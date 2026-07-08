import {
  currentTraceCause,
  resetTraceForTest,
  startTrace,
  traceEmit,
  withTraceCause,
  type Trace,
} from './trace.ts';

export type Lane = number;
export type PassId = number;
export type RootToken = object;

export interface SignalHostListener {
  onRenderStart(container: RootToken, lanes: number): void;
  onRenderEnd(container: RootToken, committed: boolean): void;
  onRootPending(container: RootToken, lanes: number): void;
  onRootCommit(container: RootToken, finishedLanes: number, remainingLanes: number): void;
  onEventEnd(): void;
}

export interface SignalHost {
  /** Negative means deferred; the absolute value is React's lane bit. */
  currentWriteLane(): number;
  renderContext(): null | { container: RootToken; lanes: number };
  runInLane<T>(lane: Lane, fn: () => T): T;
  subscribe(listener: SignalHostListener): () => void;
}

export type AtomOptions<T> = {
  equals?: (a: T, b: T) => boolean;
  effect?: (ctx: { get(): T; set(value: T): void }) => void | (() => void);
  label?: string;
  key?: string;
};

export type ComputedOptions<T> = {
  equals?: (a: T, b: T) => boolean;
  label?: string;
};

type CoreObserver = Computed<any> | ReactiveEffect;
type Source = Atom<any> | Computed<any>;

export interface ReactObserver {
  root: RootToken;
  notify(cause: number): void;
}

type Operation<T> = {
  atom: Atom<T>;
  batch: Batch | null;
  seq: number;
  appliedAt: number;
  update: boolean;
  value: T | ((previous: T) => T);
  cause: number;
};

type Batch = {
  lane: Lane;
  createdAt: number;
  retiredAt: number;
  roots: Set<RootToken>;
  committedRoots: Set<RootToken>;
  operations: Operation<any>[];
  cause: number;
};

type World = {
  pin: number;
  lanes: number;
  pass: PassId;
  deferred: boolean;
};

type Pass = {
  id: PassId;
  world: World;
  computeds: Set<Computed<any>> | null;
};

type AsyncRecord = {
  thenable: PromiseLike<unknown>;
  status: 0 | 1 | 2;
  value?: unknown;
  error?: { error: unknown };
  cause: number;
  users: Set<WeakRef<Computed<any>>>;
};

type Evaluation<T> = {
  status: 0 | 1 | 2;
  settled: boolean;
  value: T | undefined;
  thenable?: PromiseLike<unknown>;
  error?: { error: unknown };
  atoms: Atom<any>[];
  pending: AsyncRecord[];
  direct?: AsyncRecord;
};

type EvaluationFrame = {
  computed: Computed<any>;
  atoms: Atom<any>[];
  pending: AsyncRecord[];
  error?: { error: unknown };
};

export class Atom<T> {
  readonly kind = 0;
  readonly equals: (a: T, b: T) => boolean;
  readonly label?: string;
  readonly key?: string;
  readonly observation?: AtomOptions<T>['effect'];
  initialized = false;
  initializer: (() => T) | null;
  base!: T;
  version = 0;
  applied: Operation<T>[] | null = null;
  pending: Operation<T>[] | null = null;
  readonly observers = new Set<CoreObserver>();
  readonly reactObservers = new Set<ReactObserver>();
  observationCleanup: (() => void) | null = null;

  constructor(initial: T | (() => T), options: AtomOptions<T> = {}) {
    this.equals = options.equals ?? Object.is;
    this.label = options.label;
    this.key = options.key;
    this.observation = options.effect;
    this.initializer = typeof initial === 'function' ? (initial as () => T) : null;
    if (this.initializer === null) {
      this.base = initial as T;
      this.initialized = true;
    }
  }

  get state(): T {
    return read(this);
  }

  set(value: T): void {
    writeAtom(this, false, value);
  }

  update(fn: (previous: T) => T): void {
    writeAtom(this, true, fn);
  }
}

export class Computed<T> {
  readonly kind = 1;
  readonly fn: (use: <U>(thenable: PromiseLike<U>) => U) => T;
  readonly equals: (a: T, b: T) => boolean;
  readonly label?: string;
  version = 0;
  dirty = true;
  queued = false;
  evaluating = false;
  initialized = false;
  settled = false;
  status: 0 | 1 | 2 = 0;
  value: T | undefined;
  thenable?: PromiseLike<unknown>;
  error?: { error: unknown };
  readonly sources: Source[] = [];
  readonly sourceVersions: number[] = [];
  readonly sourceValues: unknown[] = [];
  readonly nextSources: Source[] = [];
  readonly nextSourceVersions: number[] = [];
  readonly nextSourceValues: unknown[] = [];
  readonly observers = new Set<CoreObserver>();
  readonly reactObservers = new Set<ReactObserver>();
  evaluation: Evaluation<T> | null = null;
  worldCache: Map<PassId, Evaluation<T>> | null = null;
  latestRevision = -1;
  latestEvaluation: Evaluation<T> | null = null;
  lastWorldPin = -1;
  lastWorldLanes = 0;
  lastWorldEvaluation: Evaluation<T> | null = null;
  readonly asyncLanes = new Map<AsyncRecord, number>();
  cause: number | undefined;

  constructor(
    fn: ((use: <U>(thenable: PromiseLike<U>) => U) => T) | (() => T),
    options: ComputedOptions<T> = {},
  ) {
    this.fn = fn;
    this.equals = options.equals ?? Object.is;
    this.label = options.label;
  }

  get state(): T {
    return read(this);
  }
}

