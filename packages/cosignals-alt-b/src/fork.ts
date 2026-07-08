/**
 * M0 — the React-fork test double.
 *
 * Implements the spec §6 external-runtime protocol surface exactly (the real
 * fork lives elsewhere in this repo); adds a scripting surface so tests can
 * simulate batch open/close, render passes with yield/resume, restarts,
 * lineage, per-root commits, and retirement — all synchronously and
 * deterministically.
 *
 * Protocol facts the double enforces (per §6.2/§6.3):
 * - tokens: `(serial << 1) | deferredBit`, nonzero, never reused while live;
 *   at most 31 live at once (throws beyond — the engine's slot-exhaustion
 *   fallback is unit-tested by lifting this cap via `maxLiveTokens`).
 * - exactly one retirement per token, ever.
 * - one pass at a time; yield/resume strictly alternate between one start and
 *   its end; a restart is end + start with the SAME lineage.
 * - onBatchCommitted fires at most once per (token, container), and before
 *   onBatchRetired when it is the token's last pending root.
 *
 * One deliberate protocol addition beyond §6.1 (reported as such): the
 * listener may carry `onBatchOpened(token)`. §9.1 requires the DIRECT→LOGGED
 * gate flip to ride a fork-signaled edge that precedes any write the batch
 * could affect; in the real fork that edge is the registry's claim/mint edge
 * (§6.2), which §6.1 does not surface as a callback. The double surfaces it
 * so the bridge can flip the gate edge-triggered, never sampled.
 */

export type Container = unknown;

/**
 * The structural fork surface the engine and bindings consume (§6). Two
 * implementations: ForkDouble (this file — the scriptable test double) and
 * ReactFork (src/react.ts — the adapter over the actual patched React's
 * external-runtime protocol).
 */
export type ForkLike = {
	subscribeToExternalRuntime(l: ExternalRuntimeListener): () => void;
	isCurrentWriteDeferred(): boolean;
	getCurrentWriteBatch(): number;
	getRenderContext(): { container: Container } | undefined;
	runInBatch(token: number, fn: () => void): boolean;
	liveTokens(): number[];
	isBatchLive(token: number): boolean;
	isQuiescent(): boolean;
	/**
	 * Is any React work open or pending RIGHT NOW — including a transition
	 * scope whose batch has not been minted yet (protocol v2 mints lazily at
	 * the first getCurrentWriteBatch call)? This is the §9.1 DIRECT→LOGGED
	 * gate's per-write probe: the batch-open edge alone cannot precede the
	 * first write of a fresh transition under lazy minting.
	 */
	hasOpenWork(): boolean;
	/**
	 * AMBIENT-W0 SEMANTICS (SPEC-RESOLUTIONS §ambient-W0): the deferred batch
	 * token whose WRITE SCOPE is executing synchronously right now, or 0.
	 * Ambient engine reads consult this for read-your-own-draft; outside any
	 * scope, ambient reads resolve W0 (drafts invisible until commit).
	 */
	getAmbientReadToken?(): number;
	/** startTransition + token capture (throughput helpers, §13.6). */
	startTransition(scope: () => void): number;
};

export type ExternalRuntimeListener = {
	onRenderPassStart?: (
		container: Container,
		includedBatches: readonly number[],
		lineage: number,
	) => void;
	onRenderPassEnd?: (container: Container) => void;
	onRenderPassYield?: (container: Container) => void;
	onRenderPassResume?: (container: Container) => void;
	onBatchCommitted?: (container: Container, token: number) => void;
	onBatchRetired?: (token: number, committed: boolean) => void;
	onBeforeMutation?: (container: Container) => void;
	onAfterMutation?: (container: Container) => void;
	/** Double extension (see module doc): the claim/mint edge of §6.2. */
	onBatchOpened?: (token: number) => void;
};

type BatchState = {
	token: number;
	deferred: boolean;
	retired: boolean;
	/** containers this token has committed on (per-root commit, §6.2 finish edge) */
	committedRoots: Set<Container>;
};

type PassState = {
	container: Container;
	includedBatches: readonly number[];
	lineage: number;
	yielded: boolean;
};

/** A recorded runInBatch invocation, for entanglement assertions (§6.5). */
export type EntangleRecord = {
	token: number;
	ran: boolean; // false = token already retired, fn not run
};

