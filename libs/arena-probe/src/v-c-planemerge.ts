/**
 * VARIANT A+D+C — growth off + link split + PLANE MERGE.
 * Nodes and links interleaved in ONE Int32Array plane (single base register,
 * single bump pointer, two free lists). Measures multi-plane register/constant
 * pressure.
 */

// ---- record layout ---------------------------------------------------------
const FLAGS = 0
const DEPS = 1
const DEPS_TAIL = 2
const SUBS = 3
const SUBS_TAIL = 4
const GEN = 5

const VERSION = 0
const DEP = 1
const SUB = 2
const PREV_SUB = 3
const NEXT_SUB = 4
const PREV_DEP = 5
const NEXT_DEP = 6

const MUTABLE = 1
const WATCHING = 2
const RECURSED_CHECK = 4
const RECURSED = 8
const DIRTY = 16
const PENDING = 32
const HAS_CHILD_EFFECT = 64
const K_SIGNAL = 128
const K_COMPUTED = 256
const K_EFFECT = 512
const K_SCOPE = 1024
const KIND_MASK = K_SIGNAL | K_COMPUTED | K_EFFECT | K_SCOPE

// ---- state ------------------------------------------------------------------
let recNext = 8
let nodeFreeHead = 0
let linkFreeHead = 0

let cycle = 0
let runDepth = 0
let batchDepth = 0
let notifyIndex = 0
let queuedLength = 0
let activeSub = 0

const queued: number[] = []

const values: unknown[] = [undefined, undefined]
const fns: (Function | undefined)[] = [undefined]

let propStack = new Int32Array(4096)
let propSp = 0
let checkStack = new Int32Array(4096)
let checkSp = 0

const initialRecords = (() => {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
		?.env?.ARENA_PROBE_INITIAL_RECORDS
	const n = env !== undefined ? Number(env) : NaN
	return Number.isFinite(n) && n >= 2 ? Math.ceil(n) : 1 << 20
})()

const M = new Int32Array(initialRecords * 3 * 8)

// ---- allocation ----------------------------------------------------------

function allocNode(flags: number): number {
	let id: number
	if (nodeFreeHead !== 0) {
		id = nodeFreeHead
		nodeFreeHead = M[id + DEPS]
		M[id + DEPS] = 0
	} else {
		id = recNext
		if (id >= M.length) {
			throw new Error('@lab/arena-probe: node arena exhausted; raise ARENA_PROBE_INITIAL_RECORDS')
		}
		recNext = id + 8
	}
	M[id + FLAGS] = flags
	const v = id >> 2
	while (values.length <= v + 1) {
		values.push(undefined)
	}
	while (fns.length <= id >> 3) {
		fns.push(undefined)
	}
	return id
}

function allocLink(): number {
	let id: number
	if (linkFreeHead !== 0) {
		id = linkFreeHead
		linkFreeHead = M[id + NEXT_DEP]
	} else {
		id = recNext
		if (id >= M.length) {
			throw new Error('@lab/arena-probe: link arena exhausted; raise ARENA_PROBE_INITIAL_RECORDS')
		}
		recNext = id + 8
	}
	return id
}

function freeLink(id: number): void {
	M[id + NEXT_DEP] = linkFreeHead
	linkFreeHead = id
}

// ---- system.ts transliteration -------------------------------------------

function link(dep: number, sub: number, version: number): void {
	const prevDep = M[sub + DEPS_TAIL]
	if (prevDep !== 0 && M[prevDep + DEP] === dep) {
		return
	}
	const nextDep = prevDep !== 0 ? M[prevDep + NEXT_DEP] : M[sub + DEPS]
	if (nextDep !== 0 && M[nextDep + DEP] === dep) {
		M[nextDep + VERSION] = version
		M[sub + DEPS_TAIL] = nextDep
		return
	}
	linkInsert(dep, sub, version, prevDep, nextDep)
}

