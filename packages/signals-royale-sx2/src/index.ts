export type BatchId = number;
export type CellKey = string;

type Cleanup = void | (() => void);
type Equality<T> = (a: T, b: T) => boolean;
type Subscriber = { notify(cause?: number): void };
type Source = {
  version: number;
  ensure(): void;
  add(subscriber: Subscriber): void;
  remove(subscriber: Subscriber): void;
};
type Link = { source: Source; version: number };
type DraftOperation<T> = {
  batch: BatchId;
  apply(previous: T): T;
  cause?: number;
};

export interface RenderWorld {
  lanes: number;
  deferred: boolean;
}

export interface TraceEvent {
  id: number;
  kind: string;
  cause?: number;
  batch?: BatchId;
}

type ViewSubscriber = (batch: BatchId, cause?: number) => void;
type LiveBatch = {
  atoms: Set<Atom<unknown>>;
  computeds: Set<Computed<unknown>>;
  openCause?: number;
  lastCause?: number;
};
type ThenableRecord = {
  thenable: PromiseLike<unknown>;
  status: "pending" | "fulfilled" | "rejected";
  value?: unknown;
  error?: AsyncError;
  owners: Array<{ owner: WeakRef<Computed<unknown>>; batch: BatchId }>;
};

let active: Observer | undefined;
let tracking = true;
let batchDepth = 0;
let flushing = false;
let effectDepth = 0;
let initializerDepth = 0;
const queuedEffects = new Set<ReactiveEffect>();
let activeScope: Set<ReactiveEffect> | undefined;
let batchAtoms:
  | Map<Atom<unknown>, { value: unknown; version: number }>
  | undefined;
let batchAtom: Atom<unknown> | undefined;
let batchAtomValue: unknown;
let batchAtomVersion = 0;
let activeWorld: RenderWorld | undefined;
let writeBatch: BatchId = 0;
let retiring = false;
const liveBatches = new Map<BatchId, LiveBatch>();
const viewSubscribers = new Set<ViewSubscriber>();
let nextTraceId = 1;
const tracers = new Set<Tracer>();
const thenableRecords = new WeakMap<object, ThenableRecord>();
let asyncOwner: Computed<unknown> | undefined;

export class AsyncError {
  readonly error: unknown;

  constructor(error: unknown) {
    this.error = error;
  }
}

function settleThenable(
  record: ThenableRecord,
  status: "fulfilled" | "rejected",
  value: unknown,
): void {
  record.status = status;
  if (status === "fulfilled") record.value = value;
  else record.error = new AsyncError(value);
  for (const entry of record.owners) {
    entry.owner.deref()?.settled(entry.batch, record);
  }
  record.owners.length = 0;
}

export function useThenable<T>(thenable: PromiseLike<T>): T {
  const key = thenable as object;
  let record = thenableRecords.get(key);
  if (record === undefined) {
    record = {
      thenable,
      status: "pending",
      owners: [],
    };
    thenableRecords.set(key, record);
    thenable.then(
      (value) => settleThenable(record as ThenableRecord, "fulfilled", value),
      (error) => settleThenable(record as ThenableRecord, "rejected", error),
    );
  }
  if (record.status === "fulfilled") return record.value as T;
  if (record.status === "rejected") throw record.error;
  if (asyncOwner === undefined) throw record.thenable;
  asyncOwner.capture(record);
  return undefined as T;
}

function emitTrace(
  kind: string,
  cause?: number,
  batchId?: BatchId,
  target?: object,
): number | undefined {
  if (tracers.size === 0) return undefined;
  const event = { id: nextTraceId++, kind, cause, batch: batchId };
  for (const tracer of tracers) tracer.push(event, target);
  return event.id;
}

function notifyViews(batchId: BatchId, cause?: number): void {
  for (const subscriber of viewSubscribers) subscriber(batchId, cause);
}

class Tracer {
  private readonly limit: number;
  private readonly log: TraceEvent[] = [];
  private readonly deliveries = new WeakMap<object, number>();
  overflow = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(event: TraceEvent, target?: object): void {
    if (this.log.length === this.limit) {
      this.log.shift();
      this.overflow++;
    }
    this.log.push(event);
    if (
      target !== undefined &&
      (event.kind === "component delivery" || event.kind === "effect run")
    ) {
      this.deliveries.set(target, event.id);
    }
  }

