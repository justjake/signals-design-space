// Solid-2.0 async API set (§7 of research/solid2-async-model.md, adapted):
// isPending / refresh / latest against the engine + fork double. The
// two-level suspense rule's HOOK half lives in react-real.test.tsx; this
// file pins the engine-policy half: box shape, flip-only probes, refresh
// epochs + latest-wins, and latest()'s per-context world choice.
import { beforeEach, describe, expect, it } from 'vitest';
import {
	Atom,
	Computed,
	ForkDouble,
	__debug,
	__resetEngineForTests,
	attachFork,
	createWatcher,
	isPending,
	latest,
	pendingComputedOf,
	refresh,
} from '../src/index';

let fork: ForkDouble;

beforeEach(() => {
	__resetEngineForTests();
	fork = new ForkDouble();
	attachFork(fork);
});

/** Resource idiom: one promise per (param, refreshEpoch) request key. */
function makeResource() {
	const param = new Atom({ state: 1 });
	const gates = new Map<string, { promise: Promise<number>; resolve: (v: number) => void }>();
	const requested: string[] = [];
	function gateFor(key: string) {
		let g = gates.get(key);
		if (g === undefined) {
			let resolve!: (v: number) => void;
			const promise = new Promise<number>((res) => {
				resolve = res;
			});
			g = { promise, resolve };
			gates.set(key, g);
			requested.push(key);
		}
		return g;
	}
	const data = new Computed<number>({
		fn: (ctx) => ctx.use(gateFor(`${param.state}:${ctx.refreshEpoch}`).promise) * 10,
	});
	return { param, data, gateFor, requested };
}

async function settle(key: string, v: number, r: ReturnType<typeof makeResource>) {
	// The engine subscribes to a thenable at the node's first EVALUATION —
	// make sure that happened (a top-level pending read throws; swallow it).
	try {
		void r.data.state;
	} catch {
		// pending or errored: evaluation (and subscription) happened either way
	}
	r.gateFor(key).resolve(v);
	await r.gateFor(key).promise;
	await Promise.resolve(); // the engine's settlement subscriber runs first
}

describe('isPending (§7): flip-only reactive pending probe', () => {
	it('lifecycle: false on first load, true on refresh, false at settle', async () => {
		const r = makeResource();
		// First load: pending but UNINITIALIZED (no latest) — NOT pending per
		// computePendingState rule 4 (stale-data-while-loading only).
		expect(isPending(r.data)).toBe(false);
		await settle('1:0', 5, r);
		expect(r.data.state).toBe(50);
		expect(isPending(r.data)).toBe(false);
		refresh(r.data);
		expect(isPending(r.data)).toBe(true); // refetch in flight, stale exists
		await settle('1:1', 7, r);
		expect(isPending(r.data)).toBe(false);
		expect(r.data.state).toBe(70);
		__debug.verify();
	});

	it('flip-only: settled value changes do not notify probe watchers', async () => {
		const r = makeResource();
		await settle('1:0', 5, r);
		const probe = pendingComputedOf(r.data);
		const fires: number[] = [];
		const w = createWatcher(probe, (token) => fires.push(token));
		// Param change starts a NEW request (new key) — data flips to pending
		// (refresh-pending: latest exists) → exactly one probe notification.
		r.param.set(2);
		expect(fires.length).toBe(1);
		expect(probe.state).toBe(true);
		await settle('2:0', 6, r);
		expect(probe.state).toBe(false);
		expect(fires.length).toBe(2); // the settle flip
		// A same-shape re-derivation (no flip) must not fire: refresh + settle
		// crosses pending↔settled twice — two more fires, no extras.
		refresh(r.data);
		await settle('2:1', 6, r);
		expect(fires.length).toBe(4);
		w.dispose();
		__debug.verify();
	});

	it('errors read as not-pending; atoms are never pending', () => {
		const boom = new Computed<number>({
			fn: () => {
				throw new Error('boom');
			},
		});
		expect(isPending(boom)).toBe(false);
		const a = new Atom({ state: 1 });
		expect(isPending(a)).toBe(false);
		__debug.verify();
	});

	it('is per-world correct: pending only in the world that diverged into it', async () => {
		// Branch cond flips to the async arm only in the writer's world.
		const cond = new Atom({ state: 0 }); // even → plain arm
		const plain = new Atom({ state: 3 });
		const r = makeResource();
		await settle('1:0', 5, r);
		refresh(r.data); // async node now refresh-pending
		const view = new Computed<number>({
			fn: () => (cond.state % 2 === 1 ? r.data.state : plain.state),
		});
		const probe = pendingComputedOf(view);
		const token = fork.openBatch(true);
		fork.inBatch(token, () => cond.set(1)); // odd ONLY in this world
		// Ambient-W0 semantics: the top-level probe read sees W0 — the plain
		// arm, not pending. The writer's world (and the explicit Wn read)
		// include the unapplied flip — pending there.
		expect(probe.state).toBe(false); // ambient = W0: draft invisible
		expect(__debug.readInWorld(probe, { kind: 'w0' })).toBe(false);
		expect(__debug.readInWorld(probe, { kind: 'newest' })).toBe(true);
		expect(__debug.readInWorld(probe, { kind: 'writer', token })).toBe(true);
		fork.retireBatch(token, true);
		__debug.verify();
	});
});

