/**
 * The layout schema and its generator — the single author-editable source of
 * truth for the engine's arena geometry: record field slots, flag bits, the
 * shape constants, and the side-column rosters with their per-column
 * grow/scrub/reset metadata. Evaluated by running this file (`pnpm gen`,
 * which is `node --experimental-strip-types tools/schema.ts`); never
 * imported by shipping code — the generator writes the layout into the
 * engine source and a debug twin, and a regen-diff test
 * (tests/schema-gen.spec.ts) regenerates in memory and string-compares, so
 * drift is a test failure, not a review burden.
 *
 * Two storage domains, one generated region:
 *
 *  - the KERNEL arena: the one shared module-level Int32Array holding every
 *    node and link record, with module-level side columns (values, fns) and
 *    the factory-carried clock buffer;
 *  - the WORLD arenas: one pooled arena per open world (the WorldArena
 *    class), whose shadow/link records live in a per-instance buffer with
 *    per-instance side columns.
 *
 * Emits, deterministically (schema order, no timestamps):
 *
 * 1. the generated layout region in src/CosignalEngine.ts, bracketed by
 *    markers — the const enums for both domains plus the column
 *    grow/scrub/reset functions, the only generated text inside a
 *    handwritten file; the generator only ever rewrites text between its
 *    own markers and fails hard when they are missing or duplicated;
 * 2. the debug twin src/debug/layout.debug.ts (whole file generated;
 *    imports nothing from the engine): field tables as runtime data, flag
 *    decoding, record hydrators, and the column rosters.
 *
 * Why the column functions are generated: a freed or evicted record's
 * side-column slots must all clear, the grown-together columns must all
 * grow, and a released arena's columns must all reset — every column
 * declared here participates by construction, so adding a column cannot
 * forget its growth loop, its scrub, or its reset.
 *
 * Any change to strides, field slots, flag bits, or column shapes bumps
 * LAYOUT_VERSION.
 */

// ---- schema types ----------------------------------------------------------------

export type FieldKind = 'flags' | 'NodeId' | 'LinkId' | 'ShadowId' | 'ArenaLinkId' | 'u31' | 'ordinal' | 'packed';

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

export type FlagEnum = {
	/** const-enum name, e.g. 'NodeFlag' */
	name: string;
	doc: string[];
	flags: FlagBit[];
	/** names of the bits that form KIND_MASK (emitted only when present) */
	kindBits?: string[];
	kindMaskDoc?: string;
};

export type ShapeConst = {
	name: string;
	value: number;
	doc: string[];
};

/**
 * A kernel-arena side column: JavaScript values running parallel to the
 * module-level arena, indexed by shifting the premultiplied record id.
 * `storage: 'growArray'` is a plain module-level array grown by the
 * allocators (stays packed; no rebuild problem); `storage: 'recordBuffer'`
 * is a typed buffer sized one-slot-per-record, created and carried by the
 * kernel factory exactly like the arena itself.
 */
export type KernelColumn = {
	/** module binding name in the engine source */
	name: string;
	storage: 'growArray' | 'recordBuffer';
	/** slots per record (growArray only; recordBuffer is always 1) */
	slotsPerRecord: number;
	/** the shape-enum member naming the id-to-slot shift */
	shiftConst: string;
	/** per-slot docs; slot offsets above 0 may name a shape offset const */
	slots: { doc: string; offsetConst?: string }[];
	/** the value a scrubbed/reset slot returns to */
	emptyValue: 'undefined' | '0';
	/** which record families' frees scrub this column's slots */
	scrubOnFree: ('node' | 'link')[];
	doc: string[];
};

/**
 * A world-arena side column: a field on each WorldArena instance, running
 * parallel to that arena's buffer. `keyedBy: 'record'` columns index by
 * shadow/link record ordinal (id >> ID_TO_COLUMN_SHIFT); the one
 * `keyedBy: 'nodeIndex'` column (nodeToShadow) indexes by the kernel's
 * dense node ordinal. `storage: 'growArray'` columns grow together in the
 * shadow allocator; `storage: 'clockBuffer'` is the growable float64
 * buffer resized in step with the arena's own buffer.
 */
