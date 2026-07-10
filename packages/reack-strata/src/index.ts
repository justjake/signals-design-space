/// <reference path="../types/react-strata.d.ts" />

import * as React from 'react'
import {
	Atom,
	Computed,
	defaultRuntime,
	ReducerAtom,
	type AtomConfig,
	type AtomOptions,
	type Branch,
	type ComputedContext,
	type ComputedOptions,
	type RenderWorld,
	type Runtime,
	type RuntimeHost,
	type Signal,
} from 'strata-signals'

const bridge = React.unstable_strata
if (bridge === undefined) {
	throw new Error('reack-strata requires the Strata React fork.')
}

interface RootState {
	readonly container: object
	readonly cutoffs: Map<Branch, number>
	readonly branches: Set<BranchMeta>
	readonly committed: Set<Candidate<any>>
	subscriptions: number
}

interface PassWorld {
	readonly world: RenderWorld
	readonly included: Branch[]
	readonly traceCause: number
}

interface Pass {
	readonly token: object
	readonly root: RootState
	readonly lanes: number
	readonly worlds: Map<Runtime, PassWorld>
	readonly records: Set<Candidate<any>>
	committed: boolean
}

interface BranchMeta {
	readonly runtime: Runtime
	readonly branch: Branch
	readonly roots: Set<RootState>
	hadRoot: boolean
	committed: boolean
	settleQueued: boolean
	readonly effects: Set<SignalEffectRecord>
}

interface SignalEffectRecord {
	runtime?: Runtime
	root?: RootState
	retainedRoot?: RootState
	fn?: () => void | (() => void)
	cleanup?: () => void
	readonly leaves: Atom<any>[]
	readonly unsubscribes: Array<() => void>
	readonly waiting: Map<Branch, number>
	pending: boolean
	disposed: boolean
	cause: number
}

interface HookOwner<T> {
	active?: Candidate<T>
	pending?: Candidate<T>
	value?: T
	hasValue: boolean
}

interface Candidate<T = unknown> {
	readonly owner: HookOwner<T>
	readonly pass: Pass
	readonly root: RootState
	readonly runtime: Runtime
	readonly source: Signal<any>
	readonly mode: 0 | 1 | 2 | 3
	readonly force: () => void
	readonly leaves: Atom<any>[]
	readonly missed: Branch[]
	readonly unsubscribes: Array<() => void>
	value?: T
	disposed: boolean
	active: boolean
}

let roots = new WeakMap<object, RootState>()
const liveRoots = new Set<RootState>()
const runtimes = new Map<Runtime, () => void>()
const branchMetas = new WeakMap<Branch, BranchMeta>()
const openPasses = new Set<Pass>()
const passes = new Map<object, Pass>()
let activePass: Pass | undefined
const settledBranches = new Set<Branch>()
const mutationListeners = new Set<(phase: 'start' | 'stop', container: Element) => void>()
export const errors: unknown[] = []

function rootFor(container: object): RootState {
	let root = roots.get(container)
	if (root !== undefined) {
		liveRoots.add(root)
		return root
	}
	root = {
		container,
		cutoffs: new Map(),
		branches: new Set(),
		committed: new Set(),
		subscriptions: 0,
	}
	for (const branch of settledBranches) root.cutoffs.set(branch, branch.lastSeq)
	roots.set(container, root)
	liveRoots.add(root)
	return root
}

function retainRoot(root: RootState): void {
	root.subscriptions++
	liveRoots.add(root)
}

function releaseRoot(root: RootState): void {
	root.subscriptions--
	if (root.subscriptions === 0 && root.branches.size === 0) liveRoots.delete(root)
}

function metaFor(runtime: Runtime, branch: Branch): BranchMeta {
	let meta = branchMetas.get(branch)
	if (meta !== undefined) return meta
	meta = {
		runtime,
		branch,
		roots: new Set(),
		hadRoot: false,
		committed: false,
		settleQueued: false,
		effects: new Set(),
	}
	branchMetas.set(branch, meta)
	return meta
}

function trackRoot(meta: BranchMeta, root: RootState): void {
	if (meta.roots.has(root)) return
	meta.roots.add(root)
	meta.hadRoot = true
	root.branches.add(meta)
}

