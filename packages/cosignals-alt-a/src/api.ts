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

/** One brand check for the hot read path (unboxing discriminates after). */
function isBox(v: unknown): v is Boxed {
	return typeof v === 'object' && v !== null && (v as Boxed)[BOX] === true;
}

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

// Module-level default equality for boxed computeds (no per-instance
// closure): identity semantics + §11.3 box reference rules. The `create`
// shape showed the per-computed closure bundle in GC attribution.
function defaultBoxedEq(a: unknown, b: unknown): boolean {
	const ab = isBox(a);
	const bb = isBox(b);
	if (ab || bb) {
		if (!ab || !bb) {
			return false;
		}
		const ba = a as Boxed;
		const bx = b as Boxed;
		if (ba.kind !== bx.kind) {
			return false;
		}
		return ba.kind === 'error'
			? Object.is((ba as ErrorBox).error, (bx as ErrorBox).error)
			: Object.is((ba as SuspendedBox).thenable, (bx as SuspendedBox).thenable);
	}
	return Object.is(a, b);
}

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
	const readAtomById = engine.readAtomById;
	const readComputedById = engine.readComputedById;

	class Atom<T> {
		readonly handle;
		private readonly id: number;
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
			this.id = this.handle.id;
		}
		get state(): T {
			return readAtomById(this.id) as T;
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
		private readonly id: number;
		constructor(options: ReducerAtomOptions<S, A>) {
			this.handle = engine.reducerAtom<S, A>(options.state, options.reducer, {
				isEqual: options.isEqual,
				label: options.label,
			});
			this.id = this.handle.id;
		}
		get state(): S {
			return readAtomById(this.id) as S;
		}
		dispatch(action: A): void {
			this.handle.dispatch(action);
		}
	}

	class Computed<T> {
		readonly handle;
		private readonly id: number;
		// §12.3: ONE reused ctx object per computed ("reused ctx object in
		// meta") — the previous per-evaluation ctx/closure allocations were
		// 58% of the kairo-deep tick and most of its GC. Per-eval state lives
		// in instance fields, reset at evaluation entry.
		private thenableCache: Map<number, TrackedThenable<unknown>[]> | undefined;
		private useIndex = 0;
		private suspended: PromiseLike<unknown> | undefined;
		private ctxLazy: ComputedCtx<T> | undefined;

		private get ctx(): ComputedCtx<T> {
			const self = this; // eslint-disable-line @typescript-eslint/no-this-alias
			return (this.ctxLazy ??= {
				get previous(): T | undefined {
					const prev = engine.policy.canonicalValue(self.handle);
					return isBox(prev) ? undefined : (prev as T | undefined);
				},
				use<U>(thenable: PromiseLike<U>): U {
					return self.useThenable(thenable);
				},
			});
		}

		constructor(options: ComputedOptions<T>) {
			const userEq = options.isEqual;
			const eq: Equality<unknown> = userEq === undefined
				? defaultBoxedEq
				: (a, b) => {
					const ab = isBox(a);
					const bb = isBox(b);
					if (ab || bb) {
						return defaultBoxedEq(a, b);
					}
					return userEq(a as T, b as T);
				};

			const self = this; // eslint-disable-line @typescript-eslint/no-this-alias
			const fn = options.fn;
			// Raw overlay-evaluation fn (§10.5): box stability via the canonical
			// cache (overlay evaluations carry no kernel prev).
			const evalFn = (): unknown => {
				self.useIndex = 0;
				self.suspended = undefined;
				try {
					return fn(self.ctx);
				} catch (e) {
					const prevBox = engine.policy.canonicalValue(self.handle);
					const susp = self.suspended;
					if (e === SUSPEND && susp !== undefined) {
						return isSuspendedBox(prevBox) && Object.is(prevBox.thenable, susp)
							? prevBox
							: suspendedBox(susp);
					}
					return isErrorBox(prevBox) && Object.is(prevBox.error, e) ? prevBox : errorBox(e);
				}
			};
			// Slim specialization for the overwhelmingly common computed: a
			// (also skips the ctx object entirely — a 0-arity fn cannot see it)
			// zero-arity fn (cannot reach ctx.use/previous) with no custom
			// equality. The kernel's identity compare IS the §11.2 contract
			// then; only §11.3 error boxing remains — and only on the throw
			// path. Saves two stores + an equality call per recomputation
			// (kairo deep/repeatedObservers are recompute-dense).
			if (options.fn.length === 0 && userEq === undefined) {
				const plainFn = options.fn as unknown as () => unknown;
				const slimKernelFn = (prev?: unknown): unknown => {
					try {
						return plainFn();
					} catch (e) {
						return isErrorBox(prev) && Object.is(prev.error, e) ? prev : errorBox(e);
					}
				};
				const slimEvalFn = (): unknown => {
					try {
						return plainFn();
					} catch (e) {
						const prevBox = engine.policy.canonicalValue(self.handle);
						return isErrorBox(prevBox) && Object.is(prevBox.error, e) ? prevBox : errorBox(e);
					}
				};
				this.handle = engine.computed<unknown>(slimEvalFn, {
					isEqual: eq,
					label: options.label,
					kernelFn: slimKernelFn,
				});
				this.id = this.handle.id;
				return;
			}
			// Fused kernel wrapper: one frame per recomputation (kernel prev in
			// hand gives box reference-stability directly, §11.2/§11.3).
			const kernelFn = (prev?: unknown): unknown => {
				self.useIndex = 0;
				self.suspended = undefined;
				let next: unknown;
				try {
					next = fn(self.ctx);
				} catch (e) {
					const susp = self.suspended;
					if (e === SUSPEND && susp !== undefined) {
						return isSuspendedBox(prev) && Object.is(prev.thenable, susp)
							? prev
							: suspendedBox(susp);
					}
					return isErrorBox(prev) && Object.is(prev.error, e) ? prev : errorBox(e);
				}
				return prev !== undefined && eq(prev, next) ? prev : next;
			};

			this.handle = engine.computed<unknown>(evalFn, { isEqual: eq, label: options.label, kernelFn });
			this.id = this.handle.id;
		}

		private useThenable<U>(thenable: PromiseLike<U>): U {
			const kind = engine.policy.evalWorldKind();
			const key = kind === 'pass' ? engine.policy.passLineage() : 0;
			const cache = (this.thenableCache ??= new Map());
			let slots = cache.get(key);
			if (slots === undefined) {
				cache.set(key, (slots = []));
			}
			const i = this.useIndex++;
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
						this.onSettle(th);
					},
					(r) => {
						th.status = 'rejected';
						th.reason = r;
						this.onSettle(th);
					},
				);
			}
			if (th.status === 'fulfilled') {
				return th.value as U;
			}
			if (th.status === 'rejected') {
				throw th.reason;
			}
			this.suspended = th;
			throw SUSPEND; // abort the rest of the body (§12.3)
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
			});
		}

		get state(): T {
			const v = readComputedById(this.id);
			if (isBox(v)) {
				if (v.kind === 'error') {
					throw v.error;
				}
				throw v.thenable; // read sites suspend (React convention)
			}
			return v as T;
		}

		/** Non-throwing read: the value or its §11.3 box. */
		get boxed(): T | ErrorBox | SuspendedBox {
			return readComputedById(this.id) as T | ErrorBox | SuspendedBox;
		}

		/** Drop a retired render lineage's thenable positions (§12.3). */
		dropLineage(lineage: number): void {
			this.thenableCache?.delete(lineage);
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
