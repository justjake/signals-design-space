/**
 * The layout schema and its generator — the single author-editable source of
 * truth for the engine's arena geometry: record field slots, flag bits, the
 * arena shape constants, and the side-column roster with its per-column
 * reset/scrub metadata. Evaluated by running this file (`pnpm gen`, which is
 * `node --experimental-strip-types tools/schema.ts`); never imported by
 * shipping code — the generator writes the layout into the engine source and
 * a debug twin, and a regen-diff test (tests/schema-gen.spec.ts) regenerates
 * in memory and string-compares, so drift is a test failure, not a review
 * burden.
 *
 * Emits, deterministically (schema order, no timestamps):
 *
 * 1. the generated layout region in src/CosignalEngine.ts, bracketed by
 *    markers — the const enums (NodeField, LinkField, NodeFlag, ArenaShape)
 *    plus the column scrub/reset functions, the only generated text inside a
 *    handwritten file; the generator only ever rewrites text between its own
 *    markers and fails hard when they are missing or duplicated;
 * 2. the debug twin src/debug/layout.debug.ts (whole file generated; imports
 *    nothing from the engine): field tables as runtime data, flag decoding,
 *    record hydrators, and the column roster.
 *
 * Why the scrub functions are generated: a freed record's side-column slots
 * must all clear, or the slot's next tenant inherits the old tenant's
 * values/closures/clocks — every column declared here participates in the
 * free-path scrub and the test reset by construction, so adding a column
 * cannot forget its cleanup.
 *
 * Any change to strides, field slots, flag bits, or column shapes bumps
 * LAYOUT_VERSION.
 */

// ---- schema types ----------------------------------------------------------------

export type FieldKind = 'flags' | 'NodeId' | 'LinkId' | 'u31' | 'ordinal';

export type Field = {
	/** const-enum member name */
	name: string;
	slot: number;
	kind: FieldKind;
	/** doc comment lines (emitted as a block comment above the member) */
	doc: string[];
	/** documented reuse of another field's slot (kind-dependent aliasing) */
	alias?: boolean;
};

export type RecordFamily = {
	/** const-enum name, e.g. 'NodeField' */
	enumName: string;
	/** prose name, e.g. 'node' */
	name: string;
	doc: string[];
	fields: Field[];
};

export type FlagBit = {
	name: string;
	bit: number;
	doc: string[];
};

/**
 * A side column: JavaScript values running parallel to the arena, indexed by
 * shifting the premultiplied record id. `storage: 'growArray'` is a plain
 * array grown by the allocators (stays packed; no rebuild problem);
 * `storage: 'recordBuffer'` is a typed buffer sized one-slot-per-record,
 * created and carried by the kernel factory exactly like the arena itself.
 */
export type SideColumn = {
	/** module binding name in the engine source */
	name: string;
	storage: 'growArray' | 'recordBuffer';
	/** slots per record (growArray only; recordBuffer is always 1) */
	slotsPerRecord: number;
	/** the ArenaShape member naming the id-to-slot shift */
	shiftConst: string;
	/** per-slot docs; slot offsets above 0 may name an ArenaShape offset const */
	slots: { doc: string; offsetConst?: string }[];
	/** the value a scrubbed/reset slot returns to */
	emptyValue: 'undefined' | '0';
	/** which record families' frees scrub this column's slots */
	scrubOnFree: ('node' | 'link')[];
	doc: string[];
};

export type ShapeConst = {
	name: string;
	value: number;
	doc: string[];
};

export type Schema = {
	layoutVersion: number;
	/** Int32 fields per record; ids are premultiplied by this */
	stride: number;
	families: RecordFamily[];
	flagEnumName: string;
	flagDoc: string[];
	/** the node FLAGS word registry; the generator fails on overlapping bits */
	flags: FlagBit[];
	/** names of the flag bits that form KIND_MASK */
	kindBits: string[];
	kindMaskDoc: string;
	shapeEnumName: string;
	shapeDoc: string[];
	/** shape constants beyond the stride and the derived column shifts */
	shapeConsts: ShapeConst[];
	columns: SideColumn[];
};

