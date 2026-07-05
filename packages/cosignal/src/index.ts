/**
 * cosignal v1 — DIRECT build (spec/cosignal-v1.md).
 *
 * This file has four layers, top to bottom:
 *
 *   1. Sentinels — the policy-level error/suspension carriers (SuspendedRead,
 *      CycleError, SentinelBox). Reference-stable boxes cached as ordinary
 *      kernel values; read sites unbox and rethrow.
 *   2. The evaluation context — the ONE `ctx` object every computed function
 *      receives (`ctx.previous`, `ctx.use`), delegating to hoisted policy
 *      functions so the kernel can pass it with zero per-recompute setup.
 *   3. K0, the kernel — the proven donor arena copied from libs/arena
 *      (alien-signals v3.2.1 on interleaved Int32Array records; 179/179
 *      conformance). Its walk structure, flag ladder, link/linkInsert split,
 *      closure-const buffers, scratch-stack discipline, and growth machinery
 *      are preserved verbatim. Deltas from the donor are enumerated below.
 *   4. The policy layer — Atom / ReducerAtom / Computed classes, effect(),
 *      batch(), untracked(), configure(); custom equality by
 *      wrapper-returns-old-reference; errors/suspensions as sentinel boxes;
 *      the observed lifecycle (AtomOptions.effect) with microtask flap
 *      damping; fold-purity and writes-in-computeds disciplines.
 *
 * ─── THE OPERATION-TABLE SEAM ────────────────────────────────────────────────
 *
 * The `Engine` record returned by `createEngine` IS the operation table of
 * spec §5.1: every public operation routes through the module-level binding
 * `E` (`E.read`, `E.write`, `E.computedRead`, …), and `E` is only ever
 * replaced at an operation boundary via closure rebuild — exactly the donor's
 * growth mechanism (`boundaryWork` → `engineFactory(records, carry)`).
 *
 * In this DIRECT build the table is statically wired: `engineFactory` is a
 * `const` bound to `createEngine` (the donor/DIRECT table), no other table
 * exists, and no overlay code is imported — a bundle of this file contains
 * zero concurrency instructions (the spec's CI symbol diff has nothing to
 * find). The LOGGED build is the twin bundle of spec §7: it shares these
 * kernel bytes but binds `engineFactory` as a `let` initialized to
 * `createEngine`, and its `registerReactBridge()` — a separate entry point,
 * never imported here — asserts `enterDepth === 0` (no open evaluation/fold/
 * walk frame, spec §3.6), re-points `engineFactory` at the logged factory
 * (same `Engine` shape; `write`/`read`/`computedRead` additionally append
 * receipts, run the marking and delivery walks, and route non-newest reads),
 * then rebuilds `E` exactly once over the carried buffers. Growth thereafter
 * rebuilds through the same binding, so the swap is one assignment plus one
 * closure rebuild at an operation boundary — the donor's own growth pattern.
 * All shared mutable state a rebuilt table needs (scalar heads, side columns,
 * queue, scratch stacks) already lives at module level for exactly this
 * reason; nothing else in the kernel or the policy layer is table-aware.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Kernel deltas vs libs/arena/src/index.ts (each is policy plumbing at a cold
 * site; the hot walks are untouched — measured ≈parity on tier-0 shapes):
 *
 *   D1. Node field 6 (spare in the donor) is `C.LIFECYCLE`: a 0/1 flag set at
 *       creation for atoms carrying an observed-lifecycle effect. Checked
 *       only in linkInsert's first-subscriber branch and in unwatched()'s
 *       signal branch; cleared in freeNode.
 *   D2. computedRead throws CycleError when the computed is re-entered during
 *       its own evaluation (spec §3.6 per-world cycle detection; one flags
 *       test on the already-loaded flags word).
 *   D3. Computed getters in `fns` take the policy evaluation context as their
 *       one argument (the donor passed `previousValue`; `ctx.previous` now
 *       reads the cache live via `activeSub`, so plain computeds pay ZERO
 *       policy instructions per recompute), and the two kernel eval sites
 *       (updateComputed, computedRead's first-eval branch) box exceptions via
 *       the cold `boxThrown` catch hook — a throwing getter never corrupts
 *       graph state, and the kernel value slot then holds a SentinelBox
 *       (flagged HAS_BOX; unboxed by the cold boxedRead read tail).
 *       computedRead is split hot/slow like the donor's link/linkInsert: the
 *       D2+D3 additions pushed the monolith past V8's 460-byte inline cliff,
 *       and the outlined form measures FASTER than the donor on read shapes.
 *   D4. A computed's aux value slot — `values[(id >> 2) + 1]`, the donor's
 *       "signal pending value OR effect cleanup" column, unused for
 *       computeds — holds the owning `Computed` instance (policy state for
 *       boxes and ctx.use slots; same packed side column, no extra map).
 *   D5. Engine gains cold policy ops: invalidateComputed (settlement-
 *       invalidate), markLifecycle (D1), activeIsComputed (the
 *       forbidWritesInComputeds check).
 *   D6. Env var is COSIGNAL_INITIAL_RECORDS; configure({initialRecords})
 *       feeds the same growth machinery through `desiredRecords`.
 *   D7. The donor's closure-handle public API (signal()/computed()) is
 *       replaced by the class layer; effect/effectScope/batch/untracked keep
 *       the donor wrappers.
 *
 * Everything else — GROWTH (closure rebuild over doubled buffers, swap at
 * operation boundaries only) and RECLAMATION (deferred free of disposed
 * effect/scope records; signal/computed records are owned by their handles
 * and are not reclaimed) — is donor behavior, documented in libs/arena.
 */

// ---- sentinels ----------------------------------------------------------------

/**
 * Thrown when a read observes a pending suspension: by `ctx.use` inside a
 * computed evaluation, and by read sites whose computed's cached result is a
 * suspended box. Carries the pending thenable. (Future React bindings catch
 * it at render read sites and forward to Suspense.)
 */
export class SuspendedRead {
	readonly thenable: PromiseLike<unknown>;
	constructor(thenable: PromiseLike<unknown>) {
		this.thenable = thenable;
	}
}

/** Thrown on per-world cycle detection (spec §3.6). */
export class CycleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CycleError';
	}
}

// SentinelBox kinds.
const BOX_ERROR = 0;
const BOX_SUSPENDED = 1;

/**
 * Reference-stable sentinel cached as the computed's kernel value when its
 * evaluation throws (BOX_ERROR, payload = the thrown value) or suspends
 * (BOX_SUSPENDED, payload = the pending thenable). The kernel compares
 * identity only, so a re-evaluation that produces the same payload returns
 * the PREVIOUS box and downstream sees no change; a different payload mints a
 * new box and propagates. Read sites unbox: errors rethrow the payload,
 * suspensions throw the box's stable SuspendedRead.
 */
class SentinelBox {
	readonly kind: number;
	readonly payload: unknown;
	/** Stable per box, minted for suspended boxes only. */
	readonly sr: SuspendedRead | undefined;
	constructor(kind: number, payload: unknown, sr?: SuspendedRead) {
		this.kind = kind;
		this.payload = payload;
		this.sr = sr;
	}
}

/**
 * Box detection never uses `instanceof` on a hot path (measured ~9ns per
 * `instanceof` there — 2.4× on read-heavy shapes). Reads route on the
 * kernel's HAS_BOX flag; the policy-side compares (ctx.previous, the isEqual
 * wrapper, boxThrown's identity check) are single pointer compares against
 * the Computed's `_box` mirror, where NO_BOX (a sentinel no evaluation ever
 * returns) means "no box" with no undefined ambiguity. The mirror invariant
 * is one-sided — if the value slot holds a box, `_box` equals it — maintained
 * by `boxThrown`, the only producer of boxes; a later successful evaluation
 * may leave `_box` pointing at a dead box, which is harmless (the compare
 * simply fails against the new plain value).
 */
const NO_BOX = new SentinelBox(BOX_ERROR, undefined);

// ---- the evaluation context ----------------------------------------------------

