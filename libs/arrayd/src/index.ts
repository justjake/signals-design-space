/**
 * @lab/arrayd — anod-lineage array core with alien-signals v3.2.1 semantics.
 *
 * No Link/edge objects. Every node stores its edges inline-first:
 *   deps side: `dep0` + `deps[]` spill, in exact read order (checkDirty
 *     verifies in recorded order — the rustc/try_mark_green discipline).
 *     Removal writes a hole (undefined); holes are skipped by traversals
 *     and squeezed out by the next re-run's reconciliation.
 *   subs side: `sub0` + `subs[]` spill, tombstoned removal (ORDER-
 *     PRESERVING — nested-effect ordering depends on subscriber order,
 *     see research/RESEARCH.md §7a) with a tombstone counter and
 *     threshold compaction.
 *
 * Dep re-tracking (anod's trick, ordered): cursor index + prefix compare
 * (deps[cursor] === dep → stamp + advance, zero alloc, no array writes);
 * appends past a fully-matched prefix extend in place. Only on real
 * divergence is the unconsumed old tail lazily swept with a version-1
 * classification mark (SEED += 2 per run gives each run a private stamp
 * pair) and the new sequence collected into a shared scratch stack, written
 * back at run end. Repeat reads dedup via the per-node stamp — no per-edge
 * versions anywhere. Stamps clobbered by nested runs are saved to VSTACK
 * and restored when the nested run finishes (anod's FENCE transaction
 * boundary). Stamp fields grow monotonically like alien's `cycle`; both
 * flip to double representation past 2^31 with identical semantics.
 *
 * The flags state machine, two-slot signal values, effect queue with
 * parent-chain outer-before-inner ordering, and purge-equivalent dep
 * trimming are copied from alien-signals v3.2.1 (upstream src/system.ts +
 * src/index.ts); propagate/checkDirty are the same algorithms made
 * iterative over (node, index) pairs on persistent scratch stacks with
 * base-pointer save/restore instead of allocated cons cells.
 *
 * One Node shape for all four kinds (kind bits in flags): propagate,
 * checkDirty, and tracking touch flags/dep0/deps/sub0/subs across mixed
 * kinds at single call sites — one hidden class keeps every one of those
 * ICs monomorphic (research/sources/js-data-layout.md; four shapes would
 * sit at V8's polymorphic limit). Cost: ~6 unused slots on signals (~48 B)
 * — less than one 80 B Link, but it is why signal creation/retained-memory
 * trails upstream; a two-shape split (signal vs consumer) is the candidate
 * fix if poly-2 ICs prove cheap enough.
 */

const enum F {
	None = 0,
	Mutable = 1,
	Watching = 2,
	RecursedCheck = 4,
	Recursed = 8,
	Dirty = 16,
	Pending = 32,
	HasChildEffect = 64,
	Signal = 128,
	Computed = 256,
	Effect = 512,
	Scope = 1024,
}

const KindMask = F.Signal | F.Computed | F.Effect | F.Scope

class Node {
	flags: number
	value: unknown = undefined // computed value / signal currentValue
	fn: unknown = undefined // computed getter / effect fn
	aux: unknown = undefined // signal pendingValue / effect cleanup (disjoint by kind)
	dep0: Node | undefined = undefined // inline first dep
	deps: (Node | undefined)[] | undefined = undefined // dep spill: logical i>=1 -> deps[i-1]
	depCount = 0 // logical dep slot count (may contain holes)
	sub0: Node | undefined = undefined // inline first sub
	subs: (Node | undefined)[] | undefined = undefined // sub spill (tombstoned)
	subCount = 0 // live subscriber count
	subTombs = 0 // tombstones in subs array
	stamp = 0 // run-stamp (dedup + reuse detection)
	rv = 0 // version of this node's own current/last run
	cursor = 0 // during a run: # of prefix-matched deps so far
	base = -1 // during a run: scratch base if diverged, else -1
	constructor(flags: number) {
		this.flags = flags
	}
}

// ---------------------------------------------------------------------------
// Globals: scheduler state + persistent scratch stacks.

let batchDepth = 0
let runDepth = 0
let notifyIndex = 0
let queuedLength = 0
let activeSub: Node | undefined

const queued: (Node | undefined)[] = []

