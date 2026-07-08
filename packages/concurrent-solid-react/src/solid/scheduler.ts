import {
  CONFIG_IN_SNAPSHOT_SCOPE,
  CONFIG_OWNED_WRITE,
  EFFECT_RENDER,
  EFFECT_TRACKED,
  EFFECT_USER,
  NOT_PENDING,
  REACTIVE_DISPOSED,
  REACTIVE_MANUAL_WRITE,
  REACTIVE_OPTIMISTIC_DIRTY,
  REACTIVE_SNAPSHOT_STALE,
  REACTIVE_ZOMBIE,
  STATUS_PENDING,
  STATUS_UNINITIALIZED
} from "./constants.js";
import { currentOptimisticLane, untrack, updatePendingSignal } from "./core.js";
import { DEV } from "./dev.js";
import { NotReadyError } from "./error.js";
import { insertIntoHeap, runHeap, type Heap } from "./heap.js";
import {
  activeLanes,
  assignOrMergeLane,
  findLane,
  hasActiveOverride,
  signalLanes
} from "./lanes.js";
import type { Computed, Signal } from "./types.js";

export { activeLanes, assignOrMergeLane, findLane };
export { getOrCreateLane, hasActiveOverride, mergeLanes, resolveLane } from "./lanes.js";

const transitions = new Set<Transition>();
export const dirtyQueue: Heap = {
  _heap: new Array(2000).fill(undefined),
  _marked: false,
  _min: 0,
  _max: 0
};
export const zombieQueue: Heap = {
  _heap: new Array(2000).fill(undefined),
  _marked: false,
  _min: 0,
  _max: 0
};

export let clock = 0;
export let activeTransition: Transition | null = null;
let scheduled = false;
let syncDepth = 0;
export let projectionWriteActive = false;
let inTrackedQueueCallback = false;

let _enforceLoadingBoundary = false;
export let _hitUnhandledAsync = false;
// When a background transition is stashed, plain optimistic signals need one
// committed-view rerun. Keep that override local to the stash flush.
let stashedOptimisticReads: Set<Signal<any>> | null = null;

// Store property nodes that were created solely to carry a pending write (no
// subscribers at write time). Swept after each flush that commits pending
// values — any still without subs get disposed via their `_unobserved` hook,
// releasing the slot in the parent store's node map.
const transientStoreNodes = new Set<Signal<any>>();

export function registerTransientStoreNode(node: Signal<any>): void {
  transientStoreNodes.add(node);
}

function canUseSimpleSyncFlush(queue: GlobalQueue): boolean {
  return (
    transitions.size === 0 &&
    activeLanes.size === 0 &&
    queue._children.length === 0 &&
    queue._optimisticNodes.length === 0 &&
    queue._optimisticStores.size === 0 &&
    transientStoreNodes.size === 0
  );
}

function sweepTransientStoreNodes(): void {
  if (transientStoreNodes.size === 0) return;
  for (const node of transientStoreNodes) {
    if (node._subs !== null) {
      transientStoreNodes.delete(node);
      continue;
    }
    if (node._pendingValue !== NOT_PENDING) continue;
    if (node._overrideValue !== undefined && node._overrideValue !== NOT_PENDING) continue;
    transientStoreNodes.delete(node);
    node._unobserved?.();
  }
}
export function resetUnhandledAsync(): void {
  _hitUnhandledAsync = false;
}
/**
 * Toggles the dev-mode "must be inside a `<Loading>` boundary" enforcement
 * window. Only `render()` calls this — wrapping the initial mount so that a
 * top-level uncaught async read surfaces the diagnostic. Not part of the
 * user-facing API.
 *
 * @internal
 */
export function enforceLoadingBoundary(enabled: boolean): void {
  _enforceLoadingBoundary = enabled;
}

export function shouldReadStashedOptimisticValue(node: Signal<any>): boolean {
  return !!stashedOptimisticReads?.has(node);
}

/**
 * Run effects from all lanes that are ready (no pending async).
 */
function runLaneEffects(type: number): void {
  for (const lane of activeLanes) {
    if (lane._mergedInto || lane._pendingAsync.size > 0) continue;
    const effects = lane._effectQueues[type - 1];
    if (effects.length) {
      lane._effectQueues[type - 1] = [];
      runQueue(effects, type);
    }
  }
}

