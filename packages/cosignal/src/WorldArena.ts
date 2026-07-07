/**
 * WORLD ARENAS — the value, invalidation, AND routing layer for render and
 * committed worlds. One arena per world: packed stride-8 Int32 records (node
 * SHADOWS + dependency LINKS sharing one pool), value/suspension/walk side
 * columns, a dirty list, and the read clock. Arenas serve real world reads
 * (values + refolds through their own walks), route write-time deliveries
 * over strong links, seed durable drains from their dirty lists, and carry
 * the mount-fixup closure over reverse links. The full vocabulary (world,
 * fold, batch, watcher) is defined at the top of concurrent.ts.
 *
 * Layout discipline: ArenaField/ArenaLinkField/ArenaFlag/ArenaGeom/ArenaWalk
 * are SAME-FILE const enums — every hot arena walk lives in this module so
 * the members inline as literals under every esbuild-based toolchain. The
 * test referee reads the layout through `arenaCheckerLayout()` (data
 * passing), never through exported enums.
 *
 * Two layers, one module:
 *  - module level: the WorldArena record class and the transliterated walk
 *    family (arenaLink/arenaPropagate/arenaCheckDirty's free half…) — pure
 *    functions over one arena, kernel-twinned (see the TWINNING OBLIGATION
 *    below);
 *  - `createWorldArena`: the engine-facing serving/lifecycle layer (serve,
 *    refold, claim/release, fanout, decay, routing walks) as a factory in
 *    the kernel's own style — it closes over its state and assigns its
 *    operation table onto the one shared engine core record (World.ts
 *    `EngineCore`), whose late-bound slots resolve the World ⇄ arena ⇄
 *    settlement recursion at call time.
 */

import { NodeField, SuspendedRead, __kernelBuffer } from './index.js';
import { InvariantViolation } from './errors.js';
import type { EngineCore, World } from './World.js';
import type { AnyNode, AtomNode, ComputedNode, ArenaInitInts, Equals, NodeId, Reader, RootId, Value, Watcher } from './concurrent.js';

/** Dense per-node column key (NodeField.NODE_INDEX — see concurrent.ts). */
type NodeIndex = number;
/** A kernel record's GEN field value (id-tenancy stamp — see concurrent.ts). */
type Generation = number;
/** Per-walk visited generation (walk termination without Set allocations). */
type WalkGen = number;

/** A node record's tenancy generation, read live from kernel memory. The
 * buffer is re-fetched per read: kernel growth rebuilds swap it, and bridge
 * operations span growth boundaries. */
export function kernelGenOf(id: NodeId): Generation {
	return __kernelBuffer()[id + NodeField.GEN]!;
}

/** A node record's NODE_INDEX, read live from kernel memory. */
export function kernelNodeIndexOf(id: NodeId): NodeIndex {
	return __kernelBuffer()[id + NodeField.NODE_INDEX]!;
}

// ---- the arena layer (NF2, plans/2026-07-06 §4) -----------------------------------
// S-B (routing-authority transfer): the arenas are the value, invalidation,
// AND routing layer for render and committed worlds — shadow records +
// strong/weak links recorded by the arena fn-readers, folds into value
// columns, fanout marks at the four committed-truth flip sites, sentinel
// boxes + settlement, consumer-refcount reclamation at quiesce, write-time
// delivery over strong links, drain candidates off the dirty lists, and the
// mount-fixup closure over reverse (deps) links. The K1 episode edge log,
// its touched-word machinery, and the separate weak-edge table were DELETED
// at S-B; the newest memo table (the ladder's last arm) died at S-C, when
// every bridge computed re-keyed onto a kernel `Computed` record — the
// kernel serves newest, and the kernel's own dep links carry the newest
// strong walks (subscription reach, the fixup closure's kernel leg). When
// the test harness arms the divergence checker (tests/arena-checker.ts, fed
// through `__checkerInternals`), every
// public operation's epilogue serves each live arena's shadows FROM THE
// ARENA (its own transliterated walks) and compares against FOLD-TRUTH — a
// naive cache-free re-fold — ANY divergence throws. Layouts and walks are
// adapted from the spike prototype
// (research/experiments/world-tagged-links-spike-code/). ArenaField/ArenaLinkField/
// ArenaFlag below are
// the world arenas' OWN layout — bridge-owned, same-file so the hot arena
// walks (the arenaPropagate/arenaCheckDirty family) inline the members as literals
// under every toolchain. The shared field/bit names deliberately keep the
// kernel's numbering (the walks are transliterations of the kernel's
// propagate/checkDirty family and read best side by side), but nothing
// couples the two layouts: walks over KERNEL records use the kernel's own
// exported enums (index.ts NodeField/LinkField/NodeFlag — see
// kernelStrongDepsOf and closureOverKernel), and offsets 5-7 here mean
// shadow-specific things the kernel's fields don't.

/** World-arena node-record fields (bridge-owned layout — NOT the kernel's
 * NodeField/LinkField, whose offsets 5-7 mean different things; stride 8;
 * node-shadow and link records share the pool). */
const enum ArenaField {
	FLAGS = 0,
	DEPS = 1,
	DEPS_TAIL = 2,
	SUBS = 3,
	SUBS_TAIL = 4,
	NODE = 5, // the nodeIndex this shadows (dense column key; identity is the kernel record id)
	NODE_GEN = 6, // id-tenancy stamp: the node's KERNEL record GEN observed at recording
	MARK = 7, // fanout read-clock dedup stamp (§4.3)
}

/** World-arena link-record fields (link records share ArenaField's pool
 * and stride; offsets overlay the node-record fields). */
const enum ArenaLinkField {
	VERSION = 0,
	DEP = 1,
	SUB = 2,
	PREV_SUB = 3,
	NEXT_SUB = 4,
	PREV_DEP = 5,
	NEXT_DEP = 6,
	MODE = 7, // ArenaLinkMode bits — §4.4.1
	/** The free list threads through the VERSION field (FREE_NEXT aliases it):
	 * kernel row-2 discipline — a freed link must keep every field a walk
	 * still reads intact. arenaCheckDirty reads NEXT_DEP (and arenaShallowPropagate
	 * NEXT_SUB) off links a mid-walk purge freed, so those must keep naming
	 * former neighbors, never the free list. VERSION is genuinely dead on freed
	 * links: it is only written at link creation/reuse (arenaLink/arenaLinkInsert) and
	 * only read off LIVE links (the subs-tail dedup probe); every allocation
	 * path rewrites it before any read. Pinned by tests/arena-freelist.spec.ts. */
	FREE_NEXT = 0,
}

/** MODE field bits. */
const enum ArenaLinkMode {
	WEAK = 1, // bit 0: 1 = weak (untracked-read) link — §4.4.1
}

/** Shadow flag bits (bridge-owned; the shared names keep the kernel
 * NodeFlag numbering for side-by-side reading — see header note). */
const enum ArenaFlag {
	MUTABLE = 1,
	RECURSED_CHECK = 4,
	RECURSED = 8,
	DIRTY = 16,
	PENDING = 32,
	K_SIGNAL = 128,
	K_COMPUTED = 256,
	/** The value column holds a folded value (cold shadow when unset). */
	VALID = 8192,
	/** Value column holds an exceptional payload (thrown error, or sentinel). */
	HAS_BOX = 2048,
	/** Refines HAS_BOX: payload is the thenable's stable SuspendedRead. */
	BOX_SUSPENDED = 4096,
	/** Refines HAS_BOX: the payload was THROWN by the fn (render-path
	 * suspension or plain error) — serves rethrow the cached payload,
	 * boxedRead-style (§4.5.3; arenas serve real reads at S-B). Clear means
	 * a RETURNED sentinel (background suspensions fold to the sentinel
	 * VALUE), which serves as a value. Arena-local bit with no
	 * kernel NodeFlag counterpart (the kernel encodes the split differently). */
	BOX_THROWN = 16384,
}

/** Arena geometry. Same-file const enum members (not module consts): the
 * reads sit inside the hot arena walks and must inline as literals. */
const enum ArenaGeom {
	/** Int32 fields per record; record ids are premultiplied by this. */
	STRIDE = 8,
	/** record id >> ID_TO_COLUMN_SHIFT = value/susp column index */
	ID_TO_COLUMN_SHIFT = 3,
	/**
	 * Int32 stamp ceiling (S-D pooling hardening): `readClock` and `cycle` are
	 * JS numbers, but their stamps store into Int32Array fields (`ArenaField.MARK`,
	 * `ArenaLinkField.VERSION`) which truncate past 2^31-1 — a wrapped store could collide
	 * with a live stamp and dedup FALSE-POSITIVE (a skipped propagation or a
	 * dropped link: the dangerous direction). The bump helpers (arenaBumpReadClock,
	 * arenaBumpCycle) renumber BEFORE any store can wrap: stamps reset to 0
	 * (= stale), the clock restarts, and the next walk re-marks — at most one
	 * conservative re-walk per record per 2^31 events, amortized zero. (Margin
	 * under 2^31-1 is cosmetic headroom; bumps route through the helpers, so
	 * the clocks never reach the ceiling.)
	 */
	CLOCK_LIMIT = 0x7fff0000,
}

/** Bounds the arena pool: releaseArena keeps at most this many scrubbed shells (further releases drop the shell). */
const ARENA_POOL_CAP = 8;
const EMPTY_I32 = new Int32Array(0);

/**
 * One world's arena: packed records, a value
 * side column, a per-shadow suspended-list index column, a dirty list, and
 * the read clock. Pooled: buffers return to the pool at release, where the
 * FULL SCRUB (releaseArena: written prefix + every side column zeroed) is
 * what makes dead-tenancy residue unable to validate; `claimGen` is the
 * tenancy diagnostic (bumped at claim AND release, monotone per shell —
 * a float64 counter, exact to 2^53, so it has no wrap surface).
 */