  events(): TraceEvent[] {
    return this.log.slice();
  }

  whyLastDelivery(target: object): string[] {
    let id: number | undefined = this.deliveries.get(target);
    const chain: string[] = [];
    while (id !== undefined) {
      let found: TraceEvent | undefined;
      for (let index = this.log.length - 1; index >= 0; index--) {
        if (this.log[index].id === id) {
          found = this.log[index];
          break;
        }
      }
      if (found === undefined) break;
      chain.push(
        `${found.kind}${
          found.batch === undefined ? "" : ` [batch ${found.batch}]`
        }`,
      );
      id = found.cause;
    }
    return chain;
  }

  stop(): void {
    tracers.delete(this);
  }
}

export function trace(options: { limit?: number } = {}): Tracer {
  const tracer = new Tracer(options.limit ?? 1024);
  tracers.add(tracer);
  return tracer;
}

export function traceEvent(
  kind: string,
  cause?: number,
  batchId?: BatchId,
  target?: object,
): number | undefined {
  return emitTrace(kind, cause, batchId, target);
}

abstract class Observer implements Subscriber {
  deps: Link[] = [];
  nextDeps: Link[] = [];
  nextSources?: Set<Source>;
  dirty = true;
  abstract get observesSources(): boolean;
  abstract notify(cause?: number): void;

  protected dependenciesChanged(): boolean {
    for (const link of this.deps) {
      link.source.ensure();
      if (link.source.version !== link.version) return true;
    }
    return false;
  }

  protected evaluate<T>(fn: () => T): T {
    const previous = active;
    const previousTracking = tracking;
    this.nextDeps.length = 0;
    this.nextSources?.clear();
    active = this;
    tracking = true;
    try {
      return fn();
    } finally {
      active = previous;
      tracking = previousTracking;
      for (const old of this.deps) {
        let retained = this.nextSources?.has(old.source) ?? false;
        if (this.nextSources === undefined) {
          for (const current of this.nextDeps) {
            if (current.source === old.source) {
              retained = true;
              break;
            }
          }
        }
        if (!retained && this.observesSources) old.source.remove(this);
      }
      const old = this.deps;
      this.deps = this.nextDeps;
      this.nextDeps = old;
    }
  }

  detach(): void {
    for (const link of this.deps) link.source.remove(this);
  }
}

function track(source: Source): void {
  const observer = active;
  if (!tracking || observer === undefined) return;
  const index = observer.nextDeps.length;
  let sources = observer.nextSources;
  if (sources === undefined) {
    for (const link of observer.nextDeps) {
      if (link.source === source) return;
    }
    if (index === 8) {
      sources = new Set();
      observer.nextSources = sources;
      for (const link of observer.nextDeps) sources.add(link.source);
    }
  } else if (sources.has(source)) {
    return;
  }
  let link: Link | undefined = observer.deps[index];
  if (link?.source !== source) {
    link = undefined;
    for (const old of observer.deps) {
      if (old.source === source) {
        link = old;
        break;
      }
    }
  }
  if (link === undefined) link = { source, version: source.version };
  else link.version = source.version;
  observer.nextDeps.push(link);
  sources?.add(source);
  if (observer.observesSources) source.add(observer);
}

function flushEffects(): void {
  if (flushing || batchDepth !== 0 || effectDepth !== 0) return;
  flushing = true;
  try {
    while (queuedEffects.size !== 0) {
      for (const effect of queuedEffects) {
        queuedEffects.delete(effect);
        effect.flush();
      }
    }
  } catch (error) {
    queuedEffects.clear();
    throw error;
  } finally {
    flushing = false;
  }
}

export interface AtomOptions<T> {
  equals?: Equality<T>;
  effect?: (context: { get(): T; set(value: T): void }) => Cleanup;
  onObserved?: (context: { get(): T; set(value: T): void }) => Cleanup;
  label?: string;
  key?: CellKey;
}