function queueSettlement(meta: BranchMeta): void {
	if (meta.settleQueued || meta.branch.status !== 0) return
	meta.settleQueued = true
	const settle = () => {
		meta.settleQueued = false
		if (meta.branch.status !== 0 || meta.roots.size !== 0) return
		const committed = meta.committed || !meta.hadRoot
		meta.runtime.finishBranch(meta.branch, committed)
		if (committed) {
			for (const effect of meta.effects) {
				if (effect.root !== undefined) effect.root.cutoffs.set(meta.branch, meta.branch.lastSeq)
				effect.waiting.delete(meta.branch)
				scheduleSignalEffect(effect)
			}
		}
		meta.effects.clear()
		settledBranches.add(meta.branch)
		if (openPasses.size === 0) clearSettledBranches()
	}
	if (!meta.hadRoot && meta.effects.size !== 0) {
		setTimeout(settle, 0)
	} else {
		queueMicrotask(() => queueMicrotask(settle))
	}
}

function clearSettledBranches(): void {
	if (openPasses.size !== 0 || settledBranches.size === 0) return
	for (const branch of settledBranches) {
		const meta = branchMetas.get(branch)!
		let hasActiveBranch = false
		for (const active of meta.runtime.activeBranches()) {
			void active
			hasActiveBranch = true
			break
		}
		if (hasActiveBranch) continue
		for (const root of liveRoots) root.cutoffs.delete(branch)
		settledBranches.delete(branch)
	}
}

export function registerStrata(runtime: Runtime = defaultRuntime): () => void {
	const existing = runtimes.get(runtime)
	if (existing !== undefined) return () => {}
	const host: RuntimeHost = {
		write(fn) {
			return bridge.write((lane, deferred) => {
				const result = fn(lane, deferred)
				for (const branch of runtime.activeBranches()) {
					queueSettlement(metaFor(runtime, branch))
				}
				return result
			})
		},
		run(lane, fn) {
			return bridge.run(lane, fn)
		},
	}
	const detach = runtime.attachHost(host)
	runtimes.set(runtime, detach)
	return () => {
		if (runtimes.get(runtime) !== detach) return
		runtimes.delete(runtime)
		detach()
	}
}

function beginPass(token: object, container: object, lanes: number, remainingLanes: number): void {
	const previous = passes.get(token)
	if (previous !== undefined) finishPass(previous, false, 0, remainingLanes)
	const root = rootFor(container)
	const pass: Pass = {
		token,
		root,
		lanes,
		worlds: new Map(),
		records: new Set(),
		committed: false,
	}
	for (const runtime of runtimes.keys()) {
		const included: Branch[] = []
		for (const branch of runtime.activeBranches()) {
			if ((branch.lane & lanes) === 0) continue
			included.push(branch)
			trackRoot(metaFor(runtime, branch), root)
		}
		let deferred = false
		for (let i = 0; i < included.length; i++) {
			if (included[i]!.deferred) {
				deferred = true
				break
			}
		}
		pass.worlds.set(runtime, {
			world: runtime.createWorld(
				container,
				lanes,
				root.cutoffs,
				deferred,
				included.length !== 0,
				included[0]?.lane ?? 0,
			),
			included,
			traceCause: runtime.emitTrace(
				'render-pass-start',
				container,
				included[included.length - 1]?.lastCause ?? 0,
				{ lanes },
			),
		})
	}
	openPasses.add(pass)
	passes.set(token, pass)
	activePass = pass
}

function disposeCandidate(candidate: Candidate<any>): void {
	if (candidate.disposed) return
	candidate.disposed = true
	for (let i = 0; i < candidate.unsubscribes.length; i++) candidate.unsubscribes[i]!()
	candidate.unsubscribes.length = 0
	candidate.pass.records.delete(candidate)
	if (candidate.owner.pending === candidate) candidate.owner.pending = undefined
	if (candidate.active) {
		candidate.active = false
		if (candidate.owner.active === candidate) candidate.owner.active = undefined
		if (candidate.mode === 2) candidate.root.committed.delete(candidate)
		for (let i = 0; i < candidate.leaves.length; i++) {
			candidate.runtime._release(candidate.leaves[i]!)
		}
		releaseRoot(candidate.root)
	}
}

