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
const operations: Operation[] = [];
const atoms = new Map<NodeId, Atom<unknown>>();
const rootBatches = new WeakMap<object, Set<BatchToken>>();
const listeners = new Set<(node: Source, cause?: number) => void>();

function track(source: Source): void {
	if (active !== undefined && collecting !== undefined) collecting.set(source, source.version);
}

function replaceDeps(observer: Observer, next: Map<Source, number>): void {
	for (const source of observer.deps.keys()) {
		if (!next.has(source)) removeSubscriber(source, observer);
	}
	for (const source of next.keys()) {
		if (!observer.deps.has(source)) addSubscriber(source, observer);
	}
	observer.deps = next;
}

function addSubscriber(source: Source, observer: Observer): void {
	const first = source.subs.size === 0;
	source.subs.add(observer);
	if (first && source instanceof Atom) source.observed(true);
}

function removeSubscriber(source: Source, observer: Observer): void {
	source.subs.delete(observer);
	if (source.subs.size === 0 && source instanceof Atom) source.observed(false);
}

function invalidate(source: Source, cause?: number): void {
	for (const observer of source.subs) observer.onStale();
	for (const listener of listeners) listener(source, cause);
	if (batchDepth === 0) flushEffects();
}

function needsRun(observer: Observer): boolean {
	for (const [source, version] of observer.deps) {
		source.read();
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
				throw new Error('Reactive cycle did not converge');
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

function applies(op: Operation, mode: 'canonical' | 'latest' | 'committed'): boolean {
	const token = op.batch;
	if (token === undefined || !token.deferred || token.committed) return true;
	if (world !== undefined && world.batches.has(token)) return true;
	if (mode === 'latest' && world === undefined) return true;
	if (mode === 'committed' && world?.root !== undefined) {
		return rootBatches.get(world.root)?.has(token) === true;
	}
	return false;
}

function fold<T>(atom: Atom<T>, mode: 'canonical' | 'latest' | 'committed'): T {
	let value = atom.materialize();
	for (const op of operations) {
		if (op.atom === atom && op.batch?.deferred !== true && applies(op, mode)) value = (op as Operation<T>).reduce(value);
	}
	for (const op of operations) {
		if (op.atom === atom && op.batch?.deferred === true && applies(op, mode)) value = (op as Operation<T>).reduce(value);
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

	constructor(private initial: T | (() => T), readonly options: AtomOptions<T> = {}) {
		atoms.set(this.id, this as Atom<unknown>);
	}

	materialize(): T {
		if (!this.ready) {
			const previous = initializer;
			initializer = this as Atom<unknown>;
			try {
				this.value = typeof this.initial === 'function' ? untracked(this.initial as () => T) : this.initial;
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

	read(): T {
		track(this);
		return fold(this, 'canonical');
	}

	latest(): T {
		track(this);
		return fold(this, 'latest');
	}

	committed(container?: object): T {
		const previous = world;
		if (container !== undefined) world = { root: container, batches: rootBatches.get(container) ?? new Set() };
		try {
			return fold(this, 'committed');
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
			if (on && this.subs.size !== 0 && this.observation === undefined) {
				this.observation = this.options.effect!({ get: () => this.read(), set: value => this.set(value) }) ?? undefined;
			} else if (!on && this.subs.size === 0 && this.observation !== undefined) {
				this.observation();
				this.observation = undefined;
			}
		});
	}
}

export interface ComputedOptions<T> {
	equals?: Equality<T>;
	label?: string;
}

class Pending {
	constructor(readonly promises: PromiseLike<unknown>[]) {}
}

type AsyncRecord = { state: 'pending'; promise: PromiseLike<unknown> } | { state: 'value'; value: unknown } | { state: 'error'; error: unknown };
const asyncRecords = new WeakMap<object, AsyncRecord>();

function useThenable<T>(promise: PromiseLike<T>): T {
	const key = promise as object;
	let record = asyncRecords.get(key);
	if (record === undefined) {
		record = { state: 'pending', promise };
		asyncRecords.set(key, record);
		promise.then(
			value => {
				asyncRecords.set(key, { state: 'value', value });
				settlePromise(promise);
			},
			error => {
				asyncRecords.set(key, { state: 'error', error });
				settlePromise(promise);
			},
		);
	}
	if (record.state === 'pending') throw new Pending([promise]);
	if (record.state === 'error') throw record.error;
	return record.value as T;
}

const promiseComputeds = new WeakMap<object, Set<Computed<unknown>>>();

function settlePromise(promise: PromiseLike<unknown>): void {
	const set = promiseComputeds.get(promise as object);
	if (set === undefined) return;
	for (const computed of set) computed.onStale();
	flushEffects();
}

export class Computed<T> implements Source, Observer {
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

	constructor(private fn: (use: <U>(promise: PromiseLike<U>) => U) => T, private options: ComputedOptions<T> = {}) {}

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

	private evaluate(): void {
		if (this.evaluating) throw new Error('Reactive cycle detected');
		this.evaluating = true;
		this.changedWhileEvaluating = false;
		const previousActive = active;
		const previousCollecting = collecting;
		const next = new Map<Source, number>();
		active = this;
		collecting = next;
		let result!: T;
		let failure: unknown;
		try {
			result = this.fn(useThenable);
		} catch (error) {
			failure = error;
		} finally {
			active = previousActive;
			collecting = previousCollecting;
			this.evaluating = false;
		}
		replaceDeps(this, next);
		this.volatile = this.changedWhileEvaluating;
		this.stale = this.volatile;
		this.pending = failure instanceof Pending ? failure : undefined;
		this.error = failure instanceof Pending ? undefined : failure;
		if (this.pending !== undefined) {
			for (const promise of this.pending.promises) {
				let set = promiseComputeds.get(promise as object);
				if (set === undefined) promiseComputeds.set(promise as object, (set = new Set()));
				set.add(this as Computed<unknown>);
			}
			return;
		}
		if (failure !== undefined) return;
		if (!this.hasValue || !(this.options.equals ?? Object.is)(this.value, result)) {
			this.value = result;
			this.hasValue = true;
			this.version++;
		}
	}

	read(): T {
		if (this.stale && this.hasValue && !this.volatile && world === undefined) {
			let changed = false;
			for (const [source, version] of this.deps) {
				source.read();
				if (source.version !== version) {
					changed = true;
					break;
				}
			}
			if (!changed) this.stale = false;
		}
		if (this.stale || (world !== undefined && world.batches.size !== 0)) this.evaluate();
		track(this);
		if (this.pending !== undefined) throw this.pending.promises.length === 1 ? this.pending.promises[0] : Promise.all(this.pending.promises);
		if (this.error !== undefined) throw this.error;
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

	constructor(private fn: () => Cleanup) {}

	onStale(): void {
		if (this.disposed) return;
		this.stale = true;
		if (!this.queued) {
			this.queued = true;
			effects.add(this);
		}
	}

	run(): void {
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

export function computed<T>(fn: (use: <U>(promise: PromiseLike<U>) => U) => T, options?: ComputedOptions<T>): Computed<T> {
	return new Computed(fn, options);
}

export function effect(fn: () => Cleanup): () => void {
	const current = new Effect(fn);
	scope?.push(current);
	runningEffect?.children.push(current);
	current.run();
	return () => current.dispose();
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
			if ((target.options.equals ?? Object.is)(target.read(), snapshot.value)) target.version = snapshot.version;
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
	if (initializer !== undefined) throw new Error('A lazy initializer must not write signals');
	const before = fold(target, token?.deferred === true ? 'latest' : 'canonical');
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
	const op: Operation<T> = { id: nextOperation++, atom: target, batch: token, reduce };
	operations.push(op as Operation);
	if (token === undefined || !token.deferred) target.version++;
	invalidate(target, op.id);
}

export function read<T>(target: Atom<T> | Computed<T>): T {
	return target.read();
}

export function latest<T>(target: Atom<T> | Computed<T>): T {
	return target instanceof Atom ? target.latest() : target.read();
}

export function committed<T>(target: Atom<T> | Computed<T>, container?: object): T {
	return target instanceof Atom ? target.committed(container) : target.read();
}

export function isPending(target: Atom<unknown> | Computed<unknown>): boolean {
	if (target instanceof Computed) return target.isPending();
	for (const op of operations) if (op.atom === target && op.batch?.deferred && !op.batch.committed) return true;
	return false;
}

export function refresh(target: Atom<unknown> | Computed<unknown>): void {
	if (target instanceof Computed) target.onStale();
	else invalidate(target);
}

export function subscribe(target: Atom<unknown> | Computed<unknown>, notify: (cause?: number) => void): () => void {
	const listener = (source: Source, cause?: number) => {
		if (source === target) notify(cause);
	};
	listeners.add(listener);
	if (target instanceof Atom && target.subs.size === 0) target.observed(true);
	return () => {
		listeners.delete(listener);
		if (target instanceof Atom && target.subs.size === 0) target.observed(false);
	};
}

export interface HostRuntime {
	currentBatch(): BatchToken | undefined;
}

export function installHost(host?: HostRuntime): void {
	currentBatch = host?.currentBatch;
}

export function withWorld<T>(batches: ReadonlySet<BatchToken>, root: object | undefined, fn: () => T): T {
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
	for (const token of committed) set.add(token);
}

export function retireBatch(token: BatchToken, didCommit: boolean): void {
	token.live = false;
	token.committed = didCommit;
	if (didCommit && token.deferred) {
		const touched = new Set<Atom<unknown>>();
		for (const op of operations) if (op.batch === token) touched.add(op.atom);
		for (const target of touched) {
			target.version++;
			invalidate(target, token.cause);
		}
	}
}

export function serializeAtomState(targets: readonly Atom<unknown>[], replacer?: (key: string, value: unknown) => unknown): string {
	const values: Record<string, unknown> = {};
	for (const target of targets) {
		const key = target.options.label;
		if (key === undefined) throw new Error('serializeAtomState requires a label on every atom');
		values[key] = target.read();
	}
	return JSON.stringify(values, replacer);
}

export function initializeAtomState(json: string, targets: readonly Atom<unknown>[], reviver?: (key: string, value: unknown) => unknown): void {
	const values = JSON.parse(json, reviver) as Record<string, unknown>;
	for (const target of targets) {
		const key = target.options.label;
		if (key !== undefined && Object.prototype.hasOwnProperty.call(values, key)) target.install(values[key]);
	}
}

export type TraceEvent = { id: number; kind: string; cause?: number; node?: NodeId; batch?: BatchId };

export interface Trace {
	events(): TraceEvent[];
	whyLastDelivery(target: unknown): string[];
	stop(): void;
}

export function trace(capacity = 1024): Trace {
	const ring: TraceEvent[] = [];
	const listener = (source: Source, cause?: number) => {
		if (ring.length === capacity) ring.shift();
		ring.push({ id: nextOperation++, kind: 'delivery', cause, node: source instanceof Atom ? source.id : undefined });
	};
	listeners.add(listener);
	return {
		events: () => ring.slice(),
		whyLastDelivery(target) {
			const node = target instanceof Atom ? target.id : undefined;
			const found = ring.findLast(event => event.node === node);
			if (found === undefined) return [];
			const chain: string[] = [];
			let current: TraceEvent | undefined = found;
			while (current !== undefined) {
				chain.push(`${current.kind}#${current.id}`);
				current = current.cause === undefined ? undefined : ring.find(event => event.id === current!.cause);
			}
			return chain;
		},
		stop: () => listeners.delete(listener),
	};
}

export function reset(): void {
	for (const current of effects) current.dispose();
	effects.clear();
	operations.length = 0;
	atoms.clear();
	nextNode = 1;
	nextOperation = 1;
	active = undefined;
	collecting = undefined;
	world = undefined;
	batchDepth = 0;
}

export const __debug = { operations, atoms };