function linkInsert(
	dep: number,
	sub: number,
	version: number,
	prevDep: number,
	nextDep: number,
): void {
	const prevSub = M[dep + SUBS_TAIL]
	if (prevSub !== 0 && M[prevSub + VERSION] === version && M[prevSub + SUB] === sub) {
		return
	}
	const newLink = allocLink()
	M[sub + DEPS_TAIL] = newLink
	M[dep + SUBS_TAIL] = newLink
	M[newLink + VERSION] = version
	M[newLink + DEP] = dep
	M[newLink + SUB] = sub
	M[newLink + PREV_DEP] = prevDep
	M[newLink + NEXT_DEP] = nextDep
	M[newLink + PREV_SUB] = prevSub
	M[newLink + NEXT_SUB] = 0
	if (nextDep !== 0) {
		M[nextDep + PREV_DEP] = newLink
	}
	if (prevDep !== 0) {
		M[prevDep + NEXT_DEP] = newLink
	} else {
		M[sub + DEPS] = newLink
	}
	if (prevSub !== 0) {
		M[prevSub + NEXT_SUB] = newLink
	} else {
		M[dep + SUBS] = newLink
	}
}

function unlink(id: number, sub = M[id + SUB]): number {
	const dep = M[id + DEP]
	const prevDep = M[id + PREV_DEP]
	const nextDep = M[id + NEXT_DEP]
	const nextSub = M[id + NEXT_SUB]
	const prevSub = M[id + PREV_SUB]
	if (nextDep !== 0) {
		M[nextDep + PREV_DEP] = prevDep
	} else {
		M[sub + DEPS_TAIL] = prevDep
	}
	if (prevDep !== 0) {
		M[prevDep + NEXT_DEP] = nextDep
	} else {
		M[sub + DEPS] = nextDep
	}
	if (nextSub !== 0) {
		M[nextSub + PREV_SUB] = prevSub
	} else {
		M[dep + SUBS_TAIL] = prevSub
	}
	freeLink(id)
	if (prevSub !== 0) {
		M[prevSub + NEXT_SUB] = nextSub
	} else if ((M[dep + SUBS] = nextSub) === 0) {
		unwatched(dep)
	}
	return nextDep
}

function propagate(startLink: number, innerWrite: boolean): void {
	let cur = startLink
	let next = M[cur + NEXT_SUB]
	const stackBase = propSp

	top: do {
		const sub = M[cur + SUB]
		let flags = M[sub + FLAGS]

		if (!(flags & (RECURSED_CHECK | RECURSED | DIRTY | PENDING))) {
			M[sub + FLAGS] = flags | PENDING
			if (innerWrite) {
				M[sub + FLAGS] |= RECURSED
			}
		} else if (!(flags & (RECURSED_CHECK | RECURSED))) {
			flags = 0
		} else if (!(flags & RECURSED_CHECK)) {
			M[sub + FLAGS] = (flags & ~RECURSED) | PENDING
		} else if (!(flags & (DIRTY | PENDING)) && isValidLink(cur, sub)) {
			M[sub + FLAGS] = flags | (RECURSED | PENDING)
			flags &= MUTABLE
		} else {
			flags = 0
		}

		if (flags & WATCHING) {
			notify(sub)
		}

		if (flags & MUTABLE) {
			const subSubs = M[sub + SUBS]
			if (subSubs !== 0) {
				cur = subSubs
				const nextSub = M[cur + NEXT_SUB]
				if (nextSub !== 0) {
					if (propSp === propStack.length) {
						const bigger = new Int32Array(propStack.length * 2)
						bigger.set(propStack)
						propStack = bigger
					}
					propStack[propSp++] = next
					next = nextSub
				}
				continue
			}
		}

		if ((cur = next) !== 0) {
			next = M[cur + NEXT_SUB]
			continue
		}

		while (propSp > stackBase) {
			cur = propStack[--propSp]
			if (cur !== 0) {
				next = M[cur + NEXT_SUB]
				continue top
			}
		}

		break
	} while (true)
}