function finishPass(pass: Pass, committed: boolean, lanes: number, remainingLanes: number): void {
	if (!openPasses.delete(pass)) return
	passes.delete(pass.token)
	if (activePass === pass) activePass = undefined
	pass.committed = committed
	if (committed) {
		const moved: Branch[] = []
		for (const [runtime, passWorld] of pass.worlds) {
			runtime.commitWorld(passWorld.world)
			const endCause = runtime.emitTrace(
				'render-pass-end',
				pass.root.container,
				passWorld.traceCause,
				{ committed: true, lanes },
			)
			runtime.emitTrace('root-commit', pass.root.container, endCause, {
				lanes,
				remainingLanes,
			})
			for (let i = 0; i < passWorld.included.length; i++) {
				const branch = passWorld.included[i]!
				const cutoff = Math.min(branch.lastSeq, passWorld.world.pin)
				if (cutoff !== 0) {
					const previous = pass.root.cutoffs.get(branch) ?? 0
					if (cutoff > previous) {
						pass.root.cutoffs.set(branch, cutoff)
						moved.push(branch)
					}
					metaFor(runtime, branch).committed = true
					const meta = metaFor(runtime, branch)
					for (const effect of meta.effects) {
						if (effect.root !== pass.root) continue
						const waiting = effect.waiting.get(branch) ?? 0
						if (waiting <= cutoff) {
							effect.waiting.delete(branch)
							meta.effects.delete(effect)
							scheduleSignalEffect(effect)
						}
					}
				}
			}
			runtime.releaseWorld(passWorld.world)
		}
		if (moved.length !== 0) {
			queueMicrotask(() => {
				for (const candidate of pass.root.committed) {
					if (candidate.disposed || !candidate.active) continue
					let relevant: Branch | undefined
					for (let i = 0; i < moved.length && relevant === undefined; i++) {
						const branch = moved[i]!
						if (candidate.source instanceof Computed && branch.signals.has(candidate.source)) {
							relevant = branch
							break
						}
						for (let j = 0; j < candidate.leaves.length; j++) {
							if (branch.atoms.has(candidate.leaves[j]!)) {
								relevant = branch
								break
							}
						}
					}
					if (relevant !== undefined) {
						candidate.runtime.emitTrace(
							'component-delivery',
							candidate.source,
							relevant.lastCause,
							{ branch: relevant.id, committed: true },
						)
						bridge.run(relevant.lane, candidate.force)
					}
				}
			})
		}
		queueMicrotask(() => {
			for (const candidate of pass.records) disposeCandidate(candidate)
		})
	} else {
		for (const [runtime, passWorld] of pass.worlds) {
			runtime.emitTrace('render-pass-end', pass.root.container, passWorld.traceCause, {
				committed: false,
				lanes,
			})
			runtime.releaseWorld(passWorld.world)
		}
		for (const candidate of pass.records) disposeCandidate(candidate)
	}
	for (const meta of pass.root.branches) {
		if ((meta.branch.lane & remainingLanes) !== 0) continue
		meta.roots.delete(pass.root)
		pass.root.branches.delete(meta)
		queueSettlement(meta)
	}
	if (pass.root.subscriptions === 0 && pass.root.branches.size === 0) {
		liveRoots.delete(pass.root)
	}
	clearSettledBranches()
	void lanes
}

function abortPass(token: object, remainingLanes: number): void {
	const pass = passes.get(token)
	if (pass !== undefined) finishPass(pass, false, 0, remainingLanes)
}

function pausePass(token: object): void {
	if (activePass?.token === token) activePass = undefined
}

function endPass(token: object, committed: boolean, lanes: number, remainingLanes: number): void {
	const pass = passes.get(token)
	if (pass !== undefined) finishPass(pass, committed, lanes, remainingLanes)
}

function resetPasses(): void {
	for (const pass of openPasses) finishPass(pass, false, 0, 0)
}

function mutation(active: boolean, container: Element): void {
	const phase = active ? 'start' : 'stop'
	for (const runtime of runtimes.keys()) {
		runtime.emitTrace(active ? 'dom-mutation-start' : 'dom-mutation-stop', container)
	}
	for (const listener of mutationListeners) {
		try {
			listener(phase, container)
		} catch (error) {
			errors.push(error)
		}
	}
}

const unregisterBridge = bridge.register({
	begin: beginPass,
	abort: abortPass,
	pause: pausePass,
	end: endPass,
	current: () => activePass,
	reset: resetPasses,
	mutation,
})

