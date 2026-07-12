export type Equality<T> = (a: T, b: T) => boolean

export interface AtomContext<T> {
	get(): T
	set(value: T): void
	update(fn: (value: T) => T): void
}

export interface AtomOptions<T> {
	equals?: Equality<T>
	isEqual?: Equality<T>
	effect?: (context: AtomContext<T>) => void | (() => void)
	onObserved?: (context: AtomContext<T>) => void | (() => void)
	label?: string
}

export interface AtomConfig<T> extends AtomOptions<T> {
	state: T | (() => T)
}

export interface ComputedContext<T> {
	readonly previous: T | undefined
	readonly refreshEpoch: number
	use<U>(thenable: PromiseLike<U>): U
}

export interface ComputedOptions<T> {
	equals?: Equality<T>
	isEqual?: Equality<T>
	label?: string
}

export interface ComputedConfig<T> extends ComputedOptions<T> {
	fn: (context: ComputedContext<T>) => T
}

export interface RuntimeOptions {
	onError?: (error: unknown) => void
}

export interface TraceSink {
	emit(kind: string, target: object | undefined, cause: number, detail?: unknown): number
}

const CLEAN = 0
const CHECK = 1
const DIRTY = 2
const DISPOSED = 3
const RUNNING = 4

type Consumer = Computed<any> | Reaction
type Source<T = any> = Atom<T> | Computed<T>
export type Signal<T = unknown> = Atom<T> | Computed<T>
type Owner = Scope | Reaction

interface ConsumerState {
	_deps: Source[]
	_depVersions: number[]
	_nextDeps?: Source[]
	_nextVersions?: number[]
	_cursor: number
	_dynamic: boolean
	_state: number
	_observing: boolean
}

interface Operation<T> {
	seq: number
	branch: Branch
	kind: 0 | 1
	value: T | ((value: T) => T)
	cause: number
}

interface ControlOperation {
	readonly seq: number
	readonly branch: Branch
	readonly refresh: boolean
	readonly cause: number
}

interface WorldMemo<T> {
	leaves: Atom[]
	value?: T
	error?: unknown
	pending?: PromiseLike<unknown>
	servePending?: boolean
}

interface ThenableRecord<T = unknown> {
	readonly thenable: PromiseLike<T>
	status: 0 | 1 | 2
	value?: T
	error?: unknown
	readonly listeners: Set<() => void>
}

interface AsyncEvaluation {
	readonly pending: ThenableRecord[]
	value?: unknown
	error?: unknown
}

export interface Branch {
	readonly id: number
	readonly lane: number
	readonly deferred: boolean
	cause: number
	lastCause: number
	retireCause: number
	status: 0 | 1 | 2
	lastSeq: number
	readonly atoms: Set<Atom<any>>
	readonly signals: Set<Computed<any>>
}

export interface RenderWorld {
	readonly runtime: Runtime
	readonly root: object
	readonly lanes: number
	readonly pin: number
	readonly cutoffs: Map<Branch, number>
	readonly memo: Map<Computed<any>, WorldMemo<any>>
	readonly deferred: boolean
	readonly speculative: boolean
	readonly settlementLane: number
	readonly newest: boolean
	readonly _cleanups: Array<() => void>
	_released: boolean
}

export interface RuntimeHost {
	write<T>(fn: (lane: number, deferred: boolean) => T): T
	run<T>(lane: number, fn: () => T): T
}

export type JournalListener = (branch: Branch, sequence: number, cause: number) => void

let nextRuntimeId = 1
let evaluationRuntime: Runtime | undefined

function applyOperation<T>(operation: Operation<T>, value: T): T {
	return operation.kind === 0 ? (operation.value as T) : (operation.value as (value: T) => T)(value)
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		(typeof value === 'object' || typeof value === 'function') &&
		value !== null &&
		typeof (value as PromiseLike<unknown>).then === 'function'
	)
}

function sameRecords(a: ThenableRecord[], b: ThenableRecord[]): boolean {
	if (a.length !== b.length) {
		return false
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false
		}
	}
	return true
}

function pendingThenable(records: ThenableRecord[]): PromiseLike<unknown> {
	if (records.length === 1) {
		return records[0].thenable
	}
	return new Promise<void>((resolve) => {
		let remaining = records.length
		const settled = () => {
			if (--remaining === 0) {
				resolve()
			}
		}
		for (let i = 0; i < records.length; i++) {
			records[i].thenable.then(settled, settled)
		}
	})
}

function containsSource(list: Source[], source: Source): boolean {
	for (let i = 0; i < list.length; i++) {
		if (list[i] === source) {
			return true
		}
	}
	return false
}

function sourceVersion(source: Source): number {
	return source._version
}

function consumerRuntime(consumer: Consumer): Runtime {
	return consumer.runtime
}

function addSubscriber(source: Source, consumer: Consumer): void {
	const single = source._subscriber
	if (single === undefined) {
		const subscribers = source._subscribers
		if (subscribers === undefined) {
			source._subscriber = consumer
		} else {
			subscribers.add(consumer)
		}
	} else if (single !== consumer) {
		source._subscriber = undefined
		const subscribers = new Set<Consumer>()
		subscribers.add(single)
		subscribers.add(consumer)
		source._subscribers = subscribers
	}
}

function removeSubscriber(source: Source, consumer: Consumer): void {
	if (source._subscriber === consumer) {
		source._subscriber = undefined
		return
	}
	const subscribers = source._subscribers
	if (subscribers === undefined) {
		return
	}
	subscribers.delete(consumer)
	if (subscribers.size === 1) {
		source._subscriber = subscribers.values().next().value
		source._subscribers = undefined
	}
}

function reconcileDependencies(consumer: ConsumerState & Consumer): void {
	if (consumer._state === DISPOSED) {
		if (consumer._nextDeps !== undefined) {
			consumer._nextDeps.length = 0
		}
		if (consumer._nextVersions !== undefined) {
			consumer._nextVersions.length = 0
		}
		return
	}
	const oldDeps = consumer._deps
	const oldVersions = consumer._depVersions
	if (!consumer._dynamic) {
		if (consumer._observing) {
			for (let i = consumer._cursor; i < oldDeps.length; i++) {
				removeSubscriber(oldDeps[i], consumer)
				consumerRuntime(consumer)._release(oldDeps[i])
			}
		}
		oldDeps.length = consumer._cursor
		oldVersions.length = consumer._cursor
		return
	}
	const nextDeps = consumer._nextDeps!
	const nextVersions = consumer._nextVersions!
	if (oldDeps.length === nextDeps.length) {
		let unchanged = true
		for (let i = 0; i < oldDeps.length; i++) {
			if (oldDeps[i] !== nextDeps[i]) {
				unchanged = false
				break
			}
		}
		if (unchanged) {
			for (let i = 0; i < oldVersions.length; i++) {
				oldVersions[i] = nextVersions[i]!
			}
			nextDeps.length = 0
			nextVersions.length = 0
			return
		}
	}

	if (consumer._observing) {
		for (let i = 0; i < oldDeps.length; i++) {
			const source = oldDeps[i]
			if (!containsSource(nextDeps, source)) {
				removeSubscriber(source, consumer)
				consumerRuntime(consumer)._release(source)
			}
		}

		for (let i = 0; i < nextDeps.length; i++) {
			const source = nextDeps[i]
			if (!containsSource(oldDeps, source)) {
				addSubscriber(source, consumer)
				consumerRuntime(consumer)._retain(source)
			}
		}
	}

	consumer._deps = nextDeps
	consumer._depVersions = nextVersions
	consumer._nextDeps = oldDeps
	consumer._nextVersions = oldVersions
	consumer._nextDeps.length = 0
	consumer._nextVersions.length = 0
}