export type ComputedCtx<T> = {
	/**
	 * The computed's last committed value (a hint; spec §3.4: no identity,
	 * recency, or per-world determinism is guaranteed — the function must be
	 * correct if `previous` were arbitrarily stale or undefined). In DIRECT
	 * mode: the cached value, read live; undefined on first evaluation and
	 * while the cache holds an error/suspension sentinel.
	 */
	readonly previous: T | undefined;
	/**
	 * Reads a thenable inside a computed. Fulfilled: returns the value.
	 * Rejected: throws the reason. Pending: suspends the computed — read
	 * sites observe a stable SuspendedRead until the thenable settles, and
	 * settlement invalidates the computed. The lazy factory form is preferred
	 * (the factory is not called while the slot's previous thenable is
	 * pending); the eager form guarantees identity stability only.
	 */
	use<V>(source: PromiseLike<V> | (() => PromiseLike<V>)): V;
};

/**
 * The ONE evaluation context, passed by the kernel to every computed getter
 * as its argument (D3). Its members delegate to hoisted policy functions
 * (defined in the policy layer below) that resolve the evaluating node from
 * the kernel's `activeSub`, so no per-recompute state setup exists at all.
 */
const POLICY_CTX: ComputedCtx<unknown> = {
	get previous(): unknown {
		return ctxPrevious();
	},
	use<V>(source: PromiseLike<V> | (() => PromiseLike<V>)): V {
		return ctxUse(source as PromiseLike<unknown> | (() => PromiseLike<unknown>)) as V;
	},
};

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
	LIFECYCLE = 6, // D1: 1 iff the node is an atom with an observed-lifecycle effect
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
	// D3: the computed's cached value is a sentinel box. Set exactly at the
	// two kernel catch sites (with boxThrown); cleared for free by the
	// eval-start flag rewrite in updateComputed/first-eval — every other flag
	// site either ORs bits or is followed by a forced recompute (unwatched
	// sets DIRTY), so a stale clear can never serve a box unboxed.
	HAS_BOX = 2048,

	// Min free records guaranteed at each op boundary. Nodes and links draw
	// from one shared pool; the old split-plane budget (256 node + 1024 link
	// records) is preserved as its sum, so any allocation pattern that fit the
	// old per-plane slack still fits the merged slack.
	REC_SLACK = 1280,
}

// ---- shared mutable state (survives engine rebuilds) ------------------------
// Scalar heads/counters live at module level so a rebuilt engine resumes
// exactly where the old one stopped; only the buffer bindings live in the
// engine closure. (This is also what lets the LOGGED table rebuild at the
// seam without copying anything but the plane.)
let recNext = 8; // bump pointer, shared by nodes and links (record 0 burned)
let nodeFreeHead = 0; // free list threaded through M[id + C.DEPS]
let linkFreeHead = 0; // free list threaded through M[id + C.NEXT_DEP]
let growPending = false;

let cycle = 0;
let runDepth = 0;
let batchDepth = 0;
let notifyIndex = 0;
let queuedLength = 0;
let activeSub = 0;
let enterDepth = 0; // live engine frames that captured M; 0 = op boundary

const queued: number[] = [];
const pendingFree: number[] = []; // disposed effect/scope records awaiting sweep

// Side columns, indexed off the id: values[id >> 2] = current/computed value,
// values[(id >> 2) + 1] = signal pending value OR effect cleanup fn OR the
// computed's owning Computed instance (D4), fns[id >> 3] = computed getter /
// effect fn. Plain arrays grown by push (stays PACKED; plain-array growth has
// no binding problem). The policy layer reads these columns directly — they
// are shared state like the scalar heads, not operations.
const values: unknown[] = [undefined, undefined];
const fns: (Function | undefined)[] = [undefined];

// Persistent scratch stacks (upstream's cons-cell Stack<T>). Re-entrant
// walks push above the caller's base and restore it on exit.
let propStack = new Int32Array(4096);
let propSp = 0;
let checkStack = new Int32Array(4096);
let checkSp = 0;

// ---- the engine (the operation table) -----------------------------------------

interface Engine {
	records: number;
	buffer(): Int32Array;
	newSignal(value: unknown): number;
	newComputed(getter: (ctx: unknown) => unknown): number;
	newEffect(fn: () => (() => void) | void): number;
	newScope(fn: () => void): number;
	gen(id: number): number;
	read(s: number): unknown;
	write(s: number, value: unknown): boolean;
	computedRead(c: number): unknown;
	run(e: number): void;
	requeueAbort(e: number): void;
	dispose(e: number): void;
	sweepPendingFree(): void;
	// D5: cold policy ops (never called from the hot walks).
	/** Marks a computed stale and propagates to its subs (settlement-invalidate). */
	invalidateComputed(c: number): boolean;
	/** D1: flags the node for observed-lifecycle delivery. */
	markLifecycle(id: number): void;
	/** True iff the currently-evaluating subscriber is a computed. */
	activeIsComputed(): boolean;
}

