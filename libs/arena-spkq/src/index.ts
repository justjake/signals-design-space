/**
 * @lab/arena-spkq — SPK-Q spike variant: the donor @lab/arena kernel with the
 * round-01 winner's read-path world-routing branch added in its cheapest
 * honest form (synthesis §5.2: `w = currentWorld; if w is NEWEST or
 * RENDER_NEWEST: return k0.pull(node)` — the donor fast path — else the world
 * path). The branch sits at the top of BOTH hot read paths (atom read and
 * computed read); during measurement `currentWorld` stays at the NEWEST
 * sentinel so the fast side is always taken — the spike question is what the
 * always-present branch costs quiet-React (DIRECT / no live transitions)
 * reads. Everything below the SPK-Q markers is the donor verbatim.
 *
 * Encoding (interpretation, documented in the findings note): `currentWorld`
 * is a module-scalar int; 0 encodes every world whose reads route to K0 raw
 * (NEWEST outside passes, RENDER_NEWEST passes — §5.1 says RENDER_NEWEST
 * reads "route like NEWEST", so both fast-routing worlds share the sentinel
 * and the check is ONE scalar compare against 0). Non-zero worlds take a real
 * out-of-line call (`worldRead`), unimplemented in this spike and never taken
 * during measurement. The F(node) flag check and freshness rule live on the
 * slow side of the branch and are therefore not modeled.
 *
 * ---- donor header follows ----------------------------------------------------
 *
 * @lab/arena — alien-signals v3.2.1 transliterated onto interleaved Int32Array
 * records. Mechanical port of upstream system.ts + index.ts:
 *
 * - Nodes and links are integer ids into ONE flat Int32Array plane (M),
 *   stride 8; ids are pre-multiplied record offsets (id = recordIndex * 8) so
 *   field access is `M[id + FIELD]`. Nodes and links interleave in the same
 *   plane: single base register, single bump pointer, two free lists (plane
 *   merge measured -2% deep / -8% diamond vs split N/L planes). Record 0 is
 *   burned as NULL, so every `x !== undefined` in upstream becomes `x !== 0`.
 * - Values and functions live in packed side arrays indexed off the id
 *   (`values` holds two slots per record: current/computed value + signal
 *   pending value or effect cleanup; `fns` holds one). One packed value
 *   column — never type-segregated.
 * - The flags word carries alien's six semantic bits PLUS kind bits, so
 *   dispatch ('getter' in node / 'currentValue' in node upstream) is a bit
 *   test on the same 4-byte load as the state check.
 * - Upstream's {value, prev} cons stacks become persistent Int32Array scratch
 *   stacks with base-pointer save/restore: checkDirty -> update -> user getter
 *   RE-ENTERS checkDirty, and the inner call must unwind to its own base.
 *
 * GROWTH (closure rebuild): the whole engine closes over `const M`
 * (TurboFan embeds the base address; measured at exact const parity, see the
 * v8-growable-buffer-bindings note). Growth rebuilds the engine closure over
 * doubled buffers (copy via .set) and swaps ONE mutable module-level `E`
 * reference — only ever at an operation boundary (enterDepth === 0, i.e. no
 * engine frame that took the old buffers into scope is live), never mid-walk.
 * The allocators set `growPending` when they cross a slack watermark; the
 * public wrappers and the flush loop perform the actual rebuild. If a single
 * operation out-allocates the remaining slack the allocator throws rather
 * than corrupt in-flight walks. Rejected growth designs (measured, do not
 * relitigate): segment tables, resizable ArrayBuffers, mutable `let` buffer
 * bindings, per-function const aliases.
 *
 * RECLAMATION: effect/effectScope disposal returns node records to the free
 * list (deferred to the next operation boundary so a mid-flush dispose can
 * never recycle a record the queue or an in-flight walk still references; a
 * generation counter in the record makes stale disposers no-ops). Signal and
 * computed records are owned by the user's handle closures and are NOT
 * reclaimed: dropping the last reference to a signal/computed handle leaks
 * its record. The fix would be a FinalizationRegistry on the handle closures
 * pushing ids onto the free list — deliberately not implemented here.
 */

