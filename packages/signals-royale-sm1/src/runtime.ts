import {
  currentTraceCause,
  resetTraceForTest,
  startTrace,
  traceEmit,
  withTraceCause,
  type Trace,
} from "./trace.ts";

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
  refreshes: Computed<any>[];
  refreshResults: Map<Computed<any>, Evaluation<any>> | null;
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
  traceStart: number;
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
  id: number;
  captureAtoms: boolean;
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
  readonly observation?: AtomOptions<T>["effect"];
  initialized = false;
  initializer: (() => T) | null;
  base!: T;
  version = 0;
  frameMark = 0;
  pendingState = false;
  cause: number | undefined;
  applied: Operation<T>[] | null = null;
  pending: Operation<T>[] | null = null;
  readonly observers = new Set<CoreObserver>();
  readonly reactObservers = new Set<ReactObserver>();
  readonly pendingObservers = new Set<ReactObserver>();
  observationCleanup: (() => void) | null = null;

  constructor(initial: T | (() => T), options: AtomOptions<T> = {}) {
    this.equals = options.equals ?? Object.is;
    this.label = options.label;
    this.key = options.key;
    this.observation = options.effect;
    this.initializer = typeof initial === "function" ? (initial as () => T) : null;
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
  canonicalRevision = -1;
  dirty = true;
  forced = false;
  queued = false;
  evaluating = false;
  initialized = false;
  settled = false;
  worldSettled = false;
  worldValue: T | undefined;
  pendingState = false;
  pendingLanes = 0;
  urgentPending = false;
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
  readonly pendingObservers = new Set<ReactObserver>();
  canonicalFrame: EvaluationFrame | null = null;
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
  handle: WeakRef<() => void> | null;
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
let nextFrameId = 1;
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
const worldComputeds = new Set<Computed<any>>();
let passes = new WeakMap<RootToken, Pass>();
let rootViews = new WeakMap<RootToken, number>();
const lifetimeQueue = new Set<Atom<any>>();
const pendingNotifications = new Set<Atom<any> | Computed<any>>();
const thenableRecords = new WeakMap<object, AsyncRecord>();
let lifetimeScheduled = false;
let pendingNotificationScheduled = false;

const disposalRegistry = new FinalizationRegistry<ReactiveEffect>(disposeEffect);

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
        traceStart: traceEmit("render pass start", { detail: "fallback" }),
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
  if (initializer === null) throw new Error("Atom has no initial value.");
  if (initializerDepth !== 0) {
    throw new Error(`Cyclic lazy initializer${target.label ? ` for ${target.label}` : ""}.`);
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
  return operation.update ? (operation.value as (previous: T) => T)(value) : (operation.value as T);
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
  if (frame !== null && frame.captureAtoms && target.frameMark !== frame.id) {
    target.frameMark = frame.id;
    frame.atoms.push(target);
  }
  const collector = activeCollector;
  if (collector !== null && !collector.atoms.includes(target)) collector.atoms.push(target);
}

function trackSource(source: Source, value: unknown): void {
  const observer = activeObserver;
  if (observer === null) return;
  const next = observer.nextSources;
  if (observer.sources[next.length] !== source && next.includes(source)) return;
  next.push(source);
  observer.nextSourceVersions.push(source.version);
  observer.nextSourceValues.push(value);
}

export function read<T>(target: Atom<T> | Computed<T>): T {
  if (target.kind === 0) {
    collectAtom(target);
    const value = readAtomInWorld(target, currentWorld());
    trackSource(target, value);
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
  if (
    evaluation.status !== 0 ||
    activeCollector !== null ||
    (activeFrame !== null && activeFrame.captureAtoms)
  ) {
    mergeEvaluation(target, evaluation as Evaluation<unknown>);
  }
  trackSource(target, evaluation.value);
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
    refreshes: [],
    refreshResults: null,
    cause,
  };
  batches.set(lane, batch);
  episodeBatches.push(batch);
  liveLanes |= lane;
  traceEmit("batch open", { cause, batch: lane });
  return batch;
}

function writeAtom<T>(target: Atom<T>, update: boolean, input: T | ((previous: T) => T)): void {
  if (initializerDepth !== 0) throw new Error("A lazy initializer must not write signals.");
  if (host?.renderContext() != null) throw new Error("Signals must not be written during render.");
  materialize(target);

  const classification = host?.currentWriteLane() ?? 0;
  const deferred = classification < 0;
  const lane = deferred ? -classification : 0;
  if (!deferred && activePassCount === 0 && batches.size === 0) {
    const previous = target.base;
    const next = update ? (input as (value: T) => T)(previous) : (input as T);
    if (target.equals(previous, next)) return;
    const cause = traceEmit("write", { label: target.label, detail: "urgent" });
    sequence++;
    worldRevision++;
    target.base = next;
    target.version++;
    invalidateAtom(target, cause);
    deliverAtom(target, 0, cause);
    flushIfReady();
    return;
  }
  const writerWorld: World = {
    pin: sequence,
    lanes: lane,
    pass: -1,
    deferred,
  };
  const previous = readAtomInWorld(target, writerWorld);
  if (!update && target.equals(previous, input as T)) return;

  const seq = ++sequence;
  worldRevision++;
  const cause = traceEmit("write", {
    batch: deferred ? lane : undefined,
    label: target.label,
    detail: deferred ? "deferred" : "urgent",
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
    setPendingState(target, true, cause);
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

function collectComputedAtoms(target: Computed<any>): void {
  for (const source of target.sources) {
    if (source.kind === 0) collectAtom(source);
    else collectComputedAtoms(source);
  }
}

function mergeEvaluation(target: Computed<any>, evaluation: Evaluation<unknown>): void {
  const frame = activeFrame;
  const collector = activeCollector;
  const traverse =
    evaluation.atoms.length === 0 && ((frame !== null && frame.captureAtoms) || collector !== null);
  if (traverse) {
    collectComputedAtoms(target);
  } else {
    if (frame !== null && frame.captureAtoms) {
      for (const atom of evaluation.atoms) {
        if (atom.frameMark !== frame.id) {
          atom.frameMark = frame.id;
          frame.atoms.push(atom);
        }
      }
    }
    if (collector !== null) {
      for (const atom of evaluation.atoms) {
        if (!collector.atoms.includes(atom)) collector.atoms.push(atom);
      }
    }
  }
  if (frame !== null) {
    for (const pending of evaluation.pending) {
      if (!frame.pending.includes(pending)) frame.pending.push(pending);
    }
    if (frame.error === undefined && evaluation.error !== undefined) {
      frame.error = evaluation.error;
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
  const settlement = traceEmit("suspense settlement", {
    cause: record.cause || undefined,
    detail: status === 1 ? "fulfilled" : "rejected",
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
        if (status === 1) {
          target.worldSettled = true;
          target.worldValue = value;
        }
      } else {
        target.lastWorldEvaluation = null;
      }
    }
    let stillPending = false;
    if (last !== null) {
      for (const pending of last.pending) {
        if (pending.status === 0) {
          stillPending = true;
          break;
        }
      }
    }
    if (!stillPending) {
      if (lanes === 0) target.urgentPending = false;
      else target.pendingLanes &= ~lanes;
      setPendingState(target, target.urgentPending || target.pendingLanes !== 0, settlement);
    }
    if (target.latestEvaluation?.pending.includes(record)) {
      target.latestRevision = -1;
    }
    if (lanes === 0) {
      if (!resolvedDirect) {
        target.forced = true;
        markComputedDirty(target, settlement);
      }
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
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function useDuringEvaluation<U>(thenable: PromiseLike<U>): U {
  const frame = activeFrame;
  const world = activeWorld;
  if (frame === null || world === null) {
    throw new Error("A computed use function cannot be called after its evaluation ends.");
  }
  return consumeThenable(frame.computed, frame, world, thenable);
}

function runEvaluation<T>(target: Computed<T>, world: World, canonical: boolean): Evaluation<T> {
  if (target.evaluating) {
    throw new Error(`Cyclic computed${target.label ? ` ${target.label}` : ""}.`);
  }
  let frame: EvaluationFrame;
  if (canonical) {
    frame = target.canonicalFrame ?? {
      id: 0,
      captureAtoms: false,
      computed: target,
      atoms: [],
      pending: [],
    };
    target.canonicalFrame = frame;
    frame.atoms.length = 0;
    frame.pending.length = 0;
    frame.error = undefined;
  } else {
    frame = { id: 0, captureAtoms: true, computed: target, atoms: [], pending: [] };
  }
  frame.id = nextFrameId++;
  frame.captureAtoms = !canonical || activeCollector !== null;
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
    value = target.fn(useDuringEvaluation);
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
  const hadSettled = canonical ? target.settled : target.worldSettled || target.settled;
  const staleValue = canonical
    ? target.settled
      ? target.value
      : undefined
    : target.worldSettled
    ? target.worldValue
    : target.settled
    ? target.value
    : undefined;
  let evaluation = canonical ? target.evaluation : null;
  if (evaluation === null) {
    evaluation = {
      status,
      settled: hadSettled,
      value: status === 0 ? value : staleValue,
      thenable,
      error,
      atoms: frame.atoms,
      pending: frame.pending,
      direct,
    };
  } else {
    evaluation.status = status;
    evaluation.settled = hadSettled;
    evaluation.value = status === 0 ? value : staleValue;
    evaluation.thenable = thenable;
    evaluation.error = error;
    evaluation.atoms = frame.atoms;
    evaluation.pending = frame.pending;
    evaluation.direct = direct;
  }

  if (!canonical) {
    if (status === 0) {
      target.worldSettled = true;
      target.worldValue = value;
    }
    const ownerLanes = world.lanes & liveLanes;
    if (status === 1 && hadSettled) {
      if (ownerLanes === 0) target.urgentPending = true;
      else target.pendingLanes |= ownerLanes;
    } else if (status === 0) {
      if (ownerLanes === 0) target.urgentPending = false;
      else target.pendingLanes &= ~ownerLanes;
    }
    setPendingState(target, target.urgentPending || target.pendingLanes !== 0, target.cause ?? 0);
    return evaluation;
  }
  const oldStatus = target.status;
  const oldValue = target.value;
  const oldSettled = target.settled;
  reconcileSources(target, target.nextSources);
  target.initialized = true;
  target.dirty = false;
  target.forced = false;
  target.status = status;
  target.thenable = thenable;
  target.error = error;
  if (status === 0) {
    target.value = value;
    target.settled = true;
    evaluation.settled = true;
  }
  target.urgentPending = status === 1 && target.settled;
  setPendingState(target, target.urgentPending || target.pendingLanes !== 0, target.cause ?? 0);
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
  target.canonicalRevision = worldRevision;
  return evaluation;
}

function evaluateCanonical<T>(target: Computed<T>): Evaluation<T> {
  if (
    !target.dirty &&
    target.initialized &&
    target.canonicalRevision === worldRevision &&
    target.evaluation !== null
  ) {
    return target.evaluation;
  }
  if (!target.dirty && target.initialized) {
    for (let i = 0; i < target.sources.length; i++) {
      const source = target.sources[i];
      if (source.kind === 1 && (source.dirty || target.observers.size === 0)) {
        evaluateCanonical(source);
      }
      if (source.version !== target.sourceVersions[i]) {
        target.dirty = true;
        break;
      }
    }
  }
  if (target.dirty && target.initialized && !target.forced) {
    let changed = false;
    for (let i = 0; i < target.sources.length; i++) {
      const source = target.sources[i];
      if (source.kind === 1 && (source.dirty || target.observers.size === 0)) {
        evaluateCanonical(source);
      }
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
  if (!target.dirty && target.evaluation !== null) {
    target.canonicalRevision = worldRevision;
    return target.evaluation;
  }
  canonicalWorld.pin = sequence;
  return runEvaluation(target, canonicalWorld, true);
}

function evaluateInWorld<T>(target: Computed<T>, world: World): Evaluation<T> {
  worldComputeds.add(target);
  if (world.pass > 0) {
    const cached = target.worldCache?.get(world.pass);
    if (cached !== undefined) return cached;
  } else if (world.pass === -2 && target.latestRevision === worldRevision) {
    return target.latestEvaluation as Evaluation<T>;
  }
  let lanesVisibleAtPin = liveLanes;
  for (const batch of episodeBatches) {
    if (batch.retiredAt > world.pin) lanesVisibleAtPin |= batch.lane;
  }
  const visibleLanes = world.lanes & lanesVisibleAtPin;
  if (
    target.lastWorldEvaluation !== null &&
    target.lastWorldPin === world.pin &&
    target.lastWorldLanes === visibleLanes
  ) {
    return target.lastWorldEvaluation;
  }
  const evaluation = runEvaluation(target, world, false);
  for (const batch of batches.values()) {
    if ((world.lanes & batch.lane) !== 0 && batch.refreshes.includes(target)) {
      (batch.refreshResults ??= new Map()).set(target, evaluation);
    }
  }
  target.lastWorldPin = world.pin;
  target.lastWorldLanes = visibleLanes;
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

function reconcileSources(observer: Computed<any> | ReactiveEffect, nextSources: Source[]): void {
  const previous = observer.sources;
  if (previous.length === nextSources.length) {
    let sameOrder = true;
    for (let i = 0; i < previous.length; i++) {
      if (previous[i] !== nextSources[i]) {
        sameOrder = false;
        break;
      }
    }
    if (sameOrder) {
      for (let i = 0; i < nextSources.length; i++) {
        observer.sourceVersions[i] = observer.nextSourceVersions[i];
        observer.sourceValues[i] = observer.nextSourceValues[i];
      }
      return;
    }
  }
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
    if (source.kind === 1 && source.dirty) evaluateCanonical(source);
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
  const event = traceEmit("effect run", {
    cause: target.cause,
    target: target.handle?.deref(),
  });
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

function setPendingState(target: Atom<any> | Computed<any>, pending: boolean, cause: number): void {
  if (target.pendingState === pending) return;
  target.pendingState = pending;
  target.cause = cause || target.cause;
  pendingNotifications.add(target);
  if (pendingNotificationScheduled) return;
  pendingNotificationScheduled = true;
  queueMicrotask(() => {
    pendingNotificationScheduled = false;
    for (const target of pendingNotifications) {
      for (const observer of target.pendingObservers) {
        const delivery = traceEmit("component delivery", {
          cause: target.cause,
          target,
          label: target.label,
          detail: target.pendingState ? "pending" : "settled",
        });
        observer.notify(delivery || target.cause || 0);
      }
    }
    pendingNotifications.clear();
  });
}

function deliverAtom(target: Atom<any>, lane: Lane, cause: number): void {
  if (target.reactObservers.size === 0) return;
  const batch = lane === 0 ? undefined : batches.get(lane);
  const notify = () => {
    for (const observer of target.reactObservers) {
      if (batch !== undefined) batch.roots.add(observer.root);
      const delivery = traceEmit("component delivery", {
        cause,
        target,
        batch: lane || undefined,
        label: target.label,
      });
      observer.notify(delivery || cause);
    }
  };
  if (lane === 0 || host === null) notify();
  else host.runInLane(lane, notify);
}

function deliverComputed(target: Computed<any>, lane: Lane, cause: number): void {
  if (target.reactObservers.size === 0) return;
  const batch = lane === 0 ? undefined : batches.get(lane);
  const notify = () => {
    for (const observer of target.reactObservers) {
      if (batch !== undefined) batch.roots.add(observer.root);
      const delivery = traceEmit("component delivery", {
        cause,
        target,
        batch: lane || undefined,
        label: target.label,
      });
      observer.notify(delivery || cause);
    }
  };
  if (lane === 0 || host === null) notify();
  else host.runInLane(lane, notify);
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
    handle: null,
  };
  if (activeEffect !== null) activeEffect.children.push(target);
  if (activeScope !== null) activeScope.effects.push(target);
  const dispose = () => disposeEffect(target);
  target.handle = new WeakRef(dispose);
  runEffect(target);
  if (target.scope === null) disposalRegistry.register(dispose, target);
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
  if (batchDepth === 0) throw new Error("endBatch called without startBatch.");
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
  atomValues: unknown[];
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
    const atomValues: unknown[] = [];
    const world = currentWorld();
    for (const atom of collector.atoms) {
      versions.push(atom.version);
      atomValues.push(readAtomInWorld(atom, world));
    }
    traceEmit("component re-render", {
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
      atomValues,
      lanes: world.lanes,
      cause,
    };
  } finally {
    activeCollector = previous;
  }
}

export function collectCommittedReactRead<T>(
  target: Atom<T> | Computed<T>,
  container: RootToken,
  cause?: number,
): ReactRead<T> {
  const collector: ReadCollector = { atoms: [], computeds: [] };
  const world =
    passes.get(container)?.world ??
    ({
      pin: sequence,
      lanes: rootViews.get(container) ?? 0,
      pass: -3,
      deferred: false,
    } satisfies World);
  const previousCollector = activeCollector;
  const previousWorld = activeWorld;
  activeCollector = collector;
  activeWorld = world;
  try {
    let value: T | undefined;
    if (target.kind === 0) {
      collectAtom(target);
      value = readAtomInWorld(target, world);
    } else {
      collector.computeds.push(target);
      const evaluation = evaluateInWorld(target, world);
      if (evaluation.status === 2) throw evaluation.error?.error;
      for (const atom of evaluation.atoms) {
        if (!collector.atoms.includes(atom)) collector.atoms.push(atom);
      }
      value = evaluation.value;
    }
    const versions: number[] = [];
    const atomValues: unknown[] = [];
    for (const atom of collector.atoms) {
      versions.push(atom.version);
      atomValues.push(readAtomInWorld(atom, world));
    }
    traceEmit("component re-render", { cause, target, label: target.label });
    return {
      target,
      value: value as T,
      atoms: collector.atoms,
      computeds: collector.computeds,
      versions,
      atomValues,
      lanes: world.lanes,
      cause,
    };
  } finally {
    activeWorld = previousWorld;
    activeCollector = previousCollector;
  }
}

export function subscribeReact<T>(snapshot: ReactRead<T>, observer: ReactObserver): () => void {
  for (const atom of snapshot.atoms) {
    const wasUnobserved = atomObserverCount(atom) === 0;
    atom.reactObservers.add(observer);
    if (wasUnobserved) queueLifetime(atom);
  }
  for (const computed of snapshot.computeds) computed.reactObservers.add(observer);

  let staleCause = 0;
  for (let i = 0; i < snapshot.atoms.length; i++) {
    const atom = snapshot.atoms[i];
    canonicalWorld.pin = sequence;
    if (
      atom.version !== snapshot.versions[i] &&
      !atom.equals(snapshot.atomValues[i], readAtomInWorld(atom, canonicalWorld))
    ) {
      staleCause = traceEmit("component delivery", {
        target: snapshot.target,
        detail: "post-subscribe canonical repair",
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
    if (!touched) {
      for (const computed of batch.refreshes) {
        if (snapshot.computeds.includes(computed)) {
          touched = true;
          break;
        }
      }
    }
    if (!touched) continue;
    batch.roots.add(observer.root);
    const delivery = traceEmit("component delivery", {
      cause: batch.cause,
      target: snapshot.target,
      batch: batch.lane,
      detail: "commit-boundary repair",
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

export function subscribePending(
  target: Atom<any> | Computed<any>,
  observer: ReactObserver,
): () => void {
  target.pendingObservers.add(observer);
  return () => target.pendingObservers.delete(observer);
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
  const world =
    activeWorld !== null || host?.renderContext() != null
      ? currentWorld()
      : { pin: sequence, lanes: liveLanes, pass: -2, deferred: false };
  if (target.kind === 0) {
    collectAtom(target);
    const value = readAtomInWorld(target, world);
    trackSource(target, value);
    return value;
  }
  const collector = activeCollector;
  if (collector !== null && !collector.computeds.includes(target)) collector.computeds.push(target);
  const evaluation =
    world.lanes === 0 && world.pass <= 0
      ? evaluateCanonical(target)
      : evaluateInWorld(target, world);
  const frame = activeFrame;
  if (frame !== null) {
    for (const atom of evaluation.atoms) {
      if (!frame.atoms.includes(atom)) frame.atoms.push(atom);
    }
  }
  if (collector !== null) {
    for (const atom of evaluation.atoms) {
      if (!collector.atoms.includes(atom)) collector.atoms.push(atom);
    }
  }
  trackSource(target, evaluation.value);
  if (evaluation.status === 2) throw evaluation.error?.error;
  return evaluation.value as T;
}

export function committed<T>(target: Atom<T> | Computed<T>, container?: RootToken): T {
  const lanes = container === undefined ? 0 : rootViews.get(container) ?? 0;
  return readInWorldWithoutTracking(target, {
    pin: sequence,
    lanes,
    pass: -3,
    deferred: false,
  }) as T;
}

export function isPending(target: Atom<any> | Computed<any>): boolean {
  return target.pendingState;
}

export function refresh(target: Computed<any>): void {
  const classification = host?.currentWriteLane() ?? 0;
  const lane = classification < 0 ? -classification : 0;
  worldRevision++;
  const cause = traceEmit("write", {
    batch: lane || undefined,
    label: target.label,
    detail: "refresh",
  });
  target.latestRevision = -1;
  target.worldCache?.clear();
  target.lastWorldEvaluation = null;
  if (lane === 0) {
    target.forced = true;
    markComputedDirty(target, cause);
    deliverComputed(target, 0, cause);
  } else {
    const batch = getOrCreateBatch(lane, ++sequence, cause);
    if (!batch.refreshes.includes(target)) batch.refreshes.push(target);
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
  traceEmit("render pass end", {
    cause: pass.traceStart || undefined,
    batch: pass.world.lanes & liveLanes || undefined,
    detail: committedPass ? "commit" : "discard",
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
  const retirementCause = traceEmit("batch retire", {
    cause: cause ?? batch.cause,
    batch: batch.lane,
    detail: committedBatch ? "committed" : "external-only",
  });
  for (const atom of changed) {
    let pending = false;
    if (atom.pending !== null) {
      for (const operation of atom.pending) {
        if ((operation.batch as Batch).retiredAt === 0) {
          pending = true;
          break;
        }
      }
    }
    setPendingState(atom, pending, retirementCause || batch.cause);
    atom.version++;
    invalidateAtom(atom, retirementCause || batch.cause);
    traceEmit("component delivery", {
      cause: retirementCause || batch.cause,
      target: atom,
      batch: batch.lane,
      label: atom.label,
      detail: "committed lane",
    });
  }
  for (const target of batch.refreshes) {
    const evaluation = batch.refreshResults?.get(target);
    if (evaluation === undefined || evaluation.status === 1) {
      target.forced = true;
      markComputedDirty(target, retirementCause || batch.cause);
      continue;
    }
    const changedValue =
      evaluation.status !== target.status ||
      (evaluation.status === 0 &&
        (!target.settled || !target.equals(target.value, evaluation.value)));
    target.initialized = true;
    target.dirty = false;
    target.forced = false;
    target.status = evaluation.status;
    target.thenable = evaluation.thenable;
    target.error = evaluation.error;
    target.evaluation = evaluation;
    if (evaluation.status === 0) {
      target.value = evaluation.value;
      target.settled = true;
    }
    target.pendingLanes &= ~batch.lane;
    setPendingState(
      target,
      target.urgentPending || target.pendingLanes !== 0,
      retirementCause || batch.cause,
    );
    if (changedValue) {
      target.version++;
      propagateComputed(target, retirementCause || batch.cause);
    }
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
  for (const target of worldComputeds) {
    target.worldCache?.clear();
    if (target.lastWorldEvaluation?.status !== 1) target.lastWorldEvaluation = null;
    if (target.latestEvaluation?.status !== 1) {
      target.latestEvaluation = null;
      target.latestRevision = -1;
    }
    if (target.lastWorldEvaluation === null && target.latestEvaluation === null) {
      worldComputeds.delete(target);
    }
  }
}

const hostListener: SignalHostListener = {
  onRenderStart(container, lanes) {
    if (passes.has(container)) clearPass(container, false);
    const visibleLanes = lanes | (rootViews.get(container) ?? 0);
    const id = nextPassId++;
    let cause: number | undefined;
    for (const batch of batches.values()) {
      if ((visibleLanes & batch.lane) !== 0) {
        cause = batch.cause;
        break;
      }
    }
    const traceStart = traceEmit("render pass start", {
      cause,
      batch: visibleLanes & liveLanes || undefined,
      detail: `pass ${id}`,
    });
    passes.set(container, {
      id,
      world: {
        pin: sequence,
        lanes: visibleLanes,
        pass: id,
        deferred: (visibleLanes & liveLanes) !== 0,
      },
      computeds: null,
      traceStart,
    });
    activePassCount++;
    for (const batch of batches.values()) {
      if ((lanes & batch.lane) !== 0) batch.roots.add(container);
    }
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
    const commit = traceEmit("root commit", { cause, detail: String(finishedLanes) });
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
  target.pendingState = false;
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
    atom.pendingState = false;
  }
  touchedAtoms.clear();
  worldComputeds.clear();
  episodeBatches.length = 0;
  dirtyComputeds.length = 0;
  pendingEffects.length = 0;
  pendingNotifications.clear();
  dirtyIndex = 0;
  effectIndex = 0;
  batchDepth = 0;
  flushing = false;
  pendingNotificationScheduled = false;
  activeWorld = null;
  activeObserver = null;
  activeFrame = null;
  activeCollector = null;
  resetTraceForTest();
}

export { startTrace, type Trace };
