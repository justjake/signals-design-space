/**
 * M5 — React bindings (§13), realized against the fork test double.
 *
 * The real package would export hooks (`useSignal`, `useSignalEffect`, ...)
 * whose bodies delegate to the objects here; without React in this repo, the
 * hook LIFECYCLES are exposed as explicit methods the tests (or a future hook
 * shim) drive:
 *
 * - `SignalHook` = one mounted `useSignal`: `renderRead()` during the pass
 *   (pure; remembers the rendered world + value), `commit(container)` in the
 *   layout-effect phase (creates the watcher and runs the §13.2 world-aware
 *   post-subscribe fixup with batch entanglement), `unmount()`.
 * - `EffectHook` = one `useSignalEffect`: runs after commit over the owning
 *   root's committed view (§13.4) and re-runs in a microtask after that
 *   root's commits when its tracked committed values change.
 * - Per-root committed views: maintained from `onBatchCommitted` /
 *   `onBatchRetired` (committedPin + lock-in mask per container).
 * - `ownedAtom`/`ownedReducerAtom`/`ownedComputed` (§13.5/§13.3): component-
 *   owned nodes with deterministic unmount disposal.
 * - `useSignalTransitionLike` (§13.6) and the SSR helpers (§13.8).
 */

import {
	Atom,
	Computed,
	ReducerAtom,
	__debug,
	batch,
	captureReads,
	createWatcher,
	disposeSignal,
	effect as engineEffect,
	installState,
	isErrorBox,
	isSuspendedBox,
	latest,
	pendingComputedOf,
	readById,
	withRootCommitted,
} from './engine';
import type {
	AtomOptions,
	ComputedOptions,
	ReducerAtomOptions,
	SignalLike,
	WatcherHandle,
} from './engine';
import type { Container, ExternalRuntimeListener, ForkLike } from './fork';

type RootView = {
	/** entries retired at or below this are in the root's committed view */
	pin: number;
	/** batches this root committed while they stay pending elsewhere (§6.2 lock-ins) */
	lockIns: Set<number>;
};

export type SetStateRecord = { token: number; reason: 'watch' | 'fixup-own' | 'fixup-pending' };

export type ReactBindings = ReturnType<typeof createReactBindings>;

