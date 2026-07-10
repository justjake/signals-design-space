/**
 * @lab/arena-host-fused — SP1b spike: @lab/arena-host with the host-callback
 * boundary FUSED away, storage untouched.
 *
 * PURPOSE (research/experiments/sp1-host-callback-tax.md follow-up; NOTES row
 * SP1b): SP1's measured tax (deep 1.06x, broad 1.06–1.09x, diamond 1.02x,
 * reads 1.09x vs the donor) bundles two effects:
 *   (a) the call-boundary cost of host upcalls out of the kernel plus
 *       kernel-accessor calls from policy code, and
 *   (b) the storage change from the donor's packed side columns
 *       (`vals[id >> 2]`, kind bits in the flags word) to a handle-indexed
 *       entity-object table (`ents[M[id + HANDLE]]`, kind in the entity).
 * This variant isolates them: it keeps arena-host's STORAGE and SEMANTICS
 * exactly — the C.HANDLE field in every node record, the dense entity table
 * with the single hidden class {kind, value, pending, fn, cleanup}, kind
 * dispatch via `ent.kind` (no kind bits in the kernel flags word), the
 * handle load `M[id + C.HANDLE]` on every dispatch — but eliminates the call
 * boundary: kernel and policy are ONE closure (the donor's shape), so the
 * refresh/notify/unwatched dispatch is a direct same-closure call from
 * checkDirty/propagate/unlink, and policy code touches M directly instead of
 * going through kernel accessor functions. This models what a codegen fusion
 * build step would emit for a two-kernel design.
 *
 * Decision rule (pre-registered): fused ~= donor => the tax is the call
 * boundary and fusion recovers it; fused ~= host => the tax is the storage
 * change and fusion won't save it.
 *
 * PRESERVED VERBATIM from the donor/arena-host (do not "improve"): flag
 * ladder and walk structure of propagate/checkDirty/shallowPropagate, the
 * link/linkInsert fast/slow split, closure-const buffer binding,
 * premultiplied ids (id = record * 8), persistent scratch stacks with
 * base-pointer save/restore, growth-by-closure-rebuild, deferred
 * effect/scope reclamation with generation counters, same-file const enum
 * constants (bundler-proof inlining).
 *
 * FUSION NOTES:
 * - arena-host's `watched(node, handle)` upcall is a policy NO-OP (plain
 *   Atom/Computed semantics have no first-subscriber behavior). Fusing an
 *   empty body splices to NOTHING, so linkInsert here matches the donor's —
 *   this is exactly what a codegen fusion step would emit.
 * - arena-host's `refresh(node, handle)` becomes the same-closure
 *   `update(node)` (the donor's name); the handle load moves inside it —
 *   same load, same storage, no call boundary.
 * - The kernel flags word carries only upstream's six semantic bits;
 *   P.HAS_CHILD_EFFECT (bit 64) is policy-owned, exactly as in arena-host.
 */

// ---- record layout + flags as a const enum -----------------------------------
// Same-file const enum so every consumer toolchain inlines the values as
// literals (see the donor's header for the bundling rationale).
const enum C {
	// Node fields (M plane, stride 8; ids are pre-multiplied: id = record * 8).
	FLAGS = 0,
	DEPS = 1, // doubles as the free-list next pointer for freed records
	DEPS_TAIL = 2,
	SUBS = 3,
	SUBS_TAIL = 4,
	GEN = 5, // bumped on free; disposers capture it to defuse stale ids
	HANDLE = 6, // policy handle: index into the entity table (arena-host storage)
	// field 7 spare (pad to one cache line per record)

	// Link fields (M plane, stride 8; link records share the plane with nodes).
	VERSION = 0,
	DEP = 1,
	SUB = 2,
	PREV_SUB = 3,
	NEXT_SUB = 4,
	PREV_DEP = 5,
	NEXT_DEP = 6, // doubles as the free-list next pointer for freed links
	// field 7 spare

	// Flags: upstream ReactiveFlags ONLY. No kind bits (kind lives in the entity).
	MUTABLE = 1,
	WATCHING = 2,
	RECURSED_CHECK = 4,
	RECURSED = 8,
	DIRTY = 16,
	PENDING = 32,

	// Min free records guaranteed at each op boundary (donor value).
	REC_SLACK = 1280,
}

