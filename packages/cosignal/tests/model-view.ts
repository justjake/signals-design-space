/**
 * The referee's MODEL VIEW of the engine: a test-side adapter that presents a
 * `CosignalBridge` in the reference model's shape, so the oracle's
 * `checkInvariants` / `snapshotModel` run against the engine without the
 * production class carrying mirror members. Everything the checkers read is
 * materialized on demand from load-bearing packed state (`tp`,
 * `openPassByRoot`-backed maps, slot/token/root registries) plus the one
 * thing packed state cannot answer — the FULL history behind compaction —
 * which a driver-side mirror retains: per-atom archives fed by the engine's
 * `onCompact` hook and per-atom origins maintained at the ops that move them
 * (creation, adoption, quiesce). The shadow fold reimplements the
 * model's Receipt-shaped fold over that full history, replaying the oracle's
 * exported `visible` rule (imported — the one Receipt-shaped statement of
 * receipt visibility, not a copy); the engine keeps only the packed forms
 * (`visibleAt`, `foldAtom`).
 *
 * Slot sets: the engine's ONLY slot-set representation is the 31-bit integer
 * word (`Pass.maskBits`/`includedBits`, `RootState.committedBits`,
 * `WatcherSnapshot`, mountFix worlds); the model's shapes are Set-valued.
 * This view is where the two meet, so it derives the Sets — pass wrappers
 * with `maskSlots`, and the `VisibilityHost` the imported rule reads.
 */
import { visible, type VisibilityHost, type World as ModelWorld } from '../../cosignal-oracle/src/model.js';
import type {
	AnyNode as ENode,
	AtomNode,
	CosignalBridge,
	Op,
	Pass,
	PassId,
	Receipt,
	RootId,
	Seq,
	SlotId,
	SlotSet,
	Value,
	World,
} from '../src/concurrent.js';

/** The full-history mirror a twin driver owns and feeds. */
export class RefereeMirror {
	private origins = new Map<AtomNode, Value>();
	private archives = new Map<AtomNode, Receipt[]>();

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
		for (const n of engine.nodes.values()) {
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

	archiveOf(atom: AtomNode): Receipt[] {
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
	readonly tape: Receipt[];
	readonly baseSeq: number;
	readonly archive: Receipt[];
	readonly origin: Value;
	__engine: AtomNode;
};
type ViewNode = ViewAtom | { kind: 'computed'; name: string; __engine: ENode };

/** A view pass: the model-shaped face of one engine pass — the Set-valued
 * `maskSlots` the oracle's tenancy check reads, derived from the bit form. */
type ViewPass = {
	id: PassId;
	root: RootId;
	pin: Seq;
	state: Pass['state'];
	maskTokens: Pass['maskTokens'];
	maskSlots: Set<SlotId>;
	__engine: Pass;
};

/** View face → the engine record behind it (pass-through when already bare). */
function unwrap<T>(n: unknown): T {
	const e = (n as { __engine?: T }).__engine;
	return e !== undefined ? e : (n as T);
}

/** Slot-set bits → the model's Set form (bit i = slot i). */
function slotsOf(bits: SlotSet): Set<SlotId> {
	const out = new Set<SlotId>();
	for (let s = 0; bits !== 0; s++, bits >>>= 1) {
		if ((bits & 1) === 1) out.add(s);
	}
	return out;
}

/** Worlds built by the oracle's checkers carry VIEW passes; the engine folds
 * over its own pass records. */
function engineWorld(w: World): World {
	return w.kind === 'pass' ? { kind: 'pass', pass: unwrap<Pass>(w.pass) } : w;
}

/** Pure op application for the shadow fold (test-side: the corpus's updaters/
 * reducers are pure by the fold-purity contract the engine enforces). */
function applyOp(atom: AtomNode, op: Op, prev: Value): Value {
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
			get tape(): Receipt[] {
				return n.tp.materialize();
			},
			get baseSeq(): number {
				return n.baseSeq;
			},
			get archive(): Receipt[] {
				return mirror.archiveOf(n);
			},
			get origin(): Value {
				return mirror.originOf(n);
			},
			__engine: n,
		};
	};
	const viewPass = (p: Pass): ViewPass => ({
		id: p.id, root: p.root, pin: p.pin, state: p.state,
		maskTokens: p.maskTokens, maskSlots: slotsOf(p.maskBits),
		__engine: p,
	});
	/** The imported visibility rule's host, answered from the engine's bit
	 * masks (the two set-valued lookups the pass/committed clauses read). */
	const host: VisibilityHost = {
		includedSet: (pass) => slotsOf(unwrap<Pass>(pass).includedBits),
		committedSlotsNow: (root) => slotsOf(engine.root(root).committedBits),
	};
	return {
		get nodes(): Map<number, ViewNode> {
			const out = new Map<number, ViewNode>();
			for (const [id, n] of engine.nodes) out.set(id, viewNode(n));
			return out;
		},
		get passes(): Map<PassId, ViewPass> {
			const out = new Map<PassId, ViewPass>();
			for (const [id, p] of engine.passes) out.set(id, viewPass(p));
			return out;
		},
		get roots() {
			return engine.roots;
		},
		get slots() {
			return engine.slots;
		},
		get tokens() {
			return engine.tokens;
		},
		get seq() {
			return engine.seq;
		},
		quiescent: () => engine.quiescent(),
		evaluate: (n: unknown, w: World) => engine.evaluate(unwrap<ENode>(n), engineWorld(w)),
		foldAtom: (n: unknown, w: World) => engine.foldAtom(unwrap<ENode>(n) as AtomNode, engineWorld(w)),
		newestValue: (n: unknown) => engine.newestValue(unwrap<ENode>(n)),
		committedValue: (n: unknown, root: string) => engine.committedValue(unwrap<ENode>(n), root),
		passValue: (n: unknown, p: unknown) => engine.passValue(unwrap<ENode>(n), unwrap<Pass>(p)),
		/** The retention invariant's full-history fold: origin + archive + tape. */
		shadowFoldAtom(n: unknown, world: World): Value {
			const atom = unwrap<ENode>(n) as AtomNode;
			// The rule is Receipt/Set-shaped; worlds arrive bit-shaped (mountFix)
			// or carrying view passes (whose host lookups unwrap) — translate here.
			const w: ModelWorld =
				world.kind === 'mountFix'
					? { kind: 'mountFix', maskSlots: slotsOf(world.maskBits), pin: world.pin, root: world.root, excludeLiveTokens: world.excludeLiveTokens }
					: (world as unknown as ModelWorld);
			let value = mirror.originOf(atom);
			for (const e of [...mirror.archiveOf(atom), ...atom.tp.materialize()]) {
				if (!visible(host, e, w)) continue;
				const next = applyOp(atom, e.op, value);
				if (!atom.equals(next, value)) value = next;
			}
			return value;
		},
	};
}