function queueStashedOptimisticEffects(node: Signal<any>): void {
  for (let s = node._subs; s !== null; s = s._nextSub) {
    const sub = s._sub as any;
    if (!sub._type) continue;
    if (sub._type === EFFECT_TRACKED) {
      if (!sub._modified) {
        sub._modified = true;
        sub._queue.enqueue(EFFECT_USER, sub._run);
      }
      continue;
    }
    const queue = sub._flags & REACTIVE_ZOMBIE ? zombieQueue : dirtyQueue;
    if (queue._min > sub._height) queue._min = sub._height;
    insertIntoHeap(sub, queue);
  }
}

export function setProjectionWriteActive(value: boolean) {
  projectionWriteActive = value;
}

export function setTrackedQueueCallback(value: boolean) {
  if (__DEV__) inTrackedQueueCallback = value;
}

export type QueueCallback = (type: number) => void;
type QueueStub = {
  _queues: [QueueCallback[], QueueCallback[]];
  _children: QueueStub[];
};
type OptimisticNode = Signal<any> | Computed<any>;
export interface Transition {
  _time: number;
  _asyncReporters: Map<Computed<any>, Set<Computed<any>>>;
  _pendingNodes: Signal<any>[];
  _optimisticNodes: OptimisticNode[]; // Optimistic signals/computeds pending transition reversion
  _optimisticStores: Set<any>;
  // [react-adapt E2] Loosened from generator iterators: the React bridge
  // pushes one opaque retainer per open fork batch; the transition can only
  // complete once every retainer is released (at that batch's retirement).
  _actions: Array<unknown>;
  _queueStash: QueueStub;
  _done: boolean | Transition;
  // Subscribers that, while recomputing under an optimistic lane, read a plain
  // signal's committed value through the entanglement gate. At commit they
  // get rescheduled so they re-run with the new committed view.
  _gatedSubs: Set<Computed<any>>;
}

/**
 * [react-adapt E2] Create a transition for a React deferred batch. This is
 * the ONLY way a transition comes into existence in this package (ambient
 * creation is disabled, see initTransition): each fork batch token the React
 * bridge sees maps to one of these, and the transition completes exactly when
 * React retires the batch.
 */
export function createBridgeTransition(): Transition {
  return {
    _time: clock,
    _pendingNodes: [],
    _asyncReporters: new Map(),
    _optimisticNodes: [],
    _optimisticStores: new Set(),
    _actions: [],
    _queueStash: { _queues: [[], []], _children: [] },
    _done: false,
    _gatedSubs: new Set()
  };
}

/**
 * [react-adapt E2] Hold a transition open until the matching release. The
 * bridge retains once per live fork batch token; `transitionComplete` cannot
 * pass while any retainer is present, so staged values commit exactly at
 * React's own commit (batch retirement), never before.
 */
export function retainTransition(transition: Transition, retainer: unknown): void {
  currentTransition(transition)._actions.push(retainer);
}

export function releaseTransition(transition: Transition, retainer: unknown): void {
  const root = currentTransition(transition);
  const i = root._actions.indexOf(retainer);
  if (i >= 0) root._actions.splice(i, 1);
}

/** [react-adapt E9] Entangle two transitions (merge their worlds). */
export function entangleTransitions(a: Transition, b: Transition): Transition {
  const rootA = currentTransition(a);
  const rootB = currentTransition(b);
  if (rootA === rootB) return rootA;
  mergeTransitionState(rootA, rootB);
  transitions.delete(rootB);
  if (activeTransition === rootB) activeTransition = rootA;
  return rootA;
}

/** [react-adapt E9] A transition that has neither completed nor been absorbed. */
export function isTransitionLive(t: Transition | null | undefined): boolean {
  return !!t && currentTransition(t)._done !== true;
}

/**
 * [react-adapt E3] Committed-world refresh for the memo cone over a
 * dual-channel (urgent-write-to-transition-held-signal) rebase. The normal
 * recompute of such a cone runs in the transition's world and refreshes only
 * staged values; without this pass a memo's committed copy would lag its
 * committed inputs until the transition ends — an urgent render could paint
 * `count = 1` beside `doubled = 0` in one frame.
 *
 * The refresh is a shadow evaluation: untracked (no dependency relinking —
 * links are shared between worlds), writes `_value` only (staged values stay
 * rebased), and never touches async/status machinery. A compute that
 * suspends, throws, or returns a promise keeps its stale committed copy
 * (async memos' committed copies remain a documented residual gap). Readers
 * of changed memos are woken through the tracked-run path.
 *
 * Runs SYNCHRONOUSLY inside the dual-channel write: React flushes discrete
 * updates at the end of the event, before microtasks, so a refresh deferred
 * to the flush would let that render paint the fresh signal beside a stale
 * memo.
 */
