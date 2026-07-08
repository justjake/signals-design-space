export type BatchId = number;

export interface RuntimeEvent {
  kind: string;
  subject?: unknown;
  batchId?: BatchId;
  committed?: boolean;
}

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

interface Subscriber {
  invalidate(cause?: number): void;
}

abstract class Node<T> {
  readonly subscribers = new Set<Subscriber>();
  version = 0;

  constructor(readonly runtime: Runtime, readonly label?: string) {}

  abstract get(): T;
  abstract current(): unknown;

  add(subscriber: Subscriber): void {
    const wasEmpty = this.subscribers.size === 0;
    this.subscribers.add(subscriber);
    if (wasEmpty && this.subscribers.size !== 0) this.observed(true);
  }

  remove(subscriber: Subscriber): void {
    if (!this.subscribers.delete(subscriber)) return;
    if (this.subscribers.size === 0) this.observed(false);
  }

  protected observed(_value: boolean): void {}

  protected changed(cause?: number): void {
    for (const subscriber of this.subscribers) subscriber.invalidate(cause);
  }
}

interface Tracker extends Subscriber {
  collecting: Set<Node<unknown>>;
  collectedValues: Map<Node<unknown>, unknown>;
}

class Scope {
  readonly reactions: Reaction[] = [];

  dispose(): void {
    let error: unknown;
    for (let i = this.reactions.length - 1; i >= 0; --i) {
      try {
        this.reactions[i].dispose();
      } catch (caught) {
        error ??= caught;
      }
    }
    this.reactions.length = 0;
    void error;
  }
}

type AtomInitial<T> = T | (() => T);

export class Atom<T> extends Node<T> {
  readonly equals: (a: T, b: T) => boolean;
  readonly key?: string;
  private initial: AtomInitial<T> | undefined;
  private value!: T;
  private ready = false;
  private observationCleanup: (() => void) | undefined;
  private observationWanted = false;

  constructor(runtime: Runtime, initial: AtomInitial<T>, options: AtomOptions<T> = {}) {
    super(runtime, options.label);
    this.initial = initial;
    this.equals = options.equals ?? Object.is;
    this.effect = options.effect;
    this.key = options.key;
  }

  private readonly effect?: AtomOptions<T>['effect'];

  materialize(): T {
    if (!this.ready) {
      const initial = this.initial as AtomInitial<T>;
      this.initial = undefined;
      if (typeof initial === 'function') {
        ++this.runtime.writesForbidden;
        try {
          this.value = (initial as () => T)();
        } finally {
          --this.runtime.writesForbidden;
        }
      } else {
        this.value = initial;
      }
      this.ready = true;
    }
    return this.value;
  }

  get(): T {
    this.runtime.track(this);
    return this.runtime.readAtom(this);
  }

  current(): unknown {
    return this.peek();
  }

  set(value: T): void {
    this.runtime.write(this, () => value);
  }

  update(update: (previous: T) => T): void {
    this.runtime.write(this, update);
  }

  apply(update: (previous: T) => T, cause?: number): boolean {
    const previous = this.materialize();
    const value = update(previous);
    if (this.equals(previous, value)) return false;
    this.value = value;
    ++this.version;
    this.changed(cause);
    return true;
  }

  notify(cause?: number): void {
    this.changed(cause);
  }

  install(value: T): void {
    this.initial = undefined;
    this.value = value;
    this.ready = true;
  }

  peek(): T {
    return this.materialize();
  }

  protected observed(value: boolean): void {
    if (this.effect === undefined) return;
    this.observationWanted = value;
    this.runtime.queueObservation(this as Atom<unknown>);
  }

  syncObservation(): void {
    if (this.observationWanted === (this.observationCleanup !== undefined)) return;
    if (this.observationWanted) {
      const cleanup = this.effect?.({ get: () => this.peek(), set: (value) => this.set(value) });
      this.observationCleanup = typeof cleanup === 'function' ? cleanup : () => {};
    } else {
      this.observationCleanup?.();
      this.observationCleanup = undefined;
    }
  }
}

class Reaction extends Scope implements Tracker {
  readonly collecting = new Set<Node<unknown>>();
  readonly collectedValues = new Map<Node<unknown>, unknown>();
  readonly dependencies = new Set<Node<unknown>>();
  readonly dependencyValues = new Map<Node<unknown>, unknown>();
  scheduled = false;
  active = true;
  private cleanup: (() => void) | undefined;
  private firstRun = true;