function createEngine(records: number, carry?: Int32Array): Engine {
	const M = new Int32Array(records * 8);
	// Bundler-proof aliases for the module-level side arrays: esbuild
	// bundling demotes module-scope `const` to mutable `var`, so TurboFan
	// loses their constant-folding at module scope; a function-scope const
	// is preserved verbatim and folds via the same one-closure-cell context
	// specialization that embeds M.
	const vals = values;
	const fnTab = fns;
	const queue = queued;
	const evalCtx = POLICY_CTX;
	if (carry !== undefined) {
		M.set(carry);
	}
	// Allocators flag growth once the bump pointer crosses the watermark:
	// keep at least C.REC_SLACK records AND half the plane free at every boundary.
	const WM = Math.min(M.length >> 1, M.length - C.REC_SLACK * 8);
	if (recNext > WM) {
		growPending = true;
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
		invalidateComputed,
		markLifecycle: (id) => {
			M[id + C.LIFECYCLE] = 1;
		},
		activeIsComputed: () => activeSub !== 0 && (M[activeSub + C.FLAGS] & C.K_COMPUTED) !== 0,
	};

	// ---- allocation ----------------------------------------------------------

	function allocNode(flags: number): number {
		let id: number;
		if (nodeFreeHead !== 0) {
			id = nodeFreeHead;
			nodeFreeHead = M[id + C.DEPS];
			M[id + C.DEPS] = 0;
		} else {
			id = recNext;
			if (id >= M.length) {
				throw new Error('cosignal: arena exhausted mid-operation; raise COSIGNAL_INITIAL_RECORDS');
			}
			recNext = id + 8;
			if (recNext > WM) {
				growPending = true;
			}
		}
		M[id + C.FLAGS] = flags;
		const v = id >> 2;
		while (vals.length <= v + 1) {
			vals.push(undefined);
		}
		while (fnTab.length <= id >> 3) {
			fnTab.push(undefined);
		}
		return id;
	}

	function freeNode(id: number): void {
		M[id + C.FLAGS] = 0;
		M[id + C.DEPS_TAIL] = 0;
		M[id + C.SUBS] = 0;
		M[id + C.SUBS_TAIL] = 0;
		M[id + C.LIFECYCLE] = 0; // D1
		++M[id + C.GEN];
		const v = id >> 2;
		vals[v] = undefined;
		vals[v + 1] = undefined;
		fnTab[id >> 3] = undefined;
		M[id + C.DEPS] = nodeFreeHead;
		nodeFreeHead = id;
	}

	function sweepPendingFree(): void {
		for (let i = 0; i < pendingFree.length; ++i) {
			freeNode(pendingFree[i]);
		}
		pendingFree.length = 0;
	}

	function allocLink(): number {
		let id: number;
		if (linkFreeHead !== 0) {
			id = linkFreeHead;
			linkFreeHead = M[id + C.NEXT_DEP];
		} else {
			id = recNext;
			if (id >= M.length) {
				throw new Error('cosignal: arena exhausted mid-operation; raise COSIGNAL_INITIAL_RECORDS');
			}
			recNext = id + 8;
			if (recNext > WM) {
				growPending = true;
			}
		}
		return id;
	}

	function freeLink(id: number): void {
		M[id + C.NEXT_DEP] = linkFreeHead;
		linkFreeHead = id;
	}

	// ---- system.ts transliteration -------------------------------------------

	function link(dep: number, sub: number, version: number): void {
		const prevDep = M[sub + C.DEPS_TAIL];
		if (prevDep !== 0 && M[prevDep + C.DEP] === dep) {
			return;
		}
		const nextDep = prevDep !== 0 ? M[prevDep + C.NEXT_DEP] : M[sub + C.DEPS];
		if (nextDep !== 0 && M[nextDep + C.DEP] === dep) {
			M[nextDep + C.VERSION] = version;
			M[sub + C.DEPS_TAIL] = nextDep;
			return;
		}
		linkInsert(dep, sub, version, prevDep, nextDep);
	}

	// Insertion tail of link(): kept out of line so the steady-state re-track
	// fast path above stays under V8's inlining bytecode budget (upstream
	// monolithic link() was 475 bytecodes — kExceedsBytecodeLimit — and never
	// inlined into the read paths despite running on every tracked read).
	function linkInsert(dep: number, sub: number, version: number, prevDep: number, nextDep: number): void {
		const prevSub = M[dep + C.SUBS_TAIL];
		if (prevSub !== 0 && M[prevSub + C.VERSION] === version && M[prevSub + C.SUB] === sub) {
			return;
		}
		const newLink = allocLink();
		M[sub + C.DEPS_TAIL] = newLink;
		M[dep + C.SUBS_TAIL] = newLink;
		M[newLink + C.VERSION] = version;
		M[newLink + C.DEP] = dep;
		M[newLink + C.SUB] = sub;
		M[newLink + C.PREV_DEP] = prevDep;
		M[newLink + C.NEXT_DEP] = nextDep;
		M[newLink + C.PREV_SUB] = prevSub;
		M[newLink + C.NEXT_SUB] = 0;
		if (nextDep !== 0) {
			M[nextDep + C.PREV_DEP] = newLink;
		}
		if (prevDep !== 0) {
			M[prevDep + C.NEXT_DEP] = newLink;
		} else {
			M[sub + C.DEPS] = newLink;
		}
		if (prevSub !== 0) {
			M[prevSub + C.NEXT_SUB] = newLink;
		} else {
			M[dep + C.SUBS] = newLink;
			// D1: first subscriber attached — the liveness bit flips 0→1.
			if (M[dep + C.LIFECYCLE] !== 0) {
				lifecycleWatched(dep);
			}
		}
	}

	function unlink(id: number, sub = M[id + C.SUB]): number {
		const dep = M[id + C.DEP];
		const prevDep = M[id + C.PREV_DEP];
		const nextDep = M[id + C.NEXT_DEP];
		const nextSub = M[id + C.NEXT_SUB];
		const prevSub = M[id + C.PREV_SUB];
		if (nextDep !== 0) {
			M[nextDep + C.PREV_DEP] = prevDep;
		} else {
			M[sub + C.DEPS_TAIL] = prevDep;
		}
		if (prevDep !== 0) {
			M[prevDep + C.NEXT_DEP] = nextDep;
		} else {
			M[sub + C.DEPS] = nextDep;
		}
		if (nextSub !== 0) {
			M[nextSub + C.PREV_SUB] = prevSub;
		} else {
			M[dep + C.SUBS_TAIL] = prevSub;
		}
		freeLink(id);
		if (prevSub !== 0) {
			M[prevSub + C.NEXT_SUB] = nextSub;
		} else if ((M[dep + C.SUBS] = nextSub) === 0) {
			unwatched(dep);
		}
		return nextDep;
	}

	function propagate(startLink: number, innerWrite: boolean): void {
		// No try/finally: propagate never runs user code (notify only queues),
		// so it cannot throw and always drains the stack back to its base.
		let cur = startLink;
		let next = M[cur + C.NEXT_SUB];
		const stackBase = propSp;

		top: do {
			const sub = M[cur + C.SUB];
			let flags = M[sub + C.FLAGS];

			if (!(flags & (C.RECURSED_CHECK | C.RECURSED | C.DIRTY | C.PENDING))) {
				M[sub + C.FLAGS] = flags | C.PENDING;
				if (innerWrite) {
					M[sub + C.FLAGS] |= C.RECURSED;
				}
			} else if (!(flags & (C.RECURSED_CHECK | C.RECURSED))) {
				flags = 0;
			} else if (!(flags & C.RECURSED_CHECK)) {
				M[sub + C.FLAGS] = (flags & ~C.RECURSED) | C.PENDING;
			} else if (!(flags & (C.DIRTY | C.PENDING)) && isValidLink(cur, sub)) {
				M[sub + C.FLAGS] = flags | (C.RECURSED | C.PENDING);
				flags &= C.MUTABLE;
			} else {
				flags = 0;
			}

			if (flags & C.WATCHING) {
				notify(sub);
			}

			if (flags & C.MUTABLE) {
				const subSubs = M[sub + C.SUBS];
				if (subSubs !== 0) {
					cur = subSubs;
					const nextSub = M[cur + C.NEXT_SUB];
					if (nextSub !== 0) {
						if (propSp === propStack.length) {
							const bigger = new Int32Array(propStack.length * 2);
							bigger.set(propStack);
							propStack = bigger;
						}
						propStack[propSp++] = next;
						next = nextSub;
					}
					continue;
				}
			}

			if ((cur = next) !== 0) {
				next = M[cur + C.NEXT_SUB];
				continue;
			}

			while (propSp > stackBase) {
				cur = propStack[--propSp];
				if (cur !== 0) {
					next = M[cur + C.NEXT_SUB];
					continue top;
				}
			}

			break;
		} while (true);
	}

	function checkDirty(startLink: number, startSub: number): boolean {
		let cur = startLink;
		let sub = startSub;
		const stackBase = checkSp;
		let checkDepth = 0;
		let dirty = false;

		try {
			top: do {
				const dep = M[cur + C.DEP];
				const depFlags = M[dep + C.FLAGS];

				if (M[sub + C.FLAGS] & C.DIRTY) {
					dirty = true;
				} else if ((depFlags & (C.MUTABLE | C.DIRTY)) === (C.MUTABLE | C.DIRTY)) {
					const depSubs = M[dep + C.SUBS];
					if (update(dep)) {
						if (M[depSubs + C.NEXT_SUB] !== 0) {
							shallowPropagate(depSubs);
						}
						dirty = true;
					}
				} else if ((depFlags & (C.MUTABLE | C.PENDING)) === (C.MUTABLE | C.PENDING)) {
					if (checkSp === checkStack.length) {
						const bigger = new Int32Array(checkStack.length * 2);
						bigger.set(checkStack);
						checkStack = bigger;
					}
					checkStack[checkSp++] = cur;
					cur = M[dep + C.DEPS];
					sub = dep;
					++checkDepth;
					continue;
				}

				if (!dirty) {
					const nextDep = M[cur + C.NEXT_DEP];
					if (nextDep !== 0) {
						cur = nextDep;
						continue;
					}
				}

				while (checkDepth--) {
					cur = checkStack[--checkSp];
					if (dirty) {
						const subSubs = M[sub + C.SUBS];
						if (update(sub)) {
							if (M[subSubs + C.NEXT_SUB] !== 0) {
								shallowPropagate(subSubs);
							}
							sub = M[cur + C.SUB];
							continue;
						}
						dirty = false;
					} else {
						M[sub + C.FLAGS] &= ~C.PENDING;
					}
					sub = M[cur + C.SUB];
					const nextDep = M[cur + C.NEXT_DEP];
					if (nextDep !== 0) {
						cur = nextDep;
						continue top;
					}
				}

				// Upstream: `dirty && !!sub.flags` — a live node always has its
				// kind bits set; flags reads 0 only if sub was disposed (record
				// zeroed) by re-entrant user code during update().
				return dirty && M[sub + C.FLAGS] !== 0;
			} while (true);
		} finally {
			checkSp = stackBase;
		}
	}

	function shallowPropagate(startLink: number): void {
		let cur = startLink;
		do {
			const sub = M[cur + C.SUB];
			const flags = M[sub + C.FLAGS];
			if ((flags & (C.PENDING | C.DIRTY)) === C.PENDING) {
				M[sub + C.FLAGS] = flags | C.DIRTY;
				if ((flags & (C.WATCHING | C.RECURSED_CHECK)) === C.WATCHING) {
					notify(sub);
				}
			}
		} while ((cur = M[cur + C.NEXT_SUB]) !== 0);
	}

	function isValidLink(checkLink: number, sub: number): boolean {
		let cur = M[sub + C.DEPS_TAIL];
		while (cur !== 0) {
			if (cur === checkLink) {
				return true;
			}
			cur = M[cur + C.PREV_DEP];
		}
		return false;
	}

	// ---- index.ts transliteration ---------------------------------------------

	function update(node: number): boolean {
		const flags = M[node + C.FLAGS];
		if (flags & C.K_COMPUTED) {
			return updateComputed(node);
		}
		if (flags & C.K_SIGNAL) {
			return updateSignal(node);
		}
		M[node + C.FLAGS] = (flags & C.KIND_MASK) | C.MUTABLE;
		return true;
	}

	function notify(e: number): void {
		let insertIndex = queuedLength;
		const firstInsertedIndex = insertIndex;

		do {
			queue[insertIndex++] = e;
			M[e + C.FLAGS] &= ~C.WATCHING;
			const subs = M[e + C.SUBS];
			e = subs !== 0 ? M[subs + C.SUB] : 0;
			if (e === 0 || !(M[e + C.FLAGS] & C.WATCHING)) {
				break;
			}
		} while (true);

		queuedLength = insertIndex;

		// The parent chain was appended child-first: reverse the inserted
		// segment in place so outer effects run before inner.
		let left = firstInsertedIndex;
		while (left < --insertIndex) {
			const tmp = queue[left];
			queue[left++] = queue[insertIndex];
			queue[insertIndex] = tmp;
		}
	}

	function unwatched(node: number): void {
		const flags = M[node + C.FLAGS];
		if (flags & C.K_COMPUTED) {
			if (M[node + C.DEPS_TAIL] !== 0) {
				M[node + C.FLAGS] = C.K_COMPUTED | C.MUTABLE | C.DIRTY;
				disposeAllDepsInReverse(node);
			}
		} else if (flags & C.K_SIGNAL) {
			// D1: last subscriber detached — the liveness bit flips 1→0.
			if (M[node + C.LIFECYCLE] !== 0) {
				lifecycleUnwatched(node);
			}
		} else if (flags & (C.K_EFFECT | C.K_SCOPE)) {
			dispose(node);
		}
	}

	// Upstream's HasChildEffect slow path in updateComputed/run: unlink every
	// dep that is not a signal/computed (i.e. child effects/scopes), in reverse.
	function unlinkChildEffects(sub: number): void {
		let cur = M[sub + C.DEPS_TAIL];
		while (cur !== 0) {
			const prev = M[cur + C.PREV_DEP];
			const dep = M[cur + C.DEP];
			if (!(M[dep + C.FLAGS] & (C.K_COMPUTED | C.K_SIGNAL))) {
				unlink(cur, sub);
			}
			cur = prev;
		}
	}

	function updateComputed(c: number): boolean {
		if (M[c + C.FLAGS] & C.HAS_CHILD_EFFECT) {
			unlinkChildEffects(c);
		}
		M[c + C.DEPS_TAIL] = 0;
		M[c + C.FLAGS] = C.K_COMPUTED | C.MUTABLE | C.RECURSED_CHECK;
		const prevSub = activeSub;
		activeSub = c;
		++enterDepth;
		const v = c >> 2;
		const oldValue = vals[v];
		try {
			++cycle;
			return oldValue !== (vals[v] = (fnTab[c >> 3] as (ctx: unknown) => unknown)(evalCtx));
		} catch (e) {
			// D3: a throwing getter never corrupts graph state — the exception
			// becomes a reference-stable sentinel box in the value slot (cold).
			vals[v] = boxThrown(c, e, oldValue);
			M[c + C.FLAGS] |= C.HAS_BOX;
			return oldValue !== vals[v];
		} finally {
			--enterDepth;
			activeSub = prevSub;
			M[c + C.FLAGS] &= ~C.RECURSED_CHECK;
			purgeDeps(c);
		}
	}

	function updateSignal(s: number): boolean {
		M[s + C.FLAGS] = C.K_SIGNAL | C.MUTABLE;
		const v = s >> 2;
		return vals[v] !== (vals[v] = vals[v + 1]);
	}

	function run(e: number): void {
		const flags = M[e + C.FLAGS];
		if (
			flags & C.DIRTY
			|| (flags & C.PENDING && checkDirty(M[e + C.DEPS], e))
		) {
			if (flags & C.HAS_CHILD_EFFECT) {
				unlinkChildEffects(e);
			}
			const cv = (e >> 2) + 1;
			if (vals[cv]) {
				runCleanup(e);
				if (M[e + C.FLAGS] === 0) {
					return; // disposed by its own cleanup
				}
			}
			M[e + C.DEPS_TAIL] = 0;
			M[e + C.FLAGS] = C.K_EFFECT | C.WATCHING | C.RECURSED_CHECK;
			const prevSub = activeSub;
			activeSub = e;
			++enterDepth;
			try {
				++cycle;
				++runDepth;
				vals[cv] = (fnTab[e >> 3] as () => (() => void) | void)();
			} finally {
				--runDepth;
				--enterDepth;
				activeSub = prevSub;
				M[e + C.FLAGS] &= ~C.RECURSED_CHECK;
				purgeDeps(e);
			}
		} else if (M[e + C.DEPS] !== 0) {
			M[e + C.FLAGS] = C.K_EFFECT | C.WATCHING | (flags & C.HAS_CHILD_EFFECT);
		}
	}

	// flush() abort path: re-arm effects still queue after a throw.
	function requeueAbort(e: number): void {
		if (M[e + C.FLAGS] & C.KIND_MASK) {
			M[e + C.FLAGS] |= C.WATCHING | C.RECURSED;
		}
	}

	function runCleanup(e: number): void {
		const cv = (e >> 2) + 1;
		const cleanup = vals[cv] as () => void;
		vals[cv] = undefined;
		const prevSub = activeSub;
		activeSub = 0;
		++enterDepth;
		try {
			cleanup();
		} finally {
			--enterDepth;
			activeSub = prevSub;
		}
	}

	// effectOper + effectScopeOper: dispose an effect (runs cleanup) or scope.
	function dispose(e: number): void {
		const flags = M[e + C.FLAGS];
		if (!(flags & C.KIND_MASK)) {
			return; // already disposed
		}
		M[e + C.FLAGS] = 0;
		disposeAllDepsInReverse(e);
		const sub = M[e + C.SUBS];
		if (sub !== 0) {
			unlink(sub);
		}
		if (flags & C.K_EFFECT && vals[(e >> 2) + 1]) {
			runCleanup(e);
		}
		// Deferred reclamation: the queue (or an in-flight walk) may still hold
		// this id; the record is swept back onto the free list at the next
		// operation boundary.
		pendingFree.push(e);
	}

	function disposeAllDepsInReverse(sub: number): void {
		let cur = M[sub + C.DEPS_TAIL];
		while (cur !== 0) {
			const prev = M[cur + C.PREV_DEP];
			unlink(cur, sub);
			cur = prev;
		}
	}

	function purgeDeps(sub: number): void {
		const depsTail = M[sub + C.DEPS_TAIL];
		let dep = depsTail !== 0 ? M[depsTail + C.NEXT_DEP] : M[sub + C.DEPS];
		while (dep !== 0) {
			dep = unlink(dep, sub);
		}
	}

	// ---- operations dispatched from the public wrappers ------------------------

	function newSignal(value: unknown): number {
		const id = allocNode(C.K_SIGNAL | C.MUTABLE);
		const v = id >> 2;
		vals[v] = value; // currentValue
		vals[v + 1] = value; // pendingValue
		return id;
	}

	function newComputed(getter: (ctx: unknown) => unknown): number {
		const id = allocNode(C.K_COMPUTED);
		fnTab[id >> 3] = getter;
		return id;
	}

	function newEffect(fn: () => (() => void) | void): number {
		const e = allocNode(C.K_EFFECT | C.WATCHING | C.RECURSED_CHECK);
		fnTab[e >> 3] = fn;
		const prevSub = activeSub;
		activeSub = e;
		if (prevSub !== 0) {
			link(e, prevSub, 0);
			M[prevSub + C.FLAGS] |= C.HAS_CHILD_EFFECT;
		}
		++enterDepth;
		try {
			++runDepth;
			vals[(e >> 2) + 1] = fn();
		} finally {
			--runDepth;
			--enterDepth;
			activeSub = prevSub;
			M[e + C.FLAGS] &= ~C.RECURSED_CHECK;
		}
		return e;
	}

	function newScope(fn: () => void): number {
		const e = allocNode(C.K_SCOPE | C.MUTABLE);
		const prevSub = activeSub;
		activeSub = e;
		if (prevSub !== 0) {
			link(e, prevSub, 0);
			M[prevSub + C.FLAGS] |= C.HAS_CHILD_EFFECT;
		}
		++enterDepth;
		try {
			fn();
		} finally {
			--enterDepth;
			activeSub = prevSub;
		}
		return e;
	}

	// signalOper read path.
	function read(s: number): unknown {
		if (M[s + C.FLAGS] & C.DIRTY) {
			if (updateSignal(s)) {
				const subs = M[s + C.SUBS];
				if (subs !== 0) {
					shallowPropagate(subs);
				}
			}
		}
		if (activeSub !== 0) {
			link(s, activeSub, cycle);
		}
		return vals[s >> 2];
	}

	// signalOper write path; the WRAPPER flushes (iff this returns true), so
	// growth can happen between queue effects at the top level (upstream
	// flushes inline here, only when the changed signal had subscribers).
	function write(s: number, value: unknown): boolean {
		const p = (s >> 2) + 1;
		if (vals[p] !== (vals[p] = value)) {
			M[s + C.FLAGS] = C.K_SIGNAL | C.MUTABLE | C.DIRTY;
			const subs = M[s + C.SUBS];
			if (subs !== 0) {
				propagate(subs, runDepth !== 0);
				return true;
			}
		}
		return false;
	}

	// computedOper — clean-read fast path. Split from the recompute ladder the
	// same way link/linkInsert is split: the donor's monolithic body plus the
	// D2/D3 deltas sits at 448+ bytecodes, past V8's 460-byte inline cliff
	// (measured: falling off costs ~2.5ns on every clean read). One combined
	// mask test routes every non-trivial case — mid-evaluation re-entry (D2),
	// dirty/pending revalidation, first evaluation, boxed cache (D3) — to the
	// out-of-line slow path.
	function computedRead(c: number): unknown {
		const flags = M[c + C.FLAGS];
		if (
			flags & (C.RECURSED_CHECK | C.DIRTY | C.PENDING | C.HAS_BOX)
			|| flags === C.K_COMPUTED
		) {
			return computedReadSlow(c, flags);
		}
		if (activeSub !== 0) {
			link(c, activeSub, cycle);
		}
		return vals[c >> 2];
	}

	// The donor computedRead ladder, out of line (recompute/first-eval/boxed).
	function computedReadSlow(c: number, flags: number): unknown {
		// D2: per-world cycle detection (spec §3.6) — reading a computed while
		// its own evaluation frame is open is a dependency cycle. (The donor
		// returned the stale cached value here, alien-signals style.)
		if (flags & C.RECURSED_CHECK) {
			throw new CycleError('cosignal: computed read during its own evaluation (dependency cycle).');
		}
		if (
			flags & C.DIRTY
			|| (
				flags & C.PENDING
				&& (
					checkDirty(M[c + C.DEPS], c)
					|| (M[c + C.FLAGS] = flags & ~C.PENDING, false)
				)
			)
		) {
			if (updateComputed(c)) {
				const subs = M[c + C.SUBS];
				if (subs !== 0) {
					shallowPropagate(subs);
				}
			}
		} else if (flags === C.K_COMPUTED) { // upstream `!flags`: never evaluated
			M[c + C.FLAGS] = C.K_COMPUTED | C.MUTABLE | C.RECURSED_CHECK;
			const prevSub = activeSub;
			activeSub = c;
			++enterDepth;
			try {
				vals[c >> 2] = (fnTab[c >> 3] as (ctx: unknown) => unknown)(evalCtx);
			} catch (e) {
				vals[c >> 2] = boxThrown(c, e, vals[c >> 2]); // D3 (cold)
				M[c + C.FLAGS] |= C.HAS_BOX;
			} finally {
				--enterDepth;
				activeSub = prevSub;
				M[c + C.FLAGS] &= ~C.RECURSED_CHECK;
			}
		}
		const sub = activeSub;
		if (sub !== 0) {
			link(c, sub, cycle);
		}
		// D3: a boxed cache unwraps on the cold path — errors rethrow, settled
		// suspensions self-heal, pending suspensions throw their stable
		// SuspendedRead. The link above already registered the subscription,
		// so recovery re-notifies whoever observed the sentinel.
		if (M[c + C.FLAGS] & C.HAS_BOX) {
			return boxedRead(c);
		}
		return vals[c >> 2];
	}

	// D5: settlement-invalidate primitive. Marks the computed stale exactly the
	// way a dependency write would have and propagates to its subscribers; the
	// wrapper flushes. Cold: called from settle listeners and read-site
	// self-heal only.
	function invalidateComputed(c: number): boolean {
		const flags = M[c + C.FLAGS];
		if (!(flags & C.K_COMPUTED)) {
			return false;
		}
		M[c + C.FLAGS] = flags | C.DIRTY;
		const subs = M[c + C.SUBS];
		if (subs !== 0) {
			propagate(subs, runDepth !== 0);
			return true;
		}
		return false;
	}
}

