export type BatchId = number;
export type TraceId = number;
export type Equality<T> = (a: T, b: T) => boolean;
type Cleanup = void | (() => void);
type Subscriber = Computation<any> | (() => void);

export type AtomOptions<T> = {
  equals?: Equality<T>;
  label?: string;
  effect?: (ctx: { get(): T; set(value: T): void }) => Cleanup;
  key?: string;
};

export type ComputedOptions<T> = { equals?: Equality<T>; label?: string };

abstract class Node<T> {
  readonly subscribers = new Set<Subscriber>();
  readonly equals: Equality<T>;
  constructor(readonly label?: string, equals?: Equality<T>) {
    this.equals = equals ?? Object.is;
  }
  abstract get(): T;
  add(subscriber: Subscriber): void {
    const wasEmpty = this.subscribers.size === 0;
    this.subscribers.add(subscriber);
    if (wasEmpty) this.observed(true);
  }
  delete(subscriber: Subscriber): void {
    if (!this.subscribers.delete(subscriber)) return;
    if (this.subscribers.size === 0) this.observed(false);
  }
  protected observed(_value: boolean): void {}
}

let active: Computation<any> | undefined;
let pendingReads: PromiseLike<unknown>[] | undefined;
let activeOwner: Effect | Scope | undefined;
let batchDepth = 0;
let flushing = false;
let initializing = 0;
let epoch = 0;
const pendingEffects = new Set<Effect>();

abstract class Computation<T> extends Node<T> {
  deps: Node<unknown>[] = [];
  depValues: unknown[] = [];
  dirty = true;
  collecting: Node<unknown>[] | undefined;
  collectingSet: Set<Node<unknown>> | undefined;
  staleDuringRun = false;
  track(node: Node<unknown>): void {
    const list = this.collecting;
    if (list === undefined) return;
    const set = this.collectingSet;
    if (set !== undefined) {
      if (!set.has(node)) {
        set.add(node);
        list.push(node);
      }
    } else if (!list.includes(node)) {
      list.push(node);
      if (list.length === 8) this.collectingSet = new Set(list);
    }
  }
  invalidate(cause?: TraceId): void {
    if (cause !== undefined) causes.set(this, cause);
    if (this.dirty) return;
    this.dirty = true;
    for (const sub of this.subscribers) {
      if (sub instanceof Computation) sub.invalidate(cause);
      else if (!suppressReact) sub();
    }
  }
  protected replaceDeps(next: Node<unknown>[]): void {
    const set = this.collectingSet;
    for (const dep of this.deps) {
      if (!(set?.has(dep) ?? next.includes(dep))) dep.delete(this);
    }
    if (this instanceof Effect || this.subscribers.size !== 0) {
      for (const dep of next) dep.add(this);
    }
    this.deps = next;
    this.depValues = next.map((dep) => dep.get());
  }
  protected observed(value: boolean): void {
    if (value) {
      for (const dep of this.deps) dep.add(this);
    } else {
      for (const dep of this.deps) dep.delete(this);
      this.dirty = true;
    }
  }
}

type Update<T> = { kind: "set"; value: T } | { kind: "update"; value: (prev: T) => T };

export class Transaction {
  readonly writes = new Map<Atom<unknown>, Update<unknown>[]>();
  readonly bases = new Map<Atom<unknown>, unknown>();
  readonly rebases = new Map<Atom<unknown>, Update<unknown>[]>();
  readonly roots = new Set<object>();
  readonly containers = new Set<object>();
  closed = false;
  landed = false;
  rebaseOnCanonical = false;
  revision = 0;
  constructor(readonly id: BatchId, readonly deferred: boolean, public cause?: TraceId) {}
}

let transactionSequence = 0;
let currentTransaction: Transaction | undefined;
let currentWorld: readonly Transaction[] | undefined;
const transactions: Transaction[] = [];
const rootWorlds = new WeakMap<object, Transaction[]>();
let suppressReact = false;
let urgentRebaseDepth = 0;
let renderProbe: (() => boolean) | undefined;