function detachConsumer(consumer: ConsumerState & Consumer): void {
	const runtime = consumerRuntime(consumer)
	for (let i = 0; i < consumer._deps.length; i++) {
		const source = consumer._deps[i]
		if (consumer._observing) {
			removeSubscriber(source, consumer)
			runtime._release(source)
		}
	}
	consumer._deps.length = 0
	consumer._depVersions.length = 0
}

export class Runtime {
	readonly id = nextRuntimeId++
	readonly errors: unknown[] = []
	private readonly onError?: (error: unknown) => void
	private activeConsumer: Consumer | undefined
	private activeOwner: Owner | undefined
	private activeWorld: RenderWorld | undefined
	private readonly collectors: Atom<any>[][] = []
	private readonly effectQueue: Reaction[] = []
	private queueIndex = 0
	private batchDepth = 0
	private batchId = 0
	private readonly batchAtoms: Atom<any>[] = []
	private flushing = false
	private writesForbidden = 0
	private host?: RuntimeHost
	private sequence = 0
	private mutationEpoch = 0
	private nextBranchId = 1
	private readonly branchesByLane = new Map<number, Branch>()
	private readonly tapedAtoms = new Set<Atom<any>>()
	private readonly tapedComputeds = new Set<Computed<any>>()
	private readonly noCutoffs = new Map<Branch, number>()
	private readonly thenables = new WeakMap<object, ThenableRecord>()
	private readonly asyncFrames: AsyncEvaluation[] = []
	private readonly evaluationFrames: Array<AsyncEvaluation | undefined> = []
	private readonly syncEvaluation: AsyncEvaluation = { pending: [] }
	private evaluationDepth = 0
	private readonly checkNodes: Computed<any>[] = []
	private readonly checkIndices: number[] = []
	private checkDepth = 0
	private openWorlds = 0
	private compactPending = false
	private trace?: TraceSink
	private traceCause = 0

	constructor(options: RuntimeOptions = {}) {
		this.onError = options.onError
	}

	attachHost(host: RuntimeHost): () => void {
		if (this.host !== undefined && this.host !== host) {
			throw new Error('This Strata runtime already has a React host.')
		}
		this.host = host
		return () => {
			if (this.host === host) {
				this.host = undefined
			}
		}
	}

	attachTrace(trace: TraceSink): () => void {
		this.trace = trace
		return () => {
			if (this.trace === trace) {
				this.trace = undefined
			}
		}
	}

	emitTrace(kind: string, target?: object, cause = 0, detail?: unknown): number {
		return this.trace?.emit(kind, target, cause, detail) ?? 0
	}

	atom<T>(initial: T | (() => T), options: AtomOptions<T> = {}): Atom<T> {
		return new Atom(initial, options, this)
	}

	reducerAtom<S, A>(
		reducer: (state: S, action: A) => S,
		initial: S | (() => S),
		options: AtomOptions<S> = {},
	): ReducerAtom<S, A> {
		return new ReducerAtom(reducer, initial, options, this)
	}

	computed<T>(
		fn: (context: ComputedContext<T>) => T,
		options: ComputedOptions<T> = {},
	): Computed<T> {
		return new Computed(fn, options, this)
	}

	effect(fn: () => void | (() => void)): () => void {
		const reaction = new Reaction(this, fn, this.activeOwner)
		const dispose = () => reaction.dispose()
		reaction._traceTarget = dispose
		this._runReaction(reaction)
		return dispose
	}

	effectScope(fn: () => void): () => void {
		const scope = new Scope(this.activeOwner)
		if (this.activeOwner !== undefined) {
			this.activeOwner._children.push(scope)
		}
		const previous = this.activeOwner
		this.activeOwner = scope
		try {
			fn()
		} finally {
			this.activeOwner = previous
		}
		return () => scope.dispose()
	}

	batch<T>(fn: () => T): T {
		this.startBatch()
		try {
			return fn()
		} finally {
			this.endBatch()
		}
	}

	startBatch(): void {
		if (this.batchDepth++ === 0) {
			this.batchId++
			this.batchAtoms.length = 0
		}
	}

	endBatch(): void {
		if (this.batchDepth === 0) {
			throw new Error('endBatch() without startBatch()')
		}
		if (--this.batchDepth === 0) {
			for (let i = 0; i < this.batchAtoms.length; i++) {
				const atom = this.batchAtoms[i]
				if (atom.equals(atom._batchValue, atom._value)) {
					atom._version = atom._batchVersion
				}
				atom._batchValue = undefined
			}
			this.batchAtoms.length = 0
			this._flush()
		}
	}

	untracked<T>(fn: () => T): T {
		const previous = this.activeConsumer
		this.activeConsumer = undefined
		try {
			return fn()
		} finally {
			this.activeConsumer = previous
		}
	}

	_useThenable<T>(thenable: PromiseLike<T>): T {
		let record = this.thenables.get(thenable) as ThenableRecord<T> | undefined
		if (record === undefined) {
			record = { thenable, status: 0, listeners: new Set() }
			this.thenables.set(thenable, record)
			thenable.then(
				(value) => {
					record!.status = 1
					record!.value = value
					for (const listener of record!.listeners) {
						listener()
					}
				},
				(error) => {
					record!.status = 2
					record!.error = error
					for (const listener of record!.listeners) {
						listener()
					}
				},
			)
		}
		if (record.status === 1) {
			return record.value as T
		}
		if (record.status === 2) {
			const evaluation = this.evaluationFrames[this.evaluationDepth - 1]
			if (evaluation !== undefined) {
				evaluation.error ??= record.error
				return undefined as T
			}
			throw record.error
		}
		if (this.evaluationDepth !== 0) {
			const depth = this.evaluationDepth - 1
			let evaluation = this.evaluationFrames[depth]
			if (evaluation === undefined) {
				evaluation = this.asyncFrames[depth]
				if (evaluation === undefined) {
					evaluation = { pending: [] }
					this.asyncFrames[depth] = evaluation
				}
				evaluation.pending.length = 0
				evaluation.value = undefined
				evaluation.error = undefined
				this.evaluationFrames[depth] = evaluation
			}
			let found = false
			for (let i = 0; i < evaluation.pending.length; i++) {
				if (evaluation.pending[i] === record) {
					found = true
					break
				}
			}
			if (!found) {
				evaluation.pending.push(record)
			}
			return undefined as T
		}
		throw thenable
	}

	private _evaluate<T>(computed: Computed<T>): AsyncEvaluation & { value?: T } {
		const depth = this.evaluationDepth++
		this.evaluationFrames[depth] = undefined
		const previousRuntime = evaluationRuntime
		evaluationRuntime = this
		let value: T | undefined
		let error: unknown
		try {
			value = computed._fn(computed._context)
		} catch (caught) {
			if (isThenable(caught)) {
				this._useThenable(caught)
			} else {
				error = caught
			}
		} finally {
			evaluationRuntime = previousRuntime
			this.evaluationDepth--
		}
		const evaluation = this.evaluationFrames[depth] ?? this.syncEvaluation
		this.evaluationFrames[depth] = undefined
		evaluation.value = value
		if (error !== undefined) {
			evaluation.error = error
		} else if (evaluation === this.syncEvaluation) {
			evaluation.error = undefined
		}
		return evaluation as AsyncEvaluation & { value?: T }
	}