function checkDirty(startLink: number, startSub: number): boolean {
	let cur = startLink
	let sub = startSub
	const stackBase = checkSp
	let checkDepth = 0
	let dirty = false

	try {
		top: do {
			const dep = M[cur + DEP]
			const depFlags = M[dep + FLAGS]

			if (M[sub + FLAGS] & DIRTY) {
				dirty = true
			} else if ((depFlags & (MUTABLE | DIRTY)) === (MUTABLE | DIRTY)) {
				const depSubs = M[dep + SUBS]
				if (update(dep)) {
					if (M[depSubs + NEXT_SUB] !== 0) {
						shallowPropagate(depSubs)
					}
					dirty = true
				}
			} else if ((depFlags & (MUTABLE | PENDING)) === (MUTABLE | PENDING)) {
				if (checkSp === checkStack.length) {
					const bigger = new Int32Array(checkStack.length * 2)
					bigger.set(checkStack)
					checkStack = bigger
				}
				checkStack[checkSp++] = cur
				cur = M[dep + DEPS]
				sub = dep
				++checkDepth
				continue
			}

			if (!dirty) {
				const nextDep = M[cur + NEXT_DEP]
				if (nextDep !== 0) {
					cur = nextDep
					continue
				}
			}

			while (checkDepth--) {
				cur = checkStack[--checkSp]
				if (dirty) {
					const subSubs = M[sub + SUBS]
					if (update(sub)) {
						if (M[subSubs + NEXT_SUB] !== 0) {
							shallowPropagate(subSubs)
						}
						sub = M[cur + SUB]
						continue
					}
					dirty = false
				} else {
					M[sub + FLAGS] &= ~PENDING
				}
				sub = M[cur + SUB]
				const nextDep = M[cur + NEXT_DEP]
				if (nextDep !== 0) {
					cur = nextDep
					continue top
				}
			}

			return dirty && M[sub + FLAGS] !== 0
		} while (true)
	} finally {
		checkSp = stackBase
	}
}

function shallowPropagate(startLink: number): void {
	let cur = startLink
	do {
		const sub = M[cur + SUB]
		const flags = M[sub + FLAGS]
		if ((flags & (PENDING | DIRTY)) === PENDING) {
			M[sub + FLAGS] = flags | DIRTY
			if ((flags & (WATCHING | RECURSED_CHECK)) === WATCHING) {
				notify(sub)
			}
		}
	} while ((cur = M[cur + NEXT_SUB]) !== 0)
}

function isValidLink(checkLink: number, sub: number): boolean {
	let cur = M[sub + DEPS_TAIL]
	while (cur !== 0) {
		if (cur === checkLink) {
			return true
		}
		cur = M[cur + PREV_DEP]
	}
	return false
}

// ---- index.ts transliteration ---------------------------------------------

function update(node: number): boolean {
	const flags = M[node + FLAGS]
	if (flags & K_COMPUTED) {
		return updateComputed(node)
	}
	if (flags & K_SIGNAL) {
		return updateSignal(node)
	}
	M[node + FLAGS] = (flags & KIND_MASK) | MUTABLE
	return true
}

function notify(e: number): void {
	let insertIndex = queuedLength
	const firstInsertedIndex = insertIndex

	do {
		queued[insertIndex++] = e
		M[e + FLAGS] &= ~WATCHING
		const subs = M[e + SUBS]
		e = subs !== 0 ? M[subs + SUB] : 0
		if (e === 0 || !(M[e + FLAGS] & WATCHING)) {
			break
		}
	} while (true)

	queuedLength = insertIndex

	let left = firstInsertedIndex
	while (left < --insertIndex) {
		const tmp = queued[left]
		queued[left++] = queued[insertIndex]
		queued[insertIndex] = tmp
	}
}

function unwatched(node: number): void {
	const flags = M[node + FLAGS]
	if (flags & K_COMPUTED) {
		if (M[node + DEPS_TAIL] !== 0) {
			M[node + FLAGS] = K_COMPUTED | MUTABLE | DIRTY
			disposeAllDepsInReverse(node)
		}
	} else if (flags & K_SIGNAL) {
		// Nothing to do for signals.
	} else if (flags & (K_EFFECT | K_SCOPE)) {
		dispose(node)
	}
}

function unlinkChildEffects(sub: number): void {
	let cur = M[sub + DEPS_TAIL]
	while (cur !== 0) {
		const prev = M[cur + PREV_DEP]
		const dep = M[cur + DEP]
		if (!(M[dep + FLAGS] & (K_COMPUTED | K_SIGNAL))) {
			unlink(cur, sub)
		}
		cur = prev
	}
}