type ReactiveEffect = {
  kind: 2;
  fn: () => void | (() => void);
  cleanup: (() => void) | null;
  sources: Source[];
  sourceVersions: number[];
  sourceValues: unknown[];
  nextSources: Source[];
  nextSourceVersions: number[];
  nextSourceValues: unknown[];
  children: ReactiveEffect[];
  parent: ReactiveEffect | null;
  scope: EffectScope | null;
  active: boolean;
  queued: boolean;
  cause: number | undefined;
};

type EffectScope = {
  effects: ReactiveEffect[];
  active: boolean;
};

type ReadCollector = {
  atoms: Atom<any>[];
  computeds: Computed<any>[];
};

let host: SignalHost | null = null;
let detachHost: (() => void) | null = null;
let sequence = 0;
let worldRevision = 0;
let nextPassId = 1;
let activePassCount = 0;
let liveLanes = 0;
let batchDepth = 0;
let flushing = false;
let initializerDepth = 0;
let activeWorld: World | null = null;
let activeObserver: CoreObserver | null = null;
let activeFrame: EvaluationFrame | null = null;
let activeCollector: ReadCollector | null = null;
let activeEffect: ReactiveEffect | null = null;
let activeScope: EffectScope | null = null;
let dirtyIndex = 0;
let effectIndex = 0;
const dirtyComputeds: Computed<any>[] = [];
const pendingEffects: ReactiveEffect[] = [];
const batches = new Map<Lane, Batch>();
const episodeBatches: Batch[] = [];
const touchedAtoms = new Set<Atom<any>>();
let passes = new WeakMap<RootToken, Pass>();
let rootViews = new WeakMap<RootToken, number>();
const lifetimeQueue = new Set<Atom<any>>();
const thenableRecords = new WeakMap<object, AsyncRecord>();
let lifetimeScheduled = false;

const disposalRegistry = new FinalizationRegistry<() => void>((dispose) => dispose());

export function atom<T>(initial: T | (() => T), options?: AtomOptions<T>): Atom<T> {
  return new Atom(initial, options);
}

export function computed<T>(
  fn: ((use: <U>(thenable: PromiseLike<U>) => U) => T) | (() => T),
  options?: ComputedOptions<T>,
): Computed<T> {
  return new Computed(fn, options);
}

const canonicalWorld: World = { pin: 0, lanes: 0, pass: 0, deferred: false };

export function attachHost(nextHost: SignalHost): () => void {
  if (detachHost !== null) detachHost();
  host = nextHost;
  detachHost = nextHost.subscribe(hostListener);
  return () => {
    if (host !== nextHost) return;
    if (detachHost !== null) detachHost();
    detachHost = null;
    host = null;
  };
}

function currentWorld(): World {
  if (activeWorld !== null) return activeWorld;
  const context = host?.renderContext();
  if (context !== null && context !== undefined) {
    let pass = passes.get(context.container);
    if (pass === undefined) {
      const lanes = context.lanes | (rootViews.get(context.container) ?? 0);
      pass = {
        id: nextPassId++,
        world: {
          pin: sequence,
          lanes,
          pass: nextPassId - 1,
          deferred: (lanes & liveLanes) !== 0,
        },
        computeds: null,
      };
      passes.set(context.container, pass);
      activePassCount++;
    }
    return pass.world;
  }
  canonicalWorld.pin = sequence;
  return canonicalWorld;
}

function materialize<T>(target: Atom<T>): void {
  if (target.initialized) return;
  const initializer = target.initializer;
  if (initializer === null) throw new Error('Atom has no initial value.');
  if (initializerDepth !== 0) {
    throw new Error(`Cyclic lazy initializer${target.label ? ` for ${target.label}` : ''}.`);
  }
  const previousObserver = activeObserver;
  const previousCollector = activeCollector;
  initializerDepth++;
  activeObserver = null;
  activeCollector = null;
  try {
    target.base = initializer();
    target.initialized = true;
    target.initializer = null;
  } finally {
    activeObserver = previousObserver;
    activeCollector = previousCollector;
    initializerDepth--;
  }
}

function applyOperation<T>(operation: Operation<T>, value: T): T {
  return operation.update
    ? (operation.value as (previous: T) => T)(value)
    : (operation.value as T);
}

function readAtomInWorld<T>(target: Atom<T>, world: World): T {
  materialize(target);
  let value = target.base;
  const applied = target.applied;
  if (applied !== null) {
    for (const operation of applied) {
      if (operation.appliedAt <= world.pin) value = applyOperation(operation, value);
    }
  }
  const pending = target.pending;
  if (pending !== null && world.lanes !== 0) {
    for (const operation of pending) {
      const batch = operation.batch as Batch;
      if (
        operation.seq <= world.pin &&
        (batch.retiredAt === 0 || batch.retiredAt > world.pin) &&
        (world.lanes & batch.lane) !== 0
      ) {
        value = applyOperation(operation, value);
      }
    }
  }
  return value;
}

function collectAtom(target: Atom<any>): void {
  const frame = activeFrame;
  if (frame !== null && !frame.atoms.includes(target)) frame.atoms.push(target);
  const collector = activeCollector;
  if (collector !== null && !collector.atoms.includes(target)) collector.atoms.push(target);
}

function trackSource(source: Source): void {
  const observer = activeObserver;
  if (observer === null) return;
  const next = observer.nextSources;
  if (next.includes(source)) return;
  next.push(source);
  canonicalWorld.pin = sequence;
  observer.nextSourceVersions.push(source.version);
  observer.nextSourceValues.push(
    source.kind === 0 ? readAtomInWorld(source, canonicalWorld) : source.value,
  );
}