// ---- record layout + flags as a const enum -----------------------------------
// A const enum (not module-level `const`s) so every consumer toolchain inlines
// the values as literals. Rationale: esbuild BUNDLING demotes module-scope
// `const` to mutable `var` (lazy-init/scope-merge hoisting), which costs
// TurboFan its constant-folding of these hot numbers — measured +15-21% on
// kairo workloads through the harness's bundled child. Same-file const enum
// members are inlined as numeric literals by esbuild (transform AND bundle
// modes), tsx, vitest, and tsc alike, so the codegen no longer depends on how
// the library is packaged. (See RESEARCH.md §7b bundling investigation.)
const enum C {
	// Node fields (M plane, stride 8; ids are pre-multiplied: id = record * 8).
	FLAGS = 0,
	DEPS = 1, // doubles as the free-list next pointer for freed records
	DEPS_TAIL = 2,
	SUBS = 3,
	SUBS_TAIL = 4,
	GEN = 5, // bumped on free; disposers capture it to defuse stale ids
	// fields 6-7 spare (pad to one cache line per record)

	// Link fields (M plane, stride 8; link records share the plane with nodes).
	VERSION = 0,
	DEP = 1,
	SUB = 2,
	PREV_SUB = 3,
	NEXT_SUB = 4,
	PREV_DEP = 5,
	NEXT_DEP = 6, // doubles as the free-list next pointer for freed links
	// field 7 spare

	// Flags (upstream ReactiveFlags + HasChildEffect + kind bits).
	MUTABLE = 1,
	WATCHING = 2,
	RECURSED_CHECK = 4,
	RECURSED = 8,
	DIRTY = 16,
	PENDING = 32,
	HAS_CHILD_EFFECT = 64,
	K_SIGNAL = 128,
	K_COMPUTED = 256,
	K_EFFECT = 512,
	K_SCOPE = 1024,
	KIND_MASK = K_SIGNAL | K_COMPUTED | K_EFFECT | K_SCOPE,

	// Min free records guaranteed at each op boundary. Nodes and links draw
	// from one shared pool; the old split-plane budget (256 node + 1024 link
	// records) is preserved as its sum, so any allocation pattern that fit the
	// old per-plane slack still fits the merged slack.
	REC_SLACK = 1280,
}

// ---- shared mutable state (survives engine rebuilds) ------------------------
// Scalar heads/counters live at module level so a rebuilt engine resumes
// exactly where the old one stopped; only the buffer bindings live in the
// engine closure.
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

// ---- SPK-Q: the winner's read-path world routing (fast side always taken) ----
// Module-level `let` (NOT a closure const): the React lifecycle drives the
// per-callstack currentWorld at pass boundaries without an engine rebuild —
// that is the baseline design whose quiet-read cost this spike prices.
// 0 = NEWEST / RENDER_NEWEST (reads hit K0 raw); any other value = a pass
// world that must route to world evaluation.
let currentWorld = 0

/** Set the routing world (React pass lifecycle). Benchmarks never leave 0. */
export function setCurrentWorld(w: number): number {
	const prev = currentWorld
	currentWorld = w
	return prev
}

// Out-of-line slow side so the branch has a real call target. The world-
// evaluation machinery (synthesis §8) is out of scope for this spike;
// measurement never arms a non-newest world.
function worldRead(node: number): unknown {
	throw new Error(
		`@lab/arena-spkq: read of node ${node} in world ${currentWorld}: world path not implemented in this spike`,
	)
}

// Side columns, indexed off the id: values[id >> 2] = current/computed value,
// values[(id >> 2) + 1] = signal pending value OR effect cleanup fn,
// fns[id >> 3] = computed getter / effect fn. Plain arrays grown by push
// (stays PACKED; plain-array growth has no binding problem).
const values: unknown[] = [undefined, undefined]
const fns: (Function | undefined)[] = [undefined]

// Persistent scratch stacks (upstream's cons-cell Stack<T>). Re-entrant
// walks push above the caller's base and restore it on exit.
let propStack = new Int32Array(4096)
let propSp = 0
let checkStack = new Int32Array(4096)
let checkSp = 0

// ---- the engine -------------------------------------------------------------

interface Engine {
	records: number
	buffer(): Int32Array
	newSignal(value: unknown): number
	newComputed(getter: (previousValue?: unknown) => unknown): number
	newEffect(fn: () => (() => void) | void): number
	newScope(fn: () => void): number
	gen(id: number): number
	read(s: number): unknown
	write(s: number, value: unknown): boolean
	computedRead(c: number): unknown
	run(e: number): void
	requeueAbort(e: number): void
	dispose(e: number): void
	sweepPendingFree(): void
}

