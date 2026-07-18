/**
 * The signal API implementation: atoms, computeds, effects, and the
 * read/write paths that connect them to React transitions.
 *
 * Base state lives in a conventional signal graph (graph.ts: lazy cached
 * computeds, effects, batching) whose node and link records live in one
 * typed-array arena. React-transition support is a thin overlay on top
 * (worlds.ts): writes issued inside a transition are recorded into a
 * draft instead of hitting the atom, and each reader resolves values
 * against base state plus the drafts it is allowed to see. See the
 * worlds.ts header for the full model; this file only decides which path
 * each read and write takes.
 *
 * This module exports everything, for the package's own use. What users
 * see is curated by the entry modules:
 * - index.ts (`cosignals-arena`) — the app-author API;
 * - unstable.ts (`cosignals-arena/unstable`) — integration seams, no
 *   compatibility promise;
 * - testing.ts (`cosignals-arena/testing`) — test-only helpers.
 */

import {
  type CellNode,
  type DerivedNode,
  type EqualsFn,
  type Flags,
  type TraceEventId,
  ReactiveNode,
  type UseFn,
  Flag,
  Lane,
  NodeSlot,
  UNINITIALIZED,
  assertSignalReadAllowed,
  assertSignalWriteAllowed,
  activeEvaluation,
  currentCause,
  flushLifetimeTransitions,
  getActiveConsumer,
  isUninitialized,
  initializeCell,
  initializeDerived,
  makeEffect,
  peekCell,
  readCell,
  readDerived,
  resetEffectLanes,
  resetGraphForBenchmark,
  runUpdater,
  untrack as graphUntrack,
  activeTracer,
  writeCell,
  graphMemory,
} from "./graph.ts"
import {
  type ErrorBox,
  type ResolvedState,
  type Suspension,
  asyncPlaneUsed,
  baseUse,
  unwrapResolved,
} from "./asyncs.ts"
import {
  type Draft,
  type DraftId,
  type World,
  BASE_WORLD,
  appendDraftIntent,
  appendUrgentIntent,
  cellHasDraftIntents,
  classifyWrite,
  currentPark,
  draftsAffecting,
  discardAllDrafts,
  getCurrentWorld,
  latestWorld,
  peekWorldMemo,
  pokeRebasedCell,
  resolveState,
  resolveStateUntracked,
  setAmbientClassifier,
  worldOf,
} from "./worlds.ts"
import { getActiveTracer } from "./tracer.ts"

// ---------------------------------------------------------------------------
// Public handle types
// ---------------------------------------------------------------------------

/** Options accepted by createAtom(). */
export interface AtomOptions<T> {
  /** Value equality for the cutoff; defaults to Object.is. */
  equals?: EqualsFn<T>
  /** Debug name shown in trace output. */
  label?: string
  /**
   * Runs when the atom gains its first subscriber of any kind; the cleanup
   * runs when the last subscriber of every kind is gone.
   */
  onObserved?: (ctx: { get(): T; set(v: T): void }) => void | (() => void)
}

/** Options accepted by createComputed(). */
export interface ComputedOptions<T> {
  /** Value equality for the cutoff; defaults to Object.is. */
  equals?: EqualsFn<T>
  /** Debug name shown in trace output. */
  label?: string
}

/**
 * Marks an object as a signal handle backed by an engine node. Atoms and
 * computeds carry it; {@link isSignal} tests for it. A registry symbol
 * (Symbol.for), so two copies of the library loaded into one page agree
 * on what counts as a signal.
 */
export const SIGNAL_BRAND: unique symbol = Symbol.for("cosignals-arena.signal")