export function refreshCommittedCone(sources: Array<Signal<any> | Computed<any>>): void {
  // Collect the pure-memo cone, breadth-first, then refresh in height order
  // so memo-over-memo reads its refreshed inputs.
  const cone: Computed<any>[] = [];
  const seen = new Set<object>();
  const wake = new Set<any>();
  const visit = (node: Signal<any> | Computed<any>) => {
    for (let s = node._subs; s !== null; s = s._nextSub) {
      const sub = s._sub as any;
      if (seen.has(sub)) continue;
      seen.add(sub);
      if (sub._type === EFFECT_TRACKED) wake.add(sub);
      else if (typeof sub._fn === "function" && !sub._type) {
        cone.push(sub);
        visit(sub);
      }
    }
  };
  for (const source of sources) visit(source);
  cone.sort((a, b) => a._height - b._height);
  for (const memo of cone) {
    if (memo._flags & REACTIVE_DISPOSED) continue;
    const prev = memo._value;
    let next: any;
    try {
      next = untrack(() => memo._fn(prev));
    } catch {
      continue; // pending/error in the committed world: keep the stale copy
    }
    if (
      next !== null &&
      typeof next === "object" &&
      (typeof (next as any).then === "function" || (next as any)[Symbol.asyncIterator])
    ) {
      continue; // async compute: committed copy stays stale (residual gap)
    }
    if (memo._equals && memo._equals(prev, next)) continue;
    memo._value = next;
    for (let s = memo._subs; s !== null; s = s._nextSub) {
      const sub = s._sub as any;
      if (sub._type === EFFECT_TRACKED) wake.add(sub);
    }
  }
  for (const sub of wake) enqueueTrackedRun(sub);
}

/**
 * [react-adapt E10] Deliver a tracked-effect run, split by world. A poke born
 * under a live transition holds a FORCED re-run in that transition's stash
 * (released at React's commit of the batch) WITHOUT consuming the `_modified`
 * dedup flag — so an unrelated urgent commit in between still runs the effect
 * against committed values (a single shared flag would let the stashed run
 * swallow every urgent poke until the transition ends). React reader nodes
 * are exempt: their wake-ups only schedule renders, which React lanes itself.
 */
export function enqueueTrackedRun(sub: any): void {
  if (activeTransition && !currentOptimisticLane && !sub._isReactReader) {
    const holder = currentTransition(activeTransition);
    if (sub._heldBy && currentTransition(sub._heldBy) === holder) return;
    sub._heldBy = holder;
    holder._queueStash._queues[EFFECT_USER - 1].push(() => {
      if (sub._heldBy && currentTransition(sub._heldBy) === holder) sub._heldBy = undefined;
      // Forced: the transition's commit just changed committed values this
      // effect depends on, whether or not an urgent run fired in between.
      sub._modified = true;
      sub._run();
    });
    schedule();
    return;
  }
  if (!sub._modified) {
    sub._modified = true;
    sub._queue.enqueue(EFFECT_USER, sub._run);
  }
}

function mergeTransitionState(target: Transition, outgoing: Transition): void {
  outgoing._done = target;
  target._actions.push(...outgoing._actions);
  for (const lane of activeLanes) if (lane._transition === outgoing) lane._transition = target;
  // [react-adapt E8] pending nodes are per-transition lists now (no global
  // aliasing), so a merge must carry them over and re-stamp their owner.
  for (let i = 0; i < outgoing._pendingNodes.length; i++) {
    outgoing._pendingNodes[i]._transition = target;
    target._pendingNodes.push(outgoing._pendingNodes[i]);
  }
  outgoing._pendingNodes.length = 0;
  for (let i = 0; i < outgoing._optimisticNodes.length; i++) {
    outgoing._optimisticNodes[i]._transition = target;
  }
  // merge the held effect queues as well
  target._queueStash._queues[0].push(...outgoing._queueStash._queues[0]);
  target._queueStash._queues[1].push(...outgoing._queueStash._queues[1]);
  outgoing._queueStash._queues = [[], []];
  target._optimisticNodes.push(...outgoing._optimisticNodes);
  for (const store of outgoing._optimisticStores) target._optimisticStores.add(store);
  for (const [source, reporters] of outgoing._asyncReporters) {
    let targetReporters = target._asyncReporters.get(source);
    if (!targetReporters) target._asyncReporters.set(source, (targetReporters = new Set()));
    for (const reporter of reporters) targetReporters.add(reporter);
  }
  for (const sub of outgoing._gatedSubs) target._gatedSubs.add(sub);
}

