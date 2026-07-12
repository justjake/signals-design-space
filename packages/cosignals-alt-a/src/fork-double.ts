/**
 * M0 — the React fork test double.
 *
 * Implements the spec §6 external-runtime protocol surface exactly, as a
 * scriptable simulation: batch open/close (§6.2 claim/mint/pending/finish/
 * close as script-driven edges), render passes with yield/resume and render
 * lineage (§6.3), write classification (§6.4), batch entanglement
 * (`runInBatch`, §6.5), per-root commits + retirement (§6.1), and the DOM
 * mutation window (§6.6). The real fork lives elsewhere; this double is the
 * deterministic driver for the engine's unit suites and the oracle fuzz.
 *
 * Coordinator resolution #6 (adopted): the listener surface carries an
 * `onBatchOpened` edge (§9.1 of the sibling variant needs it; §6.1 omitted
 * it). It fires at token MINT time — the earliest moment a batch has an
 * identity that can cross the boundary. Variant A's engine (monotonic
 * activation) does not consume it; the double still delivers it so the edge
 * is testable and the protocol surface matches the corrected spec.
 *
 * The double self-checks protocol invariants and throws on script misuse
 * (double retirement, unpaired yield/resume, >31 live tokens, retiring a
 * batch a still-open pass includes). Listener errors are captured — never
 * thrown into the caller — mirroring §6.7's "reported like uncaught errors".
 */

export type Container = unknown

export type ExternalRuntimeListener = {
	/** §6.1: fired once per root, before any of its render work can be
	 * scheduled. The write gate's activation edge (§9.1). */
	onRootRegistered?: (container: Container) => void
	/** Coordinator resolution #6: a batch token was minted (first identity
	 * crossing the boundary). Not present in §6.1 as written. */
	onBatchOpened?: (token: number, deferred: boolean) => void
	onRenderPassStart?: (
		container: Container,
		includedBatches: readonly number[],
		lineage: number,
	) => void
	onRenderPassEnd?: (container: Container) => void
	onRenderPassYield?: (container: Container) => void
	onRenderPassResume?: (container: Container) => void
	onBatchCommitted?: (container: Container, token: number) => void
	onBatchRetired?: (token: number, committed: boolean) => void
	onBeforeMutation?: (container: Container) => void
	onAfterMutation?: (container: Container) => void
}

/** The subset of the fork's isomorphic API the engine consumes (§6.1). */
export type ForkAdapter = {
	subscribeToExternalRuntime(l: ExternalRuntimeListener): () => void
	isCurrentWriteDeferred(): boolean
	getCurrentWriteBatch(): number
	getRenderContext(): { container: Container } | undefined
	runInBatch(token: number, fn: () => void): boolean
}

export type BatchScript = {
	/** Mints (lazily) and returns the batch token: `(serial << 1) | deferred`. */
	readonly token: number
	readonly deferred: boolean
	/** Whether the token has been minted yet (mint edge is lazy, §6.2). */
	readonly minted: boolean
	readonly retired: boolean
	/** Run `fn` with writes attributed to this batch (write context). */
	run<T>(fn: () => T): T
	/** Per-root commit: fires onBatchCommitted(container, token). */
	commitOnRoot(container: Container): void
	/** Retire the batch: fires onBatchRetired(token, committed). Exactly once. */
	retire(committed?: boolean): void
}

export type PassScript = {
	readonly container: Container
	readonly lineage: number
	readonly includedBatches: readonly number[]
	readonly open: boolean
	readonly executing: boolean
	yield(): void
	resume(): void
	end(): void
	/** Restart: ends this pass and starts a new one with the SAME lineage
	 * (fresh includedBatches may be supplied — a restarted pass may
	 * legitimately see newer state, §6.3). */
	restart(include?: readonly (BatchScript | number)[]): PassScript
}

export type ForkDouble = ForkAdapter & {
	/** Script: register a root (createRoot). Fires onRootRegistered. */
	registerRoot(container: Container): void
	/** Script: claim a new batch. Token mints lazily (§6.2). */
	openBatch(kind: 'urgent' | 'deferred'): BatchScript
	/** Script: start a render pass on a container. One open pass at a time. */
	startPass(
		container: Container,
		opts?: { include?: readonly (BatchScript | number)[]; lineage?: number },
	): PassScript
	/** Script: mint a fresh lineage id (for suspense-retry scripting). */
	mintLineage(): number
	/** The lazily-minted urgent batch that bare (scope-less) writes attribute
	 * to; undefined if no bare write asked yet. */
	currentEventBatch(): BatchScript | undefined
	/** Script: close the current bare-write event batch (the §6.2 "close"
	 * edge). Retires it, committed=false by default (store-only batch). */
	closeEvent(committed?: boolean): void
	/** Script: bracket a DOM mutation window (§6.6). */
	mutationWindow(container: Container, fn?: () => void): void
	/** All live (unretired) minted tokens. */
	liveTokens(): number[]
	/** Errors thrown by listeners, captured (never rethrown). */
	readonly reportedErrors: unknown[]
}

