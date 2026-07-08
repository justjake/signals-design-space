import { causeFor, emit } from "./trace.ts";

export type CellId = number;

export interface AtomOptions<T> {
  equals?: (a: T, b: T) => boolean;
  effect?: (ctx: { get(): T; set(value: T): void }) => void | (() => void);
  label?: string;
  key?: string;
}

export interface ComputedOptions<T> {
  equals?: (a: T, b: T) => boolean;
  label?: string;
}

export interface Cell<T = unknown> {
  readonly id: CellId;
  readonly _type?: T;
}

const SIGNAL = 1;
const COMPUTED = 2;
const EFFECT = 3;
const DIRTY = 1;
const RUNNING = 2;
const INITIALIZED = 4;
const MAYBE_DIRTY = 8;
const ACTIVE = 16;
const PENDING = 32;

let capacity = 256;
let count = 0;
let liveCount = 0;
let kinds = new Uint8Array(capacity);
let flags = new Uint8Array(capacity);
let versions = new Uint32Array(capacity);
let invalidationMarks = new Uint32Array(capacity);
let deliveryVersions = new Uint32Array(capacity);
let generations = new Uint32Array(capacity);
let settled = new Uint8Array(capacity);
let nextGeneration = 1;
let invalidationEpoch = 0;
let observerHeads = new Int32Array(capacity);
let observerTails = new Int32Array(capacity);
let dependencyHeads = new Int32Array(capacity);
let dependencyTails = new Int32Array(capacity);
let trackingMarks = new Uint32Array(capacity);
let batchMarks = new Uint32Array(capacity);
let batchOldVersions = new Uint32Array(capacity);
observerHeads.fill(-1);
observerTails.fill(-1);
dependencyHeads.fill(-1);
dependencyTails.fill(-1);
let edgeCapacity = 1024;
let edgeCount = 0;
let freeEdge = -1;
let edgeSources = new Int32Array(edgeCapacity);
let edgeObservers = new Int32Array(edgeCapacity);
let edgeNextObserver = new Int32Array(edgeCapacity);
let edgePreviousObserver = new Int32Array(edgeCapacity);
let edgeNextDependency = new Int32Array(edgeCapacity);
let edgeVersions = new Uint32Array(edgeCapacity);
let trackingEpoch = 0;
let activeTrackingEpoch = 0;
let trackingRemaining = -1;
let trackingHead = -1;
let trackingTail = -1;
let batchEpoch = 0;
const values: unknown[] = [];
const initializers: Array<(() => unknown) | undefined> = [];
const calculations: Array<(() => unknown) | undefined> = [];
const equalities: Array<((a: unknown, b: unknown) => boolean) | undefined> = [];
const cleanups: Array<(() => void) | undefined> = [];
const errors: unknown[] = [];
let hasErrors = new Uint8Array(256);
const labels: Array<string | undefined> = [];
const keys: Array<string | undefined> = [];
const lifetimeStarts: Array<AtomOptions<unknown>["effect"]> = [];
const lifetimeStops: Array<(() => void) | undefined> = [];
const children: Array<CellId[] | undefined> = [];
const listeners: Array<Set<() => void> | undefined> = [];
const observedCounts = new Uint32Array(256);
let observed = observedCounts;

let activeObserver = -1;
let tracking = true;
let writesForbidden = 0;
let batchDepth = 0;
let flushing = false;
let pendingEffects: CellId[] = [];
let drainingEffects: CellId[] = [];
const invalidationWork: CellId[] = [];
let listenerCount = 0;
let automaticReclamation = true;
let scope: CellId[] | undefined;
const batchOldValues: unknown[] = [];
const batchTouched: CellId[] = [];
type DraftAction = unknown | ((previous: unknown) => unknown);
interface ActionRecord {
  sequence: number;
  action: DraftAction;
}
interface Draft {
  actions: Map<CellId, ActionRecord[]>;
  bases: Map<CellId, unknown>;
  causes: Map<CellId, number>;
  roots: Set<object>;
  committedRoots: Set<object>;
  cause?: number;
}
const drafts = new Map<number, Draft>();
const immediateActions = new Map<CellId, ActionRecord[]>();
let actionSequence = 0;
const scheduledDrafts = new Set<number>();
let nextDraft = 1;
let writeDraft = 0;
let renderDrafts: number[] = [];
let inRenderWorld = false;
let renderCache = new Map<CellId, unknown>();
let rootViews = new WeakMap<object, Map<CellId, unknown>>();
let commitCause: number | undefined;
const finalizer = new FinalizationRegistry<{ id: CellId; generation: number }>((held) => {
  if (generations[held.id] === held.generation) releaseCell(held.id);
});