// ---- engine instance + growth ------------------------------------------------

const initialRecords = (() => {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
		.process?.env?.COSIGNAL_INITIAL_RECORDS;
	const n = env !== undefined ? Number(env) : NaN;
	return Number.isFinite(n) && n >= 2 ? Math.ceil(n) : 1 << 20;
})();

// D6: configure({initialRecords}) raises this floor; the growth loop honors it.
let desiredRecords = initialRecords * 3;

// THE SEAM (see the header): the operation-table factory. Initialized to the
// DIRECT table; nothing in THIS module ever reassigns it (a DIRECT bundle
// const-folds it). The LOGGED twin re-points it exactly once through
// `__installTwinTable` below, then every operation — growth included —
// routes through the logged table.
let engineFactory: (records: number, carry?: Int32Array) => Engine = createEngine;

/**
 * The fold-purity table (see runFold): every operation throws the fold error
 * (requeueAbort no-ops so flush()'s finally can never mask one). Deliberately
 * its OWN object shape, distinct from createEngine's: the real engine must
 * stay the only live instance of its hidden class so V8 keeps its function
 * fields constant and inlines `E.op` call targets (sharing one map between
 * the two tables measurably killed that: +15-25% on recompute/read shapes).
 * Legal code never dispatches through POISON — only fold-purity violations
 * reach it, and those throw — so the polymorphism it could introduce at
 * `E.op` sites is confined to code that is already erroring.
 */
