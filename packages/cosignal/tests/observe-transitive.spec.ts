/**
 * TRANSITIVE observation through derived values (graph-consumers row 18,
 * flipped): while a derived node has — or transitively feeds — a live
 * watcher, every ATOM its current evaluation reads holds one retain on the
 * observation union (AtomOptions.effect), released with the last watcher.
 * The retains follow the CURRENT strong (tracked) edge set, not the
 * episode-accumulated K1 log: each fn re-run of an observed computed
 * re-points them (dep flips move a retain from the abandoned branch to the
 * taken one), same-tick flip-flaps coalesce in the kernel's microtask
 * flush, and the observation index survives quiescence's K1 bulk-reset (the
 * closure belongs to live watchers, not to the episode). A getter that
 * throws retains the deps it read up to the throw — those reads recorded
 * K1 edges, so deliveries still reach the node's watchers through them.
 *
 * Every test here (except the kernel-chain contrast leg, which pins the
 * pre-existing K0 behavior the overlay now matches) FAILS without the
 * observation index in src/concurrent.ts.
 */
import { describe, expect, it } from 'vitest';
import { __newBridgeForTest, Atom, Computed, effect, type CosignalBridge } from '../src/index.js';

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

/** A fresh registered bridge in referee posture (events retained; quiet arms by the production derivation). */
function bridge(): CosignalBridge {
	const b = __newBridgeForTest();
	b.registerBridge();
	return b;
}

