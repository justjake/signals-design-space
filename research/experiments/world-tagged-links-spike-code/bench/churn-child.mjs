// Bench (c): discard-heavy churn (typeahead). Per "keystroke": open a
// speculative view with a divergent write (dep-flipping flag), evaluate N
// computeds with D deps under it, discard, repeat.
//   proto:  __worldBegin + __worldSet + __worldRead×N + __worldDiscard(MODE)
//   head:   openBatch + write + passStart + evaluate(pass)×N + passEnd(discard)
//           + retire of the superseded batch (the shipped memo-plane path).
import { row, repsNs, env, envInt } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench/util.mjs';

const IMPL = env('IMPL', 'head'); // head | proto
const MODE = env('MODE', 'bulk'); // proto discard mode: bulk | surgical
const PASSES = envInt('PASSES', 3000);
const N = envInt('N', 20); // computeds per pass
const D = envInt('D', 4); // atom deps per computed
const A = envInt('A', 16); // atom pool

const SPIKE_SRC = '/Users/jitl/src/alien-signals-opt/milomg-reactivity-benchmark/.claude/worktrees/agent-a9d009b875849ef38/spike/cosignal/src/index.ts';
const HEAD_SRC = '/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts';

let run;
let checksum = 0;

if (IMPL === 'proto') {
	const lib = await import(SPIKE_SRC);
	const { Atom, Computed } = lib;
	const flag = new Atom(0);
	const atoms = [];
	for (let i = 0; i < A; i++) atoms.push(new Atom(i));
	const comps = [];
	for (let i = 0; i < N; i++) {
		comps.push(new Computed(() => {
			// dep-flipping: branch on the flag, then D pool reads
			let acc = flag.state === 0 ? atoms[i % A].state : atoms[(i + 1) % A].state;
			for (let j = 1; j < D; j++) acc += atoms[(i * 7 + j) % A].state;
			return acc;
		}));
	}
	run = () => {
		for (let p = 0; p < PASSES; p++) {
			const w = lib.__worldBegin();
			lib.__worldSet(w, flag, p & 1);
			lib.__worldSet(w, atoms[p % A], p);
			for (let i = 0; i < N; i++) checksum += lib.__worldRead(w, comps[i]);
			lib.__worldDiscard(w, MODE);
		}
	};
} else {
	const lib = await import(HEAD_SRC);
	const b = new lib.CosignalBridge(); // production defaults: no event retention
	b.registerBridge(); // logged mode (one bridge per bench process)
	const flag = b.atom('flag', 0);
	const atoms = [];
	for (let i = 0; i < A; i++) atoms.push(b.atom(`a${i}`, i));
	const comps = [];
	for (let i = 0; i < N; i++) {
		comps.push(b.computed(`c${i}`, (read) => {
			let acc = read(flag) === 0 ? read(atoms[i % A]) : read(atoms[(i + 1) % A]);
			for (let j = 1; j < D; j++) acc += read(atoms[(i * 7 + j) % A]);
			return acc;
		}));
	}
	let prevToken;
	run = () => {
		for (let p = 0; p < PASSES; p++) {
			const t = b.openBatch();
			b.write(t.id, flag, { kind: 'set', value: p & 1 });
			b.write(t.id, atoms[p % A], { kind: 'set', value: p });
			const pass = b.passStart(1, [t.id]);
			const world = { kind: 'pass', pass };
			for (let i = 0; i < N; i++) checksum += b.evaluate(comps[i], world);
			b.passEnd(pass.id, 'discard');
			if (prevToken !== undefined) b.retire(prevToken.id, false); // superseded keystroke
			prevToken = t;
		}
	};
}

const ns = repsNs(run, { warmup: 2, reps: 7 });
for (const total of ns) {
	row({ metric: `churn/${IMPL}${IMPL === 'proto' ? `-${MODE}` : ''}`, value: total / PASSES, unit: 'ns/pass' });
}
row({ metric: `checksum/churn/${IMPL}`, note: String(checksum) });