function createEngine(records: number, carry?: Int32Array): Engine {
	const M = new Int32Array(records * 8)
	// Bundler-proof aliases for the module-level side arrays: esbuild
	// bundling demotes module-scope `const` to mutable `var`, so TurboFan
	// loses their constant-folding at module scope; a function-scope const
	// is preserved verbatim and folds via the same one-closure-cell context
	// specialization that embeds M.
	const vals = values
	const fnTab = fns
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
		read,
		write,
		computedRead,
		run,
		requeueAbort,
		dispose,
		sweepPendingFree,
	}

	// ---- allocation ----------------------------------------------------------

	function allocNode(flags: number): number {
		let id: number
		if (nodeFreeHead !== 0) {
			id = nodeFreeHead
			nodeFreeHead = M[id + C.DEPS]
			M[id + C.DEPS] = 0
		} else {
			id = recNext
			if (id >= M.length) {
				throw new Error('@lab/arena: arena exhausted mid-operation; raise ARENA_INITIAL_RECORDS')
			}
			recNext = id + 8
			if (recNext > WM) {
				growPending = true
			}
		}
		M[id + C.FLAGS] = flags
		const v = id >> 2
		while (vals.length <= v + 1) {
			vals.push(undefined)
		}
		while (fnTab.length <= id >> 3) {
			fnTab.push(undefined)
		}
		return id
	}

	function freeNode(id: number): void {
		M[id + C.FLAGS] = 0
		M[id + C.DEPS_TAIL] = 0
		M[id + C.SUBS] = 0
		M[id + C.SUBS_TAIL] = 0
		++M[id + C.GEN]
		const v = id >> 2
		vals[v] = undefined
		vals[v + 1] = undefined
		fnTab[id >> 3] = undefined
		M[id + C.DEPS] = nodeFreeHead
		nodeFreeHead = id
	}

	function sweepPendingFree(): void {
		for (let i = 0; i < pendingFree.length; ++i) {
			freeNode(pendingFree[i])
		}
		pendingFree.length = 0
	}

	function allocLink(): number {
		let id: number
		if (linkFreeHead !== 0) {
			id = linkFreeHead
			linkFreeHead = M[id + C.NEXT_DEP]
		} else {
			id = recNext
			if (id >= M.length) {
				throw new Error('@lab/arena: arena exhausted mid-operation; raise ARENA_INITIAL_RECORDS')
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
	// fast path above stays under V8's inlining bytecode budget (upstream
	// monolithic link() was 475 bytecodes — kExceedsBytecodeLimit — and never
	// inlined into the read paths despite running on every tracked read).
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

				// Upstream: `dirty && !!sub.flags` — a live node always has its
				// kind bits set; flags reads 0 only if sub was disposed (record
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

	// ---- index.ts transliteration ---------------------------------------------

	function update(node: number): boolean {
		const flags = M[node + C.FLAGS]
		if (flags & C.K_COMPUTED) {
			return updateComputed(node)
		}
		if (flags & C.K_SIGNAL) {
			return updateSignal(node)
		}
		M[node + C.FLAGS] = (flags & C.KIND_MASK) | C.MUTABLE
		return true
	}

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

	function unwatched(node: number): void {
		const flags = M[node + C.FLAGS]
		if (flags & C.K_COMPUTED) {
			if (M[node + C.DEPS_TAIL] !== 0) {
				M[node + C.FLAGS] = C.K_COMPUTED | C.MUTABLE | C.DIRTY
				disposeAllDepsInReverse(node)
			}
		} else if (flags & C.K_SIGNAL) {
			// Nothing to do for signals.
		} else if (flags & (C.K_EFFECT | C.K_SCOPE)) {
			dispose(node)
		}
	}

	// Upstream's HasChildEffect slow path in updateComputed/run: unlink every
	// dep that is not a signal/computed (i.e. child effects/scopes), in reverse.
	function unlinkChildEffects(sub: number): void {
		let cur = M[sub + C.DEPS_TAIL]
		while (cur !== 0) {
			const prev = M[cur + C.PREV_DEP]
			const dep = M[cur + C.DEP]
			if (!(M[dep + C.FLAGS] & (C.K_COMPUTED | C.K_SIGNAL))) {
				unlink(cur, sub)
			}
			cur = prev
		}
	}

	function updateComputed(c: number): boolean {
		if (M[c + C.FLAGS] & C.HAS_CHILD_EFFECT) {
			unlinkChildEffects(c)
		}
		M[c + C.DEPS_TAIL] = 0
		M[c + C.FLAGS] = C.K_COMPUTED | C.MUTABLE | C.RECURSED_CHECK
		const prevSub = activeSub
		activeSub = c
		++enterDepth
		try {
			++cycle
			const v = c >> 2
			const oldValue = vals[v]
			return (
				oldValue !== (vals[v] = (fnTab[c >> 3] as (previousValue?: unknown) => unknown)(oldValue))
			)
		} finally {
			--enterDepth
			activeSub = prevSub
			M[c + C.FLAGS] &= ~C.RECURSED_CHECK
			purgeDeps(c)
		}
	}

	function updateSignal(s: number): boolean {
		M[s + C.FLAGS] = C.K_SIGNAL | C.MUTABLE
		const v = s >> 2
		return vals[v] !== (vals[v] = vals[v + 1])
	}

	function run(e: number): void {
		const flags = M[e + C.FLAGS]
		if (flags & C.DIRTY || (flags & C.PENDING && checkDirty(M[e + C.DEPS], e))) {
			if (flags & C.HAS_CHILD_EFFECT) {
				unlinkChildEffects(e)
			}
			const cv = (e >> 2) + 1
			if (vals[cv]) {
				runCleanup(e)
				if (M[e + C.FLAGS] === 0) {
					return // disposed by its own cleanup
				}
			}
			M[e + C.DEPS_TAIL] = 0
			M[e + C.FLAGS] = C.K_EFFECT | C.WATCHING | C.RECURSED_CHECK
			const prevSub = activeSub
			activeSub = e
			++enterDepth
			try {
				++cycle
				++runDepth
				vals[cv] = (fnTab[e >> 3] as () => (() => void) | void)()
			} finally {
				--runDepth
				--enterDepth
				activeSub = prevSub
				M[e + C.FLAGS] &= ~C.RECURSED_CHECK
				purgeDeps(e)
			}
		} else if (M[e + C.DEPS] !== 0) {
			M[e + C.FLAGS] = C.K_EFFECT | C.WATCHING | (flags & C.HAS_CHILD_EFFECT)
		}
	}

	// flush() abort path: re-arm effects still queue after a throw.
	function requeueAbort(e: number): void {
		if (M[e + C.FLAGS] & C.KIND_MASK) {
			M[e + C.FLAGS] |= C.WATCHING | C.RECURSED
		}
	}

	function runCleanup(e: number): void {
		const cv = (e >> 2) + 1
		const cleanup = vals[cv] as () => void
		vals[cv] = undefined
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
		const flags = M[e + C.FLAGS]
		if (!(flags & C.KIND_MASK)) {
			return // already disposed
		}
		M[e + C.FLAGS] = 0
		disposeAllDepsInReverse(e)
		const sub = M[e + C.SUBS]
		if (sub !== 0) {
			unlink(sub)
		}
		if (flags & C.K_EFFECT && vals[(e >> 2) + 1]) {
			runCleanup(e)
		}
		// Deferred reclamation: the queue (or an in-flight walk) may still hold
		// this id; the record is swept back onto the free list at the next
		// operation boundary.
		pendingFree.push(e)
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

	// ---- operations dispatched from the public wrappers ------------------------

	function newSignal(value: unknown): number {
		const id = allocNode(C.K_SIGNAL | C.MUTABLE)
		const v = id >> 2
		vals[v] = value // currentValue
		vals[v + 1] = value // pendingValue
		return id
	}

	function newComputed(getter: (previousValue?: unknown) => unknown): number {
		const id = allocNode(C.K_COMPUTED)
		fnTab[id >> 3] = getter
		return id
	}

	function newEffect(fn: () => (() => void) | void): number {
		const e = allocNode(C.K_EFFECT | C.WATCHING | C.RECURSED_CHECK)
		fnTab[e >> 3] = fn
		const prevSub = activeSub
		activeSub = e
		if (prevSub !== 0) {
			link(e, prevSub, 0)
			M[prevSub + C.FLAGS] |= C.HAS_CHILD_EFFECT
		}
		++enterDepth
		try {
			++runDepth
			vals[(e >> 2) + 1] = fn()
		} finally {
			--runDepth
			--enterDepth
			activeSub = prevSub
			M[e + C.FLAGS] &= ~C.RECURSED_CHECK
		}
		return e
	}

	function newScope(fn: () => void): number {
		const e = allocNode(C.K_SCOPE | C.MUTABLE)
		const prevSub = activeSub
		activeSub = e
		if (prevSub !== 0) {
			link(e, prevSub, 0)
			M[prevSub + C.FLAGS] |= C.HAS_CHILD_EFFECT
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

	// signalOper read path.
	function read(s: number): unknown {
		if (currentWorld !== 0) {
			return worldRead(s)
		} // SPK-Q routing branch (atom read)
		if (M[s + C.FLAGS] & C.DIRTY) {
			if (updateSignal(s)) {
				const subs = M[s + C.SUBS]
				if (subs !== 0) {
					shallowPropagate(subs)
				}
			}
		}
		if (activeSub !== 0) {
			link(s, activeSub, cycle)
		}
		return vals[s >> 2]
	}

	// signalOper write path; the WRAPPER flushes (iff this returns true), so
	// growth can happen between queue effects at the top level (upstream
	// flushes inline here, only when the changed signal had subscribers).
	function write(s: number, value: unknown): boolean {
		const p = (s >> 2) + 1
		if (vals[p] !== (vals[p] = value)) {
			M[s + C.FLAGS] = C.K_SIGNAL | C.MUTABLE | C.DIRTY
			const subs = M[s + C.SUBS]
			if (subs !== 0) {
				propagate(subs, runDepth !== 0)
				return true
			}
		}
		return false
	}

	// computedOper.
	function computedRead(c: number): unknown {
		if (currentWorld !== 0) {
			return worldRead(c)
		} // SPK-Q routing branch (computed read)
		const flags = M[c + C.FLAGS]
		if (
			flags & C.DIRTY ||
			(flags & C.PENDING &&
				(checkDirty(M[c + C.DEPS], c) || ((M[c + C.FLAGS] = flags & ~C.PENDING), false)))
		) {
			if (updateComputed(c)) {
				const subs = M[c + C.SUBS]
				if (subs !== 0) {
					shallowPropagate(subs)
				}
			}
		} else if (flags === C.K_COMPUTED) {
			// upstream `!flags`: never evaluated
			M[c + C.FLAGS] = C.K_COMPUTED | C.MUTABLE | C.RECURSED_CHECK
			const prevSub = activeSub
			activeSub = c
			++enterDepth
			try {
				vals[c >> 2] = (fnTab[c >> 3] as () => unknown)()
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
		return vals[c >> 2]
	}
}

// ---- engine instance + growth ------------------------------------------------

const initialRecords = (() => {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
		?.env?.ARENA_INITIAL_RECORDS
	const n = env !== undefined ? Number(env) : NaN
	return Number.isFinite(n) && n >= 2 ? Math.ceil(n) : 1 << 20
})()

// Footprint parity with the old split planes (initialRecords node records +
// 2x initialRecords link records): 3x initialRecords shared records.
let E: Engine = createEngine(initialRecords * 3)

function maybeBoundary(): void {
	if (enterDepth === 0 && (growPending || pendingFree.length !== 0)) {
		boundaryWork()
	}
}

function boundaryWork(): void {
	// Sweep only while the effect queue is empty: an un-flushed queue (e.g. a
	// read's shallowPropagate notified an effect after the last flush) may
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
	// effects. Safe because (a) all user code during flush runs at
	// enterDepth >= 1, so E cannot be swapped mid-loop (the `engine` hoist is
	// sound), and (b) the watermark guarantees >= C.REC_SLACK (1280) free records
	// at flush start while cascade re-runs re-track through the link() fast
	// path / free lists (net new records per flush audited at ~tens across the
	// conformance suite and shapes workloads; a pathological cascade that
	// out-allocates the whole remaining plane throws in the allocator rather
	// than corrupting in-flight walks).
	maybeBoundary()
	const engine = E
	const queue = queued // function-scope alias survives bundling (see createEngine note)
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
	return function (...value: [T?]) {
		if (value.length) {
			maybeBoundary()
			if (E.write(id, value[0]) && !batchDepth) {
				flush()
			}
		} else {
			return E.read(id) as T | undefined
		}
	} as SignalHandle<T | undefined>
}

export function computed<T>(getter: (previousValue?: T) => T): () => T {
	maybeBoundary()
	const id = E.newComputed(getter as (previousValue?: unknown) => unknown)
	// No maybeBoundary on the read path: top-level first-eval read sequences
	// allocate well under C.REC_SLACK between the surrounding safe-points (see
	// flush() audit note); steady-state reads allocate nothing.
	return () => E.computedRead(id) as T
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
