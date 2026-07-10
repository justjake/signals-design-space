/**
 * §15.2 — the layout schema: the single author-editable source of truth for
 * field offsets, flag bits, opcodes, strides, and named constants. Plain
 * data (no const enums) so strip-only loaders can execute it; evaluated by
 * the generator and the debug tooling, never imported by shipping code.
 *
 * Any change to stride, field slots, flag bits, or side-column addressing
 * bumps LAYOUT_VERSION.
 */

export type FieldKind =
	| 'flags'
	| 'NodeId'
	| 'LinkId'
	| 'LogId'
	| 'MemoId'
	| 'CertOff'
	| 'seq'
	| 'u31'
	| 'value'
	| 'spare'

export type Field = {
	name: string
	slot: number
	kind: FieldKind
	doc: string
	/** Which operation writes the field / which clears it. */
	owner: string
}

export type RecordFamily = {
	name: string
	plane: 'M' | 'G' | 'W'
	fields: Field[]
}

export type FlagBit = { name: string; value: number; doc: string }
export type EnumMember = { name: string; value: number; doc: string }
export type EnumGroup = { name: string; doc: string; members: EnumMember[] }

export type Schema = {
	layoutVersion: number
	planes: Record<'M' | 'G' | 'W', { stride: number; doc: string }>
	records: RecordFamily[]
	flags: FlagBit[]
	derivedMasks: Array<{ name: string; of: string[]; doc: string }>
	groups: EnumGroup[]
	constants: EnumMember[]
	sideColumns: Array<{ name: string; index: string; doc: string }>
}

export function defineSchema(s: Schema): Schema {
	// ---- §15.5 schema self-checks at generate time -------------------------------
	for (const rec of s.records) {
		const stride = s.planes[rec.plane].stride
		const seen = new Set<number>()
		for (const f of rec.fields) {
			if (f.slot < 0 || f.slot >= stride) {
				throw new Error(`schema: ${rec.name}.${f.name} slot ${f.slot} outside stride ${stride}`)
			}
			if (seen.has(f.slot)) {
				throw new Error(`schema: ${rec.name} duplicate slot ${f.slot}`)
			}
			seen.add(f.slot)
			if (f.doc === '' || f.owner === '') {
				throw new Error(`schema: ${rec.name}.${f.name} missing doc/owner`)
			}
		}
	}
	let usedBits = 0
	for (const b of s.flags) {
		if ((b.value & (b.value - 1)) !== 0) {
			throw new Error(`schema: flag ${b.name} not a power of two`)
		}
		if ((usedBits & b.value) !== 0) {
			throw new Error(`schema: flag ${b.name} overlaps another bit`)
		}
		usedBits |= b.value
	}
	for (const m of s.derivedMasks) {
		for (const part of m.of) {
			if (!s.flags.some((b) => b.name === part)) {
				throw new Error(`schema: mask ${m.name} references unknown flag ${part}`)
			}
		}
	}
	return s
}