export type WorldColumn = {
	/** field name on the WorldArena class */
	name: string;
	keyedBy: 'record' | 'nodeIndex';
	storage: 'growArray' | 'clockBuffer';
	emptyValue: 'undefined' | '0';
	/** grows in the shadow allocator's grown-together loop */
	grownWithShadow: boolean;
	/** scrubbed when a shadow record's tenancy dies (evict/purge) */
	scrubOnEvict: boolean;
	doc: string[];
};

export type ArenaDomain = {
	/** prose name for docs */
	name: string;
	stride: number;
	/** whether the emitted enums carry `export` */
	exportEnums: boolean;
	families: RecordFamily[];
	flagEnums: FlagEnum[];
	shapeEnum: { name: string; doc: string[]; consts: ShapeConst[] };
};

export type Schema = {
	layoutVersion: number;
	kernel: ArenaDomain & { columns: KernelColumn[] };
	worldArena: ArenaDomain & { columns: WorldColumn[] };
};

// ---- validation ------------------------------------------------------------------

function validateDomain(d: ArenaDomain): void {
	if ((d.stride & (d.stride - 1)) !== 0) {
		throw new Error(`schema: ${d.name} stride must be a power of two (ids are shift-addressed)`);
	}
	for (const fe of d.flagEnums) {
		let seen = 0;
		for (const f of fe.flags) {
			if ((seen & f.bit) !== 0) {
				throw new Error(`schema: overlapping flag bit ${fe.name}.${f.name}`);
			}
			if ((f.bit & (f.bit - 1)) !== 0) {
				throw new Error(`schema: flag ${fe.name}.${f.name} is not a single bit`);
			}
			if (f.doc.length === 0) {
				throw new Error(`schema: flag ${fe.name}.${f.name} undocumented`);
			}
			seen |= f.bit;
		}
		for (const k of fe.kindBits ?? []) {
			if (!fe.flags.some((f) => f.name === k)) {
				throw new Error(`schema: kind bit ${k} not in the ${fe.name} registry`);
			}
		}
	}
	for (const fam of d.families) {
		const slots = new Set<number>();
		for (const f of fam.fields) {
			if (f.slot < 0 || f.slot >= d.stride) {
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

export function defineSchema(s: Schema): Schema {
	validateDomain(s.kernel);
	validateDomain(s.worldArena);
	const kernelFamilies = new Set(s.kernel.families.map((f) => f.name));
	for (const c of s.kernel.columns) {
		const slots = c.storage === 'recordBuffer' ? 1 : c.slotsPerRecord;
		if (slots < 1 || s.kernel.stride % slots !== 0 || ((s.kernel.stride / slots) & (s.kernel.stride / slots - 1)) !== 0) {
			throw new Error(`schema: column ${c.name} slots-per-record must divide the stride to a power of two`);
		}
		if (c.slots.length !== slots) {
			throw new Error(`schema: column ${c.name} declares ${c.slots.length} slot docs for ${slots} slots`);
		}
		for (const target of c.scrubOnFree) {
			if (!kernelFamilies.has(target)) {
				throw new Error(`schema: column ${c.name} scrubs unknown family ${target}`);
			}
		}
		if (c.doc.length === 0) {
			throw new Error(`schema: column ${c.name} undocumented`);
		}
	}
	for (const c of s.worldArena.columns) {
		if (c.doc.length === 0) {
			throw new Error(`schema: world column ${c.name} undocumented`);
		}
		if (c.storage === 'clockBuffer' && (c.grownWithShadow || c.keyedBy !== 'record')) {
			throw new Error(`schema: world column ${c.name}: clock buffers grow with the arena buffer and key by record`);
		}
	}
	if (!s.worldArena.columns.some((c) => c.grownWithShadow)) {
		throw new Error('schema: the world arena needs at least one grown-together column');
	}
	return s;
}

// ---- the schema ------------------------------------------------------------------

export const schema: Schema = defineSchema({
	layoutVersion: 2,
	kernel: {
		name: 'kernel',
		stride: 8,
		exportEnums: true,
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
		flagEnums: [
			{
				name: 'NodeFlag',
				doc: [
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
			},
		],
		shapeEnum: {
			name: 'ArenaShape',
			doc: [
				"Kernel arena shape: the strides, shifts, and offsets that address a",
				"record's fields and its side-column slots from its premultiplied id",
				'(see NodeField for the const-enum rationale).',
			],
			consts: [
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
		},
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
	},
	worldArena: {
		name: 'world arena',
		stride: 8,
		exportEnums: false,
		families: [
			{
				enumName: 'ArenaField',
				name: 'arenaShadow',
				doc: [
					'World-arena shadow-record fields (engine-owned layout — not the',
					"kernel's NodeField/LinkField, whose offsets 5-7 mean different things;",
					'stride 8; shadow and link records share the pool). Module-local on',
					'purpose: every hot arena walk is same-file, and the test-side checker',
					'reads the layout through arenaCheckerLayout() (data passing), never',
					'through exported enums. The shared field/bit names deliberately keep',
					"the kernel's numbering (the arena walks re-state the kernel's",
					'propagate/checkDirty family and read best side by side), but nothing',
					'couples the two layouts.',
				],
				fields: [
					{ name: 'FLAGS', slot: 0, kind: 'flags', doc: ['State machine + kind bits (see ArenaFlag).'] },
					{ name: 'DEPS', slot: 1, kind: 'ArenaLinkId', doc: ['First dependency link; doubles as the dead-shadow free-list next pointer.'] },
					{ name: 'DEPS_TAIL', slot: 2, kind: 'ArenaLinkId', doc: ['Last confirmed dependency link (the re-track cursor during a refold).'] },
					{ name: 'SUBS', slot: 3, kind: 'ArenaLinkId', doc: ['First STRONG subscriber link (the weak list lives in the weakSubs side column).'] },
					{ name: 'SUBS_TAIL', slot: 4, kind: 'ArenaLinkId', doc: ['Last strong subscriber link.'] },
					{ name: 'NODE', slot: 5, kind: 'ordinal', doc: ['The nodeIndex this record shadows (dense column key; identity is the kernel record id).'] },
					{ name: 'NODE_GEN', slot: 6, kind: 'u31', doc: ["Id-tenancy stamp: the node's kernel-record GEN observed at recording — dead-GEN shadows never serve."] },
					{ name: 'MARK', slot: 7, kind: 'u31', doc: ['Fanout read-clock dedup stamp (a marked cone nothing re-validated is not re-walked).'] },
				],
			},
			{
				enumName: 'ArenaLinkField',
				name: 'arenaLink',
				doc: [
					"World-arena link-record fields (link records share ArenaField's pool",
					'and stride; offsets overlay the shadow-record fields).',
				],
				fields: [
					{ name: 'VERSION', slot: 0, kind: 'u31', doc: ['Evaluation-cycle stamp: intra-refold duplicate-read dedup.'] },
					{ name: 'DEP', slot: 1, kind: 'ShadowId', doc: ['Producer shadow record id.'] },
					{ name: 'SUB', slot: 2, kind: 'ShadowId', doc: ['Consumer shadow record id.'] },
					{ name: 'PREV_SUB', slot: 3, kind: 'ArenaLinkId', doc: ["Previous link in the producer's mode-matching subscriber list."] },
					{ name: 'NEXT_SUB', slot: 4, kind: 'ArenaLinkId', doc: ["Next link in the producer's mode-matching subscriber list."] },
					{ name: 'PREV_DEP', slot: 5, kind: 'ArenaLinkId', doc: ["Previous link in the consumer's dependency list."] },
					{ name: 'NEXT_DEP', slot: 6, kind: 'ArenaLinkId', doc: ["Next link in the consumer's dependency list."] },
					{ name: 'MODE', slot: 7, kind: 'packed', doc: ['ArenaLinkMode bits (strong/weak — see the weak-link rules at the arena walks).'] },
					{
						name: 'FREE_NEXT', slot: 0, kind: 'ArenaLinkId', alias: true, doc: [
							'The free list threads through the VERSION field (FREE_NEXT aliases',
							"it), the same discipline as the kernel's LinkField.FREE_NEXT: a freed",
							'link must keep every field a walk still reads intact. arenaCheckDirty',
							'reads NEXT_DEP (and arenaShallowPropagate NEXT_SUB) off links a',
							'mid-walk purge freed, so those must keep naming former neighbors,',
							'never the free list. VERSION is genuinely dead on freed links: it is',
							'only written at link creation/reuse (arenaLink/arenaLinkInsert) and',
							'only read off live links (the subs-tail dedup probe); every',
							'allocation path rewrites it before any read. Pinned by',
							'tests/arena-freelist.spec.ts.',
						],
					},
				],
			},
		],
		flagEnums: [
			{
				name: 'ArenaLinkMode',
				doc: ['MODE field bits.'],
				flags: [
					{ name: 'WEAK', bit: 0b1, doc: ['1 = weak (untracked-read) link — never delivers; lives on the segregated weak subs list.'] },
				],
			},
			{
				name: 'ArenaFlag',
				doc: [
					'Shadow flag bits (engine-owned; the shared names keep the kernel',
					'NodeFlag numbering for side-by-side reading — see the ArenaField doc).',
				],
				flags: [
					{ name: 'MUTABLE', bit: 0b000000000000001, doc: ['Can produce new values (evaluated at least once for computeds).'] },
					{ name: 'RECURSED_CHECK', bit: 0b000000000000100, doc: ['Currently refolding (re-entrancy guard; a read under it is a dependency cycle).'] },
					{ name: 'RECURSED', bit: 0b000000000001000, doc: ['A re-entrant mark reached this shadow during its own refold.'] },
					{ name: 'DIRTY', bit: 0b000000000010000, doc: ['Definitely stale (listed on the arena dirty list — the DIRTY ⇒ listed contract).'] },
					{ name: 'PENDING', bit: 0b000000000100000, doc: ['Possibly stale — verify by pulling before refolding.'] },
					{ name: 'K_SIGNAL', bit: 0b000000010000000, doc: ['Kind: atom shadow.'] },
					{ name: 'K_COMPUTED', bit: 0b000000100000000, doc: ['Kind: computed shadow.'] },
					{
						name: 'HAS_BOX', bit: 0b000100000000000, doc: [
							'Value column holds an exceptional payload (thrown error, or sentinel).',
						],
					},
					{
						name: 'BOX_SUSPENDED', bit: 0b001000000000000, doc: [
							"Refines HAS_BOX: payload is the thenable's stable SuspendedRead.",
						],
					},
					{
						name: 'VALID', bit: 0b010000000000000, doc: [
							'The value column holds a folded value (cold shadow when unset).',
						],
					},
					{
						name: 'BOX_THROWN', bit: 0b100000000000000, doc: [
							'Refines HAS_BOX: the payload was thrown by the fn (render-path',
							'suspension or plain error) — serves rethrow the cached payload,',
							'boxedRead-style. Clear means a returned sentinel (background',
							'suspensions fold to the sentinel value), which serves as a value.',
							'Arena-local bit with no kernel NodeFlag counterpart (the kernel',
							'encodes the split differently).',
						],
					},
				],
			},
		],
		shapeEnum: {
			name: 'ArenaGeom',
			doc: [
				'World-arena geometry. Same-file const enum members (not module',
				'consts): the reads sit inside the hot arena walks and must inline as',
				'literals.',
			],
			consts: [
				{
					name: 'CLOCK_LIMIT', value: 0x7fff0000, doc: [
						'Int32 stamp ceiling: `readClock` and `cycle` are JS numbers, but',
						'their stamps store into Int32Array fields (ArenaField.MARK,',
						'ArenaLinkField.VERSION) which truncate past 2^31-1 — a wrapped store',
						'could collide with a live stamp and false-positive the dedup (a',
						'skipped propagation or a dropped link: the dangerous direction). The',
						'bump helpers (arenaBumpReadClock, arenaBumpCycle) renumber before any',
						'store can wrap: stamps reset to 0 (= stale), the clock restarts, and',
						'the next walk re-marks — at most one conservative re-walk per record',
						'per 2^31 events, amortized zero. (Margin under 2^31-1 is cosmetic',
						'headroom; bumps route through the helpers, so the clocks never reach',
						'the ceiling.)',
					],
				},
				{
					name: 'MAX_BUFFER_BYTES', value: 268435456, doc: [
						'2^28 — the growable-buffer reservation ceiling per arena (8M records',
						'at 32 bytes each). Arena growth never replaces the buffer: each',
						'arena ArrayBuffer is created resizable with this maxByteLength and',
						'grows in place, so buffer identity is stable for the life of the',
						'shell and every cached view stays valid across growth (the',
						'reservation is virtual address space; pages commit on use).',
					],
				},
			],
		},
		columns: [
			{
				name: 'nodeToShadow',
				keyedBy: 'nodeIndex',
				storage: 'growArray',
				emptyValue: '0',
				grownWithShadow: false,
				scrubOnEvict: false,
				doc: [
					'nodeIndex → shadow record id (0 = none; index 0 is burned). Grown',
					'densely by the shadow allocator and pre-sized at claim; unindexed by',
					'the purge (the evict scrub cannot cover it: it is keyed by nodeIndex,',
					'not by record).',
				],
			},
			{
				name: 'vals',
				keyedBy: 'record',
				storage: 'growArray',
				emptyValue: 'undefined',
				grownWithShadow: true,
				scrubOnEvict: true,
				doc: [
					"The folded value column (one slot per record): the fold's own output,",
					'bit for bit (dual bookkeeping requires arena value ≡ fold), or the',
					'boxed exceptional payload when HAS_BOX is set.',
				],
			},
			{
				name: 'suspIdx',
				keyedBy: 'record',
				storage: 'growArray',
				emptyValue: '0',
				grownWithShadow: true,
				scrubOnEvict: false,
				doc: [
					'Per-record suspended-list slot + 1 (0 = not suspended) — the field is',
					'the set bit and stores the dense index (swap-remove compaction).',
					'Evict scrubs it through arenaUnsuspend (list-coupled: the dense list',
					'entry must swap-remove with it), never directly.',
				],
			},
			{
				name: 'walk',
				keyedBy: 'record',
				storage: 'growArray',
				emptyValue: '0',
				grownWithShadow: true,
				scrubOnEvict: false,
				doc: [
					'Per-record walk-generation stamps (the routing walks: delivery reach,',
					'drain candidate collection, fixup closure) — termination + O(V+E)',
					'without allocation. Compared against the engine\'s global walk',
					'generation, so stale stamps are inert by generation monotonicity (no',
					'evict scrub needed); scrubbed at release like every column.',
				],
			},
			{
				name: 'weakSubs',
				keyedBy: 'record',
				storage: 'growArray',
				emptyValue: '0',
				grownWithShadow: true,
				scrubOnEvict: false,
				doc: [
					'The segregated weak subs list head (record ids; same link-record',
					'layout). Segregation is priced, not cosmetic: a combined-list walk',
					'measured 4.9× the write cost on a write-storm shape with hundreds of',
					'weak links per node — every write visited-and-skipped them all. The',
					'delivery walk traverses the strong list (ArenaField.SUBS) only and',
					'never sees a weak link; mark propagation and drain candidate',
					'collection walk both. Cleared per-shadow by the evict\'s unlink loop',
					'(list-coupled), wholesale at release.',
				],
			},
			{
				name: 'weakSubsTail',
				keyedBy: 'record',
				storage: 'growArray',
				emptyValue: '0',
				grownWithShadow: true,
				scrubOnEvict: false,
				doc: ['The segregated weak subs list tail (see weakSubs).'],
			},
			{
				name: 'clocks',
				keyedBy: 'record',
				storage: 'clockBuffer',
				emptyValue: '0',
				grownWithShadow: false,
				scrubOnEvict: true,
				doc: [
					'The per-world updated-at clock column, one float64 slot per record,',
					'in a growable buffer resized in step with the arena buffer. A shadow',
					"record's slot is the node's per-root committed clock: a process-",
					'monotone stamp (drawn from the engine\'s one clockSource) moved when',
					'the shadow\'s folded outcome changes in a COMMITTED arena — root A\'s',
					'clocks never move on root B\'s commits because each root owns its',
					'arena, and render arenas never bump (render-world values are',
					'pin-frozen; the WorldArena.bumpsClocks gate). A link record\'s slot is',
					'reserved for observer state (the last producer clock a subscription',
					'validated against). Zero means "never".',
				],
			},
		],
	},
});

// ---- generator: shared emit helpers ------------------------------------------------

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

function emitDomainEnums(out: string[], d: ArenaDomain, shapeExtras: string[]): void {
	const exp = d.exportEnums ? 'export ' : '';
	for (const fam of d.families) {
		out.push(...docBlock(fam.doc, 0));
		out.push(`${exp}const enum ${fam.enumName} {`);
		for (const f of fam.fields) {
			out.push(...docBlock(f.doc, 1));
			out.push(`\t${f.name} = ${f.slot},`);
		}
		out.push('}');
		out.push('');
	}
	for (const fe of d.flagEnums) {
		const width = Math.max(...fe.flags.map((f) => f.bit.toString(2).length));
		out.push(...docBlock(fe.doc, 0));
		out.push(`${exp}const enum ${fe.name} {`);
		for (const f of fe.flags) {
			out.push(...docBlock(f.doc, 1));
			out.push(`\t${f.name} = ${flagLiteral(f.bit, width)},`);
		}
		if (fe.kindBits !== undefined) {
			const kindMask = fe.flags.filter((f) => fe.kindBits!.includes(f.name)).reduce((m, f) => m | f.bit, 0);
			out.push(...docBlock([fe.kindMaskDoc ?? 'The kind bits together.'], 1));
			out.push(`\tKIND_MASK = ${fe.kindBits.join(' | ')}, // ${flagLiteral(kindMask, width)}`);
		}
		out.push('}');
		out.push('');
	}
	out.push(...docBlock(d.shapeEnum.doc, 0));
	out.push(`${exp}const enum ${d.shapeEnum.name} {`);
	out.push(...docBlock(['Int32 fields per record; ids are premultiplied by this (id = record ordinal × STRIDE).'], 1));
	out.push(`\tSTRIDE = ${d.stride},`);
	for (const line of shapeExtras) {
		out.push(line);
	}
	for (const k of d.shapeEnum.consts) {
		out.push(...docBlock(k.doc, 1));
		out.push(`\t${k.name} = ${k.value},`);
	}
	out.push('}');
	out.push('');
}

// ---- generator: the engine's layout region ---------------------------------------

export function generateLayoutBlock(s: Schema): string {
	const out: string[] = [];
	out.push(markerStart(s));

	// -- the kernel arena --
	const k = s.kernel;
	const kernelShifts: string[] = [];
	for (const c of k.columns) {
		const slots = c.storage === 'recordBuffer' ? 1 : c.slotsPerRecord;
		const shift = Math.round(Math.log2(k.stride / slots));
		kernelShifts.push(...docBlock([`id >> ${c.shiftConst}: premultiplied id → the record's base slot in the \`${c.name}\` column (${slots} slot${slots > 1 ? 's' : ''} per record).`], 1));
		kernelShifts.push(`\t${c.shiftConst} = ${shift},`);
	}
	emitDomainEnums(out, k, kernelShifts);

	// Kernel column scrub/reset functions: free/reset correctness is
	// generated, not hand-maintained.
	const bufferParams = k.columns.filter((c) => c.storage === 'recordBuffer').map((c) => `${c.name}: Float64Array`);
	for (const fam of k.families) {
		const participating = k.columns.filter((c) => c.scrubOnFree.includes(fam.name as 'node' | 'link'));
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
				out.push(`\tconst base: ValueIndex = id >> ${k.shapeEnum.name}.${c.shiftConst};`);
				c.slots.forEach((slot, i) => {
					const idx = i === 0 ? 'base' : `base + ${slot.offsetConst !== undefined ? `${k.shapeEnum.name}.${slot.offsetConst}` : String(i)}`;
					out.push(`\t${c.name}[${idx}] = ${c.emptyValue}; // ${slot.doc}`);
				});
			} else {
				out.push(`\t${c.name}[id >> ${k.shapeEnum.name}.${c.shiftConst}] = ${c.emptyValue}; // ${c.slots[0].doc}`);
			}
		}
		out.push('}');
		out.push('');
	}
	out.push(...docBlock([
		'Reset every kernel side column to its record-zero seed (generated from',
		'the column roster; the test reset\'s column half). Grow-arrays truncate;',
		'record buffers zero-fill in place (the arena keeps its capacity).',
	], 0));
	out.push(`function resetSideColumnsForTest(${bufferParams.join(', ')}): void {`);
	for (const c of k.columns) {
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
	out.push('');

	// -- the world arenas --
	const w = s.worldArena;
	const worldShifts: string[] = [];
	worldShifts.push(...docBlock(['record id >> ID_TO_COLUMN_SHIFT = the record\'s slot in every per-record side column (one slot per record).'], 1));
	worldShifts.push(`\tID_TO_COLUMN_SHIFT = ${Math.round(Math.log2(w.stride))},`);
	emitDomainEnums(out, w, worldShifts);

	// World-arena column functions (over the WorldArena instance): the
	// grown-together loop, the evict scrub, and the release reset.
	const grown = w.columns.filter((c) => c.grownWithShadow);
	out.push(...docBlock([
		'Grow the world arena\'s grown-together per-record columns to cover one',
		'column index (generated from the column roster — a new column cannot',
		'miss the growth loop). Called by the shadow allocator; the clock buffer',
		'grows with the arena buffer instead (arenaGrow).',
	], 0));
	out.push('function growWorldArenaColumns(a: WorldArena, columnIndex: number): void {');
	out.push(`\twhile (a.${grown[0].name}.length <= columnIndex) {`);
	for (const c of grown) {
		out.push(`\t\ta.${c.name}.push(${c.emptyValue});`);
	}
	out.push('\t}');
	out.push('}');
	out.push('');
	const evicted = w.columns.filter((c) => c.scrubOnEvict);
	out.push(...docBlock([
		'Scrub an evicted shadow record\'s per-record column slots (generated',
		'from the column roster): a re-keyed or purged record\'s next tenant must',
		'never observe the dead tenancy\'s value or clock stamp. List-coupled',
		'columns (suspIdx, the weak heads) clear through their list operations',
		'instead; walk stamps are inert by generation monotonicity.',
	], 0));
	out.push('function scrubWorldShadowColumnsOnEvict(a: WorldArena, sh: number): void {');
	out.push(`\tconst vi = sh >> ${w.shapeEnum.name}.ID_TO_COLUMN_SHIFT;`);
	for (const c of evicted) {
		out.push(`\ta.${c.name}[vi] = ${c.emptyValue};`);
	}
	out.push('}');
	out.push('');
	out.push(...docBlock([
		'Reset every world-arena side column at release (generated from the',
		'column roster; the release scrub\'s column half). Keeps each column\'s',
		'CAPACITY across pool tenancies (a priced cold-render saving: truncating',
		'to 0 forced re-pushing every element on every claim — ~2k pushes per',
		'cold render); fill() scrubs the same residue truncation would have',
		'dropped, so value refs release and stale ids read as "none" while the',
		'packed length persists. The clock buffer zero-fills its written prefix.',
	], 0));
	out.push('function resetWorldArenaColumnsOnRelease(a: WorldArena): void {');
	for (const c of w.columns) {
		if (c.storage === 'clockBuffer') {
			out.push(`\ta.${c.name}.fill(${c.emptyValue}, 0, a.next >> ${w.shapeEnum.name}.ID_TO_COLUMN_SHIFT);`);
		} else {
			out.push(`\ta.${c.name}.fill(${c.emptyValue});`);
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
	out.push('// hydrators, and the side-column rosters. Imports nothing from the engine;');
	out.push('// none of it ships on a hot path.');
	out.push('');
	out.push(`export const LAYOUT_VERSION = ${s.layoutVersion};`);
	out.push('');
	out.push('export type FieldInfo = {');
	out.push('\tname: string;');
	out.push('\tslot: number;');
	out.push('\tkind: string;');
	out.push('\tdoc: string;');
	out.push('};');
	out.push('');
	const domains = [s.kernel, s.worldArena];
	out.push('export const STRIDES: Record<string, number> = {');
	for (const d of domains) {
		for (const fam of d.families) {
			out.push(`\t${fam.name}: ${d.stride},`);
		}
	}
	out.push('};');
	out.push('');
	out.push('export const FIELDS_BY_RECORD: Record<string, readonly FieldInfo[]> = {');
	for (const d of domains) {
		for (const fam of d.families) {
			out.push(`\t${fam.name}: [`);
			for (const f of fam.fields) {
				out.push(
					`\t\t{ name: ${JSON.stringify(f.name)}, slot: ${f.slot}, kind: ${JSON.stringify(f.kind)}, doc: ${JSON.stringify(f.doc.join(' '))} },`,
				);
			}
			out.push('\t],');
		}
	}
	out.push('};');
	out.push('');
	out.push('export const FLAG_BITS: Record<string, Record<string, number>> = {');
	for (const d of domains) {
		for (const fe of d.flagEnums) {
			out.push(`\t${fe.name}: {`);
			for (const f of fe.flags) {
				out.push(`\t\t${f.name}: ${f.bit},`);
			}
			out.push('\t},');
		}
	}
	out.push('};');
	out.push('');
	out.push('export type ColumnInfo = {');
	out.push('\tname: string;');
	out.push('\tdomain: string;');
	out.push('\tstorage: string;');
	out.push('\tscrub: string;');
	out.push('};');
	out.push('');
	out.push('export const COLUMNS: readonly ColumnInfo[] = [');
	for (const c of s.kernel.columns) {
		out.push(`\t{ name: ${JSON.stringify(c.name)}, domain: 'kernel', storage: ${JSON.stringify(c.storage)}, scrub: ${JSON.stringify('free:' + c.scrubOnFree.join('+'))} },`);
	}
	for (const c of s.worldArena.columns) {
		out.push(`\t{ name: ${JSON.stringify(c.name)}, domain: 'worldArena', storage: ${JSON.stringify(c.storage)}, scrub: ${JSON.stringify(c.scrubOnEvict ? 'evict+release' : 'release')} },`);
	}
	out.push('];');
	out.push('');
	out.push('/** Decode a FLAGS word into the set flag names of one registry. */');
	out.push('export function decodeFlags(registry: string, flags: number): string[] {');
	out.push('\tconst out: string[] = [];');
	out.push('\tconst bits = FLAG_BITS[registry] ?? {};');
	out.push('\tfor (const [name, bit] of Object.entries(bits)) {');
	out.push('\t\tif ((flags & bit) !== 0) {');
	out.push('\t\t\tout.push(name);');
	out.push('\t\t}');
	out.push('\t}');
	out.push('\treturn out;');
	out.push('}');
	out.push('');
	const flagRegistryFor: Record<string, string> = {
		node: 'NodeFlag',
		arenaShadow: 'ArenaFlag',
	};
	for (const d of domains) {
		for (const fam of d.families) {
			const fname = `hydrate${fam.name[0].toUpperCase()}${fam.name.slice(1)}`;
			out.push(`/** Decode one ${fam.name} record into a plain object. */`);
			out.push(`export function ${fname}(memory: Int32Array, id: number): Record<string, unknown> {`);
			out.push('\tconst out: Record<string, unknown> = { id };');
			out.push(`\tfor (const f of FIELDS_BY_RECORD.${fam.name}) {`);
			out.push('\t\tout[f.name] = memory[id + f.slot];');
			out.push('\t}');
			if (fam.fields.some((f) => f.kind === 'flags')) {
				out.push(`\tout.flagNames = decodeFlags(${JSON.stringify(flagRegistryFor[fam.name] ?? '')}, memory[id + 0]);`);
			}
			out.push('\treturn out;');
			out.push('}');
			out.push('');
		}
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
