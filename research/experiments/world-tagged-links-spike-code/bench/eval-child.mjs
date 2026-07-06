// Bench (d): per-world evaluation/revalidation cost with a LONG-LIVED world.
// Per round: kernel-visible write(s), then re-read N computeds (D deps each)
// under the world. MODE=one writes 1 atom (precision test: only the dirty cone
// should re-evaluate); MODE=all writes every atom (pure eval-cost test).
//   proto:       persistent world; structural links + per-world flags
//   head-newest: shipped newest memo plane (O(1) fingerprints)
//   head-pass:   per-round render pass world (pass memos die each round)
import { row, repsNs, env, envInt } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench/util.mjs';

const IMPL = env('IMPL', 'head-newest'); // proto | head-newest | head-pass
const MODE = env('MODE', 'one'); // one | all | none (no writes: pure clean-revalidation)
const N = envInt('N', 100); // computeds
const D = envInt('D', 8); // atom deps per computed
const A = envInt('A', 128); // atom pool
const ROUNDS = envInt('ROUNDS', MODE === 'all' ? 300 : 2000);

const SPIKE_SRC = '/Users/jitl/src/alien-signals-opt/milomg-reactivity-benchmark/.claude/worktrees/agent-a9d009b875849ef38/spike/cosignal/src/index.ts';
const HEAD_SRC = '/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts';

let run;
let checksum = 0;
let round = 0;

if (IMPL === 'proto') {
	const lib = await import(SPIKE_SRC);
	const { Atom, Computed } = lib;
	const atoms = [];
	for (let i = 0; i < A; i++) atoms.push(new Atom(i));
	const comps = [];
	for (let i = 0; i < N; i++) {
		comps.push(new Computed(() => {
			let acc = 0;
			for (let j = 0; j < D; j++) acc += atoms[(i * D + j) % A].state;
			return acc;
		}));
	}
	const w = lib.__worldBegin();
	for (let i = 0; i < N; i++) lib.__worldRead(w, comps[i]); // prime the world
	run = () => {
		for (let r = 0; r < ROUNDS; r++) {
			round++;
			if (MODE === 'one') {
				atoms[round % A].set(round); // kernel write -> world fanout marks the cone
			} else if (MODE === 'all') {
				for (let i = 0; i < A; i++) atoms[i].set(round + i);
			} // MODE=none: no writes

			for (let i = 0; i < N; i++) checksum += lib.__worldRead(w, comps[i]);
		}
	};
} else {
	const lib = await import(HEAD_SRC);
	const b = new lib.CosignalBridge();
	b.registerBridge(); // logged mode (one bridge per bench process)
	const atoms = [];
	for (let i = 0; i < A; i++) atoms.push(b.atom(`a${i}`, i));
	const comps = [];
	for (let i = 0; i < N; i++) {
		comps.push(b.computed(`c${i}`, (read) => {
			let acc = 0;
			for (let j = 0; j < D; j++) acc += read(atoms[(i * D + j) % A]);
			return acc;
		}));
	}
	const NEWEST = { kind: 'newest' };
	for (let i = 0; i < N; i++) b.evaluate(comps[i], NEWEST); // prime the memo plane
	const writeRound = () => {
		if (MODE === 'none') return; // pure clean-revalidation rounds
		// one committed-per-round batch: write(s) then immediate committed
		// retirement (a durable flip the world must observe; tapes stay bounded)
		const t = b.openBatch();
		if (MODE === 'one') {
			b.write(t.id, atoms[round % A], { kind: 'set', value: round });
		} else {
			for (let i = 0; i < A; i++) b.write(t.id, atoms[i], { kind: 'set', value: round + i });
		}
		b.retire(t.id, true);
	};
	if (IMPL === 'head-newest') {
		run = () => {
			for (let r = 0; r < ROUNDS; r++) {
				round++;
				writeRound();
				for (let i = 0; i < N; i++) checksum += b.evaluate(comps[i], NEWEST);
			}
		};
	} else {
		run = () => {
			for (let r = 0; r < ROUNDS; r++) {
				round++;
				writeRound();
				const pass = b.passStart(1, []);
				const world = { kind: 'pass', pass };
				for (let i = 0; i < N; i++) checksum += b.evaluate(comps[i], world);
				b.passEnd(pass.id, 'discard');
			}
		};
	}
}

const ns = repsNs(run, { warmup: 2, reps: 7 });
for (const total of ns) {
	row({ metric: `eval/${MODE}/${IMPL}`, value: total / (ROUNDS * N), unit: 'ns/computed-read' });
}
row({ metric: `checksum/eval/${IMPL}/${MODE}`, note: String(checksum) });