  constructor(
    private readonly runtime: Runtime,
    private readonly fn: () => void | (() => void),
  ) {
    super();
  }

  invalidate(cause?: number): void {
    if (!this.active || this.scheduled) return;
    this.scheduled = true;
    this.runtime.scheduleReaction(this, cause);
  }

  shouldRun(): boolean {
    if (this.firstRun) return true;
    for (const dependency of this.dependencies) {
      if (dependency instanceof Computed) dependency.refresh();
      if (!Object.is(dependency.current(), this.dependencyValues.get(dependency))) return true;
    }
    return false;
  }

  run(): void {
    this.scheduled = false;
    if (!this.active || !this.shouldRun() || !this.active) return;
    this.firstRun = false;
    this.runtime.emitDebug({ kind: 'effect-run', subject: this });
    this.runtime.untracked(() => super.dispose());
    this.runtime.untracked(() => this.cleanup?.());
    this.cleanup = undefined;
    this.collecting.clear();
    this.collectedValues.clear();
    const cleanup = this.runtime.evaluate(this, this.fn, this);
    if (typeof cleanup === 'function') this.cleanup = cleanup;
    for (const dependency of this.dependencies) {
      if (!this.collecting.has(dependency)) dependency.remove(this);
    }
    for (const dependency of this.collecting) {
      if (!this.dependencies.has(dependency)) dependency.add(this);
    }
    this.dependencies.clear();
    this.dependencyValues.clear();
    for (const dependency of this.collecting) {
      this.dependencies.add(dependency);
      this.dependencyValues.set(dependency, this.collectedValues.get(dependency));
    }
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    let error: unknown;
    try {
      this.runtime.untracked(() => super.dispose());
    } catch (caught) {
      error = caught;
    }
    try {
      this.runtime.untracked(() => this.cleanup?.());
    } catch (caught) {
      error ??= caught;
    }
    this.cleanup = undefined;
    for (const dependency of this.dependencies) dependency.remove(this);
    this.dependencies.clear();
    this.collecting.clear();
    this.collectedValues.clear();
    if (error !== undefined) throw error;
  }
}

const effectFinalizer = new FinalizationRegistry<Reaction>((reaction) => {
  try {
    reaction.dispose();
  } catch {
    // Finalizers cannot report cleanup failures to a caller.
  }
});

class Watcher implements Subscriber {
  scheduled = false;
  cause: number | undefined;
  active = true;

  constructor(
    readonly runtime: Runtime,
    readonly node: Node<unknown>,
    readonly callback: (batchId?: number) => void,
  ) {}

  invalidate(cause?: number): void {
    if (!this.active) return;
    if (this.runtime.suppressWatchers) return;
    if (this.scheduled) {
      if (this.runtime.isDeferredBatch(this.cause) && !this.runtime.isDeferredBatch(cause)) {
        this.cause = cause;
      }
      return;
    }
    this.cause = cause;
    this.scheduled = true;
    this.runtime.scheduleWatcher(this);
  }

  deliver(): void {
    this.scheduled = false;
    if (this.active) this.callback(this.cause);
    this.cause = undefined;
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    this.node.remove(this);
  }
}

interface Capsule<T = unknown> {
  atom: Atom<T>;
  value: T;
}

interface LiveBatch {
  id: BatchId;
  deferred: boolean;
  capsules: Map<Atom<unknown>, Capsule>;
}

export interface HostProtocol {
  getCurrentWriteBatch(): BatchId;
  getRenderBatches(): readonly BatchId[] | null;
  getRenderContainer(): object | null;
  runInBatch<T>(batchId: BatchId, fn: () => T): T;
}

export class Runtime {
  writesForbidden = 0;
  suppressWatchers = false;
  private tracker: Tracker | null = null;
  private scope: Scope | null = null;
  private batchDepth = 0;
  private flushing = false;
  private readonly reactions: Reaction[] = [];
  private readonly watchers: Watcher[] = [];
  private readonly observations = new Set<Atom<unknown>>();
  private readonly batchWatchers = new Set<() => void>();
  private readonly rootWatchers = new Set<(container: object, batches: readonly BatchId[]) => void>();
  private readonly eventListeners = new Set<(event: RuntimeEvent) => void>();
  private observationsQueued = false;
  private host: HostProtocol | undefined;
  private nextBatchId = 1;
  private readonly liveBatches = new Map<BatchId, LiveBatch>();
  private readonly rootBatches = new WeakMap<object, Set<BatchId>>();