// Stamp machinery (anod SEED += 2 scheme).
let SEED = 1
let FENCE = 0
let trackDepth = 0

// Scratch: diverged dep sequences. Each running node that diverges claims
// [node.base .. DCOUNT) and pops back to node.base when it finishes, so
// nested runs stack naturally without a global base pointer.
const DSTACK: (Node | undefined)[] = []
let DCOUNT = 0

// Scratch: [node, savedStamp] pairs to restore when a nested run finishes.
const VSTACK: (Node | number | undefined)[] = []
let VCOUNT = 0

// Scratch: checkDirty traversal (node + dep index), re-entrant via base ptr.
const CNODE: (Node | undefined)[] = []
const CIDX: number[] = []
let CTOP = 0

// Scratch: propagate traversal (node + sub index), re-entrant via base ptr.
const PNODE: (Node | undefined)[] = []
const PIDX: number[] = []
let PTOP = 0

// ---------------------------------------------------------------------------
// Public API

/** Callable signal handle: `s()` reads, `s(value)` writes. */
export interface SignalHandle<T> {
	(): T
	(value: T): void
}

export function signal<T>(): SignalHandle<T | undefined>
export function signal<T>(initialValue: T): SignalHandle<T>
export function signal(initialValue?: unknown): SignalHandle<unknown> {
	const s = new Node(F.Signal | F.Mutable)
	s.value = initialValue
	s.aux = initialValue
	return signalOper.bind(s)
}

export function computed<T>(getter: (previousValue?: T) => T): () => T {
	const c = new Node(F.Computed)
	c.fn = getter
	return computedOper.bind(c) as () => T
}

/** Returns a disposer. `fn` may return a cleanup function. */
export function effect(fn: () => void | (() => void)): () => void {
	const e = new Node(F.Effect | F.Watching | F.RecursedCheck)
	e.fn = fn
	const parent = activeSub
	if (parent !== undefined) {
		track(e, parent)
		parent.flags |= F.HasChildEffect
	}
	const prevSub = activeSub
	const vbase = VCOUNT
	const version = beginTracking(e)
	activeSub = e
	try {
		++runDepth
		e.aux = (e.fn as () => unknown)()
	} finally {
		--runDepth
		activeSub = prevSub
		e.flags &= ~F.RecursedCheck
		finishTracking(e, version, vbase)
	}
	return effectOper.bind(e)
}

/** Returns a disposer that disposes everything created inside `fn`. */
export function effectScope(fn: () => void): () => void {
	const e = new Node(F.Scope | F.Mutable)
	const parent = activeSub
	if (parent !== undefined) {
		track(e, parent)
		parent.flags |= F.HasChildEffect
	}
	const prevSub = activeSub
	const vbase = VCOUNT
	const version = beginTracking(e)
	activeSub = e
	try {
		fn()
	} finally {
		activeSub = prevSub
		finishTracking(e, version, vbase)
	}
	return effectScopeOper.bind(e)
}

export function startBatch(): void {
	++batchDepth
}

export function endBatch(): void {
	if (!--batchDepth) {
		flush()
	}
}

export function untracked<T>(fn: () => T): T {
	const prevSub = activeSub
	activeSub = undefined
	try {
		return fn()
	} finally {
		activeSub = prevSub
	}
}

// ---------------------------------------------------------------------------
// Operators (bound as public handles)

function signalOper(this: Node): unknown {
	if (arguments.length) {
		// eslint-disable-next-line prefer-rest-params
		const v = arguments[0] as unknown
		if (this.aux !== (this.aux = v)) {
			this.flags = F.Signal | F.Mutable | F.Dirty
			if (this.subCount > 0) {
				propagate(this, runDepth > 0)
				if (!batchDepth) {
					flush()
				}
			}
		}
	} else {
		if (this.flags & F.Dirty) {
			if (updateSignal(this)) {
				if (this.subCount > 0) {
					shallowPropagate(this)
				}
			}
		}
		if (activeSub !== undefined) {
			track(this, activeSub)
		}
		return this.value
	}
}

