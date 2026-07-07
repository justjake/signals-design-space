// Workload shapes shared by the quiet-residual children: read polling, deep
// propagation, broad isolated updates, and a diamond. Each returns
// { run(n): number, checksum(): number } over injected {Atom, Computed,
// effect} constructors so both children run identical workload code without
// sharing a process or an import graph.
export function makeShape(name, { Atom, Computed, effect }) {
	if (name === 'readPoll') {
		const a = new Atom(1);
		let sink = 0;
		return {
			run(n) {
				let s = 0;
				for (let i = 0; i < n; i++) s += a.state;
				sink += s;
				return s;
			},
			checksum: () => sink,
		};
	}
	if (name === 'deepPropagate') {
		const a = new Atom(0);
		let prev = new Computed(() => a.state + 1);
		for (let d = 1; d < 50; d++) {
			const p = prev;
			prev = new Computed(() => p.state + 1);
		}
		const top = prev;
		let sink = 0;
		effect(() => { sink += top.state; });
		let v = 0;
		return {
			run(n) {
				for (let i = 0; i < n; i++) a.set(++v);
				return sink;
			},
			checksum: () => sink + top.state,
		};
	}
	if (name === 'broadIsolate') {
		const atoms = [];
		const tops = [];
		let sink = 0;
		for (let i = 0; i < 100; i++) {
			const a = new Atom(i);
			const c = new Computed(() => a.state + 1);
			atoms.push(a);
			tops.push(c);
			effect(() => { sink += c.state; });
		}
		let v = 0;
		return {
			run(n) {
				for (let i = 0; i < n; i++) atoms[i % 100].set(++v);
				return sink;
			},
			checksum: () => sink + tops[0].state,
		};
	}
	if (name === 'diamond') {
		const a = new Atom(0);
		const mids = [];
		for (let i = 0; i < 4; i++) mids.push(new Computed(() => a.state + i));
		const join = new Computed(() => mids[0].state + mids[1].state + mids[2].state + mids[3].state);
		let sink = 0;
		effect(() => { sink += join.state; });
		let v = 0;
		return {
			run(n) {
				for (let i = 0; i < n; i++) a.set(++v);
				return sink;
			},
			checksum: () => sink + join.state,
		};
	}
	throw new Error(`unknown shape ${name}`);
}

export const SHAPE_OPS = { readPoll: 2_000_000, deepPropagate: 20_000, broadIsolate: 200_000, diamond: 200_000 };
