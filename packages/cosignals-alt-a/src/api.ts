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
import type { ComputedHandle, CosignalEngine, Equality, SignalHandle } from './engine'

// ---- §11.3 sentinel boxes ---------------------------------------------------------
export type ErrorBox = { kind: 'error'; error: unknown }
export type SuspendedBox = {
	kind: 'suspended'
	thenable: PromiseLike<unknown>
	/** Solid's STATUS_UNINITIALIZED analog, inverted: true once a real value
	 * has ever committed for this node — refresh-pending boxes carry it so
	 * boundaries can serve stale content instead of falling back. */
	hasLatest: boolean
	/** The last committed value (meaningful iff hasLatest). */
	latest: unknown
	/** What the REACT BOUNDARY throws: a per-box cached gate chained AFTER
	 * the engine's settlement handler, so React's retry render is always
	 * ordered after the settlement invalidate has landed (throwing the raw
	 * thenable races: React can retry between resolution and the invalidate
	 * microtask, re-suspend on an already-resolved thenable, and never
	 * retry again). Identity-stable across retries (cached on the box). */
	gate: PromiseLike<unknown>
}

const BOX = Symbol('cosignal.box')

type Boxed = (ErrorBox | SuspendedBox) & { [BOX]: true }

/** One brand check for the hot read path (unboxing discriminates after). */
function isBox(v: unknown): v is Boxed {
	return typeof v === 'object' && v !== null && (v as Boxed)[BOX] === true
}

export function isErrorBox(v: unknown): v is ErrorBox {
	return (
		typeof v === 'object' &&
		v !== null &&
		(v as Boxed)[BOX] === true &&
		(v as ErrorBox).kind === 'error'
	)
}

export function isSuspendedBox(v: unknown): v is SuspendedBox {
	return (
		typeof v === 'object' &&
		v !== null &&
		(v as Boxed)[BOX] === true &&
		(v as SuspendedBox).kind === 'suspended'
	)
}

function errorBox(error: unknown): ErrorBox {
	return { [BOX]: true, kind: 'error', error } as Boxed & ErrorBox
}

function suspendedBox(thenable: PromiseLike<unknown>, prev: unknown): SuspendedBox {
	// Carry the latest settled value forward: from a real previous value, or
	// through a chain of pending boxes (a refresh during a refresh).
	const prevBox = isBox(prev)
	const hasLatest = prev !== undefined && (!prevBox || (isSuspendedBox(prev) && prev.hasLatest))
	const latest = prevBox ? (isSuspendedBox(prev) ? prev.latest : undefined) : prev
	// The gate registers AFTER the engine's stamp handler (ctx.use stamped
	// the thenable before any box holding it exists), so gate listeners —
	// React's retry ping — run after the settlement microtask is queued;
	// always-resolving so rejections surface through the error path, never
	// as unhandled rejections.
	const gate = thenable.then(
		() => undefined,
		() => undefined,
	)
	return { [BOX]: true, kind: 'suspended', thenable, hasLatest, latest, gate } as Boxed &
		SuspendedBox
}

// ---- §12.3 thenable protocol -------------------------------------------------------
// DELIBERATELY NON-STANDARD field names: React's use() treats a thenable
// carrying a string `status` as externally instrumented and never attaches
// its own protocol writers — stamping `status`/`value`/`reason` on the
// USER's promise wedges any React-land use(P) consumer of the same promise
// (observed: permanent fallback, no retry ping). Our tracking must be
// invisible to React.
type TrackedThenable<T> = PromiseLike<T> & {
	csStatus?: 'pending' | 'fulfilled' | 'rejected'
	csValue?: T
	csReason?: unknown
}

// Module-level default equality for boxed computeds (no per-instance
// closure): identity semantics + §11.3 box reference rules. The `create`
// shape showed the per-computed closure bundle in GC attribution.
function defaultBoxedEq(a: unknown, b: unknown): boolean {
	const ab = isBox(a)
	const bb = isBox(b)
	if (ab || bb) {
		if (!ab || !bb) {
			return false
		}
		const ba = a
		const bx = b
		if (ba.kind !== bx.kind) {
			return false
		}
		return ba.kind === 'error'
			? Object.is((ba as ErrorBox).error, (bx as ErrorBox).error)
			: Object.is((ba as SuspendedBox).thenable, (bx as SuspendedBox).thenable)
	}
	return Object.is(a, b)
}

