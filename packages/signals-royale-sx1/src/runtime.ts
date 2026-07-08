export type BatchId = number;
export type NodeId = number;

export interface BatchToken {
  id: BatchId;
  deferred: boolean;
  live: boolean;
  committed: boolean;
  cause?: number;
}

type Cleanup = void | (() => void);
type Equality<T> = (a: T, b: T) => boolean;
type Operation<T = unknown> = {
  id: number;
  atom: Atom<T>;
  batch: BatchToken | undefined;
  reduce: (value: T) => T;
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
  read(): unknown;
}

interface Observer {
  stale: boolean;
  deps: Map<Source, number>;
  queued: boolean;
  onStale(): void;
}

let nextNode: NodeId = 1;
let nextOperation = 1;
let active: Observer | undefined;
let collecting: Map<Source, number> | undefined;
let world: World | undefined;
let batchDepth = 0;
let batchSnapshots: Map<Atom<unknown>, { value: unknown; version: number }> | undefined;
let flushing = false;
let initializer: Atom<unknown> | undefined;
const effects = new Set<Effect>();
const allEffects = new Set<Effect>();
const operations: Operation[] = [];
const atoms = new Map<NodeId, WeakRef<Atom<unknown>>>();
const rootBatches = new WeakMap<object, Set<BatchToken>>();
const tokenRoots = new Map<BatchToken, Set<Set<BatchToken>>>();
const listeners = new Set<(node: Source, cause?: number) => void>();
const pendingListeners = new Set<(node: Source) => void>();
const effectFinalizer = new FinalizationRegistry<Effect>((current) => current.dispose());
class SubscriptionRecord {
  readonly listener = (source: Source, cause?: number): void => {
    if (source === this.target) this.notify.deref()?.(cause);
  };
  private notify: WeakRef<(cause?: number) => void>;

  constructor(
    readonly kind: "value" | "pending",
    readonly target: Source,
    notify: (cause?: number) => void,
  ) {
    this.notify = new WeakRef(notify);
  }
}
const cleanupFinalizer = new FinalizationRegistry<SubscriptionRecord>(cleanupSubscription);

function cleanupSubscription(record: SubscriptionRecord): void {
  if (record.kind === "value") listeners.delete(record.listener);
  else pendingListeners.delete(record.listener);
  if (record.target instanceof Atom) record.target.watch(false);
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
  if (active !== undefined && collecting !== undefined) collecting.set(source, source.version);
}

function replaceDeps(observer: Observer, next: Map<Source, number>): void {
  const wired = !(observer instanceof Computed) || observer.subs.size !== 0;
  for (const source of observer.deps.keys()) {
    if (wired && !next.has(source)) removeSubscriber(source, observer);
  }
  for (const source of next.keys()) {
    if (wired && !observer.deps.has(source)) addSubscriber(source, observer);
  }
  observer.deps = next;
}

function addSubscriber(source: Source, observer: Observer): void {
  const first = source.subs.size === 0;
  source.subs.add(observer);
  if (first && source instanceof Atom) source.observed(true);
  if (first && source instanceof Computed) source.activate();
}

function removeSubscriber(source: Source, observer: Observer): void {
  source.subs.delete(observer);
  if (source.subs.size === 0 && source instanceof Atom) source.observed(false);
  if (source.subs.size === 0 && source instanceof Computed) source.deactivate();
}

function invalidate(source: Source, cause?: number, deliver = true): void {
  for (const observer of source.subs) observer.onStale();
  if (deliver) for (const listener of listeners) listener(source, cause);
  for (const listener of pendingListeners) listener(source);
  if (traceRecorders.size !== 0)
    recordEvent({ id: nextOperation++, kind: "delivery", cause, node: source.id });
  if (batchDepth === 0) flushEffects();
}

function needsRun(observer: Observer): boolean {
  for (const [source, version] of observer.deps) {
    untracked(() => source.read());
    if (source.version !== version) return true;
  }
  return false;
}

