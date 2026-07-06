/**
 * §18 perf-iteration driver: isolated per-gate workloads over the BUNDLED
 * engine (measure through the shipping pipeline). Usage:
 *
 *   pnpm exec esbuild src/index.ts --bundle --format=esm \
 *     --outfile=bench/dist/cosignals.js
 *   node [--cpu-prof --cpu-prof-dir=bench/profiles] bench/run.mjs <workload> [iters]
 *
 * Workloads: w1=G-6b steady logged write; w2=G-8 marked-cone read (cert16);
 * w2s=G-8 cert4; w3=G-19 traced loop (RING) + untraced baseline;
 * w4=G-6a idle write+closeEvent; d1=DIRECT write baseline; d2=DIRECT read
 * baseline; deep=kernel-heavy DIRECT chain (const-parity A/B workload).
 */
import * as lib from './dist/cosignals.js';

const { createCosignalEngine, createForkDouble, createTracer } = lib;

function fastestOf(fn, iters, reps = 7) {
	fn(); // warm
	let best = Infinity;
	for (let r = 0; r < reps; ++r) {
		const t0 = performance.now();
		for (let i = 0; i < iters; ++i) {
			fn();
		}
		const dt = (performance.now() - t0) / iters;
		if (dt < best) best = dt;
	}
	return best * 1e6; // ns/op
}

function logged() {
	const e = createCosignalEngine();
	const fork = createForkDouble();
	e.attachFork(fork);
	fork.registerRoot('root');
	return { e, fork };
}

const workloads = {
	d1(iters) {
		const e = createCosignalEngine();
		const a = e.atom(0);
		let x = 0;
		return fastestOf(() => a.set(++x), iters);
	},
	d2(iters) {
		const e = createCosignalEngine();
		const atoms = Array.from({ length: 16 }, (_, i) => e.atom(i));
		const c = e.computed(() => atoms.reduce((s, a) => s + a.state, 0));
		c.state;
		return fastestOf(() => c.state, iters);
	},
	w1(iters) {
		const { e, fork } = logged();
		const a = e.atom(0);
		const holder = fork.openBatch('deferred');
		holder.run(() => a.set(-1));
		let x = 0;
		return fastestOf(() => a.set(++x), iters);
	},
	w2(iters) {
		const { e, fork } = logged();
		const atoms = Array.from({ length: 16 }, (_, i) => e.atom(i));
		const c = e.computed(() => atoms.reduce((s, a) => s + a.state, 0));
		c.state;
		const t = fork.openBatch('deferred');
		t.run(() => atoms[0].set(100));
		return fastestOf(() => c.state, iters);
	},
	w2s(iters) {
		const { e, fork } = logged();
		const atoms = Array.from({ length: 4 }, (_, i) => e.atom(i));
		const c = e.computed(() => atoms.reduce((s, a) => s + a.state, 0));
		c.state;
		const t = fork.openBatch('deferred');
		t.run(() => atoms[0].set(100));
		return fastestOf(() => c.state, iters);
	},
	w3(iters) {
		const { e, fork } = logged();
		const a = e.atom(0);
		const c = e.computed(() => a.state + 1);
		c.state;
		const holder = fork.openBatch('deferred');
		holder.run(() => a.set(-1));
		let x = 0;
		const loop = () => {
			a.set(++x);
			c.state;
		};
		const untraced = fastestOf(loop, iters);
		e.setTracer(createTracer({ mode: 'ring', capacity: 1 << 16 }));
		const traced = fastestOf(loop, iters);
		e.setTracer(undefined);
		return { untraced, traced, ratio: traced / untraced };
	},
	w4(iters) {
		const { e, fork } = logged();
		const a = e.atom(0);
		let x = 0;
		return fastestOf(() => {
			a.set(++x);
			fork.closeEvent();
		}, iters);
	},
	deep(iters) {
		const e = createCosignalEngine();
		const a = e.atom(0);
		let prev = e.computed(() => a.state + 1);
		for (let i = 0; i < 50; ++i) {
			const p = prev;
			prev = e.computed(() => p.state + 1);
		}
		const tail = prev;
		let effectRuns = 0;
		e.effect(() => {
			tail.state;
			++effectRuns;
		});
		let x = 0;
		const ns = fastestOf(() => a.set(++x), iters);
		if (effectRuns < iters) throw new Error('deep: effect did not run');
		return ns;
	},
};