function resolveOptimisticNodes(nodes: OptimisticNode[]): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    node._optimisticLane = undefined;
    if (node._pendingValue !== NOT_PENDING) {
      node._value = node._pendingValue as any;
      node._pendingValue = NOT_PENDING;
    }
    const prevOverride = node._overrideValue;
    node._overrideValue = NOT_PENDING;
    if (prevOverride !== NOT_PENDING && node._value !== prevOverride) insertSubs(node, true);
    node._transition = null;
    // [react-adapt E1] pending signals are plain now (see getPendingSignal);
    // re-derive them when the override they may have reflected reverts.
    if (node._pendingSignal) updatePendingSignal(node);
  }
  nodes.length = 0;
}

function cleanupCompletedLanes(completingTransition: Transition | null): void {
  for (const lane of activeLanes) {
    const owned = completingTransition
      ? lane._transition === completingTransition
      : !lane._transition;
    if (!owned) continue;
    if (!lane._mergedInto) {
      if (lane._effectQueues[0].length) runQueue(lane._effectQueues[0], EFFECT_RENDER);
      if (lane._effectQueues[1].length) runQueue(lane._effectQueues[1], EFFECT_USER);
    }
    if (lane._source._optimisticLane === lane) lane._source._optimisticLane = undefined;
    lane._pendingAsync.clear();
    lane._effectQueues[0].length = 0;
    lane._effectQueues[1].length = 0;
    activeLanes.delete(lane);
    signalLanes.delete(lane._source);
  }
}

export function schedule() {
  if (scheduled) return;
  scheduled = true;
  if (!syncDepth && !globalQueue._running && !projectionWriteActive) queueMicrotask(flush);
}

export interface IQueue {
  enqueue(type: number, fn: QueueCallback): void;
  run(type: number): boolean | void;
  addChild(child: IQueue): void;
  removeChild(child: IQueue): void;
  created: number;
  notify(node: Computed<any>, mask: number, flags: number, error?: any): boolean;
  stashQueues(stub: QueueStub): void;
  restoreQueues(stub: QueueStub): void;
  _parent: IQueue | null;
}

export class Queue implements IQueue {
  _parent: IQueue | null = null;
  _queues: [QueueCallback[], QueueCallback[]] = [[], []];
  _children: IQueue[] = [];
  created = clock;
  addChild(child: IQueue) {
    this._children.push(child);
    child._parent = this;
  }
  removeChild(child: IQueue) {
    const index = this._children.indexOf(child);
    if (index >= 0) {
      this._children.splice(index, 1);
      child._parent = null;
    }
  }
  notify(node: Computed<any>, mask: number, flags: number, error?: any): boolean {
    if (this._parent) return this._parent.notify(node, mask, flags, error);
    return false;
  }
  run(type: number) {
    if (this._queues[type - 1].length) {
      const effects = this._queues[type - 1];
      this._queues[type - 1] = [];
      runQueue(effects, type);
    }
    for (let i = 0; i < this._children.length; i++) (this._children[i] as any).run?.(type);
  }
  enqueue(type: number, fn: QueueCallback): void {
    if (type) {
      // Route to lane's effect queue if we're in an optimistic recomputation
      if (currentOptimisticLane) {
        const lane = findLane(currentOptimisticLane);
        lane._effectQueues[type - 1].push(fn);
      } else if (activeTransition) {
        // [react-adapt E10] Effects born under a live transition are held in
        // that transition's stash and released by restoreQueues when the
        // transition completes (at React's batch retirement). This is what
        // keeps user effects from ever observing a pending transition's
        // values: they run only after those values commit. Note: this
        // package runs a flat queue tree (no boundary child queues), so
        // stashing at the root is exact.
        activeTransition._queueStash._queues[type - 1].push(fn);
      } else {
        this._queues[type - 1].push(fn);
      }
    }
    schedule();
  }
  stashQueues(stub: QueueStub): void {
    stub._queues[0].push(...this._queues[0]);
    stub._queues[1].push(...this._queues[1]);
    this._queues = [[], []];
    for (let i = 0; i < this._children.length; i++) {
      let child = this._children[i];
      let childStub = stub._children[i];
      if (!childStub) {
        childStub = { _queues: [[], []], _children: [] };
        stub._children[i] = childStub;
      }
      child.stashQueues(childStub);
    }
  }
  restoreQueues(stub: QueueStub) {
    this._queues[0].push(...stub._queues[0]);
    this._queues[1].push(...stub._queues[1]);
    for (let i = 0; i < stub._children.length; i++) {
      const childStub = stub._children[i];
      let child = this._children[i];
      if (child) child.restoreQueues(childStub);
    }
  }
}

