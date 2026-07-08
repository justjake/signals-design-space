import { describe, expect, it } from 'vitest';
import { createCosignalEngine } from '../src/engine';
import { createAPI, isSuspendedBox } from '../src/api';
import { createForkDouble } from '../src/fork-double';

// M4 — the policy layer: §4 classes, §11.3 boxes, §12.3 ctx.use, §12.4
// observed lifecycle + §8.6 LIVE propagation, §12.5 forbidWritesInComputeds.

function makeAPI() {
	const engine = createCosignalEngine();
	return { engine, api: createAPI(engine) };
}

function tick(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}

describe('§4 API classes', () => {
	it('Atom/ReducerAtom/Computed class surface', () => {
		const { api } = makeAPI();
		const count = new api.Atom({ state: 1 });
		const doubled = new api.Computed({ fn: () => count.state * 2 });
		expect(doubled.state).toBe(2);
		count.set(5);
		expect(doubled.state).toBe(10);
		count.update((x) => x + 1);
		expect(doubled.state).toBe(12);

		const r = new api.ReducerAtom({
			state: 0,
			reducer: (s: number, a: { n: number }) => s + a.n,
		});
		r.dispatch({ n: 7 });
		expect(r.state).toBe(7);
	});

	it('custom equality on Computed returns stable references', () => {
		const { api } = makeAPI();
		const a = new api.Atom({ state: 1 });
		const c = new api.Computed({
			fn: () => ({ v: a.state % 2 }),
			isEqual: (x: { v: number }, y: { v: number }) => x.v === y.v,
		});
		const first = c.state;
		a.set(3);
		expect(c.state).toBe(first);
	});
});

describe('§11.3 sentinel boxes', () => {
	it('a throwing fn becomes a cached error; read sites rethrow; recovery works', () => {
		const { api } = makeAPI();
		const a = new api.Atom({ state: 1 });
		let evals = 0;
		const c = new api.Computed({
			fn: () => {
				++evals;
				if (a.state === 0) {
					throw new Error('div by zero');
				}
				return 10 / a.state;
			},
		});
		expect(c.state).toBe(10);
		a.set(0);
		expect(() => c.state).toThrow('div by zero');
		const n = evals;
		expect(() => c.state).toThrow('div by zero'); // cached: no re-eval
		expect(evals).toBe(n);
		a.set(2);
		expect(c.state).toBe(5); // flags were never corrupted by the throw
	});

	it('errors do not propagate through the graph as exceptions (box is a value)', () => {
		const { api } = makeAPI();
		const a = new api.Atom({ state: 1 });
		const inner = new api.Computed({
			fn: () => {
				if (a.state === 0) {
					throw new Error('inner boom');
				}
				return a.state;
			},
		});
		// A dependent that reads through the class getter observes the rethrow.
		const outer = new api.Computed({
			fn: () => {
				try {
					return inner.state * 10;
				} catch {
					return -1;
				}
			},
		});
		expect(outer.state).toBe(10);
		a.set(0);
		expect(outer.state).toBe(-1); // exception surfaced at the READ site only
		a.set(3);
		expect(outer.state).toBe(30);
	});

	it('unchanged error state keeps the same box reference (§11.2)', () => {
		const { api } = makeAPI();
		const a = new api.Atom({ state: 0 });
		const b = new api.Atom({ state: 0 });
		const err = new Error('stable');
		const c = new api.Computed({
			fn: () => {
				b.state; // extra dep to force re-evals
				if (a.state === 0) {
					throw err;
				}
				return a.state;
			},
		});
		const box1 = c.boxed;
		b.set(1); // re-evaluate; same error identity
		const box2 = c.boxed;
		expect(box2).toBe(box1); // reference-stable box
	});
});

