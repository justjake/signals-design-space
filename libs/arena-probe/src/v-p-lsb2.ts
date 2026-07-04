/**
 * @lab/arena — alien-signals v3.2.1 transliterated onto interleaved Int32Array
 * records. Mechanical port of upstream system.ts + index.ts:
 *
 * - Nodes and links are integer ids into two flat Int32Array planes (N, L),
 *   stride 8; ids are pre-multiplied record offsets (id = recordIndex * 8) so
 *   field access is `N[id + FIELD]`. Record 0 of each plane is burned as NULL,
 *   so every `x !== undefined` in upstream becomes `x !== 0`.
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
 * GROWTH (closure rebuild): the whole engine closes over `const N/L`
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

// ---- record layout ---------------------------------------------------------
// Node fields (N plane, stride 8; ids are pre-multiplied: id = record * 8).
const FLAGS = 0;
const DEPS = 1; // doubles as the free-list next pointer for freed records
const DEPS_TAIL = 2;
const SUBS = 3;
const SUBS_TAIL = 4;
const GEN = 5; // bumped on free; disposers capture it to defuse stale ids
// fields 6-7 spare (pad to one cache line per record)

// Link fields (L plane, stride 8).
const VERSION = 0;
const DEP = 1;
const SUB = 2;
const PREV_SUB = 3;
const NEXT_SUB = 4;
const PREV_DEP = 5;
const NEXT_DEP = 6; // doubles as the free-list next pointer for freed links
// field 7 spare

// ---- flags (upstream ReactiveFlags + HasChildEffect + kind bits) -----------
const MUTABLE = 1;
const WATCHING = 2;
const RECURSED_CHECK = 4;
const RECURSED = 8;
const DIRTY = 16;
const PENDING = 32;
const HAS_CHILD_EFFECT = 64;
const K_SIGNAL = 128;
const K_COMPUTED = 256;
const K_EFFECT = 512;
const K_SCOPE = 1024;
const KIND_MASK = K_SIGNAL | K_COMPUTED | K_EFFECT | K_SCOPE;

// ---- shared mutable state (survives engine rebuilds) ------------------------
// Scalar heads/counters live at module level so a rebuilt engine resumes
// exactly where the old one stopped; only the buffer bindings live in the
// engine closure.
let nodeNext = 8; // bump pointer (record 0 burned)
let linkNext = 8;
let nodeFreeHead = 0; // free list threaded through N[id + DEPS]
let linkFreeHead = 0; // free list threaded through L[id + NEXT_DEP]
let growPending = false;

let cycle = 0;
let runDepth = 0;
let batchDepth = 0;
let notifyIndex = 0;
let queuedLength = 0;
let activeSub = 0;
let enterDepth = 0; // live engine frames that captured N/L; 0 = op boundary

const queued: number[] = [];
const pendingFree: number[] = []; // disposed effect/scope records awaiting sweep

// Side columns, indexed off the id: values[id >> 2] = current/computed value,
// values[(id >> 2) + 1] = signal pending value OR effect cleanup fn,
// fns[id >> 3] = computed getter / effect fn. Plain arrays grown by push
// (stays PACKED; plain-array growth has no binding problem).
const values: unknown[] = [undefined, undefined];
const fns: (Function | undefined)[] = [undefined];

// Persistent scratch stacks (upstream's cons-cell Stack<T>). Re-entrant
// walks push above the caller's base and restore it on exit.
let propStack = new Int32Array(4096);
let propSp = 0;
let checkStack = new Int32Array(4096);
let checkSp = 0;

const NODE_SLACK = 256; // min free records guaranteed at each op boundary
const LINK_SLACK = 1024;

// ---- the engine -------------------------------------------------------------

interface Engine {
	nodeRecords: number;
	linkRecords: number;
	buffers(): { N: Int32Array; L: Int32Array };
	newSignal(value: unknown): number;
	newComputed(getter: (previousValue?: unknown) => unknown): number;
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
}

function createEngine(
	nodeRecords: number,
	linkRecords: number,
	carry?: { N: Int32Array; L: Int32Array },
): Engine {
	const N = new Int32Array(nodeRecords * 8);
	const L = new Int32Array(linkRecords * 8);
	if (carry !== undefined) {
		N.set(carry.N);
		L.set(carry.L);
	}
	// Allocators flag growth once the bump pointer crosses the watermark:
	// keep at least SLACK records AND half the plane free at every boundary.
	const NODE_WM = Math.min(N.length >> 1, N.length - NODE_SLACK * 8);
	const LINK_WM = Math.min(L.length >> 1, L.length - LINK_SLACK * 8);
	if (nodeNext > NODE_WM || linkNext > LINK_WM) {
		growPending = true;
	}

	return {
		nodeRecords,
		linkRecords,
		buffers: () => ({ N, L }),
		newSignal,
		newComputed,
		newEffect,
		newScope,
		gen: (id) => N[id + GEN],
		read,
		write,
		computedRead,
		run,
		requeueAbort,
		dispose,
		sweepPendingFree,
	};

	// ---- allocation ----------------------------------------------------------

	function allocNode(flags: number): number {
		let id: number;
		if (nodeFreeHead !== 0) {
			id = nodeFreeHead;
			nodeFreeHead = N[id + DEPS];
			N[id + DEPS] = 0;
		} else {
			id = nodeNext;
			if (id >= N.length) {
				throw new Error('@lab/arena: node arena exhausted mid-operation; raise ARENA_PROBE_INITIAL_RECORDS');
			}
			nodeNext = id + 8;
			if (nodeNext > NODE_WM) {
				growPending = true;
			}
		}
		N[id + FLAGS] = flags;
		const v = id >> 2;
		while (values.length <= v + 1) {
			values.push(undefined);
		}
		while (fns.length <= id >> 3) {
			fns.push(undefined);
		}
		return id;
	}

	function freeNode(id: number): void {
		N[id + FLAGS] = 0;
		N[id + DEPS_TAIL] = 0;
		N[id + SUBS] = 0;
		N[id + SUBS_TAIL] = 0;
		++N[id + GEN];
		const v = id >> 2;
		values[v] = undefined;
		values[v + 1] = undefined;
		fns[id >> 3] = undefined;
		N[id + DEPS] = nodeFreeHead;
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
			linkFreeHead = L[id + NEXT_DEP];
		} else {
			id = linkNext;
			if (id >= L.length) {
				throw new Error('@lab/arena: link arena exhausted mid-operation; raise ARENA_PROBE_INITIAL_RECORDS');
			}
			linkNext = id + 8;
			if (linkNext > LINK_WM) {
				growPending = true;
			}
		}
		return id;
	}

	function freeLink(id: number): void {
		L[id + NEXT_DEP] = linkFreeHead;
		linkFreeHead = id;
	}

	// ---- system.ts transliteration -------------------------------------------

	function link(dep: number, sub: number, version: number): void {
		const prevDep = N[sub + DEPS_TAIL];
		if (prevDep !== 0 && L[prevDep + DEP] === dep) {
			return;
		}
		const nextDep = prevDep !== 0 ? L[prevDep + NEXT_DEP] : N[sub + DEPS];
		if (nextDep !== 0 && L[nextDep + DEP] === dep) {
			L[nextDep + VERSION] = version;
			N[sub + DEPS_TAIL] = nextDep;
			return;
		}
		linkInsert(dep, sub, version, prevDep, nextDep);
	}

	function linkInsert(dep: number, sub: number, version: number, prevDep: number, nextDep: number): void {
		const prevSub = N[dep + SUBS_TAIL];
		if (prevSub !== 0 && L[prevSub + VERSION] === version && L[prevSub + SUB] === sub) {
			return;
		}
		const newLink = allocLink();
		N[sub + DEPS_TAIL] = newLink;
		N[dep + SUBS_TAIL] = newLink;
		L[newLink + VERSION] = version;
		L[newLink + DEP] = dep;
		L[newLink + SUB] = sub;
		L[newLink + PREV_DEP] = prevDep;
		L[newLink + NEXT_DEP] = nextDep;
		L[newLink + PREV_SUB] = prevSub;
		L[newLink + NEXT_SUB] = 0;
		if (nextDep !== 0) {
			L[nextDep + PREV_DEP] = newLink;
		}
		if (prevDep !== 0) {
			L[prevDep + NEXT_DEP] = newLink;
		} else {
			N[sub + DEPS] = newLink;
		}
		if (prevSub !== 0) {
			L[prevSub + NEXT_SUB] = newLink;
		} else {
			N[dep + SUBS] = newLink;
		}
	}

	function unlink(id: number, sub = L[id + SUB]): number {
		const dep = L[id + DEP];
		const prevDep = L[id + PREV_DEP];
		const nextDep = L[id + NEXT_DEP];
		const nextSub = L[id + NEXT_SUB];
		const prevSub = L[id + PREV_SUB];
		if (nextDep !== 0) {
			L[nextDep + PREV_DEP] = prevDep;
		} else {
			N[sub + DEPS_TAIL] = prevDep;
		}
		if (prevDep !== 0) {
			L[prevDep + NEXT_DEP] = nextDep;
		} else {
			N[sub + DEPS] = nextDep;
		}
		if (nextSub !== 0) {
			L[nextSub + PREV_SUB] = prevSub;
		} else {
			N[dep + SUBS_TAIL] = prevSub;
		}
		freeLink(id);
		if (prevSub !== 0) {
			L[prevSub + NEXT_SUB] = nextSub;
		} else if ((N[dep + SUBS] = nextSub) === 0) {
			unwatched(dep);
		}
		return nextDep;
	}

	function propagate(startLink: number, innerWrite: boolean): void {
		// No try/finally: propagate never runs user code (notify only queues),
		// so it cannot throw and always drains the stack back to its base.
		let cur = startLink;
		let next = L[cur + NEXT_SUB];
		const stackBase = propSp;

		top: do {
			const sub = L[cur + SUB];
			let flags = N[sub + FLAGS];

			if (!(flags & (RECURSED_CHECK | RECURSED | DIRTY | PENDING))) {
				N[sub + FLAGS] = flags | PENDING;
				if (innerWrite) {
					N[sub + FLAGS] |= RECURSED;
				}
			} else if (!(flags & (RECURSED_CHECK | RECURSED))) {
				flags = 0;
			} else if (!(flags & RECURSED_CHECK)) {
				N[sub + FLAGS] = (flags & ~RECURSED) | PENDING;
			} else if (!(flags & (DIRTY | PENDING)) && isValidLink(cur, sub)) {
				N[sub + FLAGS] = flags | (RECURSED | PENDING);
				flags &= MUTABLE;
			} else {
				flags = 0;
			}

			if (flags & WATCHING) {
				notify(sub);
			}

			if (flags & MUTABLE) {
				const subSubs = N[sub + SUBS];
				if (subSubs !== 0) {
					cur = subSubs;
					const nextSub = L[cur + NEXT_SUB];
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
				next = L[cur + NEXT_SUB];
				continue;
			}

			while (propSp > stackBase) {
				cur = propStack[--propSp];
				if (cur !== 0) {
					next = L[cur + NEXT_SUB];
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
				const dep = L[cur + DEP];
				const depFlags = N[dep + FLAGS];

				if (N[sub + FLAGS] & DIRTY) {
					dirty = true;
				} else if ((depFlags & (MUTABLE | DIRTY)) === (MUTABLE | DIRTY)) {
					const depSubs = N[dep + SUBS];
					if (update(dep)) {
						if (L[depSubs + NEXT_SUB] !== 0) {
							shallowPropagate(depSubs);
						}
						dirty = true;
					}
				} else if ((depFlags & (MUTABLE | PENDING)) === (MUTABLE | PENDING)) {
					if (checkSp === checkStack.length) {
						const bigger = new Int32Array(checkStack.length * 2);
						bigger.set(checkStack);
						checkStack = bigger;
					}
					checkStack[checkSp++] = cur;
					cur = N[dep + DEPS];
					sub = dep;
					++checkDepth;
					continue;
				}

				if (!dirty) {
					const nextDep = L[cur + NEXT_DEP];
					if (nextDep !== 0) {
						cur = nextDep;
						continue;
					}
				}

				while (checkDepth--) {
					cur = checkStack[--checkSp];
					if (dirty) {
						const subSubs = N[sub + SUBS];
						if (update(sub)) {
							if (L[subSubs + NEXT_SUB] !== 0) {
								shallowPropagate(subSubs);
							}
							sub = L[cur + SUB];
							continue;
						}
						dirty = false;
					} else {
						N[sub + FLAGS] &= ~PENDING;
					}
					sub = L[cur + SUB];
					const nextDep = L[cur + NEXT_DEP];
					if (nextDep !== 0) {
						cur = nextDep;
						continue top;
					}
				}

				// Upstream: `dirty && !!sub.flags` — a live node always has its
				// kind bits set; flags reads 0 only if sub was disposed (record
				// zeroed) by re-entrant user code during update().
				return dirty && N[sub + FLAGS] !== 0;
			} while (true);
		} finally {
			checkSp = stackBase;
		}
	}

	function shallowPropagate(startLink: number): void {
		let cur = startLink;
		do {
			const sub = L[cur + SUB];
			const flags = N[sub + FLAGS];
			if ((flags & (PENDING | DIRTY)) === PENDING) {
				N[sub + FLAGS] = flags | DIRTY;
				if ((flags & (WATCHING | RECURSED_CHECK)) === WATCHING) {
					notify(sub);
				}
			}
		} while ((cur = L[cur + NEXT_SUB]) !== 0);
	}

	function isValidLink(checkLink: number, sub: number): boolean {
		let cur = N[sub + DEPS_TAIL];
		while (cur !== 0) {
			if (cur === checkLink) {
				return true;
			}
			cur = L[cur + PREV_DEP];
		}
		return false;
	}

	// ---- index.ts transliteration ---------------------------------------------

	function update(node: number): boolean {
		const flags = N[node + FLAGS];
		if (flags & K_COMPUTED) {
			return updateComputed(node);
		}
		if (flags & K_SIGNAL) {
			return updateSignal(node);
		}
		N[node + FLAGS] = (flags & KIND_MASK) | MUTABLE;
		return true;
	}

	function notify(e: number): void {
		let insertIndex = queuedLength;
		const firstInsertedIndex = insertIndex;

		do {
			queued[insertIndex++] = e;
			N[e + FLAGS] &= ~WATCHING;
			const subs = N[e + SUBS];
			e = subs !== 0 ? L[subs + SUB] : 0;
			if (e === 0 || !(N[e + FLAGS] & WATCHING)) {
				break;
			}
		} while (true);

		queuedLength = insertIndex;

		// The parent chain was appended child-first: reverse the inserted
		// segment in place so outer effects run before inner.
		let left = firstInsertedIndex;
		while (left < --insertIndex) {
			const tmp = queued[left];
			queued[left++] = queued[insertIndex];
			queued[insertIndex] = tmp;
		}
	}

	function unwatched(node: number): void {
		const flags = N[node + FLAGS];
		if (flags & K_COMPUTED) {
			if (N[node + DEPS_TAIL] !== 0) {
				N[node + FLAGS] = K_COMPUTED | MUTABLE | DIRTY;
				disposeAllDepsInReverse(node);
			}
		} else if (flags & K_SIGNAL) {
			// Nothing to do for signals.
		} else if (flags & (K_EFFECT | K_SCOPE)) {
			dispose(node);
		}
	}

	// Upstream's HasChildEffect slow path in updateComputed/run: unlink every
	// dep that is not a signal/computed (i.e. child effects/scopes), in reverse.
	function unlinkChildEffects(sub: number): void {
		let cur = N[sub + DEPS_TAIL];
		while (cur !== 0) {
			const prev = L[cur + PREV_DEP];
			const dep = L[cur + DEP];
			if (!(N[dep + FLAGS] & (K_COMPUTED | K_SIGNAL))) {
				unlink(cur, sub);
			}
			cur = prev;
		}
	}

	function updateComputed(c: number): boolean {
		if (N[c + FLAGS] & HAS_CHILD_EFFECT) {
			unlinkChildEffects(c);
		}
		N[c + DEPS_TAIL] = 0;
		N[c + FLAGS] = K_COMPUTED | MUTABLE | RECURSED_CHECK;
		const prevSub = activeSub;
		activeSub = c;
		++enterDepth;
		try {
			++cycle;
			const v = c >> 2;
			const oldValue = values[v];
			return oldValue !== (values[v] = (fns[c >> 3] as (previousValue?: unknown) => unknown)(oldValue));
		} finally {
			--enterDepth;
			activeSub = prevSub;
			N[c + FLAGS] &= ~RECURSED_CHECK;
			purgeDeps(c);
		}
	}

	function updateSignal(s: number): boolean {
		N[s + FLAGS] = K_SIGNAL | MUTABLE;
		const v = s >> 2;
		return values[v] !== (values[v] = values[v + 1]);
	}

	function run(e: number): void {
		const flags = N[e + FLAGS];
		if (
			flags & DIRTY
			|| (flags & PENDING && checkDirty(N[e + DEPS], e))
		) {
			if (flags & HAS_CHILD_EFFECT) {
				unlinkChildEffects(e);
			}
			const cv = (e >> 2) + 1;
			if (values[cv]) {
				runCleanup(e);
				if (N[e + FLAGS] === 0) {
					return; // disposed by its own cleanup
				}
			}
			N[e + DEPS_TAIL] = 0;
			N[e + FLAGS] = K_EFFECT | WATCHING | RECURSED_CHECK;
			const prevSub = activeSub;
			activeSub = e;
			++enterDepth;
			try {
				++cycle;
				++runDepth;
				values[cv] = (fns[e >> 3] as () => (() => void) | void)();
			} finally {
				--runDepth;
				--enterDepth;
				activeSub = prevSub;
				N[e + FLAGS] &= ~RECURSED_CHECK;
				purgeDeps(e);
			}
		} else if (N[e + DEPS] !== 0) {
			N[e + FLAGS] = K_EFFECT | WATCHING | (flags & HAS_CHILD_EFFECT);
		}
	}

	// flush() abort path: re-arm effects still queued after a throw.
	function requeueAbort(e: number): void {
		if (N[e + FLAGS] & KIND_MASK) {
			N[e + FLAGS] |= WATCHING | RECURSED;
		}
	}

	function runCleanup(e: number): void {
		const cv = (e >> 2) + 1;
		const cleanup = values[cv] as () => void;
		values[cv] = undefined;
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
		const flags = N[e + FLAGS];
		if (!(flags & KIND_MASK)) {
			return; // already disposed
		}
		N[e + FLAGS] = 0;
		disposeAllDepsInReverse(e);
		const sub = N[e + SUBS];
		if (sub !== 0) {
			unlink(sub);
		}
		if (flags & K_EFFECT && values[(e >> 2) + 1]) {
			runCleanup(e);
		}
		// Deferred reclamation: the queue (or an in-flight walk) may still hold
		// this id; the record is swept back onto the free list at the next
		// operation boundary.
		pendingFree.push(e);
	}

	function disposeAllDepsInReverse(sub: number): void {
		let cur = N[sub + DEPS_TAIL];
		while (cur !== 0) {
			const prev = L[cur + PREV_DEP];
			unlink(cur, sub);
			cur = prev;
		}
	}

	function purgeDeps(sub: number): void {
		const depsTail = N[sub + DEPS_TAIL];
		let dep = depsTail !== 0 ? L[depsTail + NEXT_DEP] : N[sub + DEPS];
		while (dep !== 0) {
			dep = unlink(dep, sub);
		}
	}

	// ---- operations dispatched from the public wrappers ------------------------

	function newSignal(value: unknown): number {
		const id = allocNode(K_SIGNAL | MUTABLE);
		const v = id >> 2;
		values[v] = value; // currentValue
		values[v + 1] = value; // pendingValue
		return id;
	}

	function newComputed(getter: (previousValue?: unknown) => unknown): number {
		const id = allocNode(K_COMPUTED);
		fns[id >> 3] = getter;
		return id;
	}

	function newEffect(fn: () => (() => void) | void): number {
		const e = allocNode(K_EFFECT | WATCHING | RECURSED_CHECK);
		fns[e >> 3] = fn;
		const prevSub = activeSub;
		activeSub = e;
		if (prevSub !== 0) {
			link(e, prevSub, 0);
			N[prevSub + FLAGS] |= HAS_CHILD_EFFECT;
		}
		++enterDepth;
		try {
			++runDepth;
			values[(e >> 2) + 1] = fn();
		} finally {
			--runDepth;
			--enterDepth;
			activeSub = prevSub;
			N[e + FLAGS] &= ~RECURSED_CHECK;
		}
		return e;
	}

	function newScope(fn: () => void): number {
		const e = allocNode(K_SCOPE | MUTABLE);
		const prevSub = activeSub;
		activeSub = e;
		if (prevSub !== 0) {
			link(e, prevSub, 0);
			N[prevSub + FLAGS] |= HAS_CHILD_EFFECT;
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
		if (N[s + FLAGS] & DIRTY) {
			if (updateSignal(s)) {
				const subs = N[s + SUBS];
				if (subs !== 0) {
					shallowPropagate(subs);
				}
			}
		}
		if (activeSub !== 0) {
			link(s, activeSub, cycle);
		}
		return values[s >> 2];
	}

	// signalOper write path; the WRAPPER flushes (iff this returns true), so
	// growth can happen between queued effects at the top level (upstream
	// flushes inline here, only when the changed signal had subscribers).
	function write(s: number, value: unknown): boolean {
		const p = (s >> 2) + 1;
		if (values[p] !== (values[p] = value)) {
			N[s + FLAGS] = K_SIGNAL | MUTABLE | DIRTY;
			const subs = N[s + SUBS];
			if (subs !== 0) {
				propagate(subs, runDepth !== 0);
				return true;
			}
		}
		return false;
	}

	// computedOper.
	function computedRead(c: number): unknown {
		const flags = N[c + FLAGS];
		if (
			flags & DIRTY
			|| (
				flags & PENDING
				&& (
					checkDirty(N[c + DEPS], c)
					|| (N[c + FLAGS] = flags & ~PENDING, false)
				)
			)
		) {
			if (updateComputed(c)) {
				const subs = N[c + SUBS];
				if (subs !== 0) {
					shallowPropagate(subs);
				}
			}
		} else if (flags === K_COMPUTED) { // upstream `!flags`: never evaluated
			N[c + FLAGS] = K_COMPUTED | MUTABLE | RECURSED_CHECK;
			const prevSub = activeSub;
			activeSub = c;
			++enterDepth;
			try {
				values[c >> 2] = (fns[c >> 3] as () => unknown)();
			} finally {
				--enterDepth;
				activeSub = prevSub;
				N[c + FLAGS] &= ~RECURSED_CHECK;
			}
		}
		const sub = activeSub;
		if (sub !== 0) {
			link(c, sub, cycle);
		}
		return values[c >> 2];
	}
}

// ---- engine instance + growth ------------------------------------------------

const initialRecords = (() => {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
		.process?.env?.ARENA_PROBE_INITIAL_RECORDS;
	const n = env !== undefined ? Number(env) : NaN;
	return Number.isFinite(n) && n >= 2 ? Math.ceil(n) : 1 << 20;
})();

let E: Engine = createEngine(initialRecords, initialRecords * 2);

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
		let nodeRecords = E.nodeRecords;
		while (nodeNext > Math.min((nodeRecords * 8) >> 1, (nodeRecords - NODE_SLACK) * 8)) {
			nodeRecords *= 2;
		}
		let linkRecords = E.linkRecords;
		while (linkNext > Math.min((linkRecords * 8) >> 1, (linkRecords - LINK_SLACK) * 8)) {
			linkRecords *= 2;
		}
		if (nodeRecords !== E.nodeRecords || linkRecords !== E.linkRecords) {
			E = createEngine(nodeRecords, linkRecords, E.buffers());
		}
	}
}

function flush(): void {
	try {
		// PROBE boundary-lite: growth/reclamation only before the flush loop,
		// not between effects (risk: an effect chain can out-allocate slack).
		maybeBoundary();
		const engine = E;
		while (notifyIndex < queuedLength) {
			const e = queued[notifyIndex];
			queued[notifyIndex++] = 0;
			engine.run(e);
		}
	} finally {
		while (notifyIndex < queuedLength) {
			const e = queued[notifyIndex];
			queued[notifyIndex++] = 0;
			E.requeueAbort(e);
		}
		notifyIndex = 0;
		queuedLength = 0;
	}
}

// ---- public API ---------------------------------------------------------------

/** Callable signal handle: `s()` reads, `s(value)` writes. */
export interface SignalHandle<T> {
	(): T;
	(value: T): void;
}

