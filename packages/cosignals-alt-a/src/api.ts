/**
 * §4 — the public API surface (policy layer, M4): `Atom`, `ReducerAtom`,
 * `Computed` classes over the engine's handle layer, plus the §11.3 sentinel
 * boxes and the §12.3 `ctx.use` thenable protocol.
 *
 * Evaluation never throws THROUGH the graph: a throwing `fn` or a pending
 * `ctx.use` becomes a cached ErrorBox/SuspendedBox on the node (§11.3);
 * read sites rethrow or surface the thenable. Boxes are reference-stable
 * while the state is unchanged, which makes the kernel's identity compare —
 * and the overlay's memo equality — treat an unchanged error/suspension as
 * "no change" (§11.2).
 */
import type { CosignalEngine, Equality, SignalHandle } from './engine';

// ---- §11.3 sentinel boxes ---------------------------------------------------------
export type ErrorBox = { kind: 'error'; error: unknown };
export type SuspendedBox = { kind: 'suspended'; thenable: PromiseLike<unknown> };

const BOX = Symbol('cosignal.box');

type Boxed = (ErrorBox | SuspendedBox) & { [BOX]: true };

export function isErrorBox(v: unknown): v is ErrorBox {
	return typeof v === 'object' && v !== null && (v as Boxed)[BOX] === true && (v as ErrorBox).kind === 'error';
}

export function isSuspendedBox(v: unknown): v is SuspendedBox {
	return typeof v === 'object' && v !== null && (v as Boxed)[BOX] === true && (v as SuspendedBox).kind === 'suspended';
}

function errorBox(error: unknown): ErrorBox {
	return { [BOX]: true, kind: 'error', error } as Boxed & ErrorBox;
}

function suspendedBox(thenable: PromiseLike<unknown>): SuspendedBox {
	return { [BOX]: true, kind: 'suspended', thenable } as Boxed & SuspendedBox;
}

// ---- §12.3 thenable protocol -------------------------------------------------------
type TrackedThenable<T> = PromiseLike<T> & {
	status?: 'pending' | 'fulfilled' | 'rejected';
	value?: T;
	reason?: unknown;
};

const SUSPEND = Symbol('cosignal.suspend');

// ---- public option/ctx types (§4) ---------------------------------------------------
export type AtomCtx<T> = {
	peek(): T;
	set(next: T): void;
	update(fn: (current: T) => T): void;
};

export type AtomOptions<T> = {
	state: T;
	effect?: (ctx: AtomCtx<T>) => (() => void) | void;
	isEqual?: Equality<T>;
	label?: string;
};

export type ReducerAtomOptions<S, A> = {
	state: S;
	reducer: (state: S, action: A) => S;
	isEqual?: Equality<S>;
	label?: string;
};

export type ComputedCtx<T> = {
	use<U>(thenable: PromiseLike<U>): U;
	readonly previous: T | undefined;
};

export type ComputedOptions<T> = {
	fn: (ctx: ComputedCtx<T>) => T;
	isEqual?: Equality<T>;
	label?: string;
};

export type CosignalAPI = ReturnType<typeof createAPI>;

