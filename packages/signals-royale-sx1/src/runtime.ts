export type BatchId = number;
export type NodeId = number;

export interface BatchToken {
  id: BatchId;
  deferred: boolean;
  live: boolean;
  committed: boolean;
  rendered?: boolean;
  cause?: number;
}

type Cleanup = void | (() => void);
type Equality<T> = (a: T, b: T) => boolean;
type Operation<T = unknown> = {
  id: number;
  atom: Atom<T>;
  batch: BatchToken | undefined;
  reduce: (value: T) => T;
  afterDraft?: boolean;
  cause?: number;
};

interface World {
  batches: ReadonlySet<BatchToken>;
  root?: object;
}

interface Source {
  id?: NodeId;
  version: number;
  subs: Set<Observer>;
  valueListeners?: Set<SubscriptionRecord>;
  pendingListeners?: Set<SubscriptionRecord>;
  read(): unknown;
  watch(on: boolean): void;
}

interface Observer {
  stale: boolean;
  deps: Map<Source, number>;
  queued: boolean;
  onStale(confirmed?: boolean): void;
}

let nextNode: NodeId = 1;
let nextOperation = 1;
let active: Observer | undefined;
let collecting: Map<Source, number> | undefined;
let collectingNew: Source[] | undefined;
let world: World | undefined;
let batchDepth = 0;
let batchTarget: Atom<unknown> | undefined;
let batchValue: unknown;
let batchVersion = 0;
const batchSnapshots = new Map<Atom<unknown>, { value: unknown; version: number }>();
let flushing = false;
let initializer: Atom<unknown> | undefined;
const effects: Effect[] = [];
const allEffects = new Set<Effect>();
const operations: Operation[] = [];
const rootBatches = new WeakMap<object, Set<BatchToken>>();
const tokenRoots = new Map<BatchToken, Set<Set<BatchToken>>>();
let listenerCount = 0;
let subscriptionGeneration = 0;
const effectFinalizer = new FinalizationRegistry<Effect>((current) => current.dispose());
class SubscriptionRecord {
  live = true;
  private notify?: WeakRef<(cause?: number) => void>;
  private managedNotify?: (cause?: number) => void;

  constructor(
    readonly kind: "value" | "pending",
    readonly target: Source,
    readonly generation: number,
    readonly createdAt: number,
    readonly seenBatches: ReadonlySet<BatchToken> | undefined,
    notify: (cause?: number) => void,
    managed: boolean,
  ) {
    if (managed) this.managedNotify = notify;
    else this.notify = new WeakRef(notify);
  }

  deliver(cause?: number): void {
    (this.managedNotify ?? this.notify?.deref())?.(cause);
  }
}
const cleanupFinalizer = new FinalizationRegistry<SubscriptionRecord>(cleanupSubscription);

function cleanupSubscription(record: SubscriptionRecord): void {
  if (!record.live) return;
  record.live = false;
  if (record.kind === "value") record.target.valueListeners?.delete(record);
  else record.target.pendingListeners?.delete(record);
  if (record.generation === subscriptionGeneration) listenerCount--;
  record.target.watch(false);
}
type TraceRecorder = { ring: TraceEvent[]; capacity: number; overflow: number };
const traceRecorders = new Set<TraceRecorder>();

export function traceEvent(
  kind: string,
  cause?: number,
  source?: { readonly id?: NodeId },
  batch?: BatchToken,
): number {
  if (traceRecorders.size === 0) return 0;
  const id = nextOperation++;
  const event: TraceEvent = { id, kind, cause, node: source?.id, batch: batch?.id };
  for (const recorder of traceRecorders) {
    if (recorder.ring.length === recorder.capacity) {
      recorder.ring.shift();
      recorder.overflow++;
    }
    recorder.ring.push(event);
  }
  return id;
}

function recordEvent(event: TraceEvent): void {
  if (traceRecorders.size === 0) return;
  for (const recorder of traceRecorders) {
    if (recorder.ring.length === recorder.capacity) {
      recorder.ring.shift();
      recorder.overflow++;
    }
    recorder.ring.push(event);
  }
}