export function signal<T>(): SignalHandle<T | undefined>;
export function signal<T>(initialValue: T): SignalHandle<T>;
export function signal<T>(initialValue?: T): SignalHandle<T | undefined> {
	maybeBoundary();
	const id = E.newSignal(initialValue);
	return function (...value: [T?]) {
		if (value.length) {
			// PROBE: write-entry boundary check removed (boundary at flush only)
			if (E.write(id, value[0]) && !batchDepth) {
				flush();
			}
		} else {
			return E.read(id) as T | undefined;
		}
	} as SignalHandle<T | undefined>;
}

export function computed<T>(getter: (previousValue?: T) => T): () => T {
	maybeBoundary();
	const id = E.newComputed(getter as (previousValue?: unknown) => unknown);
	return () => E.computedRead(id) as T;
}

/** Returns a disposer. `fn` may return a cleanup function. */
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

export function startBatch(): void {
	++batchDepth;
}

export function endBatch(): void {
	if (!--batchDepth && notifyIndex < queuedLength) {
		flush();
	}
}

export function untracked<T>(fn: () => T): T {
	const prevSub = activeSub;
	activeSub = 0;
	try {
		return fn();
	} finally {
		activeSub = prevSub;
	}
}

export function getActiveSub(): number {
	return activeSub;
}

export function setActiveSub(sub = 0): number {
	const prevSub = activeSub;
	activeSub = sub;
	return prevSub;
}