export function createReactBindings(fork: ForkLike) {
	const rootViews = new Map<Container, RootView>();
	const rootEffects = new Map<Container, Set<EffectHook>>();
	let currentPass: { container: Container; tokens: readonly number[]; pin: number } | undefined;

	function viewOf(container: Container): RootView {
		let v = rootViews.get(container);
		if (v === undefined) {
			// A root's view starts at its mount moment (≈ its first commit):
			// everything retired so far is on its screen.
			v = { pin: __debug.seqCounter(), lockIns: new Set() };
			rootViews.set(container, v);
		}
		return v;
	}

	const unsubscribe = fork.subscribeToExternalRuntime({
		onRenderPassStart(container, includedBatches) {
			currentPass = {
				container,
				tokens: includedBatches,
				pin: __debug.seqCounter(),
			};
		},
		onRenderPassEnd() {
			currentPass = undefined;
		},
		onBatchCommitted(container, token) {
			// §13.4: a fresh pin at this root's commit, plus the lock-in while
			// the token stays pending elsewhere.
			const v = viewOf(container);
			v.pin = __debug.seqCounter();
			if (fork.isBatchLive(token)) {
				v.lockIns.add(token);
			}
			scheduleRootEffectFlush(container);
		},
		onBatchRetired(token) {
			// When a locked-in token retires everywhere, its slot clears and
			// the pin advances past its retirement ticket — the view's
			// contents are unchanged by this bookkeeping step (§13.4).
			for (const [container, v] of rootViews) {
				if (v.lockIns.delete(token)) {
					v.pin = __debug.seqCounter();
					scheduleRootEffectFlush(container);
				}
			}
		},
	});

	function readRootCommitted<T>(container: Container, fn: () => T): T {
		const v = viewOf(container);
		return withRootCommitted(v.pin, [...v.lockIns], fn);
	}

	// ---- useSignal (§13.2) --------------------------------------------------------

	class SignalHook<T> {
		private watcher: WatcherHandle | undefined;
		private rendered:
			| { pin: number; tokens: readonly number[]; value: T }
			| undefined;
		readonly setStates: SetStateRecord[] = [];
		private onSetState: ((rec: SetStateRecord) => void) | undefined;

		constructor(
			private readonly signal: SignalLike & { state: T },
			onSetState?: (rec: SetStateRecord) => void,
		) {
			this.onSetState = onSetState;
		}

		private fire(rec: SetStateRecord): void {
			this.setStates.push(rec);
			this.onSetState?.(rec);
		}

		/** Render phase (pure): read the pass's world Wp and remember it.
		 * Returns the RAW value — status boxes (SuspendedBox/ErrorBox) ride
		 * along as values; the hook layer unboxes (pending hands the node-held
		 * thenable to React use(); errors rethrow). Raw is required: throwing
		 * here would hide the node-held box the retry identity depends on. */
		renderRead(): T {
			const value = readById(this.signal.id) as T; // engine resolves RENDER ctx
			this.rendered =
				currentPass !== undefined
					? { pin: currentPass.pin, tokens: currentPass.tokens, value }
					: { pin: __debug.seqCounter(), tokens: [], value };
			return value;
		}

		/** Commit phase (layout effect): subscribe, then run the world-aware
		 * post-subscribe fixup for writes that raced into the gap (§13.2). */
		commit(): void {
			if (this.watcher === undefined) {
				this.watcher = createWatcher(this.signal, (token) => {
					this.fire({ token, reason: 'watch' });
				});
			}
			const rendered = this.rendered;
			if (rendered === undefined) {
				return;
			}
			// 1. Did this component's own world move? Compare against the
			// remembered rendered world resolved NOW — all retired history plus
			// the remembered includes' pre-pin entries. Never a literal
			// committed-vs-rendered comparison: a mount inside transition k's
			// pass must not fire a spurious correction just because committed
			// state excludes k (§13.2).
			const nowValue = __debug.readInWorld(this.signal, {
				kind: 'fixup',
				pin: rendered.pin,
				tokens: rendered.tokens,
			}) as T;
			if (!Object.is(nowValue, rendered.value) && !isSuspendedBox(rendered.value)) {
				this.fire({ token: 0, reason: 'fixup-own' }); // pre-paint urgent correction
			}
			// 2. Did a pending world this component missed move? For each live
			// deferred batch, compare its writer's world with the rendered
			// value; corrections are entangled into that batch's own lanes.
			const renderedTokens = new Set(rendered.tokens);
			for (const token of fork.liveTokens()) {
				if ((token & 1) !== 1 || renderedTokens.has(token)) {
					continue;
				}
				const worldValue = __debug.readInWorld(this.signal, { kind: 'writer', token }) as T;
				if (Object.is(worldValue, rendered.value) || Object.is(worldValue, nowValue)) {
					continue;
				}
				const ok = fork.runInBatch(token, () => {
					this.fire({ token, reason: 'fixup-pending' });
				});
				if (!ok) {
					// Retired between check and call: its values are already
					// absorbed; the urgent path covers it (§13.2 fallback).
					this.fire({ token: 0, reason: 'fixup-own' });
				}
			}
		}

		unmount(): void {
			this.watcher?.dispose();
			this.watcher = undefined;
			this.rendered = undefined;
		}
	}

	// ---- useSignalEffect (§13.4) -----------------------------------------------------

	const pendingFlush = new Set<Container>();

	function scheduleRootEffectFlush(container: Container): void {
		if (pendingFlush.has(container)) {
			return;
		}
		pendingFlush.add(container);
		void Promise.resolve().then(() => {
			pendingFlush.delete(container);
			const effects = rootEffects.get(container);
			if (effects === undefined) {
				return;
			}
			for (const e of effects) {
				e.maybeRerun();
			}
		});
	}

	class EffectHook {
		private cleanup: (() => void) | undefined;
		private tracked: Array<{ id: number; value: unknown }> = [];
		private mounted = false;
		/** Kernel-side tracker: loose-mode DIRECT writes commit with NO React
		 * batch lifecycle (no onRootCommitted), so committed-value changes
		 * must also arrive through the engine's own effect machinery. */
		private tracker: (() => void) | undefined;
		runs = 0;

		constructor(
			private readonly container: Container,
			private readonly fn: () => void | (() => void),
		) {}

		/** Passive-effect phase: first run, over the root's committed view. */
		commit(): void {
			if (!this.mounted) {
				this.mounted = true;
				let set = rootEffects.get(this.container);
				if (set === undefined) {
					set = new Set();
					rootEffects.set(this.container, set);
				}
				set.add(this);
				this.run();
			}
		}

		private run(): void {
			this.cleanup?.();
			this.cleanup = undefined;
			++this.runs;
			const handleById = (id: number): unknown =>
				readRootCommitted(this.container, () =>
					__debug.readInWorld({ id }, viewSpec(this.container)),
				);
			const { result, reads } = readRootCommitted(this.container, () =>
				captureReads(this.fn),
			);
			this.tracked = reads.map((id) => ({ id, value: handleById(id) }));
			if (typeof result === 'function') {
				this.cleanup = result;
			}
			// Re-arm the kernel tracker over the (possibly changed) read set.
			this.tracker?.();
			const hook = this;
			this.tracker = engineEffect(() => {
				for (const t of hook.tracked) {
					void readById(t.id); // tracked: the effect links these deps
				}
				scheduleRootEffectFlush(hook.container);
			});
		}

		/** Engine pathway: after the owning root's commit, re-run iff the
		 * committed value of anything tracked changed (per-root view). */
		maybeRerun(): void {
			if (!this.mounted) {
				return;
			}
			for (const t of this.tracked) {
				const now = readRootCommitted(this.container, () =>
					__debug.readInWorld({ id: t.id }, viewSpec(this.container)),
				);
				if (!Object.is(now, t.value)) {
					this.run();
					return;
				}
			}
		}

		unmount(): void {
			this.tracker?.();
			this.tracker = undefined;
			this.cleanup?.();
			this.cleanup = undefined;
			this.mounted = false;
			rootEffects.get(this.container)?.delete(this);
		}
	}

	function viewSpec(container: Container): { kind: 'committedRoot'; pin: number; tokens: number[] } {
		const v = viewOf(container);
		return { kind: 'committedRoot', pin: v.pin, tokens: [...v.lockIns] };
	}

	// ---- component-owned nodes (§13.3, §13.5) -----------------------------------------

	function ownedAtom<T>(options: AtomOptions<T>): { atom: Atom<T>; dispose(): void } {
		const atom = new Atom(options);
		return { atom, dispose: () => disposeSignal(atom) };
	}

	function ownedReducerAtom<S, A>(
		options: ReducerAtomOptions<S, A>,
	): { atom: ReducerAtom<S, A>; dispose(): void } {
		const atom = new ReducerAtom(options);
		return { atom, dispose: () => disposeSignal(atom) };
	}

	function ownedComputed<T>(options: ComputedOptions<T>): { computed: Computed<T>; dispose(): void } {
		const computed = new Computed(options);
		return { computed, dispose: () => disposeSignal(computed) };
	}

	// ---- useSignalTransition analogue (§13.6) ------------------------------------------

	function signalTransition(): {
		isPending(): boolean;
		start(scope: () => void): number;
	} {
		let token = 0;
		return {
			isPending: () => token !== 0 && fork.isBatchLive(token),
			start(scope: () => void): number {
				token = 0;
				batch(() => {
					token = fork.startTransition(scope);
				});
				return token;
			},
		};
	}

	return {
		mountSignal<T>(
			signal: SignalLike & { state: T },
			onSetState?: (rec: SetStateRecord) => void,
		): SignalHook<T> {
			return new SignalHook(signal, onSetState);
		},
		/** Is the currently-executing render pass a TRANSITION pass (any
		 * included batch deferred)? Drives the context-sensitive half of the
		 * two-level suspense rule. */
		renderingDeferredPass(): boolean {
			return currentPass !== undefined && currentPass.tokens.some((t) => (t & 1) === 1);
		},
		signalEffect(container: Container, fn: () => void | (() => void)): EffectHook {
			return new EffectHook(container, fn);
		},
		readRootCommitted,
		rootView(container: Container): { pin: number; lockIns: number[] } {
			const v = viewOf(container);
			return { pin: v.pin, lockIns: [...v.lockIns] };
		},
		ownedAtom,
		ownedReducerAtom,
		ownedComputed,
		signalTransition,
		dispose(): void {
			unsubscribe();
			rootViews.clear();
			rootEffects.clear();
		},
	};
}

