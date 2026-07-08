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
	staleDuringRun = false;
	track(node: Node<unknown>): void {
		const list = this.collecting;
		if (list !== undefined && !list.includes(node)) list.push(node);
	}
	invalidate(): void {
		if (this.dirty) return;
		this.dirty = true;
		for (const sub of this.subscribers) {
			if (sub instanceof Computation) sub.invalidate();
			else sub();
		}
	}
	protected replaceDeps(next: Node<unknown>[]): void {
		for (const dep of this.deps) if (!next.includes(dep)) dep.delete(this);
		if (this instanceof Effect || this.subscribers.size !== 0) {
			for (const dep of next) if (!this.deps.includes(dep)) dep.add(this);
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

type Update<T> = { kind: 'set'; value: T } | { kind: 'update'; value: (prev: T) => T };

export class Transaction {
	readonly writes = new Map<Atom<unknown>, Update<unknown>[]>();
	readonly roots = new Set<object>();
	closed = false;
	constructor(readonly id: BatchId, readonly deferred: boolean, readonly cause?: TraceId) {}
}

let transactionSequence = 0;
let currentTransaction: Transaction | undefined;
let currentWorld: readonly Transaction[] | undefined;
const transactions: Transaction[] = [];

function fold<T>(atom: Atom<T>, txs: readonly Transaction[]): T {
	let value = atom.base;
	for (const tx of txs) {
		const writes = tx.writes.get(atom as Atom<unknown>) as Update<T>[] | undefined;
		if (writes === undefined) continue;
		for (const write of writes) {
			const next = write.kind === 'set' ? write.value : write.value(value);
			if (!atom.equals(value, next)) value = next;
		}
	}
	return value;
}

export class Atom<T> extends Node<T> {
	base!: T;
	private ready = false;
	private installed = false;
	private observation?: () => void;
	private cleanupQueued = false;
	constructor(private initial: T | (() => T), readonly options: AtomOptions<T> = {}) {
		super(options.label, options.equals);
	}
	materialize(): void {
		if (this.ready) return;
		this.ready = true;
		if (this.installed) return;
		if (typeof this.initial === 'function') {
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
		write(this, { kind: 'set', value });
	}
	update(fn: (prev: T) => T): void {
		write(this, { kind: 'update', value: fn });
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
			if (this.observation === undefined) {
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
			});
		}
	}
}

export class Computed<T> extends Computation<T> {
	private value!: T;
	private ready = false;
	private evaluating = false;
	private seenEpoch = -1;
	constructor(readonly fn: (use: <U>(promise: PromiseLike<U>) => U) => T, options: ComputedOptions<T> = {}) {
		super(options.label, options.equals);
	}
	get(): T {
		if (active !== undefined) active.track(this as Node<unknown>);
		if (currentWorld !== undefined) return this.evaluateWorld();
		if (this.subscribers.size === 0 && this.seenEpoch !== epoch) this.dirty = true;
		if (this.dirty) this.refresh();
		return this.value;
	}
	get state(): T {
		return this.get();
	}
	private depsChanged(): boolean {
		for (let i = 0; i < this.deps.length; i++) {
			if (!this.deps[i].equals(this.depValues[i], this.deps[i].get())) return true;
		}
		return false;
	}
	private run(): T {
		if (this.evaluating) throw new Error('Reactive cycle detected');
		this.evaluating = true;
		const previous = active;
		const next: Node<unknown>[] = [];
		this.collecting = next;
		this.staleDuringRun = false;
		active = this;
		try {
			const value = this.fn(usePromise);
			this.replaceDeps(next);
			return value;
		} finally {
			active = previous;
			this.collecting = undefined;
			this.evaluating = false;
		}
	}
	private evaluateWorld(): T {
		const previous = active;
		active = this;
		try {
			return this.fn(usePromise);
		} finally {
			active = previous;
		}
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
		for (const child of [...this.children]) child.dispose();
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
	invalidate(): void {
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
		for (const child of [...this.children]) child.dispose();
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
			const cleanup = this.fn();
			this.replaceDeps(next);
			if (cleanup !== undefined) this.cleanup = cleanup;
		} finally {
			active = previousActive;
			activeOwner = previousOwner;
			this.collecting = undefined;
		}
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		pendingEffects.delete(this);
		for (const child of [...this.children]) child.dispose();
		for (const dep of this.deps) dep.delete(this);
		this.deps.length = 0;
		this.depValues.length = 0;
		const cleanup = this.cleanup;
		this.cleanup = undefined;
		if (cleanup !== undefined) untracked(cleanup);
		this.owner?.children.delete(this);
	}
}

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

function notify(node: Node<unknown>): void {
	for (const subscriber of [...node.subscribers]) {
		if (subscriber instanceof Computation) subscriber.invalidate();
		else subscriber();
	}
}

function write<T>(atom: Atom<T>, update: Update<T>): void {
	if (initializing !== 0) throw new Error('A lazy initializer cannot write');
	atom.materialize();
	if (currentTransaction?.deferred) {
		let writes = currentTransaction.writes.get(atom as Atom<unknown>);
		if (writes === undefined) currentTransaction.writes.set(atom as Atom<unknown>, (writes = []));
		writes.push(update as Update<unknown>);
		emit('write', currentTransaction.cause, { batch: currentTransaction.id, target: atom });
		for (const listener of reactListeners) listener(currentTransaction);
		return;
	}
	const next = update.kind === 'set' ? update.value : update.value(atom.base);
	if (atom.equals(atom.base, next)) return;
	atom.base = next;
	if (active?.collecting?.includes(atom as Node<unknown>)) active.staleDuringRun = true;
	epoch++;
	emit('write', currentTransaction?.cause, { batch: currentTransaction?.id ?? 0, target: atom });
	notify(atom as Node<unknown>);
	for (const listener of reactListeners) listener(currentTransaction);
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
	return () => instance.dispose();
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
	return () => scope.dispose();
}

export function startBatch(): void {
	batchDepth++;
}

export function endBatch(): void {
	if (batchDepth === 0) throw new Error('endBatch without startBatch');
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

export function read<T>(node: Atom<T> | Computed<T>): T {
	return node.get();
}

export function latest<T>(node: Atom<T> | Computed<T>): T {
	if (currentWorld !== undefined) return node.get();
	const previous = currentWorld;
	currentWorld = transactions;
	try {
		return node.get();
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
	emit('batch-open', cause, { batch: tx.id });
	return tx;
}

export function runInTransaction<T>(transaction: Transaction, fn: () => T): T {
	if (transaction.closed) throw new Error('Transaction already retired');
	const previous = currentTransaction;
	currentTransaction = transaction;
	try {
		return fn();
	} finally {
		currentTransaction = previous;
	}
}

export function retireTransaction(transaction: Transaction, commit: boolean): void {
	if (transaction.closed) return;
	transaction.closed = true;
	const index = transactions.indexOf(transaction);
	if (index !== -1) transactions.splice(index, 1);
	if (commit) {
		batch(() => {
			for (const [rawAtom, writes] of transaction.writes) {
				const target = rawAtom as Atom<unknown>;
				for (const update of writes) write(target, update);
			}
		});
	} else {
		for (const listener of reactListeners) listener(undefined);
	}
	emit('batch-retire', transaction.cause, { batch: transaction.id, commit });
}

export function activeTransactions(): readonly Transaction[] {
	return transactions;
}

const reactListeners = new Set<(transaction: Transaction | undefined) => void>();
export function subscribeReact(listener: (transaction: Transaction | undefined) => void): () => void {
	reactListeners.add(listener);
	return () => reactListeners.delete(listener);
}
export function subscribeNode(node: Atom<unknown> | Computed<unknown>, listener: () => void): () => void {
	node.add(listener);
	return () => node.delete(listener);
}

type Resource<T> = { status: 'pending' | 'value' | 'error'; promise: PromiseLike<T>; value?: T; error?: unknown };
const resources = new WeakMap<object, Resource<unknown>>();

function usePromise<T>(promise: PromiseLike<T>): T {
	const key = promise as object;
	let resource = resources.get(key) as Resource<T> | undefined;
	if (resource === undefined) {
		resource = { status: 'pending', promise };
		resources.set(key, resource as Resource<unknown>);
		promise.then(
			(value) => {
				resource!.status = 'value';
				resource!.value = value;
				epoch++;
				emit('suspense-settle', undefined, {});
				for (const listener of reactListeners) listener(currentTransaction);
			},
			(error) => {
				resource!.status = 'error';
				resource!.error = error;
				epoch++;
				for (const listener of reactListeners) listener(currentTransaction);
			},
		);
	}
	if (resource.status === 'pending') throw resource.promise;
	if (resource.status === 'error') throw resource.error;
	return resource.value as T;
}

export function committed<T>(node: Atom<T> | Computed<T>, _container?: object): T {
	return node.get();
}

export function isPending(node: Atom<unknown> | Computed<unknown>): boolean {
	try {
		latest(node);
		return false;
	} catch (error) {
		if (error !== null && typeof (error as { then?: unknown }).then === 'function') return true;
		throw error;
	}
}

export function refresh(node: Atom<unknown> | Computed<unknown>): void {
	if (node instanceof Computed) {
		node.dirty = true;
		node.invalidate();
		for (const listener of reactListeners) listener(currentTransaction);
	}
}

export function serializeAtomState(atoms: readonly Atom<unknown>[], replacer?: (key: string, value: unknown) => unknown): string {
	const state: Record<string, unknown> = {};
	for (const item of atoms) {
		if (item.options.key === undefined) throw new Error('Every serialized atom needs a key');
		state[item.options.key] = item.get();
	}
	return JSON.stringify(state, replacer);
}

export function initializeAtomState(
	json: string,
	atoms: readonly Atom<unknown>[],
	reviver?: (key: string, value: unknown) => unknown,
): void {
	const state = JSON.parse(json, reviver) as Record<string, unknown>;
	for (const item of atoms) {
		const key = item.options.key;
		if (key !== undefined && Object.prototype.hasOwnProperty.call(state, key)) item.install(state[key]);
	}
}

export type TraceEvent = { id: TraceId; kind: string; cause?: TraceId; data?: Record<string, unknown> };
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
	traceSequence = 0;
	for (const tracer of [...tracers]) tracer.stop();
}