function worldFor(pass: Pass, runtime: Runtime): PassWorld {
	let passWorld = pass.worlds.get(runtime)
	if (passWorld !== undefined) return passWorld
	registerStrata(runtime)
	const included: Branch[] = []
	for (const branch of runtime.activeBranches()) {
		if ((branch.lane & pass.lanes) === 0) continue
		included.push(branch)
		trackRoot(metaFor(runtime, branch), pass.root)
	}
	let deferred = false
	for (let i = 0; i < included.length; i++) {
		if (included[i]!.deferred) deferred = true
	}
	passWorld = {
		world: runtime.createWorld(
			pass.root.container,
			pass.lanes,
			pass.root.cutoffs,
			deferred,
			included.length !== 0,
			included[0]?.lane ?? 0,
		),
		included,
		traceCause: runtime.emitTrace(
			'render-pass-start',
			pass.root.container,
			included[included.length - 1]?.lastCause ?? 0,
			{ lanes: pass.lanes },
		),
	}
	pass.worlds.set(runtime, passWorld)
	return passWorld
}

function represented(world: RenderWorld, branch: Branch, sequence: number): boolean {
	return (
		sequence <= (world.cutoffs.get(branch) ?? 0) ||
		(sequence <= world.pin && (branch.lane & world.lanes) !== 0)
	)
}

function listenCandidate(candidate: Candidate<any>): void {
	const notify = (branch: Branch, sequence: number, cause: number) => {
		if (candidate.disposed) return
		if (candidate.mode === 3) {
			candidate.runtime.emitTrace('component-delivery', candidate.source, cause, {
				branch: branch.id,
				sequence,
				pending: branch.status === 0,
			})
			bridge.urgent(candidate.force)
			return
		}
		if (branch.status !== 0) {
			const passWorld = candidate.pass.worlds.get(candidate.runtime)
			if (
				branch.status === 2 &&
				passWorld !== undefined &&
				represented(passWorld.world, branch, sequence)
			)
				bridge.urgent(candidate.force)
			return
		}
		trackRoot(metaFor(candidate.runtime, branch), candidate.root)
		candidate.runtime.emitTrace('component-delivery', candidate.source, cause, {
			branch: branch.id,
			sequence,
		})
		candidate.force()
	}
	const scan = (branch: Branch, sequence: number) => {
		if (
			branch.status === 0 &&
			!represented(worldFor(candidate.pass, candidate.runtime).world, branch, sequence)
		) {
			let found = false
			for (let j = 0; j < candidate.missed.length; j++) {
				if (candidate.missed[j] === branch) {
					found = true
					break
				}
			}
			if (!found) candidate.missed.push(branch)
		}
	}
	if (candidate.source instanceof Computed) {
		candidate.unsubscribes.push(candidate.runtime.subscribeJournal(candidate.source, notify))
		candidate.runtime.scanJournal(candidate.source, scan)
	}
	for (let i = 0; i < candidate.leaves.length; i++) {
		const atom = candidate.leaves[i]!
		candidate.unsubscribes.push(candidate.runtime.subscribeJournal(atom, notify))
		candidate.runtime.scanJournal(atom, scan)
	}
}

function activateCandidate<T>(candidate: Candidate<T>): () => void {
	if (candidate.disposed) {
		candidate.disposed = false
		listenCandidate(candidate)
	}
	const previous = candidate.owner.active
	if (previous !== undefined && previous !== candidate) disposeCandidate(previous)
	candidate.pass.records.delete(candidate)
	candidate.owner.pending = undefined
	candidate.owner.active = candidate
	candidate.owner.value = candidate.value
	candidate.owner.hasValue = true
	if (!candidate.active) {
		candidate.active = true
		if (candidate.mode === 2) candidate.root.committed.add(candidate)
		retainRoot(candidate.root)
		for (let i = 0; i < candidate.leaves.length; i++) {
			candidate.runtime._retain(candidate.leaves[i]!)
		}
	}
	for (let i = 0; i < candidate.missed.length; i++) {
		const branch = candidate.missed[i]!
		if (branch.status !== 0) continue
		trackRoot(metaFor(candidate.runtime, branch), candidate.root)
		bridge.run(branch.lane, candidate.force)
	}
	return () => disposeCandidate(candidate)
}

function increment(value: number): number {
	return value + 1
}