/** A writable reactive value. */
export type Atom<in out T> = {
  /** Brand identifying engine-backed handles; see {@link isSignal}. */
  readonly [SIGNAL_BRAND]: true
  /**
   * Tracked read: inside a computed, an effect source, or a subscribed
   * component, this registers a dependency, so the reader re-runs when
   * the value changes. What it returns depends on where it runs:
   * - ordinarily: the committed value, with pending React transitions'
   *   writes hidden;
   * - inside a React render (or a computed evaluated for one): the
   *   snapshot that render was given, which includes the writes of any
   *   transition it belongs to.
   */
  get(): T
  /**
   * Write through the equality cutoff (equal writes are dropped). Inside
   * a React transition the write is held with the transition and stays
   * invisible outside it until the transition commits.
   */
  set(value: T): void
  /**
   * Functional update. Inside a transition the function itself is
   * recorded and replays against whatever value each pending snapshot
   * starts from, the way React replays queued useState updaters — keep
   * it pure.
   */
  update(fn: (prev: T) => T): void
  /** Read the current value without registering a dependency. */
  peek(): T
}

// A class expression keeps the public structural Atom type separate from
// the private constructor while giving the runtime value the same name.
const Atom = class<T> extends ReactiveNode implements CellNode<T> {
  declare readonly [SIGNAL_BRAND]: true
  declare value: T | typeof UNINITIALIZED
  declare initializer: (() => T) | undefined
  declare equals: EqualsFn<T>
  declare lifetime: CellNode<T>["lifetime"]
  declare lifetimeCleanup: (() => void) | undefined
  declare lifetimeActive: boolean
  /** @internal Compatibility alias; the handle itself owns the internals. */
  get node(): this {
    return this
  }
  constructor(initial: T | (() => T), opts?: AtomOptions<T>) {
    super()
    initializeCell(this, initial, opts)
  }
  // World evaluations run untracked — their staleness evidence is the
  // certificate, not graph edges — so only the base branch registers a
  // dependency. (User-facing contracts live on the public Atom type.)
  get(): T {
    const world = getCurrentWorld()
    if (world !== null) {
      // Every read within a selected world resolves that same world.
      return resolveState(this, world).value as T
    }
    return readCell(this)
  }
  set(value: T): void {
    setAtom(this, value)
  }
  update(fn: (prev: T) => T): void {
    updateAtom(this, fn)
  }
  peek(): T {
    const world = getCurrentWorld()
    if (world !== null) {
      return resolveStateUntracked(this, world).value as T
    }
    return peekCell(this)
  }
}
// The brand lives on the prototype: one property for every atom instead
// of one own property per instance.
Object.defineProperty(Atom.prototype, SIGNAL_BRAND, { value: true })

/** An atom whose dispatches replay through one reducer fixed at creation. */
export type ReducerAtom<S, A> = Atom<S> & {
  /**
   * Apply `action` through the reducer fixed at creation. Inside a
   * React transition the dispatch is recorded and replayed against each
   * pending snapshot, the same way {@link Atom.update} records its
   * function — so keep the reducer pure.
   */
  dispatch: (action: A) => void
}

type ReducerAtomNode<S, A> = ReducerAtom<S, A> &
  CellNode<S> & {
    reduce: (state: S, action: A) => S
  }

/**
 * Shared by every reducer atom, avoiding one dispatch closure per atom.
 * TypeScript erases the fake `this` parameter.
 */
function dispatchReducer<S, A>(this: ReducerAtomNode<S, A>, action: A): void {
  const reduce = this.reduce
  this.update((state) => reduce(state, action))
}

/**
 * A cached value derived from atoms and other computeds; recomputes
 * only when read after a dependency changed.
 */
export type Computed<out T> = {
  /** Brand identifying engine-backed handles; see {@link isSignal}. */
  readonly [SIGNAL_BRAND]: true
  /**
   * Tracked, cached read: registers a dependency and recomputes only if
   * a dependency changed. When the computed is async (its function reads
   * a promise through `use`), the result depends on that promise:
   * - settled: returns the settled value;
   * - pending behind an earlier settled value (a refetch): keeps
   *   returning that earlier value, and {@link isPending} reports true;
   * - pending with nothing settled yet (a first load): throws the
   *   computed's stable pending promise, which React Suspense catches;
   * - failed: rethrows the same error object at every read site.
   */
  get(): T
  /**
   * get() without the dependency: returns the same value in every
   * situation described above, but the reader never re-runs when this
   * computed changes.
   */
  peek(): T
}