export class ForkDouble {
	private listeners = new Set<ExternalRuntimeListener>();
	private serial = 0;
	private lineageSerial = 0;
	private batches = new Map<number, BatchState>();
	/** Live (unretired) tokens — O(1) liveness bookkeeping so long sessions
	 * do not degrade quadratically scanning every batch ever created. */
	private live = new Set<number>();
	/** Batch context stack for write attribution (innermost wins, §6.5). */
	private contextStack: number[] = [];
	/** Lazily-minted urgent token for writes outside any scripted batch. */
	private ambientToken = 0;
	private pass: PassState | undefined;
	/** Record of every runInBatch call, for test assertions. */
	readonly entangleLog: EntangleRecord[] = [];
	/** Cap on live tokens; §6.2 invariant is 31. Tests may raise it to force
	 * the engine's slot-exhaustion fallback. */
	maxLiveTokens = 31;

	// ---- §6.1 isomorphic API -------------------------------------------------

	subscribeToExternalRuntime(l: ExternalRuntimeListener): () => void {
		this.listeners.add(l);
		return () => {
			this.listeners.delete(l);
		};
	}

	/** §6.4 — pure classification of a write issued right now. */
	isCurrentWriteDeferred(): boolean {
		const token = this.currentContextToken();
		if (token !== 0) {
			return (token & 1) === 1;
		}
		return false;
	}

	/** §6.1 — token of the batch a write issued right now belongs to, minting
	 * lazily. The double mints an ambient urgent token when no scripted batch
	 * context is live (the real fork's per-event batch). */
	getCurrentWriteBatch(): number {
		const token = this.currentContextToken();
		if (token !== 0) {
			return token;
		}
		if (this.ambientToken === 0 || this.batches.get(this.ambientToken)?.retired) {
			this.ambientToken = this.openBatch(false);
		}
		return this.ambientToken;
	}

	/** §6.1 — defined only while React is *executing* render code. The double
	 * mirrors that: undefined inside yield gaps. */
	getRenderContext(): { container: Container } | undefined {
		if (this.pass !== undefined && !this.pass.yielded) {
			return { container: this.pass.container };
		}
		return undefined;
	}

	/** §6.5 — batch entanglement. Token live: run fn in that batch's context
	 * (write classification included) and return true. Retired: return false
	 * without running fn. Nesting uses the innermost override. */
	runInBatch(token: number, fn: () => void): boolean {
		const b = this.batches.get(token);
		if (b === undefined || b.retired) {
			this.entangleLog.push({ token, ran: false });
			return false;
		}
		this.entangleLog.push({ token, ran: true });
		this.contextStack.push(token);
		try {
			fn();
		} finally {
			this.contextStack.pop();
		}
		return true;
	}

	// ---- scripting surface -----------------------------------------------------

	/** Claim + mint a batch token (§6.2). Emits the onBatchOpened gate edge. */
	openBatch(deferred: boolean): number {
		if (this.live.size >= this.maxLiveTokens) {
			throw new Error(
				`ForkDouble: ${this.live.size} live tokens; §6.2 caps at ${this.maxLiveTokens}`,
			);
		}
		const token = ((++this.serial) << 1) | (deferred ? 1 : 0);
		this.batches.set(token, {
			token,
			deferred,
			retired: false,
			committedRoots: new Set(),
		});
		this.live.add(token);
		this.emit((l) => l.onBatchOpened?.(token));
		return token;
	}

	/** Run fn with writes attributed to `token` (like code inside a
	 * startTransition scope, or an event handler for an urgent batch). */
	inBatch(token: number, fn: () => void): void {
		const b = this.batches.get(token);
		if (b === undefined) {
			throw new Error(`ForkDouble.inBatch: unknown token ${token}`);
		}
		if (b.retired) {
			throw new Error(`ForkDouble.inBatch: token ${token} already retired`);
		}
		this.contextStack.push(token);
		try {
			fn();
		} finally {
			this.contextStack.pop();
		}
	}

	/** Ambient-W0 semantics: the innermost open write scope's token (0 = none). */
	getAmbientReadToken(): number {
		return this.contextStack.length !== 0
			? this.contextStack[this.contextStack.length - 1]
			: 0;
	}

	/** Convenience: open a deferred batch, run scope inside it (a
	 * startTransition analogue). Returns the token; caller retires it. */
	startTransition(scope: () => void): number {
		const token = this.openBatch(true);
		this.inBatch(token, scope);
		return token;
	}

	mintLineage(): number {
		return ++this.lineageSerial;
	}

	/** §6.3 — begin a render pass. One pass at a time. */
	startRenderPass(
		container: Container,
		includedBatches: readonly number[],
		lineage: number = this.mintLineage(),
	): void {
		if (this.pass !== undefined) {
			throw new Error('ForkDouble: a render pass is already open (one pass at a time, §6.3)');
		}
		for (const t of includedBatches) {
			const b = this.batches.get(t);
			if (b === undefined || (b.retired && !b.committedRoots.has(container))) {
				throw new Error(`ForkDouble: includedBatches names dead token ${t}`);
			}
		}
		this.pass = { container, includedBatches, lineage, yielded: false };
		this.emit((l) => l.onRenderPassStart?.(container, includedBatches, lineage));
	}