// ---- SSR helpers (§13.8) ------------------------------------------------------------

/** Server: capture committed leaf values. Returns a JSON-safe payload. */
export function serializeAtomState(
	atoms: Record<string, Atom<unknown> | ReducerAtom<unknown, unknown>>,
	replacer?: (key: string, value: unknown) => unknown,
): string {
	const out: Record<string, unknown> = {};
	for (const [key, atom] of Object.entries(atoms)) {
		const v = __debug.committed(() => atom.state);
		out[key] = replacer !== undefined ? replacer(key, v) : v;
	}
	return JSON.stringify(out);
}

/** Client: install serialized values into matching atoms. MUST run before
 * hydration so the first client render reads identical committed values.
 * Unknown keys warn (dev); missing keys leave the constructor default. */
export function initializeAtomState(
	json: string,
	atoms: Record<string, Atom<unknown> | ReducerAtom<unknown, unknown>>,
	reviver?: (key: string, value: unknown) => unknown,
): void {
	const data = JSON.parse(json) as Record<string, unknown>;
	for (const [key, raw] of Object.entries(data)) {
		const atom = atoms[key];
		if (atom === undefined) {
			(globalThis as { console?: { warn(msg: string): void } }).console?.warn(
				`cosignals-alt-b: initializeAtomState: unknown key "${key}"`,
			);
			continue;
		}
		installState(atom, reviver !== undefined ? reviver(key, raw) : raw);
	}
}