export class Atom<T> implements Source {
  version = 0;
  readonly label?: string;
  readonly key?: CellKey;
  private value!: T;
  private initial: T | (() => T);
  private initialized = false;
  private readonly equals: Equality<T>;
  private readonly subscribers = new Set<Subscriber>();
  private readonly viewSubscribers = new Set<ViewSubscriber>();
  private readonly pendingSubscribers = new Set<() => void>();
  private readonly drafts = new Set<BatchId>();
  private history?: DraftOperation<T>[];
  private historyBase!: T;
  private readonly observe?: (context: {
    get(): T;
    set(value: T): void;
  }) => Cleanup;
  private observation?: () => void;
  private observationEpoch = 0;

  constructor(initial: T | (() => T), options: AtomOptions<T> = {}) {
    this.initial = initial;
    this.equals = options.equals ?? Object.is;
    this.observe = options.effect ?? options.onObserved;
    this.label = options.label;
    this.key = options.key;
  }

  ensure(): void {
    if (this.initialized) return;
    const initial = this.initial;
    this.initialized = true;
    if (typeof initial === "function") {
      initializerDepth++;
      try {
        this.value = untracked(() => (initial as () => T)());
      } finally {
        initializerDepth--;
      }
    } else {
      this.value = initial;
    }
  }

  get(): T {
    this.ensure();
    track(this);
    if (activeWorld !== undefined) return this.valueFor(activeWorld.lanes);
    if (writeBatch !== 0) return this.valueFor(writeBatch);
    return this.value;
  }

  set(value: T): void {
    if (initializerDepth !== 0)
      throw new Error("Signals cannot be written by a lazy initializer");
    this.ensure();
    if (writeBatch !== 0) {
      this.writeDraft(() => value);
      return;
    }
    this.writeUrgent(value, () => value);
  }

  private writeUrgent(value: T, apply: (previous: T) => T): void {
    let cause: number | undefined;
    if (!retiring && this.history !== undefined) {
      cause = emitTrace("write", undefined, 0);
      this.history.push({ batch: 0, apply, cause });
    }
    if (this.equals(this.value, value)) return;
    cause ??= emitTrace("write", undefined, 0);
    const current = this as Atom<unknown>;
    const saved = batchAtoms?.get(current);
    let originalValue: unknown;
    let originalVersion = 0;
    let hasOriginal = false;
    if (batchAtom === current) {
      originalValue = batchAtomValue;
      originalVersion = batchAtomVersion;
      hasOriginal = true;
    } else if (saved !== undefined) {
      originalValue = saved.value;
      originalVersion = saved.version;
      hasOriginal = true;
    }
    if (batchDepth !== 0 && !hasOriginal) {
      originalValue = this.value;
      originalVersion = this.version;
      hasOriginal = true;
      if (batchAtom === undefined) {
        batchAtom = current;
        batchAtomValue = this.value;
        batchAtomVersion = this.version;
      } else {
        if (batchAtoms === undefined) {
          batchAtoms = new Map();
          batchAtoms.set(batchAtom, {
            value: batchAtomValue,
            version: batchAtomVersion,
          });
        }
        batchAtoms.set(current, {
          value: originalValue,
          version: originalVersion,
        });
      }
    }
    this.value = value;
    this.version =
      !hasOriginal
        ? this.version + 1
        : this.equals(originalValue as T, value)
        ? originalVersion
        : originalVersion + 1;
    for (const subscriber of this.subscribers) subscriber.notify(cause);
    if (!retiring) {
      this.notifyViews(0, cause);
      notifyViews(0, cause);
    }
    flushEffects();
  }

  update(fn: (previous: T) => T): void {
    if (writeBatch !== 0) {
      this.ensure();
      this.writeDraft(fn);
      return;
    }
    this.ensure();
    this.writeUrgent(fn(untracked(() => this.get())), fn);
  }

  install(value: T): void {
    this.initialized = true;
    this.value = value;
  }

  hasDraft(batchId?: BatchId): boolean {
    return batchId === undefined
      ? this.drafts.size !== 0
      : this.drafts.has(batchId);
  }

  isPending(): boolean {
    for (const batchId of this.drafts) {
      if (activeWorld === undefined || (activeWorld.lanes & batchId) === 0) {
        return true;
      }
    }
    return false;
  }

  latest(): T {
    this.ensure();
    const history = this.history;
    if (history === undefined) return this.value;
    let value = this.historyBase;
    for (const operation of history) value = operation.apply(value);
    return value;
  }