export class WorldArena {
	kind: 'render' | 'committed';
	/** Owning world (render object or committed root) — folds cite it. */
	world: World;
	root: RootId; // committed: the root id; render: the render's root (diagnostics)
	alive = true;
	/** Pool claim generation (bumped at claim AND release). */
	claimGen = 0;
	memory: Int32Array;
	vals: Value[] = [];
	/** Per-record suspended-list slot + 1 (0 = not suspended) — §4.5.4 step-0
	 * compaction: the field IS the set bit and stores the dense index. */
	suspIdx: number[] = [];
	/** Per-record walk-generation stamps (S-B routing walks: delivery reach,
	 * drain candidate collection, fixup closure) — termination + O(V+E)
	 * without allocation, per §4.4.3. Compared against the bridge's global
	 * walk generation; scrubbed at release like the other side columns. */
	walk: number[] = [];
	/** THE SEGREGATED WEAK SUBS LIST (§4.4.1's recorded fallback, DECIDED BY
	 * THE UNTRACKED-FAN GATE at S-B: the combined-list walk measured 4.9× the
	 * head-bridge anchor on the K=100 × R=4 write-storm shape — every write
	 * visited-and-skipped 400 weak links). Weak-flagged links live on a
	 * per-shadow SECOND subs list (head + tail side columns, record ids;
	 * same link-record layout): the delivery walk traverses the STRONG list
	 * (ArenaField.SUBS) only and never sees a weak link; mark propagation and drain
	 * candidate collection walk both. §4.4.1's mode transitions (first-
	 * occurrence reset, strong-dominates) MOVE a link between the lists. */
	weakSubs: number[] = [];
	weakSubsTail: number[] = [];
	next = ArenaGeom.STRIDE; // bump pointer (record 0 burned: 0 = null)
	linkFree = 0;
	/** Dead-SHADOW free list head (leak audit): record ids threaded through
	 * ArenaField.DEPS of records `disposeComputed`'s eager purge orphaned — the one
	 * site that kills a shadow record mid-tenancy (the dead-GEN path re-keys
	 * records in place). Records join FULLY ZEROED (nodeToShadow cleared, links
	 * purged, unsuspended), so nothing can reach one until arenaAllocShadow
	 * re-issues it; without this list the bump pointer grew a LIVE arena by
	 * one record per useComputed recreation, forever
	 * (tests/leak-audit.spec.ts pins the boundedness). */
	shadowFree = 0;
	links = 0;
	/** nodeIndex → shadow record id (0 = none; index 0 is burned). */
	nodeToShadow: number[] = [];
	/** Marked-shadow list (record ids; appended on the DIRTY 0→1 edge). */
	dirty: number[] = [];
	/** Suspended-shadow list (record ids; dense — swap-remove compaction). */
	suspended: number[] = [];
	/** Fanout dedup clock: bumped on every arena consumption (§4.3). */
	readClock = 0;
	/** Per-arena evaluation cycle (link VERSION stamps). */
	cycle = 0;

	constructor(kind: 'render' | 'committed', world: World, root: RootId, buf: Int32Array) {
		this.kind = kind;
		this.world = world;
		this.root = root;
		this.memory = buf;
	}
}

/** Renumber the read clock: MARK → 0 on every live shadow record, clock
 * restarts at 0 — the exact quiesce-duty state (§4.5.7), where "marks 0 /
 * clock 0" is proven sound: a dedup hit in that state claims an
 * already-marked cone whose PENDING flags persist, and any intervening
 * consumption bumps the clock away from 0. Link records are skipped by the
 * nodeToShadow round-trip guard (their slot 7 is MODE, not MARK). */
export function arenaRenumberMarks(a: WorldArena): void {
	for (let sh = ArenaGeom.STRIDE; sh < a.next; sh += ArenaGeom.STRIDE) {
		if ((a.memory[sh + ArenaField.NODE] ?? 0) !== 0 && a.nodeToShadow[a.memory[sh + ArenaField.NODE]!] === sh) a.memory[sh + ArenaField.MARK] = 0;
	}
	a.readClock = 0;
}

function arenaBumpReadClock(a: WorldArena): void {
	if (a.readClock >= ArenaGeom.CLOCK_LIMIT) arenaRenumberMarks(a);
	a.readClock++;
}

/** Renumber evaluation-cycle stamps: VERSION → 0 on every LIVE link (each
 * lives on exactly one deps chain), cycle restarts at 0. VERSION is only
 * compared for SAME-evaluation link dedup, so a zeroed stamp just reads as
 * "stale from an old evaluation" — the normal case. Freed links are never
 * touched: their VERSION aliases the free-list thread (FREE_NEXT). An open
 * outer frame keeps stamping its saved (≥ limit) cycle, which post-renumber
 * cycles can never reach again before the next renumber — no collision. */
function arenaRenumberLinkVersions(a: WorldArena): void {
	const memory = a.memory;
	for (let sh = ArenaGeom.STRIDE; sh < a.next; sh += ArenaGeom.STRIDE) {
		if ((memory[sh + ArenaField.NODE] ?? 0) !== 0 && a.nodeToShadow[memory[sh + ArenaField.NODE]!] === sh) {
			for (let l = memory[sh + ArenaField.DEPS]!; l !== 0; l = memory[l + ArenaLinkField.NEXT_DEP]!) memory[l + ArenaLinkField.VERSION] = 0;
		}
	}
	a.cycle = 0;
}

function arenaBumpCycle(a: WorldArena): number {
	if (a.cycle >= ArenaGeom.CLOCK_LIMIT) arenaRenumberLinkVersions(a);
	return ++a.cycle;
}

function arenaGrow(a: WorldArena, need: number): void {
	let len = a.memory.length;
	while (len < need) len *= 2;
	if (len !== a.memory.length) {
		const bigger = new Int32Array(len);
		bigger.set(a.memory);
		a.memory = bigger; // growth-mid-op: every allocating call site re-loads a.memory (§4.5.9)
	}
}

function arenaAllocShadow(a: WorldArena, ix: NodeIndex, flags: number, gen: number): number {
	let id = a.shadowFree;
	if (id !== 0) {
		// Reuse a dead-shadow record (see WorldArena.shadowFree): it was
		// zeroed wholesale when it joined the list, its side columns were
		// scrubbed by the evict (vals/suspIdx) and the unlinks (weak heads),
		// and its walk stamp is stale by generation monotonicity — so once
		// the thread field clears, the fresh-record invariant below holds.
		a.shadowFree = a.memory[id + ArenaField.DEPS]!;
		a.memory[id + ArenaField.DEPS] = 0;
	} else {
		id = a.next;
		arenaGrow(a, id + ArenaGeom.STRIDE);
		a.next = id + ArenaGeom.STRIDE;
	}
	const memory = a.memory;
	// Fresh-record invariant (B1 cold-render shave): memory[a.next..] is ALL ZERO —
	// a fresh Int32Array is zeroed, arenaGrow's replacement buffer is zeroed past
	// the copied prefix, and releaseArena scrubs the dead tenancy's whole
	// written prefix [0, next) before the buffer pools. So the list heads
	// (DEPS/DEPS_TAIL/SUBS/SUBS_TAIL) and MARK are already 0 here, and the
	// bump allocator never re-issues a record id mid-tenancy — only the
	// tenant fields need stores. (The freelist re-issues LINK records, whose
	// creation paths write every field — tests/arena-freelist.spec.ts.)
	memory[id + ArenaField.FLAGS] = flags;
	memory[id + ArenaField.NODE] = ix;
	memory[id + ArenaField.NODE_GEN] = gen;
	const v = id >> ArenaGeom.ID_TO_COLUMN_SHIFT;
	while (a.vals.length <= v) {
		a.vals.push(undefined);
		a.suspIdx.push(0);
		a.walk.push(0);
		a.weakSubs.push(0);
		a.weakSubsTail.push(0);
	}
	while (a.nodeToShadow.length <= ix) a.nodeToShadow.push(0); // stay packed, never holey
	a.nodeToShadow[ix] = id;
	return id;
}

function arenaAllocLink(a: WorldArena): number {
	let id = a.linkFree;
	if (id !== 0) {
		a.linkFree = a.memory[id + ArenaLinkField.FREE_NEXT]!;
	} else {
		id = a.next;
		arenaGrow(a, id + ArenaGeom.STRIDE);
		a.next = id + ArenaGeom.STRIDE;
	}
	a.links++;
	return id;
}

function arenaFreeLink(a: WorldArena, id: number): void {
	a.memory[id + ArenaLinkField.FREE_NEXT] = a.linkFree;
	a.linkFree = id;
	a.links--;
}

/** Detach a link from its dep's subs list (the MODE-matching one). Fixes
 * neighbors and the head/tail columns only — the link's OWN prev/next stay
 * stale (row-2 discipline: mid-walk readers must keep seeing former
 * neighbors; movers rewrite them in arenaSubsAppend, and freed links never
 * revalidate). */
function arenaSubsDetach(a: WorldArena, id: number): void {
	const memory = a.memory;
	const dep = memory[id + ArenaLinkField.DEP]!;
	const nextSub = memory[id + ArenaLinkField.NEXT_SUB]!;
	const prevSub = memory[id + ArenaLinkField.PREV_SUB]!;
	const weak = (memory[id + ArenaLinkField.MODE]! & ArenaLinkMode.WEAK) !== 0;
	if (nextSub !== 0) memory[nextSub + ArenaLinkField.PREV_SUB] = prevSub;
	else if (weak) a.weakSubsTail[dep >> ArenaGeom.ID_TO_COLUMN_SHIFT] = prevSub;
	else memory[dep + ArenaField.SUBS_TAIL] = prevSub;
	if (prevSub !== 0) memory[prevSub + ArenaLinkField.NEXT_SUB] = nextSub;
	else if (weak) a.weakSubs[dep >> ArenaGeom.ID_TO_COLUMN_SHIFT] = nextSub;
	else memory[dep + ArenaField.SUBS] = nextSub;
}

/** Append a link to its dep's MODE-matching subs list tail (sets the
 * link's own prev/next and mode). */
function arenaSubsAppend(a: WorldArena, id: number, weak: boolean): void {
	const memory = a.memory;
	const dep = memory[id + ArenaLinkField.DEP]!;
	const vi = dep >> ArenaGeom.ID_TO_COLUMN_SHIFT;
	const tail = weak ? a.weakSubsTail[vi]! : memory[dep + ArenaField.SUBS_TAIL]!;
	memory[id + ArenaLinkField.MODE] = weak ? ArenaLinkMode.WEAK : 0;
	memory[id + ArenaLinkField.PREV_SUB] = tail;
	memory[id + ArenaLinkField.NEXT_SUB] = 0;
	if (tail !== 0) memory[tail + ArenaLinkField.NEXT_SUB] = id;
	else if (weak) a.weakSubs[vi] = id;
	else memory[dep + ArenaField.SUBS] = id;
	if (weak) a.weakSubsTail[vi] = id;
	else memory[dep + ArenaField.SUBS_TAIL] = id;
}

/** Set a live link's mode; a change MOVES it between the dep's two subs
 * lists (§4.4.1's transitions under the segregated-list fallback). */
function arenaSetLinkWeak(a: WorldArena, id: number, weak: boolean): void {
	if (((a.memory[id + ArenaLinkField.MODE]! & ArenaLinkMode.WEAK) !== 0) === weak) return;
	arenaSubsDetach(a, id);
	arenaSubsAppend(a, id, weak);
}

/**
 * TWINNING OBLIGATION (the other half of the note above index.ts's
 * "system.ts transliteration" section): these `a`-prefixed walks re-state
 * the kernel's push-pull algorithms over the arena layout. A semantic
 * change on either side must be re-derived — not copied — on the other.
 *
 * Link maintenance (transliterated) PLUS §4.4.1's mode discipline, which
 * the transliteration source lacked and may not be transplanted bare:
 * the FIRST occurrence of a dep in an evaluation SETS the link's mode from
 * that occurrence's read kind (fresh and REUSED links alike — the in-place
 * and tail fast paths below perform the write); a LATER occurrence may only
 * upgrade weak→strong, never downgrade. Mode writes route through arenaSetLinkWeak:
 * under the segregated-list fallback a mode change moves the link between
 * the dep's strong and weak subs lists.
 */
