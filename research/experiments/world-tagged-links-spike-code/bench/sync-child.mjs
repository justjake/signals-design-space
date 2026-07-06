// Bench (b): sync-path neutrality. Public-API sync shapes; WORLDS live-but-idle
// speculative worlds (proto only) price the write-fanout branch + shadow-subs walk.
import { row, repsNs, env, envInt } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench/util.mjs';

const IMPL = env('IMPL', 'head'); // head | proto | head-bridge (shipped write path, one live batch)
const SRC = IMPL === 'proto'
	? '/Users/jitl/src/alien-signals-opt/milomg-reactivity-benchmark/.claude/worktrees/agent-a9d009b875849ef38/spike/cosignal/src/index.ts'
	: '/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts';
const lib = await import(SRC);
const { Atom, Computed, effect } = lib;

const SHAPE = env('SHAPE', 'chain');
const WORLDS = envInt('WORLDS', 0);
const ITERS = envInt('ITERS', SHAPE === 'read' ? 2_000_000 : 300_000);

let top; // the shape's tip computed
let sink = 0;
const s = new Atom(0);

if (SHAPE === 'chain') {
	let prev = new Computed(() => s.state + 1);
	for (let i = 1; i < 16; i++) {
		const p = prev;
		prev = new Computed(() => p.state + 1);
	}
	top = prev;
	effect(() => { sink += top.state; });
} else if (SHAPE === 'fan') {
	const cs = [];
	for (let i = 0; i < 64; i++) cs.push(new Computed(() => s.state + i));
	top = new Computed(() => {
		let acc = 0;
		for (let i = 0; i < 64; i++) acc += cs[i].state;
		return acc;
	});
	effect(() => { sink += top.state; });
} else if (SHAPE === 'read') {
	top = new Computed(() => s.state * 2);
	effect(() => { sink += top.state; }); // keep it watched (clean-read fast path)
} else {
	throw new Error(`unknown SHAPE ${SHAPE}`);
}

if (WORLDS > 0) {
	if (IMPL !== 'proto') throw new Error('WORLDS>0 requires IMPL=proto');
	for (let i = 0; i < WORLDS; i++) {
		const w = lib.__worldBegin();
		lib.__worldRead(w, top); // build the world's shadow graph (links live, idle)
	}
}

if (IMPL === 'head-bridge') {
	// The SHIPPED concurrent write path: bridge registered, the written atom
	// adopted, one live (pending) batch — every public write records a receipt
	// and runs the K0∪K1 delivery walk. This is the machinery per-world
	// precise fanout would replace.
	const b = new lib.CosignalBridge();
	b.registerBridge();
	const sNode = b.adoptAtom('s', s);
	const t = b.openBatch(); // held open: a pending transition exists
	b.write(t.id, sNode, { kind: 'set', value: -1 });
}

const op = SHAPE === 'read'
	? () => { for (let i = 0; i < ITERS; i++) sink += top.state; }
	: () => { for (let i = 0; i < ITERS; i++) s.set(i); };

const ns = repsNs(op, { warmup: 3, reps: 7 });
for (const total of ns) {
	row({ metric: `${SHAPE}/w${WORLDS}/${IMPL}`, value: total / ITERS, unit: 'ns/op' });
}
row({ metric: `checksum/${SHAPE}/${IMPL}`, note: String(sink) });