// ---- public option/ctx types (§4) ---------------------------------------------------
export type AtomCtx<T> = {
	peek(): T
	set(next: T): void
	update(fn: (current: T) => T): void
}

export type AtomOptions<T> = {
	/**
	 * Initial state, or a LAZY INITIALIZER (React useState convention: a
	 * function-valued state is treated as the initializer). The initializer
	 * is evaluated ONCE, lazily, at first materialization (first read,
	 * write, or subscription — never at construction), UNTRACKED, and must
	 * be pure w.r.t. the graph (writes inside it throw). First read during
	 * render is safe — that is the feature's point:
	 *
	 *     const visible = new Atom({
	 *         state: () => document.visibilityState === 'visible',
	 *     });
	 *
	 * To STORE a function as state, wrap it: `state: () => fn`.
	 */
	state: T | (() => T)
	effect?: (ctx: AtomCtx<T>) => (() => void) | void
	isEqual?: Equality<T>
	label?: string
}

export type ReducerAtomOptions<S, A> = {
	/** Initial state, or a lazy initializer (same contract as AtomOptions.state). */
	state: S | (() => S)
	reducer: (state: S, action: A) => S
	isEqual?: Equality<S>
	label?: string
}

export type ComputedCtx<T> = {
	use<U>(thenable: PromiseLike<U>): U
	readonly previous: T | undefined
}

export type ComputedOptions<T> = {
	fn: (ctx: ComputedCtx<T>) => T
	isEqual?: Equality<T>
	label?: string
}

export type CosignalAPI = ReturnType<typeof createAPI>