function track(source: Source): void {
  if (active !== undefined && collecting !== undefined) {
    if (!collecting.has(source)) collectingNew!.push(source);
    collecting.set(source, source.version);
  }
}

function finishDeps(observer: Observer, added: Source[]): void {
  const wired = !(observer instanceof Computed) || observer.isObserved();
  for (const [source, version] of observer.deps) {
    if (version < 0) {
      if (wired) removeSubscriber(source, observer);
      observer.deps.delete(source);
    }
  }
  if (wired) for (const source of added) addSubscriber(source, observer);
  added.length = 0;
}

function addSubscriber(source: Source, observer: Observer): void {
  const first = source.subs.size === 0;
  source.subs.add(observer);
  if (first && source instanceof Atom) source.observed(true);
  if (first && source instanceof Computed) source.internalObserved(true);
}

function removeSubscriber(source: Source, observer: Observer): void {
  source.subs.delete(observer);
  if (source.subs.size === 0 && source instanceof Atom) source.observed(false);
  if (source.subs.size === 0 && source instanceof Computed) source.internalObserved(false);
}

function invalidate(source: Source, cause?: number, deliver = true): void {
  const confirmed = source instanceof Atom;
  for (const observer of source.subs) observer.onStale(confirmed);
  if (deliver && source.valueListeners !== undefined)
    for (const listener of source.valueListeners) listener.deliver(cause);
  if (source.pendingListeners !== undefined)
    for (const listener of source.pendingListeners) listener.deliver();
  if (traceRecorders.size !== 0)
    recordEvent({ id: nextOperation++, kind: "delivery", cause, node: source.id });
  if (batchDepth === 0 && effects.length !== 0) flushEffects();
}

function needsRun(observer: Observer): boolean {
  const previousActive = active;
  const previousCollecting = collecting;
  const previousCollectingNew = collectingNew;
  active = undefined;
  collecting = undefined;
  collectingNew = undefined;
  try {
    for (const [source, version] of observer.deps) {
      source.read();
      if (source.version !== version) return true;
    }
  } finally {
    active = previousActive;
    collecting = previousCollecting;
    collectingNew = previousCollectingNew;
  }
  return false;
}

function flushEffects(): void {
  if (flushing) return;
  flushing = true;
  let index = 0;
  let passEnd = effects.length;
  let turns = 1;
  try {
    while (index < effects.length) {
      if (index === passEnd) {
        if (++turns > 1000) {
          effects.length = 0;
          throw new Error("Reactive cycle did not converge");
        }
        passEnd = effects.length;
      }
      const effect = effects[index++];
      effect.queued = false;
      if (!effect.disposed && effect.stale) {
        const changed = effect.confirmed || needsRun(effect);
        effect.confirmed = false;
        if (!effect.disposed && changed) effect.run();
        else effect.stale = false;
      }
    }
  } finally {
    effects.length = 0;
    flushing = false;
  }
}

function applies(op: Operation, mode: "canonical" | "latest" | "committed"): boolean {
  const token = op.batch;
  if (token === undefined || !token.deferred || token.committed) return true;
  if (world !== undefined && world.batches.has(token)) return true;
  if (mode === "latest" && world === undefined) return true;
  if (mode === "committed" && world?.root !== undefined) {
    return rootBatches.get(world.root)?.has(token) === true;
  }
  return false;
}

function fold<T>(atom: Atom<T>, mode: "canonical" | "latest" | "committed"): T {
  let value = atom.materialize();
  if (operations.length === 0) return value;
  for (const op of operations) {
    if (
      op.atom === atom &&
      op.batch?.deferred !== true &&
      op.afterDraft !== true &&
      applies(op, mode)
    )
      value = (op as Operation<T>).reduce(value);
  }
  for (const op of operations) {
    if (op.atom === atom && op.batch?.deferred === true && applies(op, mode))
      value = (op as Operation<T>).reduce(value);
  }
  for (const op of operations) {
    if (op.atom === atom && op.afterDraft === true && applies(op, mode))
      value = (op as Operation<T>).reduce(value);
  }
  return value;
}

export interface AtomOptions<T> {
  equals?: Equality<T>;
  label?: string;
  effect?: (ctx: { get(): T; set(value: T): void }) => Cleanup;
}

