/**
 * The observation union (AtomOptions.effect over BOTH consumer kinds):
 * kernel-subscriber liveness (the D1 bit) and bridge-watcher liveness feed
 * ONE refcount owned by the atom's lifecycle registration, so an atom
 * observes once when its first consumer of ANY kind attaches and unobserves
 * only when the last consumer of EVERY kind detaches. The microtask flap
 * coalescing spans the union.
 *
 * ENGINE-DIRECT (no twin driver): the reference model deliberately models no
 * observe lifecycle, and these transitions are direct callbacks — never
 * BridgeEvents — so the lockstep comparison surfaces cannot see them (the
 * last test pins that). Watcher liveness is driven the way the shim drives
 * it: the commit layout loop flips it on; `w.live = false` is the shim's
 * debounce-finalized unsubscribe / orphan sweep shape.
 */
import { describe, expect, it } from 'vitest';
import { mountEngineReactEffectPick } from './helpers.js';
import { attachRefereeStream } from './trace-events.js';
import { __newBridgeForTest, Atom, effect, type CosignalBridge } from '../src/index.js';

const tick = (): Promise<void> => new Promise<void>((res) => queueMicrotask(res));

function observedAtom(initial: number): { atom: Atom<number>; log: string[] } {
	const log: string[] = [];
	const atom = new Atom(initial, {
		effect: () => {
			log.push('observe');
			return () => log.push('unobserve');
		},
	});
	return { atom, log };
}

/** A fresh registered bridge (production posture — the only posture: no
 * event objects exist; quiet arming follows the production derivation). */
function bridge(): CosignalBridge {
	const b = __newBridgeForTest();
	b.registerBridge();
	return b;
}