const Computed = class<T> extends ReactiveNode implements DerivedNode<T> {
  declare readonly [SIGNAL_BRAND]: true
  declare value: T | typeof UNINITIALIZED
  declare fn: DerivedNode<T>["fn"]
  declare equals: EqualsFn<T>
  constructor(fn: (use: UseFn, previous: T | undefined) => T, opts?: ComputedOptions<T>) {
    super()
    initializeDerived(this, fn, opts)
  }
  // World resolutions unwrap under the ambient park (an enclosing draft
  // evaluation forwards pendingness; a render serves stale or suspends) —
  // the same rule for tracked get() and untracked peek(), so the two
  // cannot drift on async behavior.
  get(): T {
    const world = getCurrentWorld()
    if (world !== null) {
      // Every read within a selected world resolves that same world.
      return unwrapResolved(resolveState(this, world), currentPark) as T
    }
    const value = readDerived(this)
    if (asyncPlaneUsed && (graphMemory[this.id + NodeSlot.Flags] & Flag.AsyncMask) !== 0) {
      return unwrapAsyncRead(this as DerivedNode<unknown>) as T
    }
    return value
  }
  peek(): T {
    const world = getCurrentWorld()
    if (world !== null) {
      return unwrapResolved(resolveStateUntracked(this, world), currentPark) as T
    }
    return graphUntrack(() => this.get())
  }
}
// The brand lives on the prototype: one property for every computed
// instead of one own property per instance.
Object.defineProperty(Computed.prototype, SIGNAL_BRAND, { value: true })

/** Any reactive value that can be tracked automatically. */
export type Signal<T> = Atom<T> | Computed<T>

/**
 * Create a writable signal.
 *
 * Passing a function creates a lazy atom: the initializer runs once, on the
 * first read, write, or subscription. Use `opts.equals` to change which writes
 * count as a value change and `opts.onObserved` to tie an external resource to
 * the atom's observed lifetime.
 */
export function createAtom<T>(initial: T | (() => T), opts?: AtomOptions<T>): Atom<T> {
  return new Atom(initial, opts)
}

/**
 * Create a writable signal whose `dispatch` method applies one reducer.
 *
 * A dispatch inside a React transition records the reducer application, then
 * replays it over intervening urgent writes in dispatch order. Keep the
 * reducer pure for the same reason React reducers and state updaters must be
 * pure.
 */
export function createReducerAtom<S, A>(
  reduce: (state: S, action: A) => S,
  initial: S | (() => S),
  opts?: AtomOptions<S>,
): ReducerAtom<S, A> {
  const node = new Atom(initial, opts) as unknown as ReducerAtomNode<S, A>
  node.reduce = reduce
  node.dispatch = dispatchReducer
  return node
}

/**
 * Create a lazy, cached value derived from other signals.
 *
 * Reads performed by `fn` become dependencies for that evaluation. The next
 * read recomputes only after one of those dependencies changes. `use` unwraps
 * stable thenables and `previous` is the last settled value, when one exists.
 */
export function createComputed<T>(
  fn: (use: UseFn, previous: T | undefined) => T,
  opts?: ComputedOptions<T>,
): Computed<T> {
  return new Computed(fn, opts)
}

/**
 * Resolve a signal handle to its engine node, for inspection and
 * integration code that works below the handle API. Throws when given
 * anything that is not an atom or computed from this library.
 */