function computedOper(this: Node): unknown {
	const flags = this.flags
	if (
		flags & F.Dirty ||
		(flags & F.Pending && (checkDirty(this) || ((this.flags = flags & ~F.Pending), false)))
	) {
		if (updateComputed(this)) {
			if (this.subCount > 0) {
				shallowPropagate(this)
			}
		}
	} else if (!(flags & F.Mutable)) {
		// First-ever read: run the getter (no old deps, no old value).
		updateComputed(this)
	}
	if (activeSub !== undefined) {
		track(this, activeSub)
	}
	return this.value
}

function effectOper(this: Node): void {
	disposeReceiver(this)
}

function effectScopeOper(this: Node): void {
	disposeReceiver(this)
}

/** Dispose an effect or scope: children first (reverse), then own cleanup. */
function disposeReceiver(node: Node): void {
	node.flags &= KindMask
	disposeDeps(node)
	const parent = node.sub0
	if (parent !== undefined) {
		// Detach both sides; never fire unwatched on self (we ARE disposing).
		node.sub0 = undefined
		node.subCount = 0
		removeFromDeps(parent, node)
	}
	if (node.aux !== undefined && node.flags & F.Effect) {
		runCleanup(node)
	}
}

// ---------------------------------------------------------------------------
// Tracking: stamp dedup + cursor prefix reuse + scratch divergence

/**
 * Begin a tracked run of `sub`: allocate a stamp pair, publish the run
 * version on sub.rv (for track() and re-entrant write validity), reset the
 * per-node cursor/divergence state. Old deps are NOT pre-swept; the
 * version-1 classification marks are written lazily by sweepTail() only if
 * the run diverges from its old dep order.
 */
function beginTracking(sub: Node): number {
	if (trackDepth++ === 0) {
		FENCE = SEED
	}
	const version = (SEED += 2)
	sub.rv = version
	sub.cursor = 0
	sub.base = -1
	return version
}

/**
 * Record `dep` as a dependency of `sub` (=== activeSub; run state lives on
 * sub itself: rv/cursor/base). Happy paths: prefix position matches ->
 * stamp + advance cursor (zero alloc, zero array writes); appending past a
 * fully-matched prefix -> extend in place (like alien's immediate link(),
 * this keeps depCount live mid-run for runEffect's Watching restore).
 */
function track(dep: Node, sub: Node): void {
	const version = sub.rv
	const old = dep.stamp
	if (old === version) {
		return // already tracked this run
	}
	if (sub.base < 0) {
		const c = sub.cursor
		const dc = sub.depCount
		if (c < dc && (c === 0 ? sub.dep0 === dep : sub.deps![c - 1] === dep)) {
			if (old > FENCE) {
				// Stamp owned by a still-running outer computation.
				VSTACK[VCOUNT++] = dep
				VSTACK[VCOUNT++] = old
			}
			dep.stamp = version
			sub.cursor = c + 1
			return
		}
		if (c === dc) {
			// All old deps consumed, so dep is new: extend in place.
			if (old > FENCE) {
				VSTACK[VCOUNT++] = dep
				VSTACK[VCOUNT++] = old
			}
			dep.stamp = version
			subscribe(dep, sub)
			if (c === 0) {
				sub.dep0 = dep
			} else {
				let arr = sub.deps
				if (arr === undefined) {
					arr = sub.deps = []
				}
				arr[c - 1] = dep
			}
			sub.depCount = c + 1
			sub.cursor = c + 1
			return
		}
	}
	trackCold(dep, sub, version, old)
}

/** Divergence path of track(): classify via lazily swept version-1 marks. */
function trackCold(dep: Node, sub: Node, version: number, old: number): void {
	if (sub.base < 0) {
		// First divergence of this run: stamp the unconsumed old tail so
		// reused-vs-new classification works for the rest of the run.
		sweepTail(sub, sub.cursor, version - 1)
		sub.base = DCOUNT
		old = dep.stamp // may have just been re-stamped by the sweep
	}
	dep.stamp = version
	if (old !== version - 1) {
		// New dep (not in the old list): subscribe now.
		if (old > FENCE) {
			VSTACK[VCOUNT++] = dep
			VSTACK[VCOUNT++] = old
		}
		subscribe(dep, sub)
	}
	DSTACK[DCOUNT++] = dep
}