export class GlobalQueue extends Queue {
  _running: boolean = false;
  _pendingNode: Signal<any> | null = null;
  _pendingNodes: Signal<any>[] = [];
  _optimisticNodes: OptimisticNode[] = [];
  _optimisticStores: Set<any> = new Set();
  static _update: (el: Computed<unknown>) => void;
  static _dispose: (el: Computed<unknown>, self: boolean, zombie: boolean) => void;
  static _runEffect: (el: Computed<unknown>) => void;
  static _clearOptimisticStore: ((store: any) => void) | null = null;
  flush() {
    if (this._running) return;
    this._running = true;
    try {
      runHeap(dirtyQueue, GlobalQueue._update);
      // [react-adapt E8] Restructured around explicit world routing. The
      // global pending/optimistic lists now hold ONLY urgent state (each
      // transition keeps its own lists), so parking a transition no longer
      // stashes/clears the globals: urgent staged values commit at every
      // flush, held ones stay in their transition until React retires the
      // batch. E10 already routed transition-born effects into the stash, so
      // the park path does not stash live queues either.
      if (activeTransition) {
        const isComplete = transitionComplete(activeTransition);
        if (!isComplete) {
          runHeap(zombieQueue, GlobalQueue._update);
          // Run lane effects immediately - lanes with no pending async
          runLaneEffects(EFFECT_RENDER);
          runLaneEffects(EFFECT_USER);
          activeTransition = null;
          finalizePureQueue();
        } else {
          this._pendingNodes.push(...activeTransition._pendingNodes);
          activeTransition._pendingNodes.length = 0;
          this.restoreQueues(activeTransition._queueStash);
          transitions.delete(activeTransition);
          const completingTransition = activeTransition;
          activeTransition = null;
          reassignPendingTransition(this._pendingNodes);
          finalizePureQueue(completingTransition);
        }
      } else {
        if (canUseSimpleSyncFlush(this)) {
          commitPendingNodes();
          if (dirtyQueue._max >= dirtyQueue._min) {
            runHeap(dirtyQueue, GlobalQueue._update);
            commitPendingNodes();
          }
        } else {
          if (transitions.size) runHeap(zombieQueue, GlobalQueue._update);
          finalizePureQueue();
        }
      }
      clock++;
      // Check if finalization added items to the heap (from optimistic reversion)
      scheduled = dirtyQueue._max >= dirtyQueue._min;
      // Run lane effects first (for ready lanes), then regular effects
      activeLanes.size && runLaneEffects(EFFECT_RENDER);
      this.run(EFFECT_RENDER);
      activeLanes.size && runLaneEffects(EFFECT_USER);
      this.run(EFFECT_USER);
      if (__DEV__) DEV.hooks.onUpdate?.();
    } finally {
      this._running = false;
    }
  }
  notify(node: Computed<any>, mask: number, flags: number, error?: any): boolean {
    // Only track async if the boundary is propagating STATUS_PENDING (not caught by boundary)
    if (mask & STATUS_PENDING) {
      if (flags & STATUS_PENDING) {
        const actualError = error !== undefined ? error : node._error;
        if (activeTransition && actualError) {
          const source = (actualError as NotReadyError).source;
          let reporters = activeTransition._asyncReporters.get(source);
          if (!reporters) activeTransition._asyncReporters.set(source, (reporters = new Set()));
          const prevSize = reporters.size;
          reporters.add(node);
          if (reporters.size !== prevSize) schedule();
        }
        if (__DEV__ && _enforceLoadingBoundary) _hitUnhandledAsync = true;
      }
      return true;
    }
    return false;
  }
  initTransition(transition?: Transition | null): void {
    // [react-adapt E1] Ambient transition creation is disabled. In stock
    // Solid every async suspension / settlement conjures a transition so the
    // engine itself can hold committed UI stable. Hosted in React, held UI is
    // React's job (startTransition + Suspense): a transition exists here only
    // when the bridge created one for a React deferred batch. An async memo
    // that suspends outside any batch just carries pending status and commits
    // through the normal pending queue when it settles.
    if (!transition) return;
    transition = currentTransition(transition);
    if (transition === activeTransition) return;
    if (!activeTransition) {
      activeTransition = transition;
    } else {
      const outgoing = activeTransition;
      mergeTransitionState(transition, outgoing);
      transitions.delete(outgoing);
      activeTransition = transition;
    }
    transitions.add(activeTransition);
    activeTransition._time = clock;
    // [react-adapt E8] No wholesale adoption of already-staged nodes: values
    // staged before this activation belong to the urgent (committed-next-
    // flush) world and stay in the global lists. Nodes staged while this
    // transition is active route into it directly via queuePendingNode /
    // registerOptimisticNode.
    for (const lane of activeLanes) {
      if (!lane._transition) lane._transition = activeTransition;
    }
  }
}