// ============================================================================
// The REAL React bridge (§6 over the patched build's external-runtime
// protocol v2) and the hook surface (§4/§13). The test double stays the unit
// suites' fork; this adapter is the production one. Protocol deltas vs the
// spec's §6.1, with the sound degradations taken (do NOT patch React):
//
// - No batch-open listener event: protocol v2 instead has the HOST allocate
//   batch ids (unstable_registerBatchIdAllocator), called at every batch's
//   creation with its deferred classification. That call IS the §6.2
//   claim/mint edge: we mint `(serial << 1) | deferred` (the spec's token
//   encoding), so bit 0 answers isCurrentWriteDeferred with no second call.
// - No render lineage (§6.3) — and none is needed: pending state is a
//   node-held box (Solid-async model), so suspense-retry identity is keyed
//   by the NODE, not by which render attempt asked. Interleaved works on one
//   root cannot alias each other's thenables.
// - onRootCommitted(container, batches[], generation) replaces
//   onBatchCommitted(container, token): fanned out per batch id.
// - onRenderPassEnd carries `committed`; the engine's §6 listener ignores it
//   (per-root committed truth arrives via onRootCommitted).
// - The engine keeps ONE pass scalar set (§6.3 one-pass-at-a-time); if the
//   protocol opens a pass while another container's is open (defensive —
//   the host closes frames before restarting), the stale frame is ended
//   first, matching the shim precedent in cosignals-react.
// ============================================================================

type ReactRuntime = {
	unstable_registerBatchIdAllocator(fn: (deferred: boolean) => number): () => void;
	unstable_subscribeToExternalRuntime(l: {
		onRenderPassStart?: (container: unknown, includedBatches: readonly number[]) => void;
		onRenderPassYield?: (container: unknown) => void;
		onRenderPassResume?: (container: unknown) => void;
		onRenderPassEnd?: (container: unknown, committed: boolean) => void;
		onBatchRetired?: (batchId: number, committed: boolean) => void;
		onRootCommitted?: (
			container: unknown,
			committedBatches: readonly number[],
			generation: number,
		) => void;
		onBeforeMutation?: (container: unknown) => void;
		onAfterMutation?: (container: unknown) => void;
	}): () => void;
	unstable_getCurrentWriteBatch(): number;
	unstable_getRenderContext(): { container: unknown } | null;
	unstable_runInBatch(batchId: number, fn: () => void): boolean;
	unstable_resetBatchRegistryForTest?(): void;
	startTransition(scope: () => void): void;
};

export class ReactFork implements ForkLike {
	private listeners = new Set<ExternalRuntimeListener>();
	private live = new Map<number, boolean>(); // token → deferred
	private serial = 0;
	private passContainer: Container | undefined = undefined;
	private unsubs: Array<() => void> = [];
	/** runInBatch outcomes, for entanglement assertions (test parity with the double). */
	readonly entangleLog: Array<{ token: number; ran: boolean }> = [];