  retire(batchId: BatchId, commit: boolean): void {
    if (!this.drafts.has(batchId)) return;
    const wasPending = this.drafts.size !== 0;
    this.drafts.delete(batchId);
    if (wasPending && this.drafts.size === 0) this.notifyPending();
    const history = this.history as DraftOperation<T>[];
    let write = 0;
    for (const operation of history) {
      if (operation.batch === batchId) {
        if (!commit) continue;
        operation.batch = 0;
      }
      history[write++] = operation;
    }
    history.length = write;
    let value = this.historyBase;
    for (const operation of history) {
      if (operation.batch === 0) value = operation.apply(value);
    }
    this.writeUrgent(value, () => value);
    if (this.drafts.size === 0) this.history = undefined;
  }

  private valueFor(lanes: number): T {
    const history = this.history;
    if (history === undefined) return this.value;
    let value = this.historyBase;
    for (const operation of history) {
      if (operation.batch === 0 || (operation.batch & lanes) !== 0) {
        value = operation.apply(value);
      }
    }
    return value;
  }

  private writeDraft(apply: (previous: T) => T): void {
    const previous = this.valueFor(writeBatch);
    const value = apply(previous);
    if (this.equals(previous, value)) return;
    const wasPending = this.drafts.size !== 0;
    let history = this.history;
    if (history === undefined) {
      this.historyBase = this.value;
      history = [];
      this.history = history;
    }
    this.drafts.add(writeBatch);
    const live = liveBatches.get(writeBatch);
    const cause = emitTrace("write", live?.openCause, writeBatch);
    history.push({ batch: writeBatch, apply, cause });
    if (!wasPending) this.notifyPending();
    live?.atoms.add(this as Atom<unknown>);
    if (live !== undefined) live.lastCause = cause;
    this.notifyViews(writeBatch, cause);
    notifyViews(writeBatch, cause);
  }

  subscribeView(subscriber: ViewSubscriber): () => void {
    this.viewSubscribers.add(subscriber);
    return () => this.viewSubscribers.delete(subscriber);
  }

  subscribePending(subscriber: () => void): () => void {
    this.pendingSubscribers.add(subscriber);
    return () => this.pendingSubscribers.delete(subscriber);
  }

  notifyViews(batchId: BatchId, cause?: number): void {
    for (const subscriber of this.viewSubscribers) subscriber(batchId, cause);
  }

  private notifyPending(): void {
    for (const subscriber of this.pendingSubscribers) subscriber();
  }

  add(subscriber: Subscriber): void {
    const first = this.subscribers.size === 0;
    this.subscribers.add(subscriber);
    if (first && this.subscribers.size !== 0) this.queueObservation();
  }

  remove(subscriber: Subscriber): void {
    if (!this.subscribers.delete(subscriber)) return;
    if (this.subscribers.size === 0) this.queueObservation();
  }

  private queueObservation(): void {
    if (this.observe === undefined) return;
    const epoch = ++this.observationEpoch;
    queueMicrotask(() => {
      if (epoch !== this.observationEpoch) return;
      if (this.subscribers.size !== 0 && this.observation === undefined) {
        const cleanup = this.observe?.({
          get: () => this.get(),
          set: (value) => this.set(value),
        });
        if (cleanup !== undefined) this.observation = cleanup;
      } else if (
        this.subscribers.size === 0 &&
        this.observation !== undefined
      ) {
        const cleanup = this.observation;
        this.observation = undefined;
        cleanup();
      }
    });
  }
}

export interface ComputedOptions<T> {
  equals?: Equality<T>;
  label?: string;
}

export class Computed<T> extends Observer implements Source {
  version = 0;
  readonly label?: string;
  private readonly fn: () => T;
  private readonly equals: Equality<T>;
  private readonly subscribers = new Set<Subscriber>();
  private readonly pendingSubscribers = new Set<() => void>();
  private hasValue = false;
  private evaluating = false;
  private value!: T;
  private failure: unknown;
  private forced = false;
  private pending = false;
  private pendingRecords: ThenableRecord[] = [];
  private pendingThenable?: Promise<void>;
  private readonly captured: ThenableRecord[] = [];
  private readonly worldPending = new Map<
    number,
    { records: ThenableRecord[]; thenable: Promise<void> }
  >();
  private readonly worldValues = new Map<BatchId, T>();
  private readonly refreshBatches = new Set<BatchId>();