export const schema: Schema = defineSchema({
	layoutVersion: 2,
	planes: {
		M: {
			stride: 8,
			doc: 'main plane: nodes and links interleaved (ids pre-multiplied by 8; record 0 burned)',
		},
		G: {
			stride: 4,
			doc: 'log plane: write-log entries (ids pre-multiplied by 4; record 0 burned; bulk-reset at quiescence)',
		},
		W: {
			stride: 8,
			doc: 'world-memo plane: overlay memo records (certificate region lives in a companion array; bulk-reset at quiescence)',
		},
	},
	records: [
		{
			name: 'node',
			plane: 'M',
			fields: [
				{
					name: 'FLAGS',
					slot: 0,
					kind: 'flags',
					doc: 'state machine + kind bits',
					owner: 'alloc writes; free zeroes',
				},
				{
					name: 'DEPS',
					slot: 1,
					kind: 'LinkId',
					doc: 'first link of my dependency list; doubles as free-list next for freed node records',
					owner: 'link/unlink; free threads',
				},
				{
					name: 'DEPS_TAIL',
					slot: 2,
					kind: 'LinkId',
					doc: 'last confirmed dependency link (the re-run cursor)',
					owner: 'link/purgeDeps',
				},
				{
					name: 'SUBS',
					slot: 3,
					kind: 'LinkId',
					doc: 'first link of my subscriber list',
					owner: 'linkInsert/unlink',
				},
				{
					name: 'SUBS_TAIL',
					slot: 4,
					kind: 'LinkId',
					doc: 'last subscriber link',
					owner: 'linkInsert/unlink',
				},
				{
					name: 'GEN',
					slot: 5,
					kind: 'u31',
					doc: 'generation counter, bumped on free; stale disposers no-op',
					owner: 'freeNode bumps',
				},
				{
					name: 'LOG_HEAD',
					slot: 6,
					kind: 'LogId',
					doc: 'atoms: first log record id in plane G (0 = no log). Aliased as OVERLAY_STAMP on non-atoms.',
					owner: 'appendLog creates; sweep clears',
				},
				{
					name: 'LOG_TAIL',
					slot: 7,
					kind: 'LogId',
					doc: 'atoms: last log record id. Aliased as MEMO_KEY on computeds.',
					owner: 'appendLog/sweep',
				},
			],
		},
		{
			name: 'link',
			plane: 'M',
			fields: [
				{
					name: 'VERSION',
					slot: 0,
					kind: 'u31',
					doc: 'evaluation-cycle stamp: intra-run duplicate-read dedup',
					owner: 'link stamps',
				},
				{ name: 'DEP', slot: 1, kind: 'NodeId', doc: 'producer node id', owner: 'linkInsert' },
				{ name: 'SUB', slot: 2, kind: 'NodeId', doc: 'consumer node id', owner: 'linkInsert' },
				{
					name: 'PREV_SUB',
					slot: 3,
					kind: 'LinkId',
					doc: "position in the producer's subscriber list",
					owner: 'linkInsert/unlink',
				},
				{
					name: 'NEXT_SUB',
					slot: 4,
					kind: 'LinkId',
					doc: "position in the producer's subscriber list",
					owner: 'linkInsert/unlink',
				},
				{
					name: 'PREV_DEP',
					slot: 5,
					kind: 'LinkId',
					doc: "position in the consumer's dependency list",
					owner: 'linkInsert/unlink',
				},
				{
					name: 'NEXT_DEP',
					slot: 6,
					kind: 'LinkId',
					doc: "position in the consumer's dependency list; doubles as free-list next for freed link records",
					owner: 'linkInsert/unlink; free threads',
				},
			],
		},
		{
			name: 'log',
			plane: 'G',
			fields: [
				{
					name: 'L_NEXT',
					slot: 0,
					kind: 'LogId',
					doc: "next entry in this atom's log (append order = seq order); 0 = tail; doubles as free-list next",
					owner: 'appendLog/sweep; free threads',
				},
				{
					name: 'L_META',
					slot: 1,
					kind: 'flags',
					doc: 'packed: bits 0-1 OP, bit 2 APPLIED, bit 3 RETIRED, bits 4-8 BATCH_SLOT, bit 9 PSEUDO',
					owner: 'appendLog writes; retirement stamps RETIRED',
				},
				{
					name: 'L_SEQ',
					slot: 2,
					kind: 'seq',
					doc: 'take-a-number ticket at append time',
					owner: 'appendLog/coalesce',
				},
				{
					name: 'L_RETIRED_SEQ',
					slot: 3,
					kind: 'seq',
					doc: '0 while the batch is pending; one fresh ticket stamped per retirement',
					owner: 'retirement stamps',
				},
			],
		},
		{
			name: 'memo',
			plane: 'W',
			fields: [
				{
					name: 'W_KEY',
					slot: 0,
					kind: 'u31',
					doc: 'world key: newest 0; pass (serial<<2)|1; writer (token<<2)|2',
					owner: 'overlayEvaluate',
				},
				{
					name: 'W_EPOCH',
					slot: 1,
					kind: 'u31',
					doc: 'overlayEpoch at evaluation time; 0 is the tombstone value (epochs start at 1)',
					owner: 'overlayEvaluate; re-memoization tombstones',
				},
				{
					name: 'W_NODE',
					slot: 2,
					kind: 'NodeId',
					doc: 'owning computed node id (drain re-validation + stale-head guard)',
					owner: 'overlayEvaluate',
				},
				{
					name: 'W_VAL',
					slot: 3,
					kind: 'u31',
					doc: 'index into the memoVals side array holding the memoized value',
					owner: 'overlayEvaluate; tombstone clears the slot',
				},
				{
					name: 'W_NEXT_MEMO',
					slot: 4,
					kind: 'MemoId',
					doc: "next memo record for the same node (the node's memo chain)",
					owner: 'overlayEvaluate prepends',
				},
				{
					name: 'W_SLOT_NEXT',
					slot: 5,
					kind: 'MemoId',
					doc: "writer's-world records only: next record in the batch slot's memo chain; 0 on other keys",
					owner: 'overlayEvaluate; slot release clears heads',
				},
				{
					name: 'W_NDEPS',
					slot: 6,
					kind: 'u31',
					doc: 'number of certificate pairs',
					owner: 'overlayEvaluate',
				},
				{
					name: 'W_CERT',
					slot: 7,
					kind: 'CertOff',
					doc: "offset of this memo's certificate run in the certificate region",
					owner: 'overlayEvaluate',
				},
			],
		},
	],
	flags: [
		{ name: 'MUTABLE', value: 1, doc: 'can produce new values (atoms, computeds)' },
		{
			name: 'WATCHING',
			value: 2,
			doc: 'wants notification when possibly stale (effects, watchers)',
		},
		{ name: 'RECURSED_CHECK', value: 4, doc: 'currently evaluating (re-entrancy guard)' },
		{ name: 'RECURSED', value: 8, doc: 're-entrant write reached me during my own run' },
		{ name: 'DIRTY', value: 16, doc: 'definitely stale' },
		{ name: 'PENDING', value: 32, doc: 'possibly stale - verify by pulling before recomputing' },
		{
			name: 'HAS_CHILD_EFFECT',
			value: 64,
			doc: 'my dep list contains child effects/scopes (slow-path cleanup)',
		},
		{ name: 'LOGGED', value: 128, doc: 'atoms only: LOG_HEAD !== 0. The read gate.' },
		{
			name: 'IMMEDIATE',
			value: 256,
			doc: 'watchers only: notify synchronously via the broadcast list instead of the effect queue',
		},
		{
			name: 'LIVE',
			value: 512,
			doc: 'RESERVED: superseded by the liveCount side-column refcount (§8.6 conversion); bit kept for layout stability',
		},
		{ name: 'K_ATOM', value: 1024, doc: 'kind bit: atom' },
		{ name: 'K_COMPUTED', value: 2048, doc: 'kind bit: computed' },
		{ name: 'K_EFFECT', value: 4096, doc: 'kind bit: effect' },
		{ name: 'K_SCOPE', value: 8192, doc: 'kind bit: effect scope' },
		{ name: 'K_WATCHER', value: 16384, doc: 'kind bit: watcher (React hook subscription)' },
	],
	derivedMasks: [
		{
			name: 'KIND_MASK',
			of: ['K_ATOM', 'K_COMPUTED', 'K_EFFECT', 'K_SCOPE', 'K_WATCHER'],
			doc: 'union of the kind bits; a freed record has FLAGS 0',
		},
	],
	groups: [
		{
			name: 'log META packing',
			doc: 'bits 0-1 OP, bit 2 APPLIED, bit 3 RETIRED, bits 4-8 BATCH_SLOT, bit 9 PSEUDO (slot-exhaustion fallback)',
			members: [
				{ name: 'OP_BASE', value: 0, doc: 'base record: the snapshot replays start from' },
				{ name: 'OP_SET', value: 1, doc: 'SET: payload replaces the accumulator' },
				{ name: 'OP_UPDATE', value: 2, doc: 'UPDATE: stored function applies to the accumulator' },
				{
					name: 'OP_DISPATCH',
					value: 3,
					doc: "DISPATCH: the atom's reducer applies the stored action",
				},
				{ name: 'OP_MASK', value: 3, doc: 'mask for the op bits' },
				{ name: 'M_APPLIED', value: 4, doc: 'already written through the kernel (urgent writes)' },
				{ name: 'M_RETIRED', value: 8, doc: "the entry's batch retired" },
				{ name: 'SLOT_SHIFT', value: 4, doc: 'batch slot starts at bit 4' },
				{ name: 'SLOT_MASK', value: 31, doc: '5 bits: 32 slots' },
				{
					name: 'M_PSEUDO',
					value: 512,
					doc: 'always-included pseudo-batch fallback (degrades toward urgent)',
				},
			],
		},
		{
			name: 'read contexts',
			doc: 'per-read ambient context (a module scalar, kept correct by fork edges)',
			members: [
				{ name: 'CTX_NEWEST', value: 1, doc: 'default: everything visible (Wn)' },
				{
					name: 'CTX_RENDER',
					value: 2,
					doc: 'while React executes render code: the pass world (Wp)',
				},
				{
					name: 'CTX_COMMITTED',
					value: 3,
					doc: 'useSignalEffect callbacks and SSR: committed views',
				},
			],
		},
		{
			name: 'world kinds',
			doc: 'internal world-descriptor discriminants',
			members: [
				{
					name: 'WK_W0',
					value: 0,
					doc: 'the canonical world (committed + applied) the kernel maintains',
				},
				{ name: 'WK_NEWEST', value: 1, doc: 'every write visible' },
				{ name: 'WK_PASS', value: 2, doc: 'a render pass: pin + include mask' },
				{
					name: 'WK_WRITER',
					value: 3,
					doc: "a batch's writer world: retired + applied + own entries",
				},
				{
					name: 'WK_COMMITTED',
					value: 4,
					doc: 'committed views: retired-only, per-root refined by pin + lock-in mask',
				},
			],
		},
		{
			name: 'write modes',
			doc: 'the §9.1 monotonic gate',
			members: [
				{ name: 'MODE_DIRECT', value: 0, doc: 'pure kernel writes (pre-activation, servers)' },
				{
					name: 'MODE_LOGGED',
					value: 1,
					doc: 'every write is logged - permanently after first root registration',
				},
			],
		},
	],
	constants: [{ name: 'MAX_SEQ', value: 0x7fffffff, doc: 'infinity for pin comparisons' }],
	sideColumns: [
		{
			name: 'values',
			index: 'id >> 2 (+1)',
			doc: 'atom current value / computed cached value; slot 1: atom kernel pending value / effect cleanup',
		},
		{ name: 'fns', index: 'id >> 3', doc: 'computed kernel wrapper / effect function' },
		{
			name: 'memos',
			index: 'id >> 3',
			doc: 'node memo-chain head in plane W (guarded by W_NODE, §7.4)',
		},
		{
			name: 'metas',
			index: 'id >> 3',
			doc: 'policy metadata object (isEqual, reducer, rawFn, lastBroadcast, observeEffect)',
		},
		{
			name: 'unappliedStamp',
			index: 'id >> 3',
			doc: 'era-scoped "unapplied entries below me" walk-ticket stamps (per-cone NEWEST gate)',
		},
		{
			name: 'liveCount',
			index: 'id >> 3',
			doc: 'count of LIVE direct subscribers; LIVE(node) := count > 0 || effect/scope/watcher kind (§8.6 refcount)',
		},
		{
			name: 'logVals',
			index: 'gid >> 2',
			doc: 'log-entry payload: SET value / UPDATE fn / DISPATCH action / BASE snapshot',
		},
		{ name: 'memoVals', index: 'allocated', doc: 'world-memo values (undefined for tombstones)' },
	],
})
