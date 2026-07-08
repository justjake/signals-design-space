// GENERATED FILE — from tools/schema.ts; run `pnpm gen`. DO NOT EDIT.
// The debug twin: field tables as runtime data, flag decoding, record
// hydrators, and the side-column rosters. Imports nothing from the engine;
// none of it ships on a hot path.

export const LAYOUT_VERSION = 5;

export type FieldInfo = {
	name: string;
	slot: number;
	kind: string;
	doc: string;
};

export const STRIDES: Record<string, number> = {
	node: 8,
	link: 8,
	watcher: 8,
	subscription: 8,
	arenaShadow: 8,
	arenaLink: 8,
};

export const FIELDS_BY_RECORD: Record<string, readonly FieldInfo[]> = {
	node: [
		{ name: "FLAGS", slot: 0, kind: "flags", doc: "State machine + kind bits (see NodeFlag)." },
		{ name: "DEPS", slot: 1, kind: "LinkId", doc: "First dependency link; doubles as the free-list next pointer for freed records." },
		{ name: "DEPS_TAIL", slot: 2, kind: "LinkId", doc: "Last confirmed dependency link (the re-track cursor during evaluation)." },
		{ name: "SUBS", slot: 3, kind: "LinkId", doc: "First subscriber link." },
		{ name: "SUBS_TAIL", slot: 4, kind: "LinkId", doc: "Last subscriber link." },
		{ name: "GEN", slot: 5, kind: "u31", doc: "Tenancy generation: bumped on free; disposers and finalizers capture it to defuse stale ids." },
		{ name: "LIFECYCLE", slot: 6, kind: "u31", doc: "1 iff the node is an atom carrying an observed-lifecycle effect (AtomOptions.effect). Set once at construction by the markLifecycle op; cleared when the record frees. Gates the per-link lifecycle retain/release in linkInsert/unlink and the lifecycle rehydration probe — atoms without the option never pay a lifecycle instruction.  ## Why a whole field for one bit?  We tried folding it into FLAGS as a bit. That forces write() and updateSignal() to preserve the bit, turning their constant flag stores into read-modify-writes on the hottest write path — measured +0.2 ns per bare write and +3-4% on write-storm composites. A dedicated field keeps flag stores constant, and the record is stride-8 either way, so the field is free." },
		{ name: "NODE_INDEX", slot: 7, kind: "ordinal", doc: "The record's node index: a dense per-node ordinal (never an identity) assigned once when a slot first hosts a node and inherited by every later tenant of the slot (the node free list threads through DEPS, so freeNode leaves this field untouched). Consumers key dense per-node side tables by it: node and link records share one allocator, so record-id-keyed tables would go holey where index-keyed ones stay packed. Node records only — link records use slot 7 as FREE_NEXT (the two record kinds already interpret fields differently)." },
	],
	link: [
		{ name: "VERSION", slot: 0, kind: "u31", doc: "Evaluation-cycle stamp: intra-run duplicate-read dedup." },
		{ name: "DEP", slot: 1, kind: "NodeId", doc: "Producer node id." },
		{ name: "SUB", slot: 2, kind: "NodeId", doc: "Consumer node id." },
		{ name: "PREV_SUB", slot: 3, kind: "LinkId", doc: "Previous link in the producer's subscriber list." },
		{ name: "NEXT_SUB", slot: 4, kind: "LinkId", doc: "Next link in the producer's subscriber list." },
		{ name: "PREV_DEP", slot: 5, kind: "LinkId", doc: "Previous link in the consumer's dependency list." },
		{ name: "NEXT_DEP", slot: 6, kind: "LinkId", doc: "Next link in the consumer's dependency list." },
		{ name: "FREE_NEXT", slot: 7, kind: "LinkId", doc: "The free list threads through the spare field so a freed link keeps every real field intact: the walks deliberately read stale nextDep/nextSub off links unlinked earlier in the same walk (conformance case 203 exercises this; tests/freelist.spec.ts pins it with a primed free list), and those stale pointers must name former neighbors — never the free list." },
	],
	watcher: [
		{ name: "FLAGS", slot: 0, kind: "flags", doc: "Kind + observer-state bits (NodeFlag.K_WATCHER, NodeFlag.OBSERVER_LIVE)." },
		{ name: "FREE_NEXT", slot: 1, kind: "NodeId", doc: "Allocator-owned: the node free list threads here while the record is freed (0 while live — watcher records hold no dependency links)." },
		{ name: "NODE", slot: 2, kind: "NodeId", doc: "The watched node record id (the component reads this node)." },
		{ name: "NODE_GEN", slot: 3, kind: "u31", doc: "The watched record's tenancy generation (kernel GEN) at mount: record ids recycle, so every watcher→node resolution generation-checks this stamp and skips loudly on mismatch." },
		{ name: "DEDUP_BITS", slot: 4, kind: "packed", doc: "Per-(watcher, slot) delivery dedup bits, one int word (bit i = batch slot i): a second write in the same slot delivers again only if no scheduled-but-unstarted render will fold it anyway." },
		{ name: "GEN", slot: 5, kind: "u31", doc: "Allocator-owned tenancy generation (shared meaning with NodeField.GEN): bumped when the record frees." },
		{ name: "NODE_IX", slot: 6, kind: "ordinal", doc: "The watched record's NODE_INDEX, cached at mount. Slot-tied like every node index (a record slot keeps its index across tenants), so the cache never goes stale — the NODE_GEN stamp is what decides whether the watched TENANCY is still alive." },
		{ name: "NODE_INDEX", slot: 7, kind: "ordinal", doc: "Allocator-owned dense per-record ordinal (shared meaning with NodeField.NODE_INDEX); watcher records consume ordinals but no dense column stores rows for them." },
	],
	subscription: [
		{ name: "FLAGS", slot: 0, kind: "flags", doc: "Kind + observer-state bits (NodeFlag.K_SUBSCRIPTION, NodeFlag.OBSERVER_LIVE)." },
		{ name: "FREE_NEXT", slot: 1, kind: "NodeId", doc: "Allocator-owned: the node free list threads here while the record is freed (0 while live)." },
		{ name: "DEP_HEAD", slot: 2, kind: "ArenaLinkId", doc: "First dependency link of the current snapshot — a link record in the root's committed WORLD arena (cross-arena reference: the subscription record lives in the kernel arena, its dep chain in the world arena; 0 = empty snapshot)." },
		{ name: "DEP_TAIL", slot: 3, kind: "ArenaLinkId", doc: "Last dependency link of the current snapshot (append cursor; 0 = empty)." },
		{ name: "GEN", slot: 5, kind: "u31", doc: "Allocator-owned tenancy generation (shared meaning with NodeField.GEN)." },
		{ name: "NODE_INDEX", slot: 7, kind: "ordinal", doc: "Allocator-owned dense per-record ordinal (shared meaning with NodeField.NODE_INDEX); subscription records consume ordinals but no dense column stores rows for them." },
	],
	arenaShadow: [
		{ name: "FLAGS", slot: 0, kind: "flags", doc: "State machine + kind bits (see ArenaFlag)." },
		{ name: "DEPS", slot: 1, kind: "ArenaLinkId", doc: "First dependency link; doubles as the dead-shadow free-list next pointer." },
		{ name: "DEPS_TAIL", slot: 2, kind: "ArenaLinkId", doc: "Last confirmed dependency link (the re-track cursor during a refold)." },
		{ name: "SUBS", slot: 3, kind: "ArenaLinkId", doc: "First STRONG subscriber link (the weak list lives in the weakSubs side column)." },
		{ name: "SUBS_TAIL", slot: 4, kind: "ArenaLinkId", doc: "Last strong subscriber link." },
		{ name: "NODE", slot: 5, kind: "ordinal", doc: "The nodeIndex this record shadows (dense column key; identity is the kernel record id)." },
		{ name: "NODE_GEN", slot: 6, kind: "u31", doc: "Id-tenancy stamp: the node's kernel-record GEN observed at recording — dead-GEN shadows never serve." },
		{ name: "MARK", slot: 7, kind: "u31", doc: "Fanout read-clock dedup stamp (a marked cone nothing re-validated is not re-walked)." },
	],
	arenaLink: [
		{ name: "VERSION", slot: 0, kind: "u31", doc: "Evaluation-cycle stamp: intra-refold duplicate-read dedup." },
		{ name: "DEP", slot: 1, kind: "ShadowId", doc: "Producer shadow record id." },
		{ name: "SUB", slot: 2, kind: "ShadowId", doc: "Consumer shadow record id." },
		{ name: "PREV_SUB", slot: 3, kind: "ArenaLinkId", doc: "Previous link in the producer's mode-matching subscriber list." },
		{ name: "NEXT_SUB", slot: 4, kind: "ArenaLinkId", doc: "Next link in the producer's mode-matching subscriber list." },
		{ name: "PREV_DEP", slot: 5, kind: "ArenaLinkId", doc: "Previous link in the consumer's dependency list." },
		{ name: "NEXT_DEP", slot: 6, kind: "ArenaLinkId", doc: "Next link in the consumer's dependency list." },
		{ name: "MODE", slot: 7, kind: "packed", doc: "ArenaLinkMode bits (strong/weak — see the weak-link rules at the arena walks)." },
		{ name: "FREE_NEXT", slot: 0, kind: "ArenaLinkId", doc: "The free list threads through the VERSION field (FREE_NEXT aliases it), the same discipline as the kernel's LinkField.FREE_NEXT: a freed link must keep every field a walk still reads intact. arenaCheckDirty reads NEXT_DEP (and arenaShallowPropagate NEXT_SUB) off links a mid-walk purge freed, so those must keep naming former neighbors, never the free list. VERSION is genuinely dead on freed links: it is only written at link creation/reuse (arenaLink/arenaLinkInsert) and only read off live links (the subs-tail dedup probe); every allocation path rewrites it before any read. Pinned by tests/arena-freelist.spec.ts." },
	],
};