const defaultAtomOptions: AtomOptions<never> = {};

export class Atom<T> implements Source {
  readonly id = nextNode++;
  readonly subs = new Set<Observer>();
  valueListeners?: Set<SubscriptionRecord>;
  pendingListeners?: Set<SubscriptionRecord>;
  version = 0;
  private ready = false;
  private value!: T;
  private observation?: () => void;
  private observationTicket = 0;
  private externalObservers = 0;

  readonly options: AtomOptions<T>;

  constructor(
    private initial: T | (() => T),
    options?: AtomOptions<T>,
  ) {
    this.options = options ?? (defaultAtomOptions as AtomOptions<T>);
  }

  materialize(): T {
    if (!this.ready) {
      const previous = initializer;
      initializer = this as Atom<unknown>;
      try {
        this.value =
          typeof this.initial === "function" ? untracked(this.initial as () => T) : this.initial;
        this.ready = true;
      } finally {
        initializer = previous;
      }
    }
    return this.value;
  }

  install(value: T): void {
    this.value = value;
    this.ready = true;
  }

  setCheckpoint(value: T): void {
    this.value = value;
  }

  checkpoint(reduce: (value: T) => T): void {
    this.value = reduce(this.materialize());
  }

  read(): T {
    track(this);
    return fold(this, "canonical");
  }

  latest(): T {
    track(this);
    return fold(this, "latest");
  }

  committed(container?: object): T {
    const previous = world;
    if (container !== undefined)
      world = { root: container, batches: rootBatches.get(container) ?? new Set() };
    try {
      return fold(this, "committed");
    } finally {
      world = previous;
    }
  }

  set(value: T, token?: BatchToken): void {
    write(this, undefined, token, value, true);
  }

  update(fn: (value: T) => T, token?: BatchToken): void {
    write(this, fn, token);
  }

  observed(on: boolean): void {
    if (this.options.effect === undefined) return;
    const ticket = ++this.observationTicket;
    Promise.resolve().then(() => {
      if (ticket !== this.observationTicket) return;
      const watched = this.subs.size + this.externalObservers !== 0;
      if (on && watched && this.observation === undefined) {
        this.observation =
          this.options.effect!({ get: () => this.read(), set: (value) => this.set(value) }) ??
          undefined;
      } else if (!on && !watched && this.observation !== undefined) {
        this.observation();
        this.observation = undefined;
      }
    });
  }

  watch(on: boolean): void {
    this.externalObservers += on ? 1 : -1;
    this.observed(on);
  }
}

export interface ComputedOptions<T> {
  equals?: Equality<T>;
  label?: string;
}

const defaultComputedOptions: ComputedOptions<never> = {};

class Pending {
  constructor(readonly promises: PromiseLike<unknown>[]) {}
}

type AsyncRecord =
  | { state: "pending"; promise: PromiseLike<unknown> }
  | { state: "value"; value: unknown }
  | { state: "error"; error: unknown };
const asyncRecords = new WeakMap<object, AsyncRecord>();

function useThenable<T>(promise: PromiseLike<T>): T {
  const key = promise as object;
  let record = asyncRecords.get(key);
  if (record === undefined) {
    record = { state: "pending", promise };
    asyncRecords.set(key, record);
    promise.then(
      (value) => {
        asyncRecords.set(key, { state: "value", value });
        settlePromise(promise);
      },
      (error) => {
        asyncRecords.set(key, { state: "error", error });
        settlePromise(promise);
      },
    );
  }
  if (record.state === "pending") throw new Pending([promise]);
  if (record.state === "error") throw record.error;
  return record.value as T;
}

let pendingPromises: PromiseLike<unknown>[] | undefined;

function captureThenable<T>(promise: PromiseLike<T>): T {
  try {
    return useThenable(promise);
  } catch (error) {
    if (!(error instanceof Pending)) throw error;
    (pendingPromises ??= []).push(...error.promises);
    return undefined as T;
  }
}

const promiseComputeds = new WeakMap<object, Set<Computed<unknown>>>();

function settlePromise(promise: PromiseLike<unknown>): void {
  traceEvent("suspense-settlement");
  const set = promiseComputeds.get(promise as object);
  if (set === undefined) return;
  for (const computed of set) computed.settled(promise);
  flushEffects();
}

