import { causeFor, emit } from './trace';

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
let observers: Uint32Array[] = [];
let dependencies: Uint32Array[] = [];
let dependencyVersions: Uint32Array[] = [];
const values: unknown[] = [];
const initializers: Array<(() => unknown) | undefined> = [];
const calculations: Array<(() => unknown) | undefined> = [];
const equalities: Array<((a: unknown, b: unknown) => boolean) | undefined> = [];
const cleanups: Array<(() => void) | undefined> = [];
const errors: unknown[] = [];
let hasErrors = new Uint8Array(256);
const labels: Array<string | undefined> = [];
const keys: Array<string | undefined> = [];
const lifetimeStarts: Array<AtomOptions<unknown>['effect']> = [];
const lifetimeStops: Array<(() => void) | undefined> = [];
const children: CellId[][] = [];
const listeners: Array<Set<() => void> | undefined> = [];
const observedCounts = new Uint32Array(256);
let observed = observedCounts;

let activeObserver = -1;
let tracking = true;
let writesForbidden = 0;
let batchDepth = 0;
let flushing = false;
let pendingEffects: CellId[] = [];
let scope: CellId[] | undefined;
let batchValues: Map<CellId, [unknown, number]> | undefined;
type DraftAction = unknown | ((previous: unknown) => unknown);
interface Draft { actions: Map<CellId, DraftAction[]>; cause?: number }
const drafts = new Map<number, Draft>();
let nextDraft = 1;
let writeDraft = 0;
let renderDrafts: number[] = [];
let inRenderWorld = false;
let renderCache = new Map<CellId, unknown>();
let rootViews = new WeakMap<object, Map<CellId, unknown>>();
let commitCause: number | undefined;
const finalizer = new FinalizationRegistry<{ id: CellId; generation: number }>(held => {
  if (generations[held.id] === held.generation) releaseCell(held.id);
});

function grow(): void {
  const oldWords = capacity >>> 5;
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
  nextKinds.set(kinds);
  nextFlags.set(flags);
  nextVersions.set(versions);
  nextInvalidationMarks.set(invalidationMarks);
  nextDeliveryVersions.set(deliveryVersions);
  nextGenerations.set(generations);
  nextSettled.set(settled);
  nextObserved.set(observed);
  nextHasErrors.set(hasErrors);
  kinds = nextKinds;
  flags = nextFlags;
  versions = nextVersions;
  invalidationMarks = nextInvalidationMarks;
  deliveryVersions = nextDeliveryVersions;
  generations = nextGenerations;
  settled = nextSettled;
  observed = nextObserved;
  hasErrors = nextHasErrors;
  const words = capacity >>> 5;
  for (let i = 0; i < count; i++) {
    const nextObservers = new Uint32Array(words);
    const nextDependencies = new Uint32Array(words);
    const nextDependencyVersions = new Uint32Array(capacity);
    nextObservers.set(observers[i].subarray(0, oldWords));
    nextDependencies.set(dependencies[i].subarray(0, oldWords));
    nextDependencyVersions.set(dependencyVersions[i]);
    observers[i] = nextObservers;
    dependencies[i] = nextDependencies;
    dependencyVersions[i] = nextDependencyVersions;
  }
}

function createCell(kind: number): CellId {
  if (count === capacity) grow();
  const id = count++;
  generations[id] = nextGeneration++;
  liveCount++;
  kinds[id] = kind;
  flags[id] = kind === SIGNAL ? 0 : DIRTY;
  observers[id] = new Uint32Array(capacity >>> 5);
  dependencies[id] = new Uint32Array(capacity >>> 5);
  dependencyVersions[id] = new Uint32Array(capacity);
  children[id] = [];
  return id;
}

function releaseCell(id: CellId): void {
  if (kinds[id] === 0) return;
  clearDependencies(id, true);
  for (const child of children[id]) disposeEffect(child, false);
  kinds[id] = 0;
  flags[id] = 0;
  values[id] = initializers[id] = calculations[id] = equalities[id] = undefined;
  cleanups[id] = labels[id] = keys[id] = lifetimeStarts[id] = lifetimeStops[id] = undefined;
  listeners[id]?.clear();
  observers[id].fill(0);
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
  for (const batch of batches) {
    const actions = drafts.get(batch)?.actions.get(id);
    if (actions === undefined) continue;
    for (const action of actions) {
      value = typeof action === 'function' ? (action as (previous: unknown) => unknown)(value) : action;
    }
  }
  return value;
}

