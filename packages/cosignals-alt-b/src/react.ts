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
	installState,
	isSuspendedBox,
	withRootCommitted,
} from './engine';
import type {
	AtomOptions,
	ComputedOptions,
	ReducerAtomOptions,
	SignalLike,
	WatcherHandle,
} from './engine';
import type { Container, ForkDouble } from './fork';

type RootView = {
	/** entries retired at or below this are in the root's committed view */
	pin: number;
	/** batches this root committed while they stay pending elsewhere (§6.2 lock-ins) */
	lockIns: Set<number>;
};

export type SetStateRecord = { token: number; reason: 'watch' | 'fixup-own' | 'fixup-pending' };

export type ReactBindings = ReturnType<typeof createReactBindings>;

export function createReactBindings(fork: ForkDouble) {
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
		 * Suspends (throws the thenable) if the value is a SuspendedBox. */
		renderRead(): T {
			if (currentPass === undefined) {
				throw new Error('SignalHook.renderRead: no render pass is open');
			}
			const value = this.signal.state; // engine resolves RENDER ctx
			this.rendered = {
				pin: currentPass.pin,
				tokens: currentPass.tokens,
				value,
			};
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
