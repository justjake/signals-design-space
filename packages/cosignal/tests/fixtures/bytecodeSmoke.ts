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

// ---- concurrent engine: aLink, aCheckDirty, shadowFor, aNoteAtom, foldAtom.
// A bridge with the S-A divergence check armed: every op epilogue serves
// every arena shadow through the arena's own walks (aServe → aCheckDirty).
const bridge = __newBridgeForTest();
bridge.registerBridge();
bridge.__setArenaCheck(true);
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
	bridge.retire(t.id, true);
}
const t2 = bridge.openBatch();
bridge.write(t2.id, at2 as never, { kind: 'set', value: 100 });
bridge.retire(t2.id, true);

function commitWrite(node: AnyNode, value: unknown): void {
	const t = bridge.openBatch();
	bridge.write(t.id, node as never, { kind: 'set', value });
	bridge.retire(t.id, true);
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