describe('observation union at the bridge', () => {
	it('a live watcher alone observes; dropping it unobserves', async () => {
		const b = bridge();
		const { atom, log } = observedAtom(0);
		const node = b.adoptAtom('a', atom as Atom<unknown>);
		const p = b.passStart('A', []);
		const w = b.mountWatcher(p.id, node, 'W');
		await tick();
		expect(log).toEqual([]); // minted ≠ subscribed: a render alone does not observe
		b.passEnd(p.id, 'commit'); // layout: the watcher goes live
		expect(log).toEqual([]); // delivery is a microtask, never synchronous
		await tick();
		expect(log).toEqual(['observe']);
		w.live = false; // debounce-finalized unsubscribe (the shim's shape)
		await tick();
		expect(log).toEqual(['observe', 'unobserve']);
	});

	it('kernel subscriber + watcher = ONE observation; unobserve only after BOTH detach', async () => {
		const b = bridge();
		const { atom, log } = observedAtom(0);
		const node = b.adoptAtom('a', atom as Atom<unknown>);
		const dispose = effect(() => {
			void atom.state; // kernel consumer: links on the atom's record
		});
		await tick();
		expect(log).toEqual(['observe']);
		const p = b.passStart('A', []);
		const w = b.mountWatcher(p.id, node, 'W');
		b.passEnd(p.id, 'commit'); // watcher consumer joins (union 1→2)
		await tick();
		expect(log).toEqual(['observe']); // interior transition: no re-observe
		dispose(); // kernel side leaves (2→1)
		await tick();
		expect(log).toEqual(['observe']); // still held by the watcher
		w.live = false; // last consumer leaves (1→0)
		await tick();
		expect(log).toEqual(['observe', 'unobserve']);
	});

	it('deferMount hidden prepare never observes; the adoptMount reveal observes exactly once', async () => {
		const b = bridge();
		const { atom, log } = observedAtom(0);
		const node = b.adoptAtom('a', atom as Atom<unknown>);
		const hidden = b.passStart('A', []);
		const w = b.mountWatcher(hidden.id, node, 'W');
		b.deferMount(w.id); // Activity pre-render: layout effects deferred
		b.passEnd(hidden.id, 'commit');
		await tick();
		expect(w.live).toBe(false);
		expect(log).toEqual([]); // the hidden commit subscribed nothing
		const reveal = b.passStart('A', []);
		b.adoptMount(reveal.id, w.id);
		b.passEnd(reveal.id, 'commit'); // adopting commit: subscribe fires HERE
		await tick();
		expect(log).toEqual(['observe']); // one clean 0→1 — the reveal never flapped
		w.live = false;
		await tick();
		expect(log).toEqual(['observe', 'unobserve']);
	});

	it('same-tick handoff between consumer kinds coalesces (no flap either direction)', async () => {
		const b = bridge();
		const { atom, log } = observedAtom(0);
		const node = b.adoptAtom('a', atom as Atom<unknown>);
		const p = b.passStart('A', []);
		const w = b.mountWatcher(p.id, node, 'W');
		b.passEnd(p.id, 'commit');
		await tick();
		expect(log).toEqual(['observe']);
		// watcher → kernel handoff within one tick: the union never sits at 0
		// across a flush point, so nothing fires.
		w.live = false;
		const dispose = effect(() => {
			void atom.state;
		});
		await tick();
		expect(log).toEqual(['observe']);
		// kernel → watcher handoff, same rule.
		const p2 = b.passStart('A', []);
		const w2 = b.mountWatcher(p2.id, node, 'W2');
		b.passEnd(p2.id, 'commit');
		dispose(); // same tick as w2 going live
		await tick();
		expect(log).toEqual(['observe']);
		w2.live = false;
		await tick();
		expect(log).toEqual(['observe', 'unobserve']);
	});

	it('cold flap: commit-subscribe and unsubscribe within one tick net to nothing', async () => {
		const b = bridge();
		const { atom, log } = observedAtom(0);
		const node = b.adoptAtom('a', atom as Atom<unknown>);
		const p = b.passStart('A', []);
		const w = b.mountWatcher(p.id, node, 'W');
		b.passEnd(p.id, 'commit');
		w.live = false; // same tick: e.g. a mount whose tree is immediately torn down
		await tick();
		expect(log).toEqual([]); // coalesced — the documented flap-damping contract
	});

	it('re-asserting watcher liveness is edge-filtered (idempotent, no double retain)', async () => {
		const b = bridge();
		const { atom, log } = observedAtom(0);
		const node = b.adoptAtom('a', atom as Atom<unknown>);
		const p = b.passStart('A', []);
		const w = b.mountWatcher(p.id, node, 'W');
		b.passEnd(p.id, 'commit');
		w.live = true; // re-assertion (already live): must not double-count
		await tick();
		expect(log).toEqual(['observe']);
		w.live = false; // a double retain would strand the union at 1 here
		await tick();
		expect(log).toEqual(['observe', 'unobserve']);
	});

	it('quiet mode: observation transitions need no armed pipeline (production posture)', async () => {
		const b = __newBridgeForTest(); // production posture (quiet arms by derivation alone)
		b.registerBridge();
		const { atom, log } = observedAtom(0);
		const node = b.adoptAtom('a', atom as Atom<unknown>);
		expect(b.quiet).toBe(true);
		const p = b.passStart('A', []); // the pass disarms quiet while open…
		const w = b.mountWatcher(p.id, node, 'W');
		b.passEnd(p.id, 'commit'); // …and it re-arms at the commit
		expect(b.quiet).toBe(true);
		await tick();
		expect(log).toEqual(['observe']); // fired with the pipeline fully quiet
		atom.set(7); // quiet fold — still no receipts/tokens
		expect(b.newestValue(node)).toBe(7);
		expect(b.quiet).toBe(true);
		w.live = false;
		await tick();
		expect(log).toEqual(['observe', 'unobserve']);
		expect(b.quiet).toBe(true);
	});

	it('observation transitions are direct callbacks — never events (lockstep surface unchanged)', async () => {
		const b = bridge();
		const stream = attachRefereeStream(b); // referee posture: decode the packed stream
		const { atom, log } = observedAtom(0);
		const node = b.adoptAtom('a', atom as Atom<unknown>);
		const before = stream.cursor();
		const p = b.passStart('A', []);
		const w = b.mountWatcher(p.id, node, 'W');
		b.passEnd(p.id, 'commit');
		await tick();
		w.live = false;
		await tick();
		expect(log).toEqual(['observe', 'unobserve']);
		const minted = stream.eventsSince(before).map((e) => e.type);
		expect(minted.filter((t) => /observe|lifecycle/i.test(t))).toEqual([]);
		expect(minted).toEqual(['pass-committed']); // pass bookkeeping only
	});

	// RCC-OL1 re-pin (effects unification, 2026-07-06): committed
	// subscriptions (the promoted useSignalEffect mechanism) COUNT toward the
	// observation union — OL1's "anything that subscribes" — via one retain
	// per dep-snapshot node, re-pointed per run. Before the unification an
	// atom observed ONLY by a useSignalEffect never triggered its observe
	// lifecycle (the incident-I3-shaped asymmetry the plan closed).
	it('an atom observed ONLY by a committed subscription observes; removal unobserves; a dep flip moves the retain', async () => {
		const b = bridge();
		const { atom, log } = observedAtom(0);
		const { atom: atomB, log: logB } = observedAtom(0);
		const nodeA = b.adoptAtom('a', atom as Atom<unknown>);
		const nodeB = b.adoptAtom('b', atomB as Atom<unknown>);
		const flag = b.atom('flag', 0);
		const e = mountEngineReactEffectPick(b, 'A', flag, nodeA, nodeB, 'E'); // flag=0 → snapshot {flag, b}
		await tick();
		expect(log).toEqual([]); // a is not in the snapshot
		expect(logB).toEqual(['observe']); // b holds one union retain via the dep snapshot
		const t = b.openBatch();
		b.write(t.id, flag, { kind: 'set', value: 1 });
		b.retire(t.id); // boundary: the body re-chooses a; the retains re-point
		await tick();
		expect(log).toEqual(['observe']);
		expect(logB).toEqual(['observe', 'unobserve']);
		b.removeSubscription(e.id); // teardown releases the snapshot's retains
		await tick();
		expect(log).toEqual(['observe', 'unobserve']);
	});
});