function updateComputed(c: number): boolean {
	if (M[c + FLAGS] & HAS_CHILD_EFFECT) {
		unlinkChildEffects(c)
	}
	M[c + DEPS_TAIL] = 0
	M[c + FLAGS] = K_COMPUTED | MUTABLE | RECURSED_CHECK
	const prevSub = activeSub
	activeSub = c
	try {
		++cycle
		const v = c >> 2
		const oldValue = values[v]
		return (
			oldValue !== (values[v] = (fns[c >> 3] as (previousValue?: unknown) => unknown)(oldValue))
		)
	} finally {
		activeSub = prevSub
		M[c + FLAGS] &= ~RECURSED_CHECK
		purgeDeps(c)
	}
}

function updateSignal(s: number): boolean {
	M[s + FLAGS] = K_SIGNAL | MUTABLE
	const v = s >> 2
	return values[v] !== (values[v] = values[v + 1])
}

function run(e: number): void {
	const flags = M[e + FLAGS]
	if (flags & DIRTY || (flags & PENDING && checkDirty(M[e + DEPS], e))) {
		if (flags & HAS_CHILD_EFFECT) {
			unlinkChildEffects(e)
		}
		const cv = (e >> 2) + 1
		if (values[cv]) {
			runCleanup(e)
			if (M[e + FLAGS] === 0) {
				return
			}
		}
		M[e + DEPS_TAIL] = 0
		M[e + FLAGS] = K_EFFECT | WATCHING | RECURSED_CHECK
		const prevSub = activeSub
		activeSub = e
		try {
			++cycle
			++runDepth
			values[cv] = (fns[e >> 3] as () => (() => void) | void)()
		} finally {
			--runDepth
			activeSub = prevSub
			M[e + FLAGS] &= ~RECURSED_CHECK
			purgeDeps(e)
		}
	} else if (M[e + DEPS] !== 0) {
		M[e + FLAGS] = K_EFFECT | WATCHING | (flags & HAS_CHILD_EFFECT)
	}
}

function requeueAbort(e: number): void {
	if (M[e + FLAGS] & KIND_MASK) {
		M[e + FLAGS] |= WATCHING | RECURSED
	}
}

function runCleanup(e: number): void {
	const cv = (e >> 2) + 1
	const cleanup = values[cv] as () => void
	values[cv] = undefined
	const prevSub = activeSub
	activeSub = 0
	try {
		cleanup()
	} finally {
		activeSub = prevSub
	}
}

function dispose(e: number): void {
	const flags = M[e + FLAGS]
	if (!(flags & KIND_MASK)) {
		return
	}
	M[e + FLAGS] = 0
	disposeAllDepsInReverse(e)
	const sub = M[e + SUBS]
	if (sub !== 0) {
		unlink(sub)
	}
	if (flags & K_EFFECT && values[(e >> 2) + 1]) {
		runCleanup(e)
	}
	// probe variant: records leak (no sweep) — growth support is off.
}

function disposeAllDepsInReverse(sub: number): void {
	let cur = M[sub + DEPS_TAIL]
	while (cur !== 0) {
		const prev = M[cur + PREV_DEP]
		unlink(cur, sub)
		cur = prev
	}
}

function purgeDeps(sub: number): void {
	const depsTail = M[sub + DEPS_TAIL]
	let dep = depsTail !== 0 ? M[depsTail + NEXT_DEP] : M[sub + DEPS]
	while (dep !== 0) {
		dep = unlink(dep, sub)
	}
}

// ---- read/write ops ---------------------------------------------------------

function read(s: number): unknown {
	if (M[s + FLAGS] & DIRTY) {
		if (updateSignal(s)) {
			const subs = M[s + SUBS]
			if (subs !== 0) {
				shallowPropagate(subs)
			}
		}
	}
	if (activeSub !== 0) {
		link(s, activeSub, cycle)
	}
	return values[s >> 2]
}

function write(s: number, value: unknown): boolean {
	const p = (s >> 2) + 1
	if (values[p] !== (values[p] = value)) {
		M[s + FLAGS] = K_SIGNAL | MUTABLE | DIRTY
		const subs = M[s + SUBS]
		if (subs !== 0) {
			propagate(subs, runDepth !== 0)
			return true
		}
	}
	return false
}