export function read<T>(target: Atom<T> | Computed<T>): T {
  if (target.kind === 0) {
    collectAtom(target);
    const value = readAtomInWorld(target, currentWorld());
    trackSource(target);
    return value;
  }
  const collector = activeCollector;
  if (collector !== null && !collector.computeds.includes(target)) {
    collector.computeds.push(target);
  }
  const world = currentWorld();
  const evaluation =
    world.pass === 0 && world.lanes === 0
      ? evaluateCanonical(target)
      : evaluateInWorld(target, world);
  mergeEvaluation(evaluation as Evaluation<unknown>);
  trackSource(target);
  if (activeFrame !== null && activeFrame.computed !== target) {
    return evaluation.value as T;
  }
  if (evaluation.status === 2) throw evaluation.error?.error;
  if (evaluation.status === 1) {
    if (!evaluation.settled || world.deferred) throw evaluation.thenable;
  }
  return evaluation.value as T;
}

function getOrCreateBatch(lane: Lane, createdAt: number, cause: number): Batch {
  let batch = batches.get(lane);
  if (batch !== undefined) return batch;
  batch = {
    lane,
    createdAt,
    retiredAt: 0,
    roots: new Set(),
    committedRoots: new Set(),
    operations: [],
    cause,
  };
  batches.set(lane, batch);
  episodeBatches.push(batch);
  liveLanes |= lane;
  traceEmit('batch open', { cause, batch: lane });
  return batch;
}

function writeAtom<T>(target: Atom<T>, update: boolean, input: T | ((previous: T) => T)): void {
  if (initializerDepth !== 0) throw new Error('A lazy initializer must not write signals.');
  if (host?.renderContext() != null) throw new Error('Signals must not be written during render.');
  materialize(target);

  const classification = host?.currentWriteLane() ?? 0;
  const deferred = classification < 0;
  const lane = deferred ? -classification : 0;
  const writerWorld: World = {
    pin: sequence,
    lanes: lane,
    pass: -1,
    deferred,
  };
  const previous = readAtomInWorld(target, writerWorld);
  if (!update && target.equals(previous, input as T)) return;

  if (!deferred && activePassCount === 0 && batches.size === 0) {
    const next = update ? (input as (value: T) => T)(previous) : (input as T);
    if (target.equals(previous, next)) return;
    const cause = traceEmit('write', { label: target.label, detail: 'urgent' });
    sequence++;
    worldRevision++;
    target.base = next;
    target.version++;
    invalidateAtom(target, cause);
    deliverAtom(target, 0, cause);
    flushIfReady();
    return;
  }

  const seq = ++sequence;
  worldRevision++;
  const cause = traceEmit('write', {
    batch: deferred ? lane : undefined,
    label: target.label,
    detail: deferred ? 'deferred' : 'urgent',
  });
  const batch = deferred ? getOrCreateBatch(lane, seq, cause) : null;
  const operation: Operation<T> = {
    atom: target,
    batch,
    seq,
    appliedAt: deferred ? 0 : seq,
    update,
    value: input,
    cause,
  };
  touchedAtoms.add(target);
  if (deferred) {
    (target.pending ??= []).push(operation);
    batch?.operations.push(operation);
    deliverAtom(target, lane, cause);
  } else {
    (target.applied ??= []).push(operation);
    target.version++;
    invalidateAtom(target, cause);
    deliverAtom(target, 0, cause);
  }
  flushIfReady();
}

export function set<T>(target: Atom<T>, value: T): void {
  target.set(value);
}

export function update<T>(target: Atom<T>, fn: (previous: T) => T): void {
  target.update(fn);
}

function mergeEvaluation(evaluation: Evaluation<unknown>): void {
  const frame = activeFrame;
  if (frame !== null) {
    for (const atom of evaluation.atoms) {
      if (!frame.atoms.includes(atom)) frame.atoms.push(atom);
    }
    for (const pending of evaluation.pending) {
      if (!frame.pending.includes(pending)) frame.pending.push(pending);
    }
    if (frame.error === undefined && evaluation.error !== undefined) {
      frame.error = evaluation.error;
    }
  }
  const collector = activeCollector;
  if (collector !== null) {
    for (const atom of evaluation.atoms) {
      if (!collector.atoms.includes(atom)) collector.atoms.push(atom);
    }
  }
}

function asyncRecord(thenable: PromiseLike<unknown>, cause: number): AsyncRecord {
  const key = thenable as object;
  let record = thenableRecords.get(key);
  if (record !== undefined) return record;
  record = {
    thenable,
    status: 0,
    cause,
    users: new Set(),
  };
  thenableRecords.set(key, record);
  thenable.then(
    (value) => settleAsync(record as AsyncRecord, 1, value),
    (error) => settleAsync(record as AsyncRecord, 2, error),
  );
  return record;
}

function settleAsync(record: AsyncRecord, status: 1 | 2, value: unknown): void {
  if (record.status !== 0) return;
  record.status = status;
  if (status === 1) record.value = value;
  else record.error = { error: value };
  worldRevision++;
  const settlement = traceEmit('suspense settlement', {
    cause: record.cause || undefined,
    detail: status === 1 ? 'fulfilled' : 'rejected',
  });
  for (const reference of record.users) {
    const target = reference.deref();
    if (target === undefined) continue;
    const lanes = target.asyncLanes.get(record) ?? 0;
    target.asyncLanes.delete(record);
    let resolvedDirect = false;
    const canonical = target.evaluation;
    if (canonical?.direct === record) {
      canonical.status = status === 1 ? 0 : 2;
      canonical.settled = status === 1;
      canonical.value = status === 1 ? value : target.value;
      canonical.error = status === 2 ? record.error : undefined;
      canonical.thenable = undefined;
      target.status = canonical.status;
      target.error = canonical.error;
      target.thenable = undefined;
      if (status === 1) {
        target.value = value;
        target.settled = true;
      }
      target.version++;
      resolvedDirect = true;
      propagateComputed(target, settlement);
    }
    const last = target.lastWorldEvaluation;
    if (last?.pending.includes(record)) {
      if (last.direct === record) {
        last.status = status === 1 ? 0 : 2;
        last.settled = status === 1;
        last.value = status === 1 ? value : target.value;
        last.error = status === 2 ? record.error : undefined;
        last.thenable = undefined;
      } else {
        target.lastWorldEvaluation = null;
      }
    }
    if (target.latestEvaluation?.pending.includes(record)) {
      target.latestRevision = -1;
    }
    if (lanes === 0) {
      if (!resolvedDirect) markComputedDirty(target, settlement);
      deliverComputed(target, 0, settlement);
    } else {
      let remaining = lanes;
      while (remaining !== 0) {
        const lane = remaining & -remaining;
        deliverComputed(target, lane, settlement);
        remaining &= ~lane;
      }
    }
  }
  record.users.clear();
  flushIfReady();
}