	constructor(private readonly R: ReactRuntime) {
		if (typeof R.unstable_subscribeToExternalRuntime !== 'function') {
			// §6.7 version-skew rule: refuse stock React loudly; a silent
			// degraded mode would reintroduce tearing with no error at the cause.
			throw new Error(
				'cosignals-alt-b/react: this React build does not implement the external-runtime protocol (stock React); concurrent bindings require the patched build',
			);
		}
		this.unsubs.push(
			R.unstable_registerBatchIdAllocator((deferred) => {
				const token = (++this.serial << 1) | (deferred ? 1 : 0);
				this.live.set(token, deferred);
				this.emit((l) => l.onBatchOpened?.(token));
				return token;
			}),
			R.unstable_subscribeToExternalRuntime({
				onRenderPassStart: (container, included) => {
					if (this.passContainer !== undefined) {
						const prev = this.passContainer;
						this.passContainer = undefined;
						this.emit((l) => l.onRenderPassEnd?.(prev));
					}
					this.passContainer = container;
					const tokens = included.filter((t) => this.live.has(t));
					// Lineage is dead protocol weight in the Solid-async model
					// (pending state is node-held, not positional); 0 keeps the
					// listener signature shared with the test double.
					this.emit((l) => l.onRenderPassStart?.(container, tokens, 0));
				},
				onRenderPassYield: (container) => {
					if (this.passContainer === container) {
						this.emit((l) => l.onRenderPassYield?.(container));
					}
				},
				onRenderPassResume: (container) => {
					if (this.passContainer === container) {
						this.emit((l) => l.onRenderPassResume?.(container));
					}
				},
				onRenderPassEnd: (container, committed) => {
					if (this.passContainer !== container) {
						return;
					}
					this.passContainer = undefined;
					void committed; // §6 listener derives commit state from onBatchRetired
					this.emit((l) => l.onRenderPassEnd?.(container));
				},
				onBatchRetired: (token, committed) => {
					this.live.delete(token);
					this.emit((l) => l.onBatchRetired?.(token, committed));
				},
				onRootCommitted: (container, committedBatches) => {
					for (const token of committedBatches) {
						this.emit((l) => l.onBatchCommitted?.(container, token));
					}
				},
				onBeforeMutation: (container) => this.emit((l) => l.onBeforeMutation?.(container)),
				onAfterMutation: (container) => this.emit((l) => l.onAfterMutation?.(container)),
			}),
		);
	}

	/** Errors thrown by protocol listeners, captured here — the fork's events
	 * fire synchronously inside commitRoot and the scheduler microtask, so a
	 * listener throw must never propagate into React (§6.7 listener-error
	 * rule; same posture as alt-a's bridge guard). */
	readonly listenerErrors: unknown[] = [];

	private emit(fn: (l: ExternalRuntimeListener) => void): void {
		for (const l of this.listeners) {
			try {
				fn(l);
			} catch (err) {
				this.listenerErrors.push(err);
			}
		}
	}

	subscribeToExternalRuntime(l: ExternalRuntimeListener): () => void {
		this.listeners.add(l);
		return () => {
			this.listeners.delete(l);
		};
	}

	isCurrentWriteDeferred(): boolean {
		// Side-effect-free classification (§6.4 documents this as pure): the
		// first unstable_getCurrentWriteBatch call in an event CREATES the
		// batch identity, so a probe must read the current-transition slot.
		// Mirrors the classifier's own transition arm (non-gesture scope ⇒
		// a write issued now is deferred).
		const t = this.currentTransitionScope() as { gesture?: unknown } | null;
		return t !== null && !t.gesture;
	}

	/** The transition-scope object whose batch we last minted, for the
	 * read-your-own-draft probe (ambient-W0 semantics). */
	private lastScopeT: unknown = null;
	private lastScopeToken = 0;

	private currentTransitionScope(): unknown {
		const internals = (
			this.R as unknown as {
				__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: { T?: unknown };
			}
		).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
		return internals?.T ?? null;
	}

	getCurrentWriteBatch(): number {
		const token = this.R.unstable_getCurrentWriteBatch();
		// Remember (T → token) so ambient reads later in the SAME synchronous
		// transition scope resolve that batch's world (read-your-own-draft).
		if ((token & 1) === 1) {
			const t = this.currentTransitionScope();
			if (t !== null) {
				this.lastScopeT = t;
				this.lastScopeToken = token;
			}
		}
		return token;
	}