describe('refresh (§7): re-run with a fresh request, latest preserved', () => {
	it('no-op on atoms and plain signals', () => {
		const a = new Atom({ state: 42 });
		refresh(a);
		expect(a.state).toBe(42);
		__debug.verify();
	});

	it('preserves box.latest: the result is refresh-pending, never uninitialized', async () => {
		const r = makeResource();
		await settle('1:0', 5, r);
		expect(r.data.state).toBe(50);
		refresh(r.data);
		// Pending again — but latest carries the settled value through.
		expect(latest(r.data)).toBe(50);
		expect(isPending(r.data)).toBe(true);
		expect(() => r.data.state).toThrow(); // top-level pending read still throws (§11.3)
		await settle('1:1', 9, r);
		expect(r.data.state).toBe(90);
		__debug.verify();
	});

	it('re-runs the fn so ctx.use re-registers a fresh request (epoch key)', async () => {
		const r = makeResource();
		await settle('1:0', 5, r);
		expect(r.requested).toEqual(['1:0']);
		refresh(r.data);
		expect(r.requested).toEqual(['1:0', '1:1']); // a genuinely new fetch began
		await settle('1:1', 6, r);
		expect(r.data.state).toBe(60);
		__debug.verify();
	});

	it('only refreshes the targeted node, not its upstream (§7 refresh, #2691)', async () => {
		let upstreamRuns = 0;
		const a = new Atom({ state: 2 });
		const up = new Computed<number>({
			fn: () => {
				++upstreamRuns;
				return a.state * 2;
			},
		});
		const down = new Computed<number>({ fn: () => up.state + 1 });
		expect(down.state).toBe(5);
		const before = upstreamRuns;
		refresh(down);
		expect(down.state).toBe(5);
		expect(upstreamRuns).toBe(before); // upstream memo untouched
		__debug.verify();
	});

	it('latest-wins under refresh races: a superseded settlement cannot regress the value', async () => {
		const r = makeResource();
		await settle('1:0', 5, r);
		refresh(r.data); // request 1:1
		refresh(r.data); // request 1:2 supersedes 1:1
		// Settle the SUPERSEDED request first: the waiter re-runs and lands on
		// the current request — still pending, value unchanged.
		await settle('1:1', 111, r);
		expect(isPending(r.data)).toBe(true);
		expect(latest(r.data)).toBe(50);
		await settle('1:2', 7, r);
		expect(r.data.state).toBe(70); // never showed 1110
		__debug.verify();
	});
});

describe('latest (§7): current-or-stale, never suspends, never registers pending', () => {
	it('async node: undefined while uninitialized, stale while refresh-pending', async () => {
		const r = makeResource();
		expect(latest(r.data)).toBe(undefined); // first load: no stale value exists
		await settle('1:0', 5, r);
		expect(latest(r.data)).toBe(50);
		refresh(r.data);
		expect(latest(r.data)).toBe(50); // stale through the refetch
		await settle('1:1', 8, r);
		expect(latest(r.data)).toBe(80);
		__debug.verify();
	});

	it('asymmetry: latest(upstream atom) = NEWEST (in-flight) at top level; committed view differs', () => {
		const a = new Atom({ state: 1 });
		const token = fork.openBatch(true);
		fork.inBatch(token, () => a.set(2));
		// Top level: ambient context IS the newest world — latest sees the
		// deferred batch's staged write (Solid's staged-read behavior via
		// world reads, no staged buffer).
		expect(latest(a)).toBe(2);
		expect(__debug.committed(() => a.state)).toBe(1); // committed world: old
		fork.retireBatch(token, true);
		expect(latest(a)).toBe(2);
		__debug.verify();
	});

	it('never registers pending: a computed over latest() does not become pending', async () => {
		const r = makeResource();
		await settle('1:0', 5, r);
		refresh(r.data); // pending with latest 50
		const over = new Computed<string>({ fn: () => `v=${latest(r.data) ?? 'none'}` });
		expect(over.state).toBe('v=50'); // NOT pending — latest never forwards
		expect(isPending(over)).toBe(false);
		await settle('1:1', 6, r);
		expect(over.state).toBe('v=60');
		__debug.verify();
	});

	it('rethrows real errors', async () => {
		const bad = Promise.reject(new Error('nope'));
		const c = new Computed<number>({ fn: (ctx) => ctx.use(bad) });
		expect(latest(c)).toBe(undefined); // pending until rejection lands
		await bad.catch(() => undefined);
		await Promise.resolve();
		expect(() => latest(c)).toThrow('nope');
		__debug.verify();
	});
});