/** Stamp old dep slots [from..depCount) with `mark` for classification. */
function sweepTail(sub: Node, from: number, mark: number): void {
	const fence = FENCE
	const dc = sub.depCount
	for (let i = from; i < dc; i++) {
		const d = i === 0 ? sub.dep0 : sub.deps![i - 1]
		if (d !== undefined) {
			const s = d.stamp
			if (s > fence) {
				VSTACK[VCOUNT++] = d
				VSTACK[VCOUNT++] = s
			}
			d.stamp = mark
		}
	}
}

/**
 * End a tracked run: trim dropped deps (alien's purgeDeps), write back the
 * diverged sequence (array contents change only when set/order changed),
 * restore clobbered stamps.
 */
function finishTracking(sub: Node, version: number, vbase: number): void {
	if (sub.base >= 0) {
		finishDiverged(sub, version)
	} else if (sub.cursor < sub.depCount) {
		trimDeps(sub, sub.cursor)
	}
	if (VCOUNT > vbase) {
		restoreStamps(vbase)
	}
	--trackDepth
}

/** Restore stamps clobbered from still-active outer runs. */
function restoreStamps(vbase: number): void {
	do {
		const s = VSTACK[--VCOUNT] as number
		const n = VSTACK[--VCOUNT] as Node
		VSTACK[VCOUNT] = undefined
		VSTACK[VCOUNT + 1] = undefined
		n.stamp = s
	} while (VCOUNT > vbase)
}

/** Drop dep slots [newCount..depCount) — alien's purgeDeps. */
function trimDeps(sub: Node, newCount: number): void {
	for (let i = sub.depCount - 1; i >= newCount; i--) {
		const d = i === 0 ? sub.dep0 : sub.deps![i - 1]
		if (d !== undefined) {
			if (i === 0) {
				sub.dep0 = undefined
			} else {
				sub.deps![i - 1] = undefined
			}
			removeSub(d, sub)
		}
	}
	sub.depCount = newCount
}

/** Diverged-run epilogue: reconcile old tail against the scratch sequence. */
function finishDiverged(sub: Node, version: number): void {
	const oldCount = sub.depCount
	const cur = sub.cursor
	const dbase = sub.base
	const scratchLen = DCOUNT - dbase
	const newCount = cur + scratchLen
	// Drop old deps beyond the accepted prefix that were not re-read.
	for (let i = oldCount - 1; i >= cur; i--) {
		const d = i === 0 ? sub.dep0 : sub.deps![i - 1]
		if (d !== undefined && d.stamp !== version) {
			if (i === 0) {
				sub.dep0 = undefined
			} else {
				sub.deps![i - 1] = undefined
			}
			removeSub(d, sub)
		}
	}
	// Write the post-divergence sequence into logical slots [cur..).
	for (let k = 0; k < scratchLen; k++) {
		const d = DSTACK[dbase + k] as Node
		DSTACK[dbase + k] = undefined
		const i = cur + k
		if (i === 0) {
			sub.dep0 = d
		} else {
			let arr = sub.deps
			if (arr === undefined) {
				arr = sub.deps = []
			}
			arr[i - 1] = d
		}
	}
	DCOUNT = dbase
	// Clear stale slots beyond the new logical length.
	for (let i = newCount; i < oldCount; i++) {
		if (i === 0) {
			sub.dep0 = undefined
		} else {
			sub.deps![i - 1] = undefined
		}
	}
	sub.depCount = newCount
}

/**
 * Re-entrancy validity (alien's isValidLink): has `sub`'s current run
 * tracked `dep` so far? True if dep carries sub's run version, or that
 * version was saved to VSTACK when a nested run clobbered it.
 */