export function nodeOf(x: Signal<any>): ReactiveNode {
  const node = x as unknown as ReactiveNode
  if (typeof node.id === "number" && (node.flags & (Flag.KindCell | Flag.KindDerived)) !== 0) {
    return node
  }
  throw new TypeError("expected an atom or computed handle")
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Finish a computed read that found the node in an async state: park an
 * evaluating consumer on the suspension (pending forwards), then apply the
 * shared unwrap — rethrow errors, serve stale data when a settled value
 * exists, otherwise suspend (first load).
 */
function unwrapAsyncRead(node: DerivedNode<unknown>): unknown {
  if ((graphMemory[node.id + NodeSlot.Flags] & Flag.AsyncSuspended) !== 0) {
    const consumer = getActiveConsumer()
    if (consumer !== null && (graphMemory[consumer.id + NodeSlot.Flags] & Flag.KindCell) === 0) {
      // baseUse parks the consumer and throws; it never returns here.
      baseUse((node.throwable as Suspension).promise, consumer as DerivedNode<unknown>)
    }
  }
  return unwrapResolved(node as ResolvedState, null)
}

/**
 * The value slot of a state view, with the uninitialized sentinel
 * normalized to undefined — latest() never suspends, so a suspended state
 * with no settled value reads as undefined there.
 */
function stateValue(st: ResolvedState): unknown {
  return isUninitialized(st.value) ? undefined : st.value
}

/**
 * Read the newest view of x: base state plus every live transition
 * draft. Never suspends. That meaning only applies outside any
 * evaluation or render. Inside one, latest() resolves the caller's own
 * context instead, because reading ahead of your context would show a
 * torn mix of snapshots:
 * - a transition-draft evaluation reads its own draft's view;
 * - a base-state computed or effect reads base state;
 * - a React render pass reads that pass's view.
 */
export function latest<T>(x: Signal<T>): T {
  const node = nodeOf(x)
  let world = getCurrentWorld()
  if (world === null) {
    if (getActiveConsumer() !== null) {
      // A base-state evaluation is running. Its world is base state, and
      // this read is a real dependency: track it so a later change to x
      // re-runs the consumer rather than leaving it permanently stale.
      world = BASE_WORLD
      if ((node.flags & Flag.KindCell) !== 0) {
        readCell(node as CellNode<unknown>)
      } else {
        readDerived(node as DerivedNode<unknown>)
      }
    } else {
      world = renderWorld() ?? latestWorld()
    }
  }
  const st = resolveState(node, world)
  if ((st.flags & Flag.AsyncError) !== 0) {
    throw (st.throwable as ErrorBox).error
  }
  return stateValue(st) as T
}

/**
 * True while newer data exists behind what is on screen:
 * - a transition draft with writes over x is still pending, or
 * - an async computed is loading again while its previous settled value
 *   keeps serving.
 * Passive by contract: never evaluates, never refetches, never
 * suspends.
 */
export function isPending(x: Signal<any>): boolean {
  return isPendingPassive(nodeOf(x), getCurrentWorld() ?? renderWorld())
}

/**
 * Node-level pendingness probe, also used by the React bindings'
 * useIsPending. `world` scopes the suspended-memo check; null means
 * ambient.
 */
export function isPendingPassive(node: ReactiveNode, world: World | null): boolean {
  assertSignalReadAllowed()
  const flags = graphMemory[node.id + NodeSlot.Flags]
  if ((flags & Flag.KindCell) !== 0) {
    return cellHasDraftIntents(node as CellNode<unknown>)
  }
  if ((flags & Flag.KindDerived) === 0) {
    return false
  }
  // Pending means "stale data exists while newer data loads". A
  // suspension with settled history is pending; a first load is not — it
  // has no stale data to indicate over, and suspending is Suspense's
  // job, not the indicator's.
  if ((flags & Flag.AsyncSuspended) !== 0) {
    return !isUninitialized((node as DerivedNode<unknown>).value)
  }
  if (world !== null && world.drafts.length > 0) {
    const memo = peekWorldMemo(node, world.sig)
    if (memo !== undefined && (memo.flags & Flag.AsyncSuspended) !== 0) {
      return !isUninitialized(memo.value)
    }
  }
  // A drafted input anywhere in the dependency closure means newer data
  // is pending behind this computed's base value. Pendingness is
  // transitive: a computed over a pending source is itself pending. The
  // closure walk is the same one late-subscription repair uses.
  return draftsAffecting(node).length !== 0
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Installed by the React bindings: throws when called during a render. */
let renderWriteGuard: (() => void) | null = null
/**
 * Install a check that runs before every write and may throw to reject
 * it; the React bindings use this to forbid writes during a render. Pass
 * null to remove it.
 */
export function setRenderWriteGuard(fn: (() => void) | null): void {
  renderWriteGuard = fn
}
function guardRenderWrite(): void {
  renderWriteGuard?.()
}

/**
 * The implementation behind {@link Atom.set}: write through the equality
 * cutoff.
 *
 * Outside a transition the value changes immediately. Inside a React
 * transition the value is recorded in that transition's draft and stays
 * hidden from the committed tree until the transition lands.
 */
function setAtom<T>(x: Atom<T>, value: T): void {
  assertSignalWriteAllowed()
  guardRenderWrite()
  const cell = x as unknown as CellNode<unknown>
  const draft = classifyWrite()
  if (draft !== null) {
    appendDraftIntent(draft, cell, "set", value)
    return
  }
  // Urgent write: base state moves now, and pending worlds will replay
  // the intent in dispatch order.
  const rebased = appendUrgentIntent(cell, "set", value)
  const changed = writeCell(cell, value)
  // When the write was a base-state no-op (equality) but the atom has
  // pending drafts, the drafted replays still changed — their audiences
  // must hear about it even though no wave ran.
  if (rebased && !changed) {
    pokeRebasedCell(cell)
  }
}

/**
 * The implementation behind {@link Atom.update}: update an atom from its
 * previous value.
 *
 * Transition updates record `fn`, not its immediate result, so it can replay
 * over urgent writes that happen before the transition commits. Keep the
 * updater pure because React may replay it.
 */
function updateAtom<T>(x: Atom<T>, fn: (prev: T) => T): void {
  assertSignalWriteAllowed()
  guardRenderWrite()
  const cell = x as unknown as CellNode<unknown>
  const draft = classifyWrite()
  if (draft !== null) {
    appendDraftIntent(draft, cell, "update", fn)
    return
  }
  const previous = peekCell(cell) as T
  let next: T
  try {
    next = runUpdater(fn, previous)
  } catch (error) {
    if (activeTracer !== null) {
      activeTracer.emitEvent("callback-error", activeEvaluation, currentCause, {
        error,
        phase: "updater",
      })
    }
    throw error
  }
  const rebased = appendUrgentIntent(cell, "update", fn)
  const changed = writeCell(cell, next, "update")
  if (rebased && !changed) {
    pokeRebasedCell(cell)
  }
}

// ---------------------------------------------------------------------------
// Effects, batching, untrack
// ---------------------------------------------------------------------------

/**
 * When an effect's handler runs after a watched signal changes:
 * - 'sync' (the default): immediately, as part of the write;
 * - 'useLayoutEffect' or 'useEffect': in that phase of the React update
 *   the change caused, alongside components' own effects of that phase.
 * The very first run at creation is always synchronous, whatever the
 * schedule.
 */
export type EffectSchedule = "sync" | "useLayoutEffect" | "useEffect"

/**
 * Options accepted by createEffect(). `equals` and `label` configure the
 * effect's source exactly as on createComputed; the same `equals` also
 * decides whether a new value is different enough to run the handler.
 */
export interface EffectOptions<T> extends ComputedOptions<T> {
  /**
   * When the handler runs after a watched signal changes; 'sync' (the
   * default) runs it immediately, as part of the write.
   */
  schedule?: EffectSchedule
}

/**
 * One-level-deep equality:
 * - arrays: same length and element-wise Object.is;
 * - plain objects: same own keys and key-wise Object.is;
 * - everything else: Object.is.
 * The default cutoff for tuple and record effect sources, whose computes
 * rebuild their container on every run.
 */
export function shallowEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true
  }
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    return false
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) {
      return false
    }
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) {
        return false
      }
    }
    return true
  }
  if (Array.isArray(b)) {
    return false
  }
  const keysA = Object.keys(a)
  if (keysA.length !== Object.keys(b).length) {
    return false
  }
  for (const key of keysA) {
    if (
      !Object.prototype.hasOwnProperty.call(b, key) ||
      !Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    ) {
      return false
    }
  }
  return true
}

