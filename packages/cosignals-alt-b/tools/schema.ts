/**
 * §15.2 — the layout schema: the single author-editable source of truth for
 * record layouts, flag bits, packing, and named constants. Plain data through
 * defineSchema() (validate + type only); evaluated by the generator
 * (tools/gen-layout.ts), never imported by shipping code.
 *
 * Any change to strides, field slots, flag bits, or packing bumps
 * LAYOUT_VERSION.
 */

export type FieldKind = 'flags' | 'NodeId' | 'LinkId' | 'LogId' | 'MemoId' | 'u31' | 'packed';

export type Field = {
	/** const-enum member name */
	name: string;
	slot: number;
	kind: FieldKind;
	doc: string;
	/** documented alias of another field at the same slot (kind-dependent reuse) */
	alias?: boolean;
};

export type RecordFamily = {
	name: string;
	fields: Field[];
};

export type Plane = {
	name: string;
	stride: number;
	burnedRecordZero: boolean;
	families: RecordFamily[];
};

export type FlagBit = {
	name: string;
	bit: number;
	doc: string;
};

export type PackedConst = {
	name: string;
	value: number;
	doc: string;
};

export type Schema = {
	layoutVersion: number;
	planes: Plane[];
	/** the node FLAGS word registry; the generator fails on overlapping bits */
	flags: FlagBit[];
	/** names of the flag bits that form KIND_MASK */
	kindBits: string[];
	/** log META packing + misc packed constants, emitted verbatim */
	packedConsts: PackedConst[];
	namedConsts: PackedConst[];
	/** §18.3 bytecode budget table (data only this pass; CI dump deferred) */
	budgets: Record<string, number>;
};

export function defineSchema(s: Schema): Schema {
	// flag bits disjoint
	let seen = 0;
	for (const f of s.flags) {
		if ((seen & f.bit) !== 0) {
			throw new Error(`schema: overlapping flag bit ${f.name}`);
		}
		if ((f.bit & (f.bit - 1)) !== 0) {
			throw new Error(`schema: flag ${f.name} is not a single bit`);
		}
		seen |= f.bit;
	}
	for (const k of s.kindBits) {
		if (!s.flags.some((f) => f.name === k)) {
			throw new Error(`schema: kind bit ${k} not in the flag registry`);
		}
	}
	// field slots unique per family (aliases exempt), under stride, documented
	for (const p of s.planes) {
		for (const fam of p.families) {
			const slots = new Set<number>();
			for (const f of fam.fields) {
				if (f.slot < 0 || f.slot >= p.stride) {
					throw new Error(`schema: ${fam.name}.${f.name} slot out of stride`);
				}
				if (!f.alias && slots.has(f.slot)) {
					throw new Error(`schema: ${fam.name} duplicate slot ${f.slot} (${f.name})`);
				}
				slots.add(f.slot);
				if (f.doc.length === 0) {
					throw new Error(`schema: ${fam.name}.${f.name} undocumented`);
				}
			}
		}
	}
	return s;
}