  constructor(fn: () => T, options: ComputedOptions<T> = {}) {
    super();
    this.fn = fn;
    this.equals = options.equals ?? Object.is;
    this.label = options.label;
  }

  get observesSources(): boolean {
    return this.subscribers.size !== 0;
  }

  ensure(): void {
    if (!this.dirty) {
      if (this.observesSources || !this.dependenciesChanged()) return;
      this.dirty = true;
    }
    if (this.hasValue && !this.forced && !this.dependenciesChanged()) {
      this.dirty = false;
      return;
    }
    if (this.evaluating) throw new Error("Computed cycle");
    this.evaluating = true;
    let next!: T;
    let failure: unknown;
    this.captured.length = 0;
    const previousOwner = asyncOwner;
    asyncOwner = this as unknown as Computed<unknown>;
    try {
      next = this.evaluate(this.fn);
    } catch (error) {
      failure = error;
    } finally {
      asyncOwner = previousOwner;
      this.evaluating = false;
      this.dirty = false;
    }
    if (failure === undefined && this.captured.length !== 0) {
      const wasPending = this.pending;
      this.pending = true;
      if (!this.samePending(this.captured)) {
        this.pendingRecords = this.captured.slice();
        this.pendingThenable = this.aggregate(this.pendingRecords);
      }
      if (!wasPending) this.notifyPending();
      return;
    }
    const wasPending = this.pending;
    this.pending = false;
    this.forced = false;
    this.pendingRecords.length = 0;
    this.pendingThenable = undefined;
    if (wasPending) this.notifyPending();
    const changed =
      !this.hasValue ||
      failure !== this.failure ||
      (failure === undefined && !this.equals(this.value, next));
    this.hasValue = true;
    this.failure = failure;
    if (failure === undefined) this.value = next;
    if (changed) this.version++;
  }

  get(): T {
    if (activeWorld?.deferred) return this.getWorld(activeWorld.lanes);
    this.ensure();
    track(this);
    if (this.pending && !this.hasValue) throw this.pendingThenable;
    if (this.failure !== undefined) throw this.failure;
    return this.value;
  }

  notify(cause?: number): void {
    if (this.dirty) return;
    this.dirty = true;
    for (const subscriber of this.subscribers) subscriber.notify(cause);
  }

  add(subscriber: Subscriber): void {
    const first = this.subscribers.size === 0;
    this.subscribers.add(subscriber);
    if (first) {
      for (const link of this.deps) link.source.add(this);
    }
  }

  remove(subscriber: Subscriber): void {
    if (!this.subscribers.delete(subscriber) || this.subscribers.size !== 0)
      return;
    for (const link of this.deps) link.source.remove(this);
  }

  refresh(): void {
    if (writeBatch !== 0) {
      this.refreshBatches.add(writeBatch);
      const live = liveBatches.get(writeBatch);
      live?.computeds.add(this as unknown as Computed<unknown>);
      const cause = emitTrace("refresh", live?.openCause, writeBatch);
      if (live !== undefined) live.lastCause = cause;
      this.notifyPending();
      notifyViews(writeBatch, cause);
      return;
    }
    this.dirty = true;
    this.forced = true;
    for (const subscriber of this.subscribers) subscriber.notify();
    notifyViews(writeBatch);
  }

  capture(record: ThenableRecord): void {
    for (const current of this.captured) {
      if (current === record) return;
    }
    this.captured.push(record);
    let batchId = writeBatch;
    if (batchId === 0 && activeWorld !== undefined) {
      for (const [liveId] of liveBatches) {
        if ((activeWorld.lanes & liveId) !== 0) {
          batchId = liveId;
          break;
        }
      }
    }
    for (const entry of record.owners) {
      if (entry.owner.deref() === this && entry.batch === batchId) return;
    }
    record.owners.push({
      owner: new WeakRef(this as unknown as Computed<unknown>),
      batch: batchId,
    });
  }