export function queuePendingNode(node: Signal<any>): void {
  // [react-adapt E8] Route the staged value by the world that staged it. A
  // node staged under an active transition belongs to that transition: stamp
  // it immediately (stock stamped lazily at park time) so later flushes and
  // urgent readers can tell the two worlds apart, and keep it in the
  // transition's own commit list. Everything else is urgent and commits at
  // the next flush finalization.
  if (activeTransition) {
    node._transition = activeTransition;
    activeTransition._pendingNodes.push(node);
    return;
  }
  if (globalQueue._pendingNode === null && globalQueue._pendingNodes.length === 0) {
    globalQueue._pendingNode = node;
    return;
  }
  if (globalQueue._pendingNode !== null) {
    globalQueue._pendingNodes.push(globalQueue._pendingNode);
    globalQueue._pendingNode = null;
  }
  globalQueue._pendingNodes.push(node);
}

/**
 * [react-adapt E8] Register an optimistic node with the world that created
 * it: overrides written inside a React deferred batch revert when that batch
 * retires; overrides written urgently revert at the next flush (stock
 * behavior for optimistic writes outside a transition).
 */
export function registerOptimisticNode(node: OptimisticNode): void {
  if (activeTransition) {
    node._transition = activeTransition;
    activeTransition._optimisticNodes.push(node);
  } else {
    globalQueue._optimisticNodes.push(node);
  }
}

export function insertSubs(node: Signal<any> | Computed<any>, optimistic: boolean = false): void {
  // Get source lane: prefer node's own lane over current context
  // This is important for isPending signals which need their own lane to flush immediately
  const sourceLane = (node as any)._optimisticLane || currentOptimisticLane;

  const hasSnapshot = (node as any)._snapshotValue !== undefined;

  // [react-adapt E9] World inheritance. Stock Solid runs a whole flush under
  // one ambient transition, so the dirty cone of a staged write inherits the
  // world implicitly. Hosted in React, urgent and deferred writes can dirty
  // nodes in the same flush, so the world must travel per node: a subscriber
  // dirtied by a transition-staged source records that transition and
  // recompute re-enters it for just that node. Overlapping worlds entangle,
  // mirroring how React entangles transitions that touch the same state.
  let world = (node as any)._transition as Transition | null;
  world = world && isTransitionLive(world) ? currentTransition(world) : activeTransition;

  for (let s = node._subs; s !== null; s = s._nextSub) {
    if (hasSnapshot && s._sub._config & CONFIG_IN_SNAPSHOT_SCOPE) {
      s._sub._flags |= REACTIVE_SNAPSHOT_STALE;
      continue;
    }

    if (world) {
      const sub = s._sub as any;
      const existing = sub._reentryWorld as Transition | undefined;
      if (
        existing &&
        isTransitionLive(existing) &&
        currentTransition(existing) !== currentTransition(world)
      ) {
        world = entangleTransitions(existing, world);
      }
      sub._reentryWorld = world;
    }

    if (optimistic && sourceLane) {
      s._sub._flags |= REACTIVE_OPTIMISTIC_DIRTY;
      assignOrMergeLane(s._sub as any, sourceLane);
    } else if (optimistic) {
      s._sub._flags |= REACTIVE_OPTIMISTIC_DIRTY;
      // No source lane means reversion - clear subscriber's lane so effects go to regular queue
      (s._sub as any)._optimisticLane = undefined;
    }

    // Tracked effects bypass heap, go directly to effect queue
    const sub = s._sub as any;
    if (sub._type === EFFECT_TRACKED) {
      enqueueTrackedRun(sub);
      continue;
    }

    const queue = s._sub._flags & REACTIVE_ZOMBIE ? zombieQueue : dirtyQueue;
    if (queue._min > s._sub._height) queue._min = s._sub._height;
    insertIntoHeap(s._sub, queue);
  }
}