function flushEffects(): void {
  if (flushing) return;
  flushing = true;
  let turns = 0;
  try {
    while (effects.size !== 0) {
      if (++turns > 1000) {
        effects.clear();
        throw new Error("Reactive cycle did not converge");
      }
      const pending = [...effects];
      effects.clear();
      for (const effect of pending) {
        effect.queued = false;
        if (!effect.disposed && effect.stale) {
          const changed = needsRun(effect);
          if (!effect.disposed && changed) effect.run();
          else effect.stale = false;
        }
      }
    }
  } finally {
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
  for (const op of operations) {
    if (op.atom === atom && op.batch?.deferred !== true && applies(op, mode))
      value = (op as Operation<T>).reduce(value);
  }
  for (const op of operations) {
    if (op.atom === atom && op.batch?.deferred === true && applies(op, mode))
      value = (op as Operation<T>).reduce(value);
  }
  return value;
}

export interface AtomOptions<T> {
  equals?: Equality<T>;
  label?: string;
  effect?: (ctx: { get(): T; set(value: T): void }) => Cleanup;
}

export class Atom<T> implements Source {
  readonly id = nextNode++;
  readonly subs = new Set<Observer>();
  version = 0;
  private ready = false;
  private value!: T;
  private observation?: () => void;
  private observationTicket = 0;
  private externalObservers = 0;

  constructor(
    private initial: T | (() => T),
    readonly options: AtomOptions<T> = {},
  ) {
    atoms.set(this.id, new WeakRef(this as Atom<unknown>));
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
    write(this, () => value, token);
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
  deps = new Map<Source, number>();
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

  constructor(
    private fn: (use: <U>(promise: PromiseLike<U>) => U) => T,
    private options: ComputedOptions<T> = {},
  ) {}

  activate(): void {
    for (const source of this.deps.keys()) addSubscriber(source, this);
  }

  deactivate(): void {
    for (const source of this.deps.keys()) removeSubscriber(source, this);
  }

  onStale(): void {
    if (this.evaluating) this.changedWhileEvaluating = true;
    if (this.stale && this.subs.size === 0) return;
    this.stale = true;
    for (const observer of this.subs) observer.onStale();
    for (const listener of listeners) listener(this);
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
    const next = new Map<Source, number>();
    active = this;
    collecting = next;
    let result!: T;
    let failure: unknown;
    const pending: PromiseLike<unknown>[] = [];
    try {
      result = this.fn(<U>(promise: PromiseLike<U>): U => {
        try {
          return useThenable(promise);
        } catch (error) {
          if (!(error instanceof Pending)) throw error;
          pending.push(...error.promises);
          return undefined as U;
        }
      });
    } catch (error) {
      failure = error;
    } finally {
      active = previousActive;
      collecting = previousCollecting;
      this.evaluating = false;
    }
    if (pending.length !== 0) failure = new Pending(pending);
    replaceDeps(this, next);
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
      (this.stale || this.subs.size === 0) &&
      this.hasValue &&
      !this.volatile &&
      !this.contextual &&
      world === undefined
    ) {
      let changed = false;
      for (const [source, version] of this.deps) {
        untracked(() => source.read());
        if (source.version !== version) {
          changed = true;
          break;
        }
      }
      this.stale = changed;
    }
    let deferredWorld = false;
    for (const token of world?.batches ?? []) if (token.deferred) deferredWorld = true;
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
  stale = true;
  queued = false;
  disposed = false;
  private cleanup?: () => void;
  readonly children: Effect[] = [];

  constructor(private fn: () => Cleanup) {
    allEffects.add(this);
  }

  onStale(): void {
    if (this.disposed) return;
    this.stale = true;
    if (!this.queued) {
      this.queued = true;
      effects.add(this);
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
    const previousEffect = runningEffect;
    const next = new Map<Source, number>();
    active = this;
    collecting = next;
    runningEffect = this;
    this.stale = false;
    try {
      this.cleanup = this.fn() ?? undefined;
    } finally {
      active = previousActive;
      collecting = previousCollecting;
      runningEffect = previousEffect;
      replaceDeps(this, next);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    allEffects.delete(this);
    for (const child of this.children) child.dispose();
    this.children.length = 0;
    effects.delete(this);
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
  if (batchDepth === 0) batchSnapshots = new Map();
  batchDepth++;
}

export function endBatch(): void {
  if (--batchDepth === 0) {
    for (const [target, snapshot] of batchSnapshots!) {
      if ((target.options.equals ?? Object.is)(target.read(), snapshot.value))
        target.version = snapshot.version;
    }
    batchSnapshots = undefined;
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

function write<T>(target: Atom<T>, reduce: (value: T) => T, token = currentBatch?.()): void {
  if (initializer !== undefined) throw new Error("A lazy initializer must not write signals");
  if (hostRuntime?.isRendering?.() === true)
    throw new Error("Signals must not be written while React is rendering");
  const before = fold(target, token?.deferred === true ? "latest" : "canonical");
  if (active instanceof Computed && collecting?.has(target)) active.changedDuringRun();
  if (batchSnapshots !== undefined && !batchSnapshots.has(target as Atom<unknown>)) {
    batchSnapshots.set(target as Atom<unknown>, { value: before, version: target.version });
  }
  const after = reduce(before);
  let hasDraft = false;
  for (const op of operations) {
    if (op.atom === target && op.batch?.deferred === true && !op.batch.committed) {
      hasDraft = true;
      break;
    }
  }
  if (!hasDraft && (target.options.equals ?? Object.is)(before, after)) return;
  const id = nextOperation++;
  const parent = token?.cause;
  recordEvent({ id, kind: "write", cause: parent, node: target.id, batch: token?.id });
  if (token !== undefined) token.cause = id;
  if (token?.deferred === true) {
    operations.push({ id, atom: target, batch: token, reduce } as Operation);
  } else {
    target.checkpoint(() => after);
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
): () => void {
  const record = new SubscriptionRecord("value", target, notify);
  listeners.add(record.listener);
  if (target instanceof Atom) target.watch(true);
  const dispose = () => {
    void notify;
    cleanupFinalizer.unregister(dispose);
    cleanupSubscription(record);
  };
  cleanupFinalizer.register(dispose, record, dispose);
  return dispose;
}

export function subscribePending<T>(target: Atom<T> | Computed<T>, notify: () => void): () => void {
  const record = new SubscriptionRecord("pending", target, notify);
  pendingListeners.add(record.listener);
  if (target instanceof Atom) target.watch(true);
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
  const touched = new Set<Atom<unknown>>();
  for (let index = 0; index < operations.length; ) {
    const op = operations[index];
    if (op.batch === token) {
      touched.add(op.atom);
      if (didCommit) op.atom.checkpoint(op.reduce);
      operations.splice(index, 1);
    } else {
      index++;
    }
  }
  for (const set of tokenRoots.get(token) ?? []) set.delete(token);
  tokenRoots.delete(token);
  if (token.deferred) {
    for (const target of touched) {
      target.version++;
      invalidate(target, token.cause, !didCommit);
    }
  }
}

export function serializeAtomState(
  targets: readonly Atom<unknown>[],
  replacer?: (key: string, value: unknown) => unknown,
): string {
  const values: Record<string, unknown> = {};
  for (const target of targets) {
    const key = target.options.label;
    if (key === undefined) throw new Error("serializeAtomState requires a label on every atom");
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
  for (const target of targets) {
    const key = target.options.label;
    if (key !== undefined && Object.prototype.hasOwnProperty.call(values, key))
      target.install(values[key]);
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
      const found = recorder.ring.findLast(
        (event) => event.node === node && event.kind.includes("delivery"),
      );
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
  effects.clear();
  allEffects.clear();
  operations.length = 0;
  atoms.clear();
  traceRecorders.clear();
  pendingListeners.clear();
  nextNode = 1;
  nextOperation = 1;
  active = undefined;
  collecting = undefined;
  world = undefined;
  batchDepth = 0;
  batchSnapshots = undefined;
  hostRuntime = undefined;
  currentBatch = undefined;
}

export const __debug = {
  operations,
  atoms,
  listenerCount: () => listeners.size + pendingListeners.size,
};
