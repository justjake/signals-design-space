/**
 * @lab/arena-host — SP1 spike: the @lab/arena donor kernel re-split along
 * upstream alien-signals' system.ts/index.ts seam, with the kernel as a
 * CLOSED integer engine.
 *
 * PURPOSE (design-loop/NOTES/OPEN.md O2): measure the host-callback
 * indirection tax that a two-kernel architecture (D-style) would pay. The
 * kernel here never touches values, functions, or kind information: it is a
 * pure topology + flags machine over the Int32Array plane. Everything
 * value/kind-shaped lives in a policy layer above it. The kernel calls a host
 * object with exactly four callbacks, registered ONCE at kernel creation and
 * bound as function-scope consts:
 *
 *   refresh(node, handle) -> boolean  // recompute in policy land; true if
 *                                     // the node's output changed
 *                                     // (upstream `update`)
 *   notify(node, handle)              // a watching subscriber was reached
 *   watched(node, handle)             // dep gained its FIRST subscriber
 *   unwatched(node, handle)           // dep lost its LAST subscriber
 *
 * `handle` is the policy-assigned integer stored in the node record's spare
 * field (C.HANDLE); the kernel loads and forwards it opaquely so the policy
 * can index its own dense table without a kernel-id -> policy-id map. In a
 * real two-kernel design kernel node ids and policy entity ids diverge, so
 * this load is part of the honest protocol cost.
 *
 * PRESERVED VERBATIM from the donor (do not "improve" — the point is an
 * apples-to-apples diff of exactly one variable, the host indirection):
 * flag-ladder and walk structure of propagate/checkDirty/shallowPropagate,
 * the link/linkInsert fast/slow split, closure-const buffer binding,
 * premultiplied ids (id = record * 8), persistent scratch stacks with
 * base-pointer save/restore, growth-by-closure-rebuild machinery, deferred
 * effect/scope reclamation with generation counters, same-file const enum
 * field/flag constants (bundler-proof inlining).
 *
 * DELETED from the kernel relative to the donor: the values/fns side
 * columns, the kind bits (K_SIGNAL/K_COMPUTED/K_EFFECT/K_SCOPE) and every
 * kind dispatch (update/notify/unwatched/unlinkChildEffects moved to
 * policy), and all user-code invocation. The kernel flags word carries only
 * upstream's six semantic bits; bit 64 (HAS_CHILD_EFFECT) is stored in the
 * same word but is policy-owned and never tested by kernel code (exactly
 * like upstream, where it lives outside ReactiveFlags' range).
 *
 * POLICY LAYER: plain Atom/Computed/effect semantics (a transliteration of
 * upstream index.ts / the donor's policy half) over a dense handle-indexed
 * entity table with a SINGLE hidden class:
 *   { kind, value, pending, fn, cleanup }
 * The policy reaches the kernel only through its returned operations
 * (link/unlink/propagate/checkDirty/shallowPropagate/purgeDeps/
 * disposeAllDepsInReverse) and tiny field accessors — all bound as
 * function-scope consts so they inline into policy code like any
 * monomorphic closure call.
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
	HANDLE = 6, // policy handle, opaque to the kernel; forwarded to host callbacks
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

	// Flags: upstream ReactiveFlags ONLY. No kind bits in the kernel.
	MUTABLE = 1,
	WATCHING = 2,
	RECURSED_CHECK = 4,
	RECURSED = 8,
	DIRTY = 16,
	PENDING = 32,

	// Min free records guaranteed at each op boundary (donor value).
	REC_SLACK = 1280,
}

// Policy-owned data stored outside the kernel's ken.
const enum P {
	// Stored in the kernel flags word (bit 64, outside the semantic range,
	// exactly like upstream's HasChildEffect) but only ever read/written by
	// policy code. Kernel masks never include it.
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
// Dense handle-indexed, single hidden class: every entity is created with the
// same five-field literal shape and slots are RECYCLED in place (fields
// overwritten, object reused) so the table never goes polymorphic.
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

// Persistent scratch stacks (kernel-owned; module level so they survive
// engine rebuilds). Re-entrant walks push above the caller's base and
// restore it on exit.
let propStack = new Int32Array(4096)
let propSp = 0
let checkStack = new Int32Array(4096)
let checkSp = 0

// ---- the closed kernel ----------------------------------------------------------

/** The four upcalls out of the kernel. Registered once at kernel creation. */
interface Host {
	refresh(node: number, handle: number): boolean
	notify(node: number, handle: number): void
	watched(node: number, handle: number): void
	unwatched(node: number, handle: number): void
}

