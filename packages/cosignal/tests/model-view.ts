/**
 * The referee's MODEL VIEW of the engine: a test-side adapter that presents a
 * `CosignalBridge` in the reference model's shape, so the oracle's
 * `checkInvariants` / `snapshotModel` run against the engine without the
 * production class carrying mirror members. Everything the checkers read is
 * materialized on demand from load-bearing packed state (`log`,
 * `rootToOpenRender`-backed maps, slot/batch/root registries) plus the one
 * thing packed state cannot answer — the FULL history behind compaction —
 * which a driver-side mirror retains: per-atom archives fed by the engine's
 * `onCompact` hook and per-atom origins maintained at the ops that move them
 * (creation, adoption, quiesce). The shadow fold reimplements the
 * model's WriteLogEntry-shaped fold over that full history, replaying the oracle's
 * exported `visible` rule (imported — the one WriteLogEntry-shaped statement of
 * log-entry visibility, not a copy); the engine keeps only the packed forms
 * (`visibleAt`, `foldAtom`).
 *
 * Slot sets: the engine's ONLY slot-set representation is the 31-bit integer
 * word (`RenderPass.maskBits`/`includedBits`, `RootState.committedBits`,
 * `WatcherSnapshot`, mountFix worlds); the model's shapes are Set-valued.
 * This view is where the two meet, so it derives the Sets — render-pass wrappers
 * with `maskSlots`, and the `VisibilityHost` the imported rule reads.
 */
import { visible, type VisibilityHost, type World as ModelWorld } from '../../cosignal-oracle/src/model.js';
import type {
	AnyNode as ENode,
	AtomNode,
	CosignalBridge,
	RenderPass,
	RenderPassId,
	WriteLogEntry,
	RootId,
	Seq,
	BatchSlot,
	BatchSlotSet,
	Value,
	World,
} from '../src/concurrent.js';

/** The full-history mirror a twin driver owns and feeds. */
export class RefereeMirror {
	private origins = new Map<AtomNode, Value>();
	private archives = new Map<AtomNode, WriteLogEntry[]>();

	/** Install the compaction feed on a bridge (call once, at driver setup). */
	attach(engine: CosignalBridge): void {
		engine.onCompact = (atom, entry) => this.archiveOf(atom).push(entry);
	}

	/** Record an atom's origin (at creation; refreshed by originsFromBase). */
	setOrigin(atom: AtomNode, value: Value): void {
		this.origins.set(atom, value);
	}

	/** The quiescence episode reset sets origin to base (the model's episode reset twin). */
	originsFromBase(engine: CosignalBridge): void {
		for (const n of engine.idToNode.values()) {
			if (n.kind === 'atom') this.origins.set(n, n.base);
		}
	}

	/** Quiescence: archives belong to the dead episode (as in the model's episode reset). */
	clearArchives(): void {
		this.archives.clear();
	}

	originOf(atom: AtomNode): Value {
		return this.origins.get(atom);
	}

	archiveOf(atom: AtomNode): WriteLogEntry[] {
		let a = this.archives.get(atom);
		if (a === undefined) {
			a = [];
			this.archives.set(atom, a);
		}
		return a;
	}
}

/** A view node: the model-shaped face of one engine atom. */
type ViewAtom = {
	kind: 'atom';
	name: string;
	readonly log: WriteLogEntry[];
	readonly baseSeq: number;
	readonly archive: WriteLogEntry[];
	readonly origin: Value;
	__engine: AtomNode;
};
type ViewNode = ViewAtom | { kind: 'computed'; name: string; __engine: ENode };

/** A view render pass: the model-shaped face of one engine render pass — the Set-valued
 * `maskSlots` the oracle's tenancy check reads, derived from the bit form. */
type ViewRenderPass = {
	id: RenderPassId;
	root: RootId;
	pin: Seq;
	state: RenderPass['state'];
	maskBatches: RenderPass['maskBatches'];
	maskSlots: Set<BatchSlot>;
	__engine: RenderPass;
};

/** View face → the engine record behind it (pass-through when already bare). */
function unwrap<T>(n: unknown): T {
	const e = (n as { __engine?: T }).__engine;
	return e !== undefined ? e : (n as T);
}

/** Slot-set bits → the model's Set form (bit i = slot i). */
function slotsOf(bits: BatchSlotSet): Set<BatchSlot> {
	const out = new Set<BatchSlot>();
	for (let s = 0; bits !== 0; s++, bits >>>= 1) {
		if ((bits & 1) === 1) out.add(s);
	}
	return out;
}