function consumeThenable<U>(
  target: Computed<any>,
  frame: EvaluationFrame,
  world: World,
  thenable: PromiseLike<U>,
): U {
  const record = asyncRecord(thenable, target.cause ?? currentTraceCause() ?? 0);
  if (record.status === 1) return record.value as U;
  if (record.status === 2) {
    frame.error ??= record.error;
    return undefined as U;
  }
  if (!frame.pending.includes(record)) frame.pending.push(record);
  record.users.add(new WeakRef(target));
  const ownerLanes = world.lanes & liveLanes;
  target.asyncLanes.set(record, (target.asyncLanes.get(record) ?? 0) | ownerLanes);
  return undefined as U;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function runEvaluation<T>(target: Computed<T>, world: World, canonical: boolean): Evaluation<T> {
  if (target.evaluating) {
    throw new Error(`Cyclic computed${target.label ? ` ${target.label}` : ''}.`);
  }
  const frame: EvaluationFrame = { computed: target, atoms: [], pending: [] };
  const previousFrame = activeFrame;
  const previousWorld = activeWorld;
  const previousObserver = activeObserver;
  target.evaluating = true;
  target.nextSources.length = 0;
  target.nextSourceVersions.length = 0;
  target.nextSourceValues.length = 0;
  activeFrame = frame;
  activeWorld = world;
  activeObserver = canonical ? target : null;
  let value: T | undefined;
  let direct: AsyncRecord | undefined;
  let syncError: { error: unknown } | undefined;
  try {
    value = target.fn(<U>(thenable: PromiseLike<U>) => consumeThenable(target, frame, world, thenable));
    if (isThenable(value)) {
      direct = asyncRecord(value, target.cause ?? currentTraceCause() ?? 0);
      value = consumeThenable(target, frame, world, value) as T;
    }
  } catch (error) {
    syncError = { error };
  } finally {
    activeObserver = previousObserver;
    activeWorld = previousWorld;
    activeFrame = previousFrame;
    target.evaluating = false;
  }

  const error = syncError ?? frame.error;
  const status: 0 | 1 | 2 = error !== undefined ? 2 : frame.pending.length !== 0 ? 1 : 0;
  let thenable: PromiseLike<unknown> | undefined;
  if (status === 1) {
    if (frame.pending.length === 1) {
      thenable = frame.pending[0].thenable;
    } else {
      const thenables: PromiseLike<unknown>[] = [];
      for (const pending of frame.pending) thenables.push(pending.thenable);
      thenable = Promise.all(thenables);
    }
  }
  const evaluation: Evaluation<T> = {
    status,
    settled: target.settled,
    value: status === 0 ? value : target.settled ? target.value : undefined,
    thenable,
    error,
    atoms: frame.atoms,
    pending: frame.pending,
    direct,
  };

  if (!canonical) return evaluation;
  const oldStatus = target.status;
  const oldValue = target.value;
  const oldSettled = target.settled;
  reconcileSources(target, target.nextSources);
  target.initialized = true;
  target.dirty = false;
  target.status = status;
  target.thenable = thenable;
  target.error = error;
  if (status === 0) {
    target.value = value;
    target.settled = true;
    evaluation.settled = true;
  }
  if (
    oldStatus !== status ||
    oldSettled !== target.settled ||
    (status === 0 && oldSettled && !target.equals(oldValue as T, value as T))
  ) {
    target.version++;
  }
  for (let i = 0; i < target.sources.length; i++) {
    if (target.sources[i].version !== target.sourceVersions[i]) {
      target.dirty = true;
      if (target.observers.size !== 0 && !target.queued) {
        target.queued = true;
        dirtyComputeds.push(target as Computed<any>);
      }
      break;
    }
  }
  target.evaluation = evaluation;
  return evaluation;
}

function evaluateCanonical<T>(target: Computed<T>): Evaluation<T> {
  if (!target.dirty && target.initialized) {
    for (let i = 0; i < target.sources.length; i++) {
      const source = target.sources[i];
      if (source.kind === 1) evaluateCanonical(source);
      if (source.version !== target.sourceVersions[i]) {
        target.dirty = true;
        break;
      }
    }
  }
  if (target.dirty && target.initialized) {
    let changed = false;
    for (let i = 0; i < target.sources.length; i++) {
      const source = target.sources[i];
      if (source.kind === 1) evaluateCanonical(source);
      if (source.version === target.sourceVersions[i]) continue;
      if (source.kind === 0) {
        const value = readAtomInWorld(source, canonicalWorld);
        if (source.equals(target.sourceValues[i], value)) {
          target.sourceVersions[i] = source.version;
          target.sourceValues[i] = value;
          continue;
        }
      }
      changed = true;
      break;
    }
    if (!changed) target.dirty = false;
  }
  if (!target.dirty && target.evaluation !== null) return target.evaluation;
  canonicalWorld.pin = sequence;
  return runEvaluation(target, canonicalWorld, true);
}

function evaluateInWorld<T>(target: Computed<T>, world: World): Evaluation<T> {
  if (world.pass > 0) {
    const cached = target.worldCache?.get(world.pass);
    if (cached !== undefined) return cached;
  } else if (world.pass === -2 && target.latestRevision === worldRevision) {
    return target.latestEvaluation as Evaluation<T>;
  }
  if (
    target.lastWorldEvaluation !== null &&
    target.lastWorldPin === world.pin &&
    target.lastWorldLanes === world.lanes
  ) {
    return target.lastWorldEvaluation;
  }
  const evaluation = runEvaluation(target, world, false);
  target.lastWorldPin = world.pin;
  target.lastWorldLanes = world.lanes;
  target.lastWorldEvaluation = evaluation;
  if (world.pass > 0) {
    (target.worldCache ??= new Map()).set(world.pass, evaluation);
    const context = host?.renderContext();
    if (context !== null && context !== undefined) {
      const pass = passes.get(context.container);
      if (pass !== undefined) (pass.computeds ??= new Set()).add(target);
    }
  } else if (world.pass === -2) {
    target.latestRevision = worldRevision;
    target.latestEvaluation = evaluation;
  }
  return evaluation;
}

function atomObserverCount(target: Atom<any>): number {
  return target.observers.size + target.reactObservers.size;
}

function queueLifetime(target: Atom<any>): void {
  if (target.observation === undefined) return;
  lifetimeQueue.add(target);
  if (lifetimeScheduled) return;
  lifetimeScheduled = true;
  queueMicrotask(() => {
    lifetimeScheduled = false;
    for (const atom of lifetimeQueue) {
      if (atomObserverCount(atom) !== 0) {
        if (atom.observationCleanup === null) {
          const previousObserver = activeObserver;
          activeObserver = null;
          try {
            atom.observationCleanup =
              atom.observation?.({
                get: () => readAtomInWorld(atom, canonicalWorld),
                set: (value) => atom.set(value),
              }) ?? null;
          } finally {
            activeObserver = previousObserver;
          }
        }
      } else if (atom.observationCleanup !== null) {
        const cleanup = atom.observationCleanup;
        atom.observationCleanup = null;
        cleanup();
      }
    }
    lifetimeQueue.clear();
  });
}

function addCoreObserver(source: Source, observer: CoreObserver): void {
  if (source.observers.has(observer)) return;
  const wasEmpty = source.observers.size === 0;
  const atomWasUnobserved = source.kind === 0 && atomObserverCount(source) === 0;
  source.observers.add(observer);
  if (source.kind === 0) {
    if (atomWasUnobserved) queueLifetime(source);
  } else if (wasEmpty) {
    for (const dependency of source.sources) addCoreObserver(dependency, source);
  }
}

function removeCoreObserver(source: Source, observer: CoreObserver): void {
  if (!source.observers.delete(observer)) return;
  if (source.kind === 0) {
    if (atomObserverCount(source) === 0) queueLifetime(source);
  } else if (source.observers.size === 0) {
    for (const dependency of source.sources) {
      removeCoreObserver(dependency, source);
    }
  }
}

function reconcileSources(
  observer: Computed<any> | ReactiveEffect,
  nextSources: Source[],
): void {
  const previous = observer.sources;
  for (const source of previous) {
    if (!nextSources.includes(source)) removeCoreObserver(source, observer);
  }
  const shouldObserve = observer.kind === 2 || observer.observers.size !== 0;
  for (const source of nextSources) {
    if (!previous.includes(source) && shouldObserve) addCoreObserver(source, observer);
  }
  previous.length = 0;
  for (const source of nextSources) previous.push(source);
  observer.sourceVersions.length = 0;
  observer.sourceValues.length = 0;
  for (let i = 0; i < nextSources.length; i++) {
    observer.sourceVersions.push(observer.nextSourceVersions[i]);
    observer.sourceValues.push(observer.nextSourceValues[i]);
  }
}

function effectSourcesChanged(target: ReactiveEffect): boolean {
  canonicalWorld.pin = sequence;
  for (let i = 0; i < target.sources.length; i++) {
    const source = target.sources[i];
    if (source.kind === 1) evaluateCanonical(source);
    if (source.version === target.sourceVersions[i]) continue;
    if (source.kind === 0) {
      const value = readAtomInWorld(source, canonicalWorld);
      if (source.equals(target.sourceValues[i], value)) {
        target.sourceVersions[i] = source.version;
        target.sourceValues[i] = value;
        continue;
      }
    }
    return true;
  }
  return false;
}

function markComputedDirty(target: Computed<any>, cause: number): void {
  target.cause = cause || target.cause;
  if (target.dirty) return;
  target.dirty = true;
  if (target.observers.size !== 0 && !target.queued) {
    target.queued = true;
    dirtyComputeds.push(target);
  }
}

function queueEffect(target: ReactiveEffect, cause: number): void {
  if (!target.active) return;
  target.cause = cause || target.cause;
  if (target.queued) return;
  target.queued = true;
  pendingEffects.push(target);
}

function invalidateAtom(target: Atom<any>, cause: number): void {
  for (const observer of target.observers) {
    if (observer.kind === 1) markComputedDirty(observer, cause);
    else queueEffect(observer, cause);
  }
}

function propagateComputed(target: Computed<any>, cause: number): void {
  for (const observer of target.observers) {
    if (observer.kind === 1) markComputedDirty(observer, cause);
    else queueEffect(observer, cause);
  }
}

function runEffect(target: ReactiveEffect): void {
  if (!target.active) return;
  for (const child of target.children) disposeEffect(child);
  target.children.length = 0;
  if (target.cleanup !== null) {
    const cleanup = target.cleanup;
    target.cleanup = null;
    try {
      untracked(cleanup);
    } catch (error) {
      disposeEffect(target);
      throw error;
    }
  }
  target.nextSources.length = 0;
  target.nextSourceVersions.length = 0;
  target.nextSourceValues.length = 0;
  const previousObserver = activeObserver;
  const previousEffect = activeEffect;
  const previousScope = activeScope;
  activeObserver = target;
  activeEffect = target;
  activeScope = target.scope;
  const event = traceEmit('effect run', { cause: target.cause });
  try {
    target.cleanup = withTraceCause(event || target.cause, target.fn) ?? null;
  } finally {
    activeObserver = previousObserver;
    activeEffect = previousEffect;
    activeScope = previousScope;
    reconcileSources(target, target.nextSources);
  }
}

function flushIfReady(): void {
  if (batchDepth !== 0 || flushing) return;
  flushing = true;
  try {
    while (dirtyIndex < dirtyComputeds.length || effectIndex < pendingEffects.length) {
      while (dirtyIndex < dirtyComputeds.length) {
        const target = dirtyComputeds[dirtyIndex++];
        target.queued = false;
        if (target.observers.size === 0 || !target.dirty) continue;
        const previousVersion = target.version;
        evaluateCanonical(target);
        if (target.version !== previousVersion) {
          propagateComputed(target, target.cause ?? 0);
        }
      }
      if (effectIndex < pendingEffects.length) {
        const target = pendingEffects[effectIndex++];
        target.queued = false;
        if (effectSourcesChanged(target)) runEffect(target);
      }
    }
  } finally {
    dirtyComputeds.length = 0;
    pendingEffects.length = 0;
    dirtyIndex = 0;
    effectIndex = 0;
    flushing = false;
  }
}

function deliverAtom(target: Atom<any>, lane: Lane, cause: number): void {
  const batch = lane === 0 ? undefined : batches.get(lane);
  for (const observer of target.reactObservers) {
    if (batch !== undefined) batch.roots.add(observer.root);
    const delivery = traceEmit('component delivery', {
      cause,
      target,
      batch: lane || undefined,
      label: target.label,
    });
    if (lane === 0 || host === null) observer.notify(delivery || cause);
    else host.runInLane(lane, () => observer.notify(delivery || cause));
  }
}

function deliverComputed(target: Computed<any>, lane: Lane, cause: number): void {
  const batch = lane === 0 ? undefined : batches.get(lane);
  for (const observer of target.reactObservers) {
    if (batch !== undefined) batch.roots.add(observer.root);
    const delivery = traceEmit('component delivery', {
      cause,
      target,
      batch: lane || undefined,
      label: target.label,
    });
    if (lane === 0 || host === null) observer.notify(delivery || cause);
    else host.runInLane(lane, () => observer.notify(delivery || cause));
  }
}

export function effect(fn: () => void | (() => void)): () => void {
  const target: ReactiveEffect = {
    kind: 2,
    fn,
    cleanup: null,
    sources: [],
    sourceVersions: [],
    sourceValues: [],
    nextSources: [],
    nextSourceVersions: [],
    nextSourceValues: [],
    children: [],
    parent: activeEffect,
    scope: activeScope,
    active: true,
    queued: false,
    cause: currentTraceCause(),
  };
  if (activeEffect !== null) activeEffect.children.push(target);
  if (activeScope !== null) activeScope.effects.push(target);
  runEffect(target);
  const dispose = () => {
    disposalRegistry.unregister(dispose);
    disposeEffect(target);
  };
  disposalRegistry.register(dispose, () => disposeEffect(target), dispose);
  return dispose;
}

function disposeEffect(target: ReactiveEffect): void {
  if (!target.active) return;
  target.active = false;
  for (const child of target.children) disposeEffect(child);
  target.children.length = 0;
  for (const source of target.sources) removeCoreObserver(source, target);
  target.sources.length = 0;
  if (target.cleanup !== null) {
    const cleanup = target.cleanup;
    target.cleanup = null;
    untracked(cleanup);
  }
}

export function effectScope(fn: () => void): () => void {
  const scope: EffectScope = { effects: [], active: true };
  const previous = activeScope;
  activeScope = scope;
  try {
    fn();
  } finally {
    activeScope = previous;
  }
  return () => {
    if (!scope.active) return;
    scope.active = false;
    for (const target of scope.effects) disposeEffect(target);
    scope.effects.length = 0;
  };
}

export function startBatch(): void {
  batchDepth++;
}

export function endBatch(): void {
  if (batchDepth === 0) throw new Error('endBatch called without startBatch.');
  batchDepth--;
  flushIfReady();
}

export function batch<T>(fn: () => T): T {
  startBatch();
  try {
    return fn();
  } finally {
    endBatch();
  }
}

export function untracked<T>(fn: () => T): T {
  const previousObserver = activeObserver;
  const previousCollector = activeCollector;
  const previousFrame = activeFrame;
  activeObserver = null;
  activeCollector = null;
  activeFrame = null;
  try {
    return fn();
  } finally {
    activeObserver = previousObserver;
    activeCollector = previousCollector;
    activeFrame = previousFrame;
  }
}

export type ReactRead<T> = {
  target: Atom<T> | Computed<T>;
  value: T;
  atoms: Atom<any>[];
  computeds: Computed<any>[];
  versions: number[];
  lanes: number;
  cause?: number;
};

export function collectReactRead<T>(target: Atom<T> | Computed<T>, cause?: number): ReactRead<T> {
  const collector: ReadCollector = { atoms: [], computeds: [] };
  const previous = activeCollector;
  activeCollector = collector;
  try {
    const value = withTraceCause(cause, () => read(target));
    const versions: number[] = [];
    for (const atom of collector.atoms) versions.push(atom.version);
    traceEmit('component re-render', {
      cause,
      target,
      label: target.label,
    });
    return {
      target,
      value,
      atoms: collector.atoms,
      computeds: collector.computeds,
      versions,
      lanes: currentWorld().lanes,
      cause,
    };
  } finally {
    activeCollector = previous;
  }
}

export function subscribeReact(snapshot: ReactRead<unknown>, observer: ReactObserver): () => void {
  for (const atom of snapshot.atoms) {
    const wasUnobserved = atomObserverCount(atom) === 0;
    atom.reactObservers.add(observer);
    if (wasUnobserved) queueLifetime(atom);
  }
  for (const computed of snapshot.computeds) computed.reactObservers.add(observer);

  let staleCause = 0;
  for (let i = 0; i < snapshot.atoms.length; i++) {
    if (snapshot.atoms[i].version !== snapshot.versions[i]) {
      staleCause = traceEmit('component delivery', {
        target: snapshot.target,
        detail: 'post-subscribe canonical repair',
      });
      observer.notify(staleCause);
      break;
    }
  }
  for (const batch of batches.values()) {
    if (batch.committedRoots.has(observer.root)) continue;
    let touched = false;
    for (const operation of batch.operations) {
      if (snapshot.atoms.includes(operation.atom)) {
        touched = true;
        break;
      }
    }
    if (!touched) continue;
    batch.roots.add(observer.root);
    const delivery = traceEmit('component delivery', {
      cause: batch.cause,
      target: snapshot.target,
      batch: batch.lane,
      detail: 'commit-boundary repair',
    });
    if (host === null) observer.notify(delivery || batch.cause);
    else host.runInLane(batch.lane, () => observer.notify(delivery || batch.cause));
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const atom of snapshot.atoms) {
      atom.reactObservers.delete(observer);
      if (atomObserverCount(atom) === 0) queueLifetime(atom);
    }
    for (const computed of snapshot.computeds) computed.reactObservers.delete(observer);
  };
}