function commitPendingNode(n: Signal<any>): void {
  const c = n as Partial<Computed<unknown>>;
  if (!c._fn) {
    if (n._pendingValue !== NOT_PENDING) {
      n._value = n._pendingValue as any;
      n._pendingValue = NOT_PENDING;
    }
    // [react-adapt E1] plain pending signals re-derive at the commit point
    // (this is what the stock optimistic override's auto-revert provided);
    // a refresh staged here is committed later in the same drain because
    // commitPendingNodes re-reads the queue length.
    if (n._pendingSignal) updatePendingSignal(n);
    return;
  }
  if (n._pendingValue !== NOT_PENDING) {
    n._value = n._pendingValue as any;
    n._pendingValue = NOT_PENDING;
    // Set _modified for effects, but not for tracked effects (they handle their own scheduling)
    if ((n as any)._type && (n as any)._type !== EFFECT_TRACKED) (n as any)._modified = true;
  }
  c._flags! &= ~REACTIVE_MANUAL_WRITE;
  if (!(c._statusFlags! & STATUS_PENDING)) c._statusFlags! &= ~STATUS_UNINITIALIZED;
  if (n._pendingSignal) updatePendingSignal(n);
  if (c._pendingFirstChild !== null || c._pendingDisposal !== null)
    GlobalQueue._dispose(c as Computed<unknown>, false, true);
}

function commitPendingNodes() {
  if (globalQueue._pendingNode !== null) {
    commitPendingNode(globalQueue._pendingNode);
    globalQueue._pendingNode = null;
  }
  const pendingNodes = globalQueue._pendingNodes;
  for (let i = 0; i < pendingNodes.length; i++) {
    commitPendingNode(pendingNodes[i]);
  }
  pendingNodes.length = 0;
}

export function finalizePureQueue(
  completingTransition: Transition | null = null,
  incomplete: boolean = false
) {
  // For incomplete transitions, skip pending resolution and optimistic reversion
  // For completing transitions or no-transition, resolve pending and revert optimistic
  const resolvePending = !incomplete;
  if (resolvePending) commitPendingNodes();
  if (!incomplete && globalQueue._children.length) checkBoundaryChildren(globalQueue);
  const ranHeap = dirtyQueue._max >= dirtyQueue._min;
  if (ranHeap) runHeap(dirtyQueue, GlobalQueue._update);
  if (resolvePending) {
    if (ranHeap) commitPendingNodes();
    resolveOptimisticNodes(
      completingTransition ? completingTransition._optimisticNodes : globalQueue._optimisticNodes
    );
    // Replay entanglement: subs recorded by the read-time gate get rescheduled
    // so they re-run with the now-committed values visible.
    if (completingTransition && completingTransition._gatedSubs.size) {
      for (const sub of completingTransition._gatedSubs) {
        if (sub._flags & REACTIVE_DISPOSED) continue;
        if ((sub as any)._type === EFFECT_TRACKED) {
          if (!(sub as any)._modified) {
            (sub as any)._modified = true;
            sub._queue.enqueue(EFFECT_USER, (sub as any)._run);
          }
          continue;
        }
        const queue = sub._flags & REACTIVE_ZOMBIE ? zombieQueue : dirtyQueue;
        if (queue._min > sub._height) queue._min = sub._height;
        insertIntoHeap(sub, queue);
      }
      completingTransition._gatedSubs.clear();
    }
    const optimisticStores = completingTransition
      ? completingTransition._optimisticStores
      : globalQueue._optimisticStores;
    if (GlobalQueue._clearOptimisticStore && optimisticStores.size) {
      for (const store of optimisticStores) {
        GlobalQueue._clearOptimisticStore(store);
      }
      optimisticStores.clear();
      schedule();
    }
    sweepTransientStoreNodes();
    cleanupCompletedLanes(completingTransition);
  }
}

function checkBoundaryChildren(queue: Queue) {
  for (const child of queue._children) {
    (child as any).checkSources?.();
    checkBoundaryChildren(child as Queue);
  }
}

export function trackOptimisticStore(store: any): void {
  // After initTransition, globalQueue._optimisticStores IS activeTransition._optimisticStores (same reference)
  globalQueue._optimisticStores.add(store);
  schedule();
}

function reassignPendingTransition(pendingNodes: Signal<any>[]) {
  for (let i = 0; i < pendingNodes.length; i++) {
    pendingNodes[i]._transition = activeTransition;
  }
}