// ---- validation ------------------------------------------------------------------

export function defineSchema(s: Schema): Schema {
	if ((s.stride & (s.stride - 1)) !== 0) {
		throw new Error('schema: stride must be a power of two (ids are shift-addressed)');
	}
	let seen = 0;
	for (const f of s.flags) {
		if ((seen & f.bit) !== 0) {
			throw new Error(`schema: overlapping flag bit ${f.name}`);
		}
		if ((f.bit & (f.bit - 1)) !== 0) {
			throw new Error(`schema: flag ${f.name} is not a single bit`);
		}
		if (f.doc.length === 0) {
			throw new Error(`schema: flag ${f.name} undocumented`);
		}
		seen |= f.bit;
	}
	for (const k of s.kindBits) {
		if (!s.flags.some((f) => f.name === k)) {
			throw new Error(`schema: kind bit ${k} not in the flag registry`);
		}
	}
	for (const fam of s.families) {
		const slots = new Set<number>();
		for (const f of fam.fields) {
			if (f.slot < 0 || f.slot >= s.stride) {
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
	const familyNames = new Set(s.families.map((f) => f.name));
	for (const c of s.columns) {
		const slots = c.storage === 'recordBuffer' ? 1 : c.slotsPerRecord;
		if (slots < 1 || s.stride % slots !== 0 || ((s.stride / slots) & (s.stride / slots - 1)) !== 0) {
			throw new Error(`schema: column ${c.name} slots-per-record must divide the stride to a power of two`);
		}
		if (c.slots.length !== slots) {
			throw new Error(`schema: column ${c.name} declares ${c.slots.length} slot docs for ${slots} slots`);
		}
		for (const target of c.scrubOnFree) {
			if (!familyNames.has(target)) {
				throw new Error(`schema: column ${c.name} scrubs unknown family ${target}`);
			}
		}
		if (c.doc.length === 0) {
			throw new Error(`schema: column ${c.name} undocumented`);
		}
	}
	return s;
}

// ---- the schema ------------------------------------------------------------------

export const schema: Schema = defineSchema({
	layoutVersion: 1,
	stride: 8,
	families: [
		{
			enumName: 'NodeField',
			name: 'node',
			doc: [
				'Field offsets within a node arena record.',
				'NodeId is an offset pointer to the first field of the record;',
				'to access a field, add its offset to the NodeId:',
				'',
				'    const depId = memory[nodeId + NodeField.DEPS]',
				'',
				'## Why const enum?',
				'',
				'TypeScript and compliant bundlers inline `const enum` member expressions',
				'as number literals. This gives us the best chance the JavaScript JIT',
				'will specialize expressions using `const enum`.',
				'',
				'`export const Foo = { A: 1, ... }` style "enum objects" or even',
				'`export const FOO_A = 1` module constant exports can be rewritten by',
				'bundlers to less efficient forms the JIT cannot understand. For example,',
				'some versions of esbuild demote module-scope `const` to `var`, preventing',
				"TurboFan's constant-folding optimizations; this was measured to cost",
				'15-21% on benchmark workloads.',
				'',
				'## Why exported?',
				'',
				'The layout is generated into this file — the engine owns its record',
				'layout — and the enums other modules walk engine records with are',
				'exported so those consumers import the one definition instead of',
				'hand-copying numbers a field reorder would silently orphan. A cross-file',
				'member access still inlines under whole-program tsc emit and esbuild',
				'bundling; per-file transforms (tsx, vitest) fall back to a property read',
				"of the emitted enum object — acceptable at the consumers' cold-to-warm",
				"sites, never in the engine's own hot paths (which are all same-file by",
				'construction).',
			],
			fields: [
				{ name: 'FLAGS', slot: 0, kind: 'flags', doc: ['State machine + kind bits (see NodeFlag).'] },
				{ name: 'DEPS', slot: 1, kind: 'LinkId', doc: ['First dependency link; doubles as the free-list next pointer for freed records.'] },
				{ name: 'DEPS_TAIL', slot: 2, kind: 'LinkId', doc: ['Last confirmed dependency link (the re-track cursor during evaluation).'] },
				{ name: 'SUBS', slot: 3, kind: 'LinkId', doc: ['First subscriber link.'] },
				{ name: 'SUBS_TAIL', slot: 4, kind: 'LinkId', doc: ['Last subscriber link.'] },
				{ name: 'GEN', slot: 5, kind: 'u31', doc: ['Tenancy generation: bumped on free; disposers and finalizers capture it to defuse stale ids.'] },
				{
					name: 'LIFECYCLE', slot: 6, kind: 'u31', doc: [
						'1 iff the node is an atom carrying an observed-lifecycle effect',
						'(AtomOptions.effect). Set once at construction by the markLifecycle op;',
						'cleared when the record frees. Gates the per-link lifecycle',
						"retain/release in linkInsert/unlink and the lifecycle rehydration probe —",
						'atoms without the option never pay a lifecycle instruction.',
						'',
						'## Why a whole field for one bit?',
						'',
						'We tried folding it into FLAGS as a bit. That forces write() and',
						'updateSignal() to preserve the bit, turning their constant flag',
						'stores into read-modify-writes on the hottest write path — measured',
						'+0.2 ns per bare write and +3-4% on write-storm composites. A dedicated',
						'field keeps flag stores constant, and the record is stride-8 either',
						'way, so the field is free.',
					],
				},
				{
					name: 'NODE_INDEX', slot: 7, kind: 'ordinal', doc: [
						"The record's node index: a dense per-node ordinal (never an identity)",
						'assigned once when a slot first hosts a node and inherited by every',
						'later tenant of the slot (the node free list threads through DEPS, so',
						'freeNode leaves this field untouched). Consumers key dense per-node',
						'side tables by it: node and link records share one allocator, so',
						'record-id-keyed tables would go holey where index-keyed ones stay',
						'packed. Node records only — link records use slot 7 as FREE_NEXT',
						'(the two record kinds already interpret fields differently).',
					],
				},
			],
		},
		{
			enumName: 'LinkField',
			name: 'link',
			doc: [
				'Field offsets within a link arena record (link records share the arena,',
				'stride, and premultiplied ids with node records; see NodeField for the',
				'offset-pointer access pattern and the const-enum rationale).',
			],
			fields: [
				{ name: 'VERSION', slot: 0, kind: 'u31', doc: ['Evaluation-cycle stamp: intra-run duplicate-read dedup.'] },
				{ name: 'DEP', slot: 1, kind: 'NodeId', doc: ['Producer node id.'] },
				{ name: 'SUB', slot: 2, kind: 'NodeId', doc: ['Consumer node id.'] },
				{ name: 'PREV_SUB', slot: 3, kind: 'LinkId', doc: ["Previous link in the producer's subscriber list."] },
				{ name: 'NEXT_SUB', slot: 4, kind: 'LinkId', doc: ["Next link in the producer's subscriber list."] },
				{ name: 'PREV_DEP', slot: 5, kind: 'LinkId', doc: ["Previous link in the consumer's dependency list."] },
				{ name: 'NEXT_DEP', slot: 6, kind: 'LinkId', doc: ["Next link in the consumer's dependency list."] },
				{
					name: 'FREE_NEXT', slot: 7, kind: 'LinkId', doc: [
						'The free list threads through the spare field so a freed link keeps',
						"every real field intact: the walks deliberately read stale",
						'nextDep/nextSub off links unlinked earlier in the same walk',
						'(conformance case 203 exercises this; tests/freelist.spec.ts pins it',
						'with a primed free list), and those stale pointers must name former',
						'neighbors — never the free list.',
					],
				},
			],
		},
	],
	flagEnumName: 'NodeFlag',
	flagDoc: [
		"Bit values of a node's FLAGS field (upstream ReactiveFlags + HasChildEffect",
		'+ kind bits). A flags word is an OR of these (see `type NodeFlags`).',
	],
	flags: [
		{ name: 'MUTABLE', bit: 0b000000000000001, doc: ['Can produce new values (signals, computeds).'] },
		{ name: 'WATCHING', bit: 0b000000000000010, doc: ['Wants notification when possibly stale (effects, scopes).'] },
		{ name: 'RECURSED_CHECK', bit: 0b000000000000100, doc: ['Currently evaluating (re-entrancy guard).'] },
		{ name: 'RECURSED', bit: 0b000000000001000, doc: ['A re-entrant write reached this node during its own run.'] },
		{ name: 'DIRTY', bit: 0b000000000010000, doc: ['Definitely stale.'] },
		{ name: 'PENDING', bit: 0b000000000100000, doc: ['Possibly stale — verify by pulling before recomputing.'] },
		{ name: 'HAS_CHILD_EFFECT', bit: 0b000000001000000, doc: ['Dep list contains child effects/scopes (slow-path cleanup).'] },
		{ name: 'K_SIGNAL', bit: 0b000000010000000, doc: ['Kind: writable signal record (an Atom or ReducerAtom handle).'] },
		{ name: 'K_COMPUTED', bit: 0b000000100000000, doc: ['Kind: computed.'] },
		{ name: 'K_EFFECT', bit: 0b000001000000000, doc: ['Kind: effect.'] },
		{ name: 'K_SCOPE', bit: 0b000010000000000, doc: ['Kind: effect scope.'] },
		{
			name: 'HAS_BOX', bit: 0b000100000000000, doc: [
				"The computed's cached value is an exceptional outcome — the value slot",
				'holds the raw thrown value (HAS_BOX alone) or the pending thenable',
				'(HAS_BOX | BOX_SUSPENDED). Set exactly at the two kernel catch sites',
				'(with storeThrown); the eval-start flag rewrite in updateComputed',
				'preserves the bits while the getter runs (ctx.previous and the isEqual',
				'wrapper filter the residual slot payload by them) and a successful',
				"evaluation clears them in the finally's flag write — every other flag",
				'site either ORs bits or is followed by a forced recompute (unwatched',
				'sets DIRTY), so a stale clear can never serve a payload unwrapped.',
			],
		},
		{
			name: 'BOX_SUSPENDED', bit: 0b001000000000000, doc: [
				'Refines HAS_BOX (never set without it): the payload is a pending',
				'thenable, not a thrown error.',
			],
		},
		{
			name: 'MACHINERY_OWNED', bit: 0b010000000000000, doc: [
				"Marks kernel records created by the engine's own machinery (world",
				"folds, subscription captures) rather than by a user's handle. Its one",
				"hot job: keep machinery reads from counting toward a user atom's",
				'observed-lifecycle union — the "first subscriber attached / last one',
				'detached" callback (linkInsert/unlink skip the retain/release when the',
				'subscriber carries this bit; the machinery\'s observation index',
				'contributes to the union on its own terms instead, so a machinery',
				"computed's dep structure never pins an atom's remote subscription past",
				'its last real consumer). Set via the markMachineryOwned op when a',
				'computed gains concurrent-machinery content.',
			],
		},
	],
	kindBits: ['K_SIGNAL', 'K_COMPUTED', 'K_EFFECT', 'K_SCOPE'],
	kindMaskDoc: 'The kind bits together (exactly one is set on a live record).',
	shapeEnumName: 'ArenaShape',
	shapeDoc: [
		"Arena shape: the strides, shifts, and offsets that address a record's",
		'fields and its side-column slots from its premultiplied id (see',
		'NodeField for the const-enum rationale).',
	],
	shapeConsts: [
		{
			name: 'AUX_VALUE_OFFSET', value: 1, doc: [
				"valueIndex + AUX_VALUE_OFFSET: the record's second value slot — a",
				"signal's pending value or an effect's cleanup fn. Computeds leave it",
				'empty on purpose: nothing kernel-side may pin the public handle, or a',
				"dropped handle's record could never be reclaimed.",
			],
		},
		{
			name: 'HALF_ARENA_SHIFT', value: 1, doc: [
				'length >> HALF_ARENA_SHIFT: half the arena — the "keep at least half',
				'the arena free" watermark term.',
			],
		},
		{
			name: 'RECORDS_PER_UNIT', value: 3, doc: [
				'Records budgeted per configured capacity unit: one node + two links.',
			],
		},
		{
			name: 'REC_SLACK', value: 1280, doc: [
				'Min free records guaranteed at each op boundary. Nodes and links draw',
				'from one shared pool; the slack is the sum of per-kind floors (256 node',
				'+ 1024 link records), so any allocation pattern that fit those floors',
				'separately still fits the merged slack.',
			],
		},
	],
	columns: [
		{
			name: 'values',
			storage: 'growArray',
			slotsPerRecord: 2,
			shiftConst: 'ID_TO_VALUE_SHIFT',
			slots: [
				{ doc: 'current/computed value' },
				{ doc: "signal pending value or effect cleanup fn (computeds: empty on purpose)", offsetConst: 'AUX_VALUE_OFFSET' },
			],
			emptyValue: 'undefined',
			scrubOnFree: ['node'],
			doc: [
				'JavaScript values cannot live in an Int32Array, so each record owns two',
				'slots here: values[id >> ID_TO_VALUE_SHIFT] is the current/computed',
				'value; the slot above it (+ AUX_VALUE_OFFSET) is a signal\'s pending',
				"value or an effect's cleanup fn. Plain array grown by the allocators",
				'(stays packed; plain-array growth has no rebuild problem).',
			],
		},
		{
			name: 'fns',
			storage: 'growArray',
			slotsPerRecord: 1,
			shiftConst: 'ID_TO_FN_SHIFT',
			slots: [
				{ doc: "computed getter / effect fn / an atom's dormant lifecycle callback" },
			],
			emptyValue: 'undefined',
			scrubOnFree: ['node'],
			doc: [
				"One function slot per record: a computed's getter (or its equality",
				"wrapper), an effect's body, or an atom's dormant observed-lifecycle",
				'callback. Plain array grown by the allocators.',
			],
		},
		{
			name: 'clocks',
			storage: 'recordBuffer',
			slotsPerRecord: 1,
			shiftConst: 'ID_TO_CLOCK_SHIFT',
			slots: [
				{ doc: 'node: updatedAt (tagged-outcome clock) / link: the observer\'s lastValidatedAt' },
			],
			emptyValue: '0',
			scrubOnFree: ['node', 'link'],
			doc: [
				'The updated-at clock column, one float64 slot per record (see the',
				'"UpdatedAt clocks" section in the engine source for the full story).',
				"A node record's slot is its durable clock: a process-monotone stamp",
				'moved when the node\'s tagged outcome (value / thrown / suspended)',
				"changes. A link record's slot is observer state: the last producer",
				'clock the owning subscriber validated against. Zero means "never".',
				'A Float64Array created and carried by the kernel factory exactly like',
				'the arena (hot code closes over it; growth rebuilds), because a plain',
				'array would need a growth check in the link allocator\'s hot path.',
			],
		},
	],
});

// ---- generator: the engine's layout region ---------------------------------------

export const MARKER_START =
	'// #region GENERATED — layout v{V} (from tools/schema.ts; run `pnpm gen`) — DO NOT EDIT';
export const MARKER_END = '// #endregion GENERATED layout';

function markerStart(s: Schema): string {
	return MARKER_START.replace('{V}', String(s.layoutVersion));
}

/** Emit a doc block at the given tab depth. */
function docBlock(lines: string[], depth: number): string[] {
	const pad = '\t'.repeat(depth);
	if (lines.length === 1) {
		return [`${pad}/** ${lines[0]} */`];
	}
	return [`${pad}/**`, ...lines.map((l) => (l.length === 0 ? `${pad} *` : `${pad} * ${l}`)), `${pad} */`];
}

/** Pad a flag value to the fixed-width 0b literal style the flag word uses. */
function flagLiteral(bit: number, width: number): string {
	return `0b${bit.toString(2).padStart(width, '0')}`;
}

/** The shift that maps a premultiplied id to the column's base slot. */
function columnShift(s: Schema, c: SideColumn): number {
	return Math.round(Math.log2(s.stride / (c.storage === 'recordBuffer' ? 1 : c.slotsPerRecord)));
}

export function generateLayoutBlock(s: Schema): string {
	const out: string[] = [];
	out.push(markerStart(s));
	// Field enums, one per record family.
	for (const fam of s.families) {
		out.push(...docBlock(fam.doc, 0));
		out.push(`export const enum ${fam.enumName} {`);
		for (const f of fam.fields) {
			out.push(...docBlock(f.doc, 1));
			out.push(`\t${f.name} = ${f.slot},`);
		}
		out.push('}');
		out.push('');
	}
	// The flags word.
	const width = Math.max(...s.flags.map((f) => f.bit.toString(2).length));
	out.push(...docBlock(s.flagDoc, 0));
	out.push(`export const enum ${s.flagEnumName} {`);
	for (const f of s.flags) {
		out.push(...docBlock(f.doc, 1));
		out.push(`\t${f.name} = ${flagLiteral(f.bit, width)},`);
	}
	const kindMask = s.flags.filter((f) => s.kindBits.includes(f.name)).reduce((m, f) => m | f.bit, 0);
	out.push(...docBlock([s.kindMaskDoc], 1));
	out.push(`\tKIND_MASK = ${s.kindBits.join(' | ')}, // ${flagLiteral(kindMask, width)}`);
	out.push('}');
	out.push('');
	// The arena shape.
	out.push(...docBlock(s.shapeDoc, 0));
	out.push(`export const enum ${s.shapeEnumName} {`);
	out.push(...docBlock(['Int32 fields per record; ids are premultiplied by this (id = record ordinal × STRIDE).'], 1));
	out.push(`\tSTRIDE = ${s.stride},`);
	for (const c of s.columns) {
		out.push(...docBlock([`id >> ${c.shiftConst}: premultiplied id → the record's base slot in the \`${c.name}\` column (${c.storage === 'recordBuffer' ? 1 : c.slotsPerRecord} slot${(c.storage !== 'recordBuffer' && c.slotsPerRecord > 1) ? 's' : ''} per record).`], 1));
		out.push(`\t${c.shiftConst} = ${columnShift(s, c)},`);
	}
	for (const k of s.shapeConsts) {
		out.push(...docBlock(k.doc, 1));
		out.push(`\t${k.name} = ${k.value},`);
	}
	out.push('}');
	out.push('');
	// Column scrub/reset functions: free/reset correctness is generated, not
	// hand-maintained — every declared column participates by construction.
	const bufferParams = s.columns
		.filter((c) => c.storage === 'recordBuffer')
		.map((c) => `${c.name}: Float64Array`);
	for (const fam of s.families) {
		const participating = s.columns.filter((c) => c.scrubOnFree.includes(fam.name as 'node' | 'link'));
		const fname = `scrub${fam.name[0].toUpperCase()}${fam.name.slice(1)}ColumnsOnFree`;
		const params = ['id: ' + (fam.name === 'node' ? 'NodeId' : 'LinkId')];
		for (const c of participating) {
			if (c.storage === 'recordBuffer') {
				params.push(`${c.name}: Float64Array`);
			}
		}
		out.push(...docBlock([
			`Scrub a freed ${fam.name} record's side-column slots (generated from the`,
			'column roster): the slot\'s next tenant must never observe the old',
			"tenant's values, closures, or clock stamps. recordBuffer columns are",
			'closure-owned, so the caller passes its buffer.',
		], 0));
		out.push(`function ${fname}(${params.join(', ')}): void {`);
		for (const c of participating) {
			if (c.storage === 'growArray' && c.slotsPerRecord > 1) {
				out.push(`\tconst base: ValueIndex = id >> ${s.shapeEnumName}.${c.shiftConst};`);
				c.slots.forEach((slot, i) => {
					const idx = i === 0 ? 'base' : `base + ${slot.offsetConst !== undefined ? `${s.shapeEnumName}.${slot.offsetConst}` : String(i)}`;
					out.push(`\t${c.name}[${idx}] = ${c.emptyValue}; // ${slot.doc}`);
				});
			} else {
				out.push(`\t${c.name}[id >> ${s.shapeEnumName}.${c.shiftConst}] = ${c.emptyValue}; // ${c.slots[0].doc}`);
			}
		}
		out.push('}');
		out.push('');
	}
	// The test reset: every column returns to its burned-record-zero seed.
	out.push(...docBlock([
		'Reset every side column to its record-zero seed (generated from the',
		'column roster; the test reset\'s column half). Grow-arrays truncate;',
		'record buffers zero-fill in place (the arena keeps its capacity).',
	], 0));
	out.push(`function resetSideColumnsForTest(${bufferParams.join(', ')}): void {`);
	for (const c of s.columns) {
		if (c.storage === 'growArray') {
			out.push(`\t${c.name}.length = ${c.slotsPerRecord};`);
			for (let i = 0; i < c.slotsPerRecord; i++) {
				out.push(`\t${c.name}[${i}] = ${c.emptyValue};`);
			}
		} else {
			out.push(`\t${c.name}.fill(${c.emptyValue});`);
		}
	}
	out.push('}');
	out.push(MARKER_END);
	return out.join('\n');
}

// ---- generator: the debug twin -----------------------------------------------------

export function generateDebugTwin(s: Schema): string {
	const out: string[] = [];
	out.push('// GENERATED FILE — from tools/schema.ts; run `pnpm gen`. DO NOT EDIT.');
	out.push('// The debug twin: field tables as runtime data, flag decoding, record');
	out.push('// hydrators, and the side-column roster. Imports nothing from the engine;');
	out.push('// none of it ships on a hot path.');
	out.push('');
	out.push(`export const LAYOUT_VERSION = ${s.layoutVersion};`);
	out.push(`export const STRIDE = ${s.stride};`);
	out.push('');
	out.push('export type FieldInfo = {');
	out.push('\tname: string;');
	out.push('\tslot: number;');
	out.push('\tkind: string;');
	out.push('\tdoc: string;');
	out.push('};');
	out.push('');
	out.push('export const FIELDS_BY_RECORD: Record<string, readonly FieldInfo[]> = {');
	for (const fam of s.families) {
		out.push(`\t${fam.name}: [`);
		for (const f of fam.fields) {
			out.push(
				`\t\t{ name: ${JSON.stringify(f.name)}, slot: ${f.slot}, kind: ${JSON.stringify(f.kind)}, doc: ${JSON.stringify(f.doc.join(' '))} },`,
			);
		}
		out.push('\t],');
	}
	out.push('};');
	out.push('');
	out.push('export const FLAG_BITS: Record<string, number> = {');
	for (const f of s.flags) {
		out.push(`\t${f.name}: ${f.bit},`);
	}
	out.push('};');
	out.push('');
	out.push('export type ColumnInfo = {');
	out.push('\tname: string;');
	out.push('\tstorage: string;');
	out.push('\tslotsPerRecord: number;');
	out.push('\tshift: number;');
	out.push('\tscrubOnFree: readonly string[];');
	out.push('};');
	out.push('');
	out.push('export const COLUMNS: readonly ColumnInfo[] = [');
	for (const c of s.columns) {
		out.push(
			`\t{ name: ${JSON.stringify(c.name)}, storage: ${JSON.stringify(c.storage)}, slotsPerRecord: ${c.storage === 'recordBuffer' ? 1 : c.slotsPerRecord}, shift: ${columnShift(s, c)}, scrubOnFree: ${JSON.stringify(c.scrubOnFree)} },`,
		);
	}
	out.push('];');
	out.push('');
	out.push('/** Decode a FLAGS word into the set flag names. */');
	out.push('export function decodeFlags(flags: number): string[] {');
	out.push('\tconst out: string[] = [];');
	out.push('\tfor (const [name, bit] of Object.entries(FLAG_BITS)) {');
	out.push('\t\tif ((flags & bit) !== 0) {');
	out.push('\t\t\tout.push(name);');
	out.push('\t\t}');
	out.push('\t}');
	out.push('\treturn out;');
	out.push('}');
	out.push('');
	for (const fam of s.families) {
		const fname = `hydrate${fam.name[0].toUpperCase()}${fam.name.slice(1)}`;
		out.push(`/** Decode one ${fam.name} record into a plain object. */`);
		out.push(`export function ${fname}(memory: Int32Array, id: number): Record<string, unknown> {`);
		out.push('\tconst out: Record<string, unknown> = { id };');
		out.push(`\tfor (const f of FIELDS_BY_RECORD.${fam.name}) {`);
		out.push('\t\tout[f.name] = memory[id + f.slot];');
		out.push('\t}');
		if (fam.fields.some((f) => f.kind === 'flags')) {
			out.push('\tout.flagNames = decodeFlags(memory[id + 0]);');
		}
		out.push('\treturn out;');
		out.push('}');
		out.push('');
	}
	return out.join('\n');
}

// ---- splice ----------------------------------------------------------------------

/** Rewrite the generated region of the engine source; fails hard on missing
 * or duplicated markers. Returns the new content. */
export function spliceLayoutBlock(engineSource: string, s: Schema): string {
	const start = markerStart(s);
	const first = engineSource.indexOf(start);
	if (first === -1) {
		throw new Error('schema: start marker not found in src/CosignalEngine.ts');
	}
	if (engineSource.indexOf(start, first + 1) !== -1) {
		throw new Error('schema: duplicated start marker');
	}
	const endIdx = engineSource.indexOf(MARKER_END, first);
	if (endIdx === -1) {
		throw new Error('schema: end marker not found');
	}
	return (
		engineSource.slice(0, first)
		+ generateLayoutBlock(s)
		+ engineSource.slice(endIdx + MARKER_END.length)
	);
}

// ---- CLI entry -------------------------------------------------------------------

async function main(): Promise<void> {
	const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
	const { dirname, join } = await import('node:path');
	const { fileURLToPath } = await import('node:url');
	const here = dirname(fileURLToPath(import.meta.url));
	const enginePath = join(here, '..', 'src', 'CosignalEngine.ts');
	const twinPath = join(here, '..', 'src', 'debug', 'layout.debug.ts');
	const engine = readFileSync(enginePath, 'utf8');
	writeFileSync(enginePath, spliceLayoutBlock(engine, schema));
	mkdirSync(dirname(twinPath), { recursive: true });
	writeFileSync(twinPath, generateDebugTwin(schema));
	// eslint-disable-next-line no-console
	(globalThis as { console?: { log(m: string): void } }).console?.log(
		'schema: wrote the src/CosignalEngine.ts layout region + src/debug/layout.debug.ts',
	);
}

const isMain = (() => {
	const argv1 = (globalThis as { process?: { argv?: string[] } }).process?.argv?.[1];
	return argv1 !== undefined && import.meta.url.endsWith(argv1.split('/').pop() ?? '!');
})();

if (isMain) {
	void main();
}