function notifyListeners(source: CellId): void {
  const work: CellId[] = [source];
  const epoch = ++invalidationEpoch;
  invalidationMarks[source] = epoch;
  for (let cursor = 0; cursor < work.length; cursor++) {
    deliveryVersions[work[cursor]]++;
    for (const listener of listeners[work[cursor]] ?? []) listener();
    const mask = observers[work[cursor]];
    for (let word = 0; word < mask.length; word++) {
      let bits = mask[word];
      while (bits !== 0) {
        const bit = bits & -bits;
        const id = (word << 5) + (31 - Math.clz32(bit));
        if (invalidationMarks[id] !== epoch) {
          invalidationMarks[id] = epoch;
          work.push(id);
        }
        bits ^= bit;
      }
    }
  }
}

function addDependency(source: CellId): void {
  if (!tracking || activeObserver < 0 || source === activeObserver) return;
  const word = activeObserver >>> 5;
  const bit = 1 << (activeObserver & 31);
  if ((observers[source][word] & bit) !== 0) return;
  observers[source][word] |= bit;
  dependencies[activeObserver][source >>> 5] |= 1 << (source & 31);
  dependencyVersions[activeObserver][source] = versions[source];
  if (++observed[source] === 1 && lifetimeStarts[source] !== undefined) {
    queueMicrotask(() => {
      if (observed[source] !== 0 && lifetimeStops[source] === undefined) {
        lifetimeStops[source] = lifetimeStarts[source]!({
          get: () => read({ id: source }),
          set: value => set({ id: source }, value),
        }) ?? undefined;
      }
    });
  }
}

function dependenciesChanged(id: CellId): boolean {
  const mask = dependencies[id];
  for (let word = 0; word < mask.length; word++) {
    let bits = mask[word];
    while (bits !== 0) {
      const bit = bits & -bits;
      const source = (word << 5) + (31 - Math.clz32(bit));
      if ((flags[source] & (DIRTY | MAYBE_DIRTY)) !== 0 && kinds[source] === COMPUTED) {
        evaluate(source);
      }
      if (dependencyVersions[id][source] !== versions[source]) return true;
      bits ^= bit;
    }
  }
  return false;
}

function hasStaleDependency(id: CellId): boolean {
  const mask = dependencies[id];
  for (let word = 0; word < mask.length; word++) {
    let bits = mask[word];
    while (bits !== 0) {
      const bit = bits & -bits;
      const source = (word << 5) + (31 - Math.clz32(bit));
      if (dependencyVersions[id][source] !== versions[source]) return true;
      bits ^= bit;
    }
  }
  return false;
}