const POISON: Engine = {
	records: 2,
	buffer: foldPoisonOp as never,
	newSignal: foldPoisonOp as never,
	newComputed: foldPoisonOp as never,
	newEffect: foldPoisonOp as never,
	newScope: foldPoisonOp as never,
	gen: foldPoisonOp as never,
	read: foldPoisonOp as never,
	write: foldPoisonOp as never,
	computedRead: foldPoisonOp as never,
	run: foldPoisonOp as never,
	requeueAbort: foldNoop as never,
	dispose: foldPoisonOp as never,
	sweepPendingFree: foldPoisonOp as never,
	invalidateComputed: foldPoisonOp as never,
	markLifecycle: foldPoisonOp as never,
	activeIsComputed: foldPoisonOp as never,
};

// Footprint parity with the old split planes (initialRecords node records +
// 2x initialRecords link records): 3x initialRecords shared records.
let E: Engine = engineFactory(initialRecords * 3);

/**
 * THE TWIN ATTACHMENT POINT (header: "re-points `engineFactory` at the logged
 * factory, then rebuilds `E` exactly once over the carried buffers"). Called
 * only by the LOGGED entry's `registerReactBridge()` — never from this module,
 * so a DIRECT bundle never reaches overlay code through it. Asserts the
 * operation-boundary precondition (spec §3.6/§5.1): no live engine frame may
 * hold the old table's buffers. `wrap` receives the DIRECT factory and must
 * return a factory producing tables of the same `Engine` shape; growth
 * thereafter rebuilds through the swapped binding — the donor's own pattern.
 * @internal
 */