  settled(batchId: BatchId, record: ThenableRecord): void {
    if (
      batchId === 0 &&
      this.pendingRecords.length === 1 &&
      this.pendingRecords[0] === record
    ) {
      this.pending = false;
      this.pendingRecords.length = 0;
      this.pendingThenable = undefined;
      this.dirty = false;
      this.forced = false;
      this.hasValue = true;
      if (record.status === "fulfilled") {
        this.value = record.value as T;
        this.failure = undefined;
      } else {
        this.failure = record.error;
      }
      this.version++;
      this.notifyPending();
    } else {
      this.dirty = true;
    }
    const cause = emitTrace("suspense settlement", undefined, batchId);
    for (const subscriber of this.subscribers) subscriber.notify(cause);
    notifyViews(batchId, cause);
  }

  isPending(): boolean {
    if (this.pending || this.worldPending.size !== 0) return true;
    for (const batchId of this.refreshBatches) {
      if (activeWorld === undefined || (activeWorld.lanes & batchId) === 0) {
        return true;
      }
    }
    return false;
  }

  latest(lanes: number): T {
    try {
      return this.getWorld(lanes);
    } catch (error) {
      if (
        error !== null &&
        (typeof error === "object" || typeof error === "function") &&
        "then" in error
      ) {
        return this.hasValue ? this.value : (undefined as T);
      }
      throw error;
    }
  }

  subscribePending(subscriber: () => void): () => void {
    this.pendingSubscribers.add(subscriber);
    return () => this.pendingSubscribers.delete(subscriber);
  }

  retireRefresh(batchId: BatchId, commit: boolean): void {
    const refreshed = this.refreshBatches.delete(batchId);
    let hasValue = false;
    let value!: T;
    for (const [lanes, worldValue] of this.worldValues) {
      if ((lanes & batchId) !== 0) {
        hasValue = true;
        value = worldValue;
      }
    }
    this.worldPending.clear();
    this.worldValues.clear();
    if (!refreshed) return;
    if (commit && hasValue && !this.equals(this.value, value)) {
      this.value = value;
      this.hasValue = true;
      this.failure = undefined;
      this.version++;
      for (const subscriber of this.subscribers) subscriber.notify();
    }
    this.notifyPending();
  }

  private notifyPending(): void {
    for (const subscriber of this.pendingSubscribers) subscriber();
  }

  private getWorld(lanes: number): T {
    for (const [batchId, live] of liveBatches) {
      if ((lanes & batchId) !== 0) {
        live.computeds.add(this as unknown as Computed<unknown>);
      }
    }
    if (this.worldValues.has(lanes)) return this.worldValues.get(lanes) as T;
    const existing = this.worldPending.get(lanes);
    if (existing !== undefined) {
      let pending = false;
      for (const record of existing.records) {
        if (record.status === "pending") {
          pending = true;
          break;
        }
      }
      if (pending) throw existing.thenable;
      this.worldPending.delete(lanes);
      if (existing.records.length === 1) {
        const record = existing.records[0];
        if (record.status === "fulfilled") {
          const value = record.value as T;
          this.worldValues.set(lanes, value);
          return value;
        }
        if (record.status === "rejected") throw record.error;
      }
    }
    this.captured.length = 0;
    const previousOwner = asyncOwner;
    asyncOwner = this as unknown as Computed<unknown>;
    let value!: T;
    try {
      value = untracked(this.fn);
    } finally {
      asyncOwner = previousOwner;
    }
    if (this.captured.length !== 0) {
      const records = this.captured.slice();
      const thenable = this.aggregate(records);
      this.worldPending.set(lanes, { records, thenable });
      throw thenable;
    }
    this.worldValues.set(lanes, value);
    return value;
  }

  private samePending(records: ThenableRecord[]): boolean {
    if (records.length !== this.pendingRecords.length) return false;
    for (let index = 0; index < records.length; index++) {
      if (records[index] !== this.pendingRecords[index]) return false;
    }
    return true;
  }

  private aggregate(records: ThenableRecord[]): Promise<void> {
    const promises: PromiseLike<unknown>[] = [];
    for (const record of records) promises.push(record.thenable);
    return Promise.all(promises).then(() => undefined);
  }
}

class ReactiveEffect extends Observer {
  private readonly fn: () => Cleanup;
  private cleanup?: () => void;
  private active = true;
  private hasRun = false;
  private cause?: number;
  private readonly children = new Set<ReactiveEffect>();
  traceTarget?: object;