export const FLAG_BITS: Record<string, Record<string, number>> = {
	NodeFlag: {
		MUTABLE: 1,
		WATCHING: 2,
		RECURSED_CHECK: 4,
		RECURSED: 8,
		DIRTY: 16,
		PENDING: 32,
		HAS_CHILD_EFFECT: 64,
		K_SIGNAL: 128,
		K_COMPUTED: 256,
		K_EFFECT: 512,
		K_SCOPE: 1024,
		HAS_BOX: 2048,
		BOX_SUSPENDED: 4096,
		MACHINERY_OWNED: 8192,
		K_WATCHER: 16384,
		K_SUBSCRIPTION: 32768,
		OBSERVER_LIVE: 65536,
	},
	ArenaLinkMode: {
		WEAK: 1,
	},
	ArenaFlag: {
		MUTABLE: 1,
		RECURSED_CHECK: 4,
		RECURSED: 8,
		DIRTY: 16,
		PENDING: 32,
		K_SIGNAL: 128,
		K_COMPUTED: 256,
		HAS_BOX: 2048,
		BOX_SUSPENDED: 4096,
		VALID: 8192,
		BOX_THROWN: 16384,
	},
};

export type ColumnInfo = {
	name: string;
	domain: string;
	storage: string;
	scrub: string;
};

