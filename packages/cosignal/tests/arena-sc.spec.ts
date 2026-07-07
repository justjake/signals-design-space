/**
 * NF2 P2.S-C ENTRY GATES (plans/2026-07-06 §4.7/§4.8 — written and proved
 * green against S-B BEFORE any S-C deletion lands):
 *
 *  - M6 world-path retain re-point (§4.7, fable M6 / codex 9): observation
 *    capture fires on EVERY tracked dependency read BEFORE any link
 *    reuse/dedup — including WORLD evaluations through the arena walks
 *    (arenaUpdateComputed's capture). An observed computed whose committed-world
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
import { engine, __resetEngineForTest, type AnyNode, type CosignalEngine } from '../src/concurrent.js';
import { armArenaCheck } from './arena-checker.js';
import { Atom, Computed, effect } from '../src/index.js';

const tick = (): Promise<void> => new Promise<void>((res) => queueMicrotask(res));

function bridge(): CosignalEngine {
	// Finish the previous test's leftover episode so the reset's idle preconditions hold.
	engine.discardAllWip();
	for (const t of engine.liveBatches()) {
		if (t.parked) engine.settleAction(t.id);
		else engine.retire(t.id);
	}
	__resetEngineForTest();
	const b = engine;
	armArenaCheck(b); // armed: arena serves ≡ fold truth at every epilogue
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

function mount(b: CosignalEngine, root: string, node: AnyNode, name: string) {
	const p = b.renderStart(root, []);
	const w = b.mountWatcher(p.id, node, name);
	b.renderEnd(p.id, 'commit');
	return w;
}

function commitWrite(b: CosignalEngine, node: AnyNode, value: unknown): void {
	const t = b.openBatch();
	b.write(t.id, node as never, 0, value);
	b.retire(t.id);
}

describe('S-C entry gate 1 — M6 world-path observation retain re-point (§4.7)', () => {
	it('committed re-evaluation THROUGH A DRAIN re-points retains at the committed run\'s deps: A gains/holds, B releases', async () => {
		const b = bridge();
		const { atom: atomA, log: logA } = observedAtom(10);
		const { atom: atomB, log: logB } = observedAtom(20);
		const nA = b.nodeForAtom(atomA as Atom<unknown>);
		nA.name = 'A';
		const nB = b.nodeForAtom(atomB as Atom<unknown>);
		nB.name = 'B';
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
		b.write(t1.id, flag, 0, 1);
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

describe('S-C — N-1 REAL-REUSE leg (§4.5.3): a disposed computed\'s kernel id, reused by a new tenant, never serves the dead value/fn/comparator', () => {
	it('dispose → kernel id reuse → reads run the NEW tenant cold; the dead fn and dead comparator never run again', () => {
		const b = bridge();
		const a = b.atom('a', 5);
		let oldEvals = 0;
		let oldCompares = 0;
		const cOld = b.computed('cOld', (read) => {
			oldEvals++;
			return (read(a) as number) * 2;
		}, (p, n) => {
			oldCompares++;
			return Object.is(p, n);
		});
		const w1 = mount(b, 'R', cOld, 'W1');
		expect(b.committedValue(cOld, 'R')).toBe(10);
		const oldKernelId = cOld.handle._id;
		const oldEvalsAtDispose = oldEvals;
		const oldComparesAtDispose = oldCompares;

		// Supersede: the watcher re-keys first (the hooks' discipline; dispose
		// throws on live watchers), then the kernel record frees — its id
		// joins the free list at the operation boundary inside the call.
		b.removeWatcher(w1.id);
		b.disposeComputed(cOld.handle);

		// REAL reuse: the next kernel computed allocation takes the freed id.
		let newEvals = 0;
		const cNew = b.computed('cNew', (read) => {
			newEvals++;
			return (read(a) as number) + 1000;
		});
		expect(cNew.handle._id).toBe(oldKernelId); // the free-list handed the id to the new tenant

		// Reads under a live committed arena: the NEW tenant folds cold —
		// never the dead node's cached 10, fn, or comparator.
		mount(b, 'R', cNew, 'W2');
		expect(b.committedValue(cNew, 'R')).toBe(1005);
		expect(newEvals).toBeGreaterThan(0);
		expect(b.newestValue(cNew)).toBe(1005); // kernel serving under the reused id: the new tenant's fn
		expect(oldEvals).toBe(oldEvalsAtDispose); // the dead fn never ran again
		expect(oldCompares).toBe(oldComparesAtDispose); // the dead comparator never ran again
		expect(b.__arenaLinkMode('R', a, cNew)).toBe('strong'); // re-tenanted links under the new bridge id

		// And the new tenancy routes: a committed write reaches the cone.
		commitWrite(b, a, 6);
		expect(b.committedValue(cNew, 'R')).toBe(1006);
		expect(b.newestValue(cNew)).toBe(1006);
	});
});

describe('S-C — §4.5.3 per-world equality record (custom-equality computeds under arenas)', () => {
	it('comparator-order pin: a deliberately NON-SYMMETRIC comparator runs in HEAD\'s isEqual(prev, next) order at every arena compare site', () => {
		const b = bridge();
		const x = b.atom('x', 2);
		// isEqual(prev, next) = next <= prev: with prev=2, next=1 this is EQUAL
		// at HEAD (no change); the FLIPPED order would report a change and
		// regress the world to 1 (§4.5.3, codex checklist 6).
		const orders: string[] = [];
		const cMono = b.computed('cMono', (read) => read(x), (p, n) => {
			orders.push(`eq(${String(p)},${String(n)})`);
			return (n as number) <= (p as number);
		});
		mount(b, 'R', cMono, 'W');
		expect(b.committedValue(cMono, 'R')).toBe(2);
		commitWrite(b, x, 1); // next=1 vs prev=2: EQUAL under HEAD order → the world KEEPS 2
		expect(b.committedValue(cMono, 'R')).toBe(2);
		expect(orders).toContain('eq(2,1)'); // the arena compare ran (prev, next) — never (next, prev)
		expect(orders).not.toContain('eq(1,2)');
		commitWrite(b, x, 5); // next=5 vs prev=2: changed → the world moves
		expect(b.committedValue(cMono, 'R')).toBe(5);
		expect(b.newestValue(cMono)).toBe(5); // kernel wrapper agrees (same HEAD order)
	});

	it('codex 6\'s reference-preservation shape in THREE arenas at once: each arena keeps ITS OWN previous reference on an equal refold — never the kernel\'s', () => {
		const b = bridge();
		const x = b.atom('x', 1);
		const y = b.atom('y', 0); // the refold driver: marks cArr without moving [x]
		const cArr = b.computed('cArr', (read) => {
			read(y);
			return [read(x)];
		}, (p, n) => (p as number[])[0] === (n as number[])[0]);
		// Three arenas: committed R1, committed R2, and an open render on R3.
		mount(b, 'R1', cArr, 'W1');
		mount(b, 'R2', cArr, 'W2');
		const ref1 = b.committedValue(cArr, 'R1');
		const ref2 = b.committedValue(cArr, 'R2');
		const p3 = b.renderStart('R3', []);
		const ref3 = b.renderValue(cArr, p3);
		expect(ref1).toEqual([1]);
		// Distinct evaluations per arena: three distinct references.
		expect(ref1 === ref2).toBe(false);
		// Drive a refold that the comparator calls EQUAL ([x] unchanged): every
		// arena must serve ITS previous reference — identity-stable per world.
		commitWrite(b, y, 1);
		expect(b.committedValue(cArr, 'R1')).toBe(ref1);
		expect(b.committedValue(cArr, 'R2')).toBe(ref2);
		expect(b.renderValue(cArr, p3)).toBe(ref3); // the pin kept y=0; the render serves its own cached reference
		b.renderEnd(p3.id, 'discard');
		// A REAL change moves every committed world to a fresh reference.
		commitWrite(b, x, 9);
		const next1 = b.committedValue(cArr, 'R1');
		expect(next1).toEqual([9]);
		expect(next1 === ref1).toBe(false);
	});

	it('equality never bridges an exceptional boundary: value→box and box→value are CHANGES even under an always-equal comparator (which still gates value→value)', () => {
		const b = bridge();
		const gate = b.atom('gate', 0);
		// Pathological comparator: EVERYTHING is "equal". If equality could
		// bridge an exceptional boundary, the box below would never serve (or
		// never clear); if it gated value→value, the world would freeze at
		// its first value — both arms pinned here.
		const cBoom = b.computed('cBoom', (read) => {
			const g = read(gate) as number;
			if (g === 1) throw new Error('boom');
			return 100 + g;
		}, () => true);
		b.root('R'); // materialize the committed arena without a watcher
		expect(b.committedValue(cBoom, 'R')).toBe(100);
		commitWrite(b, gate, 1); // value → box: a CHANGE — the thrown payload caches and rethrows
		expect(() => b.committedValue(cBoom, 'R')).toThrow('boom');
		commitWrite(b, gate, 2); // box → value: a CHANGE — prevValid is false, the comparator never sees the box
		expect(b.committedValue(cBoom, 'R')).toBe(102);
		commitWrite(b, gate, 3); // value → value: the comparator gates — the world KEEPS 102
		expect(b.committedValue(cBoom, 'R')).toBe(102);
	});
});

describe('§4.9.1 hang schedule — kernel computeds under worlds via arena frames (ported from research/experiments/world-tagged-links-spike-code/tests/hang.spec.ts; pinned GREEN at S-C)', () => {
	it('dep-flipping kernel computeds evaluated under two divergent worlds, deliveries and mid-eval kernel propagation interleaved, then the unwatched-dispose cascade: terminates, per-world correct, kernel sound', () => {
		const b = bridge();
		// The NF2 graph: c = (flag ? a : bb) + 1 through a middle computed —
		// REAL kernel Computed records, watched by a kernel effect so the
		// unwatched/dispose cascades engage (the historical hang site: world
		// evaluations hosted on kernel records left cross-world link cycles
		// the dispose walk could not traverse — see the spike's RED half).
		const flag = new Atom<unknown>(true);
		const a = new Atom<unknown>(10);
		const bb = new Atom<unknown>(20);
		const m = new Computed<number>(() => (flag.state ? a.state : bb.state) as number);
		const c = new Computed<number>(() => m.state + 1);
		const seen: number[] = [];
		const disposeEff = effect(() => {
			seen.push(c.state);
		});
		expect(seen).toEqual([11]); // newest: flag=true → a=10 → 11
		const nFlag = b.nodeForAtom(flag);
		nFlag.name = 'flag';
		b.nodeForAtom(a).name = 'a';
		b.nodeForAtom(bb).name = 'bb';
		const nC = b.nodeForComputed(c as Computed<unknown>);
		nC.name = 'c';

		// Two worlds with DIFFERENT flag values (the dep flip): w1 = the render
		// world of a live batch writing flag=false; w2 = the committed world
		// of root R2 (flag=true — the batch is not committed there).
		const t1 = b.openBatch();
		b.write(t1.id, nFlag, 0, false); // NEWEST sees it eagerly (unlike the spike's world-LOCAL override)
		expect(seen[seen.length - 1]).toBe(21); // kernel effect heard the eager apply: flag=false → bb → 21
		const p1 = b.renderStart('R1', [t1.id]);
		b.root('R2'); // materialize the committed arena
		expect(b.renderValue(nC, p1)).toBe(21); // w1: flag=false → bb=20 → 21 (deps diverge per world)
		expect(b.committedValue(nC, 'R2')).toBe(11); // w2: t1 uncommitted → flag=true → a=10 → 11

		// DELIVERY mid-schedule: a committed write while both worlds hold live
		// arena links. w2 folds it; newest is on the bb branch (kernel links
		// exclude a — the write is delivery-silent there); w1's pin excludes it.
		const t2 = b.openBatch();
		b.write(t2.id, b.nodeForAtom(a), 0, 100);
		b.retire(t2.id);
		expect(seen).toEqual([11, 21]); // no newest re-run: a is off m's newest dep set (the ruling's tracked-only rule)
		expect(b.committedValue(nC, 'R2')).toBe(101); // w2: flag=true (no t1) → a=100 → 101
		expect(b.renderValue(nC, p1)).toBe(21); // pin: the paused render never drifts

		// Writes INSIDE a world evaluation (the spike's mid-walk interleave,
		// RE-PINNED for always-concurrent): the old tolerance — "a write to
		// an atom the engine doesn't know takes the plain kernel path even
		// mid-world-eval" — died with the registration era (a handle exists
		// ⟺ the engine can resolve it, so with the pipeline armed the write
		// classifies and hits the render-purity guard). The pinned truth now:
		// the write THROWS and leaves nothing behind. The throwing node is
		// DISPOSED after the pin (its boxed throw would otherwise sit in the
		// render arena as a stale outcome no world can invalidate — the
		// armed checker rightly refuses impure fns), and the dep-flip
		// evaluation continues on a well-behaved twin.
		const poker = new Atom(0);
		const pokerSeen: number[] = [];
		const disposePoker = effect(() => {
			pokerSeen.push(poker.state as number);
		});
		const pokerWriter = new Computed<number>(() => {
			poker.set((flag.state ? a.state : bb.state) as number); // a write during the world evaluation
			return 0;
		});
		const nPokerWriter = b.nodeForComputed(pokerWriter as Computed<unknown>);
		nPokerWriter.name = 'pokerWriter';
		expect(() => b.renderValue(nPokerWriter, p1)).toThrow(/write during a world evaluation/); // render purity, era-free
		expect(pokerSeen).toEqual([0]); // the rejected write left nothing behind
		b.disposeComputed(pokerWriter as Computed<unknown>); // purge the boxed throw from every arena
		const noisy = new Computed<number>(() => (flag.state ? a.state : bb.state) as number);
		const nNoisy = b.nodeForComputed(noisy as Computed<unknown>);
		nNoisy.name = 'noisy';
		expect(b.renderValue(nNoisy, p1)).toBe(20); // w1: flag=false → bb
		expect(b.committedValue(nNoisy, 'R2')).toBe(100); // w2: flag=true → a=100
		expect(noisy.state).toBe(20); // newest evaluation, kernel path (newest flag=false → bb)

		// Kernel dep flip UNDER live worlds: newest re-track while world links live.
		const t3 = b.openBatch();
		b.write(t3.id, nFlag, 0, false);
		b.retire(t3.id);
		expect(seen[seen.length - 1]).toBe(21); // newest: m → {flag, bb} (re-tracked at the earlier flip)
		expect(b.committedValue(nC, 'R2')).toBe(21); // w2 folds the retired flip: flag=false → bb → 21
		expect(b.renderValue(nC, p1)).toBe(21);

		// DISPOSAL: the NF2 hang site — the kernel's unwatched cascade
		// (disposeAllDepsInReverse) runs while the arenas still hold m/c
		// shadows and links. Kernel links and arena links are SEPARATE planes
		// since NF2 — the cascade terminates (this test completing IS the
		// regression pin) and both planes stay functional.
		disposeEff();
		disposePoker();
		const t4 = b.openBatch();
		b.write(t4.id, b.nodeForAtom(a), 0, 7);
		b.write(t4.id, nFlag, 0, true);
		b.retire(t4.id);
		expect(c.state).toBe(8); // kernel fully functional after dispose (lazy re-eval)
		expect(b.committedValue(nC, 'R2')).toBe(8); // worlds correct after the cascade
		expect(b.renderValue(nC, p1)).toBe(21); // the pinned render STILL never drifts
		b.renderEnd(p1.id, 'discard');
		b.retire(t1.id);
		// Zero-world sync semantics intact after everything.
		const t5 = b.openBatch();
		b.write(t5.id, b.nodeForAtom(bb), 0, 99);
		b.write(t5.id, nFlag, 0, false);
		b.retire(t5.id);
		expect(c.state).toBe(100);
		expect(b.newestValue(nC)).toBe(100);
	});
});