function fold<T>(atom: Atom<T>, txs: readonly Transaction[]): T {
  let value = atom.base;
  for (const tx of txs) {
    const writes = tx.writes.get(atom as Atom<unknown>) as Update<T>[] | undefined;
    if (writes === undefined) continue;
    const rebases = tx.rebases.get(atom as Atom<unknown>) as Update<T>[] | undefined;
    if (rebases !== undefined && !tx.rebaseOnCanonical) {
      value = tx.bases.get(atom as Atom<unknown>) as T;
    }
    for (const write of writes) {
      const next = write.kind === "set" ? write.value : write.value(value);
      if (!atom.equals(value, next)) value = next;
    }
    if (rebases !== undefined && !tx.rebaseOnCanonical) {
      for (const write of rebases) {
        const next = write.kind === "set" ? write.value : write.value(value);
        if (!atom.equals(value, next)) value = next;
      }
    }
  }
  return value;
}

function worldKey(): string {
  if (currentWorld === undefined || currentWorld.length === 0) return "canonical";
  let key = "";
  for (const transaction of currentWorld) key += `${transaction.id}:${transaction.revision};`;
  return key;
}

export class Atom<T> extends Node<T> {
  base!: T;
  private ready = false;
  private installed = false;
  private observation?: () => void;
  private observationActive = false;
  private cleanupQueued = false;
  constructor(private initial: T | (() => T), readonly options: AtomOptions<T> = {}) {
    super(options.label, options.equals);
  }
  materialize(): void {
    if (this.ready) return;
    this.ready = true;
    if (this.installed) return;
    if (typeof this.initial === "function") {
      initializing++;
      try {
        this.base = untracked(this.initial as () => T);
      } finally {
        initializing--;
      }
    } else this.base = this.initial;
  }
  get(): T {
    this.materialize();
    if (active !== undefined) active.track(this as Node<unknown>);
    return currentWorld === undefined ? this.base : fold(this, currentWorld);
  }
  get state(): T {
    return this.get();
  }
  set(value: T): void {
    write(this, { kind: "set", value });
  }
  update(fn: (prev: T) => T): void {
    write(this, { kind: "update", value: fn });
  }
  install(value: T): void {
    this.base = value;
    this.ready = true;
    this.installed = true;
  }
  protected observed(value: boolean): void {
    const effect = this.options.effect;
    if (effect === undefined) return;
    if (value) {
      this.cleanupQueued = false;
      if (!this.observationActive) {
        this.observationActive = true;
        const cleanup = effect({ get: () => this.get(), set: (next) => this.set(next) });
        if (cleanup !== undefined) this.observation = cleanup;
      }
    } else {
      this.cleanupQueued = true;
      Promise.resolve().then(() => {
        if (!this.cleanupQueued || this.subscribers.size !== 0) return;
        this.cleanupQueued = false;
        this.observation?.();
        this.observation = undefined;
        this.observationActive = false;
      });
    }
  }
}

