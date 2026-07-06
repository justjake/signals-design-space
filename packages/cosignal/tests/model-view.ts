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
 * (creation, direct-mode writes, quiesce). The shadow fold reimplements the
 * model's Receipt-shaped fold over that full history, replaying the oracle's
 * exported `visible` rule (imported — the one Receipt-shaped statement of
 * receipt visibility, not a copy); the engine keeps only the packed forms
 * (`visibleAt`, `foldAtom`).
 */
import { visible } from '../../cosignal-oracle/src/model.js';
import type {
	AnyNode as ENode,
	AtomNode,
	CosignalBridge,
	Op,
	Pass,
	Receipt,
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

	/** Direct-mode writes and the quiescence episode reset set origin to base. */
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

function unwrap(n: unknown): ENode {
	const e = (n as { __engine?: ENode }).__engine;
	return e !== undefined ? e : (n as ENode);
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
	return {
		get nodes(): Map<number, ViewNode> {
			const out = new Map<number, ViewNode>();
			for (const [id, n] of engine.nodes) out.set(id, viewNode(n));
			return out;
		},
		get passes() {
			return engine.passes;
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
		evaluate: (n: unknown, w: World) => engine.evaluate(unwrap(n), w),
		foldAtom: (n: unknown, w: World) => engine.foldAtom(unwrap(n) as AtomNode, w),
		newestValue: (n: unknown) => engine.newestValue(unwrap(n)),
		committedValue: (n: unknown, root: string) => engine.committedValue(unwrap(n), root),
		passValue: (n: unknown, p: Pass) => engine.passValue(unwrap(n), p),
		/** The retention invariant's full-history fold: origin + archive + tape. */
		shadowFoldAtom(n: unknown, world: World): Value {
			const atom = unwrap(n) as AtomNode;
			let value = mirror.originOf(atom);
			for (const e of [...mirror.archiveOf(atom), ...atom.tp.materialize()]) {
				if (!visible(engine, e, world)) continue;
				const next = applyOp(atom, e.op, value);
				if (!atom.equals(next, value)) value = next;
			}
			return value;
		},
	};
}