	private _detachAsync(computed: Computed<any>): void {
		const subscriptions = computed._asyncSubscriptions
		if (subscriptions === undefined) {
			return
		}
		for (let i = 0; i < subscriptions.length; i++) {
			const subscription = subscriptions[i]
			subscription.record.listeners.delete(subscription.listener)
		}
		subscriptions.length = 0
	}

	_disposeComputed(computed: Computed<any>): void {
		this._detachAsync(computed)
		detachConsumer(computed)
	}

	private _attachAsync(computed: Computed<any>, records: ThenableRecord[]): void {
		this._detachAsync(computed)
		const subscriptions = (computed._asyncSubscriptions ??= [])
		const generation = ++computed._asyncGeneration
		for (let i = 0; i < records.length; i++) {
			const record = records[i]
			const listener = () => {
				if (computed._asyncGeneration !== generation || computed._state === DISPOSED) {
					return
				}
				const previousCause = this.traceCause
				this.traceCause = computed._cause
				try {
					this._settle(computed)
				} finally {
					this.traceCause = previousCause
				}
			}
			record.listeners.add(listener)
			subscriptions.push({ record, listener })
		}
	}

	private _watchWorldPending(
		computed: Computed<any>,
		records: ThenableRecord[],
		world: RenderWorld,
	): void {
		const host = this.host
		if (host === undefined || world.settlementLane === 0) {
			return
		}
		if (
			!world.deferred &&
			computed._pendingRecords !== undefined &&
			sameRecords(computed._pendingRecords, records)
		) {
			return
		}
		for (let i = 0; i < records.length; i++) {
			const record = records[i]
			const listener = () => {
				if (world._released) {
					return
				}
				const previousCause = this.traceCause
				this.traceCause = computed._cause
				try {
					host.run(world.settlementLane, () => {
						this._settle(computed)
					})
				} finally {
					this.traceCause = previousCause
				}
			}
			record.listeners.add(listener)
			world._cleanups.push(() => record.listeners.delete(listener))
		}
	}

	private _settle(computed: Computed<any>): void {
		if (this.host === undefined) {
			this.mutationEpoch++
			computed._state = DIRTY
			const cause = this.emitTrace('suspense-settlement', computed, this.traceCause)
			this._invalidate(computed, cause)
			this._flush()
			return
		}
		this.host.write((lane, deferred) => {
			this._control(computed, lane, deferred, false)
		})
	}

	private _control(
		computed: Computed<any>,
		lane: number,
		deferred: boolean,
		refresh: boolean,
	): void {
		const branch = this._branch(lane, deferred)
		this.mutationEpoch++
		const operation: ControlOperation = {
			seq: ++this.sequence,
			branch,
			refresh,
			cause: this.emitTrace(refresh ? 'refresh' : 'suspense-settlement', computed, branch.cause, {
				branch: branch.id,
				lane,
				deferred,
			}),
		}
		;(computed._controlTape ??= []).push(operation)
		this.tapedComputeds.add(computed)
		branch.lastSeq = operation.seq
		branch.lastCause = operation.cause
		branch.signals.add(computed)
		if (!deferred) {
			if (refresh) {
				computed._refreshEpoch = this._foldRefresh(computed, 0)
			}
			computed._state = DIRTY
			computed._cause = operation.cause
			this._invalidate(computed, operation.cause)
		}
		this._notifyJournal(computed, branch, operation.seq, operation.cause)
		this._flush()
	}

	_read<T>(source: Source<T>): T {
		return source instanceof Atom ? this._readAtom(source) : this._readComputed(source)
	}

	_readAtom<T>(atom: Atom<T>): T {
		if (this.activeWorld !== undefined) {
			return this._readWorld(atom, this.activeWorld)
		}
		this._track(atom)
		return this._materialize(atom)
	}

	_readComputed<T>(computed: Computed<T>): T {
		if (this.activeWorld !== undefined) {
			return this._readWorld(computed, this.activeWorld)
		}
		this._updateComputed(computed)
		this._track(computed)
		if (computed._error !== undefined) {
			throw computed._error
		}
		if (computed._pending !== undefined) {
			throw computed._pending
		}
		return computed._value as T
	}

	_write<T>(atom: Atom<T>, kind: 0 | 1, value: T | ((value: T) => T)): void {
		if (this.writesForbidden !== 0) {
			throw new Error('Signals cannot be written in this context.')
		}
		if (this.host === undefined) {
			this._writeCanonical(atom, kind, value)
			return
		}
		this.host.write((lane, deferred) => {
			this._writeBranch(atom, lane, deferred, kind, value)
		})
	}

	private _writeCanonical<T>(atom: Atom<T>, kind: 0 | 1, value: T | ((value: T) => T)): void {
		const previous = this._materialize(atom)
		this._snapshot(atom, previous)
		const next = kind === 0 ? (value as T) : (value as (value: T) => T)(previous)
		if (atom.equals(previous, next)) {
			return
		}
		const cause = this.emitTrace('write', atom, this.traceCause)
		atom._value = next
		atom._latest = next
		atom._version++
		this.mutationEpoch++
		this._invalidate(atom, cause)
		this._flush()
	}

	private _writeBranch<T>(
		atom: Atom<T>,
		lane: number,
		deferred: boolean,
		kind: 0 | 1,
		value: T | ((value: T) => T),
	): void {
		this._materialize(atom)
		this._snapshot(atom, atom._value)
		const branch = this._branch(lane, deferred)
		if (atom._tape === undefined) {
			atom._base = atom._value
			atom._tape = []
			this.tapedAtoms.add(atom)
		}
		const writerValue = this._fold(atom, 2, branch)
		const next = kind === 0 ? (value as T) : (value as (value: T) => T)(writerValue)
		if (atom.equals(writerValue, next)) {
			return
		}
		const operation: Operation<T> = {
			seq: ++this.sequence,
			branch,
			kind,
			value,
			cause: this.emitTrace('write', atom, branch.cause, {
				branch: branch.id,
				lane,
				deferred,
			}),
		}
		branch.lastCause = operation.cause
		atom._tape.push(operation)
		this.mutationEpoch++
		branch.lastSeq = operation.seq
		branch.atoms.add(atom)
		atom._latest = this._fold(atom, 1)
		if (!deferred) {
			const previous = atom._value
			atom._value = kind === 0 ? (value as T) : (value as (value: T) => T)(previous)
			if (!atom.equals(previous, atom._value)) {
				atom._version++
				this._invalidate(atom, operation.cause)
			}
		}
		this._notifyJournal(atom, branch, operation.seq, operation.cause)
		this._flush()
	}

	private _branch(lane: number, deferred: boolean): Branch {
		const existing = this.branchesByLane.get(lane)
		if (existing !== undefined && existing.status === 0) {
			return existing
		}
		const branch: Branch = {
			id: this.nextBranchId++,
			lane,
			deferred,
			cause: 0,
			lastCause: 0,
			retireCause: 0,
			status: 0,
			lastSeq: 0,
			atoms: new Set(),
			signals: new Set(),
		}
		branch.cause = this.emitTrace('batch-open', branch, this.traceCause, { lane, deferred })
		this.branchesByLane.set(lane, branch)
		return branch
	}

	activeBranches(): IterableIterator<Branch> {
		return this.branchesByLane.values()
	}

