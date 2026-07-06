/**
 * NF2 P2.S-C ENTRY GATES (plans/2026-07-06 §4.7/§4.8 — written and proved
 * green against S-B BEFORE any S-C deletion lands):
 *
 *  - M6 world-path retain re-point (§4.7, fable M6 / codex 9): observation
 *    capture fires on EVERY tracked dependency read BEFORE any link
 *    reuse/dedup — including WORLD evaluations through the arena walks
 *    (aUpdateComputed's capture). An observed computed whose committed-world
 *    deps are {A} while its newest deps are {B} (world-divergent flag),
 *    re-evaluated on the COMMITTED path through a drain, must re-point the
 *    observation retains: A gains/holds its retain and B's releases. A
 *    verbatim spike-`wLink` transplant (capture after the reuse cursor's
 *    early return) captures an empty set on unchanged deps and releases
 *    retains while the watcher lives (RCC-OL1 violation) — this pin goes
 *    red on that shape.
 *
 *  - fable N-1 dispose-reuse-read id tenancy (§4.5.3): kernel node records
 *    are free-listed and REUSED; at S-C the computed identity re-keys onto
 *    kernel ids, so a live committed arena outliving a disposed computed
 *    would serve the dead node's value or run the dead node's fn under the
 *    reused id. The GEN discipline (shadow stamps validated against the
 *    node's current generation; a dead-GEN shadow never serves — evict,
 *    refold cold under the new tenant) is what makes the re-key sound.
 *    Against S-B the reuse is forced through the id-tenancy seam (overlay
 *    ids are never freed pre-S-C); the schedule asserts the dead tenancy's
 *    CACHED VALUE never serves and the refold runs the CURRENT fn cold.
 */
import { describe, expect, it } from 'vitest';
import { __newBridgeForTest, type AnyNode, type CosignalBridge } from '../src/concurrent.js';
import { Atom } from '../src/index.js';

const tick = (): Promise<void> => new Promise<void>((res) => queueMicrotask(res));

function bridge(): CosignalBridge {
	const b = __newBridgeForTest();
	b.registerBridge();
	b.__setArenaCheck(true); // armed: arena serves ≡ fold truth at every epilogue
	return b;
}

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

function mount(b: CosignalBridge, root: string, node: AnyNode, name: string) {
	const p = b.passStart(root, []);
	const w = b.mountWatcher(p.id, node, name);
	b.passEnd(p.id, 'commit');
	return w;
}

function commitWrite(b: CosignalBridge, node: AnyNode, value: unknown): void {
	const t = b.openBatch();
	b.write(t.id, node as never, { kind: 'set', value });
	b.retire(t.id, true);
}

describe('S-C entry gate 1 — M6 world-path observation retain re-point (§4.7)', () => {
	it('committed re-evaluation THROUGH A DRAIN re-points retains at the committed run\'s deps: A gains/holds, B releases', async () => {
		const b = bridge();
		const { atom: atomA, log: logA } = observedAtom(10);
		const { atom: atomB, log: logB } = observedAtom(20);
		const nA = b.adoptAtom('A', atomA as Atom<unknown>);
		const nB = b.adoptAtom('B', atomB as Atom<unknown>);
		const flag = b.atom('flag', 0);
		// World-divergent deps: flag=0 → {flag, A}; flag=1 → {flag, B}.
		const oc = b.computed('oc', (read) => ((read(flag) as number) ? read(nB) : read(nA)));
		const w = mount(b, 'R', oc, 'W');
		expect(w.lastRenderedValue).toBe(10);
		await tick();
		expect(logA).toEqual(['observe']); // liveness discovery took the flag=0 branch
		expect(logB).toEqual([]);

		// Divergence: a LIVE (unretired) batch flips the flag — newest sees
		// flag=1, committed-for-R keeps flag=0. A newest evaluation re-points
		// the observed closure at the NEWEST deps {flag, B}.
		const t1 = b.openBatch();
		b.write(t1.id, flag, { kind: 'set', value: 1 });
		expect(b.newestValue(oc)).toBe(20);
		await tick();
		expect(logA).toEqual(['observe', 'unobserve']);
		expect(logB).toEqual(['observe']); // retains now follow the newest run

		// THE GATE: committed truth moves (write A, retire) → the durable
		// drain re-evaluates oc on the WORLD path (arena refold). The capture
		// must ride that evaluation: A regains its retain, B's releases —
		// even though the arena's link set for oc is UNCHANGED ({flag, A}),
		// i.e. every wLink call takes the in-place reuse fast path. A
		// post-dedup capture would see nothing and strand the retains on B.
		commitWrite(b, nA, 11);
		expect(w.lastRenderedValue).toBe(11); // the drain corrected the watcher
		await tick();
		expect(logA).toEqual(['observe', 'unobserve', 'observe']); // A re-retained by the WORLD path
		expect(logB).toEqual(['observe', 'unobserve']); // B released while the watcher lives on A
		expect(b.committedValue(oc, 'R')).toBe(11);
	});
});

describe('S-C entry gate 2 — N-1 dispose-reuse-read id tenancy (§4.5.3)', () => {
	it('a dead-GEN shadow under a live committed arena never serves: cold refold under the new tenant, never the dead value/fn', () => {
		const b = bridge();
		const a = b.atom('a', 5);
		let evals = 0;
		const c = b.computed('c', (read) => {
			evals++;
			return (read(a) as number) * 2;
		});
		mount(b, 'R', c, 'W');
		expect(b.committedValue(c, 'R')).toBe(10);
		const evalsBefore = evals;

		// Dispose-reuse analog (§4.5.3: pre-S-C overlay ids never free, so the
		// seam forces the generation move the kernel free list will perform;
		// at S-C the same pin is driven by real kernel id reuse).
		b.__bumpNodeGenForTest(c.id);

		// Read WITHOUT any committed-truth motion: the shadow still holds the
		// old tenancy's cached value 10 and no mark is pending — only the GEN
		// stamp says it may not serve. The read must refold COLD (the fn runs
		// again), never serve the dead tenancy's cached 10 silently.
		expect(b.committedValue(c, 'R')).toBe(10);
		expect(evals).toBeGreaterThan(evalsBefore); // refolded — did not serve the dead shadow
		expect(b.__arenaLinkMode('R', a, c)).toBe('strong'); // re-tenanted: links re-recorded under the new GEN

		// And the re-tenanted shadow routes: a committed write reaches the cone.
		commitWrite(b, a, 6);
		expect(b.committedValue(c, 'R')).toBe(12);
	});
});