	/** Ambient-W0 semantics (SPEC-RESOLUTIONS §ambient-W0): the deferred
	 * batch whose write scope is executing NOW, or 0. Identity-keyed on the
	 * reconciler's current-transition slot: minted at the scope's first
	 * write; reads before any write correctly see W0 (no draft exists). A
	 * different transition or plain handler has a different (or null) T. */
	getAmbientReadToken(): number {
		if (this.lastScopeToken === 0) {
			return 0;
		}
		const t = this.currentTransitionScope();
		return t !== null && t === this.lastScopeT ? this.lastScopeToken : 0;
	}

	getRenderContext(): { container: Container } | undefined {
		return this.R.unstable_getRenderContext() ?? undefined;
	}

	runInBatch(token: number, fn: () => void): boolean {
		let ran = false;
		try {
			ran = this.R.unstable_runInBatch(token, fn) !== false;
		} catch {
			ran = false; // e.g. called during render: fall back to urgent (§6.5)
		}
		this.entangleLog.push({ token, ran });
		return ran;
	}

	liveTokens(): number[] {
		return [...this.live.keys()];
	}

	isBatchLive(token: number): boolean {
		return this.live.has(token);
	}

	isQuiescent(): boolean {
		return this.live.size === 0 && this.passContainer === undefined;
	}

	hasOpenWork(): boolean {
		if (this.live.size !== 0 || this.passContainer !== undefined) {
			return true;
		}
		// An open transition scope whose batch is not minted yet (protocol v2
		// mints lazily): the reconciler's current-transition slot is the only
		// pre-mint witness. Reading it through the shared-internals export is
		// the sound alternative to patching a pure classification API in.
		const internals = (
			this.R as unknown as {
				__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: { T?: unknown };
			}
		).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
		if (internals !== undefined && internals.T !== null && internals.T !== undefined) {
			return true;
		}
		return this.R.unstable_getRenderContext() !== null;
	}

	startTransition(scope: () => void): number {
		let token = 0;
		this.R.startTransition(() => {
			scope();
			token = this.R.unstable_getCurrentWriteBatch(); // mints the transition batch
		});
		return token;
	}

	dispose(): void {
		for (const u of this.unsubs) {
			u();
		}
		this.unsubs.length = 0;
		this.listeners.clear();
		this.live.clear();
	}
}

// ---- activation + hooks (§4.5/§13) ---------------------------------------------

import * as ReactNS from 'react';
import { attachFork, detachFork } from './engine';
import type { AtomOptions as AtomOpts, ReducerAtomOptions as ReducerOpts } from './engine';

let activeFork: ReactFork | undefined;
let activeBindings: ReactBindings | undefined;

export type AltBReactHandle = {
	fork: ReactFork;
	bindings: ReactBindings;
	dispose(): void;
};

/**
 * Couples the module-singleton engine to the patched React build. Call after
 * importing react-dom/client (the renderer registers the protocol provider
 * at module init) and before rendering any root. Throws on stock React.
 * There is no required provider component (§4.5).
 */
export function registerAltBReact(): AltBReactHandle {
	if (activeFork !== undefined) {
		throw new Error('cosignals-alt-b/react: already registered (dispose the previous handle first)');
	}
	const fork = new ReactFork(ReactNS as unknown as ReactRuntime);
	attachFork(fork);
	const bindings = createReactBindings(fork);
	activeFork = fork;
	activeBindings = bindings;
	return {
		fork,
		bindings,
		dispose() {
			bindings.dispose();
			fork.dispose();
			detachFork();
			if (activeFork === fork) {
				activeFork = undefined;
				activeBindings = undefined;
			}
		},
	};
}

function requireBindings(): ReactBindings {
	if (activeBindings === undefined) {
		throw new Error('cosignals-alt-b/react: registerAltBReact() must run before using hooks');
	}
	return activeBindings;
}

type AnySignalHook = ReturnType<ReactBindings['mountSignal']>;

/**
 * §13.2 — subscribe this component to a signal; returns its value for the
 * current render's world. Concurrent-safe: render reads resolve the pass's
 * world; the layout-effect commit creates the watcher and runs the
 * world-aware post-subscribe fixup (corrections entangled into pending
 * batches' own lanes). Suspends while the value is a SuspendedBox.
 */