interface Kernel {
	records: number
	buffer(): Int32Array
	alloc(flags: number, handle: number): number
	free(id: number): void
	gen(id: number): number
	handle(id: number): number
	getFlags(id: number): number
	setFlags(id: number, flags: number): void
	orFlags(id: number, mask: number): void
	andFlags(id: number, mask: number): void
	deps(id: number): number
	depsTail(id: number): number
	setDepsTail(id: number, link: number): void
	subs(id: number): number
	linkDep(l: number): number
	linkSub(l: number): number
	linkPrevDep(l: number): number
	link(dep: number, sub: number, version: number): void
	unlink(l: number, sub?: number): number
	propagate(startLink: number, innerWrite: boolean): void
	checkDirty(startLink: number, startSub: number): boolean
	shallowPropagate(startLink: number): void
	purgeDeps(sub: number): void
	disposeAllDepsInReverse(sub: number): void
}

function createKernel(records: number, host: Host, carry?: Int32Array): Kernel {
	const M = new Int32Array(records * 8)
	// Host callbacks bound ONCE as function-scope consts: one property load at
	// creation, every upcall thereafter is a direct monomorphic closure call.
	const hostRefresh = host.refresh
	const hostNotify = host.notify
	const hostWatched = host.watched
	const hostUnwatched = host.unwatched
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
		alloc,
		free,
		gen: (id) => M[id + C.GEN],
		handle: (id) => M[id + C.HANDLE],
		getFlags: (id) => M[id + C.FLAGS],
		setFlags: (id, flags) => {
			M[id + C.FLAGS] = flags
		},
		orFlags: (id, mask) => {
			M[id + C.FLAGS] |= mask
		},
		andFlags: (id, mask) => {
			M[id + C.FLAGS] &= mask
		},
		deps: (id) => M[id + C.DEPS],
		depsTail: (id) => M[id + C.DEPS_TAIL],
		setDepsTail: (id, l) => {
			M[id + C.DEPS_TAIL] = l
		},
		subs: (id) => M[id + C.SUBS],
		linkDep: (l) => M[l + C.DEP],
		linkSub: (l) => M[l + C.SUB],
		linkPrevDep: (l) => M[l + C.PREV_DEP],
		link,
		unlink,
		propagate,
		checkDirty,
		shallowPropagate,
		purgeDeps,
		disposeAllDepsInReverse,
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
					'@lab/arena-host: arena exhausted mid-operation; raise ARENA_INITIAL_RECORDS',
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
					'@lab/arena-host: arena exhausted mid-operation; raise ARENA_INITIAL_RECORDS',
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
			// dep just gained its FIRST subscriber: host protocol upcall.
			hostWatched(dep, M[dep + C.HANDLE])
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
			hostUnwatched(dep, M[dep + C.HANDLE])
		}
		return nextDep
	}

	function propagate(startLink: number, innerWrite: boolean): void {
		// No try/finally: propagate never runs user code (host notify only
		// queues), so it cannot throw and always drains the stack to its base.
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
				hostNotify(sub, M[sub + C.HANDLE])
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
					if (hostRefresh(dep, M[dep + C.HANDLE])) {
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
						if (hostRefresh(sub, M[sub + C.HANDLE])) {
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
				// zeroed) by re-entrant user code during refresh().
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
					hostNotify(sub, M[sub + C.HANDLE])
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

	// Pure-topology helpers (no kind/value knowledge): kernel mechanism.

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
}

// ---- the policy layer -----------------------------------------------------------

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
	// Bundler-proof aliases for the module-level policy state (see donor note:
	// esbuild bundling demotes module-scope `const` to mutable `var`).
	const ents = entities
	const handleFree = freeHandles
	const queue = queued

	// The host object: registered once, here. Function declarations below are
	// hoisted, so the kernel can const-bind them at creation.
	const K = createKernel(records, { refresh, notify, watched, unwatched }, carry)

	// Kernel operations bound as function-scope consts: direct monomorphic
	// closure calls from policy code (the accessors are small enough to inline).
	const kAlloc = K.alloc
	const kFree = K.free
	const kHandle = K.handle
	const kGetFlags = K.getFlags
	const kSetFlags = K.setFlags
	const kOrFlags = K.orFlags
	const kAndFlags = K.andFlags
	const kDeps = K.deps
	const kDepsTail = K.depsTail
	const kSetDepsTail = K.setDepsTail
	const kSubs = K.subs
	const kLinkDep = K.linkDep
	const kLinkSub = K.linkSub
	const kLinkPrevDep = K.linkPrevDep
	const kLink = K.link
	const kUnlink = K.unlink
	const kPropagate = K.propagate
	const kCheckDirty = K.checkDirty
	const kShallowPropagate = K.shallowPropagate
	const kPurgeDeps = K.purgeDeps
	const kDisposeAllDepsInReverse = K.disposeAllDepsInReverse

	return {
		records: K.records,
		buffer: K.buffer,
		newSignal,
		newComputed,
		newEffect,
		newScope,
		gen: K.gen,
		handleOf: K.handle,
		read,
		write,
		computedRead,
		run,
		requeueAbort,
		dispose,
		sweepPendingFree,
	}

	// ---- host callbacks (the four upcalls) -----------------------------------

	function refresh(node: number, handle: number): boolean {
		const ent = ents[handle]
		const kind = ent.kind
		if (kind === Kind.Computed) {
			return updateComputed(node, ent)
		}
		if (kind === Kind.Signal) {
			return updateSignal(node, ent)
		}
		kSetFlags(node, C.MUTABLE)
		return true
	}

	function notify(e: number, _handle: number): void {
		let insertIndex = queuedLength
		const firstInsertedIndex = insertIndex

		do {
			queue[insertIndex++] = e
			kAndFlags(e, ~C.WATCHING)
			const subs = kSubs(e)
			e = subs !== 0 ? kLinkSub(subs) : 0
			if (e === 0 || !(kGetFlags(e) & C.WATCHING)) {
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

	function watched(_node: number, _handle: number): void {
		// Plain Atom/Computed/effect semantics have no first-subscriber
		// behavior; the upcall exists (and its call cost is paid) as part of
		// the four-callback host protocol under measurement.
	}

	function unwatched(node: number, handle: number): void {
		const kind = ents[handle].kind
		if (kind === Kind.Computed) {
			if (kDepsTail(node) !== 0) {
				kSetFlags(node, C.MUTABLE | C.DIRTY)
				kDisposeAllDepsInReverse(node)
			}
		} else if (kind === Kind.Signal) {
			// Nothing to do for signals.
		} else if (kind !== Kind.Dead) {
			dispose(node)
		}
	}

	// ---- index.ts transliteration (policy) ------------------------------------

	// Upstream's HasChildEffect slow path: unlink every dep that is not a
	// signal/computed (i.e. child effects/scopes), in reverse. Needs kind
	// knowledge, hence policy.
	function unlinkChildEffects(sub: number): void {
		let cur = kDepsTail(sub)
		while (cur !== 0) {
			const prev = kLinkPrevDep(cur)
			const dep = kLinkDep(cur)
			const kind = ents[kHandle(dep)].kind
			if (kind !== Kind.Computed && kind !== Kind.Signal) {
				kUnlink(cur, sub)
			}
			cur = prev
		}
	}

	function updateComputed(c: number, ent: Ent): boolean {
		if (kGetFlags(c) & P.HAS_CHILD_EFFECT) {
			unlinkChildEffects(c)
		}
		kSetDepsTail(c, 0)
		kSetFlags(c, C.MUTABLE | C.RECURSED_CHECK)
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
			kAndFlags(c, ~C.RECURSED_CHECK)
			kPurgeDeps(c)
		}
	}

	function updateSignal(s: number, ent: Ent): boolean {
		kSetFlags(s, C.MUTABLE)
		return ent.value !== (ent.value = ent.pending)
	}

	function run(e: number): void {
		const flags = kGetFlags(e)
		if (flags & C.DIRTY || (flags & C.PENDING && kCheckDirty(kDeps(e), e))) {
			if (flags & P.HAS_CHILD_EFFECT) {
				unlinkChildEffects(e)
			}
			const ent = ents[kHandle(e)]
			if (ent.cleanup) {
				runCleanup(ent)
				if (ent.kind === Kind.Dead) {
					return // disposed by its own cleanup
				}
			}
			kSetDepsTail(e, 0)
			kSetFlags(e, C.WATCHING | C.RECURSED_CHECK)
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
				kAndFlags(e, ~C.RECURSED_CHECK)
				kPurgeDeps(e)
			}
		} else if (kDeps(e) !== 0) {
			kSetFlags(e, C.WATCHING | (flags & P.HAS_CHILD_EFFECT))
		}
	}

	// flush() abort path: re-arm effects still queued after a throw.
	function requeueAbort(e: number): void {
		if (ents[kHandle(e)].kind !== Kind.Dead) {
			kOrFlags(e, C.WATCHING | C.RECURSED)
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
		const ent = ents[kHandle(e)]
		const kind = ent.kind
		if (kind === Kind.Dead) {
			return // already disposed
		}
		ent.kind = Kind.Dead
		kSetFlags(e, 0)
		kDisposeAllDepsInReverse(e)
		const sub = kSubs(e)
		if (sub !== 0) {
			kUnlink(sub)
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
			const h = kHandle(id)
			const ent = ents[h]
			ent.kind = Kind.Dead
			ent.value = undefined
			ent.pending = undefined
			ent.fn = undefined
			ent.cleanup = undefined
			handleFree.push(h)
			kFree(id)
		}
		pendingFree.length = 0
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
		return kAlloc(C.MUTABLE, allocEnt(Kind.Signal, value, value, undefined))
	}

	function newComputed(getter: (previousValue?: unknown) => unknown): number {
		return kAlloc(0, allocEnt(Kind.Computed, undefined, undefined, getter))
	}

	function newEffect(fn: () => (() => void) | void): number {
		const h = allocEnt(Kind.Effect, undefined, undefined, fn)
		const e = kAlloc(C.WATCHING | C.RECURSED_CHECK, h)
		const ent = ents[h]
		const prevSub = activeSub
		activeSub = e
		if (prevSub !== 0) {
			kLink(e, prevSub, 0)
			kOrFlags(prevSub, P.HAS_CHILD_EFFECT)
		}
		++enterDepth
		try {
			++runDepth
			ent.cleanup = fn()
		} finally {
			--runDepth
			--enterDepth
			activeSub = prevSub
			kAndFlags(e, ~C.RECURSED_CHECK)
		}
		return e
	}

	function newScope(fn: () => void): number {
		const e = kAlloc(C.MUTABLE, allocEnt(Kind.Scope, undefined, undefined, undefined))
		const prevSub = activeSub
		activeSub = e
		if (prevSub !== 0) {
			kLink(e, prevSub, 0)
			kOrFlags(prevSub, P.HAS_CHILD_EFFECT)
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
		if (kGetFlags(s) & C.DIRTY) {
			if (updateSignal(s, ent)) {
				const subs = kSubs(s)
				if (subs !== 0) {
					kShallowPropagate(subs)
				}
			}
		}
		if (activeSub !== 0) {
			kLink(s, activeSub, cycle)
		}
		return ent.value
	}

	// signalOper write path; the WRAPPER flushes (iff this returns true), so
	// growth can happen between queued effects at the top level.
	function write(s: number, h: number, value: unknown): boolean {
		const ent = ents[h]
		if (ent.pending !== (ent.pending = value)) {
			kSetFlags(s, C.MUTABLE | C.DIRTY)
			const subs = kSubs(s)
			if (subs !== 0) {
				kPropagate(subs, runDepth !== 0)
				return true
			}
		}
		return false
	}

	// computedOper.
	function computedRead(c: number, h: number): unknown {
		const ent = ents[h]
		const flags = kGetFlags(c)
		if (
			flags & C.DIRTY ||
			(flags & C.PENDING && (kCheckDirty(kDeps(c), c) || (kSetFlags(c, flags & ~C.PENDING), false)))
		) {
			if (updateComputed(c, ent)) {
				const subs = kSubs(c)
				if (subs !== 0) {
					kShallowPropagate(subs)
				}
			}
		} else if (flags === 0) {
			// upstream `!flags`: never evaluated
			kSetFlags(c, C.MUTABLE | C.RECURSED_CHECK)
			const prevSub = activeSub
			activeSub = c
			++enterDepth
			try {
				ent.value = (ent.fn as () => unknown)()
			} finally {
				--enterDepth
				activeSub = prevSub
				kAndFlags(c, ~C.RECURSED_CHECK)
			}
		}
		const sub = activeSub
		if (sub !== 0) {
			kLink(c, sub, cycle)
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