	finishBranch(branch: Branch, committed: boolean): void {
		if (branch.status !== 0) {
			return
		}
		this.mutationEpoch++
		branch.status = committed ? 1 : 2
		branch.retireCause = this.emitTrace('batch-retire', branch, branch.lastCause || branch.cause, {
			committed,
		})
		if (this.branchesByLane.get(branch.lane) === branch) {
			this.branchesByLane.delete(branch.lane)
		}
		for (const atom of branch.atoms) {
			const previous = atom._value
			atom._value = this._fold(atom, 0)
			atom._latest = this._fold(atom, 1)
			if (!atom.equals(previous, atom._value)) {
				atom._version++
				this._invalidate(atom, branch.retireCause)
			}
			this._notifyJournal(atom, branch, branch.lastSeq, branch.retireCause)
		}
		for (const computed of branch.signals) {
			if (branch.deferred) {
				const previousEpoch = computed._refreshEpoch
				computed._refreshEpoch = this._foldRefresh(computed, 0)
				let settled = false
				const tape = computed._controlTape
				if (tape !== undefined) {
					for (let i = 0; i < tape.length; i++) {
						if (tape[i].branch === branch && !tape[i].refresh) {
							settled = true
							break
						}
					}
				}
				if (settled || previousEpoch !== computed._refreshEpoch) {
					computed._state = DIRTY
					computed._cause = branch.retireCause
					this._invalidate(computed, branch.retireCause)
				}
			}
			this._notifyJournal(computed, branch, branch.lastSeq, branch.retireCause)
		}
		if (this.branchesByLane.size === 0) {
			this.compactPending = true
			this._compact()
		}
		this._flush()
	}

	private _fold<T>(atom: Atom<T>, mode: 0 | 1 | 2 | 3, context?: Branch | RenderWorld): T {
		let value = atom._base
		const tape = atom._tape
		if (tape === undefined) {
			return atom._value
		}
		for (let i = 0; i < tape.length; i++) {
			const operation = tape[i]
			let include: boolean
			if (mode === 0) {
				include = !operation.branch.deferred || operation.branch.status === 1
			} else if (mode === 1) {
				include = operation.branch.status !== 2
			} else if (mode === 2) {
				include =
					operation.branch === context ||
					!operation.branch.deferred ||
					operation.branch.status === 1
			} else {
				const world = context as RenderWorld
				const cutoff = world.cutoffs.get(operation.branch) ?? 0
				include = world.newest
					? operation.branch.status !== 2
					: operation.seq <= cutoff ||
						(operation.seq <= world.pin && (operation.branch.lane & world.lanes) !== 0)
			}
			if (include) {
				value = applyOperation(operation, value)
			}
		}
		return value
	}

	private _foldRefresh(computed: Computed<any>, mode: 0 | 3, world?: RenderWorld): number {
		let epoch = computed._refreshBase
		const tape = computed._controlTape
		if (tape === undefined) {
			return computed._refreshEpoch
		}
		for (let i = 0; i < tape.length; i++) {
			const operation = tape[i]
			if (!operation.refresh) {
				continue
			}
			let include: boolean
			if (mode === 0) {
				include = !operation.branch.deferred || operation.branch.status === 1
			} else {
				const cutoff = world!.cutoffs.get(operation.branch) ?? 0
				include = world!.newest
					? operation.branch.status !== 2
					: operation.seq <= cutoff ||
						(operation.seq <= world!.pin && (operation.branch.lane & world!.lanes) !== 0)
			}
			if (include) {
				epoch++
			}
		}
		return epoch
	}

	private _snapshot<T>(atom: Atom<T>, value: T): void {
		if (this.batchDepth !== 0 && atom._batchId !== this.batchId) {
			atom._batchId = this.batchId
			atom._batchValue = value
			atom._batchVersion = atom._version
			this.batchAtoms.push(atom)
		}
	}

	private _compact(): void {
		if (!this.compactPending || this.openWorlds !== 0) {
			return
		}
		this.compactPending = false
		for (const atom of this.tapedAtoms) {
			atom._base = atom._value
			atom._latest = atom._value
			atom._tape = undefined
		}
		this.tapedAtoms.clear()
		for (const computed of this.tapedComputeds) {
			computed._refreshBase = computed._refreshEpoch
			computed._controlTape = undefined
		}
		this.tapedComputeds.clear()
	}

	createWorld(
		root: object,
		lanes: number,
		cutoffs: Map<Branch, number>,
		deferred = false,
		speculative = false,
		settlementLane = 0,
		newest = false,
	): RenderWorld {
		const snapshot = new Map<Branch, number>()
		for (const [branch, cutoff] of cutoffs) {
			snapshot.set(branch, cutoff)
		}
		this.openWorlds++
		return {
			runtime: this,
			root,
			lanes,
			pin: this.sequence,
			cutoffs: snapshot,
			memo: new Map(),
			deferred,
			speculative,
			settlementLane,
			newest,
			_cleanups: [],
			_released: false,
		}
	}

	releaseWorld(world: RenderWorld): void {
		if (world.runtime !== this || world._released) {
			return
		}
		world._released = true
		for (let i = 0; i < world._cleanups.length; i++) {
			world._cleanups[i]()
		}
		world._cleanups.length = 0
		world.memo.clear()
		this.openWorlds--
		this._compact()
	}

	commitWorld(world: RenderWorld): void {
		if (world.runtime !== this || world._released) {
			return
		}
		for (const [computed, memo] of world.memo) {
			if (memo.error !== undefined || memo.pending !== undefined) {
				continue
			}
			computed._stableValue = memo.value
			computed._hasStable = true
		}
	}

	withWorld<T>(world: RenderWorld, leaves: Atom<any>[], fn: () => T): T {
		if (world.runtime !== this) {
			throw new Error('Render world belongs to another Strata runtime.')
		}
		const previousWorld = this.activeWorld
		const previousConsumer = this.activeConsumer
		this.activeWorld = world
		this.activeConsumer = undefined
		leaves.length = 0
		this.collectors.push(leaves)
		try {
			return fn()
		} finally {
			this.collectors.pop()
			this.activeConsumer = previousConsumer
			this.activeWorld = previousWorld
		}
	}

	_readWorld<T>(source: Source<T>, world: RenderWorld): T {
		if (source instanceof Atom) {
			this._recordLeaf(source)
			this._materialize(source)
			if (source._tape === undefined) {
				return source._value
			}
			return this._fold(source, 3, world)
		}
		if (!world.speculative) {
			const previousWorld = this.activeWorld
			this.activeWorld = undefined
			try {
				this._updateComputed(source)
				this._recordSourceLeaves(source)
				if (source._error !== undefined) {
					throw source._error
				}
				if (source._pending !== undefined) {
					if (source._hasStable && !world.deferred) {
						return source._stableValue as T
					}
					throw source._pending
				}
				return source._value as T
			} finally {
				this.activeWorld = previousWorld
			}
		}

		const cached = world.memo.get(source) as WorldMemo<T> | undefined
		if (cached !== undefined) {
			this._recordLeaves(cached.leaves)
			if (cached.error !== undefined) {
				throw cached.error
			}
			if (cached.pending !== undefined && !cached.servePending) {
				throw cached.pending
			}
			return cached.value as T
		}

		const leaves: Atom<any>[] = []
		this.collectors.push(leaves)
		let memo: WorldMemo<T>
		try {
			const result = this._evaluate(source)
			if (result.error !== undefined) {
				memo = { leaves, error: result.error }
			} else if (result.pending.length !== 0) {
				const pending = pendingThenable(result.pending)
				this._watchWorldPending(source, result.pending, world)
				memo =
					source._hasStable && !world.deferred
						? { leaves, value: source._stableValue, pending, servePending: true }
						: { leaves, pending }
			} else {
				memo = { leaves, value: result.value }
			}
		} finally {
			this.collectors.pop()
		}
		world.memo.set(source, memo)
		this._recordLeaves(leaves)
		if (memo.error !== undefined) {
			throw memo.error
		}
		if (memo.pending !== undefined && !memo.servePending) {
			throw memo.pending
		}
		return memo.value as T
	}