  constructor(fn: () => Cleanup) {
    super();
    this.fn = fn;
  }

  get observesSources(): boolean {
    return true;
  }

  notify(cause?: number): void {
    if (!this.active) return;
    this.dirty = true;
    this.cause = cause;
    queuedEffects.add(this);
  }

  flush(): void {
    if (!this.active || (!this.dirty && this.hasRun)) return;
    if (this.hasRun && !this.dependenciesChanged()) {
      this.dirty = false;
      return;
    }
    if (!this.active) return;
    effectDepth++;
    try {
      this.dirty = false;
      for (const child of this.children) child.dispose();
      this.children.clear();
      if (this.cleanup !== undefined) untracked(this.cleanup);
      this.cleanup = undefined;
      const parentScope = activeScope;
      activeScope = this.children;
      try {
        emitTrace(
          "effect run",
          this.cause,
          undefined,
          this.traceTarget ?? this,
        );
        const result = this.evaluate(this.fn);
        if (typeof result === "function") this.cleanup = result;
        this.hasRun = true;
      } finally {
        activeScope = parentScope;
      }
    } finally {
      effectDepth--;
    }
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    queuedEffects.delete(this);
    this.detach();
    for (const child of this.children) child.dispose();
    this.children.clear();
    if (this.cleanup !== undefined) untracked(this.cleanup);
    this.cleanup = undefined;
  }
}

export function atom<T>(
  initial: T | (() => T),
  options?: AtomOptions<T>,
): Atom<T> {
  return new Atom(initial, options);
}

export function computed<T>(
  fn: () => T,
  options?: ComputedOptions<T>,
): Computed<T> {
  return new Computed(fn, options);
}

export function effect(fn: () => Cleanup): () => void {
  const reactiveEffect = new ReactiveEffect(fn);
  const dispose = () => reactiveEffect.dispose();
  reactiveEffect.traceTarget = dispose;
  reactiveEffect.flush();
  activeScope?.add(reactiveEffect);
  flushEffects();
  return dispose;
}

export function effectScope(fn: () => void): () => void {
  const parent = activeScope;
  const scope = new Set<ReactiveEffect>();
  activeScope = scope;
  try {
    fn();
  } finally {
    activeScope = parent;
  }
  return () => {
    for (const reactiveEffect of scope) {
      try {
        reactiveEffect.dispose();
      } catch {}
    }
    scope.clear();
  };
}

export function startBatch(): void {
  batchDepth++;
}

export function endBatch(): void {
  if (batchDepth === 0) throw new Error("endBatch without startBatch");
  if (--batchDepth === 0) {
    batchAtoms = undefined;
    batchAtom = undefined;
    batchAtomValue = undefined;
    flushEffects();
  }
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
  const previous = tracking;
  tracking = false;
  try {
    return fn();
  } finally {
    tracking = previous;
  }
}

export function read<T>(cell: Atom<T> | Computed<T>): T {
  return cell.get();
}

export function latest<T>(cell: Atom<T> | Computed<T>): T {
  if (activeWorld !== undefined) return cell.get();
  if (cell instanceof Atom) return cell.latest();
  let lanes = 0;
  for (const [batchId] of liveBatches) lanes |= batchId;
  return lanes === 0
    ? cell.get()
    : withWorld({ lanes, deferred: true }, () => cell.latest(lanes));
}

export function set<T>(cell: Atom<T>, value: T): void {
  cell.set(value);
}

export function update<T>(cell: Atom<T>, fn: (previous: T) => T): void {
  cell.update(fn);
}

const committedRoots = new WeakMap<object, Map<object, unknown>>();
const lastCommitted = new WeakMap<object, unknown>();

export function committed<T>(
  cell: Atom<T> | Computed<T>,
  container?: object,
): T {
  if (container !== undefined) {
    const value = committedRoots.get(container)?.get(cell);
    if (value !== undefined || committedRoots.get(container)?.has(cell)) {
      return value as T;
    }
  } else if (lastCommitted.has(cell)) {
    return lastCommitted.get(cell) as T;
  }
  return untracked(() => cell.get());
}

export function recordCommitted(
  container: object,
  values: Map<object, unknown>,
): void {
  committedRoots.set(container, values);
  for (const [cell, value] of values) lastCommitted.set(cell, value);
}