function grow(): void {
  capacity <<= 1;
  const nextKinds = new Uint8Array(capacity);
  const nextFlags = new Uint8Array(capacity);
  const nextVersions = new Uint32Array(capacity);
  const nextInvalidationMarks = new Uint32Array(capacity);
  const nextDeliveryVersions = new Uint32Array(capacity);
  const nextGenerations = new Uint32Array(capacity);
  const nextSettled = new Uint8Array(capacity);
  const nextObserved = new Uint32Array(capacity);
  const nextHasErrors = new Uint8Array(capacity);
  const nextObserverHeads = new Int32Array(capacity);
  const nextObserverTails = new Int32Array(capacity);
  const nextDependencyHeads = new Int32Array(capacity);
  const nextDependencyTails = new Int32Array(capacity);
  const nextTrackingMarks = new Uint32Array(capacity);
  const nextBatchMarks = new Uint32Array(capacity);
  const nextBatchOldVersions = new Uint32Array(capacity);
  nextObserverHeads.fill(-1);
  nextObserverTails.fill(-1);
  nextDependencyHeads.fill(-1);
  nextDependencyTails.fill(-1);
  nextKinds.set(kinds);
  nextFlags.set(flags);
  nextVersions.set(versions);
  nextInvalidationMarks.set(invalidationMarks);
  nextDeliveryVersions.set(deliveryVersions);
  nextGenerations.set(generations);
  nextSettled.set(settled);
  nextObserved.set(observed);
  nextHasErrors.set(hasErrors);
  nextObserverHeads.set(observerHeads);
  nextObserverTails.set(observerTails);
  nextDependencyHeads.set(dependencyHeads);
  nextDependencyTails.set(dependencyTails);
  nextTrackingMarks.set(trackingMarks);
  nextBatchMarks.set(batchMarks);
  nextBatchOldVersions.set(batchOldVersions);
  kinds = nextKinds;
  flags = nextFlags;
  versions = nextVersions;
  invalidationMarks = nextInvalidationMarks;
  deliveryVersions = nextDeliveryVersions;
  generations = nextGenerations;
  settled = nextSettled;
  observed = nextObserved;
  hasErrors = nextHasErrors;
  observerHeads = nextObserverHeads;
  observerTails = nextObserverTails;
  dependencyHeads = nextDependencyHeads;
  dependencyTails = nextDependencyTails;
  trackingMarks = nextTrackingMarks;
  batchMarks = nextBatchMarks;
  batchOldVersions = nextBatchOldVersions;
}

function growEdges(): void {
  edgeCapacity <<= 1;
  const nextSources = new Int32Array(edgeCapacity);
  const nextObservers = new Int32Array(edgeCapacity);
  const nextNextObserver = new Int32Array(edgeCapacity);
  const nextPreviousObserver = new Int32Array(edgeCapacity);
  const nextNextDependency = new Int32Array(edgeCapacity);
  const nextVersions = new Uint32Array(edgeCapacity);
  nextSources.set(edgeSources);
  nextObservers.set(edgeObservers);
  nextNextObserver.set(edgeNextObserver);
  nextPreviousObserver.set(edgePreviousObserver);
  nextNextDependency.set(edgeNextDependency);
  nextVersions.set(edgeVersions);
  edgeSources = nextSources;
  edgeObservers = nextObservers;
  edgeNextObserver = nextNextObserver;
  edgePreviousObserver = nextPreviousObserver;
  edgeNextDependency = nextNextDependency;
  edgeVersions = nextVersions;
}

function createCell(kind: number): CellId {
  if (count === capacity) grow();
  const id = count++;
  generations[id] = nextGeneration++;
  liveCount++;
  kinds[id] = kind;
  flags[id] = kind === SIGNAL ? 0 : DIRTY;
  return id;
}

function releaseCell(id: CellId): void {
  if (kinds[id] === 0) return;
  clearDependencies(id, true);
  for (const child of children[id] ?? []) disposeEffect(child, false);
  kinds[id] = 0;
  flags[id] = 0;
  values[id] = initializers[id] = calculations[id] = equalities[id] = undefined;
  cleanups[id] = labels[id] = keys[id] = lifetimeStarts[id] = lifetimeStops[id] = undefined;
  listeners[id]?.clear();
  observerHeads[id] = -1;
  observerTails[id] = -1;
  liveCount--;
}

function materialize(id: CellId): void {
  if ((flags[id] & INITIALIZED) !== 0) return;
  flags[id] |= INITIALIZED;
  const initialize = initializers[id];
  if (initialize !== undefined) {
    const previousTracking = tracking;
    tracking = false;
    writesForbidden++;
    try {
      values[id] = initialize();
    } finally {
      writesForbidden--;
      tracking = previousTracking;
    }
    initializers[id] = undefined;
  }
}