	pendingInWorld(source: Source, world: RenderWorld): boolean {
		if (source instanceof Atom) {
			return this.isPending(source)
		}
		if (!world.speculative) {
			this._updateComputed(source)
			return source._pending !== undefined && source._hasStable
		}
		let memo = world.memo.get(source)
		if (memo === undefined) {
			try {
				this._readWorld(source, world)
			} catch {
				// The memo records the pending/error outcome.
			}
			memo = world.memo.get(source)
		}
		return memo?.pending !== undefined && source._hasStable
	}

	latest<T>(source: Source<T>): T | undefined {
		if (this.activeWorld !== undefined) {
			try {
				return this._readWorld(source, this.activeWorld)
			} catch (error) {
				if (isThenable(error) && source instanceof Computed) {
					return source._hasStable ? source._stableValue : undefined
				}
				throw error
			}
		}
		if (source instanceof Atom) {
			this._materialize(source)
			return source._latest
		}
		if (this.activeConsumer === undefined && this.branchesByLane.size !== 0) {
			let lanes = 0
			for (const branch of this.branchesByLane.values()) {
				lanes |= branch.lane
			}
			const world = this.createWorld(this, lanes, this.noCutoffs, true, true, 0, true)
			try {
				return this.withWorld(world, [], () => this.latest(source))
			} finally {
				this.releaseWorld(world)
			}
		}
		this._updateComputed(source)
		if (source._error !== undefined) {
			throw source._error
		}
		return source._hasStable ? source._stableValue : undefined
	}

	committed<T>(source: Source<T>): T | undefined {
		const previousWorld = this.activeWorld
		this.activeWorld = undefined
		try {
			if (source instanceof Atom) {
				return this._materialize(source)
			}
			this._updateComputed(source)
			if (source._error !== undefined) {
				throw source._error
			}
			if (source._pending !== undefined) {
				return source._hasStable ? source._stableValue : undefined
			}
			return source._value
		} finally {
			this.activeWorld = previousWorld
		}
	}

	isPending(source: Source): boolean {
		if (source instanceof Atom) {
			const tape = source._tape
			if (tape === undefined) {
				return false
			}
			for (let i = 0; i < tape.length; i++) {
				const branch = tape[i].branch
				if (branch.deferred && branch.status === 0) {
					return true
				}
			}
			return false
		}
		if (
			this.activeWorld === undefined &&
			this.activeConsumer === undefined &&
			this.branchesByLane.size !== 0
		) {
			let lanes = 0
			for (const branch of this.branchesByLane.values()) {
				lanes |= branch.lane
			}
			const world = this.createWorld(this, lanes, this.noCutoffs, true, true, 0, true)
			try {
				return this.pendingInWorld(source, world)
			} finally {
				this.releaseWorld(world)
			}
		}
		this._updateComputed(source)
		return source._pending !== undefined && source._hasStable
	}

	refresh(source: Source): void {
		if (source instanceof Atom) {
			return
		}
		if (this.host === undefined) {
			const cause = this.emitTrace('refresh', source, this.traceCause)
			this.mutationEpoch++
			source._refreshEpoch++
			source._refreshBase = source._refreshEpoch
			source._state = DIRTY
			source._cause = cause
			this._invalidate(source, cause)
			this._flush()
			if (source._state !== CLEAN) {
				this._updateComputed(source)
			}
			return
		}
		const deferred = this.host.write((lane, isDeferred) => {
			this._control(source, lane, isDeferred, true)
			return isDeferred
		})
		if (!deferred && source._state !== CLEAN) {
			this._updateComputed(source)
		}
	}

	_refreshValue(computed: Computed<any>): number {
		return this.activeWorld === undefined || computed._controlTape === undefined
			? computed._refreshEpoch
			: this._foldRefresh(computed, 3, this.activeWorld)
	}

	private _notifyJournal(
		source: Signal<any>,
		branch: Branch,
		sequence: number,
		cause: number,
	): void {
		if (source._journalListeners === undefined) {
			return
		}
		for (const listener of source._journalListeners) {
			listener(branch, sequence, cause)
		}
	}

	subscribeJournal(source: Signal<any>, listener: JournalListener): () => void {
		;(source._journalListeners ??= new Set()).add(listener)
		return () => {
			const listeners = source._journalListeners
			if (listeners === undefined) {
				return
			}
			listeners.delete(listener)
			if (listeners.size === 0) {
				source._journalListeners = undefined
			}
		}
	}

	scanJournal(source: Signal<any>, visit: JournalListener): void {
		if (source instanceof Atom) {
			const tape = source._tape
			if (tape === undefined) {
				return
			}
			for (let i = 0; i < tape.length; i++) {
				const operation = tape[i]
				visit(operation.branch, operation.seq, operation.cause)
			}
		} else {
			const tape = source._controlTape
			if (tape === undefined) {
				return
			}
			for (let i = 0; i < tape.length; i++) {
				const operation = tape[i]
				visit(operation.branch, operation.seq, operation.cause)
			}
		}
	}

	installState<T>(atom: Atom<T>, value: T): void {
		atom._initializer = undefined
		atom._ready = true
		atom._value = value
		atom._latest = value
		atom._base = value
		atom._tape = undefined
	}

	serialize(
		atoms: Record<string, Atom<any>>,
		replacer?: (key: string, value: unknown) => unknown,
	): string {
		const state: Record<string, unknown> = {}
		for (const key in atoms) {
			if (Object.prototype.hasOwnProperty.call(atoms, key)) {
				state[key] = this.committed(atoms[key])
			}
		}
		return JSON.stringify(state, replacer)
	}

	initialize(
		json: string,
		atoms: Record<string, Atom<any>>,
		reviver?: (key: string, value: unknown) => unknown,
	): void {
		const state = JSON.parse(json, reviver) as Record<string, unknown>
		for (const key in atoms) {
			if (
				Object.prototype.hasOwnProperty.call(atoms, key) &&
				Object.prototype.hasOwnProperty.call(state, key)
			) {
				this.installState(atoms[key], state[key])
			}
		}
	}

	_retain(source: Source): void {
		if (source._observers++ !== 0) {
			return
		}
		if (source instanceof Atom) {
			this._materialize(source)
			this._scheduleLifecycle(source)
			return
		}
		this._updateComputed(source)
		source._observing = true
		for (let i = 0; i < source._deps.length; i++) {
			const dependency = source._deps[i]
			addSubscriber(dependency, source)
			this._retain(dependency)
		}
	}

	_release(source: Source): void {
		if (source._observers === 0 || --source._observers !== 0) {
			return
		}
		if (source instanceof Atom) {
			this._scheduleLifecycle(source)
			return
		}
		source._observing = false
		for (let i = 0; i < source._deps.length; i++) {
			const dependency = source._deps[i]
			removeSubscriber(dependency, source)
			this._release(dependency)
		}
	}