export function isPending<T>(cell: Atom<T> | Computed<T>): boolean {
  return cell.isPending();
}

export function refresh<T>(cell: Atom<T> | Computed<T>): void {
  if (cell instanceof Computed) cell.refresh();
  else notifyViews(writeBatch);
}

export function withWorld<T>(world: RenderWorld, fn: () => T): T {
  const previous = activeWorld;
  activeWorld = world;
  try {
    return fn();
  } finally {
    activeWorld = previous;
  }
}

export function withWriteBatch<T>(batchId: BatchId, fn: () => T): T {
  if (batchId !== 0 && !liveBatches.has(batchId)) {
    liveBatches.set(batchId, {
      atoms: new Set(),
      computeds: new Set(),
      openCause: emitTrace("batch open", undefined, batchId),
    });
  }
  const previous = writeBatch;
  writeBatch = batchId;
  try {
    return fn();
  } finally {
    writeBatch = previous;
  }
}

export function liveBatchIds(cell?: {
  hasDraft(batchId?: BatchId): boolean;
}): BatchId[] {
  const ids: BatchId[] = [];
  for (const [batchId] of liveBatches) {
    if (cell === undefined || cell.hasDraft(batchId)) ids.push(batchId);
  }
  return ids;
}

export function liveBatchMask(cell?: {
  hasDraft(batchId?: BatchId): boolean;
}): number {
  let lanes = 0;
  for (const [batchId] of liveBatches) {
    if (cell === undefined || cell.hasDraft(batchId)) lanes |= batchId;
  }
  return lanes;
}

export function batchCause(batchId: BatchId): number | undefined {
  return liveBatches.get(batchId)?.lastCause;
}

export function retireBatch(batchId: BatchId, commit: boolean): void {
  const live = liveBatches.get(batchId);
  if (live === undefined) return;
  liveBatches.delete(batchId);
  const cause = emitTrace(
    commit ? "batch retire" : "batch discard",
    live.openCause,
    batchId,
  );
  retiring = true;
  try {
    batch(() => {
      for (const cell of live.atoms) cell.retire(batchId, commit);
    });
  } finally {
    retiring = false;
  }
  if (!commit) {
    for (const cell of live.atoms) cell.notifyViews(batchId, cause);
  }
  for (const cell of live.computeds) cell.retireRefresh(batchId, commit);
  notifyViews(batchId, cause);
}

export function subscribeView<T>(
  cell: Atom<T> | Computed<T>,
  subscriber: ViewSubscriber,
): () => void {
  if (cell instanceof Atom) return cell.subscribeView(subscriber);
  viewSubscribers.add(subscriber);
  return () => viewSubscribers.delete(subscriber);
}

export function observeCell<T>(cell: Atom<T> | Computed<T>): () => void {
  const subscriber: Subscriber = { notify() {} };
  cell.add(subscriber);
  return () => cell.remove(subscriber);
}

export function subscribePending<T>(
  cell: Atom<T> | Computed<T>,
  subscriber: () => void,
): () => void {
  return cell.subscribePending(subscriber);
}

export function resetForTest(): void {
  for (const [batchId] of liveBatches) retireBatch(batchId, false);
  viewSubscribers.clear();
  tracers.clear();
}

export function installState<T>(cell: Atom<T>, value: T): void {
  cell.install(value);
}

export function serializeAtomState(
  atoms: readonly Atom<any>[],
  replacer?: Parameters<typeof JSON.stringify>[1],
): string {
  const state: Record<string, unknown> = {};
  for (let index = 0; index < atoms.length; index++) {
    const cell = atoms[index];
    state[cell.key ?? String(index)] = untracked(() => cell.get());
  }
  return JSON.stringify(state, replacer);
}

export function initializeAtomState(
  json: string,
  atoms: readonly Atom<any>[],
  reviver?: Parameters<typeof JSON.parse>[1],
): void {
  const state = JSON.parse(json, reviver) as Record<string, unknown>;
  for (let index = 0; index < atoms.length; index++) {
    const cell = atoms[index];
    const key = cell.key ?? String(index);
    if (Object.hasOwn(state, key)) cell.install(state[key]);
  }
}
