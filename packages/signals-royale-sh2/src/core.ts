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
let kinds = new Uint8Array(capacity);
let flags = new Uint8Array(capacity);
let versions = new Uint32Array(capacity);
let invalidationMarks = new Uint32Array(capacity);
let invalidationEpoch = 0;
let observers: Uint32Array[] = [];
let dependencies: Uint32Array[] = [];
let dependencyVersions: Uint32Array[] = [];
const values: unknown[] = [];
const initializers: Array<(() => unknown) | undefined> = [];
const calculations: Array<(() => unknown) | undefined> = [];
const equalities: Array<((a: unknown, b: unknown) => boolean) | undefined> = [];
const cleanups: Array<(() => void) | undefined> = [];
const labels: Array<string | undefined> = [];
const keys: Array<string | undefined> = [];
const lifetimeStarts: Array<AtomOptions<unknown>['effect']> = [];
const lifetimeStops: Array<(() => void) | undefined> = [];
const children: CellId[][] = [];
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

function grow(): void {
  const oldWords = capacity >>> 5;
  capacity <<= 1;
  const nextKinds = new Uint8Array(capacity);
  const nextFlags = new Uint8Array(capacity);
  const nextVersions = new Uint32Array(capacity);
  const nextInvalidationMarks = new Uint32Array(capacity);
  const nextObserved = new Uint32Array(capacity);
  nextKinds.set(kinds);
  nextFlags.set(flags);
  nextVersions.set(versions);
  nextInvalidationMarks.set(invalidationMarks);
  nextObserved.set(observed);
  kinds = nextKinds;
  flags = nextFlags;
  versions = nextVersions;
  invalidationMarks = nextInvalidationMarks;
  observed = nextObserved;
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
  kinds[id] = kind;
  flags[id] = kind === SIGNAL ? 0 : DIRTY;
  observers[id] = new Uint32Array(capacity >>> 5);
  dependencies[id] = new Uint32Array(capacity >>> 5);
  dependencyVersions[id] = new Uint32Array(capacity);
  children[id] = [];
  return id;
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

function clearDependencies(id: CellId): void {
  const mask = dependencies[id];
  for (let word = 0; word < mask.length; word++) {
    let bits = mask[word];
    while (bits !== 0) {
      const bit = bits & -bits;
      const source = (word << 5) + (31 - Math.clz32(bit));
      observers[source][id >>> 5] &= ~(1 << (id & 31));
      if (--observed[source] === 0 && lifetimeStarts[source] !== undefined) {
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
      return values[id];
    }
    flags[id] = (flags[id] | DIRTY) & ~MAYBE_DIRTY;
  }
  if ((flags[id] & DIRTY) === 0) return values[id];
  if ((flags[id] & RUNNING) !== 0) throw new Error('Reactive cycle');
  flags[id] = (flags[id] | RUNNING) & ~DIRTY;
  clearDependencies(id);
  const previousObserver = activeObserver;
  const previousTracking = tracking;
  activeObserver = id;
  tracking = true;
  try {
    const next = calculations[id]!();
    const equal = equalities[id] ?? Object.is;
    if (!equal(values[id], next) || (versions[id] === 0 && kinds[id] === COMPUTED)) {
      values[id] = next;
      versions[id]++;
    }
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
  clearDependencies(id);
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
  return { id };
}

export function computed<T>(calculate: () => T, options: ComputedOptions<T> = {}): Cell<T> {
  const id = createCell(COMPUTED);
  calculations[id] = calculate;
  equalities[id] = options.equals as ((a: unknown, b: unknown) => boolean) | undefined;
  labels[id] = options.label;
  return { id };
}

export function read<T>(cell: Cell<T>): T {
  const id = cell.id;
  if (kinds[id] === SIGNAL) materialize(id);
  else evaluate(id);
  addDependency(id);
  return values[id] as T;
}

export function set<T>(cell: Cell<T>, value: T): void {
  if (writesForbidden !== 0) throw new Error('Writes are forbidden in this context');
  const id = cell.id;
  if (kinds[id] !== SIGNAL) throw new Error('Only atoms are writable');
  materialize(id);
  const equal = equalities[id] ?? Object.is;
  if (equal(values[id], value)) return;
  if (batchDepth !== 0) {
    batchValues ??= new Map();
    if (!batchValues.has(id)) batchValues.set(id, [values[id], versions[id]]);
  }
  values[id] = value;
  versions[id]++;
  invalidate(id);
}

export function update<T>(cell: Cell<T>, reducer: (previous: T) => T): void {
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
  const stop = effect(() => {
    read(cell);
    listener();
  });
  return stop;
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

export function reset(): void {
  capacity = 256;
  count = 0;
  kinds = new Uint8Array(capacity);
  flags = new Uint8Array(capacity);
  versions = new Uint32Array(capacity);
  invalidationMarks = new Uint32Array(capacity);
  invalidationEpoch = 0;
  observed = new Uint32Array(capacity);
  observers = [];
  dependencies = [];
  dependencyVersions = [];
  values.length = initializers.length = calculations.length = equalities.length = 0;
  cleanups.length = labels.length = keys.length = lifetimeStarts.length = lifetimeStops.length = 0;
  activeObserver = -1;
  tracking = true;
  writesForbidden = batchDepth = 0;
  pendingEffects = [];
  batchValues = undefined;
}

export function debugStats(): { cells: number; pendingEffects: number } {
  return { cells: count, pendingEffects: pendingEffects.length };
}