describe('§12.3 ctx.use and suspense', () => {
	it('pending → suspended box; settlement invalidates; value lands', async () => {
		const { api } = makeAPI();
		let resolve!: (v: number) => void;
		const promise = new Promise<number>((r) => (resolve = r));
		const c = new api.Computed({
			fn: (ctx) => ctx.use(promise) * 2,
		});
		expect(isSuspendedBox(c.boxed)).toBe(true);
		expect(() => c.state).toThrow(); // read sites surface the thenable
		let effectSaw: unknown;
		api.effect(() => {
			effectSaw = c.boxed;
		});
		resolve(21);
		await tick();
		await tick();
		expect(c.state).toBe(42); // settlement wake-up re-evaluated
		expect(effectSaw).toBe(42); // invalidate reached the effect
	});

	it('rejection becomes a cached error', async () => {
		const { api } = makeAPI();
		const promise = Promise.reject(new Error('fetch failed'));
		const c = new api.Computed({
			fn: (ctx) => ctx.use(promise),
		});
		expect(isSuspendedBox(c.boxed)).toBe(true);
		await tick();
		await tick();
		expect(() => c.state).toThrow('fetch failed');
	});

	it('canonical thenable identity: retries reuse the store-held thenable; input changes refetch (latest-wins)', async () => {
		const { api } = makeAPI();
		const dep = new api.Atom({ state: 0 });
		let created = 0;
		const make = (): Promise<number> => {
			++created;
			return Promise.resolve(5 + (dep.handle.peek() as number));
		};
		const c = new api.Computed({
			fn: (ctx) => {
				dep.state;
				return ctx.use(make());
			},
		});
		c.boxed; // first eval registers position 0 (pending)
		const afterFirst = created;
		c.boxed; // pending is GRAPH STATE: the box is cached — no re-evaluation
		expect(created).toBe(afterFirst);
		await tick();
		await tick();
		expect(c.state).toBe(5); // settled through invalidate → propagate
		const settledCreations = created;
		expect(c.state).toBe(5); // no re-evaluation, no fetch
		expect(created).toBe(settledCreations);
		// A REAL input change: canonical slots were cleared at the settled
		// completion, so the next evaluation fetches fresh (latest-wins) —
		// and the TWO-LEVEL RULE serves the stale value while it refetches
		// (refresh-pending has a latest; no suspension).
		dep.set(1);
		expect(c.state).toBe(5); // stale content, straight through
		expect(isSuspendedBox(c.boxed)).toBe(true); // ...while pending underneath
		await tick();
		await tick();
		expect(c.state).toBe(6); // 5 + dep(1) — the NEW input's data
	});

	it('settlement bumps the overlay epoch so writer-world memos re-validate', async () => {
		const { engine, api } = makeAPI();
		const fork = createForkDouble();
		engine.attachFork(fork);
		fork.registerRoot('root');
		const epochBefore = engine.debug.epoch();
		const c = new api.Computed({ fn: (ctx) => ctx.use(Promise.resolve(1)) });
		c.boxed;
		await tick();
		await tick();
		expect(engine.debug.epoch()).toBeGreaterThan(epochBefore);
		expect(c.state).toBe(1);
	});

	it('pass-world suspensions key on render lineage and survive restarts', () => {
		const { engine, api } = makeAPI();
		const fork = createForkDouble();
		engine.attachFork(fork);
		fork.registerRoot('root');
		const flag = new api.Atom({ state: 0 });
		let created = 0;
		const c = new api.Computed({
			fn: (ctx) => {
				if (flag.state === 1) {
					++created;
					return ctx.use(new Promise<number>(() => undefined));
				}
				return 0;
			},
		});
		expect(c.state).toBe(0); // canonical: flag 0
		const t = fork.openBatch('deferred');
		t.run(() => flag.set(1));
		expect(engine.debug.readWorld(c.handle, { kind: 'w0' })).toBe(0); // canonical untouched
		const pass = fork.startPass('root', { include: [t] });
		expect(isSuspendedBox(engine.debug.readWorld(c.handle, { kind: 'pass' }))).toBe(true);
		expect(created).toBe(1);
		const pass2 = pass.restart(); // same lineage → same thenable position
		expect(isSuspendedBox(engine.debug.readWorld(c.handle, { kind: 'pass' }))).toBe(true);
		expect(created).toBe(2); // re-evaluated, but...
		// ...the SAME cached thenable was reused: dropLineage then re-restart
		// would re-fetch; without it, position 0 held.
		pass2.end();
		t.retire();
	});
});

describe('§12.3 (adapted): pending as graph state', () => {
	it('downstream computeds FORWARD pending by default and settle by propagation', async () => {
		const { api } = makeAPI();
		let release!: (v: number) => void;
		const data = new Promise<number>((r) => (release = r));
		const source = new api.Computed({ fn: (ctx) => ctx.use(data) });
		// A zero-arity (slim) downstream computed: reads the pending source
		// through the ordinary class getter — no ctx, no use().
		const doubled = new api.Computed({ fn: () => (source.state as number) * 2 });
		// And a ctx-ful one above THAT (two forwarding hops).
		const plusOne = new api.Computed({ fn: () => (doubled.state as number) + 1 });
		expect(isSuspendedBox(doubled.boxed)).toBe(true); // forwarded, not thrown
		expect(isSuspendedBox(plusOne.boxed)).toBe(true);
		// The forwarded thenable is the SOURCE's store-held one (stable identity).
		const b1 = doubled.boxed;
		const b2 = doubled.boxed;
		expect(b1).toBe(b2); // graph state: cached box, no re-evaluation churn
		release(21);
		await tick();
		await tick();
		expect(doubled.state).toBe(42); // settlement = a normal write, resumed by propagation
		expect(plusOne.state).toBe(43);
	});

	it('parallel fetches: multiple ctx.use in one evaluation all register before pending surfaces', async () => {
		const { api } = makeAPI();
		let started = 0;
		let releaseA!: (v: number) => void;
		let releaseB!: (v: number) => void;
		const make = (r: (f: (v: number) => void) => void): Promise<number> =>
			new Promise<number>((res) => {
				++started;
				r(res);
			});
		const c = new api.Computed({
			fn: (ctx) => {
				const a = ctx.use(make((f) => (releaseA = f)));
				const b = ctx.use(make((f) => (releaseB = f))); // must still run while a is pending
				return (a as number) + (b as number);
			},
		});
		expect(isSuspendedBox(c.boxed)).toBe(true);
		expect(started).toBe(2); // BOTH fetches registered — no throw-created waterfall
		releaseA(1);
		await tick();
		await tick();
		releaseB(2);
		await tick();
		await tick();
		expect(c.state).toBe(3);
	});
});