function readInWorldWithoutTracking<T>(target: Atom<T> | Computed<T>, world: World): T | undefined {
  const previousObserver = activeObserver;
  const previousCollector = activeCollector;
  const previousFrame = activeFrame;
  const previousWorld = activeWorld;
  activeObserver = null;
  activeCollector = null;
  activeFrame = null;
  activeWorld = world;
  try {
    if (target.kind === 0) return readAtomInWorld(target, world);
    const evaluation =
      world.pass === 0 && world.lanes === 0
        ? evaluateCanonical(target)
        : evaluateInWorld(target, world);
    if (evaluation.status === 2) throw evaluation.error?.error;
    return evaluation.value;
  } finally {
    activeObserver = previousObserver;
    activeCollector = previousCollector;
    activeFrame = previousFrame;
    activeWorld = previousWorld;
  }
}

export function latest<T>(target: Atom<T> | Computed<T>): T {
  if (activeWorld !== null || host?.renderContext() != null) return read(target);
  return readInWorldWithoutTracking(target, {
    pin: sequence,
    lanes: liveLanes,
    pass: -2,
    deferred: false,
  }) as T;
}

export function committed<T>(target: Atom<T> | Computed<T>, container?: RootToken): T {
  const lanes = container === undefined ? 0 : (rootViews.get(container) ?? 0);
  return readInWorldWithoutTracking(target, {
    pin: sequence,
    lanes,
    pass: -3,
    deferred: false,
  }) as T;
}