/** The value a signal handle produces. */
export type SignalValue<S> = S extends Signal<infer V> ? V : never

/**
 * Signal container sources map to same-shaped value containers: a tuple
 * of signals yields a tuple of values, a record yields a record.
 */
export type SignalValues<S> = { -readonly [K in keyof S]: SignalValue<S[K]> }

/**
 * True when `x` is a signal handle from this library — an atom or a
 * computed. The test is the {@link SIGNAL_BRAND} symbol every handle
 * carries, so plain objects that happen to have a `get` method (a Map, a
 * foreign reactive) never match.
 */
export function isSignal(x: unknown): x is Signal<unknown> {
  return typeof x === "object" && x !== null && SIGNAL_BRAND in x
}

/**
 * Create an effect: watch a source, run a handler when its value
 * changes. Returns a disposer.
 *
 * The source declares what the effect reacts to:
 * - a compute function: runs tracked, so the signals it read — and only
 *   those — become dependencies, branch by branch; it is cached, handed
 *   its own previous value, and may read promises through use();
 * - a signal: shorthand for a compute that reads it;
 * - a tuple or record of signals: shorthand for a compute that reads
 *   each one into a same-shaped container of values, compared with
 *   {@link shallowEquals} by default since the container is rebuilt
 *   every run (an explicit `equals` overrides).
 *
 * The handler is called with the new value and the previous value it
 * handled, and may return a cleanup that runs before the next handler
 * run and at disposal. Reads inside the handler are not tracked — a
 * value the effect should react to belongs in the source.
 *
 * The first run happens synchronously, at creation. Async sources relax
 * that:
 * - nothing has resolved yet: the first handler run waits for the value;
 * - loading again behind an earlier value: the effect stays quiet and
 *   keeps the last cleanup installed ({@link isPending} is the loading
 *   indicator);
 * - a load completes: the handler runs only if the new value differs
 *   from the last one it handled.
 * If the source throws, the handler is not called; the error surfaces
 * where the effect runs — at the write for 'sync' effects, in the React
 * phase for scheduled ones.
 *
 * Effects never see a React transition's pending writes: when the
 * transition commits, its writes reach effects once, like any other
 * write. See docs/effects.md for the full contract.
 */