function clearDependencies(id: CellId, orphan = false): void {
  const mask = dependencies[id];
  for (let word = 0; word < mask.length; word++) {
    let bits = mask[word];
    while (bits !== 0) {
      const bit = bits & -bits;
      const source = (word << 5) + (31 - Math.clz32(bit));
      observers[source][id >>> 5] &= ~(1 << (id & 31));
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
      bits ^= bit;
    }
    mask[word] = 0;
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
  if ((flags[id] & RUNNING) !== 0) throw new Error('Reactive cycle');
  flags[id] = (flags[id] | RUNNING) & ~DIRTY;
  clearDependencies(id);
  const previousObserver = activeObserver;
  const previousTracking = tracking;
  activeObserver = id;
  tracking = true;
  try {
    let next;
    try {
      next = calculations[id]!();
      hasErrors[id] = 0;
      errors[id] = undefined;
    } catch (error) {
      errors[id] = error;
      hasErrors[id] = 1;
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
    activeObserver = previousObserver;
    tracking = previousTracking;
    flags[id] &= ~RUNNING;
    if (hasStaleDependency(id)) flags[id] |= MAYBE_DIRTY;
  }
}

function invalidate(source: CellId): void {
  const work: CellId[] = [source];
  const epoch = ++invalidationEpoch;
  invalidationMarks[source] = epoch;
  for (let cursor = 0; cursor < work.length; cursor++) {
    const mask = observers[work[cursor]];
    for (let word = 0; word < mask.length; word++) {
      let bits = mask[word];
      while (bits !== 0) {
        const bit = bits & -bits;
        const id = (word << 5) + (31 - Math.clz32(bit));
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
        bits ^= bit;
      }
    }
  }
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
  emit('effect run', id, causeFor(id), labels[id]);
  const previousTracking = tracking;
  tracking = false;
  try {
    cleanups[id]?.();
    for (const child of children[id]) disposeEffect(child, false);
  } finally {
    tracking = previousTracking;
    cleanups[id] = undefined;
    children[id] = [];
  }
  if ((flags[id] & ACTIVE) === 0) return;
  const result = evaluate(id);
  if (typeof result === 'function' && (flags[id] & ACTIVE) !== 0) cleanups[id] = result as () => void;
}

function disposeEffect(id: CellId, rethrow: boolean): void {
  if ((flags[id] & ACTIVE) === 0) return;
  flags[id] &= ~(ACTIVE | DIRTY | MAYBE_DIRTY);
  clearDependencies(id, true);
  for (const child of children[id]) disposeEffect(child, rethrow);
  children[id] = [];
  const cleanup = cleanups[id];
  cleanups[id] = undefined;
  if (cleanup !== undefined) {
    const previous = tracking;
    tracking = false;
    try { cleanup(); } catch (error) { if (rethrow) throw error; }
    finally { tracking = previous; }
  }
}

function flushEffects(): void {
  if (flushing) return;
  flushing = true;
  try {
    while (pendingEffects.length !== 0) {
      const effects = pendingEffects;
      pendingEffects = [];
      for (let i = 0; i < effects.length; i++) runEffect(effects[i]);
    }
  } finally {
    flushing = false;
  }
}

export function atom<T>(initial: T | (() => T), options: AtomOptions<T> = {}): Cell<T> {
  const id = createCell(SIGNAL);
  if (typeof initial === 'function') initializers[id] = initial as () => T;
  else {
    values[id] = initial;
    flags[id] |= INITIALIZED;
  }
  equalities[id] = options.equals as ((a: unknown, b: unknown) => boolean) | undefined;
  lifetimeStarts[id] = options.effect as AtomOptions<unknown>['effect'];
  labels[id] = options.label;
  keys[id] = options.key;
  const cell = { id };
  finalizer.register(cell, { id, generation: generations[id] }, cell);
  return cell;
}

export function computed<T>(calculate: () => T, options: ComputedOptions<T> = {}): Cell<T> {
  const id = createCell(COMPUTED);
  calculations[id] = calculate;
  equalities[id] = options.equals as ((a: unknown, b: unknown) => boolean) | undefined;
  labels[id] = options.label;
  const cell = { id };
  finalizer.register(cell, { id, generation: generations[id] }, cell);
  return cell;
}

export function read<T>(cell: Cell<T>): T {
  const id = cell.id;
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

export function set<T>(cell: Cell<T>, value: T): void {
  if (writesForbidden !== 0) throw new Error('Writes are forbidden in this context');
  const id = cell.id;
  if (kinds[id] !== SIGNAL) throw new Error('Only atoms are writable');
  if (inRenderWorld) throw new Error('Signals cannot be written during render');
  materialize(id);
  if (writeDraft !== 0) {
    const draft = drafts.get(writeDraft);
    if (draft === undefined) throw new Error('The transition batch has retired');
    const current = valueInDrafts(id, [writeDraft]);
    const equal = equalities[id] ?? Object.is;
    if (equal(current, value)) return;
    let actions = draft.actions.get(id);
    if (actions === undefined) draft.actions.set(id, actions = []);
    actions.push(value);
    emit('write', id, causeFor(writeDraft), `batch ${writeDraft}`);
    notifyListeners(id);
    return;
  }
  const equal = equalities[id] ?? Object.is;
  if (equal(values[id], value)) return;
  if (batchDepth !== 0) {
    batchValues ??= new Map();
    if (!batchValues.has(id)) batchValues.set(id, [values[id], versions[id]]);
  }
  values[id] = value;
  versions[id]++;
  emit('write', id, commitCause, labels[id]);
  invalidate(id);
  notifyListeners(id);
}

export function update<T>(cell: Cell<T>, reducer: (previous: T) => T): void {
  if (writeDraft !== 0) {
    const id = cell.id;
    materialize(id);
    const draft = drafts.get(writeDraft);
    if (draft === undefined) throw new Error('The transition batch has retired');
    let actions = draft.actions.get(id);
    if (actions === undefined) draft.actions.set(id, actions = []);
    actions.push(reducer as (previous: unknown) => unknown);
    emit('write', id, causeFor(writeDraft), `batch ${writeDraft}`);
    notifyListeners(id);
    return;
  }
  set(cell, reducer(read(cell)));
}

export function effect(calculate: () => void | (() => void)): () => void {
  const id = createCell(EFFECT);
  flags[id] |= ACTIVE;
  calculations[id] = calculate;
  scope?.push(id);
  if (activeObserver >= 0 && kinds[activeObserver] === EFFECT) children[activeObserver].push(id);
  batchDepth++;
  try { runEffect(id); } finally {
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
  if (batchDepth === 0) batchValues = new Map();
  batchDepth++;
}

export function endBatch(): void {
  if (batchDepth === 0) throw new Error('No batch is open');
  if (--batchDepth === 0) {
    for (const [id, [value, version]] of batchValues ?? []) {
      const equal = equalities[id] ?? Object.is;
      if (equal(values[id], value)) versions[id] = version;
    }
    batchValues = undefined;
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
  if (++observed[id] === 1 && lifetimeStarts[id] !== undefined) {
    queueMicrotask(() => {
      if (observed[id] !== 0 && lifetimeStops[id] === undefined) {
        lifetimeStops[id] = lifetimeStarts[id]!({
          get: () => read({ id }),
          set: value => set({ id }, value),
        }) ?? undefined;
      }
    });
  }
  return () => {
    if (!subscriberSet!.delete(listener)) return;
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

export function revision(cell: Cell): number {
  return deliveryVersions[cell.id];
}

export function installState<T>(cell: Cell<T>, value: T): void {
  const id = cell.id;
  values[id] = value;
  initializers[id] = undefined;
  flags[id] |= INITIALIZED;
}

export function serializeAtomState(atoms: Cell[], replacer?: (key: string, value: unknown) => unknown): string {
  const state: Record<string, unknown> = {};
  for (const cell of atoms) {
    const key = keys[cell.id];
    if (key === undefined) throw new Error('Every serialized atom needs a key');
    state[key] = read(cell);
  }
  return JSON.stringify(state, replacer);
}

export function initializeAtomState(json: string, atoms: Cell[], reviver?: (key: string, value: unknown) => unknown): void {
  const state = JSON.parse(json, reviver) as Record<string, unknown>;
  for (const cell of atoms) {
    const key = keys[cell.id];
    if (key !== undefined && Object.prototype.hasOwnProperty.call(state, key)) installState(cell, state[key]);
  }
}

export function beginDraft(): number {
  const id = nextDraft++;
  drafts.set(id, { actions: new Map() });
  emit('batch open', id);
  return id;
}

export function withDraft<T>(id: number, run: () => T): T {
  const previous = writeDraft;
  writeDraft = id;
  try { return run(); } finally { writeDraft = previous; }
}

export function enterRenderWorld(batches: number[]): void {
  inRenderWorld = true;
  renderDrafts = batches;
  renderCache = new Map();
  emit('render pass start', undefined, batches.length === 0 ? undefined : causeFor(batches[0]));
}

export function leaveRenderWorld(): void {
  emit('render pass end');
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
  emit('root commit', undefined, batches.length === 0 ? undefined : causeFor(batches[0]));
  for (const batch of batches) {
    const draft = drafts.get(batch);
    if (draft === undefined) continue;
    commitCause = emit('batch retire', batch, causeFor(batch));
    for (const [id, actions] of draft.actions) {
      let value = values[id];
      for (const action of actions) {
        value = typeof action === 'function' ? (action as (previous: unknown) => unknown)(value) : action;
      }
      set({ id }, value);
    }
    commitCause = undefined;
    drafts.delete(batch);
    for (const id of draft.actions.keys()) notifyListeners(id);
  }
}

export function latest<T>(cell: Cell<T>): T {
  if (inRenderWorld) return read(cell);
  if (kinds[cell.id] !== SIGNAL) {
    try { return read(cell); } catch (error) {
      if (error !== null && typeof error === 'object' && 'then' in error && settled[cell.id] !== 0) {
        return values[cell.id] as T;
      }
      if (error !== null && typeof error === 'object' && 'then' in error) return undefined as T;
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
  const error = errors[cell.id];
  if (hasErrors[cell.id] !== 0 && error !== null && typeof error === 'object' && 'then' in error) return true;
  for (const [id, draft] of drafts) {
    if (inRenderWorld && renderDrafts.includes(id)) continue;
    if (draft.actions.has(cell.id) || kinds[cell.id] === COMPUTED && draft.actions.size !== 0) return true;
  }
  return false;
}

export function pendingBatch(cell: Cell): number {
  for (const [id, draft] of drafts) {
    if (draft.actions.has(cell.id) || kinds[cell.id] === COMPUTED && draft.actions.size !== 0) return id;
  }
  return 0;
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
  flags[id] |= DIRTY;
  invalidate(id);
  notifyListeners(id);
}

export function resolveComputed<T>(cell: Cell<T>, value: T): void {
  const id = cell.id;
  values[id] = value;
  errors[id] = undefined;
  hasErrors[id] = 0;
  settled[id] = 1;
  flags[id] &= ~(DIRTY | MAYBE_DIRTY);
  versions[id]++;
  emit('suspense settlement', id);
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
  observers = [];
  dependencies = [];
  dependencyVersions = [];
  values.length = initializers.length = calculations.length = equalities.length = 0;
  cleanups.length = labels.length = keys.length = lifetimeStarts.length = lifetimeStops.length = 0;
  errors.length = 0;
  hasErrors = new Uint8Array(capacity);
  listeners.length = children.length = 0;
  activeObserver = -1;
  tracking = true;
  writesForbidden = batchDepth = 0;
  pendingEffects = [];
  batchValues = undefined;
  drafts.clear();
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