function valueInDrafts(id: CellId, batches: readonly number[]): unknown {
  let value = values[id];
  let firstSequence = Infinity;
  let base: unknown;
  const ordered: ActionRecord[] = [];
  for (const batch of batches) {
    const draft = drafts.get(batch);
    const actions = draft?.actions.get(id);
    if (actions === undefined) continue;
    if (actions[0].sequence < firstSequence) {
      firstSequence = actions[0].sequence;
      base = draft!.bases.get(id);
    }
    for (const action of actions) ordered.push(action);
  }
  if (firstSequence === Infinity) return value;
  for (const action of immediateActions.get(id) ?? []) {
    if (action.sequence > firstSequence) ordered.push(action);
  }
  ordered.sort((a, b) => a.sequence - b.sequence);
  value = base;
  for (const record of ordered) {
    const action = record.action;
    value =
      typeof action === "function" ? (action as (previous: unknown) => unknown)(value) : action;
  }
  return value;
}

function notifyListeners(source: CellId): void {
  if (listenerCount === 0) return;
  const work: CellId[] = [source];
  const epoch = ++invalidationEpoch;
  invalidationMarks[source] = epoch;
  for (let cursor = 0; cursor < work.length; cursor++) {
    deliveryVersions[work[cursor]]++;
    for (const listener of listeners[work[cursor]] ?? []) listener();
    let edge = observerHeads[work[cursor]];
    while (edge !== -1) {
      const next = edgeNextObserver[edge];
      const id = edgeObservers[edge];
      if (invalidationMarks[id] !== epoch) {
        invalidationMarks[id] = epoch;
        work.push(id);
      }
      edge = next;
    }
  }
}

function addDependency(source: CellId): void {
  if (!tracking || activeObserver < 0 || source === activeObserver) return;
  if (trackingMarks[source] === activeTrackingEpoch) return;
  trackingMarks[source] = activeTrackingEpoch;
  let edge = trackingRemaining;
  if (edge !== -1 && edgeSources[edge] === source) {
    trackingRemaining = edgeNextDependency[edge];
  } else {
    let previous = -1;
    while (edge !== -1 && edgeSources[edge] !== source) {
      previous = edge;
      edge = edgeNextDependency[edge];
    }
    if (edge !== -1) {
      if (previous === -1) trackingRemaining = edgeNextDependency[edge];
      else edgeNextDependency[previous] = edgeNextDependency[edge];
    } else {
      if (freeEdge !== -1) {
        edge = freeEdge;
        freeEdge = edgeNextDependency[edge];
      } else {
        if (edgeCount === edgeCapacity) growEdges();
        edge = edgeCount++;
      }
      const observerTail = observerTails[source];
      edgeSources[edge] = source;
      edgeObservers[edge] = activeObserver;
      edgePreviousObserver[edge] = observerTail;
      edgeNextObserver[edge] = -1;
      if (observerTail === -1) observerHeads[source] = edge;
      else edgeNextObserver[observerTail] = edge;
      observerTails[source] = edge;
      if (++observed[source] === 1 && lifetimeStarts[source] !== undefined) {
        queueMicrotask(() => {
          if (observed[source] !== 0 && lifetimeStops[source] === undefined) {
            lifetimeStops[source] =
              lifetimeStarts[source]!({
                get: () => read({ id: source }),
                set: (value) => set({ id: source }, value),
              }) ?? undefined;
          }
        });
      }
    }
  }
  edgeNextDependency[edge] = -1;
  if (trackingTail === -1) trackingHead = edge;
  else edgeNextDependency[trackingTail] = edge;
  trackingTail = edge;
  edgeVersions[edge] = versions[source];
}

function dependenciesChanged(id: CellId): boolean {
  for (let edge = dependencyHeads[id]; edge !== -1; edge = edgeNextDependency[edge]) {
    const source = edgeSources[edge];
    if ((flags[source] & (DIRTY | MAYBE_DIRTY)) !== 0 && kinds[source] === COMPUTED) {
      evaluate(source);
    }
    if (edgeVersions[edge] !== versions[source]) return true;
  }
  return false;
}

function hasStaleDependency(id: CellId): boolean {
  for (let edge = dependencyHeads[id]; edge !== -1; edge = edgeNextDependency[edge]) {
    if (edgeVersions[edge] !== versions[edgeSources[edge]]) return true;
  }
  return false;
}

function releaseEdge(edge: number, orphan: boolean): void {
  const source = edgeSources[edge];
  const previousObserver = edgePreviousObserver[edge];
  const nextObserver = edgeNextObserver[edge];
  if (previousObserver === -1) observerHeads[source] = nextObserver;
  else edgeNextObserver[previousObserver] = nextObserver;
  if (nextObserver !== -1) edgePreviousObserver[nextObserver] = previousObserver;
  else observerTails[source] = previousObserver;
  edgeNextDependency[edge] = freeEdge;
  freeEdge = edge;
  if (--observed[source] === 0 && kinds[source] === COMPUTED && orphan) {
    flags[source] |= DIRTY;
    clearDependencies(source, true);
  }
  if (observed[source] === 0 && lifetimeStarts[source] !== undefined) {
    queueMicrotask(() => {
      if (observed[source] === 0) {
        lifetimeStops[source]?.();
        lifetimeStops[source] = undefined;
      }
    });
  }
}

