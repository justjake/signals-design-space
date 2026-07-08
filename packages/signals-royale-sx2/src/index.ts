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

let active: Observer | undefined;
let tracking = true;
let batchDepth = 0;
let flushing = false;
let effectDepth = 0;
const queuedEffects = new Set<ReactiveEffect>();
let activeScope: Set<ReactiveEffect> | undefined;
let batchAtoms:
  | Map<Atom<unknown>, { value: unknown; version: number }>
  | undefined;

abstract class Observer implements Subscriber {
  deps: Link[] = [];
  nextDeps: Link[] = [];
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
    active = this;
    tracking = true;
    try {
      return fn();
    } finally {
      active = previous;
      tracking = previousTracking;
      for (const old of this.deps) {
        let retained = false;
        for (const current of this.nextDeps) {
          if (current.source === old.source) {
            retained = true;
            break;
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
  for (const link of observer.nextDeps) {
    if (link.source === source) return;
  }
  let link: Link | undefined;
  for (const old of observer.deps) {
    if (old.source === source) {
      link = old;
      break;
    }
  }
  if (link === undefined) link = { source, version: source.version };
  else link.version = source.version;
  observer.nextDeps.push(link);
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
    this.value =
      typeof initial === "function"
        ? untracked(() => (initial as () => T)())
        : initial;
  }

  get(): T {
    this.ensure();
    track(this);
    return this.value;
  }

  set(value: T): void {
    this.ensure();
    if (this.equals(this.value, value)) return;
    let original = batchAtoms?.get(this as Atom<unknown>);
    if (batchAtoms !== undefined && original === undefined) {
      original = { value: this.value, version: this.version };
      batchAtoms.set(this as Atom<unknown>, original);
    }
    this.value = value;
    this.version =
      original === undefined
        ? this.version + 1
        : this.equals(original.value as T, value)
        ? original.version
        : original.version + 1;
    for (const subscriber of this.subscribers) subscriber.notify();
    flushEffects();
  }

  update(fn: (previous: T) => T): void {
    this.set(fn(untracked(() => this.get())));
  }

  install(value: T): void {
    this.initialized = true;
    this.value = value;
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
  private hasValue = false;
  private evaluating = false;
  private value!: T;
  private failure: unknown;

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
    if (this.hasValue && !this.dependenciesChanged()) {
      this.dirty = false;
      return;
    }
    if (this.evaluating) throw new Error("Computed cycle");
    this.evaluating = true;
    let next!: T;
    let failure: unknown;
    try {
      next = this.evaluate(this.fn);
    } catch (error) {
      failure = error;
    } finally {
      this.evaluating = false;
      this.dirty = false;
    }
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
    this.ensure();
    track(this);
    if (this.failure !== undefined) throw this.failure;
    return this.value;
  }

  notify(): void {
    if (this.dirty) return;
    this.dirty = true;
    for (const subscriber of this.subscribers) subscriber.notify();
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
}

class ReactiveEffect extends Observer {
  private readonly fn: () => Cleanup;
  private cleanup?: () => void;
  private active = true;
  private hasRun = false;
  private readonly children = new Set<ReactiveEffect>();

  constructor(fn: () => Cleanup) {
    super();
    this.fn = fn;
    this.flush();
  }

  get observesSources(): boolean {
    return true;
  }

  notify(): void {
    if (!this.active) return;
    this.dirty = true;
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
  activeScope?.add(reactiveEffect);
  flushEffects();
  return () => reactiveEffect.dispose();
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
  if (batchDepth === 0) batchAtoms = new Map();
  batchDepth++;
}

export function endBatch(): void {
  if (batchDepth === 0) throw new Error("endBatch without startBatch");
  if (--batchDepth === 0) {
    batchAtoms = undefined;
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

export function set<T>(cell: Atom<T>, value: T): void {
  cell.set(value);
}

export function update<T>(cell: Atom<T>, fn: (previous: T) => T): void {
  cell.update(fn);
}

export function installState<T>(cell: Atom<T>, value: T): void {
  cell.install(value);
}

export function serializeAtomState(
  atoms: readonly Atom<unknown>[],
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
  atoms: readonly Atom<unknown>[],
  reviver?: Parameters<typeof JSON.parse>[1],
): void {
  const state = JSON.parse(json, reviver) as Record<string, unknown>;
  for (let index = 0; index < atoms.length; index++) {
    const cell = atoms[index];
    const key = cell.key ?? String(index);
    if (Object.hasOwn(state, key)) cell.install(state[key]);
  }
}