function useSignalValue<T>(source: Signal<T>, mode: 0 | 1 | 2 | 3): T | boolean | undefined {
	const pass = bridge.current() as Pass | null
	const [, force] = React.useReducer(increment, 0)
	const owner = React.useRef<HookOwner<any>>(undefined)
	if (owner.current === undefined) owner.current = { hasValue: false }
	if (pass === null) {
		if (mode === 0) return source.state
		if (mode === 3) return source.runtime.isPending(source)
		return mode === 1 ? source.runtime.latest(source) : source.runtime.committed(source)
	}

	const passWorld = worldFor(pass, source.runtime)
	const candidate: Candidate<any> = {
		owner: owner.current,
		pass,
		root: pass.root,
		runtime: source.runtime,
		source,
		mode,
		force,
		leaves: [],
		missed: [],
		unsubscribes: [],
		disposed: false,
		active: false,
	}
	owner.current.pending = candidate
	pass.records.add(candidate)
	React.useLayoutEffect(() => activateCandidate(candidate), [candidate])

	let value: T | boolean | undefined
	let error: unknown
	const readWorld =
		mode === 2
			? source.runtime.createWorld(pass.root.container, 0, pass.root.cutoffs)
			: passWorld.world
	try {
		value = source.runtime.withWorld(readWorld, candidate.leaves, () => {
			if (mode === 0) return source.state
			const latestValue = source.runtime.latest(source)
			return mode === 3 ? source.runtime.pendingInWorld(source, readWorld) : latestValue
		})
		const equal =
			mode === 3
				? Object.is(owner.current.value, value)
				: source.equals(owner.current.value as T, value as T)
		if (owner.current.hasValue && equal) {
			value = owner.current.value
		}
		candidate.value = value
	} catch (caught) {
		error = caught
	} finally {
		if (mode === 2) source.runtime.releaseWorld(readWorld)
		listenCandidate(candidate)
	}
	if (error !== undefined) throw error
	let renderCause = 0
	let renderSequence = 0
	for (let i = 0; i < passWorld.included.length; i++) {
		const branch = passWorld.included[i]!
		if (branch.lastSeq <= renderSequence) continue
		if (source instanceof Computed && branch.signals.has(source)) {
			renderSequence = branch.lastSeq
			renderCause = branch.lastCause
			continue
		}
		for (let j = 0; j < candidate.leaves.length; j++) {
			if (branch.atoms.has(candidate.leaves[j]!)) {
				renderSequence = branch.lastSeq
				renderCause = branch.lastCause
				break
			}
		}
	}
	source.runtime.emitTrace('component-render', source, renderCause)
	return candidate.value
}

export function useSignal<T>(source: Signal<T>): T {
	return useSignalValue(source, 0) as T
}

export function useLatest<T>(source: Signal<T>): T | undefined {
	return useSignalValue(source, 1) as T | undefined
}

export function useComputed<T>(
	fn: (context: ComputedContext<T>) => T,
	deps: readonly unknown[],
	options?: ComputedOptions<T>,
): T {
	const value = React.useMemo(() => new Computed(fn, options), deps)
	React.useEffect(() => () => value.dispose(), [value])
	return useSignal(value)
}

function clearSignalEffectSubscriptions(record: SignalEffectRecord): void {
	for (let i = 0; i < record.unsubscribes.length; i++) record.unsubscribes[i]!()
	record.unsubscribes.length = 0
	if (record.runtime !== undefined) {
		for (let i = 0; i < record.leaves.length; i++) record.runtime._release(record.leaves[i]!)
	}
	record.leaves.length = 0
}

function runSignalEffect(record: SignalEffectRecord): void {
	record.pending = false
	if (
		record.disposed ||
		record.fn === undefined ||
		record.runtime === undefined ||
		record.root === undefined
	) {
		return
	}
	for (const [branch] of record.waiting) {
		if (branch.status === 0) return
	}
	if (record.cleanup !== undefined) {
		const cleanup = record.cleanup
		record.cleanup = undefined
		try {
			cleanup()
		} catch (error) {
			errors.push(error)
		}
	}
	clearSignalEffectSubscriptions(record)
	const world = record.runtime.createWorld(record.root.container, 0, record.root.cutoffs)
	try {
		record.runtime.emitTrace('effect-run', record, record.cause)
		const cleanup = record.runtime.withWorld(world, record.leaves, record.fn)
		if (typeof cleanup === 'function') record.cleanup = cleanup
	} catch (error) {
		errors.push(error)
	} finally {
		record.runtime.releaseWorld(world)
	}
	for (let i = 0; i < record.leaves.length; i++) {
		const atom = record.leaves[i]!
		record.runtime._retain(atom)
		record.unsubscribes.push(
			record.runtime.subscribeJournal(atom, (branch, sequence, cause) => {
				if (record.disposed || branch.status !== 0) return
				record.cause = cause
				const previous = record.waiting.get(branch) ?? 0
				if (sequence > previous) record.waiting.set(branch, sequence)
				metaFor(record.runtime!, branch).effects.add(record)
			}),
		)
	}
}