  atom<T>(initial: AtomInitial<T>, options?: AtomOptions<T>): Atom<T> {
    return new Atom(this, initial, options);
  }

  computed<T>(
    fn: (use: <U>(promise: PromiseLike<U>) => U) => T,
    options?: ComputedOptions<T>,
  ): Computed<T> {
    return new Computed(this, fn, options);
  }

  effect(fn: () => void | (() => void)): () => void {
    const reaction = new Reaction(this, fn);
    const owner = this.scope;
    owner?.reactions.push(reaction);
    reaction.run();
    const dispose = () => {
      effectFinalizer.unregister(dispose);
      reaction.dispose();
    };
    if (owner === null) effectFinalizer.register(dispose, reaction, dispose);
    return dispose;
  }

  effectScope(fn: () => void): () => void {
    const scope = new Scope();
    const previous = this.scope;
    this.scope = scope;
    try {
      fn();
    } finally {
      this.scope = previous;
    }
    return () => scope.dispose();
  }

  evaluate<T>(tracker: Tracker, fn: () => T, scope?: Scope): T {
    const previousTracker = this.tracker;
    const previousScope = this.scope;
    this.tracker = tracker;
    if (scope !== undefined) this.scope = scope;
    try {
      return fn();
    } finally {
      this.tracker = previousTracker;
      this.scope = previousScope;
    }
  }

  track(node: Node<unknown>): void {
    const tracker = this.tracker;
    if (tracker === null || tracker.collecting.has(node)) return;
    tracker.collecting.add(node);
    tracker.collectedValues.set(node, node.current());
  }

  untracked<T>(fn: () => T): T {
    const previous = this.tracker;
    this.tracker = null;
    try {
      return fn();
    } finally {
      this.tracker = previous;
    }
  }

  batch<T>(fn: () => T): T {
    this.startBatch();
    try {
      return fn();
    } finally {
      this.endBatch();
    }
  }

  startBatch(): void {
    ++this.batchDepth;
  }

  endBatch(): void {
    if (this.batchDepth === 0) throw new Error('endBatch called without startBatch');
    if (--this.batchDepth === 0) this.flush();
  }

  scheduleReaction(reaction: Reaction, cause?: number): void {
    this.reactions.push(reaction);
    if (this.batchDepth === 0) this.flush(cause);
  }

  scheduleWatcher(watcher: Watcher): void {
    this.watchers.push(watcher);
    if (this.batchDepth === 0) this.flush();
  }

  flush(_cause?: number): void {
    if (this.flushing || this.batchDepth !== 0) return;
    this.flushing = true;
    let error: unknown;
    try {
      for (let i = 0; i < this.reactions.length; ++i) {
        try {
          this.reactions[i].run();
        } catch (caught) {
          error ??= caught;
        }
      }
      for (let i = 0; i < this.watchers.length; ++i) {
        try {
          this.watchers[i].deliver();
        } catch (caught) {
          error ??= caught;
        }
      }
    } finally {
      this.reactions.length = 0;
      this.watchers.length = 0;
      this.flushing = false;
    }
    if (error !== undefined) throw error;
  }

  subscribe<T>(node: Atom<T> | Computed<T>, callback: (batchId?: number) => void): () => void {
    const watcher = new Watcher(this, node as Node<unknown>, callback);
    node.add(watcher);
    return () => watcher.dispose();
  }

  attachHost(host: HostProtocol | undefined): void {
    this.host = host;
  }

  renderBatches(): readonly BatchId[] | null {
    return this.host?.getRenderBatches() ?? null;
  }

  allocateBatch(deferred: boolean): BatchId {
    const id = this.nextBatchId++;
    this.liveBatches.set(id, { id, deferred, capsules: new Map() });
    this.emitDebug({ kind: 'batch-open', batchId: id });
    return id;
  }

  readAtom<T>(atom: Atom<T>): T {
    const batches = this.host?.getRenderBatches();
    if (batches !== null && batches !== undefined) return this.valueFor(atom, batches);
    return atom.peek();
  }