function clearDependencies(id: CellId, orphan = false): void {
  let edge = dependencyHeads[id];
  dependencyHeads[id] = -1;
  dependencyTails[id] = -1;
  while (edge !== -1) {
    const nextDependency = edgeNextDependency[edge];
    releaseEdge(edge, orphan);
    edge = nextDependency;
  }
}

function evaluate(id: CellId): unknown {
  if ((flags[id] & MAYBE_DIRTY) !== 0 && (flags[id] & DIRTY) === 0) {
    if (!dependenciesChanged(id)) {
      flags[id] &= ~MAYBE_DIRTY;
      if (hasErrors[id] !== 0) throw errors[id];
      return values[id];
    }
    flags[id] = (flags[id] | DIRTY) & ~MAYBE_DIRTY;
  }
  if ((flags[id] & DIRTY) === 0) {
    if (hasErrors[id] !== 0) throw errors[id];
    return values[id];
  }
  if ((flags[id] & RUNNING) !== 0) throw new Error("Reactive cycle");
  flags[id] = (flags[id] | RUNNING) & ~DIRTY;
  const previousObserver = activeObserver;
  const previousTracking = tracking;
  const previousTrackingEpoch = activeTrackingEpoch;
  const previousRemaining = trackingRemaining;
  const previousHead = trackingHead;
  const previousTail = trackingTail;
  trackingRemaining = dependencyHeads[id];
  trackingHead = -1;
  trackingTail = -1;
  dependencyHeads[id] = -1;
  dependencyTails[id] = -1;
  trackingEpoch = (trackingEpoch + 1) >>> 0;
  if (trackingEpoch === 0) {
    trackingMarks.fill(0);
    trackingEpoch = 1;
  }
  activeObserver = id;
  activeTrackingEpoch = trackingEpoch;
  tracking = true;
  try {
    let next;
    try {
      next = calculations[id]!();
      hasErrors[id] = 0;
      errors[id] = undefined;
      flags[id] &= ~PENDING;
    } catch (error) {
      errors[id] = error;
      hasErrors[id] = 1;
      if (error === null || typeof error !== "object" || !("then" in error)) flags[id] &= ~PENDING;
      versions[id]++;
      throw error;
    }
    const equal = equalities[id] ?? Object.is;
    if (!equal(values[id], next) || (versions[id] === 0 && kinds[id] === COMPUTED)) {
      values[id] = next;
      versions[id]++;
    }
    settled[id] = 1;
    return values[id];
  } finally {
    let unused = trackingRemaining;
    while (unused !== -1) {
      const next = edgeNextDependency[unused];
      releaseEdge(unused, false);
      unused = next;
    }
    dependencyHeads[id] = trackingHead;
    dependencyTails[id] = trackingTail;
    trackingRemaining = previousRemaining;
    trackingHead = previousHead;
    trackingTail = previousTail;
    activeObserver = previousObserver;
    activeTrackingEpoch = previousTrackingEpoch;
    tracking = previousTracking;
    flags[id] &= ~RUNNING;
    if (hasStaleDependency(id)) flags[id] |= MAYBE_DIRTY;
  }
}

function invalidate(source: CellId): void {
  const work = invalidationWork;
  work[0] = source;
  work.length = 1;
  const epoch = ++invalidationEpoch;
  invalidationMarks[source] = epoch;
  for (let cursor = 0; cursor < work.length; cursor++) {
    let edge = observerHeads[work[cursor]];
    while (edge !== -1) {
      const id = edgeObservers[edge];
      if (
        (flags[id] & (DIRTY | MAYBE_DIRTY)) === 0 &&
        (flags[id] & RUNNING) === 0 &&
        ((flags[id] & ACTIVE) !== 0 || kinds[id] === COMPUTED)
      ) {
        flags[id] |= MAYBE_DIRTY;
        if (kinds[id] === EFFECT) pendingEffects.push(id);
      }
      if (kinds[id] === COMPUTED && invalidationMarks[id] !== epoch) {
        invalidationMarks[id] = epoch;
        work.push(id);
      }
      edge = edgeNextObserver[edge];
    }
  }
  work.length = 0;
  if (batchDepth === 0) flushEffects();
}

function runEffect(id: CellId): void {
  if ((flags[id] & ACTIVE) === 0) return;
  if ((flags[id] & MAYBE_DIRTY) !== 0 && (flags[id] & DIRTY) === 0) {
    if (!dependenciesChanged(id)) {
      flags[id] &= ~MAYBE_DIRTY;
      return;
    }
    flags[id] = (flags[id] | DIRTY) & ~MAYBE_DIRTY;
  }
  if ((flags[id] & DIRTY) === 0) return;
  emit("effect run", id, causeFor(id), labels[id]);
  const previousTracking = tracking;
  tracking = false;
  try {
    cleanups[id]?.();
    for (const child of children[id] ?? []) disposeEffect(child, false);
  } finally {
    tracking = previousTracking;
    cleanups[id] = undefined;
    children[id] = [];
  }
  if ((flags[id] & ACTIVE) === 0) return;
  const result = evaluate(id);
  if (typeof result === "function" && (flags[id] & ACTIVE) !== 0)
    cleanups[id] = result as () => void;
}