	private _materialize<T>(atom: Atom<T>): T {
		if (atom._ready) {
			return atom._value
		}
		const initializer = atom._initializer!
		const previousConsumer = this.activeConsumer
		this.activeConsumer = undefined
		this.writesForbidden++
		try {
			atom._value = initializer()
			atom._latest = atom._value
			atom._base = atom._value
			atom._ready = true
			atom._initializer = undefined
		} finally {
			this.writesForbidden--
			this.activeConsumer = previousConsumer
		}
		return atom._value
	}

	private _track(source: Source): void {
		const consumer = this.activeConsumer
		if (consumer === undefined || consumer.runtime !== this || consumer._state === DISPOSED) {
			return
		}
		const index = consumer._cursor++
		if (!consumer._dynamic && consumer._deps[index] === source) {
			consumer._depVersions[index] = sourceVersion(source)
			return
		}
		if (!consumer._dynamic) {
			for (let i = 0; i < index; i++) {
				if (consumer._deps[i] === source) {
					consumer._cursor--
					return
				}
			}
			if (index === consumer._deps.length) {
				consumer._deps.push(source)
				consumer._depVersions.push(sourceVersion(source))
				if (consumer._observing) {
					addSubscriber(source, consumer)
					consumer.runtime._retain(source)
				}
				return
			}
			consumer._dynamic = true
			const nextDeps = (consumer._nextDeps ??= [])
			const nextVersions = (consumer._nextVersions ??= [])
			for (let i = 0; i < index; i++) {
				nextDeps.push(consumer._deps[i])
				nextVersions.push(consumer._depVersions[i])
			}
		}
		const nextDeps = consumer._nextDeps!
		if (containsSource(nextDeps, source)) {
			return
		}
		nextDeps.push(source)
		consumer._nextVersions!.push(sourceVersion(source))
	}

	private _recordLeaf(atom: Atom<any>): void {
		for (let i = 0; i < this.collectors.length; i++) {
			const collector = this.collectors[i]
			let found = false
			for (let j = 0; j < collector.length; j++) {
				if (collector[j] === atom) {
					found = true
					break
				}
			}
			if (!found) {
				collector.push(atom)
			}
		}
	}

	private _recordLeaves(leaves: Atom<any>[]): void {
		for (let i = 0; i < leaves.length; i++) {
			this._recordLeaf(leaves[i])
		}
	}

	private _recordSourceLeaves(source: Source): void {
		if (source instanceof Atom) {
			this._recordLeaf(source)
			return
		}
		for (let i = 0; i < source._deps.length; i++) {
			this._recordSourceLeaves(source._deps[i])
		}
	}

	private _invalidate(source: Source, cause: number): void {
		const subscriber = source._subscriber
		if (subscriber !== undefined) {
			this._invalidateConsumer(subscriber, cause)
		}
		const subscribers = source._subscribers
		if (subscribers === undefined) {
			return
		}
		for (const consumer of subscribers) {
			this._invalidateConsumer(consumer, cause)
		}
	}

	private _invalidateConsumer(consumer: Consumer, cause: number): void {
		if (consumer._state !== CLEAN) {
			return
		}
		consumer._state = CHECK
		consumer._cause = cause
		if (consumer instanceof Reaction) {
			this._enqueue(consumer)
		} else {
			this._invalidate(consumer, cause)
		}
	}

	private _consumerChanged(consumer: ConsumerState & Consumer): boolean {
		for (let i = 0; i < consumer._deps.length; i++) {
			const source = consumer._deps[i]
			if (source instanceof Computed) {
				this._updateComputed(source)
			}
			if (sourceVersion(source) !== consumer._depVersions[i]) {
				return true
			}
		}
		return false
	}

	_updateComputed<T>(computed: Computed<T>): void {
		if (computed._state === CLEAN) {
			if (computed._observing || computed._checkedEpoch === this.mutationEpoch) {
				return
			}
			computed._state = CHECK
		}
		if (computed._state === RUNNING) {
			throw new Error('Reactive cycle detected.')
		}
		if (computed._state === CHECK) {
			this._checkComputed(computed)
			return
		}
		this._recompute(computed)
	}

	private _checkComputed(root: Computed<any>): void {
		const base = this.checkDepth
		let depth = 0
		let computed = root
		let index = 0
		while (true) {
			let changed = false
			for (; index < computed._deps.length; index++) {
				const dependency = computed._deps[index]
				if (
					dependency instanceof Computed &&
					(dependency._state !== CLEAN ||
						(!dependency._observing && dependency._checkedEpoch !== this.mutationEpoch))
				) {
					if (dependency._state === CLEAN) {
						dependency._state = CHECK
					}
					if (dependency._state === RUNNING) {
						throw new Error('Reactive cycle detected.')
					}
					if (dependency._state === CHECK) {
						this.checkNodes[base + depth] = computed
						this.checkIndices[base + depth] = index
						depth++
						this.checkDepth = base + depth
						computed = dependency
						index = 0
						changed = true
						break
					}
					this._recompute(dependency)
				}
				if (dependency._version !== computed._depVersions[index]) {
					this._recompute(computed)
					index = computed._deps.length
					break
				}
			}
			if (changed) {
				continue
			}
			if (computed._state === CHECK) {
				computed._state = CLEAN
				computed._checkedEpoch = this.mutationEpoch
			}
			if (depth === 0) {
				this.checkDepth = base
				return
			}
			depth--
			this.checkDepth = base + depth
			const child = computed
			computed = this.checkNodes[base + depth]!
			index = this.checkIndices[base + depth]!
			if (child._version !== computed._depVersions[index]) {
				this._recompute(computed)
				index = computed._deps.length
			} else {
				index++
			}
		}
	}

	private _recompute<T>(computed: Computed<T>): void {
		computed._state = RUNNING
		const mutationEpoch = this.mutationEpoch
		if (computed._nextDeps !== undefined) {
			computed._nextDeps.length = 0
		}
		if (computed._nextVersions !== undefined) {
			computed._nextVersions.length = 0
		}
		computed._cursor = 0
		computed._dynamic = false
		const previousConsumer = this.activeConsumer
		this.activeConsumer = computed as Computed<unknown>
		const previousRuntime = evaluationRuntime
		evaluationRuntime = this
		const evaluationDepth = this.evaluationDepth++
		this.evaluationFrames[evaluationDepth] = undefined
		let value: T | undefined
		let error: unknown
		try {
			value = computed._fn(computed._context)
		} catch (caught) {
			if (isThenable(caught)) {
				this._useThenable(caught)
			} else {
				error = caught
			}
		} finally {
			evaluationRuntime = previousRuntime
			this.evaluationDepth--
			this.activeConsumer = previousConsumer
			if (computed._dynamic || computed._cursor !== computed._deps.length) {
				reconcileDependencies(computed as Computed<unknown>)
			}
		}

		if (
			this.evaluationFrames[evaluationDepth] === undefined &&
			error === undefined &&
			computed._error === undefined &&
			computed._pending === undefined
		) {
			const changed = !computed._hasValue || !computed.equals(computed._value as T, value as T)
			if (changed) {
				computed._value = value
				computed._hasValue = true
				computed._stableValue = value
				computed._hasStable = true
				computed._version++
			}
			computed._state = CLEAN
			if (mutationEpoch !== this.mutationEpoch) {
				for (let i = 0; i < computed._deps.length; i++) {
					if (computed._deps[i]._version !== computed._depVersions[i]) {
						computed._state = DIRTY
						break
					}
				}
			}
			if (computed._state === CLEAN) {
				computed._checkedEpoch = this.mutationEpoch
			}
			return
		}
		const result = (this.evaluationFrames[evaluationDepth] ??
			this.syncEvaluation) as AsyncEvaluation & { value?: T }
		this.evaluationFrames[evaluationDepth] = undefined
		result.value = value
		if (error !== undefined) {
			result.error = error
		} else if (result === this.syncEvaluation) {
			result.error = undefined
		}
		this._finishComputed(computed, result, mutationEpoch)
	}