	yieldPass(): void {
		const p = this.requirePass('yieldPass');
		if (p.yielded) {
			throw new Error('ForkDouble: yield without intervening resume (§6.3 strict alternation)');
		}
		p.yielded = true;
		this.emit((l) => l.onRenderPassYield?.(p.container));
	}

	resumePass(): void {
		const p = this.requirePass('resumePass');
		if (!p.yielded) {
			throw new Error('ForkDouble: resume without a yield (§6.3 strict alternation)');
		}
		p.yielded = false;
		this.emit((l) => l.onRenderPassResume?.(p.container));
	}

	/** §6.3 — exactly one end per start, even across restarts. */
	endRenderPass(): void {
		const p = this.requirePass('endRenderPass');
		this.pass = undefined;
		this.emit((l) => l.onRenderPassEnd?.(p.container));
	}

	/** Restart: end the old pass, start a new one with the SAME lineage,
	 * re-delivering (possibly newer) includedBatches. */
	restartRenderPass(includedBatches: readonly number[]): void {
		const p = this.requirePass('restartRenderPass');
		const { container, lineage } = p;
		this.endRenderPass();
		this.startRenderPass(container, includedBatches, lineage);
	}

	/** §6.1/§6.2 finish edge — a batch's work committed on one root. */
	commitBatchOnRoot(container: Container, token: number): void {
		const b = this.batches.get(token);
		if (b === undefined) {
			throw new Error(`ForkDouble.commitBatchOnRoot: unknown token ${token}`);
		}
		if (b.retired) {
			throw new Error(`ForkDouble.commitBatchOnRoot: token ${token} already retired`);
		}
		if (b.committedRoots.has(container)) {
			throw new Error(
				`ForkDouble.commitBatchOnRoot: duplicate commit of ${token} on the same root (exactly once per (token, root), §6.1)`,
			);
		}
		b.committedRoots.add(container);
		this.emit((l) => l.onBatchCommitted?.(container, token));
	}

	/**
	 * Retire a token — exactly once, ever (§6.1). `committed` defaults to
	 * whether any root committed it. Commit-then-retire convenience: pass a
	 * container to emit the final root's onBatchCommitted first, as the real
	 * fork does ("fires before onBatchRetired when this is the token's last
	 * pending root").
	 */
	retireBatch(token: number, committed?: boolean, finalRoot?: Container): void {
		const b = this.batches.get(token);
		if (b === undefined) {
			throw new Error(`ForkDouble.retireBatch: unknown token ${token}`);
		}
		if (b.retired) {
			throw new Error(`ForkDouble.retireBatch: token ${token} retired twice (§6.1 exactly-once)`);
		}
		if (finalRoot !== undefined) {
			this.commitBatchOnRoot(finalRoot, token);
		}
		b.retired = true;
		this.live.delete(token);
		const wasCommitted = committed ?? b.committedRoots.size > 0;
		this.emit((l) => l.onBatchRetired?.(token, wasCommitted));
	}

	/** DOM mutation window (§6.6) — scripted brackets. */
	mutationWindow(container: Container, fn: () => void): void {
		this.emit((l) => l.onBeforeMutation?.(container));
		try {
			fn();
		} finally {
			this.emit((l) => l.onAfterMutation?.(container));
		}
	}

	// ---- queries ---------------------------------------------------------------

	/** Full React quiescence per §9.1: no live (unretired) batches, no open pass. */
	isQuiescent(): boolean {
		return this.pass === undefined && this.live.size === 0;
	}

	hasOpenWork(): boolean {
		return !this.isQuiescent() || this.contextStack.length !== 0;
	}

	isBatchLive(token: number): boolean {
		const b = this.batches.get(token);
		return b !== undefined && !b.retired;
	}

	liveTokens(): number[] {
		return [...this.live];
	}

	// ---- internals ---------------------------------------------------------------

	private currentContextToken(): number {
		return this.contextStack.length !== 0
			? this.contextStack[this.contextStack.length - 1]
			: 0;
	}

	private requirePass(op: string): PassState {
		if (this.pass === undefined) {
			throw new Error(`ForkDouble.${op}: no open render pass`);
		}
		return this.pass;
	}

	private emit(fn: (l: ExternalRuntimeListener) => void): void {
		for (const l of this.listeners) {
			// Listener errors are reported like uncaught errors, never thrown
			// into the caller (§6.7). In the double we rethrow to fail tests
			// loudly — a listener throw is always a bug here.
			fn(l);
		}
	}
}