function disposeEffect(id: CellId, rethrow: boolean): void {
  if ((flags[id] & ACTIVE) === 0) return;
  flags[id] &= ~(ACTIVE | DIRTY | MAYBE_DIRTY);
  clearDependencies(id, true);
  for (const child of children[id] ?? []) disposeEffect(child, rethrow);
  children[id] = undefined;
  const cleanup = cleanups[id];
  cleanups[id] = undefined;
  if (cleanup !== undefined) {
    const previous = tracking;
    tracking = false;
    try {
      cleanup();
    } catch (error) {
      if (rethrow) throw error;
    } finally {
      tracking = previous;
    }
  }
}

function flushEffects(): void {
  if (flushing) return;
  flushing = true;
  try {
    while (pendingEffects.length !== 0) {
      const effects = pendingEffects;
      pendingEffects = drainingEffects;
      drainingEffects = effects;
      for (let i = 0; i < effects.length; i++) runEffect(effects[i]);
      effects.length = 0;
    }
  } finally {
    flushing = false;
  }
}

export function atom<T>(initial: T | (() => T), options: AtomOptions<T> = {}): Cell<T> {
  const id = createCell(SIGNAL);
  if (typeof initial === "function") initializers[id] = initial as () => T;
  else {
    values[id] = initial;
    flags[id] |= INITIALIZED;
  }
  equalities[id] = options.equals as ((a: unknown, b: unknown) => boolean) | undefined;
  lifetimeStarts[id] = options.effect as AtomOptions<unknown>["effect"];
  labels[id] = options.label;
  keys[id] = options.key;
  const cell = { id };
  if (automaticReclamation) finalizer.register(cell, { id, generation: generations[id] }, cell);
  return cell;
}

export function atomId(initial: unknown): CellId {
  const id = createCell(SIGNAL);
  values[id] = initial;
  flags[id] |= INITIALIZED;
  return id;
}

export function computed<T>(calculate: () => T, options: ComputedOptions<T> = {}): Cell<T> {
  const id = createCell(COMPUTED);
  calculations[id] = calculate;
  equalities[id] = options.equals as ((a: unknown, b: unknown) => boolean) | undefined;
  labels[id] = options.label;
  const cell = { id };
  if (automaticReclamation) finalizer.register(cell, { id, generation: generations[id] }, cell);
  return cell;
}

export function computedId(calculate: () => unknown): CellId {
  const id = createCell(COMPUTED);
  calculations[id] = calculate;
  return id;
}

export function read<T>(cell: Cell<T> | CellId): T {
  const id = typeof cell === "number" ? cell : cell.id;
  if (kinds[id] === SIGNAL) {
    materialize(id);
    if (renderDrafts.length !== 0) {
      addDependency(id);
      return valueInDrafts(id, renderDrafts) as T;
    }
  } else if (renderDrafts.length !== 0) {
    if (!renderCache.has(id)) renderCache.set(id, calculations[id]!());
    addDependency(id);
    return renderCache.get(id) as T;
  } else evaluate(id);
  addDependency(id);
  return values[id] as T;
}

export function set<T>(cell: Cell<T> | CellId, value: T): void {
  if (writesForbidden !== 0) throw new Error("Writes are forbidden in this context");
  const id = typeof cell === "number" ? cell : cell.id;
  if (kinds[id] !== SIGNAL) throw new Error("Only atoms are writable");
  if (inRenderWorld) throw new Error("Signals cannot be written during render");
  materialize(id);
  if (writeDraft !== 0) {
    const draft = drafts.get(writeDraft);
    if (draft === undefined) throw new Error("The transition batch has retired");
    const current = valueInDrafts(id, [writeDraft]);
    const equal = equalities[id] ?? Object.is;
    if (equal(current, value)) return;
    let actions = draft.actions.get(id);
    if (actions === undefined) {
      draft.actions.set(id, (actions = []));
      draft.bases.set(id, values[id]);
    }
    actions.push({ sequence: ++actionSequence, action: value });
    draft.causes.set(id, emit("write", id, causeFor(writeDraft), `batch ${writeDraft}`));
    notifyListeners(id);
    return;
  }
  let affectsDraft = false;
  if (commitCause === undefined) {
    for (const draft of drafts.values()) {
      if (!draft.actions.has(id)) continue;
      let actions = immediateActions.get(id);
      if (actions === undefined) immediateActions.set(id, (actions = []));
      actions.push({ sequence: ++actionSequence, action: value });
      affectsDraft = true;
      break;
    }
  }
  const equal = equalities[id] ?? Object.is;
  if (equal(values[id], value)) {
    if (affectsDraft) notifyListeners(id);
    return;
  }
  if (batchDepth !== 0) {
    if (batchMarks[id] !== batchEpoch) {
      batchMarks[id] = batchEpoch;
      batchOldValues[id] = values[id];
      batchOldVersions[id] = versions[id];
      batchTouched.push(id);
    }
  }
  values[id] = value;
  versions[id]++;
  emit("write", id, commitCause, labels[id]);
  invalidate(id);
  notifyListeners(id);
}