export function isPending(target: Atom<any> | Computed<any>): boolean {
  if (target.kind === 0 || !target.settled) return false;
  const context = host?.renderContext();
  if (context !== null && context !== undefined) {
    const pass = passes.get(context.container);
    const evaluation = pass === undefined ? undefined : target.worldCache?.get(pass.id);
    if (evaluation !== undefined) return evaluation.status === 1;
  }
  if (target.latestRevision === worldRevision && target.latestEvaluation !== null) {
    return target.latestEvaluation.status === 1;
  }
  return target.status === 1;
}

export function refresh(target: Computed<any>): void {
  const classification = host?.currentWriteLane() ?? 0;
  const lane = classification < 0 ? -classification : 0;
  worldRevision++;
  const cause = traceEmit('write', {
    batch: lane || undefined,
    label: target.label,
    detail: 'refresh',
  });
  target.latestRevision = -1;
  target.worldCache?.clear();
  target.lastWorldEvaluation = null;
  if (lane === 0) {
    markComputedDirty(target, cause);
    deliverComputed(target, 0, cause);
  } else {
    getOrCreateBatch(lane, ++sequence, cause);
    deliverComputed(target, lane, cause);
  }
  flushIfReady();
}

function clearPass(container: RootToken, committedPass: boolean): void {
  const pass = passes.get(container);
  if (pass === undefined) return;
  passes.delete(container);
  activePassCount--;
  if (pass.computeds !== null) {
    for (const target of pass.computeds) target.worldCache?.delete(pass.id);
  }
  traceEmit('render pass end', {
    batch: pass.world.lanes & liveLanes || undefined,
    detail: committedPass ? 'commit' : 'discard',
  });
  sweepIfQuiescent();
}