  latest<T>(node: Atom<T> | Computed<T>): T {
    if (node instanceof Computed) return node.latest();
    const batches = this.host?.getRenderBatches();
    if (batches !== null && batches !== undefined) return this.valueFor(node, batches);
    let value = node.peek();
    for (const batch of this.liveBatches.values()) {
      const capsule = batch.capsules.get(node as Atom<unknown>);
      if (capsule !== undefined) value = capsule.value as T;
    }
    return value;
  }

  committed<T>(node: Atom<T> | Computed<T>, container?: object): T {
    if (node instanceof Computed || container === undefined) return node.get();
    const batches = this.rootBatches.get(container);
    return batches === undefined ? node.peek() : this.valueFor(node, batches);
  }

  isPending<T>(node: Atom<T> | Computed<T>): boolean {
    if (node instanceof Computed && node.isPending()) return true;
    for (const batch of this.liveBatches.values()) {
      if (batch.deferred && batch.capsules.has(node as Atom<unknown>)) return true;
    }
    return false;
  }

  isDeferredBatch(id: BatchId | undefined): boolean {
    return id !== undefined && this.liveBatches.get(id)?.deferred === true;
  }

  pendingBatchIds<T>(node: Atom<T> | Computed<T>): BatchId[] {
    const ids: BatchId[] = [];
    for (const batch of this.liveBatches.values()) {
      if (
        batch.deferred &&
        (node instanceof Computed || batch.capsules.has(node as Atom<unknown>))
      ) {
        ids.push(batch.id);
      }
    }
    return ids;
  }

  subscribeBatchState(callback: () => void): () => void {
    this.batchWatchers.add(callback);
    return () => this.batchWatchers.delete(callback);
  }

  subscribeRoot(
    callback: (container: object, batches: readonly BatchId[]) => void,
  ): () => void {
    this.rootWatchers.add(callback);
    return () => this.rootWatchers.delete(callback);
  }

  refresh<T>(node: Atom<T> | Computed<T>): void {
    if (node instanceof Computed) {
      node.refresh(true);
      node.invalidate();
    } else {
      node.notify();
    }
  }

  write<T>(atom: Atom<T>, update: (previous: T) => T): void {
    if (this.writesForbidden !== 0) throw new Error('A lazy initializer cannot write');
    if (this.host?.getRenderBatches() != null) throw new Error('Signals cannot be written during render');
    this.startBatch();
    try {
      const id = this.host?.getCurrentWriteBatch() ?? 0;
      this.emitDebug({ kind: 'write', subject: atom, batchId: id || undefined });
      const batch = this.liveBatches.get(id);
      if (batch?.deferred) {
        let capsule = batch.capsules.get(atom as Atom<unknown>) as Capsule<T> | undefined;
        if (capsule === undefined) {
          capsule = { atom, value: atom.peek() };
          batch.capsules.set(atom as Atom<unknown>, capsule as Capsule);
          for (const watcher of this.batchWatchers) watcher();
        }
        const value = update(capsule.value);
        if (!atom.equals(capsule.value, value)) {
          capsule.value = value;
          atom.notify(id);
        }
      } else {
        atom.apply(update, id || undefined);
        for (const live of this.liveBatches.values()) {
          if (!live.deferred) continue;
          const capsule = live.capsules.get(atom as Atom<unknown>) as Capsule<T> | undefined;
          if (capsule === undefined) continue;
          const value = update(capsule.value);
          if (!atom.equals(capsule.value, value)) {
            capsule.value = value;
            atom.notify(live.id);
          }
        }
      }
    } finally {
      this.endBatch();
    }
  }

  rootCommitted(container: object, batchIds: readonly BatchId[]): void {
    let committed = this.rootBatches.get(container);
    if (committed === undefined) {
      committed = new Set();
      this.rootBatches.set(container, committed);
    }
    for (const id of batchIds) committed.add(id);
    this.emitDebug({ kind: 'root-commit', subject: container, batchId: batchIds[0] });
    for (const watcher of this.rootWatchers) watcher(container, batchIds);
  }