export class Computed<T> implements Source, Observer {
  readonly id = nextNode++;
  readonly subs = new Set<Observer>();
  valueListeners?: Set<SubscriptionRecord>;
  pendingListeners?: Set<SubscriptionRecord>;
  deps = new Map<Source, number>();
  private newDeps: Source[] = [];
  version = 0;
  stale = true;
  queued = false;
  private hasValue = false;
  private value!: T;
  private pending?: Pending;
  private error: unknown;
  private evaluating = false;
  private changedWhileEvaluating = false;
  private volatile = false;
  private contextual = false;
  private pendingOwner?: BatchToken;
  private refreshOwner?: BatchToken;
  private externalObservers = 0;

  private options: ComputedOptions<T>;

  constructor(
    private fn: (use: <U>(promise: PromiseLike<U>) => U) => T,
    options?: ComputedOptions<T>,
  ) {
    this.options = options ?? (defaultComputedOptions as ComputedOptions<T>);
  }

  activate(): void {
    for (const source of this.deps.keys()) addSubscriber(source, this);
  }

  deactivate(): void {
    for (const source of this.deps.keys()) removeSubscriber(source, this);
  }

  isObserved(): boolean {
    return this.subs.size + this.externalObservers !== 0;
  }

  internalObserved(on: boolean): void {
    if (this.externalObservers !== 0) return;
    if (on) this.activate();
    else this.deactivate();
  }

  watch(on: boolean): void {
    const observed = this.subs.size + this.externalObservers !== 0;
    this.externalObservers += on ? 1 : -1;
    const nextObserved = this.subs.size + this.externalObservers !== 0;
    if (!observed && nextObserved) this.activate();
    else if (observed && !nextObserved) this.deactivate();
  }

  onStale(): void {
    if (this.evaluating) this.changedWhileEvaluating = true;
    if (this.stale && this.subs.size + this.externalObservers === 0) return;
    this.stale = true;
    for (const observer of this.subs) observer.onStale();
    if (this.valueListeners !== undefined)
      for (const listener of this.valueListeners) listener.deliver();
    if (this.pendingListeners !== undefined)
      for (const listener of this.pendingListeners) listener.deliver();
  }

  changedDuringRun(): void {
    this.changedWhileEvaluating = true;
  }

  settled(settledPromise: PromiseLike<unknown>): void {
    if (!this.pending?.promises.includes(settledPromise)) return;
    for (const promise of this.pending?.promises ?? []) {
      if (asyncRecords.get(promise as object)?.state === "pending") return;
    }
    const owner = this.pendingOwner;
    if (owner === undefined) this.onStale();
    else hostRuntime?.runInBatch?.(owner, () => this.onStale());
  }

  refresh(token?: BatchToken): void {
    this.refreshOwner = token;
    this.onStale();
  }

  private evaluate(): void {
    if (this.evaluating) throw new Error("Reactive cycle detected");
    this.evaluating = true;
    this.changedWhileEvaluating = false;
    this.contextual = false;
    const previousActive = active;
    const previousCollecting = collecting;
    const previousCollectingNew = collectingNew;
    const previousPendingPromises = pendingPromises;
    for (const [source, version] of this.deps) this.deps.set(source, -version - 1);
    active = this;
    collecting = this.deps;
    collectingNew = this.newDeps;
    pendingPromises = undefined;
    let result!: T;
    let failure: unknown;
    let pending: PromiseLike<unknown>[] | undefined;
    try {
      result = this.fn(captureThenable);
    } catch (error) {
      failure = error;
    } finally {
      pending = pendingPromises;
      pendingPromises = previousPendingPromises;
      active = previousActive;
      collecting = previousCollecting;
      collectingNew = previousCollectingNew;
      this.evaluating = false;
    }
    if (pending !== undefined) failure = new Pending(pending);
    finishDeps(this, this.newDeps);
    this.volatile = this.changedWhileEvaluating;
    this.stale = this.volatile;
    this.pending = failure instanceof Pending ? failure : undefined;
    this.error = failure instanceof Pending ? undefined : failure;
    if (this.pending !== undefined) {
      this.pendingOwner = this.refreshOwner;
      for (const token of world?.batches ?? []) if (token.deferred) this.pendingOwner = token;
      this.refreshOwner = undefined;
      for (const promise of this.pending.promises) {
        let set = promiseComputeds.get(promise as object);
        if (set === undefined) promiseComputeds.set(promise as object, (set = new Set()));
        set.add(this as Computed<unknown>);
      }
      return;
    }
    if (failure !== undefined) return;
    this.pendingOwner = undefined;
    if (!this.hasValue || !(this.options.equals ?? Object.is)(this.value, result)) {
      this.value = result;
      this.hasValue = true;
      this.version++;
    }
  }