/** Worlds built by the oracle's checkers carry VIEW render passes; the engine folds
 * over its own render records. */
function engineWorld(w: World): World {
	return w.kind === 'render' ? { kind: 'render', render: unwrap<RenderPass>(w.render) } : w;
}

/** Pure op application for the shadow fold (test-side: the corpus's updaters/
 * reducers are pure by the fold-purity contract the engine enforces; the
 * object-shaped op is the materialized WriteLogEntry surface — engine truth is the
 * packed scalar pair). */
function applyOp(atom: AtomNode, op: WriteLogEntry['op'], prev: Value): Value {
	switch (op.kind) {
		case 'set':
			return op.value;
		case 'update':
			return op.fn(prev);
	}
}

/**
 * The model-shaped view. Cast it to the oracle's `CosignalModel` for
 * `checkInvariants(view as unknown as CosignalModel)` / `snapshotModel(...)`
 * — it presents exactly the members those checkers read at runtime.
 */
export function modelView(engine: CosignalBridge, mirror: RefereeMirror): Record<string, unknown> {
	const viewNode = (n: ENode): ViewNode => {
		if (n.kind !== 'atom') return { kind: 'computed', name: n.name, __engine: n };
		return {
			kind: 'atom',
			name: n.name,
			get log(): WriteLogEntry[] {
				return n.log.materialize();
			},
			get baseSeq(): number {
				return n.baseSeq;
			},
			get archive(): WriteLogEntry[] {
				return mirror.archiveOf(n);
			},
			get origin(): Value {
				return mirror.originOf(n);
			},
			__engine: n,
		};
	};
	const viewRenderPass = (p: RenderPass): ViewRenderPass => ({
		id: p.id, root: p.root, pin: p.pin, state: p.state,
		maskBatches: p.maskBatches, maskSlots: slotsOf(p.maskBits),
		__engine: p,
	});
	/** The imported visibility rule's host, answered from the engine's bit
	 * masks (the two set-valued lookups the render/committed clauses read). */
	const host: VisibilityHost = {
		includedSet: (render) => slotsOf(unwrap<RenderPass>(render).includedBits),
		committedSlotsNow: (root) => slotsOf(engine.root(root).committedBits),
	};
	return {
		get idToNode(): Map<number, ViewNode> {
			const out = new Map<number, ViewNode>();
			for (const [id, n] of engine.idToNode) out.set(id, viewNode(n));
			return out;
		},
		get idToRenderPass(): Map<RenderPassId, ViewRenderPass> {
			const out = new Map<RenderPassId, ViewRenderPass>();
			for (const [id, p] of engine.idToRenderPass) out.set(id, viewRenderPass(p));
			return out;
		},
		get roots() {
			return engine.roots;
		},
		get slots() {
			return engine.slots;
		},
		get idToBatch() {
			return engine.idToBatch;
		},
		get seq() {
			return engine.seq;
		},
		quiescent: () => engine.quiescent(),
		evaluate: (n: unknown, w: World) => engine.evaluate(unwrap<ENode>(n), engineWorld(w)),
		foldAtom: (n: unknown, w: World) => engine.foldAtom(unwrap<ENode>(n) as AtomNode, engineWorld(w)),
		newestValue: (n: unknown) => engine.newestValue(unwrap<ENode>(n)),
		committedValue: (n: unknown, root: string) => engine.committedValue(unwrap<ENode>(n), root),
		renderValue: (n: unknown, p: unknown) => engine.renderValue(unwrap<ENode>(n), unwrap<RenderPass>(p)),
		/** The retention invariant's full-history fold: origin + archive + write log. */
		shadowFoldAtom(n: unknown, world: World): Value {
			const atom = unwrap<ENode>(n) as AtomNode;
			// The rule is WriteLogEntry/Set-shaped; worlds arrive bit-shaped (mountFix)
			// or carrying view render passes (whose host lookups unwrap) — translate here.
			const w: ModelWorld =
				world.kind === 'mountFix'
					? { kind: 'mountFix', maskSlots: slotsOf(world.maskBits), pin: world.pin, root: world.root }
					: (world as unknown as ModelWorld);
			let value = mirror.originOf(atom);
			for (const e of [...mirror.archiveOf(atom), ...atom.log.materialize()]) {
				if (!visible(host, e, w)) continue;
				const next = applyOp(atom, e.op, value);
				if (!atom.equals(next, value)) value = next;
			}
			return value;
		},
	};
}