// Policy-owned data stored in the kernel flags word (bit 64, outside the
// semantic range, exactly like upstream's HasChildEffect / arena-host's P).
const enum P {
	HAS_CHILD_EFFECT = 64,
}

const enum Kind {
	Dead = 0,
	Signal = 1,
	Computed = 2,
	Effect = 3,
	Scope = 4,
}

// ---- shared mutable state (survives engine rebuilds) ------------------------
let recNext = 8 // bump pointer, shared by nodes and links (record 0 burned)
let nodeFreeHead = 0 // free list threaded through M[id + C.DEPS]
let linkFreeHead = 0 // free list threaded through M[id + C.NEXT_DEP]
let growPending = false

let cycle = 0
let runDepth = 0
let batchDepth = 0
let notifyIndex = 0
let queuedLength = 0
let activeSub = 0
let enterDepth = 0 // live engine frames that captured M; 0 = op boundary

const queued: number[] = []
const pendingFree: number[] = [] // disposed effect/scope records awaiting sweep

// ---- policy entity table ------------------------------------------------------
// IDENTICAL to arena-host: dense handle-indexed, single hidden class; slots
// are RECYCLED in place so the table never goes polymorphic.
interface Ent {
	kind: number // Kind.*; Kind.Dead marks disposed/free slots
	value: unknown // signal current value / computed value
	pending: unknown // signal pending value
	fn: Function | undefined // computed getter / effect fn
	cleanup: unknown // effect cleanup fn (result of the last run)
}

// Handle 0 burned to mirror the kernel's burned record 0.
const entities: Ent[] = [
	{ kind: Kind.Dead, value: undefined, pending: undefined, fn: undefined, cleanup: undefined },
]
const freeHandles: number[] = []

// Persistent scratch stacks. Re-entrant walks push above the caller's base
// and restore it on exit.
let propStack = new Int32Array(4096)
let propSp = 0
let checkStack = new Int32Array(4096)
let checkSp = 0

// ---- the fused engine -----------------------------------------------------------

interface Engine {
	records: number
	buffer(): Int32Array
	newSignal(value: unknown): number
	newComputed(getter: (previousValue?: unknown) => unknown): number
	newEffect(fn: () => (() => void) | void): number
	newScope(fn: () => void): number
	gen(id: number): number
	handleOf(id: number): number
	read(s: number, h: number): unknown
	write(s: number, h: number, value: unknown): boolean
	computedRead(c: number, h: number): unknown
	run(e: number): void
	requeueAbort(e: number): void
	dispose(e: number): void
	sweepPendingFree(): void
}