describe('Solid-2.0 async API set (isPending / refresh / latest)', () => {
	it('isPending flips only on pending↔settled and never refetches', async () => {
		const { api } = makeAPI();
		const dep = new api.Atom({ state: 1 });
		const resolvers: Array<(v: number) => void> = [];
		let fetches = 0;
		const remote = new api.Computed<number>({
			fn: (ctx) => {
				const d = dep.state as number;
				++fetches;
				return (ctx.use(new Promise<number>((r) => resolvers.push(r))) as number) + d;
			},
		});
		const flips: boolean[] = [];
		api.effect(() => {
			flips.push(api.isPending(remote));
		});
		expect(flips).toEqual([true]); // first load: pending
		const probeFetches = fetches;
		api.isPending(remote); // probing again...
		api.isPending(remote);
		expect(fetches).toBe(probeFetches); // ...never refetches (§8 rule)
		await tick();
		resolvers[0](10);
		await tick();
		await tick();
		expect(remote.state).toBe(11);
		expect(flips).toEqual([true, false]); // flip-only: one edge per transition
		dep.set(2); // refetch (input change)
		expect(flips).toEqual([true, false, true]);
		// Resolve the LIVE fetch (cache-less callers discard one superseded
		// promise per settlement wave — latest-wins ignores stale resolvers).
		resolvers[resolvers.length - 1](20);
		await tick();
		await tick();
		expect(remote.state).toBe(22);
		expect(flips).toEqual([true, false, true, false]);
	});

	it('latest asymmetry: upstream reads the in-flight (newest) value; the async node reads its stale committed value', async () => {
		const { api } = makeAPI();
		const fork = createForkDouble();
		api.engine.attachFork(fork);
		fork.registerRoot('root');
		const x = new api.Atom({ state: 1 });
		const doubled = new api.Computed({ fn: () => (x.state as number) * 2 });
		const resolvers: Array<(v: number) => void> = [];
		const asyncTen = new api.Computed<number>({
			fn: (ctx) => {
				const d = x.state as number;
				return (ctx.use(new Promise<number>((r) => resolvers.push(r))) as number) * d;
			},
		});
		asyncTen.boxed; // start first load
		resolvers[0](10);
		await tick();
		await tick();
		expect(asyncTen.state).toBe(10); // 10 * 1

		// A pending deferred write to x: the in-flight (newest) world moves,
		// the committed world does not, and the async node refetches.
		const t = fork.openBatch('deferred');
		t.run(() => x.set(2));
		// upstream: latest() samples the NEWEST world (Wn) → the in-flight 2.
		expect(api.latest(x)).toBe(2);
		// ALT-FAMILY AMBIENT RULE: `.state` outside the batch's own scope is
		// W0 — the pending deferred draft is invisible; latest() above is THE
		// explicit drafts-included read.
		expect(x.state).toBe(1);
		t.run(() => {
			expect(x.state).toBe(2); // read-your-own-draft inside the scope
		});
		expect(api.engine.readCommitted(x.handle)).toBe(1);
		// sync memo downstream of x: latest = in-flight derivation.
		expect(api.latest(doubled)).toBe(4);
		// the ASYNC node itself: refetching in the newest world → its latest()
		// is the stale committed value, and it does not suspend or register.
		expect(api.latest(asyncTen)).toBe(10);
		t.retire();
		// Force the canonical refetch (recompute is lazy), then settle ITS
		// promise — earlier world-eval fetches are superseded (latest-wins).
		asyncTen.boxed;
		resolvers[resolvers.length - 1](30);
		await tick();
		await tick();
		expect(asyncTen.state).toBe(60); // 30 * 2 after settlement commit
	});

	it('refresh() preserves latest, forces re-registration, and races latest-wins', async () => {
		const { api } = makeAPI();
		const resolvers: Array<(v: number) => void> = [];
		let fetches = 0;
		const remote = new api.Computed<number>({
			fn: (ctx) => {
				++fetches;
				return ctx.use(new Promise<number>((r) => resolvers.push(r)));
			},
		});
		remote.boxed;
		resolvers[0](1);
		await tick();
		await tick();
		expect(remote.state).toBe(1);
		api.refresh(remote);
		expect(remote.state).toBe(1); // refresh-pending serves latest (stale)
		expect(api.isPending(remote)).toBe(true);
		const raceLoser = resolvers[resolvers.length - 1];
		api.refresh(remote); // refresh RACE: supersedes the in-flight fetch
		remote.boxed; // force the re-registration
		const raceWinner = resolvers[resolvers.length - 1];
		raceLoser(2); // the SUPERSEDED fetch settles: latest-wins → ignored
		await tick();
		await tick();
		expect(api.isPending(remote)).toBe(true); // still waiting on the winner
		expect(remote.state).toBe(1);
		expect(fetches).toBeGreaterThan(2);
		raceWinner(3); // the winning fetch settles
		await tick();
		await tick();
		expect(remote.state).toBe(3);
		expect(api.isPending(remote)).toBe(false);
		// refresh on an atom is a no-op (plain signals have no fetch to force).
		const a = new api.Atom({ state: 5 });
		api.refresh(a);
		expect(a.state).toBe(5);
	});
});