  read(): T {
    if (
      (this.stale || this.subs.size + this.externalObservers === 0) &&
      this.hasValue &&
      !this.volatile &&
      !this.contextual &&
      world === undefined
    ) {
      let changed = false;
      const previousActive = active;
      const previousCollecting = collecting;
      const previousCollectingNew = collectingNew;
      active = undefined;
      collecting = undefined;
      collectingNew = undefined;
      try {
        for (const [source, version] of this.deps) {
          source.read();
          if (source.version !== version) {
            changed = true;
            break;
          }
        }
      } finally {
        active = previousActive;
        collecting = previousCollecting;
        collectingNew = previousCollectingNew;
      }
      this.stale = changed;
    }
    let deferredWorld = false;
    if (world !== undefined) {
      for (const token of world.batches) if (token.deferred) deferredWorld = true;
    }
    if (this.stale || deferredWorld) this.evaluate();
    track(this);
    if (this.pending !== undefined) {
      if (!this.hasValue || deferredWorld) {
        throw this.pending.promises.length === 1
          ? this.pending.promises[0]
          : Promise.all(this.pending.promises);
      }
    }
    if (this.error !== undefined) throw this.error;
    if (deferredWorld) {
      this.contextual = true;
      this.stale = true;
    }
    return this.value;
  }

  isPending(): boolean {
    if (this.stale) {
      try {
        this.evaluate();
      } catch {}
    }
    return this.pending !== undefined;
  }
}

class Effect implements Observer {
  deps = new Map<Source, number>();
  private newDeps: Source[] = [];
  stale = true;
  queued = false;
  confirmed = false;
  disposed = false;
  private cleanup?: () => void;
  readonly children: Effect[] = [];

  constructor(private fn: () => Cleanup) {
    allEffects.add(this);
  }

  onStale(confirmed = false): void {
    if (this.disposed) return;
    this.stale = true;
    this.confirmed ||= confirmed;
    if (!this.queued) {
      this.queued = true;
      effects.push(this);
    }
  }