export class Computed<T> extends Computation<T> {
  private value!: T;
  private ready = false;
  private evaluating = false;
  private seenEpoch = -1;
  private pendingParts: PromiseLike<unknown>[] = [];
  private pendingThenable?: PromiseLike<unknown>;
  private pendingWorld?: string;
  private pendingActive = false;
  constructor(
    readonly fn: (use: <U>(promise: PromiseLike<U>) => U) => T,
    options: ComputedOptions<T> = {},
  ) {
    super(options.label, options.equals);
  }
  get(): T {
    if (active !== undefined) active.track(this as Node<unknown>);
    if (this.pendingActive && this.pendingWorld === worldKey()) throw this.pendingThenable;
    if (currentWorld !== undefined) {
      try {
        return this.evaluateWorld();
      } catch (error) {
        if (pendingReads !== undefined && isThenable(error)) {
          pendingReads.push(error);
          return undefined as T;
        }
        throw error;
      }
    }
    if (this.subscribers.size === 0 && this.seenEpoch !== epoch) this.dirty = true;
    if (this.dirty) {
      try {
        this.refresh();
      } catch (error) {
        if (pendingReads !== undefined && isThenable(error)) {
          pendingReads.push(error);
          return undefined as T;
        }
        throw error;
      }
    }
    return this.value;
  }
  get state(): T {
    return this.get();
  }
  peek(): T | undefined {
    return this.ready ? this.value : undefined;
  }
  invalidate(cause?: TraceId): void {
    this.pendingActive = false;
    super.invalidate(cause);
  }
  private depsChanged(): boolean {
    for (let i = 0; i < this.deps.length; i++) {
      if (!this.deps[i].equals(this.depValues[i], this.deps[i].get())) return true;
    }
    return false;
  }
  private run(): T {
    if (this.evaluating) throw new Error("Reactive cycle detected");
    this.evaluating = true;
    const previous = active;
    const previousPending = pendingReads;
    const next: Node<unknown>[] = [];
    const pending: PromiseLike<unknown>[] = [];
    this.collecting = next;
    this.staleDuringRun = false;
    active = this;
    pendingReads = pending;
    try {
      const value = this.fn(usePromise);
      this.replaceDeps(next);
      if (pending.length !== 0) throw this.join(pending);
      return value;
    } finally {
      active = previous;
      pendingReads = previousPending;
      this.collecting = undefined;
      this.collectingSet = undefined;
      this.evaluating = false;
    }
  }
  private evaluateWorld(): T {
    const previous = active;
    const previousPending = pendingReads;
    const pending: PromiseLike<unknown>[] = [];
    active = this;
    pendingReads = pending;
    try {
      const value = this.fn(usePromise);
      if (pending.length !== 0) throw this.join(pending);
      return value;
    } finally {
      active = previous;
      pendingReads = previousPending;
    }
  }
  private join(parts: PromiseLike<unknown>[]): PromiseLike<unknown> {
    if (parts.length === this.pendingParts.length) {
      let same = true;
      for (let index = 0; index < parts.length; index++) {
        if (parts[index] !== this.pendingParts[index]) {
          same = false;
          break;
        }
      }
      if (same) {
        this.pendingActive = true;
        this.pendingWorld = worldKey();
        return this.pendingThenable!;
      }
    }
    this.pendingParts = parts;
    const promises: Promise<unknown>[] = [];
    for (const part of parts) promises.push(Promise.resolve(part));
    this.pendingThenable = Promise.all(promises);
    this.pendingActive = true;
    this.pendingWorld = worldKey();
    const joined = this.pendingThenable;
    joined.then(
      () => {
        if (this.pendingThenable === joined) this.pendingActive = false;
      },
      () => {
        if (this.pendingThenable === joined) this.pendingActive = false;
      },
    );
    return this.pendingThenable;
  }
  refresh(): void {
    if (!this.dirty) return;
    if (this.ready && !this.staleDuringRun && !this.depsChanged()) {
      this.dirty = false;
      this.seenEpoch = epoch;
      return;
    }
    const previous = this.value;
    const next = this.run();
    this.value = this.ready && this.equals(previous, next) ? previous : next;
    this.ready = true;
    this.dirty = this.staleDuringRun;
    this.seenEpoch = epoch;
  }
}

class Scope {
  readonly children = new Set<Effect>();
  dispose(): void {
    for (const child of this.children) child.dispose();
  }
}