export function update<T>(cell: Cell<T>, reducer: (previous: T) => T): void {
  if (writeDraft !== 0) {
    const id = cell.id;
    materialize(id);
    const draft = drafts.get(writeDraft);
    if (draft === undefined) throw new Error("The transition batch has retired");
    let actions = draft.actions.get(id);
    if (actions === undefined) {
      draft.actions.set(id, (actions = []));
      draft.bases.set(id, values[id]);
    }
    actions.push({ sequence: ++actionSequence, action: reducer as (previous: unknown) => unknown });
    draft.causes.set(id, emit("write", id, causeFor(writeDraft), `batch ${writeDraft}`));
    notifyListeners(id);
    return;
  }
  let actions: ActionRecord[] | undefined;
  for (const draft of drafts.values()) {
    if (!draft.actions.has(cell.id)) continue;
    actions = immediateActions.get(cell.id);
    if (actions === undefined) immediateActions.set(cell.id, (actions = []));
    actions.push({ sequence: ++actionSequence, action: reducer as (previous: unknown) => unknown });
    break;
  }
  if (actions !== undefined) {
    const value = reducer(read(cell));
    const record = actions[actions.length - 1];
    actions.pop();
    set(cell, value);
    actions[actions.length - 1] = record;
    return;
  }
  set(cell, reducer(read(cell)));
}

export function effect(calculate: () => void | (() => void)): () => void {
  const id = createCell(EFFECT);
  flags[id] |= ACTIVE;
  children[id] = [];
  calculations[id] = calculate;
  scope?.push(id);
  if (activeObserver >= 0 && kinds[activeObserver] === EFFECT) children[activeObserver]!.push(id);
  batchDepth++;
  try {
    runEffect(id);
  } finally {
    if (--batchDepth === 0) flushEffects();
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    disposeEffect(id, true);
  };
}

export function effectScope(run: () => void): () => void {
  const previous = scope;
  const owned: CellId[] = [];
  scope = owned;
  try {
    run();
  } finally {
    scope = previous;
  }
  return () => {
    for (const id of owned) {
      disposeEffect(id, false);
    }
  };
}

export function startBatch(): void {
  if (batchDepth === 0) {
    batchEpoch = (batchEpoch + 1) >>> 0;
    if (batchEpoch === 0) {
      batchMarks.fill(0);
      batchEpoch = 1;
    }
    batchTouched.length = 0;
  }
  batchDepth++;
}

export function endBatch(): void {
  if (batchDepth === 0) throw new Error("No batch is open");
  if (--batchDepth === 0) {
    for (const id of batchTouched) {
      const equal = equalities[id] ?? Object.is;
      if (equal(values[id], batchOldValues[id])) versions[id] = batchOldVersions[id];
      batchOldValues[id] = undefined;
    }
    batchTouched.length = 0;
    flushEffects();
  }
}

export function batch(run: () => void): void {
  startBatch();
  try {
    run();
  } finally {
    endBatch();
  }
}

export function untracked<T>(run: () => T): T {
  const previous = tracking;
  tracking = false;
  try {
    return run();
  } finally {
    tracking = previous;
  }
}

export function subscribe(cell: Cell, listener: () => void): () => void {
  const id = cell.id;
  let subscriberSet = listeners[id];
  if (subscriberSet === undefined) listeners[id] = subscriberSet = new Set();
  subscriberSet.add(listener);
  listenerCount++;
  if (++observed[id] === 1 && lifetimeStarts[id] !== undefined) {
    queueMicrotask(() => {
      if (observed[id] !== 0 && lifetimeStops[id] === undefined) {
        lifetimeStops[id] =
          lifetimeStarts[id]!({
            get: () => read({ id }),
            set: (value) => set({ id }, value),
          }) ?? undefined;
      }
    });
  }
  return () => {
    if (!subscriberSet!.delete(listener)) return;
    listenerCount--;
    if (--observed[id] === 0 && lifetimeStarts[id] !== undefined) {
      queueMicrotask(() => {
        if (observed[id] === 0) {
          lifetimeStops[id]?.();
          lifetimeStops[id] = undefined;
        }
      });
    }
    if (observed[id] === 0 && kinds[id] === COMPUTED) {
      flags[id] |= DIRTY;
      clearDependencies(id, true);
    }
  };
}