	private _finishComputed<T>(
		computed: Computed<T>,
		result: AsyncEvaluation & { value?: T },
		mutationEpoch: number,
	): void {
		const previousError = computed._error
		const previousPending = computed._pending
		let pending: PromiseLike<unknown> | undefined
		if (result.pending.length !== 0 && result.error === undefined) {
			const pendingRecords = (computed._pendingRecords ??= [])
			pending =
				previousPending !== undefined && sameRecords(pendingRecords, result.pending)
					? previousPending
					: pendingThenable(result.pending)
			this._attachAsync(computed, result.pending)
			pendingRecords.length = 0
			for (let i = 0; i < result.pending.length; i++) {
				pendingRecords.push(result.pending[i])
			}
		} else {
			if (computed._asyncSubscriptions?.length !== 0) {
				this._detachAsync(computed)
			}
			if (computed._pendingRecords !== undefined) {
				computed._pendingRecords.length = 0
			}
		}
		let changed: boolean
		if (result.error !== undefined || previousError !== undefined) {
			changed = result.error !== previousError
		} else if (pending !== undefined || previousPending !== undefined) {
			changed = pending !== previousPending
		} else {
			changed = !computed._hasValue || !computed.equals(computed._value as T, result.value as T)
		}
		computed._error = result.error
		computed._pending = pending
		if (result.error === undefined && pending === undefined && changed) {
			computed._value = result.value
			computed._hasValue = true
			computed._stableValue = result.value
			computed._hasStable = true
		}
		computed._state = CLEAN
		for (let i = 0; i < computed._deps.length; i++) {
			if (computed._deps[i]._version !== computed._depVersions[i]) {
				computed._state = DIRTY
				break
			}
		}
		if (computed._state === CLEAN) {
			computed._checkedEpoch = this.mutationEpoch
		}
		if (changed) {
			computed._version++
		}
	}

	_enqueue(reaction: Reaction): void {
		if (reaction._queued || reaction._state === DISPOSED) {
			return
		}
		reaction._queued = true
		this.effectQueue.push(reaction)
	}

	_flush(): void {
		if (this.batchDepth !== 0 || this.flushing) {
			return
		}
		this.flushing = true
		try {
			while (this.queueIndex < this.effectQueue.length) {
				const reaction = this.effectQueue[this.queueIndex++]
				reaction._queued = false
				if (reaction._state !== DISPOSED) {
					this._runReaction(reaction)
				}
			}
		} finally {
			this.effectQueue.length = 0
			this.queueIndex = 0
			this.flushing = false
		}
	}

	private _runReaction(reaction: Reaction): void {
		if (reaction._state === CHECK) {
			const changed = this._consumerChanged(reaction)
			if ((reaction._state as number) === DISPOSED) {
				return
			}
			if (!changed) {
				reaction._state = CLEAN
				return
			}
		}
		reaction._disposeChildren()
		if (reaction._cleanup !== undefined) {
			const cleanup = reaction._cleanup
			reaction._cleanup = undefined
			const previousConsumer = this.activeConsumer
			this.activeConsumer = undefined
			try {
				cleanup()
			} catch (error) {
				this._report(error)
				reaction._state = DISPOSED
				detachConsumer(reaction)
				return
			} finally {
				this.activeConsumer = previousConsumer
			}
		}
		if (reaction._state === DISPOSED) {
			return
		}
		if (reaction._nextDeps !== undefined) {
			reaction._nextDeps.length = 0
		}
		if (reaction._nextVersions !== undefined) {
			reaction._nextVersions.length = 0
		}
		reaction._cursor = 0
		reaction._dynamic = false
		reaction._state = CLEAN
		this.emitTrace('effect-run', reaction._traceTarget, reaction._cause)
		const previousConsumer = this.activeConsumer
		const previousOwner = this.activeOwner
		this.activeConsumer = reaction
		this.activeOwner = reaction
		try {
			const cleanup = reaction._fn()
			if (typeof cleanup === 'function') {
				reaction._cleanup = cleanup
			}
		} catch (error) {
			this._report(error)
		} finally {
			this.activeConsumer = previousConsumer
			this.activeOwner = previousOwner
			if (reaction._dynamic || reaction._cursor !== reaction._deps.length) {
				reconcileDependencies(reaction)
			}
		}
	}

	private _scheduleLifecycle(atom: Atom<any>): void {
		if (atom._lifecycle === undefined || atom._lifecycleQueued) {
			return
		}
		atom._lifecycleQueued = true
		queueMicrotask(() => {
			atom._lifecycleQueued = false
			if (atom._observers !== 0 && atom._lifecycleCleanup === undefined) {
				try {
					const cleanup = this.untracked(() => atom._lifecycle!(atom._context!))
					atom._lifecycleCleanup = typeof cleanup === 'function' ? cleanup : undefined
				} catch (error) {
					this._report(error)
				}
			} else if (atom._observers === 0 && atom._lifecycleCleanup !== undefined) {
				const cleanup = atom._lifecycleCleanup
				atom._lifecycleCleanup = undefined
				try {
					cleanup()
				} catch (error) {
					this._report(error)
				}
			}
		})
	}

	private _report(error: unknown): void {
		this.errors.push(error)
		this.onError?.(error)
	}
}

export class Atom<T = unknown> {
	readonly runtime: Runtime
	readonly equals: Equality<T>
	readonly label?: string
	_version = 0
	_batchId = 0
	_batchVersion = 0
	_batchValue?: T
	_observers = 0
	_subscriber?: Consumer
	_subscribers?: Set<Consumer>
	_journalListeners?: Set<JournalListener>
	_ready: boolean
	_initializer?: () => T
	_value!: T
	_latest!: T
	_base!: T
	_tape?: Operation<T>[]
	_lifecycle?: (context: AtomContext<T>) => void | (() => void)
	_lifecycleCleanup?: () => void
	_lifecycleQueued = false
	readonly _context?: AtomContext<T>

	constructor(config: AtomConfig<T>, runtime?: Runtime)
	constructor(initial: T | (() => T), options?: AtomOptions<T>, runtime?: Runtime)
	constructor(
		initialOrConfig: T | (() => T) | AtomConfig<T>,
		optionsOrRuntime: AtomOptions<T> | Runtime = {},
		runtime = defaultRuntime,
	) {
		let initial: T | (() => T)
		let options: AtomOptions<T>
		if (
			typeof initialOrConfig === 'object' &&
			initialOrConfig !== null &&
			'state' in initialOrConfig
		) {
			initial = initialOrConfig.state
			options = initialOrConfig
			runtime = optionsOrRuntime instanceof Runtime ? optionsOrRuntime : runtime
		} else {
			initial = initialOrConfig
			options = optionsOrRuntime instanceof Runtime ? {} : optionsOrRuntime
			if (optionsOrRuntime instanceof Runtime) {
				runtime = optionsOrRuntime
			}
		}
		this.runtime = runtime
		this.equals = options.equals ?? options.isEqual ?? Object.is
		this.label = options.label
		this._lifecycle = options.effect ?? options.onObserved
		this._ready = typeof initial !== 'function'
		if (this._ready) {
			this._value = initial as T
			this._latest = this._value
			this._base = this._value
		} else {
			this._initializer = initial as () => T
		}
		if (this._lifecycle !== undefined) {
			this._context = {
				get: () => this.state,
				set: (value) => this.set(value),
				update: (fn) => this.update(fn),
			}
		}
	}