class Effect extends Computation<unknown> {
  readonly children = new Set<Effect>();
  cleanup?: () => void;
  disposed = false;
  constructor(readonly fn: () => Cleanup, readonly owner?: Effect | Scope) {
    super();
    owner?.children.add(this);
  }
  get(): unknown {
    return undefined;
  }
  invalidate(cause?: TraceId): void {
    if (cause !== undefined) causes.set(this, cause);
    if (this.disposed || this.dirty) return;
    this.dirty = true;
    pendingEffects.add(this);
    if (batchDepth === 0 && !flushing) flushEffects();
  }
  needsRun(): boolean {
    if (!this.dirty || this.disposed) return false;
    for (let i = 0; i < this.deps.length; i++) {
      if (!this.deps[i].equals(this.depValues[i], this.deps[i].get())) return true;
    }
    this.dirty = false;
    return false;
  }
  run(): void {
    if (this.disposed) return;
    for (const child of this.children) child.dispose();
    const oldCleanup = this.cleanup;
    this.cleanup = undefined;
    try {
      if (oldCleanup !== undefined) untracked(oldCleanup);
    } catch (error) {
      this.dispose();
      throw error;
    }
    const previousActive = active;
    const previousOwner = activeOwner;
    const next: Node<unknown>[] = [];
    this.collecting = next;
    this.dirty = false;
    active = this;
    activeOwner = this;
    try {
      emit("effect-run", causes.get(this), { target: this });
      const cleanup = this.fn();
      this.replaceDeps(next);
      if (cleanup !== undefined) this.cleanup = cleanup;
    } finally {
      active = previousActive;
      activeOwner = previousOwner;
      this.collecting = undefined;
      this.collectingSet = undefined;
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    pendingEffects.delete(this);
    for (const child of this.children) child.dispose();
    for (const dep of this.deps) dep.delete(this);
    this.deps.length = 0;
    this.depValues.length = 0;
    const cleanup = this.cleanup;
    this.cleanup = undefined;
    if (cleanup !== undefined) untracked(cleanup);
    this.owner?.children.delete(this);
  }
}

const droppedEffects = new FinalizationRegistry<Effect>((instance) => instance.dispose());
const droppedScopes = new FinalizationRegistry<Scope>((scope) => scope.dispose());

function flushEffects(): void {
  if (flushing || batchDepth !== 0) return;
  flushing = true;
  let firstError: unknown;
  try {
    while (pendingEffects.size !== 0) {
      const effects = [...pendingEffects];
      pendingEffects.clear();
      for (const effect of effects) {
        try {
          if (effect.needsRun()) effect.run();
        } catch (error) {
          if (firstError === undefined) firstError = error;
        }
      }
    }
  } finally {
    flushing = false;
  }
  if (firstError !== undefined) throw firstError;
}

const causes = new WeakMap<object, TraceId>();
export function causeOf(node: object): TraceId | undefined {
  return causes.get(node);
}

function notify(node: Node<unknown>, cause?: TraceId): void {
  for (const subscriber of [...node.subscribers]) {
    if (subscriber instanceof Computation) subscriber.invalidate(cause);
    else if (!suppressReact) subscriber();
  }
}

function write<T>(atom: Atom<T>, update: Update<T>): void {
  if (renderProbe?.()) throw new Error("Signals cannot be written during render");
  if (initializing !== 0) throw new Error("A lazy initializer cannot write");
  atom.materialize();
  if (currentTransaction?.deferred) {
    const before = fold(atom, [currentTransaction]);
    const next = update.kind === "set" ? update.value : update.value(before);
    if (atom.equals(before, next)) return;
    let writes = currentTransaction.writes.get(atom as Atom<unknown>);
    if (writes === undefined) {
      currentTransaction.bases.set(atom as Atom<unknown>, atom.base);
      currentTransaction.writes.set(atom as Atom<unknown>, (writes = []));
    }
    writes.push(update as Update<unknown>);
    currentTransaction.revision++;
    currentTransaction.cause = emit("write", currentTransaction.cause, {
      batch: currentTransaction.id,
      target: atom,
    });
    causes.set(atom, currentTransaction.cause);
    for (const listener of reactListeners) listener(currentTransaction, atom);
    return;
  }
  const next = update.kind === "set" ? update.value : update.value(atom.base);
  if (atom.equals(atom.base, next)) return;
  for (const transaction of transactions) {
    if (
      transaction.closed ||
      transaction.roots.size === 0 ||
      !transaction.writes.has(atom as Atom<unknown>)
    ) {
      continue;
    }
    let rebases = transaction.rebases.get(atom as Atom<unknown>);
    if (rebases === undefined) transaction.rebases.set(atom as Atom<unknown>, (rebases = []));
    rebases.push(update as Update<unknown>);
    if (urgentRebaseDepth !== 0) transaction.rebaseOnCanonical = true;
  }
  atom.base = next;
  if (
    active !== undefined &&
    (active.collectingSet?.has(atom as Node<unknown>) ??
      active.collecting?.includes(atom as Node<unknown>))
  ) {
    active.staleDuringRun = true;
  }
  epoch++;
  const cause = emit("write", currentTransaction?.cause, {
    batch: currentTransaction?.id ?? 0,
    target: atom,
  });
  causes.set(atom, cause);
  notify(atom as Node<unknown>, cause);
  if (!suppressReact)
    for (const listener of reactListeners) listener(currentTransaction, atom, true);
  if (batchDepth === 0) flushEffects();
}

export function atom<T>(initial: T | (() => T), options?: AtomOptions<T>): Atom<T> {
  return new Atom(initial, options);
}

export function computed<T>(
  fn: (() => T) | ((use: <U>(promise: PromiseLike<U>) => U) => T),
  options?: ComputedOptions<T>,
): Computed<T> {
  return new Computed(fn, options);
}

export function effect(fn: () => Cleanup): () => void {
  const instance = new Effect(fn, activeOwner);
  try {
    instance.run();
  } catch (error) {
    instance.dispose();
    throw error;
  }
  const dispose = () => {
    droppedEffects.unregister(dispose);
    instance.dispose();
  };
  if (activeOwner === undefined) droppedEffects.register(dispose, instance, dispose);
  return dispose;
}

export function effectScope(fn: () => void): () => void {
  const scope = new Scope();
  const previous = activeOwner;
  activeOwner = scope;
  try {
    fn();
  } finally {
    activeOwner = previous;
  }
  const dispose = () => {
    droppedScopes.unregister(dispose);
    scope.dispose();
  };
  droppedScopes.register(dispose, scope, dispose);
  return dispose;
}

export function startBatch(): void {
  batchDepth++;
}

export function endBatch(): void {
  if (batchDepth === 0) throw new Error("endBatch without startBatch");
  if (--batchDepth === 0) flushEffects();
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
  const previous = active;
  active = undefined;
  try {
    return fn();
  } finally {
    active = previous;
  }
}

export function setRenderProbe(probe: () => boolean): void {
  renderProbe = probe;
}

export function setFlushSync(active: boolean): void {
  urgentRebaseDepth += active ? 1 : -1;
}

export function read<T>(node: Atom<T> | Computed<T>): T {
  return node.get();
}

export function latest<T>(node: Atom<T> | Computed<T>): T {
  if (currentWorld !== undefined || active !== undefined) {
    try {
      return node.get();
    } catch (error) {
      if (isThenable(error) && node instanceof Computed) return node.peek() as T;
      throw error;
    }
  }
  const previous = currentWorld;
  currentWorld = transactions;
  try {
    try {
      return node.get();
    } catch (error) {
      if (isThenable(error) && node instanceof Computed) return node.peek() as T;
      throw error;
    }
  } finally {
    currentWorld = previous;
  }
}

export function withWorld<T>(world: readonly Transaction[], fn: () => T): T {
  const previous = currentWorld;
  currentWorld = world;
  try {
    return fn();
  } finally {
    currentWorld = previous;
  }
}

export function openTransaction(deferred = true, cause?: TraceId): Transaction {
  const tx = new Transaction(++transactionSequence, deferred, cause);
  transactions.push(tx);
  tx.cause = emit("batch-open", cause, { batch: tx.id });
  return tx;
}

export function runInTransaction<T>(transaction: Transaction, fn: () => T): T {
  if (transaction.closed) throw new Error("Transaction already retired");
  const previous = currentTransaction;
  currentTransaction = transaction;
  try {
    return fn();
  } finally {
    currentTransaction = previous;
  }
}

export function retireTransaction(
  transaction: Transaction,
  commit: boolean,
  notifyReact = true,
): void {
  if (transaction.closed) return;
  transaction.closed = true;
  const index = transactions.indexOf(transaction);
  if (index !== -1) transactions.splice(index, 1);
  if (commit) {
    const previous = suppressReact;
    suppressReact = !notifyReact;
    try {
      batch(() => {
        for (const [rawAtom, writes] of transaction.writes) {
          const target = rawAtom as Atom<unknown>;
          if (transaction.landed) {
            let value = transaction.rebaseOnCanonical
              ? target.base
              : transaction.bases.get(rawAtom);
            for (const update of writes) {
              value = update.kind === "set" ? update.value : update.value(value);
            }
            const rebases = transaction.rebases.get(rawAtom);
            if (rebases !== undefined && !transaction.rebaseOnCanonical) {
              for (const update of rebases) {
                value = update.kind === "set" ? update.value : update.value(value);
              }
            }
            write(target, { kind: "set", value });
          } else {
            for (const update of writes) write(target, update);
          }
        }
      });
    } finally {
      suppressReact = previous;
    }
    for (const [target] of transaction.writes) {
      for (const listener of reactListeners) listener(undefined, target);
    }
  } else {
    if (notifyReact) for (const listener of reactListeners) listener(undefined);
  }
  for (const container of transaction.containers) {
    const world = rootWorlds.get(container);
    if (world !== undefined)
      rootWorlds.set(
        container,
        world.filter((item) => item !== transaction),
      );
  }
  emit("batch-retire", transaction.cause, { batch: transaction.id, commit });
}

export function activeTransactions(): readonly Transaction[] {
  return transactions;
}

export function setRootWorld(container: object, world: Transaction[]): void {
  rootWorlds.set(container, world);
  for (const transaction of world) transaction.containers.add(container);
}

export function rootWorld(container: object): readonly Transaction[] {
  return rootWorlds.get(container) ?? [];
}

const reactListeners = new Set<
  (transaction: Transaction | undefined, target?: object, canonical?: boolean) => void
>();
export function subscribeReact(
  listener: (transaction: Transaction | undefined, target?: object, canonical?: boolean) => void,
): () => void {
  reactListeners.add(listener);
  return () => reactListeners.delete(listener);
}
export function subscribeNode(node: Atom<any> | Computed<any>, listener: () => void): () => void {
  node.add(listener);
  return () => node.delete(listener);
}

type Resource<T> = {
  status: "pending" | "value" | "error";
  promise: PromiseLike<T>;
  value?: T;
  error?: unknown;
};
const resources = new WeakMap<object, Resource<unknown>>();

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function usePromise<T>(promise: PromiseLike<T>): T {
  const key = promise as object;
  let resource = resources.get(key) as Resource<T> | undefined;
  if (resource === undefined) {
    resource = { status: "pending", promise };
    resources.set(key, resource as Resource<unknown>);
    const owner = currentTransaction ?? currentWorld?.[currentWorld.length - 1];
    promise.then(
      (value) => {
        resource!.status = "value";
        resource!.value = value;
        epoch++;
        emit("suspense-settle", owner?.cause, {});
        for (const listener of reactListeners) listener(owner);
      },
      (error) => {
        resource!.status = "error";
        resource!.error = error;
        epoch++;
        for (const listener of reactListeners) listener(owner);
      },
    );
  }
  if (resource.status === "pending") {
    if (pendingReads === undefined) throw resource.promise;
    pendingReads.push(resource.promise);
    return undefined as T;
  }
  if (resource.status === "error") throw resource.error;
  return resource.value as T;
}

export function committed<T>(node: Atom<T> | Computed<T>, _container?: object): T {
  try {
    if (_container === undefined) return node.get();
    return withWorld(rootWorld(_container), () => node.get());
  } catch (error) {
    if (isThenable(error) && node instanceof Computed) return node.peek() as T;
    throw error;
  }
}

export function isPending(node: Atom<any> | Computed<any>): boolean {
  if (node instanceof Atom) {
    for (const transaction of transactions) {
      if (transaction.writes.has(node as Atom<unknown>)) return true;
    }
  }
  const previous = currentWorld;
  currentWorld = transactions;
  try {
    node.get();
    return false;
  } catch (error) {
    if (isThenable(error)) return true;
    throw error;
  } finally {
    currentWorld = previous;
  }
}

export function pendingTransaction(node: Atom<any> | Computed<any>): Transaction | undefined {
  if (!(node instanceof Atom)) return undefined;
  for (let index = transactions.length - 1; index >= 0; index--) {
    if (transactions[index].writes.has(node as Atom<unknown>)) return transactions[index];
  }
  return undefined;
}

export function refresh(node: Atom<any> | Computed<any>): void {
  if (node instanceof Computed) {
    node.invalidate();
    node.dirty = true;
    node.staleDuringRun = true;
    for (const listener of reactListeners) listener(currentTransaction, node);
  }
}

export function serializeAtomState(
  atoms: readonly Atom<any>[],
  replacer?: (key: string, value: unknown) => unknown,
): string {
  const state: Record<string, unknown> = {};
  for (const item of atoms) {
    if (item.options.key === undefined) throw new Error("Every serialized atom needs a key");
    state[item.options.key] = item.get();
  }
  return JSON.stringify(state, replacer);
}

export function initializeAtomState(
  json: string,
  atoms: readonly Atom<any>[],
  reviver?: (key: string, value: unknown) => unknown,
): void {
  const state = JSON.parse(json, reviver) as Record<string, unknown>;
  for (const item of atoms) {
    const key = item.options.key;
    if (key !== undefined && Object.prototype.hasOwnProperty.call(state, key))
      item.install(state[key]);
  }
}

export type TraceEvent = {
  id: TraceId;
  kind: string;
  cause?: TraceId;
  data?: Record<string, unknown>;
};
export class Tracer {
  private readonly log: TraceEvent[] = [];
  private stopped = false;
  overflow = 0;
  constructor(readonly capacity = 1024) {
    tracers.add(this);
  }
  push(event: TraceEvent): void {
    if (this.stopped) return;
    if (this.log.length === this.capacity) {
      this.log.shift();
      this.overflow++;
    }
    this.log.push(event);
  }
  events(): TraceEvent[] {
    return this.log.slice();
  }
  chain(id: TraceId): string[] {
    const out: string[] = [];
    while (id !== 0) {
      const event = this.log.find((entry) => entry.id === id);
      if (event === undefined) break;
      out.push(`${event.kind}#${event.id}`);
      id = event.cause ?? 0;
    }
    return out;
  }
  stop(): void {
    this.stopped = true;
    tracers.delete(this);
  }
}

let traceSequence = 0;
const tracers = new Set<Tracer>();
export function emit(kind: string, cause?: TraceId, data?: Record<string, unknown>): TraceId {
  if (tracers.size === 0) return 0;
  const event = { id: ++traceSequence, kind, cause, data };
  for (const tracer of tracers) tracer.push(event);
  return event.id;
}
export function trace(capacity?: number): Tracer {
  return new Tracer(capacity);
}

export function resetForTest(): void {
  for (const tx of [...transactions]) retireTransaction(tx, false);
  pendingEffects.clear();
  batchDepth = 0;
  flushing = false;
  epoch = 0;
  transactionSequence = 0;
  urgentRebaseDepth = 0;
  traceSequence = 0;
  for (const tracer of [...tracers]) tracer.stop();
}