describe('transitive observation through derived nodes', () => {
	it('two watchers sharing one derived node: minted ≠ observed, ONE observe at first liveness, release after the LAST leaves', async () => {
		const b = bridge();
		const { atom, log } = observedAtom(0);
		const node = b.adoptAtom('a', atom as Atom<unknown>);
		const oc = b.computed('oc', (read) => read(node));
		const p1 = b.renderStart('A', []);
		const w1 = b.mountWatcher(p1.id, oc, 'W1');
		await tick();
		expect(log).toEqual([]); // minted, not live: a render alone observes nothing
		b.renderEnd(p1.id, 'commit');
		await tick();
		expect(log).toEqual(['observe']); // the closure atom observes through the derived node
		const p2 = b.renderStart('A', []);
		const w2 = b.mountWatcher(p2.id, oc, 'W2');
		b.renderEnd(p2.id, 'commit');
		await tick();
		expect(log).toEqual(['observe']); // second watcher on the SAME node: interior transition
		w1.live = false;
		await tick();
		expect(log).toEqual(['observe']); // one watcher remains
		w2.live = false;
		await tick();
		expect(log).toEqual(['observe', 'unobserve']);
	});

	it('dep-flip moves the retain to the branch the re-evaluation took; a same-tick flip-flap coalesces', async () => {
		const b = bridge();
		const { atom: atomA, log: logA } = observedAtom(10);
		const { atom: atomB, log: logB } = observedAtom(20);
		const na = b.adoptAtom('a', atomA as Atom<unknown>);
		const nb = b.adoptAtom('b', atomB as Atom<unknown>);
		const flag = b.atom('flag', 1);
		const oc = b.computed('oc', (read) => ((read(flag) as number) ? read(na) : read(nb)));
		const p = b.renderStart('A', []);
		const w = b.mountWatcher(p.id, oc, 'W');
		b.renderEnd(p.id, 'commit');
		await tick();
		expect(logA).toEqual(['observe']); // the taken branch is retained…
		expect(logB).toEqual([]); // …the untaken one is not
		const t = b.openBatch();
		b.write(t.id, flag, 0, 0);
		b.retire(t.id); // durable drain re-evaluates the watched computed
		await tick();
		expect(logA).toEqual(['observe', 'unobserve']); // the retain MOVED with the edge set
		expect(logB).toEqual(['observe']);
		// Flip A→B→A within one tick: the microtask flush nets both shifts out.
		const t2 = b.openBatch();
		b.write(t2.id, flag, 0, 1);
		b.retire(t2.id); // re-eval reads a again (retain a, release b)…
		const t3 = b.openBatch();
		b.write(t3.id, flag, 0, 0);
		b.retire(t3.id); // …and back (retain b, release a), same tick
		await tick();
		expect(logA).toEqual(['observe', 'unobserve']); // no flap
		expect(logB).toEqual(['observe']); // no flap
		w.live = false;
		await tick();
		expect(logB).toEqual(['observe', 'unobserve']);
	});

	it('depth-2 chain retains the leaf atom; removeWatcher releases the whole closure', async () => {
		const b = bridge();
		const { atom, log } = observedAtom(3);
		const na = b.adoptAtom('a', atom as Atom<unknown>);
		const cB = b.computed('cB', (read) => (read(na) as number) * 2);
		const cA = b.computed('cA', (read) => (read(cB) as number) + 1);
		const p = b.renderStart('A', []);
		const w = b.mountWatcher(p.id, cA, 'W');
		b.renderEnd(p.id, 'commit');
		await tick();
		expect(log).toEqual(['observe']); // watcher → cA → cB → atom
		b.removeWatcher(w.id); // the grind-3 unsubscribe surface
		await tick();
		expect(log).toEqual(['observe', 'unobserve']); // the whole closure released in one call
		expect(b.watchers.size).toBe(0);
	});

	it('quiesce: the K1 bulk-reset produces NO unobserve/reobserve flap while a watcher stays live', async () => {
		const b = bridge();
		const { atom, log } = observedAtom(0);
		const na = b.adoptAtom('a', atom as Atom<unknown>);
		const oc = b.computed('oc', (read) => read(na));
		const p = b.renderStart('A', []);
		const w = b.mountWatcher(p.id, oc, 'W');
		b.renderEnd(p.id, 'commit');
		await tick();
		expect(log).toEqual(['observe']);
		const epochBefore = b.epoch;
		b.quiesce(); // episode reset: K1 edges drop, refresh re-records the cone
		expect(b.epoch).toBe(epochBefore + 1); // the reset really ran
		await tick();
		expect(log).toEqual(['observe']); // retains survived the reset — not even a coalesced flap
		w.live = false;
		await tick();
		expect(log).toEqual(['observe', 'unobserve']); // and still release cleanly afterwards
	});

	it('CONTRAST (kernel chain, pre-existing behavior): a K0 computed chain already retains transitively', async () => {
		const { atom, log } = observedAtom(1);
		const kc = new Computed(() => (atom.state as number) + 1);
		const kc2 = new Computed(() => kc.state + 1);
		const dispose = effect(() => {
			void kc2.state;
		});
		await tick();
		expect(log).toEqual(['observe']); // K0 links are structural subscriptions
		dispose();
		await tick();
		expect(log).toEqual(['observe', 'unobserve']);
	});

	it('a computed that THROWS after reading some atoms retains exactly the deps read up to the throw', async () => {
		const b = bridge();
		const { atom: atomA, log: logA } = observedAtom(0);
		const { atom: atomB, log: logB } = observedAtom(0);
		const na = b.adoptAtom('a', atomA as Atom<unknown>);
		const nb = b.adoptAtom('b', atomB as Atom<unknown>);
		const oc = b.computed('oc', (read) => {
			const bv = read(nb) as number; // read FIRST — stays retained through the throw
			if (bv > 0) throw new Error('boom');
			return read(na);
		});
		const p = b.renderStart('A', []);
		const w = b.mountWatcher(p.id, oc, 'W');
		b.renderEnd(p.id, 'commit');
		await tick();
		expect(logA).toEqual(['observe']); // healthy evaluation reads both
		expect(logB).toEqual(['observe']);
		const t = b.openBatch();
		b.write(t.id, nb, 0, 1); // pending write; newest sees it
		expect(() => b.newestValue(oc)).toThrow('boom'); // re-evaluation dies after reading b
		await tick();
		expect(logA).toEqual(['observe', 'unobserve']); // unread past the throw → released
		expect(logB).toEqual(['observe']); // read before the throw → still retained (its K1 edge delivers)
		w.live = false;
		await tick();
		expect(logB).toEqual(['observe', 'unobserve']);
		b.retire(t.id);
	});
});