workloads.r1 = (iters) => {
	// Interleaved same-session ratio: G-6b steady logged write vs DIRECT.
	const d = createCosignalEngine();
	const da = d.atom(0);
	const { e, fork } = logged();
	const la = e.atom(0);
	const holder = fork.openBatch('deferred');
	holder.run(() => la.set(-1));
	let x = 0;
	let dNs = Infinity;
	let lNs = Infinity;
	for (let round = 0; round < 7; ++round) {
		dNs = Math.min(dNs, fastestOf(() => da.set(++x), iters, 2));
		lNs = Math.min(lNs, fastestOf(() => la.set(++x), iters, 2));
	}
	return { untraced: dNs, traced: lNs, ratio: lNs / dNs };
};
workloads.r2 = (iters) => {
	// Interleaved ratio: G-8 marked NEWEST read (cert 16) vs DIRECT read.
	const d = createCosignalEngine();
	const datoms = Array.from({ length: 16 }, (_, i) => d.atom(i));
	const dc = d.computed(() => datoms.reduce((s2, a) => s2 + a.state, 0));
	dc.state;
	const { e, fork } = logged();
	const atoms = Array.from({ length: 16 }, (_, i) => e.atom(i));
	const c = e.computed(() => atoms.reduce((s2, a) => s2 + a.state, 0));
	c.state;
	const t = fork.openBatch('deferred');
	t.run(() => atoms[0].set(100));
	let dNs = Infinity;
	let lNs = Infinity;
	for (let round = 0; round < 7; ++round) {
		dNs = Math.min(dNs, fastestOf(() => dc.state, iters, 2));
		lNs = Math.min(lNs, fastestOf(() => c.state, iters, 2));
	}
	return { untraced: dNs, traced: lNs, ratio: lNs / dNs };
};
workloads.r2s = (iters) => {
	const d = createCosignalEngine();
	const datoms = Array.from({ length: 4 }, (_, i) => d.atom(i));
	const dc = d.computed(() => datoms.reduce((s2, a) => s2 + a.state, 0));
	dc.state;
	const { e, fork } = logged();
	const atoms = Array.from({ length: 4 }, (_, i) => e.atom(i));
	const c = e.computed(() => atoms.reduce((s2, a) => s2 + a.state, 0));
	c.state;
	const t = fork.openBatch('deferred');
	t.run(() => atoms[0].set(100));
	let dNs = Infinity;
	let lNs = Infinity;
	for (let round = 0; round < 7; ++round) {
		dNs = Math.min(dNs, fastestOf(() => dc.state, iters, 2));
		lNs = Math.min(lNs, fastestOf(() => c.state, iters, 2));
	}
	return { untraced: dNs, traced: lNs, ratio: lNs / dNs };
};

workloads.w3d = (iters) => {
	// G-19 on a tier-0 DIRECT shape: DIRECT paths carry zero tracing
	// instructions, so the ratio prices only the slot checks.
	const e = createCosignalEngine();
	const a = e.atom(0);
	let prev = e.computed(() => a.state + 1);
	for (let i = 0; i < 50; ++i) {
		const p2 = prev;
		prev = e.computed(() => p2.state + 1);
	}
	const tail = prev;
	e.effect(() => {
		tail.state;
	});
	let x = 0;
	const loop = () => a.set(++x);
	const untraced = fastestOf(loop, iters);
	e.setTracer(createTracer({ mode: 'ring', capacity: 1 << 16 }));
	const traced = fastestOf(loop, iters);
	e.setTracer(undefined);
	return { untraced, traced, ratio: traced / untraced };
};

workloads.kdeep = (iters) => {
	// kairo deepPropagation through the CLASS API (the product surface).
	const { Atom, Computed, effect, batch } = lib.createServerEngineLike?.() ?? lib;
	const head = new Atom({ state: 0 });
	let current = new Computed({ fn: () => head.state + 1 });
	for (let i = 0; i < 49; ++i) {
		const c = current;
		current = new Computed({ fn: () => c.state + 1 });
	}
	let calls = 0;
	effect(() => {
		current.state;
		++calls;
	});
	let x = 0;
	const ns = fastestOf(() => {
		batch(() => head.set(++x));
		if (current.state !== 50 + x) throw new Error('bad value');
	}, iters);
	if (calls < iters) throw new Error('effect did not run');
	return ns;
};
workloads.kbroad = (iters) => {
	const { Atom, Computed, effect, batch } = lib;
	const head = new Atom({ state: 0 });
	const disposers = [];
	for (let i = 0; i < 50; ++i) {
		const c = new Computed({ fn: () => head.state + i });
		disposers.push(effect(() => { c.state; }));
	}
	let x = 0;
	return fastestOf(() => {
		batch(() => head.set(++x));
	}, iters);
};

const name = process.argv[2] ?? 'w1';
const iters = Number(process.argv[3] ?? (name === 'deep' ? 20000 : name.startsWith('d2') || name.startsWith('w2') || name.startsWith('r2') ? 200000 : 50000));
const result = workloads[name](iters);
if (typeof result === 'number') {
	console.log(`${name}: ${result.toFixed(1)} ns/op (${iters} iters)`);
} else {
	console.log(`${name}: untraced ${result.untraced.toFixed(1)}ns traced ${result.traced.toFixed(1)}ns ratio ${result.ratio.toFixed(3)}x`);
}