export const COLUMNS: readonly ColumnInfo[] = [
	{ name: "values", domain: 'kernel', storage: "growArray", scrub: "free:node" },
	{ name: "fns", domain: 'kernel', storage: "growArray", scrub: "free:node" },
	{ name: "extras", domain: 'kernel', storage: "growArray", scrub: "free:node" },
	{ name: "clocks", domain: 'kernel', storage: "recordBuffer", scrub: "free:node+link" },
	{ name: "nodeToShadow", domain: 'worldArena', storage: "growArray", scrub: "release" },
	{ name: "vals", domain: 'worldArena', storage: "growArray", scrub: "evict+release" },
	{ name: "suspIdx", domain: 'worldArena', storage: "growArray", scrub: "release" },
	{ name: "walk", domain: 'worldArena', storage: "growArray", scrub: "release" },
	{ name: "weakSubs", domain: 'worldArena', storage: "growArray", scrub: "release" },
	{ name: "weakSubsTail", domain: 'worldArena', storage: "growArray", scrub: "release" },
	{ name: "clocks", domain: 'worldArena', storage: "recordBuffer", scrub: "evict+release" },
	{ name: "cutoffVals", domain: 'worldArena', storage: "growArray", scrub: "evict+release" },
];

/** Decode a FLAGS word into the set flag names of one registry. */
export function decodeFlags(registry: string, flags: number): string[] {
	const out: string[] = [];
	const bits = FLAG_BITS[registry] ?? {};
	for (const [name, bit] of Object.entries(bits)) {
		if ((flags & bit) !== 0) {
			out.push(name);
		}
	}
	return out;
}

/** Decode one node record into a plain object. */
export function hydrateNode(memory: Int32Array, id: number): Record<string, unknown> {
	const out: Record<string, unknown> = { id };
	for (const f of FIELDS_BY_RECORD.node) {
		out[f.name] = memory[id + f.slot];
	}
	out.flagNames = decodeFlags("NodeFlag", memory[id + 0]);
	return out;
}

/** Decode one link record into a plain object. */
export function hydrateLink(memory: Int32Array, id: number): Record<string, unknown> {
	const out: Record<string, unknown> = { id };
	for (const f of FIELDS_BY_RECORD.link) {
		out[f.name] = memory[id + f.slot];
	}
	return out;
}

/** Decode one watcher record into a plain object. */
export function hydrateWatcher(memory: Int32Array, id: number): Record<string, unknown> {
	const out: Record<string, unknown> = { id };
	for (const f of FIELDS_BY_RECORD.watcher) {
		out[f.name] = memory[id + f.slot];
	}
	out.flagNames = decodeFlags("NodeFlag", memory[id + 0]);
	return out;
}

/** Decode one subscription record into a plain object. */
export function hydrateSubscription(memory: Int32Array, id: number): Record<string, unknown> {
	const out: Record<string, unknown> = { id };
	for (const f of FIELDS_BY_RECORD.subscription) {
		out[f.name] = memory[id + f.slot];
	}
	out.flagNames = decodeFlags("NodeFlag", memory[id + 0]);
	return out;
}

/** Decode one arenaShadow record into a plain object. */
export function hydrateArenaShadow(memory: Int32Array, id: number): Record<string, unknown> {
	const out: Record<string, unknown> = { id };
	for (const f of FIELDS_BY_RECORD.arenaShadow) {
		out[f.name] = memory[id + f.slot];
	}
	out.flagNames = decodeFlags("ArenaFlag", memory[id + 0]);
	return out;
}

/** Decode one arenaLink record into a plain object. */
export function hydrateArenaLink(memory: Int32Array, id: number): Record<string, unknown> {
	const out: Record<string, unknown> = { id };
	for (const f of FIELDS_BY_RECORD.arenaLink) {
		out[f.name] = memory[id + f.slot];
	}
	return out;
}
