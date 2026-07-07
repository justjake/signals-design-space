/**
 * Exercises every budgeted hot path so V8 generates bytecode for each
 * function (lazy compilation: uninvoked functions never get bytecode).
 * Used by tests/bytecode.spec.ts: esbuild-bundled (const enums inline to
 * literals — the shipped-consumer codegen), then run under
 * `node --print-bytecode --print-bytecode-filter=*`.
 *
 * The marker line separates library bytecode from node-bootstrap internals:
 * the spec parses only output after it. Functions compile at first CALL, so
 * everything exercised below dumps after the marker.
 */
import {
	__newBridgeForTest,
	Atom,
	batch,
	Computed,
	effect,
	effectScope,
	untracked,
	type AnyNode,
} from '../../src/index';
import { armArenaCheck } from '../arena-checker';

process.stdout.write('@@SMOKE-START\n');

// ---- kernel: link/linkInsert (insert + re-track), computedRead, updateComputed
const a = new Atom(1);
const b = new Atom(2);
const toggle = new Atom(false);
const c1 = new Computed(() => a.state + 1);
// dynamic deps: unlink + purgeDeps on re-track
const c2 = new Computed(() => c1.state + (toggle.state ? a.state : b.state));
// multi-sub: shallowPropagate
const c3 = new Computed(() => c1.state + c2.state);
const d1 = effect(() => {
	c3.state;
});
const d2 = effect(() => {
	c2.state;
});

// Inner write inside an effect: propagate's recurse arms + isValidLink.
const r = new Atom(0);
effect(() => {
	const v = r.state;
	if (v > 0 && v < 3) {
		r.set(v + 1);
	}
});
r.set(1);

// Parent effect re-runs with a child effect: run()'s unlinkChildEffects arm.
const p = new Atom(0);
effect(() => {
	p.state;
	effect(() => {
		b.state;
	});
});
p.set(1);

// write/flush/propagate/checkDirty/notify/run/updateSignal churn.
for (let i = 0; i < 200; i++) {
	a.set(i);
	toggle.set(i % 2 === 0);
	b.set(i * 2);
}
batch(() => {
	a.set(999);
	b.set(998);
});
untracked(() => a.state);
const scope = effectScope(() => {
	effect(() => {
		c1.state;
	});
});
scope();
d1();
d2();
// computedReadSlow: a never-evaluated computed's first read + a dirty read.
const cold = new Computed(() => a.state * 2);
cold.state;
a.set(1234);
cold.state;

// B2 checkDirty fast paths as real dataflow: a 5-deep single-dep/single-sub
// chain (stackless chainCheck descend + climb) and a 2-level cone (the
// wrapper's two-level descend-then-unwind path).
const base = new Atom(0);
let chainNode = new Computed(() => base.state + 1);
for (let d = 1; d < 5; d++) {
	const prev = chainNode;
	chainNode = new Computed(() => prev.state + 1);
}
const chainTop = chainNode;
let chainSink = 0;
effect(() => {
	chainSink += chainTop.state;
});
const two1 = new Computed(() => base.state * 3);
const two2 = new Computed(() => two1.state + 1);
effect(() => {
	chainSink += two2.state;
});
base.set(1);
base.set(2);

// ---- concurrent engine: aLink, aCheckDirty, shadowFor, aNoteAtom, foldAtom.
// A bridge with the S-A divergence check armed: every op epilogue serves
// every arena shadow through the arena's own walks (aServe → aCheckDirty).
const bridge = __newBridgeForTest();
bridge.registerBridge();
armArenaCheck(bridge);
const at = bridge.atom('at', 1);
const at2 = bridge.atom('at2', 2);
const cc = bridge.computed('cc', (read) => (read(at) as number) + (read(at2) as number));
const cc2 = bridge.computed('cc2', (read, untrackedRead) => (read(cc) as number) + (untrackedRead(at) as number));
const pass = bridge.passStart('R', []);
bridge.mountWatcher(pass.id, cc2 as AnyNode, 'W');
bridge.passEnd(pass.id, 'commit');
for (let i = 0; i < 50; i++) {
	const t = bridge.openBatch();
	// update-op receipts make committed folds run the updater: foldAtom.
	bridge.write(t.id, at as never, { kind: 'update', fn: (prev) => (prev as number) + 1 });
	bridge.retire(t.id);
}
const t2 = bridge.openBatch();
bridge.write(t2.id, at2 as never, { kind: 'set', value: 100 });
bridge.retire(t2.id);