  retireBatch(id: BatchId, committed: boolean): void {
    const batch = this.liveBatches.get(id);
    if (batch === undefined) return;
    this.liveBatches.delete(id);
    this.emitDebug({ kind: 'batch-retire', batchId: id, committed });
    this.suppressWatchers = committed;
    try {
      for (const capsule of batch.capsules.values()) {
        if (committed) capsule.atom.apply(() => capsule.value, id);
        else capsule.atom.notify(id);
      }
    } finally {
      this.suppressWatchers = false;
    }
    for (const watcher of this.batchWatchers) watcher();
    this.flush();
  }

  runInBatch<T>(id: BatchId, fn: () => T): T {
    return this.host === undefined ? fn() : this.host.runInBatch(id, fn);
  }

  queueObservation(atom: Atom<unknown>): void {
    this.observations.add(atom);
    if (this.observationsQueued) return;
    this.observationsQueued = true;
    queueMicrotask(() => {
      this.observationsQueued = false;
      for (const pending of this.observations) pending.syncObservation();
      this.observations.clear();
    });
  }

  liveBatchCount(): number {
    return this.liveBatches.size;
  }

  subscribeDebug(listener: (event: RuntimeEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  emitDebug(event: RuntimeEvent): void {
    if (this.eventListeners.size === 0) return;
    for (const listener of this.eventListeners) listener(event);
  }

  private valueFor<T>(atom: Atom<T>, included: Iterable<BatchId>): T {
    let value = atom.peek();
    for (const id of included) {
      const capsule = this.liveBatches.get(id)?.capsules.get(atom as Atom<unknown>);
      if (capsule !== undefined) value = capsule.value as T;
    }
    return value;
  }
}

const defaultRuntime = new Runtime();

export function createRuntime(): Runtime {
  return new Runtime();
}

export function getDefaultRuntime(): Runtime {
  return defaultRuntime;
}

type ThenableState =
  | { status: 'pending'; promise: PromiseLike<unknown> }
  | { status: 'fulfilled'; value: unknown }
  | { status: 'rejected'; error: unknown };

const thenables = new WeakMap<object, ThenableState>();

export class Computed<T> extends Node<T> implements Tracker {
  readonly collecting = new Set<Node<unknown>>();
  readonly collectedValues = new Map<Node<unknown>, unknown>();
  readonly dependencies = new Set<Node<unknown>>();
  readonly dependencyValues = new Map<Node<unknown>, unknown>();
  private readonly equals: (a: T, b: T) => boolean;
  private value!: T;
  private hasValue = false;
  private dirty = true;
  private evaluating = false;
  private connected = false;
  private error: unknown;
  private pending: PromiseLike<unknown> | undefined;
  private settledDirty = false;

  constructor(
    runtime: Runtime,
    private readonly compute: (use: <U>(promise: PromiseLike<U>) => U) => T,
    options: ComputedOptions<T> = {},
  ) {
    super(runtime, options.label);
    this.equals = options.equals ?? Object.is;
  }

  invalidate(cause?: number): void {
    if (this.dirty) return;
    this.dirty = true;
    this.changed(cause);
  }

  get(): T {
    if (this.runtime.renderBatches() !== null) return this.readWorld();
    this.refresh();
    this.runtime.track(this);
    if (this.pending !== undefined && !this.hasValue) throw this.pending;
    if (this.error !== undefined) throw this.error;
    return this.value;
  }

  current(): unknown {
    this.refresh();
    return this.error ?? this.pending ?? this.value;
  }

  latest(): T {
    this.refresh();
    if (this.pending !== undefined && !this.hasValue) throw this.pending;
    if (this.error !== undefined) throw this.error;
    return this.value;
  }

  isPending(): boolean {
    this.refresh();
    return this.pending !== undefined;
  }

  private readWorld(): T {
    this.collecting.clear();
    this.collectedValues.clear();
    const pending: PromiseLike<unknown>[] = [];
    const use = <U>(promise: PromiseLike<U>): U => {
      const object = promise as object;
      let state = thenables.get(object);
      if (state === undefined) {
        state = { status: 'pending', promise };
        thenables.set(object, state);
        const settle = () => {
          this.settledDirty = true;
          this.runtime.emitDebug({ kind: 'suspense-settlement', subject: this });
          this.invalidate();
          this.runtime.flush();
        };
        promise.then(
          (value) => {
            thenables.set(object, { status: 'fulfilled', value });
            this.runtime.emitDebug({ kind: 'suspense-settlement', subject: this });
            settle();
          },
          (error) => {
            thenables.set(object, { status: 'rejected', error });
            this.runtime.emitDebug({ kind: 'suspense-settlement', subject: this });
            settle();
          },
        );
      }
      if (state.status === 'pending') {
        pending.push(promise);
        return undefined as U;
      }
      if (state.status === 'rejected') throw state.error;
      return state.value as U;
    };
    let value!: T;
    let error: unknown;
    try {
      value = this.runtime.evaluate(this, () => this.compute(use));
    } catch (caught) {
      error = caught;
    }
    for (const dependency of this.collecting) {
      if (this.dependencies.has(dependency)) continue;
      this.dependencies.add(dependency);
      this.dependencyValues.set(dependency, this.collectedValues.get(dependency));
      if (this.connected) dependency.add(this);
    }
    if (pending.length !== 0) {
      this.pending = pending[0];
      const batches = this.runtime.renderBatches();
      if (!this.hasValue || batches?.some((id) => this.runtime.isDeferredBatch(id))) {
        throw this.pending;
      }
      return this.value;
    }
    if (error !== undefined) throw error;
    if (!this.hasValue) {
      this.value = value;
      this.hasValue = true;
      ++this.version;
    }
    return value;
  }

  refresh(force = false): boolean {
    if (!force && !this.settledDirty && (this.hasValue || this.error !== undefined || this.pending !== undefined)) {
      let changed = false;
      for (const dependency of this.dependencies) {
        if (dependency instanceof Computed) dependency.refresh();
        if (!Object.is(dependency.current(), this.dependencyValues.get(dependency))) {
          changed = true;
          break;
        }
      }
      if (!changed) {
        this.dirty = false;
        return false;
      }
      this.dirty = true;
    }
    if (!this.dirty && !force) return false;
    if (this.evaluating) throw new Error('Reactive cycle detected');
    const previousValue = this.value;
    const previousError = this.error;
    const hadValue = this.hasValue;
    this.collecting.clear();
    this.collectedValues.clear();
    this.evaluating = true;
    this.settledDirty = false;
    this.pending = undefined;
    this.error = undefined;
    const pending: PromiseLike<unknown>[] = [];
    const use = <U>(promise: PromiseLike<U>): U => {
      const object = promise as object;
      let state = thenables.get(object);
      if (state === undefined) {
        state = { status: 'pending', promise };
        thenables.set(object, state);
        promise.then(
          (value) => {
            thenables.set(object, { status: 'fulfilled', value });
            this.settledDirty = true;
            this.invalidate();
            this.runtime.flush();
          },
          (error) => {
            thenables.set(object, { status: 'rejected', error });
            this.settledDirty = true;
            this.invalidate();
            this.runtime.flush();
          },
        );
      }
      if (state.status === 'pending') {
        pending.push(promise);
        return undefined as U;
      }
      if (state.status === 'rejected') throw state.error;
      return state.value as U;
    };
    let next!: T;
    try {
      next = this.runtime.evaluate(this, () => this.compute(use));
    } catch (error) {
      if (pending.length === 0) this.error = error;
    } finally {
      this.evaluating = false;
      this.reconcileDependencies();
    }
    if (pending.length !== 0) {
      this.pending = pending.length === 1 ? pending[0] : Promise.all(pending);
      this.dirty = false;
      return false;
    }
    this.dirty = false;
    if (this.error !== undefined) {
      if (previousError !== this.error || hadValue) {
        this.hasValue = false;
        ++this.version;
        return true;
      }
      return false;
    }
    this.hasValue = true;
    if (!hadValue || previousError !== undefined || !this.equals(previousValue, next)) {
      this.value = next;
      ++this.version;
      return true;
    }
    return false;
  }

  protected observed(value: boolean): void {
    this.connected = value;
    for (const dependency of this.dependencies) {
      if (value) dependency.add(this);
      else dependency.remove(this);
    }
  }

  private reconcileDependencies(): void {
    for (const dependency of this.dependencies) {
      if (!this.collecting.has(dependency) && this.connected) dependency.remove(this);
    }
    for (const dependency of this.collecting) {
      if (!this.dependencies.has(dependency) && this.connected) dependency.add(this);
    }
    this.dependencies.clear();
    this.dependencyValues.clear();
    for (const dependency of this.collecting) {
      this.dependencies.add(dependency);
      this.dependencyValues.set(dependency, this.collectedValues.get(dependency));
    }
  }
}