function createEngine(records: number, carry?: Int32Array): Engine {
	const M = new Int32Array(records * 8)
	// Bundler-proof aliases for the module-level policy state (see donor note:
	// esbuild bundling demotes module-scope `const` to mutable `var`).
	const ents = entities
	const handleFree = freeHandles
	const queue = queued
	if (carry !== undefined) {
		M.set(carry)
	}
	// Allocators flag growth once the bump pointer crosses the watermark:
	// keep at least C.REC_SLACK records AND half the plane free at every boundary.
	const WM = Math.min(M.length >> 1, M.length - C.REC_SLACK * 8)
	if (recNext > WM) {
		growPending = true
	}

	return {
		records,
		buffer: () => M,
		newSignal,
		newComputed,
		newEffect,
		newScope,
		gen: (id) => M[id + C.GEN],
		handleOf: (id) => M[id + C.HANDLE],
		read,
		write,
		computedRead,
		run,
		requeueAbort,
		dispose,
		sweepPendingFree,
	}

	// ---- allocation ----------------------------------------------------------

	function alloc(flags: number, handle: number): number {
		let id: number
		if (nodeFreeHead !== 0) {
			id = nodeFreeHead
			nodeFreeHead = M[id + C.DEPS]
			M[id + C.DEPS] = 0
		} else {
			id = recNext
			if (id >= M.length) {
				throw new Error(
					'@lab/arena-host-fused: arena exhausted mid-operation; raise ARENA_INITIAL_RECORDS',
				)
			}
			recNext = id + 8
			if (recNext > WM) {
				growPending = true
			}
		}
		M[id + C.FLAGS] = flags
		M[id + C.HANDLE] = handle
		return id
	}

	function free(id: number): void {
		M[id + C.FLAGS] = 0
		M[id + C.DEPS_TAIL] = 0
		M[id + C.SUBS] = 0
		M[id + C.SUBS_TAIL] = 0
		M[id + C.HANDLE] = 0
		++M[id + C.GEN]
		M[id + C.DEPS] = nodeFreeHead
		nodeFreeHead = id
	}

	function allocLink(): number {
		let id: number
		if (linkFreeHead !== 0) {
			id = linkFreeHead
			linkFreeHead = M[id + C.NEXT_DEP]
		} else {
			id = recNext
			if (id >= M.length) {
				throw new Error(
					'@lab/arena-host-fused: arena exhausted mid-operation; raise ARENA_INITIAL_RECORDS',
				)
			}
			recNext = id + 8
			if (recNext > WM) {
				growPending = true
			}
		}
		return id
	}

	function freeLink(id: number): void {
		M[id + C.NEXT_DEP] = linkFreeHead
		linkFreeHead = id
	}

	// ---- system.ts transliteration -------------------------------------------

	function link(dep: number, sub: number, version: number): void {
		const prevDep = M[sub + C.DEPS_TAIL]
		if (prevDep !== 0 && M[prevDep + C.DEP] === dep) {
			return
		}
		const nextDep = prevDep !== 0 ? M[prevDep + C.NEXT_DEP] : M[sub + C.DEPS]
		if (nextDep !== 0 && M[nextDep + C.DEP] === dep) {
			M[nextDep + C.VERSION] = version
			M[sub + C.DEPS_TAIL] = nextDep
			return
		}
		linkInsert(dep, sub, version, prevDep, nextDep)
	}

	// Insertion tail of link(): kept out of line so the steady-state re-track
	// fast path above stays under V8's inlining bytecode budget (donor note).
	function linkInsert(
		dep: number,
		sub: number,
		version: number,
		prevDep: number,
		nextDep: number,
	): void {
		const prevSub = M[dep + C.SUBS_TAIL]
		if (prevSub !== 0 && M[prevSub + C.VERSION] === version && M[prevSub + C.SUB] === sub) {
			return
		}
		const newLink = allocLink()
		M[sub + C.DEPS_TAIL] = newLink
		M[dep + C.SUBS_TAIL] = newLink
		M[newLink + C.VERSION] = version
		M[newLink + C.DEP] = dep
		M[newLink + C.SUB] = sub
		M[newLink + C.PREV_DEP] = prevDep
		M[newLink + C.NEXT_DEP] = nextDep
		M[newLink + C.PREV_SUB] = prevSub
		M[newLink + C.NEXT_SUB] = 0
		if (nextDep !== 0) {
			M[nextDep + C.PREV_DEP] = newLink
		}
		if (prevDep !== 0) {
			M[prevDep + C.NEXT_DEP] = newLink
		} else {
			M[sub + C.DEPS] = newLink
		}
		if (prevSub !== 0) {
			M[prevSub + C.NEXT_SUB] = newLink
		} else {
			M[dep + C.SUBS] = newLink
			// FUSION POINT: arena-host upcalls hostWatched(dep, handle) here.
			// The policy body is a no-op, so the fused splice is empty.
		}
	}

	function unlink(id: number, sub = M[id + C.SUB]): number {
		const dep = M[id + C.DEP]
		const prevDep = M[id + C.PREV_DEP]
		const nextDep = M[id + C.NEXT_DEP]
		const nextSub = M[id + C.NEXT_SUB]
		const prevSub = M[id + C.PREV_SUB]
		if (nextDep !== 0) {
			M[nextDep + C.PREV_DEP] = prevDep
		} else {
			M[sub + C.DEPS_TAIL] = prevDep
		}
		if (prevDep !== 0) {
			M[prevDep + C.NEXT_DEP] = nextDep
		} else {
			M[sub + C.DEPS] = nextDep
		}
		if (nextSub !== 0) {
			M[nextSub + C.PREV_SUB] = prevSub
		} else {
			M[dep + C.SUBS_TAIL] = prevSub
		}
		freeLink(id)
		if (prevSub !== 0) {
			M[prevSub + C.NEXT_SUB] = nextSub
		} else if ((M[dep + C.SUBS] = nextSub) === 0) {
			// FUSION POINT: arena-host upcalls hostUnwatched(dep, handle) here.
			unwatched(dep)
		}
		return nextDep
	}

	function propagate(startLink: number, innerWrite: boolean): void {
		// No try/finally: propagate never runs user code (notify only queues),
		// so it cannot throw and always drains the stack back to its base.
		let cur = startLink
		let next = M[cur + C.NEXT_SUB]
		const stackBase = propSp

		top: do {
			const sub = M[cur + C.SUB]
			let flags = M[sub + C.FLAGS]

			if (!(flags & (C.RECURSED_CHECK | C.RECURSED | C.DIRTY | C.PENDING))) {
				M[sub + C.FLAGS] = flags | C.PENDING
				if (innerWrite) {
					M[sub + C.FLAGS] |= C.RECURSED
				}
			} else if (!(flags & (C.RECURSED_CHECK | C.RECURSED))) {
				flags = 0
			} else if (!(flags & C.RECURSED_CHECK)) {
				M[sub + C.FLAGS] = (flags & ~C.RECURSED) | C.PENDING
			} else if (!(flags & (C.DIRTY | C.PENDING)) && isValidLink(cur, sub)) {
				M[sub + C.FLAGS] = flags | (C.RECURSED | C.PENDING)
				flags &= C.MUTABLE
			} else {
				flags = 0
			}

			if (flags & C.WATCHING) {
				// FUSION POINT: arena-host upcalls hostNotify(sub, handle) here.
				notify(sub)
			}

			if (flags & C.MUTABLE) {
				const subSubs = M[sub + C.SUBS]
				if (subSubs !== 0) {
					cur = subSubs
					const nextSub = M[cur + C.NEXT_SUB]
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
				next = M[cur + C.NEXT_SUB]
				continue
			}

			while (propSp > stackBase) {
				cur = propStack[--propSp]
				if (cur !== 0) {
					next = M[cur + C.NEXT_SUB]
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
				const dep = M[cur + C.DEP]
				const depFlags = M[dep + C.FLAGS]

				if (M[sub + C.FLAGS] & C.DIRTY) {
					dirty = true
				} else if ((depFlags & (C.MUTABLE | C.DIRTY)) === (C.MUTABLE | C.DIRTY)) {
					const depSubs = M[dep + C.SUBS]
					// FUSION POINT: arena-host upcalls hostRefresh(dep, handle).
					if (update(dep)) {
						if (M[depSubs + C.NEXT_SUB] !== 0) {
							shallowPropagate(depSubs)
						}
						dirty = true
					}
				} else if ((depFlags & (C.MUTABLE | C.PENDING)) === (C.MUTABLE | C.PENDING)) {
					if (checkSp === checkStack.length) {
						const bigger = new Int32Array(checkStack.length * 2)
						bigger.set(checkStack)
						checkStack = bigger
					}
					checkStack[checkSp++] = cur
					cur = M[dep + C.DEPS]
					sub = dep
					++checkDepth
					continue
				}

				if (!dirty) {
					const nextDep = M[cur + C.NEXT_DEP]
					if (nextDep !== 0) {
						cur = nextDep
						continue
					}
				}

				while (checkDepth--) {
					cur = checkStack[--checkSp]
					if (dirty) {
						const subSubs = M[sub + C.SUBS]
						// FUSION POINT: arena-host upcalls hostRefresh(sub, handle).
						if (update(sub)) {
							if (M[subSubs + C.NEXT_SUB] !== 0) {
								shallowPropagate(subSubs)
							}
							sub = M[cur + C.SUB]
							continue
						}
						dirty = false
					} else {
						M[sub + C.FLAGS] &= ~C.PENDING
					}
					sub = M[cur + C.SUB]
					const nextDep = M[cur + C.NEXT_DEP]
					if (nextDep !== 0) {
						cur = nextDep
						continue top
					}
				}

				// Upstream: `dirty && !!sub.flags` — a live node here always has
				// semantic bits set (a computed being verified is Mutable at
				// minimum); flags reads 0 only if sub was disposed (record
				// zeroed) by re-entrant user code during update().
				return dirty && M[sub + C.FLAGS] !== 0
			} while (true)
		} finally {
			checkSp = stackBase
		}
	}

	function shallowPropagate(startLink: number): void {
		let cur = startLink
		do {
			const sub = M[cur + C.SUB]
			const flags = M[sub + C.FLAGS]
			if ((flags & (C.PENDING | C.DIRTY)) === C.PENDING) {
				M[sub + C.FLAGS] = flags | C.DIRTY
				if ((flags & (C.WATCHING | C.RECURSED_CHECK)) === C.WATCHING) {
					// FUSION POINT: arena-host upcalls hostNotify(sub, handle).
					notify(sub)
				}
			}
		} while ((cur = M[cur + C.NEXT_SUB]) !== 0)
	}

	function isValidLink(checkLink: number, sub: number): boolean {
		let cur = M[sub + C.DEPS_TAIL]
		while (cur !== 0) {
			if (cur === checkLink) {
				return true
			}
			cur = M[cur + C.PREV_DEP]
		}
		return false
	}

	// ---- index.ts transliteration (policy, fused same-closure) ----------------

	// arena-host's host.refresh, fused: the entity load and kind switch are the
	// SAME as arena-host's (handle load M[node + C.HANDLE], ent.kind dispatch);
	// only the call boundary is gone.
	function update(node: number): boolean {
		const ent = ents[M[node + C.HANDLE]]
		const kind = ent.kind
		if (kind === Kind.Computed) {
			return updateComputed(node, ent)
		}
		if (kind === Kind.Signal) {
			return updateSignal(node, ent)
		}
		M[node + C.FLAGS] = C.MUTABLE
		return true
	}

	// arena-host's host.notify, fused (handle unused there too).
	function notify(e: number): void {
		let insertIndex = queuedLength
		const firstInsertedIndex = insertIndex

		do {
			queue[insertIndex++] = e
			M[e + C.FLAGS] &= ~C.WATCHING
			const subs = M[e + C.SUBS]
			e = subs !== 0 ? M[subs + C.SUB] : 0
			if (e === 0 || !(M[e + C.FLAGS] & C.WATCHING)) {
				break
			}
		} while (true)

		queuedLength = insertIndex

		// The parent chain was appended child-first: reverse the inserted
		// segment in place so outer effects run before inner.
		let left = firstInsertedIndex
		while (left < --insertIndex) {
			const tmp = queue[left]
			queue[left++] = queue[insertIndex]
			queue[insertIndex] = tmp
		}
	}

	// arena-host's host.unwatched, fused.
	function unwatched(node: number): void {
		const kind = ents[M[node + C.HANDLE]].kind
		if (kind === Kind.Computed) {
			if (M[node + C.DEPS_TAIL] !== 0) {
				M[node + C.FLAGS] = C.MUTABLE | C.DIRTY
				disposeAllDepsInReverse(node)
			}
		} else if (kind === Kind.Signal) {
			// Nothing to do for signals.
		} else if (kind !== Kind.Dead) {
			dispose(node)
		}
	}

	// Upstream's HasChildEffect slow path: unlink every dep that is not a
	// signal/computed (i.e. child effects/scopes), in reverse. Kind knowledge
	// comes from the entity table, as in arena-host.
	function unlinkChildEffects(sub: number): void {
		let cur = M[sub + C.DEPS_TAIL]
		while (cur !== 0) {
			const prev = M[cur + C.PREV_DEP]
			const dep = M[cur + C.DEP]
			const kind = ents[M[dep + C.HANDLE]].kind
			if (kind !== Kind.Computed && kind !== Kind.Signal) {
				unlink(cur, sub)
			}
			cur = prev
		}
	}

	function updateComputed(c: number, ent: Ent): boolean {
		if (M[c + C.FLAGS] & P.HAS_CHILD_EFFECT) {
			unlinkChildEffects(c)
		}
		M[c + C.DEPS_TAIL] = 0
		M[c + C.FLAGS] = C.MUTABLE | C.RECURSED_CHECK
		const prevSub = activeSub
		activeSub = c
		++enterDepth
		try {
			++cycle
			const oldValue = ent.value
			return oldValue !== (ent.value = (ent.fn as (previousValue?: unknown) => unknown)(oldValue))
		} finally {
			--enterDepth
			activeSub = prevSub
			M[c + C.FLAGS] &= ~C.RECURSED_CHECK
			purgeDeps(c)
		}
	}

	function updateSignal(s: number, ent: Ent): boolean {
		M[s + C.FLAGS] = C.MUTABLE
		return ent.value !== (ent.value = ent.pending)
	}

	function run(e: number): void {
		const flags = M[e + C.FLAGS]
		if (flags & C.DIRTY || (flags & C.PENDING && checkDirty(M[e + C.DEPS], e))) {
			if (flags & P.HAS_CHILD_EFFECT) {
				unlinkChildEffects(e)
			}
			const ent = ents[M[e + C.HANDLE]]
			if (ent.cleanup) {
				runCleanup(ent)
				if (ent.kind === Kind.Dead) {
					return // disposed by its own cleanup
				}
			}
			M[e + C.DEPS_TAIL] = 0
			M[e + C.FLAGS] = C.WATCHING | C.RECURSED_CHECK
			const prevSub = activeSub
			activeSub = e
			++enterDepth
			try {
				++cycle
				++runDepth
				ent.cleanup = (ent.fn as () => (() => void) | void)()
			} finally {
				--runDepth
				--enterDepth
				activeSub = prevSub
				M[e + C.FLAGS] &= ~C.RECURSED_CHECK
				purgeDeps(e)
			}
		} else if (M[e + C.DEPS] !== 0) {
			M[e + C.FLAGS] = C.WATCHING | (flags & P.HAS_CHILD_EFFECT)
		}
	}

	// flush() abort path: re-arm effects still queued after a throw.
	function requeueAbort(e: number): void {
		if (ents[M[e + C.HANDLE]].kind !== Kind.Dead) {
			M[e + C.FLAGS] |= C.WATCHING | C.RECURSED
		}
	}

	function runCleanup(ent: Ent): void {
		const cleanup = ent.cleanup as () => void
		ent.cleanup = undefined
		const prevSub = activeSub
		activeSub = 0
		++enterDepth
		try {
			cleanup()
		} finally {
			--enterDepth
			activeSub = prevSub
		}
	}

	// effectOper + effectScopeOper: dispose an effect (runs cleanup) or scope.
	function dispose(e: number): void {
		const ent = ents[M[e + C.HANDLE]]
		const kind = ent.kind
		if (kind === Kind.Dead) {
			return // already disposed
		}
		ent.kind = Kind.Dead
		M[e + C.FLAGS] = 0
		disposeAllDepsInReverse(e)
		const sub = M[e + C.SUBS]
		if (sub !== 0) {
			unlink(sub)
		}
		if (kind === Kind.Effect && ent.cleanup) {
			runCleanup(ent)
		}
		// Deferred reclamation: the queue (or an in-flight walk) may still hold
		// this id; the record is swept back onto the free list at the next
		// operation boundary.
		pendingFree.push(e)
	}

	function sweepPendingFree(): void {
		for (let i = 0; i < pendingFree.length; ++i) {
			const id = pendingFree[i]
			const h = M[id + C.HANDLE]
			const ent = ents[h]
			ent.kind = Kind.Dead
			ent.value = undefined
			ent.pending = undefined
			ent.fn = undefined
			ent.cleanup = undefined
			handleFree.push(h)
			free(id)
		}
		pendingFree.length = 0
	}

	function disposeAllDepsInReverse(sub: number): void {
		let cur = M[sub + C.DEPS_TAIL]
		while (cur !== 0) {
			const prev = M[cur + C.PREV_DEP]
			unlink(cur, sub)
			cur = prev
		}
	}

	function purgeDeps(sub: number): void {
		const depsTail = M[sub + C.DEPS_TAIL]
		let dep = depsTail !== 0 ? M[depsTail + C.NEXT_DEP] : M[sub + C.DEPS]
		while (dep !== 0) {
			dep = unlink(dep, sub)
		}
	}

	// ---- entity + node creation ------------------------------------------------

	function allocEnt(
		kind: number,
		value: unknown,
		pending: unknown,
		fn: Function | undefined,
	): number {
		if (handleFree.length !== 0) {
			const h = handleFree.pop()!
			const ent = ents[h]
			ent.kind = kind
			ent.value = value
			ent.pending = pending
			ent.fn = fn
			ent.cleanup = undefined
			return h
		}
		ents.push({ kind, value, pending, fn, cleanup: undefined })
		return ents.length - 1
	}

	function newSignal(value: unknown): number {
		return alloc(C.MUTABLE, allocEnt(Kind.Signal, value, value, undefined))
	}

	function newComputed(getter: (previousValue?: unknown) => unknown): number {
		return alloc(0, allocEnt(Kind.Computed, undefined, undefined, getter))
	}

	function newEffect(fn: () => (() => void) | void): number {
		const h = allocEnt(Kind.Effect, undefined, undefined, fn)
		const e = alloc(C.WATCHING | C.RECURSED_CHECK, h)
		const ent = ents[h]
		const prevSub = activeSub
		activeSub = e
		if (prevSub !== 0) {
			link(e, prevSub, 0)
			M[prevSub + C.FLAGS] |= P.HAS_CHILD_EFFECT
		}
		++enterDepth
		try {
			++runDepth
			ent.cleanup = fn()
		} finally {
			--runDepth
			--enterDepth
			activeSub = prevSub
			M[e + C.FLAGS] &= ~C.RECURSED_CHECK
		}
		return e
	}

	function newScope(fn: () => void): number {
		const e = alloc(C.MUTABLE, allocEnt(Kind.Scope, undefined, undefined, undefined))
		const prevSub = activeSub
		activeSub = e
		if (prevSub !== 0) {
			link(e, prevSub, 0)
			M[prevSub + C.FLAGS] |= P.HAS_CHILD_EFFECT
		}
		++enterDepth
		try {
			fn()
		} finally {
			--enterDepth
			activeSub = prevSub
		}
		return e
	}

	// ---- operations dispatched from the public wrappers ------------------------

	// signalOper read path.
	function read(s: number, h: number): unknown {
		const ent = ents[h]
		if (M[s + C.FLAGS] & C.DIRTY) {
			if (updateSignal(s, ent)) {
				const subs = M[s + C.SUBS]
				if (subs !== 0) {
					shallowPropagate(subs)
				}
			}
		}
		if (activeSub !== 0) {
			link(s, activeSub, cycle)
		}
		return ent.value
	}

	// signalOper write path; the WRAPPER flushes (iff this returns true), so
	// growth can happen between queued effects at the top level.
	function write(s: number, h: number, value: unknown): boolean {
		const ent = ents[h]
		if (ent.pending !== (ent.pending = value)) {
			M[s + C.FLAGS] = C.MUTABLE | C.DIRTY
			const subs = M[s + C.SUBS]
			if (subs !== 0) {
				propagate(subs, runDepth !== 0)
				return true
			}
		}
		return false
	}

	// computedOper.
	function computedRead(c: number, h: number): unknown {
		const ent = ents[h]
		const flags = M[c + C.FLAGS]
		if (
			flags & C.DIRTY ||
			(flags & C.PENDING &&
				(checkDirty(M[c + C.DEPS], c) || ((M[c + C.FLAGS] = flags & ~C.PENDING), false)))
		) {
			if (updateComputed(c, ent)) {
				const subs = M[c + C.SUBS]
				if (subs !== 0) {
					shallowPropagate(subs)
				}
			}
		} else if (flags === 0) {
			// upstream `!flags`: never evaluated
			M[c + C.FLAGS] = C.MUTABLE | C.RECURSED_CHECK
			const prevSub = activeSub
			activeSub = c
			++enterDepth
			try {
				ent.value = (ent.fn as () => unknown)()
			} finally {
				--enterDepth
				activeSub = prevSub
				M[c + C.FLAGS] &= ~C.RECURSED_CHECK
			}
		}
		const sub = activeSub
		if (sub !== 0) {
			link(c, sub, cycle)
		}
		return ent.value
	}
}

// ---- engine instance + growth ------------------------------------------------

const initialRecords = (() => {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
		?.env?.ARENA_INITIAL_RECORDS
	const n = env !== undefined ? Number(env) : NaN
	return Number.isFinite(n) && n >= 2 ? Math.ceil(n) : 1 << 20
})()

// Footprint parity with the donor: 3x initialRecords shared records.
let E: Engine = createEngine(initialRecords * 3)

function maybeBoundary(): void {
	if (enterDepth === 0 && (growPending || pendingFree.length !== 0)) {
		boundaryWork()
	}
}

function boundaryWork(): void {
	// Sweep only while the effect queue is empty: an un-flushed queue may
	// still reference a disposed record, and freeing it here would let a new
	// node reuse the id and be run() by the stale queue entry.
	if (pendingFree.length !== 0 && queuedLength === 0) {
		E.sweepPendingFree()
	}
	if (growPending) {
		growPending = false
		let records = E.records
		while (recNext > Math.min((records * 8) >> 1, (records - C.REC_SLACK) * 8)) {
			records *= 2
		}
		if (records !== E.records) {
			E = createEngine(records, E.buffer())
		}
	}
}

function flush(): void {
	// Boundary-lite: growth/reclamation only BEFORE the flush loop, not between
	// effects (see donor flush() audit note; all user code during flush runs
	// at enterDepth >= 1, so E cannot be swapped mid-loop).
	maybeBoundary()
	const engine = E
	const queue = queued // function-scope alias survives bundling
	try {
		while (notifyIndex < queuedLength) {
			const e = queue[notifyIndex]
			queue[notifyIndex++] = 0
			engine.run(e)
		}
	} finally {
		while (notifyIndex < queuedLength) {
			const e = queue[notifyIndex]
			queue[notifyIndex++] = 0
			E.requeueAbort(e)
		}
		notifyIndex = 0
		queuedLength = 0
	}
}

// ---- public API ---------------------------------------------------------------

/** Callable signal handle: `s()` reads, `s(value)` writes. */
export interface SignalHandle<T> {
	(): T
	(value: T): void
}

export function signal<T>(): SignalHandle<T | undefined>
export function signal<T>(initialValue: T): SignalHandle<T>
export function signal<T>(initialValue?: T): SignalHandle<T | undefined> {
	maybeBoundary()
	const id = E.newSignal(initialValue)
	const h = E.handleOf(id)
	return function (...value: [T?]) {
		if (value.length) {
			maybeBoundary()
			if (E.write(id, h, value[0]) && !batchDepth) {
				flush()
			}
		} else {
			return E.read(id, h) as T | undefined
		}
	} as SignalHandle<T | undefined>
}

export function computed<T>(getter: (previousValue?: T) => T): () => T {
	maybeBoundary()
	const id = E.newComputed(getter as (previousValue?: unknown) => unknown)
	const h = E.handleOf(id)
	// No maybeBoundary on the read path (donor audit note).
	return () => E.computedRead(id, h) as T
}

/** Returns a disposer. `fn` may return a cleanup function. */
export function effect(fn: () => void | (() => void)): () => void {
	maybeBoundary()
	const id = E.newEffect(fn)
	const gen = E.gen(id)
	return () => {
		if (E.gen(id) !== gen) {
			return // record already reclaimed (and possibly reused)
		}
		E.dispose(id)
		maybeBoundary()
	}
}

/** Returns a disposer that disposes every effect created inside `fn`. */
export function effectScope(fn: () => void): () => void {
	maybeBoundary()
	const id = E.newScope(fn)
	const gen = E.gen(id)
	return () => {
		if (E.gen(id) !== gen) {
			return
		}
		E.dispose(id)
		maybeBoundary()
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