/** Shared hook body: mount/subscribe + render-read RAW (boxes included). */
function useSignalRaw(signal: SignalLike & { state: unknown }): unknown {
	const b = requireBindings();
	const [, bump] = ReactNS.useReducer((c: number) => (c + 1) | 0, 0);
	const ref = ReactNS.useRef<{ hook: AnySignalHook; of: SignalLike } | null>(null);
	if (ref.current === null || ref.current.of !== signal) {
		ref.current?.hook.unmount();
		ref.current = {
			hook: b.mountSignal(signal, () => bump()) as AnySignalHook,
			of: signal,
		};
	}
	const value: unknown = ref.current.hook.renderRead();
	ReactNS.useLayoutEffect(() => {
		// Every commit: idempotent watcher creation + the §13.2 fixup for
		// writes that raced into the render→commit gap. StrictMode's
		// simulated unmount disposes the watcher; this recreates it.
		ref.current?.hook.commit();
	});
	ReactNS.useLayoutEffect(() => {
		return () => {
			ref.current?.hook.unmount();
		};
	}, []);
	return value;
}

export function useSignal<T>(signal: SignalLike & { state: T }): T {
	const value: unknown = useSignalRaw(signal);
	if (isErrorBox(value)) {
		throw value.error;
	}
	if (isSuspendedBox(value)) {
		// TWO-LEVEL SUSPENSE RULE, CONTEXT-SENSITIVE (solid2-async-model §2,
		// amended): (a) inside a TRANSITION pass, ALWAYS hand the thenable to
		// React use() — React natively holds old UI for suspends-in-
		// transition (no fallback flash) and keeps the transition pending
		// until settlement, so signals-side and React-side waiters of the
		// same promise land in ONE commit (no early commit with stale data);
		// (b) in an urgent/sync pass with a settled history, serve latest
		// through (suspending here would flash the fallback) — pending
		// surfaces via useIsPending; (c) never-settled always suspends.
		// Per-site opt-outs: latest() / isPending(). The engine never holds
		// transitions itself — React is the single waiter.
		const inTransitionPass = requireBindings().renderingDeferredPass();
		if (value.latest !== undefined && !inTransitionPass) {
			return value.latest as T; // (b) urgent stale-through
		}
		// (a)/(c): hand the NODE-HELD thenable to React use(): its identity
		// is store-stable across retries (foldEvalResult preserves the box
		// while the thenable is unchanged), so React resumes instead of
		// looping. use() is exempt from hook-order rules, so the conditional
		// call is legal.
		const use = (ReactNS as { use?: (t: PromiseLike<unknown>) => unknown }).use;
		if (use === undefined) {
			throw value.thenable; // pre-use() React: classic thrown-thenable suspend
		}
		use(value.thenable);
		// use() returned without suspending: the thenable already settled and
		// the engine's settlement write (registered first) has landed —
		// re-read (raw, ambient render context) for the post-settlement value.
		const again: unknown = readById(signal.id);
		if (isErrorBox(again)) {
			throw again.error;
		}
		if (isSuspendedBox(again)) {
			if (again.latest !== undefined && !inTransitionPass) {
				return again.latest as T; // re-pending on a NEW fetch: urgent stale-through
			}
			throw again.thenable; // still pending in this context: classic suspend
		}
		return again as T;
	}
	return value as T;
}

/** §7 isPending as a hook: reactive "stale data while newer loads" boolean.
 * Flip-only re-renders — the probe computed's boolean equality suppresses
 * upstream value churn; first load and errors read false. */
export function useIsPending(signal: SignalLike): boolean {
	return useSignal(pendingComputedOf(signal));
}

/** §ambient-W0 companion hook: subscribe like useSignal but read the
 * COMMITTED world (global committed view — the hook does not know its root;
 * per-root refinement is the kernel-side effects' job via withRootCommitted).
 * Never suspends: pending unwraps to box.latest (undefined while the
 * committed world never had a value), errors rethrow. */
export function useCommitted<T>(signal: SignalLike & { state: T }): T | undefined {
	useSignalRaw(signal); // subscription: re-render on broadcasts
	const raw = __debug.readInWorld(signal, { kind: 'committed' });
	if (isErrorBox(raw)) {
		throw raw.error;
	}
	if (isSuspendedBox(raw)) {
		return raw.latest as T | undefined;
	}
	return raw as T;
}

/** §7 latest as a hook: subscribe like useSignal but NEVER suspend — pending
 * unwraps to box.latest (undefined while uninitialized), errors rethrow.
 * World choice follows the render pass like useSignal (purity/replay). */