function arenaLink(a: WorldArena, dep: number, sub: number, version: number, weak: boolean): void {
	const memory = a.memory;
	const prevDep = memory[sub + ArenaField.DEPS_TAIL]!;
	if (prevDep !== 0 && memory[prevDep + ArenaLinkField.DEP] === dep) {
		// Duplicate occurrence within this evaluation: strong dominates.
		if (!weak) arenaSetLinkWeak(a, prevDep, false);
		return;
	}
	const nextDep = prevDep !== 0 ? memory[prevDep + ArenaLinkField.NEXT_DEP]! : memory[sub + ArenaField.DEPS]!;
	if (nextDep !== 0 && memory[nextDep + ArenaLinkField.DEP] === dep) {
		// In-place reuse: first occurrence this evaluation — reset the mode.
		memory[nextDep + ArenaLinkField.VERSION] = version;
		arenaSetLinkWeak(a, nextDep, weak);
		memory[sub + ArenaField.DEPS_TAIL] = nextDep;
		return;
	}
	arenaLinkInsert(a, dep, sub, version, weak, prevDep, nextDep);
}

function arenaLinkInsert(a: WorldArena, dep: number, sub: number, version: number, weak: boolean, prevDep: number, nextDep: number): void {
	// Same-evaluation duplicate arriving via the insert path (nonadjacent
	// re-read): probe BOTH mode tails; strong dominates.
	const sTail = a.memory[dep + ArenaField.SUBS_TAIL]!;
	if (sTail !== 0 && a.memory[sTail + ArenaLinkField.VERSION] === version && a.memory[sTail + ArenaLinkField.SUB] === sub) {
		return; // already strong this evaluation
	}
	const wTail = a.weakSubsTail[dep >> ArenaGeom.ID_TO_COLUMN_SHIFT]!;
	if (wTail !== 0 && a.memory[wTail + ArenaLinkField.VERSION] === version && a.memory[wTail + ArenaLinkField.SUB] === sub) {
		if (!weak) arenaSetLinkWeak(a, wTail, false); // upgrade weak→strong
		return;
	}
	const newLink = arenaAllocLink(a); // may grow the arena: re-load memory after
	const memory = a.memory;
	memory[sub + ArenaField.DEPS_TAIL] = newLink;
	memory[newLink + ArenaLinkField.VERSION] = version;
	memory[newLink + ArenaLinkField.DEP] = dep;
	memory[newLink + ArenaLinkField.SUB] = sub;
	memory[newLink + ArenaLinkField.PREV_DEP] = prevDep;
	memory[newLink + ArenaLinkField.NEXT_DEP] = nextDep;
	if (nextDep !== 0) memory[nextDep + ArenaLinkField.PREV_DEP] = newLink;
	if (prevDep !== 0) memory[prevDep + ArenaLinkField.NEXT_DEP] = newLink;
	else memory[sub + ArenaField.DEPS] = newLink;
	arenaSubsAppend(a, newLink, weak); // subs-side wiring + mode, on the matching list
}

function arenaUnlink(a: WorldArena, id: number, sub: number = a.memory[id + ArenaLinkField.SUB]!): number {
	const memory = a.memory;
	const dep = memory[id + ArenaLinkField.DEP]!;
	const prevDep = memory[id + ArenaLinkField.PREV_DEP]!;
	const nextDep = memory[id + ArenaLinkField.NEXT_DEP]!;
	if (nextDep !== 0) memory[nextDep + ArenaLinkField.PREV_DEP] = prevDep;
	else memory[sub + ArenaField.DEPS_TAIL] = prevDep;
	if (prevDep !== 0) memory[prevDep + ArenaLinkField.NEXT_DEP] = nextDep;
	else memory[sub + ArenaField.DEPS] = nextDep;
	arenaSubsDetach(a, id); // mode-matching subs list; the freed link keeps stale pointers (row 2)
	arenaFreeLink(a, id);
	if (memory[dep + ArenaField.SUBS] === 0 && a.weakSubs[dep >> ArenaGeom.ID_TO_COLUMN_SHIFT] === 0 && (memory[dep + ArenaField.FLAGS]! & ArenaFlag.K_COMPUTED) !== 0) {
		// Unwatched computed shadow (BOTH subs lists empty): mark stale, tear
		// down its own deps (in-world cascade — per-view acyclicity makes
		// this terminate).
		if (memory[dep + ArenaField.DEPS_TAIL] !== 0) {
			// Dirty-LIST append on the mark's 0→1 edge (the a.dirty contract;
			// the armed validator — tests/arena-checker.ts — enforces DIRTY ⇒
			// listed, and decay drops the torn
			// shadow to cold from the list). This was the one DIRTY-setting
			// site that skipped the append — the armed validator catches it
			// the first time a last-sub unlink tears a computed with deps.
			if ((memory[dep + ArenaField.FLAGS]! & ArenaFlag.DIRTY) === 0) {
				a.dirty.push(dep);
			}
			memory[dep + ArenaField.FLAGS] = memory[dep + ArenaField.FLAGS]! | ArenaFlag.DIRTY;
			arenaDisposeAllDepsInReverse(a, dep);
		}
	}
	return nextDep;
}

function arenaDisposeAllDepsInReverse(a: WorldArena, sub: number): void {
	let cur = a.memory[sub + ArenaField.DEPS_TAIL]!;
	while (cur !== 0) {
		const prev = a.memory[cur + ArenaLinkField.PREV_DEP]!;
		arenaUnlink(a, cur, sub);
		cur = prev;
	}
}

/** Bounds every arena chain/graph walk's step count — a longer walk can only
 * be a corrupted-list cycle, so the guards throw. Same-file const enum member
 * (not a module const): the comparison sits inside the hot walk loops and
 * must inline as a literal. */
const enum ArenaWalk {
	CYCLE_CAP = 1_000_000,
}

/** Purge links not re-tracked by the current evaluation (kernel discipline). */
function arenaPurgeDeps(a: WorldArena, sub: number): void {
	const depsTail = a.memory[sub + ArenaField.DEPS_TAIL]!;
	let dep = depsTail !== 0 ? a.memory[depsTail + ArenaLinkField.NEXT_DEP]! : a.memory[sub + ArenaField.DEPS]!;
	let guard = 0;
	while (dep !== 0) {
		if (++guard > ArenaWalk.CYCLE_CAP) throw new InvariantViolation(`arenaPurgeDeps: deps chain cycle at link ${dep} (shadow ${sub})`);
		dep = arenaUnlink(a, dep, sub);
	}
}

/** Seed capacity (entries) of the walk scratch stacks below (they double on demand). */
const WALK_STACK_SEED = 4096;

// Arena-walk scratch stacks (module-owned; the routing walks use the
// factory's own buffers instead).
let arenaPropStack = new Int32Array(WALK_STACK_SEED);
let arenaPropSp = 0;
let arenaCheckStack = new Int32Array(WALK_STACK_SEED);
let arenaCheckSp = 0;

/** Out-of-line cycle-cap thrower (keeps the walk arms' inline bytecode
 * free of the message-building code — cold by definition). */
function arenaWalkCycle(site: string, cur: number): never {
	throw new InvariantViolation(`${site}: walk exceeded ${ArenaWalk.CYCLE_CAP} steps (cycle) at link ${cur}`);
}

/** Propagate PENDING over strong AND weak links
 * (§4.4.1: weak links participate in mark propagation and drains — only the
 * write-time delivery walk skips them). Under the segregated-list fallback
 * each descended sub contributes TWO chains: the strong list is walked
 * first and the weak head is pushed as a pending continuation (the same
 * stack mechanism that holds sibling continuations). */
function arenaPropagate(a: WorldArena, startLink: number): void {
	const memory = a.memory; // never allocates: safe to cache
	let cur = startLink;
	let next = memory[cur + ArenaLinkField.NEXT_SUB]!;
	const stackBase = arenaPropSp;
	let guard = 0;
	top: do {
		if (++guard > ArenaWalk.CYCLE_CAP) arenaWalkCycle('arenaPropagate', cur);
		const sub = memory[cur + ArenaLinkField.SUB]!;
		let flags = memory[sub + ArenaField.FLAGS]!;
		if (!(flags & (ArenaFlag.RECURSED_CHECK | ArenaFlag.RECURSED | ArenaFlag.DIRTY | ArenaFlag.PENDING))) {
			memory[sub + ArenaField.FLAGS] = flags | ArenaFlag.PENDING;
		} else if (!(flags & (ArenaFlag.RECURSED_CHECK | ArenaFlag.RECURSED))) {
			flags = 0;
		} else if (!(flags & ArenaFlag.RECURSED_CHECK)) {
			memory[sub + ArenaField.FLAGS] = (flags & ~ArenaFlag.RECURSED) | ArenaFlag.PENDING;
		} else if (!(flags & (ArenaFlag.DIRTY | ArenaFlag.PENDING)) && arenaIsValidLink(a, cur, sub)) {
			memory[sub + ArenaField.FLAGS] = flags | (ArenaFlag.RECURSED | ArenaFlag.PENDING);
			flags &= ArenaFlag.MUTABLE;
		} else {
			flags = 0;
		}
		if (flags & ArenaFlag.MUTABLE) {
			let subSubs = memory[sub + ArenaField.SUBS]!;
			const subWeak = a.weakSubs[sub >> ArenaGeom.ID_TO_COLUMN_SHIFT]!;
			let park = 0; // the weak head, parked when both lists are populated
			if (subWeak !== 0) {
				if (subSubs === 0) subSubs = subWeak; // only weak dependents: descend into them
				else park = subWeak;
			}
			if (subSubs !== 0) {
				cur = subSubs;
				const nextSub = memory[cur + ArenaLinkField.NEXT_SUB]!;
				if (nextSub !== 0 || park !== 0) {
					if (arenaPropSp + 2 > arenaPropStack.length) {
						const bigger = new Int32Array(arenaPropStack.length * 2);
						bigger.set(arenaPropStack);
						arenaPropStack = bigger;
					}
					if (park !== 0) arenaPropStack[arenaPropSp++] = park;
					if (nextSub !== 0) {
						arenaPropStack[arenaPropSp++] = next;
						next = nextSub;
					}
				}
				continue;
			}
		}
		if ((cur = next) !== 0) {
			next = memory[cur + ArenaLinkField.NEXT_SUB]!;
			continue;
		}
		while (arenaPropSp > stackBase) {
			cur = arenaPropStack[--arenaPropSp]!;
			if (cur !== 0) {
				next = memory[cur + ArenaLinkField.NEXT_SUB]!;
				continue top;
			}
		}
		break;
	} while (true);
}

/** Head of a shadow's subs list by index: 0 = strong (arena links), 1 = weak
 * (the side column) — the one place the `for (list 0..1)` walk sites learn
 * where the two lists live. (arenaPropagateBoth/arenaShallowBoth below read the
 * heads directly: they are the write-fanout hot path.) */