export function createEffect<T>(
  compute: (use: UseFn, previous: T | undefined) => T,
  handler: (value: T, previous: T | undefined) => void | (() => void),
  opts?: EffectOptions<T>,
): () => void
export function createEffect<S extends Signal<any>>(
  source: S,
  handler: (value: SignalValue<S>, previous: SignalValue<S> | undefined) => void | (() => void),
  opts?: EffectOptions<SignalValue<S>>,
): () => void
export function createEffect<const S extends readonly Signal<any>[]>(
  sources: S,
  handler: (values: SignalValues<S>, previous: SignalValues<S> | undefined) => void | (() => void),
  opts?: EffectOptions<SignalValues<S>>,
): () => void
export function createEffect<S extends Record<string, Signal<any>>>(
  sources: S,
  handler: (values: SignalValues<S>, previous: SignalValues<S> | undefined) => void | (() => void),
  opts?: EffectOptions<SignalValues<S>>,
): () => void
export function createEffect(
  source:
    | ((use: UseFn, previous: any) => unknown)
    | Signal<any>
    | readonly Signal<any>[]
    | Record<string, Signal<any>>,
  handler: (value: any, previous: any) => void | (() => void),
  opts?: EffectOptions<any>,
): () => void {
  const schedule = opts?.schedule
  const lane =
    schedule === "useLayoutEffect"
      ? Lane.UseLayoutEffect
      : schedule === "useEffect"
        ? Lane.UseEffect
        : Lane.Sync
  let compute: (use: UseFn, previous: unknown) => unknown
  let equals = opts?.equals as EqualsFn<unknown> | undefined
  if (typeof source === "function") {
    compute = source
  } else if (isSignal(source)) {
    compute = () => source.get()
  } else if (Array.isArray(source)) {
    const sources = source as readonly Signal<unknown>[]
    compute = () => {
      const values = new Array<unknown>(sources.length)
      for (let i = 0; i < sources.length; i++) {
        values[i] = sources[i]!.get()
      }
      return values
    }
    equals ??= shallowEquals
  } else {
    const record = source as Record<string, Signal<unknown>>
    const keys = Object.keys(record)
    compute = () => {
      const values: Record<string, unknown> = {}
      for (const key of keys) {
        values[key] = record[key]!.get()
      }
      return values
    }
    equals ??= shallowEquals
  }
  return makeEffect(compute, handler, lane, equals, opts?.label)
}