	get state(): T {
		return this.runtime._readAtom(this)
	}

	set(value: T): void {
		this.runtime._write(this, 0, value)
	}

	update(fn: (value: T) => T): void {
		this.runtime._write(this, 1, fn)
	}
}

export class ReducerAtom<S, A> extends Atom<S> {
	readonly reducer: (state: S, action: A) => S

	constructor(
		reducer: (state: S, action: A) => S,
		initial: S | (() => S),
		options?: AtomOptions<S>,
		runtime?: Runtime,
	) {
		super(initial, options, runtime)
		this.reducer = reducer
	}

	dispatch(action: A): void {
		this.update((state) => this.reducer(state, action))
	}
}

class Context<T> implements ComputedContext<T> {
	constructor(private readonly computed: Computed<T>) {}

	get previous(): T | undefined {
		return this.computed._hasStable ? this.computed._stableValue : undefined
	}

	get refreshEpoch(): number {
		return this.computed.runtime._refreshValue(this.computed)
	}

	use<U>(thenable: PromiseLike<U>): U {
		return evaluationRuntime!._useThenable(thenable)
	}
}

export class Computed<T = unknown> implements ConsumerState {
	readonly runtime: Runtime
	readonly equals: Equality<T>
	readonly label?: string
	readonly _fn: (context: ComputedContext<T>) => T
	readonly _context: ComputedContext<T>
	_version = 0
	_observers = 0
	_subscriber?: Consumer
	_subscribers?: Set<Consumer>
	_journalListeners?: Set<JournalListener>
	_deps: Source[] = []
	_depVersions: number[] = []
	_nextDeps?: Source[]
	_nextVersions?: number[]
	_cursor = 0
	_dynamic = false
	_state = DIRTY
	_observing = false
	_checkedEpoch = -1
	_value?: T
	_error?: unknown
	_pending?: PromiseLike<unknown>
	_pendingRecords?: ThenableRecord[]
	_asyncSubscriptions?: Array<{ record: ThenableRecord; listener: () => void }>
	_asyncGeneration = 0
	_cause = 0
	_refreshEpoch = 0
	_refreshBase = 0
	_controlTape?: ControlOperation[]
	_hasValue = false
	_stableValue?: T
	_hasStable = false

	constructor(config: ComputedConfig<T>, runtime?: Runtime)
	constructor(
		fn: (context: ComputedContext<T>) => T,
		options?: ComputedOptions<T>,
		runtime?: Runtime,
	)
	constructor(
		fnOrConfig: ((context: ComputedContext<T>) => T) | ComputedConfig<T>,
		optionsOrRuntime: ComputedOptions<T> | Runtime = {},
		runtime = defaultRuntime,
	) {
		let options: ComputedOptions<T>
		if (typeof fnOrConfig === 'function') {
			this._fn = fnOrConfig
			options = optionsOrRuntime instanceof Runtime ? {} : optionsOrRuntime
			if (optionsOrRuntime instanceof Runtime) {
				runtime = optionsOrRuntime
			}
		} else {
			this._fn = fnOrConfig.fn
			options = fnOrConfig
			runtime = optionsOrRuntime instanceof Runtime ? optionsOrRuntime : runtime
		}
		this.runtime = runtime
		this.equals = options.equals ?? options.isEqual ?? Object.is
		this.label = options.label
		this._context = new Context(this)
	}

	get state(): T {
		return this.runtime._readComputed(this)
	}

	dispose(): void {
		if (this._state === DISPOSED) {
			return
		}
		this._state = DISPOSED
		this.runtime._disposeComputed(this)
	}
}

class Scope {
	readonly _children: Owner[] = []
	private disposed = false

	constructor(readonly parent?: Owner) {}

	dispose(): void {
		if (this.disposed) {
			return
		}
		this.disposed = true
		for (let i = this._children.length - 1; i >= 0; i--) {
			this._children[i].dispose()
		}
		this._children.length = 0
	}
}

class Reaction implements ConsumerState {
	readonly _children: Owner[] = []
	_deps: Source[] = []
	_depVersions: number[] = []
	_nextDeps?: Source[]
	_nextVersions?: number[]
	_cursor = 0
	_dynamic = false
	_state = DIRTY
	_observing = true
	_queued = false
	_cleanup?: () => void
	_cause = 0
	_traceTarget!: () => void

	constructor(
		readonly runtime: Runtime,
		readonly _fn: () => void | (() => void),
		readonly parent?: Owner,
	) {
		if (parent !== undefined) {
			parent._children.push(this)
		}
	}

	_disposeChildren(): void {
		for (let i = this._children.length - 1; i >= 0; i--) {
			this._children[i].dispose()
		}
		this._children.length = 0
	}

	dispose(): void {
		if (this._state === DISPOSED) {
			return
		}
		this._state = DISPOSED
		this._disposeChildren()
		if (this._cleanup !== undefined) {
			const cleanup = this._cleanup
			this._cleanup = undefined
			const runtime = this.runtime
			try {
				runtime.untracked(cleanup)
			} catch (error) {
				runtime.errors.push(error)
			}
		}
		detachConsumer(this)
	}
}

export const defaultRuntime = new Runtime()

export function createRuntime(options?: RuntimeOptions): Runtime {
	return new Runtime(options)
}

export function atom<T>(initial: T | (() => T), options?: AtomOptions<T>): Atom<T> {
	return defaultRuntime.atom(initial, options)
}

export function reducerAtom<S, A>(
	reducer: (state: S, action: A) => S,
	initial: S | (() => S),
	options?: AtomOptions<S>,
): ReducerAtom<S, A> {
	return defaultRuntime.reducerAtom(reducer, initial, options)
}

export function computed<T>(
	fn: (context: ComputedContext<T>) => T,
	options?: ComputedOptions<T>,
): Computed<T> {
	return defaultRuntime.computed(fn, options)
}

export const effect = defaultRuntime.effect.bind(defaultRuntime)
export const effectScope = defaultRuntime.effectScope.bind(defaultRuntime)
export const batch = defaultRuntime.batch.bind(defaultRuntime)
export const startBatch = defaultRuntime.startBatch.bind(defaultRuntime)
export const endBatch = defaultRuntime.endBatch.bind(defaultRuntime)
export const untracked = defaultRuntime.untracked.bind(defaultRuntime)
export const latest = defaultRuntime.latest.bind(defaultRuntime)
export const committed = defaultRuntime.committed.bind(defaultRuntime)
export const isPending = defaultRuntime.isPending.bind(defaultRuntime)
export const refresh = defaultRuntime.refresh.bind(defaultRuntime)

export function serializeAtomState(
	atoms: Record<string, Atom<any>>,
	replacer?: (key: string, value: unknown) => unknown,
): string {
	return defaultRuntime.serialize(atoms, replacer)
}

export function initializeAtomState(
	json: string,
	atoms: Record<string, Atom<any>>,
	reviver?: (key: string, value: unknown) => unknown,
): void {
	defaultRuntime.initialize(json, atoms, reviver)
}

export function installState<T>(atom: Atom<T>, value: T): void {
	atom.runtime.installState(atom, value)
}