describe('§12.4 observed lifecycle + §8.6 LIVE propagation', () => {
	it('mounts on first (transitive) watcher, cleans up on last unwatch', async () => {
		const { engine, api } = makeAPI();
		const log: string[] = [];
		const a = new api.Atom({
			state: 1,
			effect: () => {
				log.push('mount');
				return () => log.push('cleanup');
			},
		});
		const c = new api.Computed({ fn: () => a.state + 1 });
		expect(c.state).toBe(2); // read alone does not observe
		await tick();
		expect(log).toEqual([]);
		const w = engine.watch(c.handle); // transitively watches a through c
		await tick();
		expect(log).toEqual(['mount']);
		expect(engine.policy.isLive(a.handle)).toBe(true);
		w.dispose();
		await tick();
		expect(log).toEqual(['mount', 'cleanup']);
		expect(engine.policy.isLive(a.handle)).toBe(false);
	});

	it('an observe/unobserve flap within one tick nets to nothing (§12.4 debounce)', async () => {
		const { engine, api } = makeAPI();
		const log: string[] = [];
		const a = new api.Atom({
			state: 1,
			effect: () => {
				log.push('mount');
				return () => log.push('cleanup');
			},
		});
		const w = engine.watch(a.handle);
		w.dispose(); // same tick
		await tick();
		expect(log).toEqual([]);
	});

	it('effects drive liveness too', async () => {
		const { api, engine } = makeAPI();
		const log: string[] = [];
		const a = new api.Atom({
			state: 1,
			effect: () => {
				log.push('mount');
				return () => log.push('cleanup');
			},
		});
		const dispose = api.effect(() => {
			a.state;
		});
		await tick();
		expect(log).toEqual(['mount']);
		dispose();
		await tick();
		expect(log).toEqual(['mount', 'cleanup']);
		expect(engine.policy.isLive(a.handle)).toBe(false);
	});
});

describe('§12.5 forbidWritesInComputeds', () => {
	it('writes inside canonical computed evaluation throw when configured', () => {
		const { api } = makeAPI();
		const a = new api.Atom({ state: 0 });
		const b = new api.Atom({ state: 0 });
		const c = new api.Computed({
			fn: () => {
				b.set(a.state); // side effect in computed
				return a.state;
			},
		});
		expect(c.state).toBe(0); // allowed by default
		api.configure({ forbidWritesInComputeds: true });
		a.set(1);
		expect(() => c.state).toThrow(/forbidden/);
		api.configure({ forbidWritesInComputeds: false });
	});

	it('render-world evaluation always rejects writes (§10.8), independent of the switch', () => {
		const { engine, api } = makeAPI();
		const fork = createForkDouble();
		engine.attachFork(fork);
		fork.registerRoot('root');
		const a = new api.Atom({ state: 0 });
		const evil = new api.Computed({
			fn: () => {
				if (a.state > 0) {
					a.set(a.state + 1);
				}
				return a.state;
			},
		});
		expect(evil.state).toBe(0);
		const t = fork.openBatch('deferred');
		t.run(() => a.set(1));
		const pass = fork.startPass('root', { include: [t] });
		expect(() => evil.state).toThrow(/render/); // pass-world overlay frame
		pass.end();
		t.retire();
	});
});
