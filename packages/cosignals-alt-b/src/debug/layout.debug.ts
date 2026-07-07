// GENERATED FILE — from tools/schema.ts; run `pnpm gen`. DO NOT EDIT.
// The debug twin (§15.2): field tables as runtime data, flag decoding,
// and record hydrators. Imports nothing from the kernel; none of it
// ships on a hot path.

export const LAYOUT_VERSION = 1;

export type FieldInfo = {
	name: string;
	slot: number;
	kind: string;
	doc: string;
};

export const FIELDS_BY_RECORD: Record<string, readonly FieldInfo[]> = {
	node: [
		{ name: "FLAGS", slot: 0, kind: "flags", doc: "state machine + kind bits" },
		{ name: "DEPS", slot: 1, kind: "LinkId", doc: "first dependency link; free-list next when freed" },
		{ name: "DEPS_TAIL", slot: 2, kind: "LinkId", doc: "last confirmed dependency link (re-run cursor)" },
		{ name: "SUBS", slot: 3, kind: "LinkId", doc: "first subscriber link" },
		{ name: "SUBS_TAIL", slot: 4, kind: "LinkId", doc: "last subscriber link" },
		{ name: "GEN", slot: 5, kind: "u31", doc: "generation counter; bumped on free, defuses stale disposers" },
		{ name: "LOG_HEAD", slot: 6, kind: "LogId", doc: "atoms: first log record id in plane G (0 = no log)" },
		{ name: "OVERLAY_STAMP", slot: 6, kind: "u31", doc: "computeds/effects/watchers: last notify-walk ticket; marked iff > eraFloor" },
		{ name: "LOG_TAIL", slot: 7, kind: "LogId", doc: "atoms: last log record id" },
		{ name: "MEMO_KEY", slot: 7, kind: "u31", doc: "computeds: world key of the head memo record (fast hit check)" },
	],
	link: [
		{ name: "VERSION", slot: 0, kind: "u31", doc: "evaluation-cycle stamp: intra-run duplicate-read dedup" },
		{ name: "DEP", slot: 1, kind: "NodeId", doc: "producer node id" },
		{ name: "SUB", slot: 2, kind: "NodeId", doc: "consumer node id" },
		{ name: "PREV_SUB", slot: 3, kind: "LinkId", doc: "previous link in the producer's subscriber list" },
		{ name: "NEXT_SUB", slot: 4, kind: "LinkId", doc: "next link in the producer's subscriber list" },
		{ name: "PREV_DEP", slot: 5, kind: "LinkId", doc: "previous link in the consumer's dependency list" },
		{ name: "NEXT_DEP", slot: 6, kind: "LinkId", doc: "next link in the consumer's dependency list; free-list next when freed" },
	],
	log: [
		{ name: "L_NEXT", slot: 0, kind: "LogId", doc: "next entry in this atom's log (append = seq order); 0 = tail; free-list next when freed" },
		{ name: "L_META", slot: 1, kind: "packed", doc: "packed: OP (bits 0-1), APPLIED (2), RETIRED (3), BATCH_SLOT (4-8), PSEUDO (9)" },
		{ name: "L_SEQ", slot: 2, kind: "u31", doc: "take-a-number ticket at append time" },
		{ name: "L_RETIRED_SEQ", slot: 3, kind: "u31", doc: "0 while pending; a fresh ticket stamped at retirement" },
	],
	memo: [
		{ name: "W_KEY", slot: 0, kind: "u31", doc: "world key (0 newest; (passSerial<<2)|1; (token<<2)|2)" },
		{ name: "W_EPOCH", slot: 1, kind: "u31", doc: "overlayEpoch at evaluation; 0 is the tombstone value" },
		{ name: "W_NODE", slot: 2, kind: "NodeId", doc: "owning computed (drain re-validation + stale-head guard)" },
		{ name: "W_VAL", slot: 3, kind: "u31", doc: "index into the memoVals side array (GC-visible value/box)" },
		{ name: "W_NEXT_MEMO", slot: 4, kind: "MemoId", doc: "next memo record on the same node's chain" },
		{ name: "W_SLOT_NEXT", slot: 5, kind: "MemoId", doc: "writer's-world records only: next record on the batch slot's chain" },
		{ name: "W_NDEPS", slot: 6, kind: "u31", doc: "number of certificate pairs" },
		{ name: "W_CERT", slot: 7, kind: "u31", doc: "offset of this memo's certificate run in the certificate region" },
	],
};

export const STRIDES: Record<string, number> = {
	M: 8,
	G: 4,
	W: 8,
};

export const FLAG_BITS: Record<string, number> = {
	MUTABLE: 1,
	WATCHING: 2,
	RECURSED_CHECK: 4,
	RECURSED: 8,
	DIRTY: 16,
	PENDING: 32,
	HAS_CHILD_EFFECT: 64,
	LOGGED: 128,
	IMMEDIATE: 256,
	LIVE: 512,
	K_ATOM: 1024,
	K_COMPUTED: 2048,
	K_EFFECT: 4096,
	K_SCOPE: 8192,
	K_WATCHER: 16384,
};

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

/** Decode one node record (plane M) into a plain object. */
export function hydrateNode(plane: Int32Array, id: number): Record<string, unknown> {
	const out: Record<string, unknown> = { id };
	for (const f of FIELDS_BY_RECORD.node) {
		out[f.name] = plane[id + f.slot];
	}
	out.flagNames = decodeFlags(plane[id + 0]);
	return out;
}

/** Decode one link record (plane M) into a plain object. */
export function hydrateLink(plane: Int32Array, id: number): Record<string, unknown> {
	const out: Record<string, unknown> = { id };
	for (const f of FIELDS_BY_RECORD.link) {
		out[f.name] = plane[id + f.slot];
	}
	return out;
}

/** Decode one log record (plane G) into a plain object. */
export function hydrateLog(plane: Int32Array, id: number): Record<string, unknown> {
	const out: Record<string, unknown> = { id };
	for (const f of FIELDS_BY_RECORD.log) {
		out[f.name] = plane[id + f.slot];
	}
	return out;
}

/** Decode one memo record (plane W) into a plain object. */
export function hydrateMemo(plane: Int32Array, id: number): Record<string, unknown> {
	const out: Record<string, unknown> = { id };
	for (const f of FIELDS_BY_RECORD.memo) {
		out[f.name] = plane[id + f.slot];
	}
	return out;
}

export const BYTECODE_BUDGETS: Record<string, number> = {
	link: 200,
	linkInsert: 800,
	propagate: 460,
	checkDirty: 560,
	notifyWalk: 460,
	readAtomPublic: 200,
	readComputedPublic: 200,
	atomWrite: 460,
	atomWriteLogged: 1200,
};