export function createAPI(engine: CosignalEngine) {
	class Atom<T> {
		readonly handle;
		constructor(options: AtomOptions<T>) {
			this.handle = engine.atom<T>(options.state, {
				isEqual: options.isEqual,
				label: options.label,
				observeEffect:
					options.effect !== undefined
						? (ctx) =>
							options.effect!({
								peek: () => ctx.peek() as T,
								set: (v: T) => ctx.set(v),
								update: (f: (c: T) => T) => ctx.update(f as (x: unknown) => unknown),
							})
						: undefined,
			});
		}
		get state(): T {
			return this.handle.state;
		}
		set(next: T): void {
			this.handle.set(next);
		}
		update(fn: (current: T) => T): void {
			this.handle.update(fn);
		}
	}

	class ReducerAtom<S, A> {
		readonly handle;
		constructor(options: ReducerAtomOptions<S, A>) {
			this.handle = engine.reducerAtom<S, A>(options.state, options.reducer, {
				isEqual: options.isEqual,
				label: options.label,
			});
		}
		get state(): S {
			return this.handle.state;
		}
		dispatch(action: A): void {
			this.handle.dispatch(action);
		}
	}

	class Computed<T> {
		readonly handle;
		// §12.3 positional identity cache: cacheKey 0 = canonical (and every
		// non-pass world — writer's-world broadcast evaluations never initiate
		// speculative fetches, they reuse the canonical positions); pass-world
		// evaluations key on the render lineage so Suspense retries converge.
		private thenableCache = new Map<number, TrackedThenable<unknown>[]>();

		constructor(options: ComputedOptions<T>) {
			const userEq = options.isEqual;
			const eq: Equality<unknown> = (a, b) => {
				const ab = isErrorBox(a) || isSuspendedBox(a);
				const bb = isErrorBox(b) || isSuspendedBox(b);
				if (ab || bb) {
					if (!ab || !bb) {
						return false;
					}
					if (isErrorBox(a) && isErrorBox(b)) {
						return Object.is(a.error, b.error);
					}
					if (isSuspendedBox(a) && isSuspendedBox(b)) {
						return Object.is(a.thenable, b.thenable);
					}
					return false;
				}
				return userEq !== undefined ? userEq(a as T, b as T) : Object.is(a, b);
			};

			const self = this; // eslint-disable-line @typescript-eslint/no-this-alias
			const evalFn = (): unknown => {
				let useIndex = 0;
				let suspended: PromiseLike<unknown> | undefined;
				const ctx: ComputedCtx<T> = {
					get previous(): T | undefined {
						const prev = engine.policy.canonicalValue(self.handle);
						return isErrorBox(prev) || isSuspendedBox(prev) ? undefined : (prev as T | undefined);
					},
					use<U>(thenable: PromiseLike<U>): U {
						const kind = engine.policy.evalWorldKind();
						const key = kind === 'pass' ? engine.policy.passLineage() : 0;
						let slots = self.thenableCache.get(key);
						if (slots === undefined) {
							self.thenableCache.set(key, (slots = []));
						}
						const i = useIndex++;
						if (slots[i] === undefined) {
							slots[i] = thenable as TrackedThenable<unknown>;
						}
						const th = slots[i] as TrackedThenable<U>;
						if (th.status === undefined) {
							th.status = 'pending';
							th.then(
								(v) => {
									th.status = 'fulfilled';
									th.value = v;
									self.onSettle(th);
								},
								(r) => {
									th.status = 'rejected';
									th.reason = r;
									self.onSettle(th);
								},
							);
						}
						if (th.status === 'fulfilled') {
							return th.value as U;
						}
						if (th.status === 'rejected') {
							throw th.reason;
						}
						suspended = th;
						throw SUSPEND; // abort the rest of the body (§12.3)
					},
				};
				const prevBox = engine.policy.canonicalValue(self.handle);
				try {
					return options.fn(ctx);
				} catch (e) {
					if (e === SUSPEND && suspended !== undefined) {
						return isSuspendedBox(prevBox) && Object.is(prevBox.thenable, suspended)
							? prevBox
							: suspendedBox(suspended);
					}
					return isErrorBox(prevBox) && Object.is(prevBox.error, e) ? prevBox : errorBox(e);
				}
			};

			this.handle = engine.computed<unknown>(evalFn, { isEqual: eq, label: options.label });
		}

		private onSettle(th: PromiseLike<unknown>): void {
			queueMicrotask(() => {
				// Settlement wake-up (§12.3): if the canonical cache still holds
				// this thenable's SuspendedBox, invalidate so watchers/effects
				// re-run and the wrapper re-evaluates with the settled status.
				const cached = engine.policy.canonicalValue(this.handle);
				if (isSuspendedBox(cached) && Object.is(cached.thenable, th)) {
					engine.policy.invalidate(this.handle);
				}
				// A settlement moves no atom's tape: bump the overlay epoch so
				// writer's-world memos holding the suspended box re-validate.
				engine.policy.bumpOverlayEpoch();
				// Canonical entry drops once the computed settles to a
				// non-suspended value on next evaluation; keep positions stable
				// until then (React's `use` protocol).
			});
		}

		get state(): T {
			const v = this.handle.state;
			if (isErrorBox(v)) {
				throw v.error;
			}
			if (isSuspendedBox(v)) {
				throw v.thenable; // read sites suspend (React convention)
			}
			return v as T;
		}

		/** Non-throwing read: the value or its §11.3 box. */
		get boxed(): T | ErrorBox | SuspendedBox {
			return this.handle.state as T | ErrorBox | SuspendedBox;
		}

		/** Drop a retired render lineage's thenable positions (§12.3). */
		dropLineage(lineage: number): void {
			this.thenableCache.delete(lineage);
		}
	}

	type Serializable = { handle: SignalHandle } | SignalHandle;
	const handleOf = (x: Serializable): SignalHandle => ('handle' in x ? x.handle : x);

	/** §13.8 Server: capture committed leaf values. Keys are app-supplied
	 * strings — debug labels are not identity, creation order is not stable. */
	function serializeAtomState(
		atoms: Record<string, Serializable>,
		replacer?: (key: string, value: unknown) => unknown,
	): string {
		const out: Record<string, unknown> = {};
		for (const [key, a] of Object.entries(atoms)) {
			const v = engine.readCommitted(handleOf(a));
			out[key] = replacer !== undefined ? replacer(key, v) : v;
		}
		return JSON.stringify(out);
	}

	/** §13.8 Client: install serialized values into matching atoms. MUST run
	 * before hydration so the first client render reads identical committed
	 * values. Unknown keys warn; missing keys leave the constructor default. */
	function initializeAtomState(
		json: string,
		atoms: Record<string, { handle: { set(v: never): void } } | { set(v: never): void }>,
		reviver?: (key: string, value: unknown) => unknown,
	): void {
		const data = JSON.parse(json) as Record<string, unknown>;
		for (const [key, raw] of Object.entries(data)) {
			const target = atoms[key];
			if (target === undefined) {
				console.warn(`cosignal: initializeAtomState: unknown key "${key}"`);
				continue;
			}
			const v = reviver !== undefined ? reviver(key, raw) : raw;
			const settable = ('handle' in target ? target.handle : target) as { set(x: unknown): void };
			settable.set(v);
		}
	}

	return {
		Atom,
		ReducerAtom,
		Computed,
		effect: engine.effect,
		effectScope: engine.effectScope,
		batch: engine.batch,
		untracked: engine.untracked,
		configure: engine.configure,
		serializeAtomState,
		initializeAtomState,
		engine,
	};
}