function arenaSubsHead(a: WorldArena, sh: number, list: number): number {
	return list === 0 ? a.memory[sh + ArenaField.SUBS]! : a.weakSubs[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT]!;
}

/** Seed arenaPropagate over BOTH of a shadow's subs lists (fanout sites). */
function arenaPropagateBoth(a: WorldArena, sh: number): void {
	const subs = a.memory[sh + ArenaField.SUBS]!;
	if (subs !== 0) arenaPropagate(a, subs);
	const weak = a.weakSubs[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT]!;
	if (weak !== 0) arenaPropagate(a, weak);
}

function arenaShallowPropagate(a: WorldArena, startLink: number): void {
	const memory = a.memory;
	let cur = startLink;
	let guard = 0;
	do {
		if (++guard > ArenaWalk.CYCLE_CAP) throw new InvariantViolation(`arenaShallowPropagate: subs chain cycle at link ${cur}`);
		const sub = memory[cur + ArenaLinkField.SUB]!;
		const flags = memory[sub + ArenaField.FLAGS]!;
		if ((flags & (ArenaFlag.PENDING | ArenaFlag.DIRTY)) === ArenaFlag.PENDING) {
			memory[sub + ArenaField.FLAGS] = flags | ArenaFlag.DIRTY;
			// Dirty-LIST append on the DIRTY 0→1 edge (the a.dirty contract:
			// DIRTY ⇒ listed — decay and drain seeding both stand on it). At
			// S-A this site's upgrades were always consumed within the same
			// checker pass; S-B serves arenas mid-operation, so an upgraded
			// shadow can reach a boundary unconsumed and MUST be listed.
			a.dirty.push(sub);
		}
	} while ((cur = memory[cur + ArenaLinkField.NEXT_SUB]!) !== 0);
}

/** Shallow-propagate over BOTH of a shadow's subs lists (weak dependents
 * take the PENDING→DIRTY upgrade too — validation coverage, §4.4.1). */
function arenaShallowBoth(a: WorldArena, sh: number): void {
	const subs = a.memory[sh + ArenaField.SUBS]!;
	if (subs !== 0) arenaShallowPropagate(a, subs);
	const weak = a.weakSubs[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT]!;
	if (weak !== 0) arenaShallowPropagate(a, weak);
}

function arenaIsValidLink(a: WorldArena, checkLink: number, sub: number): boolean {
	const memory = a.memory;
	let cur = memory[sub + ArenaField.DEPS_TAIL]!;
	let guard = 0;
	while (cur !== 0) {
		if (++guard > ArenaWalk.CYCLE_CAP) throw new InvariantViolation(`arenaIsValidLink: prev-dep chain cycle at link ${cur}`);
		if (cur === checkLink) return true;
		cur = memory[cur + ArenaLinkField.PREV_DEP]!;
	}
	return false;
}

/**
 * The serve-override slot's non-arena occupant (W3): while `serveOverride`
 * holds this marker, routed atom reads fold plain from their write logs in the
 * frame's world — no arena, no kernel shortcut — the armed divergence
 * checker's reference discipline (tests/arena-checker.ts compares arena
 * serves against these folds, so its reads must never consult the state
 * under check). Production never sets it; it exists so the routed-read hot
 * path tests ONE override slot instead of two.
 */
export const FOLD_TRUTH = Symbol('cosignal.foldTruth');

/** The arena record layout as plain numbers, restricted to the fields the
 * test referee's structural validator reads (`ArenaCheckerInternals.layout`
 * — concurrent.ts documents the data-passing decision). Built HERE, in the
 * enums' own file, so the view is in sync by construction; a fresh object
 * per call, exactly as the in-class construction allocated. */
export function arenaCheckerLayout(): {
	readonly ArenaGeom: { readonly ID_TO_COLUMN_SHIFT: number; readonly CLOCK_LIMIT: number };
	readonly ArenaField: { readonly NODE: number; readonly MARK: number; readonly FLAGS: number; readonly DEPS: number; readonly SUBS: number };
	readonly ArenaLinkField: { readonly DEP: number; readonly SUB: number; readonly PREV_DEP: number; readonly NEXT_DEP: number; readonly NEXT_SUB: number; readonly MODE: number };
	readonly ArenaLinkMode: { readonly WEAK: number };
	readonly ArenaFlag: { readonly DIRTY: number; readonly BOX_SUSPENDED: number };
} {
	return {
		ArenaGeom: { ID_TO_COLUMN_SHIFT: ArenaGeom.ID_TO_COLUMN_SHIFT, CLOCK_LIMIT: ArenaGeom.CLOCK_LIMIT },
		ArenaField: { NODE: ArenaField.NODE, MARK: ArenaField.MARK, FLAGS: ArenaField.FLAGS, DEPS: ArenaField.DEPS, SUBS: ArenaField.SUBS },
		ArenaLinkField: { DEP: ArenaLinkField.DEP, SUB: ArenaLinkField.SUB, PREV_DEP: ArenaLinkField.PREV_DEP, NEXT_DEP: ArenaLinkField.NEXT_DEP, NEXT_SUB: ArenaLinkField.NEXT_SUB, MODE: ArenaLinkField.MODE },
		ArenaLinkMode: { WEAK: ArenaLinkMode.WEAK },
		ArenaFlag: { DIRTY: ArenaFlag.DIRTY, BOX_SUSPENDED: ArenaFlag.BOX_SUSPENDED },
	};
}

/**
 * The arena serving/lifecycle layer — a factory in the kernel's own style:
 * closes over the arena registries (committed arenas by root, the shell
 * pool, the open evaluation frame, the routing-walk scratch) and assigns its
 * operation table onto the shared engine core record. Cross-module calls
 * (the World fold family, the fold-purity bracket, read-routing state) read
 * the core's late-bound slots at call time — never import-time references —
 * which is what closes the evaluate → arenaServe → foldAtom recursion.
 */