export function useLatest<T>(signal: SignalLike & { state: T }): T | undefined {
	const raw = useSignalRaw(signal);
	if (isErrorBox(raw)) {
		throw raw.error;
	}
	if (isSuspendedBox(raw)) {
		return raw.latest as T | undefined;
	}
	return raw as T;
}

/** Holder pattern (§13.5): component-owned nodes survive StrictMode's
 * simulated unmount by re-creating on the post-remount effect. */
function useOwned<H extends SignalLike>(make: () => H): H {
	const [holder, setHolder] = ReactNS.useState(() => ({ node: make(), disposed: false }));
	ReactNS.useEffect(() => {
		if (holder.disposed) {
			setHolder({ node: make(), disposed: false });
			return;
		}
		return () => {
			holder.disposed = true;
			disposeSignal(holder.node);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [holder]);
	return holder.node;
}

/** §13.5 — component-owned atom; like useState but a signal. */
export function useAtom<T>(options: AtomOpts<T>): Atom<T> {
	const optionsRef = ReactNS.useRef(options);
	return useOwned(() => new Atom(optionsRef.current));
}

/** §13.5 — component-owned reducer atom; like useReducer. */
export function useReducerAtom<S, A>(options: ReducerOpts<S, A>): ReducerAtom<S, A> {
	const optionsRef = ReactNS.useRef(options);
	return useOwned(() => new ReducerAtom(optionsRef.current));
}

function depsEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; ++i) {
		if (!Object.is(a[i], b[i])) {
			return false;
		}
	}
	return true;
}

/**
 * §13.3 — like useMemo, but re-renders when a signal read inside `fn`
 * changes. `fn` closes over props/state freely (that is what `deps` is for);
 * signal reads are auto-tracked and NOT listed in deps. Node creation during
 * render is engine-side allocation only; superseded nodes are disposed in an
 * effect (a discarded render's node falls to FinalizationRegistry/reset).
 */
export function useComputed<T>(
	fn: () => T,
	deps: readonly unknown[],
	options?: { isEqual?: (a: T, b: T) => boolean; label?: string },
): T {
	const ref = ReactNS.useRef<{ c: Computed<T>; deps: readonly unknown[]; retired: Computed<T>[] } | null>(null);
	if (ref.current === null || !depsEqual(ref.current.deps, deps)) {
		const retired = ref.current === null ? [] : [...ref.current.retired, ref.current.c];
		ref.current = {
			c: new Computed<T>({ fn: () => fn(), isEqual: options?.isEqual, label: options?.label }),
			deps,
			retired,
		};
	}
	const holder = ref.current;
	ReactNS.useEffect(() => {
		if (holder.retired.length !== 0) {
			for (const c of holder.retired) {
				disposeSignal(c);
			}
			holder.retired.length = 0;
		}
	});
	ReactNS.useEffect(() => {
		return () => {
			if (ref.current !== null) {
				disposeSignal(ref.current.c);
				ref.current = null;
			}
		};
	}, []);
	return useSignal(holder.c as SignalLike & { state: T });
}

/**
 * §13.4 — like useEffect, but also re-runs when a tracked signal's committed
 * value (per this component's root) changes. Cleanup supported.
 */
export function useSignalEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void {
	const b = requireBindings();
	// Capture the owning root during render (the only moment the protocol
	// exposes it); fall back to a process-wide default for rootless renders.
	const containerRef = ReactNS.useRef<unknown>('cosignals-alt-b:default-root');
	const ctx = activeFork?.getRenderContext();
	if (ctx !== undefined) {
		containerRef.current = ctx.container;
	}
	const fnRef = ReactNS.useRef(fn);
	fnRef.current = fn;
	ReactNS.useEffect(() => {
		const hook = b.signalEffect(containerRef.current, () => fnRef.current());
		hook.commit();
		return () => {
			hook.unmount();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, deps ?? []);
}

/**
 * §13.6 — useTransition + engine batching: writes in `scope` classify into
 * the transition's batch and broadcast once per watcher.
 */
export function useSignalTransition(): [boolean, (scope: () => void) => void] {
	const [isPending, start] = ReactNS.useTransition();
	const startScoped = ReactNS.useCallback((scope: () => void) => {
		start(() => {
			batch(scope);
		});
	}, [start]);
	return [isPending, startScoped];
}