export function __installTwinTable(
	wrap: (direct: (records: number, carry?: Int32Array) => Engine) => (records: number, carry?: Int32Array) => Engine,
): void {
	if (enterDepth !== 0) {
		throw new Error('cosignal: registerReactBridge inside an open evaluation/fold/walk frame (spec §3.6).');
	}
	engineFactory = wrap(createEngine);
	E = engineFactory(E.records, E.buffer());
}

/** The operation-table shape the twin factory must produce. @internal */
export type { Engine as EngineTable };

function maybeBoundary(): void {
	if (enterDepth === 0 && (growPending || pendingFree.length !== 0)) {
		boundaryWork();
	}
}

function boundaryWork(): void {
	// Sweep only while the effect queue is empty: an un-flushed queue (e.g. a
	// read's shallowPropagate notified an effect after the last flush) may
	// still reference a disposed record, and freeing it here would let a new
	// node reuse the id and be run() by the stale queue entry.
	if (pendingFree.length !== 0 && queuedLength === 0) {
		E.sweepPendingFree();
	}
	if (growPending) {
		growPending = false;
		let records = E.records;
		while (records < desiredRecords || recNext > Math.min((records * 8) >> 1, (records - C.REC_SLACK) * 8)) {
			records *= 2;
		}
		if (records !== E.records) {
			E = engineFactory(records, E.buffer());
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
	maybeBoundary();
	const engine = E;
	const queue = queued; // function-scope alias survives bundling (see createEngine note)
	try {
		while (notifyIndex < queuedLength) {
			const e = queue[notifyIndex];
			queue[notifyIndex++] = 0;
			engine.run(e);
		}
	} finally {
		while (notifyIndex < queuedLength) {
			const e = queue[notifyIndex];
			queue[notifyIndex++] = 0;
			E.requeueAbort(e);
		}
		notifyIndex = 0;
		queuedLength = 0;
	}
}

// ═══════════════════════════════════════════════════════════════════════════════
// Policy layer
// ═══════════════════════════════════════════════════════════════════════════════

// ---- policy state -------------------------------------------------------------

let forbidWritesInComputeds = false;

function throwFold(): never {
	throw new Error(
		'cosignal: signal reads and writes are not allowed inside an update() updater or a reducer — read before dispatch instead.',
	);
}

// The poison table's operations (hoisted: referenced when POISON is built at
// module init). Every op throws the fold-purity error; requeueAbort no-ops.
function foldPoisonOp(): never {
	throwFold();
}

function foldNoop(): void {}

/** The Computed instance owning kernel node `c` (aux value slot, D4). */
function ownerOf(c: number): Computed<unknown> {
	return values[(c >> 2) + 1] as Computed<unknown>;
}

// ---- observed lifecycle (AtomOptions.effect) -----------------------------------
// Delivered on the kernel's liveness bit: linkInsert's first-subscriber branch
// and unwatched()'s signal branch call the two hooks below (guarded by the
// node's C.LIFECYCLE field, D1). Both transitions run through a microtask
// queue so observe/unobserve flaps within one tick coalesce to nothing.

type LifecycleState = {
	effect: (ctx: AtomCtx<unknown>) => void | (() => void);
	ctx: AtomCtx<unknown>;
	cleanup: (() => void) | undefined;
	/** Desired state as of the last liveness transition. */
	wantMounted: boolean;
	/** Actual state (effect has run and not been cleaned up). */
	isMounted: boolean;
	scheduled: boolean;
};

const lifecycleStates = new Map<number, LifecycleState>();
let lifecycleQueue: LifecycleState[] = [];
let lifecycleFlushScheduled = false;

function scheduleLifecycleFlush(): void {
	if (lifecycleFlushScheduled) {
		return;
	}
	lifecycleFlushScheduled = true;
	queueMicrotask(() => {
		lifecycleFlushScheduled = false;
		const queue = lifecycleQueue;
		lifecycleQueue = [];
		for (const state of queue) {
			state.scheduled = false;
			if (state.wantMounted === state.isMounted) {
				continue; // flap coalesced within one tick
			}
			if (state.wantMounted) {
				state.isMounted = true;
				const result = state.effect(state.ctx);
				state.cleanup = typeof result === 'function' ? result : undefined;
			} else {
				state.isMounted = false;
				const cleanup = state.cleanup;
				state.cleanup = undefined;
				if (cleanup !== undefined) {
					cleanup();
				}
			}
		}
	});
}

function lifecycleTransition(id: number, wantMounted: boolean): void {
	const state = lifecycleStates.get(id);
	if (state === undefined) {
		return;
	}
	state.wantMounted = wantMounted;
	if (!state.scheduled) {
		state.scheduled = true;
		lifecycleQueue.push(state);
		scheduleLifecycleFlush();
	}
}

// Hoisted function declarations: the kernel calls these from linkInsert /
// unwatched, which are defined earlier in the module.
function lifecycleWatched(id: number): void {
	lifecycleTransition(id, true);
}

function lifecycleUnwatched(id: number): void {
	lifecycleTransition(id, false);
}

// ---- writes (shared by Atom.set / update / dispatch / lifecycle ctx) -----------

function writeAtom(id: number, isEqual: ((a: unknown, b: unknown) => boolean) | undefined, value: unknown): void {
	// Writes-in-computeds: tolerated by default (donor/alien semantics,
	// conformance-pinned — a write that feeds the evaluating computed simply
	// marks it pending again through the kernel's RECURSED ladder and settles
	// by lazy revalidation). Evaluation *cycles* — re-entrant reads — throw in
	// computedRead (D2). The configure flag rejects every in-evaluation write.
	// (Known pinhole, documented: a write wrapped in untracked() clears the
	// kernel's activeSub, so the flag cannot see it.)
	if (forbidWritesInComputeds && E.activeIsComputed()) {
		throw new Error('cosignal: writes inside computeds are forbidden (configure({ forbidWritesInComputeds: true })).');
	}
	// Empty-history equality drop (spec §5.3 step 2): in DIRECT mode every
	// atom's tape is always empty, so the plain equality short-circuit is the
	// whole rule. Policy equality against the newest (pending) value here; the
	// kernel's own identity compare covers the default.
	if (isEqual !== undefined && isEqual(values[(id >> 2) + 1], value)) {
		return;
	}
	maybeBoundary();
	if (E.write(id, value) && batchDepth === 0) {
		flush();
	}
}

/**
 * Runs a reducer/updater under the fold-purity guard (spec §3.1: signal reads
 * and writes inside throw, in all builds). Mechanism: the operation table is
 * swapped to the POISON table for the duration, so every read/write/creation
 * the fold attempts throws at the dispatch site — and the hot read/write
 * paths carry zero fold instructions. Folds are synchronous and never open
 * kernel frames of their own; open outer frames hold the real table's
 * buffers as closure constants and are unaffected by the swap.
 */
function runFold<T>(fn: () => T): T {
	const saved = E;
	E = POISON;
	try {
		return fn();
	} finally {
		E = saved;
	}
}

// ---- the computed evaluation policy --------------------------------------------

const noop = (): void => {};

type InstrumentedThenable = PromiseLike<unknown> & {
	status?: 'pending' | 'fulfilled' | 'rejected';
	value?: unknown;
	reason?: unknown;
};

/**
 * ctx.previous (hoisted; called from POLICY_CTX). The evaluating node is the
 * kernel's activeSub; its value slot still holds the previous cached value
 * during the evaluation (updateComputed assigns after the getter returns).
 * Boxes read as undefined. Leaked-ctx calls outside a computed evaluation
 * fall under the "arbitrarily stale or undefined" license of spec §3.4.
 */
function ctxPrevious(): unknown {
	const c = activeSub;
	if (c === 0) {
		return undefined;
	}
	const v = values[c >> 2];
	const owner = values[(c >> 2) + 1];
	if (owner instanceof Computed && (v === owner._box || v === NO_BOX)) {
		return undefined;
	}
	return v;
}

/**
 * ctx.use (hoisted; called from POLICY_CTX) — the canonical thenable protocol
 * (mirrors React's trackUsedThenable): instrument `status`/`value`/`reason`
 * onto the thenable itself; while a slot's previous thenable survives, a
 * thenable produced by re-evaluation is assumed to re-create the same work —
 * the previous one wins and the new one is silenced (the lazy factory is not
 * even called). Settled thenables synchronously return their value / throw
 * their reason.
 *
 * Slot lifetime (the React render-attempt analog): a settle-driven
 * re-evaluation is a REPLAY — every slot survives, so settled work is
 * consumed, never refetched. A dependency-driven re-evaluation is a fresh
 * attempt — settled slots are dropped (changed inputs refetch; at worst a
 * duplicate fetch) while still-pending slots survive for identity stability.
 * The suspense evaluation prologue (installed on first use, see
 * suspenseEvalFn) applies that hygiene per evaluation. Known v1 corner
 * (documented; the LOGGED build's capsule prefixes refine it): a dependency
 * change landing while a slot is pending dedupes into the in-flight work
 * rather than refetching.
 */
function ctxUse(source: PromiseLike<unknown> | (() => PromiseLike<unknown>)): unknown {
	const c = activeSub;
	const owner = c !== 0 ? values[(c >> 2) + 1] : undefined;
	if (!(owner instanceof Computed)) {
		throw new Error('cosignal: ctx.use may only be called during a computed evaluation.');
	}
	let slots = owner._slots;
	if (slots === undefined) {
		// First-ever use on this node: create the slot store and install the
		// suspense evaluation prologue for every later evaluation (the current,
		// already-running evaluation needs no hygiene — its slots are fresh).
		slots = owner._slots = [];
		owner._slotIndex = 0;
		fns[c >> 3] = suspenseEvalFn(owner, fns[c >> 3] as (ctx: unknown) => unknown);
	}
	const index = owner._slotIndex++;
	const prev = slots[index] as InstrumentedThenable | undefined;
	let t: InstrumentedThenable;
	if (prev !== undefined) {
		t = prev; // the slot's previous work wins for the whole attempt
		if (typeof source !== 'function' && source !== prev) {
			source.then(noop, noop); // silence the dropped re-creation
		}
	} else {
		t = (typeof source === 'function' ? source() : source) as InstrumentedThenable;
	}
	slots[index] = t;
	switch (t.status) {
		case 'fulfilled':
			return t.value;
		case 'rejected':
			throw t.reason;
		case 'pending':
			throw new SuspendedRead(t);
		default: {
			t.status = 'pending';
			t.then(
				(v: unknown) => {
					if (t.status === 'pending') {
						t.status = 'fulfilled';
						t.value = v;
					}
				},
				(e: unknown) => {
					if (t.status === 'pending') {
						t.status = 'rejected';
						t.reason = e;
					}
				},
			);
			throw new SuspendedRead(t);
		}
	}
}

/**
 * Evaluation prologue for computeds that use ctx.use, installed into the
 * kernel fn slot at the first use() call — only suspense users pay it. Runs
 * the slot-attempt hygiene described on ctxUse, then delegates to the
 * original evaluator.
 */
function suspenseEvalFn(owner: Computed<unknown>, inner: (ctx: unknown) => unknown): (ctx: unknown) => unknown {
	return (ctxArg: unknown): unknown => {
		owner._slotIndex = 0;
		const slots = owner._slots!;
		if (slots.length !== 0) {
			if (owner._settleReplay) {
				owner._settleReplay = false;
			} else {
				for (let i = 0; i < slots.length; i++) {
					const s = slots[i] as InstrumentedThenable | undefined;
					if (s !== undefined && s.status !== 'pending') {
						slots[i] = undefined;
					}
				}
			}
		}
		return inner(ctxArg);
	};
}

/**
 * The kernel's exception hook (D3), cold: turns whatever a computed
 * evaluation threw into the reference-stable sentinel box that becomes the
 * cached value. Same payload → the previous box is returned, so downstream
 * sees no change (the kernel compares identity).
 */
function boxThrown(c: number, e: unknown, oldValue: unknown): SentinelBox {
	const owner = ownerOf(c);
	const prevBox = oldValue !== undefined && oldValue === owner._box ? (oldValue as SentinelBox) : undefined;
	if (e instanceof SuspendedRead) {
		const t = e.thenable;
		if (prevBox !== undefined && prevBox.kind === BOX_SUSPENDED && prevBox.payload === t) {
			return prevBox; // same pending thenable — identity stable across re-eval
		}
		const box = new SentinelBox(BOX_SUSPENDED, t, e);
		owner._box = box;
		attachSettle(owner, box, t as InstrumentedThenable);
		return box;
	}
	if (prevBox !== undefined && prevBox.kind === BOX_ERROR && prevBox.payload === e) {
		return prevBox; // rethrown identical error — no downstream churn
	}
	const box = new SentinelBox(BOX_ERROR, e);
	owner._box = box;
	return box;
}

/**
 * Settlement-invalidate: when the pending thenable of a suspended box
 * settles, mark the computed stale and propagate so watchers re-run and
 * readers recompute. Guarded by reference identity — the box must still be
 * the node's cached value AND still carry this exact thenable (spec §5.8's
 * settlement rule), so out-of-order settlement of superseded work is inert.
 */
function attachSettle(owner: Computed<unknown>, box: SentinelBox, t: InstrumentedThenable): void {
	const id = owner._id;
	const onSettle = (): void => {
		if (values[id >> 2] !== box || box.payload !== t) {
			return;
		}
		try {
			maybeBoundary();
			owner._settleReplay = true; // the next evaluation is a replay
			E.invalidateComputed(id);
			if (batchDepth === 0) {
				flush();
			}
		} catch (err) {
			// Effects that throw during the settle flush surface like any other
			// unhandled error rather than rejecting the settled promise chain.
			queueMicrotask(() => {
				throw err;
			});
		}
	};
	t.then(onSettle, onSettle);
}

/**
 * Cold read tail (hoisted; called from the kernel's computedRead when the
 * HAS_BOX flag is set): the cached value is a sentinel box. Errors rethrow
 * their payload. Suspended boxes whose thenable already settled self-heal
 * (invalidate + recompute) so a read after `await` is deterministic even
 * before the settle listener's microtask runs; pending suspensions throw the
 * box's stable SuspendedRead. The self-heal re-read recurses through the
 * kernel tail at most once more: a further box minted during the recursion
 * necessarily carries a thenable that was pending at mint, which throws —
 * settlement cannot occur inside this synchronous frame.
 */
function boxedRead(c: number): unknown {
	const box = values[c >> 2] as SentinelBox;
	if (box.kind !== BOX_SUSPENDED) {
		throw box.payload;
	}
	const t = box.payload as InstrumentedThenable;
	if (t.status === undefined || t.status === 'pending') {
		throw box.sr;
	}
	const owner = ownerOf(c);
	owner._settleReplay = true; // the recompute below is a settle replay
	E.invalidateComputed(c);
	const next = E.computedRead(c);
	if (batchDepth === 0) {
		flush();
	}
	if (next === box) {
		// Defensive: no progress (should be unreachable) — surface as-is.
		throw box.sr;
	}
	return next;
}

// ---- public API -----------------------------------------------------------------

/** Passed to an Atom's `effect` option while the atom is observed. */
export type AtomCtx<T> = {
	/** Current value, read without registering a dependency. */
	readonly state: T;
	set(value: T): void;
	update(fn: (current: T) => T): void;
};

export type AtomOptions<T> = {
	/**
	 * Observed lifecycle: runs when the atom becomes observed (first
	 * subscriber attaches — the kernel liveness bit flips 0→1); the returned
	 * cleanup runs once the atom is no longer observed. Both are delivered in
	 * a microtask so observe/unobserve flaps within one tick coalesce.
	 * Intended for remote subscriptions.
	 */
	effect?: (ctx: AtomCtx<T>) => void | (() => void);
	/**
	 * Policy equality for writes: an incoming value equal to the newest value
	 * is dropped (the empty-history equality drop — in DIRECT mode history is
	 * always empty). The kernel itself compares reference identity only; keep
	 * values reference-stable rather than relying on deep equality.
	 */
	isEqual?: (a: T, b: T) => boolean;
	/** Debug label. */
	label?: string;
};

export type ComputedOptions<T> = {
	/**
	 * Policy equality for recomputes: an equal result returns the previous
	 * reference, so downstream sees no change (equality cutoff). The kernel
	 * compares identity only.
	 */
	isEqual?: (a: T, b: T) => boolean;
	/** Debug label. */
	label?: string;
};

/** A writable signal. `.state` reads (tracked inside evaluations), `.set` writes. */
export class Atom<T> {
	/** Kernel record id; consumed by the (future) React bindings. @internal */
	readonly _id: number;
	/** @internal */
	readonly _isEqual: ((a: unknown, b: unknown) => boolean) | undefined;
	readonly label: string | undefined;

	constructor(initialState: T, options?: AtomOptions<T>) {
		maybeBoundary();
		const id = E.newSignal(initialState);
		this._id = id;
		this._isEqual = options?.isEqual as ((a: unknown, b: unknown) => boolean) | undefined;
		this.label = options?.label;
		const effect = options?.effect;
		if (effect !== undefined) {
			E.markLifecycle(id);
			const isEqual = this._isEqual;
			lifecycleStates.set(id, {
				effect: effect as (ctx: AtomCtx<unknown>) => void | (() => void),
				ctx: {
					get state(): unknown {
						return untracked(() => E.read(id));
					},
					set(value: unknown): void {
						writeAtom(id, isEqual, value);
					},
					update(fn: (current: unknown) => unknown): void {
						const next = runFold(() => fn(values[(id >> 2) + 1]));
						writeAtom(id, isEqual, next);
					},
				},
				cleanup: undefined,
				wantMounted: false,
				isMounted: false,
				scheduled: false,
			});
		}
	}

	/**
	 * The atom's current value (registers a dependency inside evaluations).
	 * Inside a fold frame the dispatch itself throws (POISON table).
	 */
	get state(): T {
		return E.read(this._id) as T;
	}

	/** Replaces the atom's value. */
	set(value: T): void {
		writeAtom(this._id, this._isEqual, value);
	}

	/**
	 * Functional update. `fn` must be pure: it runs under the fold-purity
	 * guard, so signal reads and writes inside it throw (spec §3.1 — read
	 * before dispatch instead). In the future LOGGED build the updater is
	 * stored and replayed per world; in DIRECT mode it applies immediately.
	 */
	update(fn: (current: T) => T): void {
		const id = this._id;
		const next = runFold(() => fn(values[(id >> 2) + 1] as T));
		writeAtom(id, this._isEqual, next);
	}
}

export type ReducerAtomOptions<S> = AtomOptions<S>;

/**
 * An atom whose writes go through a reducer. The reducer is fixed at
 * creation (spec §3.1); it must be pure — it runs under the fold-purity
 * guard, and in the LOGGED build dispatched actions are replayed through it
 * per world.
 */
export class ReducerAtom<S, A> extends Atom<S> {
	readonly reduce: (state: S, action: A) => S;

	constructor(reduce: (state: S, action: A) => S, initialState: S, options?: ReducerAtomOptions<S>) {
		super(initialState, options);
		this.reduce = reduce;
	}

	dispatch(action: A): void {
		const id = this._id;
		const reduce = this.reduce;
		const next = runFold(() => reduce(values[(id >> 2) + 1] as S, action));
		writeAtom(id, this._isEqual, next);
	}
}

/** A derived signal. `.state` reads; the function re-runs on demand. */
export class Computed<T> {
	/** Kernel record id; consumed by the (future) React bindings. @internal */
	readonly _id: number;
	/** ctx.use slot cache (per node, lazily created). @internal */
	_slots: unknown[] | undefined;
	/** ctx.use slot cursor for the evaluation in progress. @internal */
	_slotIndex: number;
	/** True while the next evaluation is a settlement replay. @internal */
	_settleReplay: boolean;
	/** Mirror of the sentinel box in the kernel cache, or NO_BOX. @internal */
	_box: SentinelBox;
	readonly label: string | undefined;

	constructor(fn: (ctx: ComputedCtx<T>) => T, options?: ComputedOptions<T>) {
		maybeBoundary();
		this._slots = undefined;
		this._slotIndex = 0;
		this._settleReplay = false;
		this._box = NO_BOX;
		this.label = options?.label;
		const isEqual = options?.isEqual as ((a: unknown, b: unknown) => boolean) | undefined;
		const id = E.newComputed(fn as (ctx: unknown) => unknown);
		this._id = id;
		// D4: the aux value slot carries the owning instance (policy state).
		values[(id >> 2) + 1] = this;
		if (isEqual !== undefined) {
			// Only equality users pay a wrapper: an equal result returns the
			// OLD reference so the kernel's identity compare sees no change.
			const self = this;
			const iv = id >> 2;
			fns[id >> 3] = (ctxArg: unknown): unknown => {
				const prev = values[iv];
				const next = (fn as (ctx: unknown) => unknown)(ctxArg);
				if (prev === undefined || prev === self._box) {
					return next;
				}
				return isEqual(prev, next) ? prev : next;
			};
		}
	}

	/**
	 * The computed's current value. Rethrows the evaluation's cached error;
	 * throws SuspendedRead while suspended on a pending `ctx.use` thenable
	 * (the kernel's boxed-read tail, D3). Inside a fold frame the dispatch
	 * itself throws (POISON table).
	 */
	get state(): T {
		return E.computedRead(this._id) as T;
	}
}

/** Either public signal wrapper. */
export type Signal<T> = Atom<T> | Computed<T>;

/**
 * Runs `fn` immediately with dependency tracking and re-runs it when tracked
 * signals change. Core-effect contract (spec §3.1): observes the newest
 * world — in DIRECT mode, simply the current values. `fn` may return a
 * cleanup run before each re-run and at dispose. Returns a disposer.
 */
export function effect(fn: () => void | (() => void)): () => void {
	maybeBoundary();
	const id = E.newEffect(fn);
	const gen = E.gen(id);
	return () => {
		if (E.gen(id) !== gen) {
			return; // record already reclaimed (and possibly reused)
		}
		E.dispose(id);
		maybeBoundary();
	};
}

/** Returns a disposer that disposes every effect created inside `fn`. */
export function effectScope(fn: () => void): () => void {
	maybeBoundary();
	const id = E.newScope(fn);
	const gen = E.gen(id);
	return () => {
		if (E.gen(id) !== gen) {
			return;
		}
		E.dispose(id);
		maybeBoundary();
	};
}

/**
 * Defers core-effect flushing to the batch's close. Nothing else (spec §3.1):
 * no implicit grouping of any kind exists anywhere in the engine.
 */
export function batch<T>(fn: () => T): T {
	++batchDepth;
	try {
		return fn();
	} finally {
		if (!--batchDepth && notifyIndex < queuedLength) {
			flush();
		}
	}
}

/** Low-level batch surface (adapter/bindings plumbing; prefer batch()). */
export function startBatch(): void {
	++batchDepth;
}

export function endBatch(): void {
	if (!--batchDepth && notifyIndex < queuedLength) {
		flush();
	}
}

/** Reads inside `fn` register no dependency edges. */
export function untracked<T>(fn: () => T): T {
	const prevSub = activeSub;
	activeSub = 0;
	try {
		return fn();
	} finally {
		activeSub = prevSub;
	}
}

export type ConfigureOptions = {
	/**
	 * When true, any atom write during a computed evaluation throws. When
	 * false (default), writes inside computeds are tolerated as long as they
	 * do not re-enter the writing computed (evaluation cycles throw
	 * CycleError; self-feedback writes settle by lazy revalidation,
	 * alien-signals semantics).
	 */
	forbidWritesInComputeds?: boolean;
	/**
	 * Capacity floor, in records (one signal/computed/effect node or one
	 * dependency link each; the plane holds 3× this number, donor parity).
	 * Raising it triggers growth at the next operation boundary; it never
	 * shrinks. Also settable via the COSIGNAL_INITIAL_RECORDS env var before
	 * first import.
	 */
	initialRecords?: number;
};

export function configure(options: ConfigureOptions): void {
	if (options.forbidWritesInComputeds !== undefined) {
		forbidWritesInComputeds = options.forbidWritesInComputeds;
	}
	const n = options.initialRecords;
	if (n !== undefined) {
		if (!Number.isFinite(n) || n < 2) {
			throw new Error('cosignal: configure({ initialRecords }) must be a number >= 2.');
		}
		const target = Math.ceil(n) * 3;
		if (target > desiredRecords) {
			desiredRecords = target;
		}
		if (E.records < desiredRecords) {
			growPending = true;
			maybeBoundary();
		}
	}
}