export const globalQueue = new GlobalQueue();

/**
 * Synchronously processes the pending reactive queue, or runs `fn` in a synchronous
 * flush scope before draining the queue.
 *
 * Reactive updates are normally batched onto the microtask queue, so multiple
 * writes in a row collapse into a single update pass. Call `flush()` when you
 * need to *observe* the result of those writes synchronously — most commonly
 * in tests, but also at the boundary of imperative integration code. Pass a
 * callback when the writes themselves should bypass microtask scheduling and
 * drain synchronously when the callback returns.
 *
 * @example
 * ```ts
 * const [count, setCount] = createSignal(0);
 * const doubled = createMemo(() => count() * 2);
 *
 * setCount(5);
 * flush();
 * expect(doubled()).toBe(10);
 *
 * flush(() => setCount(6));
 * expect(doubled()).toBe(12);
 *
 * // Nested flushes drain at each level:
 * flush(() => {
 *   setCount(7);
 *   flush(() => setCount(8)); // inner drain — effects fire here
 *   // outer continues with up-to-date state
 * });
 * ```
 */
export function flush(): void;
export function flush<T>(fn: () => T): T;
export function flush<T>(fn?: () => T): T | void {
  if (fn) {
    syncDepth++;
    try {
      return fn();
    } finally {
      // Decrement even if the drain throws (a throwing effect): a leaked
      // syncDepth would stop `schedule()` from ever queuing a microtask again.
      try {
        flush();
      } finally {
        syncDepth--;
      }
    }
  }
  if (globalQueue._running) {
    if (__DEV__ && inTrackedQueueCallback) {
      throw new Error(
        "Cannot call flush() from inside onSettled or createTrackedEffect. flush() is not reentrant there."
      );
    }
    return;
  }
  let count = 0;
  // `flush()` is an explicit drain point, so it must also process an active
  // transition even if no microtask was scheduled for it yet.
  while (scheduled || activeTransition) {
    if (__DEV__ && ++count === 1e5) throw new Error("Potential Infinite Loop Detected.");
    globalQueue.flush();
  }
}

function runQueue(queue: QueueCallback[], type: number): void {
  for (let i = 0; i < queue.length; i++) queue[i](type);
}

function reporterBlocksSource(reporter: Computed<any>, source: Computed<any>): boolean {
  if (reporter._flags & (REACTIVE_ZOMBIE | REACTIVE_DISPOSED)) return false;
  if (reporter._pendingSource === source || reporter._pendingSources?.has(source)) return true;
  for (let dep = reporter._deps; dep; dep = dep._nextDep) {
    let current = dep._dep as Signal<any> | Computed<any> | undefined;
    while (current) {
      if (current === source || (current as any)._firewall === source) return true;
      current = current._parentSource;
    }
  }
  return !!(
    reporter._statusFlags & STATUS_PENDING &&
    reporter._error instanceof NotReadyError &&
    reporter._error.source === source
  );
}

function transitionComplete(transition: Transition): boolean {
  if (transition._done) return true;
  if (transition._actions.length) return false;
  let done = true;
  for (const [source, reporters] of transition._asyncReporters) {
    let hasLive = false;
    for (const reporter of reporters) {
      if (reporterBlocksSource(reporter, source)) {
        hasLive = true;
        break;
      }
      reporters.delete(reporter);
    }
    if (!hasLive) transition._asyncReporters.delete(source);
    else if (
      source._statusFlags & STATUS_PENDING &&
      (source._error as NotReadyError)?.source === source
    ) {
      done = false;
      break;
    }
  }
  if (done) {
    for (let i = 0; i < transition._optimisticNodes.length; i++) {
      const node = transition._optimisticNodes[i];
      if (
        hasActiveOverride(node) &&
        "_statusFlags" in node &&
        node._statusFlags & STATUS_PENDING &&
        node._error instanceof NotReadyError &&
        node._error.source !== node
      ) {
        done = false;
        break;
      }
    }
  }
  done && (transition._done = true);
  return done;
}
export function currentTransition(transition: Transition) {
  while (transition._done && typeof transition._done === "object") transition = transition._done;
  return transition;
}

export function setActiveTransition(transition: Transition | null) {
  activeTransition = transition;
}

export function runInTransition<T>(transition: Transition, fn: () => T): T {
  const prevTransition = activeTransition;

  try {
    activeTransition = currentTransition(transition);
    return fn();
  } finally {
    activeTransition = prevTransition;
  }
}