export function createAPI(engine: CosignalEngine) {
	const readAtomById = engine.readAtomById
	const readComputedById = engine.readComputedById

	class Atom<T> {
		private _handle: ReturnType<typeof engine.atom<T>> | undefined
		private id = 0 // 0 = unmaterialized (engine node ids are never 0)
		private _init: (() => T) | undefined
		private _opts: AtomOptions<T> | undefined
		constructor(options: AtomOptions<T>) {
			if (typeof options.state === 'function') {
				// LAZY INITIALIZER (React useState convention; see
				// AtomOptions.state): the engine node is minted at first
				// materialization — the initializer runs there, once.
				this._init = options.state as () => T
				this._opts = options
			} else {
				this.mint(options.state, options)
			}
		}
		private mint(initial: T, options: AtomOptions<T>): ReturnType<typeof engine.atom<T>> {
			const h = engine.atom<T>(initial, {
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
			})
			this._handle = h
			this.id = h.id
			// Cleared only on SUCCESS: a throwing initializer leaves the atom
			// unmaterialized (the next access retries — React semantics).
			this._init = undefined
			this._opts = undefined
			return h
		}
		get handle(): ReturnType<typeof engine.atom<T>> {
			// Materialization: fin-token minting, observe-lifecycle wiring and
			// everything else happen HERE for lazy atoms (mint-time =
			// materialization time). The initializer result is CANONICAL/BASE
			// state regardless of the reading context's world.
			return this._handle ?? this.mint(engine.policy.runInitializer(this._init!), this._opts!)
		}
		/** Introspection (tests/oracle): has the engine node been minted? */
		get materialized(): boolean {
			return this._handle !== undefined
		}
		/** §13.8 SSR install: counts as materialization, the initializer is
		 * SKIPPED — install transplants committed state, it is not a write
		 * (deliberate asymmetry with set(), which RUNS the initializer for
		 * the equality-drop contract; SPEC-RESOLUTIONS). */
		installState(v: T): void {
			if (this._handle === undefined && this._init !== undefined) {
				this.mint(v, this._opts!)
				return
			}
			this.handle.set(v)
		}
		get state(): T {
			const id = this.id
			return readAtomById(id !== 0 ? id : this.handle.id) as T
		}
		set(next: T): void {
			this.handle.set(next)
		}
		update(fn: (current: T) => T): void {
			this.handle.update(fn)
		}
	}

	class ReducerAtom<S, A> {
		private _handle: ReturnType<typeof engine.reducerAtom<S, A>> | undefined
		private id = 0 // 0 = unmaterialized
		private _init: (() => S) | undefined
		private _opts: ReducerAtomOptions<S, A> | undefined
		constructor(options: ReducerAtomOptions<S, A>) {
			if (typeof options.state === 'function') {
				this._init = options.state as () => S
				this._opts = options
			} else {
				this.mint(options.state, options)
			}
		}
		private mint(
			initial: S,
			options: ReducerAtomOptions<S, A>,
		): ReturnType<typeof engine.reducerAtom<S, A>> {
			const h = engine.reducerAtom<S, A>(initial, options.reducer, {
				isEqual: options.isEqual,
				label: options.label,
			})
			this._handle = h
			this.id = h.id
			this._init = undefined
			this._opts = undefined
			return h
		}
		get handle(): ReturnType<typeof engine.reducerAtom<S, A>> {
			return this._handle ?? this.mint(engine.policy.runInitializer(this._init!), this._opts!)
		}
		get materialized(): boolean {
			return this._handle !== undefined
		}
		/** §13.8 SSR install — same contract as Atom.installState. */
		installState(v: S): void {
			if (this._handle === undefined && this._init !== undefined) {
				this.mint(v, this._opts!)
				return
			}
			;(this.handle as unknown as { set(v: S): void }).set(v)
		}
		get state(): S {
			const id = this.id
			return readAtomById(id !== 0 ? id : this.handle.id) as S
		}
		dispatch(action: A): void {
			this.handle.dispatch(action) // materializes: the reducer folds over the initializer result
		}
	}

	// ---- Solid-2.0-adapted suspense (owner design change; see
	// SPEC-RESOLUTIONS.md "Async model"): pending/error are GRAPH STATE.
	// A computed hitting an unresolved async dep EVALUATES-TO-PENDING: the
	// evaluation registers every pending thenable it touched (no mid-eval
	// throw — parallel ctx.use fetches all register before pending surfaces),
	// and the result is a SuspendedBox holding the node's thenable, stored in
	// the ordinary value slots (canonical values / (node,world) memo slots) —
	// so status propagates downstream through propagate/shallowPropagate like
	// any value change, downstream evaluations FORWARD pending by default
	// (reading a pending dep records it on the active evaluation frame and
	// returns undefined), settlement is a normal write (invalidate →
	// propagate), and the React boundary throws the NODE-HELD thenable whose
	// identity is stable because it is store-held.
	//
	// Evaluation frames: one per active policy evaluation, pooled (the frame
	// allocation would otherwise be the kairo-deep regression all over again).
	type EvalFrame = { pending: PromiseLike<unknown>[]; usedCanonSlots: boolean }
	// Preallocated indexed stack (profiled: pool-array push/pop per recompute
	// cost kairo-deep ~85% — recomputes are the hot loop, frames must be an
	// index bump + two resets).
	const frameStack: EvalFrame[] = []
	let frameSp = 0

	function pushFrame(): EvalFrame {
		let f = frameStack[frameSp]
		if (f === undefined) {
			frameStack[frameSp] = f = { pending: [], usedCanonSlots: false }
		}
		if (f.pending.length !== 0) {
			f.pending.length = 0
		}
		f.usedCanonSlots = false
		++frameSp
		return f
	}

	function popFrame(): void {
		--frameSp
	}

	// Ultimate SOURCE SETS of join thenables (module-level: joins from one
	// node forward through others). A thenable absent from the map is its
	// own single source (a raw ctx.use fetch). Joins key on the FLATTENED
	// set: a world whose immediate parts are {join(a,b), a} must produce
	// the SAME thenable as one whose parts are {join(a,b)} — the wait set
	// is {a,b} either way (oracle-caught: fuzz seed 281 — a forwarded part
	// arriving both directly and inside a sibling's join made two worlds'
	// identical wait sets look different, a spurious pending→pending
	// broadcast).
	const joinSources = new WeakMap<PromiseLike<unknown>, PromiseLike<unknown>[]>()

	/** Forward a pending dep into the active evaluation, if one is open.
	 * Returns true when forwarded (the reader continues with undefined). */
	function forwardPending(th: PromiseLike<unknown>): boolean {
		if (frameSp === 0) {
			return false
		}
		const f = frameStack[frameSp - 1]
		if (!f.pending.includes(th)) {
			f.pending.push(th)
		}
		return true
	}

	class Computed<T> {
		readonly handle: ComputedHandle<unknown>
		private readonly id: number
		// Thenable slots per node×world (the §12.3 adaptation): positions are
		// stable for the node's life within one world key, so re-evaluations
		// and Suspense retries re-see the SAME store-held thenable. Canonical
		// slots clear after a settled completion (kernel re-evaluations are
		// dirty-gated, so the next evaluation is a REAL input change → fresh
		// fetch, Solid's latest-wins); world keys stay first-wins (overlay
		// re-evaluation is conservative and must not thrash fetches).
		private useSlots: Map<string, TrackedThenable<unknown>[]> | undefined
		private useIndex = 0
		// Canonical joins per SOURCE SET: the same set of pending thenables
		// always yields the same joined object (broadcast cutoffs and memo
		// equality then key on the true wait-set, not join allocation order).
		private pendingJoins:
			| Array<{ parts: PromiseLike<unknown>[]; joined: PromiseLike<unknown> }>
			| undefined
		private ctxLazy: ComputedCtx<T> | undefined

		private get ctx(): ComputedCtx<T> {
			const self = this // eslint-disable-line @typescript-eslint/no-this-alias
			return (this.ctxLazy ??= {
				get previous(): T | undefined {
					const prev = engine.policy.canonicalValue(self.handle)
					return isBox(prev) ? undefined : (prev as T | undefined)
				},
				use<U>(thenable: PromiseLike<U>): U {
					return self.useThenable(thenable)
				},
			})
		}

		constructor(options: ComputedOptions<T>) {
			const userEq = options.isEqual
			const eq: Equality<unknown> =
				userEq === undefined
					? defaultBoxedEq
					: (a, b) => {
							const ab = isBox(a)
							const bb = isBox(b)
							if (ab || bb) {
								return defaultBoxedEq(a, b)
							}
							return userEq(a as T, b as T)
						}

			const self = this // eslint-disable-line @typescript-eslint/no-this-alias
			const fn = options.fn
			// The shared evaluation body: run under a frame; a throw is §11.3
			// error state; recorded pendings make the result a SuspendedBox
			// holding the node's (joined) thenable.
			const evaluate = (prevForBoxes: unknown): unknown => {
				self.useIndex = 0
				const frame = pushFrame()
				let next: unknown
				try {
					next = fn(self.ctx)
				} catch (e) {
					popFrame()
					return isErrorBox(prevForBoxes) && Object.is(prevForBoxes.error, e)
						? prevForBoxes
						: errorBox(e)
				}
				const pendingCount = frame.pending.length
				const usedCanon = frame.usedCanonSlots
				if (pendingCount !== 0) {
					const th = self.joinPending(frame.pending)
					popFrame()
					return isSuspendedBox(prevForBoxes) && Object.is(prevForBoxes.thenable, th)
						? prevForBoxes
						: suspendedBox(th, prevForBoxes)
				}
				popFrame()
				if (usedCanon) {
					// Settled completion consumed the canonical slots: the next
					// canonical evaluation is a real input change (exact pull
					// counts) → fresh fetches (latest-wins).
					self.useSlots?.delete('canon')
				}
				return next
			}
			// Raw overlay-evaluation fn (§10.5): box stability via the canonical
			// cache (overlay evaluations carry no kernel prev).
			const evalFn = (): unknown => evaluate(engine.policy.canonicalValue(self.handle))
			// Slim specialization: zero-arity fn (cannot reach ctx) + no custom
			// equality. It can still READ pending deps, so it still runs under a
			// frame — but skips ctx/slot bookkeeping entirely.
			if (options.fn.length === 0 && userEq === undefined) {
				const plainFn = options.fn as unknown as () => unknown
				const slimBody = (prevForBoxes: unknown): unknown => {
					const frame = pushFrame()
					let next: unknown
					try {
						next = plainFn()
					} catch (e) {
						popFrame()
						return isErrorBox(prevForBoxes) && Object.is(prevForBoxes.error, e)
							? prevForBoxes
							: errorBox(e)
					}
					const pendingCount = frame.pending.length
					if (pendingCount !== 0) {
						const th = self.joinPending(frame.pending)
						popFrame()
						return isSuspendedBox(prevForBoxes) && Object.is(prevForBoxes.thenable, th)
							? prevForBoxes
							: suspendedBox(th, prevForBoxes)
					}
					popFrame()
					return next
				}
				this.handle = engine.computed<unknown>(
					() => slimBody(engine.policy.canonicalValue(self.handle)),
					{
						isEqual: eq,
						label: options.label,
						kernelFn: (prev?: unknown): unknown => slimBody(prev),
					},
				)
				this.id = this.handle.id
				instancesByHandle.set(this.handle, this)
				return
			}
			// Fused kernel wrapper: canonical evaluations carry the kernel's
			// prev for box reference-stability and equality (§11.2/§11.3).
			const kernelFn = (prev?: unknown): unknown => {
				const next = evaluate(prev)
				if (isBox(next)) {
					return next
				}
				return prev !== undefined && eq(prev, next) ? prev : next
			}

			this.handle = engine.computed<unknown>(evalFn, {
				isEqual: eq,
				label: options.label,
				kernelFn,
			})
			this.id = this.handle.id
			instancesByHandle.set(this.handle, this)
		}

		/** refresh() support: drop every world's thenable slots so the next
		 * evaluation re-registers fresh fetches. The pendingJoins cache is
		 * deliberately KEPT — it is identity infrastructure (same pending
		 * source set ⇒ same joined thenable, forever); clearing it would mint
		 * a new join for an identical set, a pending→pending identity change
		 * that would spuriously re-broadcast (caught by the oracle fuzz). */
		clearUseSlots(): void {
			this.useSlots = undefined
		}

		/** One thenable identity per evaluation outcome: the single pending
		 * source, or a node-cached join of the set (so retries re-see the same
		 * object even with parallel fetches). */
		private joinPending(parts: PromiseLike<unknown>[]): PromiseLike<unknown> {
			// FLATTEN to the ultimate source set (see joinSources).
			let flat: PromiseLike<unknown>[]
			if (parts.length === 1 && joinSources.get(parts[0]) === undefined) {
				return parts[0] // raw singleton: pass through (hot path)
			}
			flat = []
			for (const p of parts) {
				const src = joinSources.get(p)
				if (src === undefined) {
					if (!flat.includes(p)) {
						flat.push(p)
					}
				} else {
					for (const u of src) {
						if (!flat.includes(u)) {
							flat.push(u)
						}
					}
				}
			}
			if (flat.length === 1) {
				return flat[0]
			}
			// Pass-through: an immediate part already waiting on EXACTLY this
			// set is the join (keeps forwarded identity stable across worlds).
			for (const p of parts) {
				const src = joinSources.get(p)
				if (src !== undefined && src.length === flat.length && flat.every((t) => src.includes(t))) {
					return p
				}
			}
			const joins = (this.pendingJoins ??= [])
			for (const cached of joins) {
				if (
					cached.parts.length === flat.length &&
					flat.every((t) => cached.parts.includes(t)) // set equality
				) {
					return cached.joined
				}
			}
			const joined = Promise.all(flat).then(() => undefined) as PromiseLike<unknown>
			joinSources.set(joined, flat)
			joins.push({ parts: flat, joined })
			return joined
		}

		/** §12.3 (adapted): record-pending-and-return. Never throws mid-eval
		 * for pending — parallel ctx.use calls all register their fetches
		 * before pending surfaces on the node. */
		private useThenable<U>(thenable: PromiseLike<U>): U {
			if (frameSp === 0) {
				throw new Error('cosignal: ctx.use may only run inside a computed evaluation')
			}
			const frame = frameStack[frameSp - 1]
			const key = engine.policy.useCacheKey()
			const slots = (this.useSlots ??= new Map())
			let arr = slots.get(key)
			if (arr === undefined) {
				slots.set(key, (arr = []))
			}
			const i = this.useIndex++
			if (key === 'canon') {
				// Mark EVERY canonical slot access: a settled completion then
				// clears the canonical slots, so the next dirty-gated canonical
				// evaluation (a real input change — exact pull counts) fetches
				// fresh (latest-wins).
				frame.usedCanonSlots = true
			}
			let th = arr[i] as TrackedThenable<U> | undefined
			if (th === undefined) {
				arr[i] = (th = thenable as TrackedThenable<U>) as TrackedThenable<unknown>
			} else if (th.csStatus === 'pending' && !Object.is(th, thenable)) {
				// LATEST-WINS while pending (the Solid rule): re-evaluations are
				// dirty/cert-gated, so a different incoming thenable at a pending
				// position means the inputs moved — the stale in-flight fetch
				// must not answer for the new inputs. (Settled occupants stay
				// first-wins until the settled-completion clear; keyed data
				// layers make the replace a no-op.) The superseded promise still
				// settles harmlessly — its onSettle no-ops once the node's box
				// no longer holds it.
				arr[i] = (th = thenable as TrackedThenable<U>) as TrackedThenable<unknown>
			}
			if (th.csStatus === undefined) {
				th.csStatus = 'pending'
				th.then(
					(v) => {
						th.csStatus = 'fulfilled'
						th.csValue = v
						this.onSettle(th)
					},
					(r) => {
						th.csStatus = 'rejected'
						th.csReason = r
						this.onSettle(th)
					},
				)
			}
			if (th.csStatus === 'fulfilled') {
				return th.csValue as U
			}
			if (th.csStatus === 'rejected') {
				throw th.csReason
			}
			if (!frame.pending.includes(th)) {
				frame.pending.push(th)
			}
			// The evaluation continues (its result is discarded — the node
			// evaluates-to-pending); undefined is the documented in-flight
			// stand-in a pending read produces.
			return undefined as U
		}

		private onSettle(th: PromiseLike<unknown>): void {
			queueMicrotask(() => {
				// Settlement is a NORMAL WRITE (§12.3 adapted): if the canonical
				// value still holds a pending box containing this thenable
				// (directly or via a join), commit the resumption through
				// invalidate → propagate.
				const cached = engine.policy.canonicalValue(this.handle)
				if (
					isSuspendedBox(cached) &&
					(Object.is(cached.thenable, th) ||
						this.pendingJoins?.some(
							(j) => Object.is(j.joined, cached.thenable) && j.parts.some((p) => Object.is(p, th)),
						) === true)
				) {
					engine.policy.invalidate(this.handle)
				}
				// A settlement moves no atom's tape: bump the overlay epoch so
				// world memos holding the pending box re-validate.
				engine.policy.bumpOverlayEpoch()
			})
		}

		get state(): T {
			const v = readComputedById(this.id)
			if (isBox(v)) {
				if (v.kind === 'error') {
					throw v.error // error state surfaces at read sites (§11.3)
				}
				// Pending: inside an evaluation, FORWARD (status propagates as
				// graph state).
				if (forwardPending(v.thenable)) {
					return undefined as T
				}
				// Top-level read — the CONTEXT-SENSITIVE two-level rule (owner
				// amendment): (a) inside a TRANSITION render pass, always hand
				// the thenable to React — React holds old UI natively and the
				// transition waits for settlement, keeping use(P) consumers and
				// signals consumers on the SAME promise (no early stale commit,
				// no tearing); (b) urgent/sync reads with a latest serve it
				// straight through (no fallback flash); (c) never-settled
				// suspends everywhere.
				if ((v as SuspendedBox).hasLatest && !engine.policy.inTransitionRender()) {
					return (v as SuspendedBox).latest as T
				}
				throw (v as SuspendedBox).gate
			}
			return v as T
		}

		/** Non-throwing read: the value or its §11.3 status box. */
		get boxed(): T | ErrorBox | SuspendedBox {
			return readComputedById(this.id) as T | ErrorBox | SuspendedBox
		}
	}

	// ---- Solid-2.0 async API set (owner brief; research/solid2-async-model.md §7) ----

	/** Computed instances by handle (refresh needs the slot owner). */
	const instancesByHandle = new WeakMap<object, Computed<unknown>>()
	/** Lazily-created cached isPending probe per node (§3 helper-node analog). */
	const pendingProbes = new WeakMap<object, Computed<boolean>>()

	function handleOfSource(x: { handle: SignalHandle } | SignalHandle): SignalHandle {
		return 'handle' in x ? x.handle : x
	}

	/**
	 * Reactive "is it showing stale/pending data?" — a lazily-created cached
	 * computed per node over the BOX SHAPE (raw engine read: no unboxing, no
	 * pending registration), so the boolean flips only on pending↔settled
	 * transitions (equality cutoff) and is per-world correct by construction
	 * (the probe evaluates in whatever world its reader resolves).
	 * Divergence from Solid noted in SPEC-RESOLUTIONS: the probe never
	 * rethrows on uninitialized first load (React boundaries get first-load
	 * suspension from useSignal itself) and never triggers refetches (it
	 * reads the cached box, §8 "probes don't refetch").
	 */
	function isPending(source: { handle: SignalHandle } | SignalHandle): boolean {
		return pendingProbe(source).state
	}

	/**
	 * Force a refetch with unchanged inputs: clear the node's thenable slots
	 * (ctx.use re-registers fresh fetches) and invalidate through the normal
	 * write path. `latest` is PRESERVED — the new pending box carries the
	 * last committed value, so boundaries show stale content (refresh-pending),
	 * never a fallback. Latest-wins supersession applies to refresh races
	 * (a superseded in-flight settlement no-ops). No-op on atoms and on
	 * computeds this API did not create (Solid: refresh no-ops on plain
	 * signals).
	 */
	/** The node's isPending probe computed (created if needed) — hooks
	 * subscribe to it like any signal. */
	function pendingProbe(source: { handle: SignalHandle } | SignalHandle): Computed<boolean> {
		const h = handleOfSource(source)
		let probe = pendingProbes.get(h)
		if (probe === undefined) {
			probe = new Computed<boolean>({
				fn: () => isSuspendedBox(engine.readComputedRaw(h.id)),
			})
			pendingProbes.set(h, probe)
		}
		return probe
	}

	function refresh(source: { handle: SignalHandle } | SignalHandle): void {
		const h = handleOfSource(source)
		const inst = instancesByHandle.get(h)
		if (inst === undefined) {
			return // plain signal / foreign node: no-op
		}
		inst.clearUseSlots()
		engine.policy.invalidate(h)
	}

	/**
	 * Read current-or-stale without suspending and without registering
	 * pending — Solid's `latest()` as WORLD SAMPLING (research §3):
	 *
	 *  - the async node itself → its last committed value (`box.latest`);
	 *  - anything upstream of the async → the NEWEST world's value (Wn: every
	 *    write visible — our analog of Solid's staged `_pendingValue`), so a
	 *    loading indicator can show the in-flight input while the async
	 *    output stays stale.
	 *
	 * World sampled PER READ CONTEXT (family convergence, alt-b
	 * adjudicated): top-level/handlers/effects sample Wn (drafts included);
	 * inside RENDER it samples the PASS WORLD (reading ahead of the pin
	 * would be a tear — a replayed render could commit mixed frames; use
	 * useIsPending for render-time loading indicators); inside a memoized
	 * evaluation it samples the eval's own world (certificates stay
	 * per-world). Tracked callers still subscribe to the node.
	 */
	function latest<T>(source: { handle: SignalHandle } | SignalHandle): T | undefined {
		const h = handleOfSource(source)
		const v = engine.latestValue(h.id)
		if (isBox(v)) {
			if (v.kind === 'error') {
				throw v.error
			}
			return ((v as SuspendedBox).hasLatest ? (v as SuspendedBox).latest : undefined) as
				| T
				| undefined
		}
		return v as T
	}

	/**
	 * Read the COMMITTED value — what is ON SCREEN (per-root when a
	 * container is given, the global committed view otherwise). The fourth
	 * member of the read family (ALT-FAMILY VISIBILITY RULE):
	 *
	 *   .state        → real      (W0: committed + applied urgent; drafts hidden)
	 *   latest(x)     → intent    (Wn: newest, pending drafts included)
	 *   committed(x)  → on screen (retired batches a root has committed)
	 *   isPending(x)  → loading   (flip-only probe)
	 *
	 * Boxes unbox like latest(): errors throw; a committed pending box
	 * serves its carried latest (or undefined before any settlement).
	 * Never subscribes — pair with useCommitted for reactive reads.
	 */
	function committed<T>(
		source: { handle: SignalHandle } | SignalHandle,
		container?: unknown,
	): T | undefined {
		const h = handleOfSource(source)
		const v = engine.readCommitted(h, container)
		if (isBox(v)) {
			if (v.kind === 'error') {
				throw v.error
			}
			return ((v as SuspendedBox).hasLatest ? (v as SuspendedBox).latest : undefined) as
				| T
				| undefined
		}
		return v as T
	}

	type Serializable = { handle: SignalHandle } | SignalHandle
	const handleOf = (x: Serializable): SignalHandle => ('handle' in x ? x.handle : x)

	/** §13.8 Server: capture committed leaf values. Keys are app-supplied
	 * strings — debug labels are not identity, creation order is not stable. */
	function serializeAtomState(
		atoms: Record<string, Serializable>,
		replacer?: (key: string, value: unknown) => unknown,
	): string {
		const out: Record<string, unknown> = {}
		for (const [key, a] of Object.entries(atoms)) {
			const v = engine.readCommitted(handleOf(a))
			out[key] = replacer !== undefined ? replacer(key, v) : v
		}
		return JSON.stringify(out)
	}

	/** §13.8 Client: install serialized values into matching atoms. MUST run
	 * before hydration so the first client render reads identical committed
	 * values. Unknown keys warn; missing keys leave the constructor default. */
	function initializeAtomState(
		json: string,
		atoms: Record<string, { handle: { set(v: unknown): void } } | { set(v: unknown): void }>,
		reviver?: (key: string, value: unknown) => unknown,
	): void {
		const data = JSON.parse(json) as Record<string, unknown>
		for (const [key, raw] of Object.entries(data)) {
			const target = atoms[key]
			if (target === undefined) {
				console.warn(`cosignal: initializeAtomState: unknown key "${key}"`)
				continue
			}
			const v = reviver !== undefined ? reviver(key, raw) : raw
			// Lazy class atoms install WITHOUT running the initializer (the
			// server's committed value replaces it — install ≠ write).
			const installable = target as { installState?: (x: unknown) => void }
			if (typeof installable.installState === 'function') {
				installable.installState(v)
				continue
			}
			const settable = 'handle' in target ? target.handle : target
			settable.set(v)
		}
	}

	return {
		Atom,
		ReducerAtom,
		Computed,
		isPending,
		pendingProbe,
		refresh,
		latest,
		committed,
		effect: engine.effect,
		effectScope: engine.effectScope,
		batch: engine.batch,
		untracked: engine.untracked,
		configure: engine.configure,
		serializeAtomState,
		initializeAtomState,
		engine,
	}
}