function commitWrite(node: AnyNode, value: unknown): void {
	const t = bridge.openBatch();
	bridge.write(t.id, node as never, { kind: 'set', value });
	bridge.retire(t.id);
}

// Dead-watcher constant cone: marks survive the drain (no live watcher to
// re-evaluate), so the armed epilogue's serves run aUpdateShadow (the dirty
// atom), aUpdateComputed (the promoted computed, folding UNCHANGED), and
// aCheckDirty (the pending-only grandchild's walk).
const atG = bridge.atom('atG', 0);
const cGate = bridge.computed('cGate', (read) => {
	read(atG);
	return 7;
});
const top2 = bridge.computed('top2', (read) => read(cGate));
const p2 = bridge.passStart('R2', []);
const w2 = bridge.mountWatcher(p2.id, top2 as AnyNode, 'W2');
bridge.passEnd(p2.id, 'commit');
w2.live = false;
commitWrite(atG as AnyNode, 1);
commitWrite(atG as AnyNode, 2);

// B2 aCheckDirtyLoop walk shapes. The cone's TOP gets the lowest node id
// (created first; its fn closes over later-declared handles, resolved at
// the first render), so the armed epilogue's node-id-order serve hits the
// top FIRST and must WALK to resolve its Pending. Both computeds fold
// CONSTANTS: a committed-arena atom shadow stays cold-invalid until its own
// first direct serve, and a cold base is invisible to the walk's dirt arms
// — a pre-existing S-A hole (probed on the B2 base commit) that
// stale-serves value-carrying top-first cones; constants keep every serve
// in agreement regardless of walk depth.
const topK = bridge.computed('topK', (read) => {
	read(cK);
	return 11;
});
const cK = bridge.computed('cK', (read) => {
	read(atK);
	return 7;
});
const atK = bridge.atom('atK', 0);
const p5 = bridge.passStart('R5', []);
const w5 = bridge.mountWatcher(p5.id, topK as AnyNode, 'W5');
bridge.passEnd(p5.id, 'commit');
w5.live = false;
commitWrite(atK as AnyNode, 1);
commitWrite(atK as AnyNode, 2);
// aCheckDirtyLoop's update arms (aUpdateAndShallow, descend + unwind): at
// S-A no PUBLIC flow reaches them — arena-authoritative serves happen only
// inside the armed epilogue, whose aValidate/memo-evaluate pass consumes
// every mark before the node-id-order serves walk (probed with prototype
// counters on the B2 base commit). The arms are the walk's safety net and
// the S-B/S-C serving path, so exercise them directly: fan a mark into the
// committed arena (valid shadows), then serve the top — the walk itself
// refolds the dirty base (descend arm; committed fold, value unchanged)
// and sees the unchanged constant above it (unwind arm), leaving flags
// clean and every value as it was.
const B = bridge as unknown as {
	eachArena(cb: (a: unknown) => void): void;
	fanAtomsToArena(a: unknown, atoms: unknown[], fromSettlement: boolean): void;
	aServe(a: unknown, node: AnyNode): unknown;
};
B.eachArena((a) => {
	if ((a as { root: string; kind: string }).root !== 'R5' || (a as { kind: string }).kind !== 'committed') return;
	B.fanAtomsToArena(a, [atK], false);
	B.aServe(a, topK as AnyNode);
});

// In-arena dynamic dep drop + re-link: aUnlink, aFreeLink, then aAllocLink
// popping the freed records back into live chains.
const gateB = bridge.atom('gateB', 0);
const extra = bridge.atom('extra', 5);
const cDyn = bridge.computed('cDyn', (read) => ((read(gateB) as number) === 0 ? read(extra) : 0));
const p3 = bridge.passStart('R3', []);
bridge.mountWatcher(p3.id, cDyn as AnyNode, 'W3');
bridge.passEnd(p3.id, 'commit');
commitWrite(gateB as AnyNode, 1);
commitWrite(gateB as AnyNode, 0);
commitWrite(extra as AnyNode, 6);

process.stdout.write(`@@SMOKE-OK ${c3.state} ${String(bridge.committedValue(cc2 as AnyNode, 'R'))} ${String(bridge.committedValue(cDyn as AnyNode, 'R3'))}\n`);