  run(): void {
    traceEvent("effect-run");
    for (const child of this.children) child.dispose();
    this.children.length = 0;
    const cleanup = this.cleanup;
    this.cleanup = undefined;
    if (cleanup !== undefined) {
      try {
        untracked(cleanup);
      } catch (error) {
        this.dispose();
        throw error;
      }
    }
    const previousActive = active;
    const previousCollecting = collecting;
    const previousCollectingNew = collectingNew;
    const previousEffect = runningEffect;
    for (const [source, version] of this.deps) this.deps.set(source, -version - 1);
    active = this;
    collecting = this.deps;
    collectingNew = this.newDeps;
    runningEffect = this;
    this.stale = false;
    try {
      this.cleanup = this.fn() ?? undefined;
    } finally {
      active = previousActive;
      collecting = previousCollecting;
      collectingNew = previousCollectingNew;
      runningEffect = previousEffect;
      finishDeps(this, this.newDeps);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    allEffects.delete(this);
    for (const child of this.children) child.dispose();
    this.children.length = 0;
    this.queued = false;
    for (const source of this.deps.keys()) removeSubscriber(source, this);
    this.deps.clear();
    const cleanup = this.cleanup;
    this.cleanup = undefined;
    if (cleanup !== undefined) untracked(cleanup);
  }
}

let scope: Effect[] | undefined;
let runningEffect: Effect | undefined;

export function atom<T>(initial: T | (() => T), options?: AtomOptions<T>): Atom<T> {
  return new Atom(initial, options);
}

export function computed<T>(
  fn: (use: <U>(promise: PromiseLike<U>) => U) => T,
  options?: ComputedOptions<T>,
): Computed<T> {
  return new Computed(fn, options);
}

export function effect(fn: () => Cleanup): () => void {
  const current = new Effect(fn);
  scope?.push(current);
  runningEffect?.children.push(current);
  current.run();
  const dispose = () => {
    effectFinalizer.unregister(dispose);
    current.dispose();
  };
  if (scope === undefined && runningEffect === undefined)
    effectFinalizer.register(dispose, current, dispose);
  return dispose;
}

export function effectScope(fn: () => void): () => void {
  const previous = scope;
  const owned: Effect[] = [];
  scope = owned;
  try {
    fn();
  } finally {
    scope = previous;
  }
  return () => {
    for (const current of owned) current.dispose();
  };
}

export function startBatch(): void {
  if (batchDepth === 0) {
    batchTarget = undefined;
    batchSnapshots.clear();
  }
  batchDepth++;
}

export function endBatch(): void {
  if (--batchDepth === 0) {
    if (batchTarget !== undefined) {
      if ((batchTarget.options.equals ?? Object.is)(batchTarget.read(), batchValue)) {
        batchTarget.version = batchVersion;
        for (const observer of batchTarget.subs) {
          if (observer instanceof Effect && observer.confirmed && !needsRun(observer))
            observer.confirmed = false;
        }
      }
    }
    for (const [target, snapshot] of batchSnapshots) {
      if ((target.options.equals ?? Object.is)(target.read(), snapshot.value)) {
        target.version = snapshot.version;
        for (const observer of target.subs) {
          if (observer instanceof Effect && observer.confirmed && !needsRun(observer))
            observer.confirmed = false;
        }
      }
    }
    batchTarget = undefined;
    batchSnapshots.clear();
    flushEffects();
  }
}

export function batch(fn: () => void): void {
  startBatch();
  try {
    fn();
  } finally {
    endBatch();
  }
}

export function untracked<T>(fn: () => T): T {
  const previousActive = active;
  const previousCollecting = collecting;
  active = undefined;
  collecting = undefined;
  try {
    return fn();
  } finally {
    active = previousActive;
    collecting = previousCollecting;
  }
}

let currentBatch: (() => BatchToken | undefined) | undefined;

function write<T>(
  target: Atom<T>,
  reduce: ((value: T) => T) | undefined,
  token = currentBatch?.(),
  value?: T,
  direct = false,
): void {
  if (initializer !== undefined) throw new Error("A lazy initializer must not write signals");
  if (hostRuntime?.isRendering?.() === true)
    throw new Error("Signals must not be written while React is rendering");
  const before = fold(target, token?.deferred === true ? "latest" : "canonical");
  const trackedVersion = collecting?.get(target);
  if (active instanceof Computed && trackedVersion !== undefined && trackedVersion >= 0)
    active.changedDuringRun();
  if (batchDepth !== 0 && target !== batchTarget && !batchSnapshots.has(target as Atom<unknown>)) {
    if (batchTarget === undefined) {
      batchTarget = target as Atom<unknown>;
      batchValue = before;
      batchVersion = target.version;
    } else {
      batchSnapshots.set(target as Atom<unknown>, { value: before, version: target.version });
    }
  }
  const after = direct ? (value as T) : reduce!(before);
  let hasDraft = false;
  let renderedDraft = false;
  for (const op of operations) {
    if (op.atom === target && op.batch?.deferred === true && !op.batch.committed) {
      hasDraft = true;
      renderedDraft ||= op.batch.rendered === true;
    }
  }
  if (!hasDraft && (target.options.equals ?? Object.is)(before, after)) return;
  const id = nextOperation++;
  const parent = token?.cause;
  if (traceRecorders.size !== 0)
    recordEvent({ id, kind: "write", cause: parent, node: target.id, batch: token?.id });
  if (token !== undefined) token.cause = id;
  if (token?.deferred === true) {
    operations.push({
      id,
      atom: target,
      batch: token,
      reduce: direct ? () => value as T : reduce!,
    } as Operation);
  } else if (renderedDraft) {
    operations.push({
      id,
      atom: target,
      batch: undefined,
      reduce: direct ? () => value as T : reduce!,
      afterDraft: true,
    } as Operation);
    target.version++;
  } else {
    target.setCheckpoint(after);
    target.version++;
  }
  invalidate(target, id);
}

export function read<T>(target: Atom<T> | Computed<T>): T {
  return target.read();
}

export function latest<T>(target: Atom<T> | Computed<T>): T {
  if (target instanceof Atom) return target.latest();
  if (world !== undefined) return target.read();
  const batches = new Set<BatchToken>();
  for (const op of operations) if (op.batch?.deferred && op.batch.live) batches.add(op.batch);
  return withWorld(batches, undefined, () => target.read());
}

export function committed<T>(target: Atom<T> | Computed<T>, container?: object): T {
  if (target instanceof Atom) return target.committed(container);
  if (container === undefined) return target.read();
  return withWorld(rootBatches.get(container) ?? new Set(), container, () => target.read());
}

export function installState<T>(target: Atom<T>, value: T): void {
  target.install(value);
}

export function isPending<T>(target: Atom<T> | Computed<T>): boolean {
  if (target instanceof Computed) return target.isPending();
  for (const op of operations)
    if (op.atom === target && op.batch?.deferred && !op.batch.committed) return true;
  return false;
}

export function refresh<T>(target: Atom<T> | Computed<T>): void {
  if (target instanceof Computed) target.refresh(currentBatch?.());
  else invalidate(target);
}

export function subscribe<T>(
  target: Atom<T> | Computed<T>,
  notify: (cause?: number) => void,
  seenBatches?: ReadonlySet<BatchToken>,
  managed = false,
): () => void {
  const record = new SubscriptionRecord(
    "value",
    target,
    subscriptionGeneration,
    nextOperation,
    seenBatches,
    notify,
    managed,
  );
  (target.valueListeners ??= new Set()).add(record);
  listenerCount++;
  target.watch(true);
  const dispose = () => {
    void notify;
    cleanupFinalizer.unregister(dispose);
    cleanupSubscription(record);
  };
  if (!managed) cleanupFinalizer.register(dispose, record, dispose);
  return dispose;
}

export function subscribePending<T>(target: Atom<T> | Computed<T>, notify: () => void): () => void {
  const record = new SubscriptionRecord(
    "pending",
    target,
    subscriptionGeneration,
    nextOperation,
    undefined,
    notify,
    false,
  );
  (target.pendingListeners ??= new Set()).add(record);
  listenerCount++;
  target.watch(true);
  const dispose = () => {
    void notify;
    cleanupFinalizer.unregister(dispose);
    cleanupSubscription(record);
  };
  cleanupFinalizer.register(dispose, record, dispose);
  return dispose;
}

export interface HostRuntime {
  currentBatch(): BatchToken | undefined;
  isRendering?(): boolean;
  runInBatch?<T>(token: BatchToken, fn: () => T): T;
}

let hostRuntime: HostRuntime | undefined;

export function installHost(host?: HostRuntime): void {
  hostRuntime = host;
  currentBatch = host?.currentBatch;
}

export function withWorld<T>(
  batches: ReadonlySet<BatchToken>,
  root: object | undefined,
  fn: () => T,
): T {
  const previous = world;
  world = { batches, root };
  try {
    return fn();
  } finally {
    world = previous;
  }
}

export function commitRoot(root: object, committed: readonly BatchToken[]): void {
  let set = rootBatches.get(root);
  if (set === undefined) rootBatches.set(root, (set = new Set()));
  for (const token of committed) {
    set.add(token);
    if (traceRecorders.size !== 0) {
      for (const op of operations) {
        if (op.batch === token) {
          recordEvent({
            id: nextOperation++,
            kind: "component-delivery",
            cause: op.id,
            node: op.atom.id,
          });
        }
      }
    }
    let roots = tokenRoots.get(token);
    if (roots === undefined) tokenRoots.set(token, (roots = new Set()));
    roots.add(set);
  }
}

export function retireBatch(token: BatchToken, didCommit: boolean): void {
  traceEvent("batch-retire", token.cause, undefined, token);
  token.live = false;
  token.committed = didCommit;
  const touched = new Map<Atom<unknown>, number>();
  for (let index = 0; index < operations.length; ) {
    const op = operations[index];
    if (op.batch === token) {
      if (!touched.has(op.atom)) touched.set(op.atom, op.id);
      if (didCommit) op.atom.checkpoint(op.reduce);
      operations.splice(index, 1);
    } else {
      index++;
    }
  }
  for (const set of tokenRoots.get(token) ?? []) set.delete(token);
  tokenRoots.delete(token);
  for (const [target] of touched) {
    let draftRemains = false;
    for (const op of operations) {
      if (op.atom === target && op.batch?.deferred && !op.batch.committed) {
        draftRemains = true;
        break;
      }
    }
    if (!draftRemains) {
      for (let index = 0; index < operations.length; ) {
        const op = operations[index];
        if (op.atom === target && op.afterDraft) {
          target.checkpoint(op.reduce);
          operations.splice(index, 1);
        } else {
          index++;
        }
      }
    }
  }
  if (token.deferred) {
    for (const [target, draftStart] of touched) {
      target.version++;
      invalidate(target, token.cause, !didCommit);
      if (didCommit && target.valueListeners !== undefined) {
        for (const listener of target.valueListeners) {
          if (listener.createdAt > draftStart && listener.seenBatches?.has(token) !== true)
            listener.deliver(token.cause);
        }
      }
    }
  }
}

export function serializeAtomState(
  targets: readonly Atom<unknown>[],
  replacer?: (key: string, value: unknown) => unknown,
): string {
  const values: Record<string, unknown> = {};
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    const key = target.options.label ?? String(index);
    values[key] = target.read();
  }
  return JSON.stringify(values, replacer);
}