function computedRead(c: number): unknown {
	const flags = M[c + FLAGS]
	if (
		flags & DIRTY ||
		(flags & PENDING && (checkDirty(M[c + DEPS], c) || ((M[c + FLAGS] = flags & ~PENDING), false)))
	) {
		if (updateComputed(c)) {
			const subs = M[c + SUBS]
			if (subs !== 0) {
				shallowPropagate(subs)
			}
		}
	} else if (flags === K_COMPUTED) {
		M[c + FLAGS] = K_COMPUTED | MUTABLE | RECURSED_CHECK
		const prevSub = activeSub
		activeSub = c
		try {
			values[c >> 2] = (fns[c >> 3] as () => unknown)()
		} finally {
			activeSub = prevSub
			M[c + FLAGS] &= ~RECURSED_CHECK
		}
	}
	const sub = activeSub
	if (sub !== 0) {
		link(c, sub, cycle)
	}
	return values[c >> 2]
}

function flush(): void {
	try {
		while (notifyIndex < queuedLength) {
			const e = queued[notifyIndex]
			queued[notifyIndex++] = 0
			run(e)
		}
	} finally {
		while (notifyIndex < queuedLength) {
			const e = queued[notifyIndex]
			queued[notifyIndex++] = 0
			requeueAbort(e)
		}
		notifyIndex = 0
		queuedLength = 0
	}
}

// ---- public API ---------------------------------------------------------------

export interface SignalHandle<T> {
	(): T
	(value: T): void
}

export function signal<T>(): SignalHandle<T | undefined>
export function signal<T>(initialValue: T): SignalHandle<T>
export function signal<T>(initialValue?: T): SignalHandle<T | undefined> {
	const id = allocNode(K_SIGNAL | MUTABLE)
	const v = id >> 2
	values[v] = initialValue
	values[v + 1] = initialValue
	return function (...value: [T?]) {
		if (value.length) {
			if (write(id, value[0]) && !batchDepth) {
				flush()
			}
		} else {
			return read(id) as T | undefined
		}
	} as SignalHandle<T | undefined>
}

export function computed<T>(getter: (previousValue?: T) => T): () => T {
	const id = allocNode(K_COMPUTED)
	fns[id >> 3] = getter as (previousValue?: unknown) => unknown
	return () => computedRead(id) as T
}

export function effect(fn: () => void | (() => void)): () => void {
	const e = allocNode(K_EFFECT | WATCHING | RECURSED_CHECK)
	fns[e >> 3] = fn
	const prevSub = activeSub
	activeSub = e
	if (prevSub !== 0) {
		link(e, prevSub, 0)
		M[prevSub + FLAGS] |= HAS_CHILD_EFFECT
	}
	try {
		++runDepth
		values[(e >> 2) + 1] = fn()
	} finally {
		--runDepth
		activeSub = prevSub
		M[e + FLAGS] &= ~RECURSED_CHECK
	}
	const gen = M[e + GEN]
	return () => {
		if (M[e + GEN] !== gen) {
			return
		}
		dispose(e)
	}
}

export function effectScope(fn: () => void): () => void {
	const e = allocNode(K_SCOPE | MUTABLE)
	const prevSub = activeSub
	activeSub = e
	if (prevSub !== 0) {
		link(e, prevSub, 0)
		M[prevSub + FLAGS] |= HAS_CHILD_EFFECT
	}
	try {
		fn()
	} finally {
		activeSub = prevSub
	}
	const gen = M[e + GEN]
	return () => {
		if (M[e + GEN] !== gen) {
			return
		}
		dispose(e)
	}
}

export function startBatch(): void {
	++batchDepth
}

export function endBatch(): void {
	if (!--batchDepth && notifyIndex < queuedLength) {
		flush()
	}
}

export function untracked<T>(fn: () => T): T {
	const prevSub = activeSub
	activeSub = 0
	try {
		return fn()
	} finally {
		activeSub = prevSub
	}
}

export function getActiveSub(): number {
	return activeSub
}

export function setActiveSub(sub = 0): number {
	const prevSub = activeSub
	activeSub = sub
	return prevSub
}