export function createWorldArena(core: EngineCore): void {
	// Stable resident columns/registries, aliased once (identity-shared).
	const nodesArr = core.nodesArr;
	const nodeToWatchers = core.nodeToWatchers;
	const lastWalk = core.lastWalk;
	const obsRefs = core.obsRefs;
	const obsSyncDeps = core.obsSyncDeps;
	const roots = core.roots;
	const rootToOpenRender = core.rootToOpenRender;
	/** Committed arenas, by root (consumer-populated life — §4.1/§4.5.8). */
	const rootToArena = core.rootToArena;
	/** Pooled released arena shells (buffers reused; claimGen bumped per tenancy). */
	const arenaPool = core.arenaPool;
	/** Initial arena size in ints (BridgeOptions knob; tests shrink it to force mid-op growth — §4.5.9). */
	const arenaInitInts: ArenaInitInts = core.arenaInitInts;

	/** Open arena evaluation frame (piggybacked on the overlay evaluation OR
	 * an arena-only refold): links record into arenaFrame at arenaFrameCycle.
	 * Flattened to scalars — one object per evaluation showed up in the
	 * cold-render gate. undefined arena ⇔ no frame. */
	let arenaFrame: WorldArena | undefined = undefined;
	let arenaFrameShadow = 0;
	let arenaFrameCycle = 0;

	function claimArena(kind: 'render' | 'committed', world: World, root: RootId): WorldArena {
		let a = arenaPool.pop();
		if (a === undefined) {
			a = new WorldArena(kind, world, root, new Int32Array(arenaInitInts));
		} else {
			a.kind = kind;
			a.world = world;
			a.root = root;
		}
		a.alive = true;
		a.claimGen++;
		// Dense nodeToShadow: pre-size to the node population and keep it PACKED
		// (holey reads cost on the cold-read hot path; shadowFor probes this
		// per read). arenaAllocShadow grows it densely past this watermark.
		const n = nodesArr.length;
		for (let i = a.nodeToShadow.length; i < n; i++) a.nodeToShadow.push(0);
		return a;
	}

	/** Release an arena: buffer to the pool, claim generation bumped, columns
	 * dropped (payload release), dirty + suspended lists discarded (§4.5.8 —
	 * safe by the evict-don't-serve argument; nobody observes those cones). */
	function releaseArena(a: WorldArena): void {
		for (let i = 0; i < a.suspended.length; i++) core.suspendedCount--;
		a.alive = false;
		a.claimGen++;
		// Keep the side columns' CAPACITY across pool tenancies (B1 cold-render
		// shave): truncating to 0 forced claimArena + arenaAllocShadow to re-push
		// every element on every claim (~2k pushes per cold render). fill()
		// scrubs the residue the truncation used to drop — value refs are
		// released (no pooled-arena leak), nodeToShadow reads 0 (= none), suspIdx
		// reads 0 (= not suspended) — while the packed length persists, so
		// the next tenancy's growth loops are no-ops up to this watermark.
		a.nodeToShadow.fill(0);
		a.vals.fill(undefined);
		a.suspIdx.fill(0);
		a.walk.fill(0);
		a.weakSubs.fill(0);
		a.weakSubsTail.fill(0);
		a.dirty.length = 0;
		a.suspended.length = 0;
		// Scrub the written record prefix so pooled buffers re-claim ALL-ZERO
		// past the burned record — arenaAllocShadow's fresh-record invariant (one
		// vectorized fill here beats per-field zeroing on every cold alloc,
		// and closes the pooled-residue class wholesale: nothing survives).
		a.memory.fill(0, 0, a.next);
		a.next = ArenaGeom.STRIDE;
		a.linkFree = 0;
		a.shadowFree = 0; // dead-shadow list dies with the tenancy (threads were zeroed above)
		a.links = 0;
		a.readClock = 0;
		a.cycle = 0;
		if (arenaPool.length < ARENA_POOL_CAP) arenaPool.push(a);
	}

	/** The arena of a world: render arenas ride the render record (claimed at
	 * renderStart, m2's dev assert on dropped-arena touch); committed arenas
	 * materialize lazily at the root's first committed evaluation and persist
	 * for the root's consumer-populated life (§4.1). */
	function arenaOf(world: World): WorldArena | undefined {
		if (world.kind === 'render') {
			const a = world.render.arena;
			if (a !== undefined && !a.alive) throw new InvariantViolation(`arena of render pass ${world.render.id} was reclaimed while still reachable (m2)`);
			return a;
		}
		if (world.kind !== 'committed') return undefined;
		let a = rootToArena.get(world.root);
		if (a === undefined) {
			// Mirror memoTableOf's rule: never CREATE the root record here.
			if (!roots.has(world.root)) return undefined;
			a = claimArena('committed', { kind: 'committed', root: world.root }, world.root);
			rootToArena.set(world.root, a);
		}
		return a;
	}

	function eachArena(fn: (a: WorldArena) => void): void {
		for (const a of rootToArena.values()) fn(a);
		for (const p of rootToOpenRender.values()) {
			if (p.arena !== undefined) fn(p.arena);
		}
	}

	/** Shadow lookup/create with the GEN id-tenancy validation (the stamp is
	 * the KERNEL record generation since the id-space merge): a dead-GEN
	 * shadow never serves — it is reset cold and re-tenanted. */
	function shadowFor(a: WorldArena, node: AnyNode, kindFlags: number): number {
		const ix = node.ix;
		let sh = ix < a.nodeToShadow.length ? a.nodeToShadow[ix]! : 0;
		const gen = kernelGenOf(node.id); // one kernel-memory load per consult (priced by the bench trio)
		if (sh !== 0) {
			if (a.memory[sh + ArenaField.NODE_GEN] === gen) return sh;
			// Dead tenancy: evict, purge links (both directions, both subs
			// lists), refold under the new tenant — never serve the dead
			// node's value or fn.
			arenaEvictShadow(a, sh);
			a.memory[sh + ArenaField.FLAGS] = kindFlags;
			a.memory[sh + ArenaField.NODE_GEN] = gen;
			a.memory[sh + ArenaField.MARK] = 0;
			return sh;
		}
		sh = arenaAllocShadow(a, ix, kindFlags, gen);
		return sh;
	}

	/** Detach a shadow from its arena wholesale: deps in reverse, BOTH subs
	 * lists, the suspended set, the cached value. Shared by shadowFor's
	 * dead-tenancy re-key (§4.5.3) and disposeComputed's eager purge. */
	function arenaEvictShadow(a: WorldArena, sh: number): void {
		arenaDisposeAllDepsInReverse(a, sh);
		for (let list = 0; list < 2; list++) {
			let sl = arenaSubsHead(a, sh, list);
			while (sl !== 0) {
				const next = a.memory[sl + ArenaLinkField.NEXT_SUB]!;
				arenaUnlink(a, sl);
				sl = next;
			}
		}
		if ((a.memory[sh + ArenaField.FLAGS]! & ArenaFlag.BOX_SUSPENDED) !== 0) arenaUnsuspend(a, sh);
		a.vals[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] = undefined;
	}

	/** Arena dep recording (arena fn-reader hook): first-occurrence mode
	 * reset + strong-dominates ride inside arenaLink (§4.4.1). The pre-dedup
	 * observation capture rides the STRONG arm only (§4.7/M6 — the
	 * discipline carried into the walks; OL1 is strong-only). */
	function arenaRecordDep(dep: AnyNode, weak: boolean): void {
		const a = arenaFrame;
		if (a === undefined) return;
		if (!weak) {
			const oc = core.obsCapture;
			if (oc !== undefined) oc.push(dep);
		}
		const sh = dep.kind === 'atom'
			? shadowFor(a, dep, ArenaFlag.K_SIGNAL | ArenaFlag.MUTABLE)
			: shadowFor(a, dep, ArenaFlag.K_COMPUTED);
		arenaLink(a, sh, arenaFrameShadow, arenaFrameCycle, weak);
	}

	/** The arena atom-propagation gate is Object.is over FOLD OUTPUTS: the
	 * atom's own `equals` already participated in the fold's stepwise
	 * equality, and world serving re-derives consumers on any fold-output
	 * motion — a custom comparator here could suppress propagation the fold
	 * path performs (dual-bookkeeping divergence by construction). The
	 * §4.5.3 comparator-order mandate — HEAD's `isEqual(prev, next)`,
	 * mirroring the kernel's `writeAtom` compare — binds the CUSTOM-EQUALITY
	 * COMPUTED record (arenaFoldOutcome's comparator arm, landed at S-C). */
	function arenaEqAtom(prev: Value, next: Value): boolean {
		return Object.is(prev, next);
	}

	/** Suspended-list append on the box-suspended bit's 0→1; the per-shadow
	 * field stores the dense index (S-A step 0 compaction — §4.5.4). */
	function arenaSuspend(a: WorldArena, sh: number): void {
		const vi = sh >> ArenaGeom.ID_TO_COLUMN_SHIFT;
		if (a.suspIdx[vi] !== 0) return; // already a member (value column just swaps sentinels)
		a.suspended.push(sh);
		a.suspIdx[vi] = a.suspended.length; // index + 1
		core.suspendedCount++;
	}

	/** Swap-remove at the stored index on the 1→0 clear: the list stays a
	 * DENSE set; the moved entry's stored index is updated (S-A step 0). */
	function arenaUnsuspend(a: WorldArena, sh: number): void {
		const vi = sh >> ArenaGeom.ID_TO_COLUMN_SHIFT;
		const slot = a.suspIdx[vi]!;
		if (slot === 0) return;
		const last = a.suspended.length - 1;
		const moved = a.suspended[last]!;
		a.suspended[slot - 1] = moved;
		a.suspIdx[moved >> ArenaGeom.ID_TO_COLUMN_SHIFT] = slot;
		a.suspended.pop();
		a.suspIdx[vi] = 0;
		core.suspendedCount--;
	}

	/** Exceptional outcome of an arena fn run (arenaUpdateComputed's catch):
	 * cache the thrown payload into the shadow with the THROWN bit — later
	 * serves rethrow it boxedRead-style (a thrown suspension re-runs once
	 * its thenable settles: the serve-site probe marks it DIRTY). */
	function arenaNoteThrow(a: WorldArena, sh: number, err: unknown): void {
		const memory = a.memory;
		const flags = memory[sh + ArenaField.FLAGS]!;
		const vi = sh >> ArenaGeom.ID_TO_COLUMN_SHIFT;
		arenaBumpReadClock(a);
		if (err instanceof SuspendedRead) {
			a.vals[vi] = err;
			memory[sh + ArenaField.FLAGS] = (flags & ~(ArenaFlag.DIRTY | ArenaFlag.PENDING)) | ArenaFlag.VALID | ArenaFlag.HAS_BOX | ArenaFlag.BOX_SUSPENDED | ArenaFlag.BOX_THROWN;
			arenaSuspend(a, sh);
			return;
		}
		if ((flags & ArenaFlag.BOX_SUSPENDED) !== 0) arenaUnsuspend(a, sh);
		a.vals[vi] = err;
		memory[sh + ArenaField.FLAGS] = (flags & ~(ArenaFlag.DIRTY | ArenaFlag.PENDING | ArenaFlag.BOX_SUSPENDED)) | ArenaFlag.VALID | ArenaFlag.HAS_BOX | ArenaFlag.BOX_THROWN;
	}

	// ---- arena serving (world reads, checks, settlement refolds) ----

	/** Serve a node from an arena — THE render/committed read path since S-B —
	 * refolding through the arena's own walks when marks or cold bases
	 * demand it. Refolds run under the arena-only routing override so
	 * raw-handle reads inside fns resolve to arena values too; frame-link
	 * sites feed the observation capture (raw reads have no reader hook). */
	function arenaServe(a: WorldArena, node: AnyNode): Value {
		if (node.kind === 'atom') {
			const sh = shadowFor(a, node, ArenaFlag.K_SIGNAL | ArenaFlag.MUTABLE);
			const memory = a.memory;
			const flags = memory[sh + ArenaField.FLAGS]!;
			if ((flags & ArenaFlag.VALID) === 0 || (flags & ArenaFlag.DIRTY) !== 0) {
				// Spike wAtomRead: a changed refold upgrades PENDING dependents
				// to DIRTY (shallow propagate, both subs lists) so their
				// re-check refolds them.
				if (arenaUpdateShadow(a, sh)) arenaShallowBoth(a, sh);
			}
			if (arenaFrame === a) {
				arenaLink(a, sh, arenaFrameShadow, arenaFrameCycle, false);
				const oc = core.obsCapture;
				if (oc !== undefined) oc.push(node);
			}
			return a.vals[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT];
		}
		const sh = shadowFor(a, node, ArenaFlag.K_COMPUTED);
		const memory = a.memory;
		let flags = memory[sh + ArenaField.FLAGS]!;
		if ((flags & ArenaFlag.RECURSED_CHECK) !== 0) {
			throw core.cycleError(node.name);
		}
		// Read-site self-heal probe (§4.5.4 pull half; mirrored at the memo
		// serve and the kernel's boxedRead): a settled-but-not-yet-invalidated
		// suspension self-invalidates AT THE READ, so a read after `await` is
		// deterministic even before the settle listener's microtask runs.
		if ((flags & ArenaFlag.BOX_SUSPENDED) !== 0) {
			const t = (a.vals[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] as SuspendedRead).thenable as { status?: string };
			if (t.status !== undefined && t.status !== 'pending') {
				memory[sh + ArenaField.FLAGS] = flags | ArenaFlag.DIRTY;
				flags = memory[sh + ArenaField.FLAGS]!;
			}
		}
		if ((flags & ArenaFlag.MUTABLE) === 0) {
			arenaUpdateComputed(a, sh); // never evaluated in this arena: cold fold
		} else if (
			(flags & ArenaFlag.DIRTY) !== 0
			// Evicted-to-cold residue (decay §4.3 / torn-cone dirt): VALID is
			// the "value column holds a folded value" bit — with it clear the
			// slot is evicted and must refold on consult, exactly as the atom
			// branch above does. MUTABLE alone only says "evaluated once".
			|| (flags & ArenaFlag.VALID) === 0
			|| ((flags & ArenaFlag.PENDING) !== 0 && arenaCheckDirty(a, a.memory[sh + ArenaField.DEPS]!, sh))
		) {
			if (arenaUpdateComputed(a, sh)) arenaShallowBoth(a, sh);
		} else if ((flags & ArenaFlag.PENDING) !== 0) {
			a.memory[sh + ArenaField.FLAGS] = flags & ~ArenaFlag.PENDING;
		}
		if (arenaFrame === a) {
			arenaLink(a, sh, arenaFrameShadow, arenaFrameCycle, false);
			const oc = core.obsCapture;
			if (oc !== undefined) oc.push(node);
		}
		const outFlags = a.memory[sh + ArenaField.FLAGS]!;
		// The boxedRead-style rethrow discipline (arenas serve real reads at
		// S-B): a THROWN payload — plain error, or a still-pending render-path
		// suspension — rethrows from the cache; a RETURNED sentinel (background
		// suspensions fold to the sentinel VALUE) serves
		// as a value, compared by identity (battery 16d's still-pending rule).
		if ((outFlags & ArenaFlag.HAS_BOX) !== 0 && ((outFlags & ArenaFlag.BOX_SUSPENDED) === 0 || (outFlags & ArenaFlag.BOX_THROWN) !== 0)) {
			throw a.vals[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT];
		}
		return a.vals[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT];
	}

	/** Refold a shadow (atom fold or computed fn run);
	 * returns whether the world's value changed (the §4.2 value cutoff). */
	function arenaUpdateShadow(a: WorldArena, sh: number): boolean {
		const flags = a.memory[sh + ArenaField.FLAGS]!;
		if ((flags & ArenaFlag.K_COMPUTED) !== 0) return arenaUpdateComputed(a, sh);
		const nid: NodeIndex = a.memory[sh + ArenaField.NODE]!;
		const atom = nodesArr[nid] as AtomNode;
		// §4.2 (iii): marked ⇒ REFOLD unconditionally — no fingerprint
		// consulted (the fp side channel was deleted at S-D).
		const next = core.foldAtom(atom, a.world);
		const vi = sh >> ArenaGeom.ID_TO_COLUMN_SHIFT;
		const prev = a.vals[vi];
		const prevValid = (flags & ArenaFlag.VALID) !== 0;
		a.memory[sh + ArenaField.FLAGS] = (flags & ~(ArenaFlag.DIRTY | ArenaFlag.PENDING)) | ArenaFlag.VALID;
		arenaBumpReadClock(a);
		// The shadow column ALWAYS stores the fold's own output (dual
		// bookkeeping requires arena value ≡ fold, bit for bit); the
		// comparator gates PROPAGATION only. Reference preservation for
		// custom-equality COMPUTEDS lives in arenaFoldOutcome (§4.5.3, S-C).
		a.vals[vi] = next;
		return !(prevValid && arenaEqAtom(prev, next));
	}

	/** Arena computed refold: the fn runs with the ARENA readers and the
	 * arena-only routing override — no memo writes. The evaluating world is
	 * set so raw-handle reads route. OBSERVED nodes capture the strong deps
	 * of this run and re-point their retains afterward (§4.7/M6: the
	 * world-path retain re-point, carried into the arena walks at S-B). */
	function arenaUpdateComputed(a: WorldArena, sh: number): boolean {
		const c = core; // one context load; field accesses below keep the one-load shape
		const nid: NodeIndex = a.memory[sh + ArenaField.NODE]!;
		const node = nodesArr[nid] as ComputedNode;
		a.memory[sh + ArenaField.DEPS_TAIL] = 0;
		a.memory[sh + ArenaField.FLAGS] = (a.memory[sh + ArenaField.FLAGS]! | ArenaFlag.MUTABLE | ArenaFlag.RECURSED_CHECK) & ~(ArenaFlag.RECURSED | ArenaFlag.DIRTY | ArenaFlag.PENDING);
		const savedFrameArena = arenaFrame;
		const savedFrameShadow = arenaFrameShadow;
		const savedFrameCycle = arenaFrameCycle;
		const savedRoute = c.serveOverride;
		const savedWorld = c.activeWorld;
		const savedSink = c.currentSink;
		const savedObsCapture = c.obsCapture;
		arenaFrame = a;
		arenaFrameShadow = sh;
		arenaFrameCycle = arenaBumpCycle(a);
		c.serveOverride = a;
		c.currentSink = 0;
		c.obsCapture = obsRefs[nid]! > 0 ? [] : undefined; // nid IS the nodeIndex (the NODE column)
		c.setWorld(a.world);
		c.evalDepth++;
		const tr = c.trace; // paired eval hooks; end fires on throw too
		if (tr !== undefined) tr.evalStart(node, a.world);
		try {
			return arenaFoldOutcome(a, sh, node.fn(arenaTrackedReader, arenaUntrackedReader), node.isEqual);
		} catch (err) {
			arenaNoteThrow(a, sh, err);
			throw err;
		} finally {
			if (tr !== undefined) tr.evalEnd();
			const obsCaptured = c.obsCapture;
			c.evalDepth--;
			c.setWorld(savedWorld);
			c.obsCapture = savedObsCapture;
			c.currentSink = savedSink;
			c.serveOverride = savedRoute;
			arenaFrame = savedFrameArena;
			arenaFrameShadow = savedFrameShadow;
			arenaFrameCycle = savedFrameCycle;
			a.memory[sh + ArenaField.FLAGS] = a.memory[sh + ArenaField.FLAGS]! & ~ArenaFlag.RECURSED_CHECK;
			arenaPurgeDeps(a, sh);
			arenaBumpReadClock(a);
			if (obsCaptured !== undefined) arenaSyncObsAfterRefold(node, obsCaptured);
		}
	}

	/** Observed-closure sync after an arena refold, out of line (keeps
	 * arenaUpdateComputed under the V8 inline budget; observed nodes only) —
	 * after every restore, so discovery evaluations run on a clean frame
	 * stack. A NESTED refold (inside an outer walk) has serveOverride
	 * restored to the OUTER arena; clear it around the sync so discovery's
	 * newest evaluations route newest. */
	function arenaSyncObsAfterRefold(node: AnyNode, captured: AnyNode[]): void {
		const so = core.serveOverride;
		core.serveOverride = undefined;
		try {
			obsSyncDeps(node, captured);
		} finally {
			core.serveOverride = so;
		}
	}

	/** Fold epilogue of an arena computed refold, out of line from
	 * arenaUpdateComputed (B2 split — the frame save/restore wrapper stays under
	 * V8's 460-bytecode inline budget): classify the fn's outcome —
	 * suspension sentinel or plain value — into the shadow's value column
	 * and outcome bits; returns the §4.2 value cutoff. The caller cleared
	 * DIRTY/PENDING at entry, and its call sites own propagation. A RETURNED
	 * sentinel clears the THROWN bit (it serves as a value; box→same-box by
	 * sentinel identity is UNCHANGED — battery 16d's still-pending rule).
	 * §4.5.3 (S-C): custom-equality computeds compare through their policy
	 * comparator against the ARENA-LOCAL previous value — never the kernel
	 * slot — in HEAD's argument order `isEqual(prev, next)` (mirroring the
	 * kernel's writeAtom compare; comparators need not be equivalence
	 * relations, so the order is load-bearing). On unchanged, the PREVIOUS
	 * reference is kept (write nothing). Equality never bridges an
	 * exceptional boundary: `prevValid` demands a plain previous value. */
	function arenaFoldOutcome(a: WorldArena, sh: number, value: Value, eq: Equals | undefined): boolean {
		const vi = sh >> ArenaGeom.ID_TO_COLUMN_SHIFT;
		const flags = a.memory[sh + ArenaField.FLAGS]!;
		if (value instanceof SuspendedRead) {
			const same = (flags & ArenaFlag.BOX_SUSPENDED) !== 0 && (flags & ArenaFlag.BOX_THROWN) === 0 && a.vals[vi] === value;
			a.vals[vi] = value;
			a.memory[sh + ArenaField.FLAGS] = (flags & ~ArenaFlag.BOX_THROWN) | ArenaFlag.VALID | ArenaFlag.HAS_BOX | ArenaFlag.BOX_SUSPENDED;
			arenaSuspend(a, sh);
			return !same;
		}
		const prevValid = (flags & ArenaFlag.VALID) !== 0 && (flags & ArenaFlag.HAS_BOX) === 0;
		const changed = !(prevValid && (eq === undefined
			? Object.is(a.vals[vi], value)
			: arenaEqCold(eq, a.vals[vi], value)));
		if ((flags & ArenaFlag.BOX_SUSPENDED) !== 0) arenaUnsuspend(a, sh);
		if (changed) a.vals[vi] = value;
		a.memory[sh + ArenaField.FLAGS] = (a.memory[sh + ArenaField.FLAGS]! & ~(ArenaFlag.HAS_BOX | ArenaFlag.BOX_SUSPENDED | ArenaFlag.BOX_THROWN)) | ArenaFlag.VALID;
		return changed;
	}

	/** The custom-equality compare, out of line (cold — §4.5.3 policy users
	 * only; keeps arenaFoldOutcome's hot default arm closure-free and under its
	 * budget). HEAD argument order: isEqual(prev, next) — see arenaFoldOutcome. */
	function arenaEqCold(eq: Equals, prev: Value, next: Value): boolean {
		return core.inCallback(() => eq(prev, next));
	}

	const arenaTrackedReader: Reader = (dep) => {
		arenaRecordDep(dep, false);
		return arenaServe(arenaFrame!, dep);
	};

	const arenaUntrackedReader: Reader = (dep) => {
		arenaRecordDep(dep, true);
		const a = arenaFrame;
		arenaFrame = undefined; // untracked: dep's own reads link nowhere new
		try {
			return arenaServe(a!, dep);
		} finally {
			arenaFrame = a;
		}
	};

	/** Kernel `checkDirty` transliteration (arenaUpdateShadow can run getters —
	 * allocations, arena growth — so a.memory re-loads after every update call).
	 * Entry wrapper: owns the scratch-stack base restore around the
	 * out-of-line walk so each piece stays under V8's 460-bytecode inline
	 * budget (B2 — the arena twin of the kernel checkDirty split). */
	function arenaCheckDirty(a: WorldArena, startLink: number, startSub: number): boolean {
		if (startLink === 0) return false;
		const stackBase = arenaCheckSp;
		try {
			return arenaCheckDirtyLoop(a, startLink, startSub);
		} finally {
			arenaCheckSp = stackBase;
		}
	}

	/** arenaUpdateShadow + sibling Pending->Dirty upgrade, shared by the descend
	 * and unwind arms of arenaCheckDirtyLoop. Heads are captured BEFORE the
	 * refold runs (it can rebuild the lists), as in the kernel's
	 * updateAndShallow; BOTH subs lists take the upgrade (§4.4.1). The
	 * kernel's single-sub skip ("the only sub is the walker itself") is
	 * UNSOUND under the segregated lists — a validation walk can arrive via
	 * the OTHER list, leaving a lone strong sub PENDING with no refold due
	 * (found by the fuzz corpus, seed 40: a weak-side validation refolded
	 * the shared dep and the strong-side consumer stale-served) — so both
	 * lists propagate unconditionally; the walker's own re-upgrade is a
	 * flag-guarded no-op. */
	function arenaUpdateAndShallow(a: WorldArena, node: number): boolean {
		const subs = a.memory[node + ArenaField.SUBS]!;
		const weak = a.weakSubs[node >> ArenaGeom.ID_TO_COLUMN_SHIFT]!;
		if (arenaUpdateShadow(a, node)) {
			if (subs !== 0) arenaShallowPropagate(a, subs);
			if (weak !== 0) arenaShallowPropagate(a, weak);
			return true;
		}
		return false;
	}

	/** The general arena walk, out of line (see arenaCheckDirty — the wrapper
	 * owns the arenaCheckSp restore, so a throwing fold unwinds through it). */
	function arenaCheckDirtyLoop(a: WorldArena, cur: number, sub: number): boolean {
		let checkDepth = 0;
		let dirty = false;
		let guard = 0;
		top: do {
			if (++guard > ArenaWalk.CYCLE_CAP) arenaWalkCycle('arenaCheckDirty', cur);
			const memory = a.memory;
			const dep = memory[cur + ArenaLinkField.DEP]!;
			const depFlags = memory[dep + ArenaField.FLAGS]!;
			if ((memory[sub + ArenaField.FLAGS]! & ArenaFlag.DIRTY) !== 0) {
				dirty = true;
			} else if (
				(depFlags & (ArenaFlag.MUTABLE | ArenaFlag.DIRTY)) === (ArenaFlag.MUTABLE | ArenaFlag.DIRTY)
				// Cold base (decay §4.3 evicted the value: MUTABLE kept, VALID
				// cleared, column dropped) — the walk's twin of arenaServe's
				// evicted-to-cold arm: with no folded value there is nothing to
				// validate against, so a cold dep IS dirt and must refold on
				// consult. Without this arm a cold base is invisible (neither
				// DIRTY nor PENDING) and a top-first serve stale-serves its
				// cone (the B2-documented S-A bug; pinned in arena-sa3).
				|| (depFlags & (ArenaFlag.MUTABLE | ArenaFlag.VALID)) === ArenaFlag.MUTABLE
			) {
				if (arenaUpdateAndShallow(a, dep)) {
					dirty = true;
				}
			} else if ((depFlags & (ArenaFlag.MUTABLE | ArenaFlag.PENDING)) === (ArenaFlag.MUTABLE | ArenaFlag.PENDING)) {
				if (arenaCheckSp === arenaCheckStack.length) {
					const bigger = new Int32Array(arenaCheckStack.length * 2);
					bigger.set(arenaCheckStack);
					arenaCheckStack = bigger;
				}
				arenaCheckStack[arenaCheckSp++] = cur;
				cur = memory[dep + ArenaField.DEPS]!;
				sub = dep;
				++checkDepth;
				continue;
			}
			if (!dirty) {
				const nextDep = a.memory[cur + ArenaLinkField.NEXT_DEP]!;
				if (nextDep !== 0) {
					cur = nextDep;
					continue;
				}
			}
			while (checkDepth--) {
				cur = arenaCheckStack[--arenaCheckSp]!;
				if (dirty) {
					if (arenaUpdateAndShallow(a, sub)) {
						sub = a.memory[cur + ArenaLinkField.SUB]!;
						continue;
					}
					dirty = false;
				} else {
					a.memory[sub + ArenaField.FLAGS] = a.memory[sub + ArenaField.FLAGS]! & ~ArenaFlag.PENDING;
				}
				sub = a.memory[cur + ArenaLinkField.SUB]!;
				const nextDep = a.memory[cur + ArenaLinkField.NEXT_DEP]!;
				if (nextDep !== 0) {
					cur = nextDep;
					continue top;
				}
			}
			return dirty;
		} while (true);
	}

	// ---- fanout at the four flip sites + mark decay (§4.3) ----

	/** Mark the flipped atoms' shadows in one arena and propagate PENDING over
	 * strong AND weak links, with the read-clock dedup: a still-DIRTY shadow
	 * whose MARK stamp equals the arena's clock has an already-marked cone
	 * that nothing re-validated since — re-propagation would be a no-op walk.
	 * RenderPass arenas receive NO log-entry-driven fanout, ever (the pin proof,
	 * §4.3) — dev-asserted here; the one pin-exempt mark source is L4
	 * resource settlement (`fromSettlement`). */
	function fanAtomsToArena(a: WorldArena, atoms: AtomNode[], fromSettlement: boolean): void {
		if (a.kind === 'render' && !fromSettlement) {
			throw new InvariantViolation('log-entry-flip fanout reached a render arena — render-world values are pin-frozen (§4.3)');
		}
		const memory = a.memory;
		for (let i = 0; i < atoms.length; i++) {
			const sh = a.nodeToShadow[atoms[i]!.ix] ?? 0;
			if (sh === 0) continue; // no shadow: nothing consumes this atom here
			const flags = memory[sh + ArenaField.FLAGS]!;
			if ((flags & ArenaFlag.DIRTY) !== 0 && memory[sh + ArenaField.MARK] === a.readClock) continue; // dedup
			if ((flags & ArenaFlag.DIRTY) === 0) {
				memory[sh + ArenaField.FLAGS] = flags | ArenaFlag.DIRTY;
				a.dirty.push(sh); // dirty-LIST append on the mark's 0→1 edge
			}
			memory[sh + ArenaField.MARK] = a.readClock;
			arenaPropagateBoth(a, sh); // strong AND weak (§4.4.1)
		}
	}

	/** Reused single-atom buffer for site (c)/(d) fanout (no per-write alloc). */
	const oneAtom: AtomNode[] = [];
	function oneAtomBuf(atom: AtomNode): AtomNode[] {
		oneAtom[0] = atom;
		return oneAtom;
	}

	/** Site (a)/(d) helper: fan into EVERY live committed arena. */
	function fanAtomsToCommittedArenas(atoms: AtomNode[]): void {
		if (rootToArena.size === 0) return; // the one scalar check quiet writes pay (§4.1.2)
		for (const a of rootToArena.values()) fanAtomsToArena(a, atoms, false);
	}

	/** §4.3 decay-by-eviction: swap the dirty list; an entry no evaluation
	 * consumed whose node has no live same-root watcher MAY drop to cold
	 * (evict the value, clear the mark) instead of re-appending — the dirty
	 * list stays bounded by live consumers' cones. A mark never clears
	 * without its refold having run OR its value having been evicted. */
	function arenaDecay(a: WorldArena): void {
		if (a.dirty.length === 0) return;
		const list = a.dirty;
		a.dirty = [];
		const memory = a.memory;
		for (let i = 0; i < list.length; i++) {
			const sh = list[i]!;
			const flags = memory[sh + ArenaField.FLAGS]!;
			if ((flags & ArenaFlag.DIRTY) === 0) continue; // consumed by an evaluation: drop the entry
			const nid = memory[sh + ArenaField.NODE]!;
			const ws = nodeToWatchers[nid];
			let watched = false;
			if (ws !== undefined) {
				for (let j = 0; j < ws.length; j++) {
					const w = ws[j]!;
					if (w.live && w.root === a.root) {
						watched = true;
						break;
					}
				}
			}
			if (watched) {
				a.dirty.push(sh); // keep-the-dirt: unconsumed marks survive to the next boundary
			} else {
				// Drop-to-cold: evict the cached value, clear the mark; links and
				// MUTABLE stay so routing coverage survives (§4.1's point).
				if ((flags & ArenaFlag.BOX_SUSPENDED) !== 0) arenaUnsuspend(a, sh);
				memory[sh + ArenaField.FLAGS] = flags & ~(ArenaFlag.DIRTY | ArenaFlag.VALID | ArenaFlag.HAS_BOX | ArenaFlag.BOX_SUSPENDED | ArenaFlag.BOX_THROWN);
				a.vals[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] = undefined;
			}
		}
	}

	/** Purge one nodeIndex's shadow from every live arena: evict, zero the
	 * record, unindex, and thread it onto the arena's dead-shadow free list.
	 * Shared by disposeComputed's eager teardown (the dispose→sweep window
	 * must not route through the dead shadow) and the record-free scrub
	 * (idempotent — an already-purged index reads shadow 0 and skips). */
	function purgeNodeFromArenas(ix: NodeIndex): void {
		eachArena((a) => {
			const sh = ix < a.nodeToShadow.length ? a.nodeToShadow[ix]! : 0;
			if (sh === 0) return;
			arenaEvictShadow(a, sh);
			// Zero the record and unindex: dirty-list residue reads an inert
			// record (FLAGS 0 — decay drops it); nothing routes here again.
			for (let f = 0; f < ArenaGeom.STRIDE; f++) a.memory[sh + f] = 0;
			a.nodeToShadow[ix] = 0;
			// Leak audit: thread the orphaned record onto the arena's
			// dead-shadow free list so recreation churn (the useComputed
			// dispose→create pattern) reuses it instead of growing a live
			// arena's record plane without bound. Stale dirty-list entries
			// naming it stay benign: pre-reuse they read FLAGS 0 (dropped),
			// post-reuse they alias the new tenant's listed entry (decay
			// re-checks flags per entry; duplicates cannot amplify).
			a.memory[sh + ArenaField.DEPS] = a.shadowFree;
			a.shadowFree = sh;
		});
	}

	/** A settlement's arena half (the settlement drain's per-arena scan —
	 * lives here so the suspended-list scan's flag/mark writes stay same-file
	 * with the layout enums): scan the dense suspended list for shadows whose
	 * box payload IS this sentinel; each match marks DIRTY (listed), stamps
	 * the mark clock, and propagates PENDING over BOTH subs lists (pin-exempt
	 * for render arenas — §4.3). Returns whether anything matched (the drain
	 * adds committed roots to its cone set); the read clock bumps once per
	 * matched arena, after the marks, exactly as the in-drain loop did. */
	function arenaInvalidateSettled(a: WorldArena, suspendSentinel: SuspendedRead): boolean {
		const list = a.suspended;
		const memory = a.memory;
		let matched = false;
		for (let j = 0; j < list.length; j++) {
			const sh = list[j]!;
			if (a.vals[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] !== suspendSentinel) continue;
			const flags = memory[sh + ArenaField.FLAGS]!;
			if ((flags & ArenaFlag.DIRTY) === 0) {
				memory[sh + ArenaField.FLAGS] = flags | ArenaFlag.DIRTY;
				a.dirty.push(sh);
			}
			memory[sh + ArenaField.MARK] = a.readClock;
			arenaPropagateBoth(a, sh); // strong AND weak; pin-exempt for render arenas (§4.3)
			matched = true;
		}
		if (matched) arenaBumpReadClock(a);
		return matched;
	}

	// ---- the routing walks (S-B: arenas route; §4.4.3/§4.4.6/§4.4.7) ----

	/** Reused routing-walk stack (walks are never re-entrant; holds arena
	 * shadow RECORD ids during arena walks). */
	const walkStack: number[] = [];

	/** Collect the live watchers subscribed on one node, by nodeIndex (delivery walk). */
	function collectWatchersAt(nid: NodeIndex, found: Watcher[]): void {
		const ws = nodeToWatchers[nid];
		if (ws !== undefined) {
			for (let i = 0; i < ws.length; i++) {
				const w = ws[i]!;
				if (w.live) found.push(w);
			}
		}
	}

	/** Collect the live same-root watchers subscribed on one node, by nodeIndex (drains). */
	function collectRootWatchersAt(nid: NodeIndex, rootId: RootId, ws: Watcher[]): void {
		const nw = nodeToWatchers[nid];
		if (nw !== undefined) {
			for (let j = 0; j < nw.length; j++) {
				const w = nw[j]!;
				if (w.live && w.root === rootId) ws.push(w);
			}
		}
	}

	/** One arena's half of the delivery walk: DFS over the STRONG subs lists
	 * (the segregated weak lists are never visited — the untracked-fan
	 * gate's prize) with per-arena shadow stamps for traversal termination
	 * and the global per-node stamps for collection dedup. Dead-GEN residue
	 * never routes (§4.5.3). Never allocates or folds: a.memory/a.walk stable. */
	function walkArenaStrong(a: WorldArena, from: NodeIndex, kGen: Generation, gen: WalkGen, found: Watcher[]): void {
		const start = from < a.nodeToShadow.length ? a.nodeToShadow[from]! : 0;
		if (start === 0) return;
		if (a.memory[start + ArenaField.NODE_GEN] !== kGen) return;
		const memory = a.memory;
		const walk = a.walk;
		const stack = walkStack;
		let sp = 0;
		walk[start >> ArenaGeom.ID_TO_COLUMN_SHIFT] = gen;
		stack[sp++] = start;
		while (sp > 0) {
			const sh = stack[--sp]!;
			let l = memory[sh + ArenaField.SUBS]!;
			while (l !== 0) {
				const sub = memory[l + ArenaLinkField.SUB]!;
				if (walk[sub >> ArenaGeom.ID_TO_COLUMN_SHIFT] !== gen) {
					walk[sub >> ArenaGeom.ID_TO_COLUMN_SHIFT] = gen;
					stack[sp++] = sub;
					const nid = memory[sub + ArenaField.NODE]!;
					if (lastWalk[nid] !== gen) {
						lastWalk[nid] = gen;
						collectWatchersAt(nid, found);
					}
				}
				l = memory[l + ArenaLinkField.NEXT_SUB]!;
			}
		}
	}

	/** The durable drain's candidate collection (§4.4.6), the arena-walking
	 * half of drainCommittedObservers — same-file with the layout enums: the
	 * root arena's dirty list seeds a walk over ALL arena links, strong AND
	 * weak (§4.4.1: drains expand over both; a weak hop's strong dependents
	 * expand past it too, since the walk keeps going), collecting live
	 * same-root watchers on visited nodes with the global per-node stamps
	 * for collection dedup. No folds or allocations run inside the walk, so
	 * a.memory/a.walk are stable to cache. The resident drain owns the gen
	 * bump, the restaled union, the id-order sort, and the correction loop. */
	function arenaCollectDrainCandidates(a: WorldArena, gen: WalkGen, rootId: RootId, ws: Watcher[]): void {
		const memory = a.memory;
		const walk = a.walk;
		const stack = walkStack;
		let sp = 0;
		const list = a.dirty;
		for (let i = 0; i < list.length; i++) {
			const sh = list[i]!;
			if (walk[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] === gen) continue;
			walk[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] = gen;
			stack[sp++] = sh;
			const nid = memory[sh + ArenaField.NODE]!;
			if (lastWalk[nid] !== gen) {
				lastWalk[nid] = gen;
				collectRootWatchersAt(nid, rootId, ws);
			}
		}
		while (sp > 0) {
			const sh = stack[--sp]!;
			// BOTH subs lists: drains expand over weak links too (§4.4.1).
			for (let list = 0; list < 2; list++) {
				let l = arenaSubsHead(a, sh, list);
				while (l !== 0) {
					const sub = memory[l + ArenaLinkField.SUB]!;
					if (walk[sub >> ArenaGeom.ID_TO_COLUMN_SHIFT] !== gen) {
						walk[sub >> ArenaGeom.ID_TO_COLUMN_SHIFT] = gen;
						stack[sp++] = sub;
						const nid = memory[sub + ArenaField.NODE]!;
						if (lastWalk[nid] !== gen) {
							lastWalk[nid] = gen;
							collectRootWatchersAt(nid, rootId, ws);
						}
					}
					l = memory[l + ArenaLinkField.NEXT_SUB]!;
				}
			}
		}
	}

	/** One arena's reverse-deps half of the fixup closure (strong links).
	 * The arena's NODE column stores nodeIndexes (dense column keys), so
	 * visited shadows map back to NodeIds through the dense node row. */
	function closureOverArena(a: WorldArena, node: AnyNode, closure: Set<NodeId>): void {
		const start = node.ix < a.nodeToShadow.length ? a.nodeToShadow[node.ix]! : 0;
		if (start === 0) return;
		if (a.memory[start + ArenaField.NODE_GEN] !== kernelGenOf(node.id)) return; // dead-tenancy residue never routes
		const gen = ++core.walkGen;
		const memory = a.memory;
		const walk = a.walk;
		const stack = walkStack;
		let sp = 0;
		walk[start >> ArenaGeom.ID_TO_COLUMN_SHIFT] = gen;
		stack[sp++] = start;
		while (sp > 0) {
			const sh = stack[--sp]!;
			let l = memory[sh + ArenaField.DEPS]!;
			while (l !== 0) {
				if ((memory[l + ArenaLinkField.MODE]! & ArenaLinkMode.WEAK) === 0) {
					const dep = memory[l + ArenaLinkField.DEP]!;
					if (walk[dep >> ArenaGeom.ID_TO_COLUMN_SHIFT] !== gen) {
						walk[dep >> ArenaGeom.ID_TO_COLUMN_SHIFT] = gen;
						const depNode = nodesArr[memory[dep + ArenaField.NODE]!];
						if (depNode !== undefined) closure.add(depNode.id);
						stack[sp++] = dep;
					}
				}
				l = memory[l + ArenaLinkField.NEXT_DEP]!;
			}
		}
	}

	/**
	 * One fold-truth evaluation frame (the armed checker's naive fn runs —
	 * the evaluator itself lives in tests/arena-checker.ts and reaches this
	 * only through `__checkerInternals`): the serve override becomes
	 * FOLD_TRUTH, so routed atom reads inside `fn` fold plain from their
	 * write logs and no arena-refold route survives into the frame — nothing
	 * routes back into the arena under check; the world is pinned for those
	 * folds' visibility; the fold-through sink and observation capture close
	 * (a checker read must never join a capture); the eval depth bumps
	 * (writes inside the frame throw, as in every world). Everything
	 * restores on the way out, throw or return.
	 */
	function foldTruthFrame<T>(world: World, fn: () => T): T {
		const savedWorld = core.activeWorld;
		const savedRoute = core.serveOverride;
		const savedSink = core.currentSink;
		const savedObsCapture = core.obsCapture;
		core.setWorld(world);
		core.serveOverride = FOLD_TRUTH;
		core.currentSink = 0;
		core.obsCapture = undefined;
		core.evalDepth++;
		try {
			return fn();
		} finally {
			core.evalDepth--;
			core.obsCapture = savedObsCapture;
			core.currentSink = savedSink;
			core.serveOverride = savedRoute;
			core.setWorld(savedWorld);
		}
	}

	/**
	 * Referee surface — not consulted by engine logic. The recorded
	 * dependency edges as dep → dependents (NodeIds — kernel record ids), materialized
	 * as the union of every live arena's links (strong AND weak-flagged —
	 * the current structure the routing walks consult); read by: graphviz,
	 * twin tests, soak metrics. (Replaced the K1 episode-edge snapshot at
	 * S-B; arena links persist across quiescence with their arenas.)
	 */
	function dependencyEdges(): Map<NodeId, Set<NodeId>> {
		const out = new Map<NodeId, Set<NodeId>>();
		eachArena((a) => {
			const memory = a.memory;
			for (let ix = 0; ix < a.nodeToShadow.length; ix++) {
				const sh = a.nodeToShadow[ix]!;
				if (sh === 0) continue;
				const depNode = nodesArr[ix];
				if (depNode === undefined) continue; // dead residue: not part of the live graph
				for (let list = 0; list < 2; list++) {
					let l = arenaSubsHead(a, sh, list);
					while (l !== 0) {
						const sub = memory[l + ArenaLinkField.SUB]!;
						const subNode = nodesArr[memory[sub + ArenaField.NODE]!];
						if (subNode !== undefined) {
							let s = out.get(depNode.id);
							if (s === undefined) {
								s = new Set();
								out.set(depNode.id, s);
							}
							s.add(subNode.id);
						}
						l = memory[l + ArenaLinkField.NEXT_SUB]!;
					}
				}
			}
		});
		return out;
	}

	/** Test seam: a committed arena's (dep → sub) link mode, or undefined
	 * when no link exists (§4.4.1 mode-transition pin). @internal */
	function __arenaLinkMode(rootId: RootId, dep: AnyNode, sub: AnyNode): 'strong' | 'weak' | undefined {
		const a = rootToArena.get(rootId);
		if (a === undefined) return undefined;
		const depSh = a.nodeToShadow[dep.ix] ?? 0;
		const subSh = a.nodeToShadow[sub.ix] ?? 0;
		if (depSh === 0 || subSh === 0) return undefined;
		let cur = a.memory[subSh + ArenaField.DEPS]!;
		while (cur !== 0) {
			if (a.memory[cur + ArenaLinkField.DEP] === depSh) return (a.memory[cur + ArenaLinkField.MODE]! & ArenaLinkMode.WEAK) !== 0 ? 'weak' : 'strong';
			cur = a.memory[cur + ArenaLinkField.NEXT_DEP]!;
		}
		return undefined;
	}

	/** Test seam: a committed arena's live (dep → sub) link record id, or 0
	 * when no link exists (freelist-discipline pins capture ids before a
	 * teardown). @internal */
	function __arenaLinkIdForTest(rootId: RootId, dep: AnyNode, sub: AnyNode): number {
		const a = rootToArena.get(rootId);
		if (a === undefined) return 0;
		const depSh = a.nodeToShadow[dep.ix] ?? 0;
		const subSh = a.nodeToShadow[sub.ix] ?? 0;
		if (depSh === 0 || subSh === 0) return 0;
		let cur = a.memory[subSh + ArenaField.DEPS]!;
		while (cur !== 0) {
			if (a.memory[cur + ArenaLinkField.DEP] === depSh) return cur;
			cur = a.memory[cur + ArenaLinkField.NEXT_DEP]!;
		}
		return 0;
	}

	/** Test seam: raw NEXT_DEP field of an arena link record BY ID — valid
	 * on freed links too. The freelist-discipline regression pin (dalien row
	 * 2 twin) asserts a freed link's stale nextDep still names its former
	 * neighbor, never the free list: arenaCheckDirty reads NEXT_DEP off links
	 * a mid-walk purge freed. @internal */
	function __arenaLinkNextDepForTest(rootId: RootId, linkId: number): number {
		const a = rootToArena.get(rootId);
		if (a === undefined) return -1;
		return a.memory[linkId + ArenaLinkField.NEXT_DEP] ?? -1;
	}

	// ---- the operation table (late-bound onto the shared core record) ----
	core.claimArena = claimArena;
	core.releaseArena = releaseArena;
	core.arenaOf = arenaOf;
	core.eachArena = eachArena;
	core.arenaServe = arenaServe;
	core.fanAtomsToArena = fanAtomsToArena;
	core.fanAtomsToCommittedArenas = fanAtomsToCommittedArenas;
	core.oneAtomBuf = oneAtomBuf;
	core.arenaDecay = arenaDecay;
	core.purgeNodeFromArenas = purgeNodeFromArenas;
	core.arenaInvalidateSettled = arenaInvalidateSettled;
	core.walkArenaStrong = walkArenaStrong;
	core.collectWatchersAt = collectWatchersAt;
	core.arenaCollectDrainCandidates = arenaCollectDrainCandidates;
	core.closureOverArena = closureOverArena;
	core.foldTruthFrame = foldTruthFrame;
	core.dependencyEdges = dependencyEdges;
	core.__arenaLinkMode = __arenaLinkMode;
	core.__arenaLinkIdForTest = __arenaLinkIdForTest;
	core.__arenaLinkNextDepForTest = __arenaLinkNextDepForTest;
}