function isValid(dep: Node, sub: Node): boolean {
	const rv = sub.rv
	if (dep.stamp === rv) {
		return true
	}
	for (let i = 0; i < VCOUNT; i += 2) {
		if (VSTACK[i] === dep && VSTACK[i + 1] === rv) {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Subs side: inline sub0 + tombstoned array with threshold compaction

function subscribe(dep: Node, sub: Node): void {
	const arr = dep.subs
	if (dep.subCount === 0) {
		dep.sub0 = sub
		if (arr !== undefined && arr.length !== 0) {
			arr.length = 0
			dep.subTombs = 0
		}
	} else if (arr === undefined) {
		dep.subs = [sub]
	} else {
		arr.push(sub)
	}
	dep.subCount++
}

function removeSub(dep: Node, sub: Node): void {
	if (dep.sub0 === sub) {
		dep.sub0 = undefined
	} else {
		const arr = dep.subs
		if (arr !== undefined) {
			for (let i = 0; i < arr.length; i++) {
				if (arr[i] === sub) {
					arr[i] = undefined
					dep.subTombs++
					break
				}
			}
			if (dep.subTombs > 0 && dep.subTombs * 2 >= arr.length) {
				compactSubs(dep)
			}
		}
	}
	if (--dep.subCount === 0) {
		unwatchedNode(dep)
	}
}

/** Order-preserving compaction (never swap-remove). */
function compactSubs(dep: Node): void {
	const arr = dep.subs!
	const len = arr.length
	let w = 0
	let s0 = dep.sub0
	for (let r = 0; r < len; r++) {
		const v = arr[r]
		if (v !== undefined) {
			arr[r] = undefined
			if (s0 === undefined && w === 0) {
				// Promote the first live entry to sub0. Order-safe: w === 0
				// means no earlier array entry remains ahead of it.
				s0 = v
			} else {
				arr[w++] = v
			}
		}
	}
	dep.sub0 = s0
	dep.subTombs = 0
	let excess = len - w
	if (excess > 0) {
		if (excess < 20) {
			while (excess-- > 0) {
				arr.pop()
			}
		} else {
			arr.length = w
		}
	}
}

/** Remove `child` from parent's dep list, leaving a hole (index-stable). */
function removeFromDeps(parent: Node, child: Node): void {
	if (parent.dep0 === child) {
		parent.dep0 = undefined
		return
	}
	const arr = parent.deps
	if (arr !== undefined) {
		for (let i = 0; i < arr.length; i++) {
			if (arr[i] === child) {
				arr[i] = undefined
				return
			}
		}
	}
}

/** Reverse-order unlink of every dep (alien's disposeAllDepsInReverse). */
function disposeDeps(sub: Node): void {
	for (let i = sub.depCount - 1; i >= 0; i--) {
		const d = i === 0 ? sub.dep0 : sub.deps![i - 1]
		if (d !== undefined) {
			if (i === 0) {
				sub.dep0 = undefined
			} else {
				sub.deps![i - 1] = undefined
			}
			removeSub(d, sub)
		}
	}
	sub.depCount = 0
}

/**
 * Unlink child effects/scopes before re-running their parent (alien's
 * HasChildEffect pre-pass in run()/updateComputed()). Leaves holes.
 */
function purgeChildren(e: Node): void {
	for (let i = e.depCount - 1; i >= 0; i--) {
		const d = i === 0 ? e.dep0 : e.deps![i - 1]
		if (d !== undefined && d.flags & (F.Effect | F.Scope)) {
			if (i === 0) {
				e.dep0 = undefined
			} else {
				e.deps![i - 1] = undefined
			}
			removeSub(d, e)
		}
	}
}

function unwatchedNode(node: Node): void {
	const flags = node.flags
	if (flags & F.Computed) {
		if (node.depCount > 0) {
			node.flags = F.Computed | F.Mutable | F.Dirty
			disposeDeps(node)
		}
	} else if (flags & (F.Effect | F.Scope)) {
		disposeReceiver(node)
	}
	// Signals: nothing to do.
}

// ---------------------------------------------------------------------------
// Updates

function update(node: Node): boolean {
	const flags = node.flags
	if (flags & F.Computed) {
		return updateComputed(node)
	}
	if (flags & F.Signal) {
		return updateSignal(node)
	}
	node.flags = F.Scope | F.Mutable
	return true
}

function updateSignal(s: Node): boolean {
	s.flags = F.Signal | F.Mutable
	return s.value !== (s.value = s.aux)
}

function updateComputed(c: Node): boolean {
	if (c.flags & F.HasChildEffect) {
		purgeChildren(c)
	}
	const prevSub = activeSub
	const vbase = VCOUNT
	// beginTracking, inlined (hot):
	if (trackDepth++ === 0) {
		FENCE = SEED
	}
	const version = (SEED += 2)
	c.rv = version
	c.cursor = 0
	c.base = -1
	activeSub = c
	c.flags = F.Computed | F.Mutable | F.RecursedCheck
	try {
		const oldValue = c.value
		return oldValue !== (c.value = (c.fn as (p?: unknown) => unknown)(oldValue))
	} finally {
		activeSub = prevSub
		c.flags &= ~F.RecursedCheck
		// finishTracking, inlined (hot paths; cold work in callees):
		if (c.base >= 0) {
			finishDiverged(c, version)
		} else if (c.cursor < c.depCount) {
			trimDeps(c, c.cursor)
		}
		if (VCOUNT > vbase) {
			restoreStamps(vbase)
		}
		--trackDepth
	}
}

// ---------------------------------------------------------------------------
// Effect queue: parent-chain walk + segment reversal (outer before inner)

function notify(e: Node): void {
	let insertIndex = queuedLength
	let firstInsertedIndex = insertIndex
	do {
		queued[insertIndex++] = e
		e.flags &= ~F.Watching
		const p = e.sub0
		if (p === undefined || !(p.flags & F.Watching)) {
			break
		}
		e = p
	} while (true)
	queuedLength = insertIndex
	while (firstInsertedIndex < --insertIndex) {
		const left = queued[firstInsertedIndex]
		queued[firstInsertedIndex++] = queued[insertIndex]
		queued[insertIndex] = left
	}
}

function flush(): void {
	try {
		while (notifyIndex < queuedLength) {
			const e = queued[notifyIndex]!
			queued[notifyIndex++] = undefined
			runEffect(e)
		}
	} finally {
		while (notifyIndex < queuedLength) {
			const e = queued[notifyIndex]!
			queued[notifyIndex++] = undefined
			e.flags |= F.Watching | F.Recursed
		}
		notifyIndex = 0
		queuedLength = 0
	}
}

function runEffect(e: Node): void {
	const flags = e.flags
	if (flags & F.Dirty || (flags & F.Pending && checkDirty(e))) {
		if (flags & F.HasChildEffect) {
			purgeChildren(e)
		}
		if (e.aux !== undefined) {
			runCleanup(e)
			if (!(e.flags & ~KindMask)) {
				return // disposed during its own cleanup
			}
		}
		const prevSub = activeSub
		const vbase = VCOUNT
		const version = beginTracking(e)
		e.flags = F.Effect | F.Watching | F.RecursedCheck
		activeSub = e
		try {
			++runDepth
			e.aux = (e.fn as () => unknown)()
		} finally {
			--runDepth
			activeSub = prevSub
			e.flags &= ~F.RecursedCheck
			finishTracking(e, version, vbase)
		}
	} else if (e.depCount > 0) {
		e.flags = F.Effect | F.Watching | (flags & F.HasChildEffect)
	}
}

function runCleanup(e: Node): void {
	const cleanup = e.aux as () => void
	e.aux = undefined
	const prevSub = activeSub
	activeSub = undefined
	try {
		cleanup()
	} finally {
		activeSub = prevSub
	}
}

// ---------------------------------------------------------------------------
// Graph traversals (alien system.ts algorithms over array edges)

/** Next live logical sub index of `node` at or after `from` (0 = sub0). */
function nextLiveSub(node: Node, from: number): number {
	if (from === 0) {
		if (node.sub0 !== undefined) {
			return 0
		}
		from = 1
	}
	const arr = node.subs
	if (arr === undefined) {
		return -1
	}
	for (let i = from - 1; i < arr.length; i++) {
		if (arr[i] !== undefined) {
			return i + 1
		}
	}
	return -1
}

function propagate(d: Node, innerWrite: boolean): void {
	const base = PTOP
	let curNode = d
	let curIdx = nextLiveSub(d, 0)
	if (curIdx === -1) {
		return
	}
	let nxtNode = d
	let nxtIdx = nextLiveSub(d, curIdx + 1)
	top: do {
		const sub = curIdx === 0 ? curNode.sub0! : curNode.subs![curIdx - 1]!
		let flags = sub.flags

		if (!(flags & (F.RecursedCheck | F.Recursed | F.Dirty | F.Pending))) {
			sub.flags = flags | F.Pending
			if (innerWrite) {
				sub.flags |= F.Recursed
			}
		} else if (!(flags & (F.RecursedCheck | F.Recursed))) {
			flags = F.None
		} else if (!(flags & F.RecursedCheck)) {
			sub.flags = (flags & ~F.Recursed) | F.Pending
		} else if (!(flags & (F.Dirty | F.Pending)) && isValid(curNode, sub)) {
			sub.flags = flags | (F.Recursed | F.Pending)
			flags &= F.Mutable
		} else {
			flags = F.None
		}

		if (flags & F.Watching) {
			notify(sub)
		}

		if (flags & F.Mutable && sub.subCount > 0) {
			if (sub.subCount === 1 && sub.sub0 !== undefined) {
				// Degree-1 chain descent: no scans, no stack (the hot shape).
				curNode = sub
				curIdx = 0
				continue
			}
			const cf = nextLiveSub(sub, 0)
			if (cf !== -1) {
				const cs = nextLiveSub(sub, cf + 1)
				if (cs !== -1) {
					if (nxtIdx !== -1) {
						PNODE[PTOP] = nxtNode
						PIDX[PTOP] = nxtIdx
						PTOP++
					}
					nxtNode = sub
					nxtIdx = cs
				}
				curNode = sub
				curIdx = cf
				continue
			}
		}

		if (nxtIdx !== -1) {
			curNode = nxtNode
			curIdx = nxtIdx
			nxtIdx = nextLiveSub(nxtNode, nxtIdx + 1)
			continue
		}

		while (PTOP > base) {
			PTOP--
			const n = PNODE[PTOP]!
			PNODE[PTOP] = undefined
			const i = PIDX[PTOP]
			curNode = n
			curIdx = i
			nxtNode = n
			nxtIdx = nextLiveSub(n, i + 1)
			continue top
		}

		break
	} while (true)
}

function checkDirty(sub: Node): boolean {
	const base = CTOP
	let i = 0
	let dirty = false

	top: do {
		const dep = i === 0 ? sub.dep0 : sub.deps![i - 1]
		if (dep !== undefined) {
			const flags = dep.flags
			if (sub.flags & F.Dirty) {
				dirty = true
			} else if ((flags & (F.Mutable | F.Dirty)) === (F.Mutable | F.Dirty)) {
				// Capture before update(): the getter may unsubscribe the
				// other subs (e.g. dispose a sibling effect), but they were
				// marked Pending by propagate and still need the upgrade.
				const multi = dep.subCount > 1
				if (update(dep)) {
					if (multi) {
						shallowPropagate(dep)
					}
					dirty = true
				}
			} else if ((flags & (F.Mutable | F.Pending)) === (F.Mutable | F.Pending)) {
				CNODE[CTOP] = sub
				CIDX[CTOP] = i
				CTOP++
				sub = dep
				i = 0
				continue
			}
		}

		if (!dirty && i + 1 < sub.depCount) {
			i++
			continue
		}

		do {
			if (CTOP === base) {
				return dirty && (sub.flags & ~KindMask) !== 0
			}
			CTOP--
			const parent = CNODE[CTOP]!
			CNODE[CTOP] = undefined
			const pi = CIDX[CTOP]
			if (dirty) {
				const multi = sub.subCount > 1
				if (update(sub)) {
					if (multi) {
						shallowPropagate(sub)
					}
					sub = parent
					i = pi
					continue // parent is definitely dirty: update it next pop
				}
				dirty = false
			} else {
				sub.flags &= ~F.Pending
			}
			sub = parent
			i = pi
			if (i + 1 < sub.depCount) {
				i++
				continue top
			}
		} while (true)
	} while (true)
}

function shallowPropagate(dep: Node): void {
	const s0 = dep.sub0
	if (s0 !== undefined) {
		const flags = s0.flags
		if ((flags & (F.Pending | F.Dirty)) === F.Pending) {
			s0.flags = flags | F.Dirty
			if ((flags & (F.Watching | F.RecursedCheck)) === F.Watching) {
				notify(s0)
			}
		}
	}
	const arr = dep.subs
	if (arr !== undefined) {
		for (let i = 0; i < arr.length; i++) {
			const s = arr[i]
			if (s !== undefined) {
				const flags = s.flags
				if ((flags & (F.Pending | F.Dirty)) === F.Pending) {
					s.flags = flags | F.Dirty
					if ((flags & (F.Watching | F.RecursedCheck)) === F.Watching) {
						notify(s)
					}
				}
			}
		}
	}
}