export function initializeAtomState(
  json: string,
  targets: readonly Atom<unknown>[],
  reviver?: (key: string, value: unknown) => unknown,
): void {
  const values = JSON.parse(json, reviver) as Record<string, unknown>;
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    const key = target.options.label ?? String(index);
    if (Object.prototype.hasOwnProperty.call(values, key)) target.install(values[key]);
  }
}

export type TraceEvent = {
  id: number;
  kind: string;
  cause?: number;
  node?: NodeId;
  batch?: BatchId;
};

export interface Trace {
  events(): TraceEvent[];
  whyLastDelivery(target: unknown): string[];
  stop(): void;
}

export function trace(capacity = 1024): Trace {
  const recorder: TraceRecorder = { ring: [], capacity, overflow: 0 };
  traceRecorders.add(recorder);
  return {
    events: () =>
      recorder.overflow === 0
        ? recorder.ring.slice()
        : [{ id: 0, kind: `overflow:${recorder.overflow}` }, ...recorder.ring],
    whyLastDelivery(target) {
      const node = target instanceof Atom || target instanceof Computed ? target.id : undefined;
      let found: TraceEvent | undefined;
      for (let index = recorder.ring.length - 1; index >= 0; index--) {
        const event = recorder.ring[index];
        if (event.node === node && event.kind.includes("delivery")) {
          found = event;
          break;
        }
      }
      if (found === undefined) return [];
      const chain: string[] = [];
      let current: TraceEvent | undefined = found;
      while (current !== undefined) {
        chain.push(`${current.kind}#${current.id}`);
        current =
          current.cause === undefined
            ? undefined
            : recorder.ring.find((event) => event.id === current!.cause);
      }
      return chain;
    },
    stop: () => traceRecorders.delete(recorder),
  };
}

export function reset(): void {
  for (const current of [...allEffects]) current.dispose();
  effects.length = 0;
  allEffects.clear();
  operations.length = 0;
  traceRecorders.clear();
  listenerCount = 0;
  subscriptionGeneration++;
  nextNode = 1;
  nextOperation = 1;
  active = undefined;
  collecting = undefined;
  collectingNew = undefined;
  world = undefined;
  batchDepth = 0;
  batchTarget = undefined;
  batchSnapshots.clear();
  hostRuntime = undefined;
  currentBatch = undefined;
}

export const __debug = {
  operations,
  listenerCount: () => listenerCount,
};