function retireBatch(batch: Batch, committedBatch: boolean, cause?: number): void {
  if (batch.retiredAt !== 0) return;
  const retirement = ++sequence;
  worldRevision++;
  batch.retiredAt = retirement;
  batches.delete(batch.lane);
  liveLanes &= ~batch.lane;
  const changed: Atom<any>[] = [];
  for (const operation of batch.operations) {
    operation.appliedAt = retirement;
    const atom = operation.atom;
    (atom.applied ??= []).push(operation);
    if (!changed.includes(atom)) changed.push(atom);
  }
  for (const root of batch.committedRoots) {
    rootViews.set(root, (rootViews.get(root) ?? 0) & ~batch.lane);
  }
  const retirementCause = traceEmit('batch retire', {
    cause: cause ?? batch.cause,
    batch: batch.lane,
    detail: committedBatch ? 'committed' : 'external-only',
  });
  for (const atom of changed) {
    atom.version++;
    invalidateAtom(atom, retirementCause || batch.cause);
  }
  flushIfReady();
  sweepIfQuiescent();
}

function sweepIfQuiescent(): void {
  if (activePassCount !== 0 || batches.size !== 0) return;
  canonicalWorld.pin = sequence;
  for (const atom of touchedAtoms) {
    atom.base = readAtomInWorld(atom, canonicalWorld);
    atom.applied = null;
    atom.pending = null;
  }
  touchedAtoms.clear();
  episodeBatches.length = 0;
}