function scheduleSignalEffect(record: SignalEffectRecord): void {
	if (record.pending || record.disposed) return
	record.pending = true
	queueMicrotask(() => runSignalEffect(record))
}

function disposeSignalEffect(record: SignalEffectRecord): void {
	if (record.disposed) return
	record.disposed = true
	for (const [branch] of record.waiting) branchMetas.get(branch)?.effects.delete(record)
	record.waiting.clear()
	clearSignalEffectSubscriptions(record)
	if (record.retainedRoot !== undefined) {
		releaseRoot(record.retainedRoot)
		record.retainedRoot = undefined
	}
	if (record.cleanup !== undefined) {
		const cleanup = record.cleanup
		record.cleanup = undefined
		try {
			cleanup()
		} catch (error) {
			errors.push(error)
		}
	}
}

export function useSignalEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void {
	const pass = bridge.current() as Pass | null
	if (pass !== null) registerStrata(defaultRuntime)
	const ref = React.useRef<SignalEffectRecord>(undefined)
	if (ref.current === undefined) {
		ref.current = {
			leaves: [],
			unsubscribes: [],
			waiting: new Map(),
			pending: false,
			disposed: false,
			cause: 0,
		}
	}
	const record = ref.current
	React.useLayoutEffect(() => {
		record.disposed = false
		return () => disposeSignalEffect(record)
	}, [record])
	React.useLayoutEffect(() => {
		record.fn = fn
		if (pass !== null && record.retainedRoot !== pass.root) {
			if (record.retainedRoot !== undefined) releaseRoot(record.retainedRoot)
			record.root = pass.root
			record.retainedRoot = pass.root
			retainRoot(pass.root)
		}
		record.runtime ??= defaultRuntime
	})
	React.useLayoutEffect(() => scheduleSignalEffect(record), deps)
}

export function useAtom<T>(config: AtomConfig<T>): Atom<T>
export function useAtom<T>(initial: T | (() => T), options?: AtomOptions<T>): Atom<T>
export function useAtom<T>(
	initial: T | (() => T) | AtomConfig<T>,
	options?: AtomOptions<T>,
): Atom<T> {
	return React.useMemo(() => new Atom(initial as T | (() => T), options), [])
}

export function useReducerAtom<S, A>(
	reducer: (state: S, action: A) => S,
	initial: S | (() => S),
	options?: AtomOptions<S>,
): [S, (action: A) => void] {
	const value = React.useMemo(() => new ReducerAtom(reducer, initial, options), [])
	const state = useSignal(value)
	const dispatch = React.useCallback((action: A) => value.dispatch(action), [value])
	return [state, dispatch]
}

export function startSignalTransition(scope: () => void): void {
	React.startTransition(scope)
}

export function useSignalTransition(): [boolean, (scope: () => void) => void] {
	return React.useTransition()
}

export function useCommitted<T>(source: Signal<T>): T | undefined {
	return useSignalValue(source, 2) as T | undefined
}

export function committed<T>(source: Signal<T>, container?: object): T | undefined {
	if (container === undefined) return source.runtime.committed(source)
	const root = roots.get(container)
	if (root === undefined) return source.runtime.committed(source)
	const world = source.runtime.createWorld(container, 0, root.cutoffs)
	const leaves: Atom<any>[] = []
	try {
		return source.runtime.withWorld(world, leaves, () => source.runtime.latest(source))
	} finally {
		source.runtime.releaseWorld(world)
	}
}

export function useIsPending(source: Signal<any>): boolean {
	return useSignalValue(source, 3) as boolean
}

export function onDomMutation(
	listener: (phase: 'start' | 'stop', container: Element) => void,
): () => void {
	mutationListeners.add(listener)
	return () => mutationListeners.delete(listener)
}

export function resetForTest(): void {
	resetPasses()
	for (const root of liveRoots) {
		root.cutoffs.clear()
		root.branches.clear()
	}
	liveRoots.clear()
	roots = new WeakMap()
	settledBranches.clear()
	errors.length = 0
}

export function disposeReackStrata(): void {
	unregisterBridge()
	for (const detach of runtimes.values()) detach()
	runtimes.clear()
}

export { Atom, Computed, defaultRuntime } from 'strata-signals'