export function disposeCell(cell: Cell): void {
  finalizer.unregister(cell);
  releaseCell(cell.id);
}

export function setAutomaticReclamation(enabled: boolean): void {
  automaticReclamation = enabled;
}

export function revision(cell: Cell): number {
  return deliveryVersions[cell.id];
}

export function installState<T>(cell: Cell<T>, value: T): void {
  const id = cell.id;
  values[id] = value;
  initializers[id] = undefined;
  flags[id] |= INITIALIZED;
}

export function serializeAtomState(
  atoms: Cell[],
  replacer?: (key: string, value: unknown) => unknown,
): string {
  const state: Record<string, unknown> = {};
  for (let i = 0; i < atoms.length; i++) {
    const cell = atoms[i];
    const key = keys[cell.id] ?? String(i);
    state[key] = read(cell);
  }
  return JSON.stringify(state, replacer);
}

export function initializeAtomState(
  json: string,
  atoms: Cell[],
  reviver?: (key: string, value: unknown) => unknown,
): void {
  const state = JSON.parse(json, reviver) as Record<string, unknown>;
  for (let i = 0; i < atoms.length; i++) {
    const cell = atoms[i];
    const key = keys[cell.id] ?? String(i);
    if (Object.prototype.hasOwnProperty.call(state, key))
      installState(cell, state[key]);
  }
}

export function beginDraft(): number {
  const id = nextDraft++;
  drafts.set(id, {
    actions: new Map(),
    bases: new Map(),
    causes: new Map(),
    roots: new Set(),
    committedRoots: new Set(),
  });
  emit("batch open", id);
  return id;
}

export function withDraft<T>(id: number, run: () => T): T {
  const previous = writeDraft;
  writeDraft = id;
  try {
    return run();
  } finally {
    writeDraft = previous;
  }
}

export function markDraftScheduled(id: number, container?: object): void {
  scheduledDrafts.add(id);
  if (container !== undefined) drafts.get(id)?.roots.add(container);
}

export function commitIfUnscheduled(id: number): void {
  if (drafts.has(id) && !scheduledDrafts.has(id)) commitDrafts({}, [id]);
}

export function enterRenderWorld(batches: number[]): void {
  inRenderWorld = true;
  renderDrafts = batches;
  renderCache = new Map();
  emit("render pass start", undefined, batches.length === 0 ? undefined : causeFor(batches[0]));
}

export function leaveRenderWorld(): void {
  emit("render pass end");
  renderDrafts = [];
  inRenderWorld = false;
  renderCache.clear();
}

export function commitDrafts(container: object, batches: number[]): void {
  const view = new Map<CellId, unknown>();
  for (let id = 0; id < count; id++) {
    if (kinds[id] === SIGNAL) {
      materialize(id);
      view.set(id, valueInDrafts(id, batches));
    }
  }
  rootViews.set(container, view);
  emit("root commit", undefined, batches.length === 0 ? undefined : causeFor(batches[0]));
  for (const batch of batches) {
    const draft = drafts.get(batch);
    if (draft === undefined) continue;
    draft.committedRoots.add(container);
    let complete = true;
    for (const root of draft.roots) {
      if (!draft.committedRoots.has(root)) {
        complete = false;
        break;
      }
    }
    if (!complete) continue;
    commitCause = emit("batch retire", batch, causeFor(batch));
    for (const [id, actions] of draft.actions) {
      let value = draft.bases.get(id);
      const ordered = actions.slice();
      for (const action of immediateActions.get(id) ?? []) {
        if (action.sequence > actions[0].sequence) ordered.push(action);
      }
      ordered.sort((a, b) => a.sequence - b.sequence);
      for (const record of ordered) {
        const action = record.action;
        value =
          typeof action === "function" ? (action as (previous: unknown) => unknown)(value) : action;
      }
      set({ id }, value);
    }
    commitCause = undefined;
    drafts.delete(batch);
    scheduledDrafts.delete(batch);
    for (const id of draft.actions.keys()) notifyListeners(id);
  }
  if (drafts.size === 0) immediateActions.clear();
}

export function latest<T>(cell: Cell<T>): T {
  if (inRenderWorld) {
    try {
      return read(cell);
    } catch (error) {
      if (error !== null && typeof error === "object" && "then" in error) {
        return settled[cell.id] === 0 ? (undefined as T) : (values[cell.id] as T);
      }
      throw error;
    }
  }
  if (kinds[cell.id] !== SIGNAL) {
    try {
      return read(cell);
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "then" in error &&
        settled[cell.id] !== 0
      ) {
        return values[cell.id] as T;
      }
      if (error !== null && typeof error === "object" && "then" in error) return undefined as T;
      throw error;
    }
  }
  materialize(cell.id);
  return valueInDrafts(cell.id, [...drafts.keys()]) as T;
}