const hostListener: SignalHostListener = {
  onRenderStart(container, lanes) {
    if (passes.has(container)) clearPass(container, false);
    const visibleLanes = lanes | (rootViews.get(container) ?? 0);
    const id = nextPassId++;
    passes.set(container, {
      id,
      world: {
        pin: sequence,
        lanes: visibleLanes,
        pass: id,
        deferred: (visibleLanes & liveLanes) !== 0,
      },
      computeds: null,
    });
    activePassCount++;
    for (const batch of batches.values()) {
      if ((lanes & batch.lane) !== 0) batch.roots.add(container);
    }
    traceEmit('render pass start', {
      batch: visibleLanes & liveLanes || undefined,
      detail: `pass ${id}`,
    });
  },
  onRenderEnd(container, committedPass) {
    clearPass(container, committedPass);
  },
  onRootPending(container, lanes) {
    for (const batch of batches.values()) {
      if ((lanes & batch.lane) !== 0) batch.roots.add(container);
    }
  },
  onRootCommit(container, finishedLanes, remainingLanes) {
    let cause: number | undefined;
    for (const batch of batches.values()) {
      if ((finishedLanes & batch.lane) !== 0) {
        batch.committedRoots.add(container);
        rootViews.set(container, (rootViews.get(container) ?? 0) | batch.lane);
        cause = batch.cause;
      }
    }
    const commit = traceEmit('root commit', { cause, detail: String(finishedLanes) });
    const retiring: Batch[] = [];
    for (const batch of batches.values()) {
      if ((remainingLanes & batch.lane) === 0) batch.roots.delete(container);
      if (batch.roots.size === 0) retiring.push(batch);
    }
    for (const batch of retiring) {
      retireBatch(batch, batch.committedRoots.size !== 0, commit || cause);
    }
  },
  onEventEnd() {
    const retiring: Batch[] = [];
    for (const batch of batches.values()) {
      if (batch.roots.size === 0) retiring.push(batch);
    }
    for (const batch of retiring) retireBatch(batch, false);
  },
};

export function installState<T>(target: Atom<T>, value: T): void {
  target.base = value;
  target.initialized = true;
  target.initializer = null;
  target.applied = null;
  target.pending = null;
}

type AtomTable = ReadonlyArray<Atom<any>> | Record<string, Atom<any>>;

function atomEntries(table: AtomTable): Array<[string, Atom<any>]> {
  const entries: Array<[string, Atom<any>]> = [];
  if (Array.isArray(table)) {
    for (let i = 0; i < table.length; i++) {
      const atom = table[i];
      entries.push([atom.key ?? atom.label ?? String(i), atom]);
    }
  } else {
    const keyed = table as Record<string, Atom<any>>;
    for (const key of Object.keys(keyed)) entries.push([key, keyed[key]]);
  }
  return entries;
}

export function serializeAtomState(
  table: AtomTable,
  replacer?: (this: unknown, key: string, value: unknown) => unknown,
): string {
  const state: Record<string, unknown> = {};
  for (const [key, atom] of atomEntries(table)) state[key] = committed(atom);
  return JSON.stringify(state, replacer);
}

export function initializeAtomState(
  json: string,
  table: AtomTable,
  reviver?: (this: unknown, key: string, value: unknown) => unknown,
): void {
  const state = JSON.parse(json, reviver) as Record<string, unknown>;
  for (const [key, atom] of atomEntries(table)) {
    if (Object.prototype.hasOwnProperty.call(state, key)) installState(atom, state[key]);
  }
}

export function debugState(): {
  batches: number;
  passes: number;
  touchedAtoms: number;
  liveLanes: number;
} {
  return {
    batches: batches.size,
    passes: activePassCount,
    touchedAtoms: touchedAtoms.size,
    liveLanes,
  };
}

export function resetForTest(): void {
  for (const batch of batches.values()) batch.retiredAt = ++sequence;
  batches.clear();
  liveLanes = 0;
  activePassCount = 0;
  passes = new WeakMap();
  rootViews = new WeakMap();
  for (const atom of touchedAtoms) {
    atom.applied = null;
    atom.pending = null;
  }
  touchedAtoms.clear();
  episodeBatches.length = 0;
  dirtyComputeds.length = 0;
  pendingEffects.length = 0;
  dirtyIndex = 0;
  effectIndex = 0;
  batchDepth = 0;
  flushing = false;
  activeWorld = null;
  activeObserver = null;
  activeFrame = null;
  activeCollector = null;
  resetTraceForTest();
}

export { startTrace, type Trace };
