// GENERATED FILE — from tools/schema.ts; run `pnpm gen`. DO NOT EDIT.
// The debug twin: field tables as runtime data, flag decoding, record
// hydrators, and the side-column roster. Imports nothing from the engine;
// none of it ships on a hot path.

export const LAYOUT_VERSION = 1;
export const STRIDE = 8;

export type FieldInfo = {
	name: string;
	slot: number;
	kind: string;
	doc: string;
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
};

export const FLAG_BITS: Record<string, number> = {
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
};

export type ColumnInfo = {
	name: string;
	storage: string;
	slotsPerRecord: number;
	shift: number;
	scrubOnFree: readonly string[];
};

export const COLUMNS: readonly ColumnInfo[] = [
	{ name: "values", storage: "growArray", slotsPerRecord: 2, shift: 2, scrubOnFree: ["node"] },
	{ name: "fns", storage: "growArray", slotsPerRecord: 1, shift: 3, scrubOnFree: ["node"] },
	{ name: "clocks", storage: "recordBuffer", slotsPerRecord: 1, shift: 3, scrubOnFree: ["node","link"] },
];

/** Decode a FLAGS word into the set flag names. */
export function decodeFlags(flags: number): string[] {
	const out: string[] = [];
	for (const [name, bit] of Object.entries(FLAG_BITS)) {
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
	out.flagNames = decodeFlags(memory[id + 0]);
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