export function createForkDouble(): ForkDouble {
	const listeners = new Set<ExternalRuntimeListener>()
	const roots = new Set<Container>()
	const reportedErrors: unknown[] = []
	const batches: BatchScript[] = [] // all ever opened
	const liveByToken = new Map<number, BatchState>()
	let serial = 0
	let lineageSerial = 0
	// Write-attribution context stack: entries are batch states (explicit
	// scopes and runInBatch overrides). Empty = bare write (urgent event).
	const ctxStack: BatchState[] = []
	let eventBatch: BatchState | undefined // lazily minted bare-write batch
	// The single open pass (React renders one pass at a time, §6.3).
	let pass:
		| {
				container: Container
				lineage: number
				included: number[]
				executing: boolean
				ended: boolean
		  }
		| undefined

	// Fixed arity (no rest/spread): emit runs on every batch lifecycle edge
	// and rest-arg materialization dominated the idle-write profile.
	function emit(k: keyof ExternalRuntimeListener, a?: unknown, b?: unknown, c?: unknown): void {
		for (const l of listeners) {
			const fn = l[k] as ((x?: unknown, y?: unknown, z?: unknown) => void) | undefined
			if (fn !== undefined) {
				try {
					fn(a, b, c)
				} catch (err) {
					reportedErrors.push(err)
				}
			}
		}
	}

	function mint(b: BatchState): number {
		if (b._token === 0) {
			if (liveByToken.size >= 31) {
				throw new Error('fork-double: >31 live tokens (violates §6.2 liveness invariant)')
			}
			b._token = (++serial << 1) | (b.deferred ? 1 : 0)
			liveByToken.set(b._token, b)
			emit('onBatchOpened', b._token, b.deferred)
		}
		return b._token
	}

	// A class (prototype methods, no per-batch closures): batch construction
	// is the idle-write workload's hottest allocation site.
	class BatchState implements BatchScript {
		_token = 0
		retired = false
		committedRootsLazy: Set<Container> | undefined
		constructor(readonly deferred: boolean) {}
		get committedRoots(): Set<Container> {
			return (this.committedRootsLazy ??= new Set())
		}
		get token(): number {
			return mint(this)
		}
		get minted(): boolean {
			return this._token !== 0
		}
		run<T>(fn: () => T): T {
			if (this.retired) {
				throw new Error('fork-double: run() on a retired batch')
			}
			ctxStack.push(this)
			try {
				return fn()
			} finally {
				ctxStack.pop()
			}
		}
		commitOnRoot(container: Container): void {
			if (!roots.has(container)) {
				throw new Error('fork-double: commitOnRoot on unregistered root')
			}
			if (this.retired) {
				throw new Error('fork-double: commitOnRoot after retirement')
			}
			const token = mint(this)
			if (this.committedRoots.has(container)) {
				throw new Error('fork-double: duplicate onBatchCommitted for (token, root)')
			}
			this.committedRoots.add(container)
			emit('onBatchCommitted', container, token)
		}
		retire(committed?: boolean): void {
			if (this.retired) {
				throw new Error('fork-double: batch retired twice')
			}
			const token = mint(this)
			if (pass !== undefined && !pass.ended && pass.included.includes(token)) {
				throw new Error(
					'fork-double: retiring a batch included in the open pass (end the pass first)',
				)
			}
			this.retired = true
			liveByToken.delete(token)
			if (eventBatch === this) {
				eventBatch = undefined
			}
			// Default: committed=true iff any root committed it; a batch that
			// produced no React work retires committed=false (§6.2 close edge).
			const c =
				committed ?? (this.committedRootsLazy !== undefined && this.committedRootsLazy.size > 0)
			emit('onBatchRetired', token, c)
		}
	}

	function makeBatch(deferred: boolean): BatchState {
		const state = new BatchState(deferred)
		batches.push(state)
		return state
	}

	const fork: ForkDouble = {
		reportedErrors,

		// ---- §6.1 engine-facing surface ------------------------------------
		subscribeToExternalRuntime(l: ExternalRuntimeListener): () => void {
			listeners.add(l)
			return () => {
				listeners.delete(l)
			}
		},
		isCurrentWriteDeferred(): boolean {
			const n = ctxStack.length
			return n !== 0 && ctxStack[n - 1].deferred
		},
		getCurrentWriteBatch(): number {
			// Hot early exits first (the engine calls this on every logged
			// write); minting stays out of line.
			const n = ctxStack.length
			if (n !== 0) {
				const top = ctxStack[n - 1]
				// _token directly: the `token` getter is the minting path.
				return top._token !== 0 ? top._token : mint(top)
			}
			const eb = eventBatch
			if (eb !== undefined && !eb.retired && eb._token !== 0) {
				return eb._token
			}
			// Bare write: attribute to the lazily-minted urgent event batch
			// (one token per "event that touches external state", §6.2).
			if (eventBatch === undefined || eventBatch.retired) {
				eventBatch = makeBatch(false)
			}
			return mint(eventBatch)
		},
		getRenderContext(): { container: Container } | undefined {
			return pass !== undefined && !pass.ended && pass.executing
				? { container: pass.container }
				: undefined
		},
		runInBatch(token: number, fn: () => void): boolean {
			const b = liveByToken.get(token)
			if (b === undefined || b.retired) {
				return false // retired → caller falls back to plain urgent (§6.5)
			}
			ctxStack.push(b)
			try {
				fn()
			} finally {
				ctxStack.pop()
			}
			return true
		},

		// ---- script controls -------------------------------------------------
		registerRoot(container: Container): void {
			if (roots.has(container)) {
				throw new Error('fork-double: root registered twice')
			}
			roots.add(container)
			emit('onRootRegistered', container)
		},
		openBatch(kind: 'urgent' | 'deferred'): BatchScript {
			return makeBatch(kind === 'deferred')
		},
		mintLineage(): number {
			return ++lineageSerial
		},
		currentEventBatch(): BatchScript | undefined {
			return eventBatch
		},
		closeEvent(committed = false): void {
			if (eventBatch !== undefined && !eventBatch.retired) {
				eventBatch.retire(committed)
			}
			eventBatch = undefined
		},
		startPass(
			container: Container,
			opts?: { include?: readonly (BatchScript | number)[]; lineage?: number },
		): PassScript {
			if (!roots.has(container)) {
				throw new Error('fork-double: startPass on unregistered root')
			}
			if (pass !== undefined && !pass.ended) {
				throw new Error('fork-double: a pass is already open (one pass at a time, §6.3)')
			}
			const included: number[] = []
			for (const b of opts?.include ?? []) {
				const token = typeof b === 'number' ? b : b.token
				const st = liveByToken.get(token)
				if (st === undefined) {
					throw new Error('fork-double: startPass including unknown/retired token ' + token)
				}
				included.push(token)
			}
			// §6.2 lock-in: batches this root committed while pending elsewhere
			// must stay included.
			for (const st of liveByToken.values()) {
				if (st.committedRootsLazy?.has(container) === true && !included.includes(st.token)) {
					included.push(st.token)
				}
			}
			const lineage = opts?.lineage ?? ++lineageSerial
			const p = { container, lineage, included, executing: true, ended: false }
			pass = p
			emit('onRenderPassStart', container, included.slice(), lineage)
			const script: PassScript = {
				container,
				lineage,
				get includedBatches() {
					return p.included.slice()
				},
				get open() {
					return !p.ended
				},
				get executing() {
					return !p.ended && p.executing
				},
				yield() {
					if (p.ended || !p.executing) {
						throw new Error('fork-double: yield on non-executing pass')
					}
					p.executing = false
					emit('onRenderPassYield', container)
				},
				resume() {
					if (p.ended || p.executing) {
						throw new Error('fork-double: resume on non-yielded pass')
					}
					p.executing = true
					emit('onRenderPassResume', container)
				},
				end() {
					if (p.ended) {
						throw new Error('fork-double: pass ended twice')
					}
					p.ended = true
					if (pass === p) {
						pass = undefined
					}
					emit('onRenderPassEnd', container)
				},
				restart(include?: readonly (BatchScript | number)[]): PassScript {
					script.end()
					return fork.startPass(container, {
						include: include ?? p.included,
						lineage, // same work → same lineage (§6.3)
					})
				},
			}
			return script
		},
		mutationWindow(container: Container, fn?: () => void): void {
			emit('onBeforeMutation', container)
			try {
				fn?.()
			} finally {
				emit('onAfterMutation', container)
			}
		},
		liveTokens(): number[] {
			return [...liveByToken.keys()]
		},
	}
	return fork
}