export function committed<T>(cell: Cell<T>, container?: object): T {
  if (container !== undefined) {
    const value = rootViews.get(container)?.get(cell.id);
    if (value !== undefined || rootViews.get(container)?.has(cell.id)) return value as T;
  }
  return read(cell);
}

export function isPending(cell: Cell): boolean {
  if ((flags[cell.id] & PENDING) !== 0) return true;
  const error = errors[cell.id];
  if (hasErrors[cell.id] !== 0 && error !== null && typeof error === "object" && "then" in error)
    return true;
  for (const [id, draft] of drafts) {
    if (inRenderWorld && renderDrafts.includes(id)) continue;
    if (draft.actions.has(cell.id) || (kinds[cell.id] === COMPUTED && draft.actions.size !== 0))
      return true;
  }
  return false;
}

export function pendingBatch(cell: Cell): number {
  for (const [id, draft] of drafts) {
    if (draft.actions.has(cell.id) || (kinds[cell.id] === COMPUTED && draft.actions.size !== 0))
      return id;
  }
  return 0;
}

export function deliveryCause(cell: Cell): number | undefined {
  if (inRenderWorld) {
    for (let i = renderDrafts.length - 1; i >= 0; i--) {
      const cause = drafts.get(renderDrafts[i])?.causes.get(cell.id);
      if (cause !== undefined) return cause;
    }
  }
  return causeFor(cell.id);
}

export function staleValue<T>(cell: Cell<T>): { available: boolean; value: T | undefined } {
  return { available: settled[cell.id] !== 0, value: values[cell.id] as T | undefined };
}

export function renderIncludesDraft(): boolean {
  return inRenderWorld && renderDrafts.length !== 0;
}

export function refresh(cell: Cell): void {
  const id = cell.id;
  if (kinds[id] !== COMPUTED) return;
  flags[id] |= DIRTY | PENDING;
  invalidate(id);
  notifyListeners(id);
}

export function resolveComputed<T>(cell: Cell<T>, value: T): void {
  const id = cell.id;
  values[id] = value;
  errors[id] = undefined;
  hasErrors[id] = 0;
  settled[id] = 1;
  flags[id] &= ~(DIRTY | MAYBE_DIRTY | PENDING);
  versions[id]++;
  emit("suspense settlement", id);
  notifyListeners(id);
}

export function reset(): void {
  capacity = 256;
  count = 0;
  liveCount = 0;
  kinds = new Uint8Array(capacity);
  flags = new Uint8Array(capacity);
  versions = new Uint32Array(capacity);
  invalidationMarks = new Uint32Array(capacity);
  deliveryVersions = new Uint32Array(capacity);
  generations = new Uint32Array(capacity);
  settled = new Uint8Array(capacity);
  invalidationEpoch = 0;
  observed = new Uint32Array(capacity);
  observerHeads = new Int32Array(capacity);
  observerTails = new Int32Array(capacity);
  dependencyHeads = new Int32Array(capacity);
  dependencyTails = new Int32Array(capacity);
  trackingMarks = new Uint32Array(capacity);
  batchMarks = new Uint32Array(capacity);
  batchOldVersions = new Uint32Array(capacity);
  observerHeads.fill(-1);
  observerTails.fill(-1);
  dependencyHeads.fill(-1);
  dependencyTails.fill(-1);
  edgeCapacity = 1024;
  edgeCount = 0;
  freeEdge = -1;
  edgeSources = new Int32Array(edgeCapacity);
  edgeObservers = new Int32Array(edgeCapacity);
  edgeNextObserver = new Int32Array(edgeCapacity);
  edgePreviousObserver = new Int32Array(edgeCapacity);
  edgeNextDependency = new Int32Array(edgeCapacity);
  edgeVersions = new Uint32Array(edgeCapacity);
  trackingEpoch = 0;
  activeTrackingEpoch = 0;
  trackingRemaining = -1;
  trackingHead = -1;
  trackingTail = -1;
  batchEpoch = 0;
  values.length = initializers.length = calculations.length = equalities.length = 0;
  cleanups.length = labels.length = keys.length = lifetimeStarts.length = lifetimeStops.length = 0;
  errors.length = 0;
  hasErrors = new Uint8Array(capacity);
  listeners.length = children.length = 0;
  activeObserver = -1;
  tracking = true;
  writesForbidden = batchDepth = 0;
  pendingEffects = [];
  drainingEffects = [];
  invalidationWork.length = 0;
  listenerCount = 0;
  batchOldValues.length = 0;
  batchTouched.length = 0;
  drafts.clear();
  immediateActions.clear();
  actionSequence = 0;
  scheduledDrafts.clear();
  nextDraft = 1;
  writeDraft = 0;
  renderDrafts = [];
  inRenderWorld = false;
  renderCache.clear();
  rootViews = new WeakMap();
}

export function debugStats(): { cells: number; pendingEffects: number } {
  return { cells: liveCount, pendingEffects: pendingEffects.length };
}

export function debugEpisodeCount(): number {
  return drafts.size;
}