export const schema: Schema = defineSchema({
	layoutVersion: 1,
	planes: [
		{
			name: 'M',
			stride: 8,
			burnedRecordZero: true,
			families: [
				{
					name: 'node',
					fields: [
						{ name: 'FLAGS', slot: 0, kind: 'flags', doc: 'state machine + kind bits' },
						{ name: 'DEPS', slot: 1, kind: 'LinkId', doc: 'first dependency link; free-list next when freed' },
						{ name: 'DEPS_TAIL', slot: 2, kind: 'LinkId', doc: 'last confirmed dependency link (re-run cursor)' },
						{ name: 'SUBS', slot: 3, kind: 'LinkId', doc: 'first subscriber link' },
						{ name: 'SUBS_TAIL', slot: 4, kind: 'LinkId', doc: 'last subscriber link' },
						{ name: 'GEN', slot: 5, kind: 'u31', doc: 'generation counter; bumped on free, defuses stale disposers' },
						{ name: 'LOG_HEAD', slot: 6, kind: 'LogId', doc: 'atoms: first log record id in plane G (0 = no log)' },
						{ name: 'OVERLAY_STAMP', slot: 6, kind: 'u31', alias: true, doc: 'computeds/effects/watchers: last notify-walk ticket; marked iff > eraFloor' },
						{ name: 'LOG_TAIL', slot: 7, kind: 'LogId', doc: 'atoms: last log record id' },
						{ name: 'MEMO_KEY', slot: 7, kind: 'u31', alias: true, doc: 'computeds: world key of the head memo record (fast hit check)' },
					],
				},
				{
					name: 'link',
					fields: [
						{ name: 'VERSION', slot: 0, kind: 'u31', doc: 'evaluation-cycle stamp: intra-run duplicate-read dedup' },
						{ name: 'DEP', slot: 1, kind: 'NodeId', doc: 'producer node id' },
						{ name: 'SUB', slot: 2, kind: 'NodeId', doc: 'consumer node id' },
						{ name: 'PREV_SUB', slot: 3, kind: 'LinkId', doc: "previous link in the producer's subscriber list" },
						{ name: 'NEXT_SUB', slot: 4, kind: 'LinkId', doc: "next link in the producer's subscriber list" },
						{ name: 'PREV_DEP', slot: 5, kind: 'LinkId', doc: "previous link in the consumer's dependency list" },
						{ name: 'NEXT_DEP', slot: 6, kind: 'LinkId', doc: "next link in the consumer's dependency list; free-list next when freed" },
					],
				},
			],
		},
		{
			name: 'G',
			stride: 4,
			burnedRecordZero: true,
			families: [
				{
					name: 'log',
					fields: [
						{ name: 'L_NEXT', slot: 0, kind: 'LogId', doc: "next entry in this atom's log (append = seq order); 0 = tail; free-list next when freed" },
						{ name: 'L_META', slot: 1, kind: 'packed', doc: 'packed: OP (bits 0-1), APPLIED (2), RETIRED (3), BATCH_SLOT (4-8), PSEUDO (9)' },
						{ name: 'L_SEQ', slot: 2, kind: 'u31', doc: 'take-a-number ticket at append time' },
						{ name: 'L_RETIRED_SEQ', slot: 3, kind: 'u31', doc: '0 while pending; a fresh ticket stamped at retirement' },
					],
				},
			],
		},
		{
			name: 'W',
			stride: 8,
			burnedRecordZero: true,
			families: [
				{
					name: 'memo',
					fields: [
						{ name: 'W_KEY', slot: 0, kind: 'u31', doc: 'world key (0 newest; (passSerial<<2)|1; (token<<2)|2)' },
						{ name: 'W_EPOCH', slot: 1, kind: 'u31', doc: 'overlayEpoch at evaluation; 0 is the tombstone value' },
						{ name: 'W_NODE', slot: 2, kind: 'NodeId', doc: 'owning computed (drain re-validation + stale-head guard)' },
						{ name: 'W_VAL', slot: 3, kind: 'u31', doc: 'index into the memoVals side array (GC-visible value/box)' },
						{ name: 'W_NEXT_MEMO', slot: 4, kind: 'MemoId', doc: "next memo record on the same node's chain" },
						{ name: 'W_SLOT_NEXT', slot: 5, kind: 'MemoId', doc: "writer's-world records only: next record on the batch slot's chain" },
						{ name: 'W_NDEPS', slot: 6, kind: 'u31', doc: 'number of certificate pairs' },
						{ name: 'W_CERT', slot: 7, kind: 'u31', doc: "offset of this memo's certificate run in the certificate region" },
					],
				},
			],
		},
	],
	flags: [
		{ name: 'MUTABLE', bit: 1, doc: 'can produce new values (atoms, computeds)' },
		{ name: 'WATCHING', bit: 2, doc: 'wants notification when possibly stale (effects, watchers)' },
		{ name: 'RECURSED_CHECK', bit: 4, doc: 'currently evaluating (re-entrancy guard)' },
		{ name: 'RECURSED', bit: 8, doc: 're-entrant write reached me during my own run' },
		{ name: 'DIRTY', bit: 16, doc: 'definitely stale' },
		{ name: 'PENDING', bit: 32, doc: 'possibly stale — verify by pulling before recomputing' },
		{ name: 'HAS_CHILD_EFFECT', bit: 64, doc: 'dep list contains child effects/scopes (slow-path cleanup)' },
		{ name: 'LOGGED', bit: 128, doc: 'atoms only: LOG_HEAD !== 0 — the read gate' },
		{ name: 'IMMEDIATE', bit: 256, doc: 'watchers only: notify via the broadcast list, not the effect queue' },
		// bit 512 free: LIVE became a per-node refcount side column (liveCount),
		// kept out of the kernel-rewritten flags word (§8.6 refcount conversion).
		{ name: 'K_ATOM', bit: 1024, doc: 'kind: writable atom' },
		{ name: 'K_COMPUTED', bit: 2048, doc: 'kind: computed' },
		{ name: 'K_EFFECT', bit: 4096, doc: 'kind: effect' },
		{ name: 'K_SCOPE', bit: 8192, doc: 'kind: effect scope' },
		{ name: 'K_WATCHER', bit: 16384, doc: 'kind: React watcher (broadcast-notified)' },
	],
	kindBits: ['K_ATOM', 'K_COMPUTED', 'K_EFFECT', 'K_SCOPE', 'K_WATCHER'],
	packedConsts: [
		{ name: 'OP_MASK', value: 3, doc: 'L_META bits 0-1: operation' },
		{ name: 'OP_BASE', value: 0, doc: 'base record (tape-creation snapshot)' },
		{ name: 'OP_SET', value: 1, doc: 'SET: payload replaces the accumulator' },
		{ name: 'OP_UPDATE', value: 2, doc: 'UPDATE: payload fn applies to the accumulator' },
		{ name: 'OP_DISPATCH', value: 3, doc: "DISPATCH: the atom's reducer applies the action" },
		{ name: 'F_APPLIED', value: 4, doc: 'already written through the kernel (urgent writes, §9.4)' },
		{ name: 'F_RETIRED', value: 8, doc: 'batch retired; visibility runs on L_RETIRED_SEQ' },
		{ name: 'SLOT_SHIFT', value: 4, doc: 'L_META bits 4-8: batch slot (0-31)' },
		{ name: 'SLOT_MASK', value: 496, doc: '31 << SLOT_SHIFT' },
		{ name: 'F_PSEUDO', value: 512, doc: 'slot-exhaustion fallback entry (§9.2), counted outside slots' },
	],
	namedConsts: [
		{ name: 'REC_SLACK', value: 1280, doc: 'min free main-plane records guaranteed at each op boundary' },
	],
	budgets: {
		// §18.3 declared bytecode budgets (measured via --print-bytecode over
		// the bundled artifact; the automated CI dump is a deferred gate).
		link: 200, // measured 42
		linkInsert: 800, // out-of-line by design (mark repair + LIVE flow live here)
		propagate: 460, // measured 446
		checkDirty: 560, // measured 535: donor-derived out-of-line walk, never inlined
		notifyWalk: 460, // measured 432
		readAtomPublic: 200, // measured ~190 after the tracked-link dedup
		readComputedPublic: 200, // measured 154
		atomWrite: 460, // measured 200 (DIRECT fast path; LOGGED half out-of-line)
		atomWriteLogged: 1200, // out-of-line slow half by design
	},
});
