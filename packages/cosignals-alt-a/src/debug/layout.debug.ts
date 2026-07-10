/**
 * GENERATED debug twin (from tools/schema.ts; run pnpm gen) — DO NOT EDIT.
 * Imports nothing from the kernel; field tables are runtime data and the
 * hydrators decode record ids into plain objects (§15.2). None of this
 * ships in the hot build.
 */

export const LAYOUT_VERSION = 2

export type FieldInfo = { name: string; slot: number; kind: string; doc: string }

export const FIELDS_BY_RECORD: Record<string, FieldInfo[]> = {
	node: [
		{ name: 'FLAGS', slot: 0, kind: 'flags', doc: 'state machine + kind bits' },
		{
			name: 'DEPS',
			slot: 1,
			kind: 'LinkId',
			doc: 'first link of my dependency list; doubles as free-list next for freed node records',
		},
		{
			name: 'DEPS_TAIL',
			slot: 2,
			kind: 'LinkId',
			doc: 'last confirmed dependency link (the re-run cursor)',
		},
		{ name: 'SUBS', slot: 3, kind: 'LinkId', doc: 'first link of my subscriber list' },
		{ name: 'SUBS_TAIL', slot: 4, kind: 'LinkId', doc: 'last subscriber link' },
		{
			name: 'GEN',
			slot: 5,
			kind: 'u31',
			doc: 'generation counter, bumped on free; stale disposers no-op',
		},
		{
			name: 'LOG_HEAD',
			slot: 6,
			kind: 'LogId',
			doc: 'atoms: first log record id in plane G (0 = no log). Aliased as OVERLAY_STAMP on non-atoms.',
		},
		{
			name: 'LOG_TAIL',
			slot: 7,
			kind: 'LogId',
			doc: 'atoms: last log record id. Aliased as MEMO_KEY on computeds.',
		},
	],
	link: [
		{
			name: 'VERSION',
			slot: 0,
			kind: 'u31',
			doc: 'evaluation-cycle stamp: intra-run duplicate-read dedup',
		},
		{ name: 'DEP', slot: 1, kind: 'NodeId', doc: 'producer node id' },
		{ name: 'SUB', slot: 2, kind: 'NodeId', doc: 'consumer node id' },
		{
			name: 'PREV_SUB',
			slot: 3,
			kind: 'LinkId',
			doc: "position in the producer's subscriber list",
		},
		{
			name: 'NEXT_SUB',
			slot: 4,
			kind: 'LinkId',
			doc: "position in the producer's subscriber list",
		},
		{
			name: 'PREV_DEP',
			slot: 5,
			kind: 'LinkId',
			doc: "position in the consumer's dependency list",
		},
		{
			name: 'NEXT_DEP',
			slot: 6,
			kind: 'LinkId',
			doc: "position in the consumer's dependency list; doubles as free-list next for freed link records",
		},
	],
	log: [
		{
			name: 'L_NEXT',
			slot: 0,
			kind: 'LogId',
			doc: "next entry in this atom's log (append order = seq order); 0 = tail; doubles as free-list next",
		},
		{
			name: 'L_META',
			slot: 1,
			kind: 'flags',
			doc: 'packed: bits 0-1 OP, bit 2 APPLIED, bit 3 RETIRED, bits 4-8 BATCH_SLOT, bit 9 PSEUDO',
		},
		{ name: 'L_SEQ', slot: 2, kind: 'seq', doc: 'take-a-number ticket at append time' },
		{
			name: 'L_RETIRED_SEQ',
			slot: 3,
			kind: 'seq',
			doc: '0 while the batch is pending; one fresh ticket stamped per retirement',
		},
	],
	memo: [
		{
			name: 'W_KEY',
			slot: 0,
			kind: 'u31',
			doc: 'world key: newest 0; pass (serial<<2)|1; writer (token<<2)|2',
		},
		{
			name: 'W_EPOCH',
			slot: 1,
			kind: 'u31',
			doc: 'overlayEpoch at evaluation time; 0 is the tombstone value (epochs start at 1)',
		},
		{
			name: 'W_NODE',
			slot: 2,
			kind: 'NodeId',
			doc: 'owning computed node id (drain re-validation + stale-head guard)',
		},
		{
			name: 'W_VAL',
			slot: 3,
			kind: 'u31',
			doc: 'index into the memoVals side array holding the memoized value',
		},
		{
			name: 'W_NEXT_MEMO',
			slot: 4,
			kind: 'MemoId',
			doc: "next memo record for the same node (the node's memo chain)",
		},
		{
			name: 'W_SLOT_NEXT',
			slot: 5,
			kind: 'MemoId',
			doc: "writer's-world records only: next record in the batch slot's memo chain; 0 on other keys",
		},
		{ name: 'W_NDEPS', slot: 6, kind: 'u31', doc: 'number of certificate pairs' },
		{
			name: 'W_CERT',
			slot: 7,
			kind: 'CertOff',
			doc: "offset of this memo's certificate run in the certificate region",
		},
	],
}

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
}

export const STRIDES = { M: 8, G: 4, W: 8 } as const

export function decodeFlags(word: number): string[] {
	const out: string[] = []
	for (const [name, bit] of Object.entries(FLAG_BITS)) {
		if ((word & bit) !== 0) {
			out.push(name)
		}
	}
	return out
}

function hydrate(plane: Int32Array, id: number, family: string): Record<string, number | string[]> {
	const out: Record<string, number | string[]> = { id }
	for (const f of FIELDS_BY_RECORD[family]) {
		out[f.name] = f.kind === 'flags' ? decodeFlags(plane[id + f.slot]) : plane[id + f.slot]
	}
	return out
}

export function nodeRecord(M: Int32Array, id: number): Record<string, number | string[]> {
	return hydrate(M, id, 'node')
}

export function linkRecord(M: Int32Array, id: number): Record<string, number | string[]> {
	return hydrate(M, id, 'link')
}

export function logRecord(G: Int32Array, gid: number): Record<string, number | string[]> {
	return hydrate(G, gid, 'log')
}

export function memoRecord(W: Int32Array, wid: number): Record<string, number | string[]> {
	return hydrate(W, wid, 'memo')
}