export {
  makeScope as effectScope,
  batch,
  startBatch,
  endBatch,
  untrack,
  flushScheduledEffects,
  growCapacity,
  setArenaCapacityForTesting,
  arenaStats,
} from "./graph.ts"
export { resetGraphForBenchmark }

// ---------------------------------------------------------------------------
// Render-world provider, installed by the ./react bindings (which import
// engine modules directly — the react directory is part of this library).
// ---------------------------------------------------------------------------

/**
 * Answers "what world is rendering right now":
 * - draft ids: the current render pass declared its world and the
 *   declaration is still valid;
 * - 'base': a component render is executing but no valid declaration
 *   exists (it expired or belongs to another pass). Plain latest() and
 *   isPending() calls must then fall back to base state — wrong-toward-
 *   base is safe, while reading a stale world or reading ahead into live
 *   drafts is not;
 * - null: no render is executing, so ambient reads see the newest view.
 * A provider function rather than a sticky setter, because only the React
 * host knows when React is rendering and which declarations a pass
 * refreshed.
 */
let renderWorldProvider: (() => readonly DraftId[] | "base" | null) | null = null

/**
 * Install a provider answering "what world is rendering right now"; the
 * React bindings install theirs at registration. Pass null to remove it.
 */
export function setRenderWorldProvider(
  fn: (() => readonly DraftId[] | "base" | null) | null,
): void {
  renderWorldProvider = fn
}

function renderWorld(): World | null {
  if (renderWorldProvider === null) {
    return null
  }
  const ids = renderWorldProvider()
  if (ids === null) {
    return null
  }
  if (ids === "base") {
    return BASE_WORLD
  }
  return worldOf(ids)
}

/**
 * Test seam: discard live drafts, settle pending lifetime transitions,
 * drop ambient classification, detach any tracer. Existing atoms stay
 * valid.
 */
export function resetEngineForTest(): void {
  discardAllDrafts()
  flushLifetimeTransitions()
  resetEffectLanes()
  setAmbientClassifier(null)
  setRenderWriteGuard(null)
  renderWorldProvider = null
  getActiveTracer()?.stop()
}

export type {
  ReactiveNode,
  ResolvedState,
  Suspension,
  World,
  DraftId,
  Draft,
  UseFn,
  EqualsFn,
  Flags,
}
/**
 * For consumers reading ResolvedState views directly: the Flag bit
 * constants (test async bits via Flag.AsyncMask/AsyncError/
 * AsyncSuspended) and the uninitialized sentinel test.
 */
export { Flag, isUninitialized }
export { BASE_WORLD }
