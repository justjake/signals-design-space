/**
 * The engine's 17-case acceptance battery, re-run at the React level
 * through the public bindings against a real protocol-v1 React build:
 * every case whose React-visible semantics application code can exercise,
 * case numbers cited in test names. Not exercisable here (documented):
 *  - case 7 (yield-gap writes) — needs deterministic time-slicing control;
 *    pinned by the patched React build's own tests and the engine suite.
 *  - case 9 rows c/d (foreign retirement / post-pin write IN the
 *    render→commit window) and case 10 races (i)/(ii) — sub-millisecond
 *    windows the public API cannot schedule; the reference-model and
 *    patched-React suites pin them. Rows a/e and the batch-join path (a
 *    mount's corrective re-render scheduled into a live batch's own lane)
 *    are covered below.
 *  - case 13 rows 6-9 (counter wrap/horizon) — engine counters; the
 *    quiescence/epoch half is smoke-tested below.
 */
import { describe, expect, test, afterEach } from 'vitest';
import * as React from 'react';
import { flushSync } from 'react-dom';
import { Atom, ReducerAtom, SuspendedRead, effect, type AtomNode } from 'cosignal';
import * as CosignalReact from '../src/index.js';
import { useSignal, useComputed, useSignalEffect, startSignalTransition } from '../src/index.js';
import { makeHarness, act, text, deferred, type Harness } from './helpers.js';

let h: Harness;
afterEach(async () => {
	await h.cleanup();
});

function Reader({ id, atom }: { id: string; atom: Atom<number> }) {
	return (
		<span>
			{id}:{useSignal(atom)};
		</span>
	);
}

describe('battery (spec §6) at React level', () => {
	test('case 1 — world-divergent dependency: committed vs newest stay distinct until commit', async () => {
		h = makeHarness();
		const a = new Atom(1);
		const gate = deferred<void>();
		function Suspender() {
			const v = useSignal(a);
			if (v > 1 && gate.settled !== true) throw gate.promise;
			return <span>s:{v};</span>;
		}
		function App() {
			const c = useComputed<number>(() => (a.state as number) * 10, []);
			return (
				<>
					<span>c:{useSignal(c)};</span>
					<React.Suspense fallback={null}>
						<Suspender />
					</React.Suspense>
				</>
			);
		}
		const { container } = await h.mount(<App />);
		expect(text(container)).toBe('c:10;s:1;');
		await act(async () => {
			React.startTransition(() => a.set(2));
		});
		// Divergence window: committed world (and the DOM) hold the old value
		// while the newest world already folded the pending write.
		expect(text(container)).toBe('c:10;s:1;');
		const node = h.bridge.byKernelId.get(a._id) as AtomNode;
		expect(h.bridge.newestValue(node)).toBe(2);
		gate.settled = true;
		await act(async () => {
			gate.resolve();
		});
		expect(text(container)).toBe('c:20;s:2;');
	});

	test('case 2 — flushSync excludes a pending batch (always-log premise)', async () => {
		// NOTE: this React generation ties the Default lane to the Sync lane so
		// they render together (React calls this lane "entanglement"; unified
		// sync lane), so a DEFAULT batch cannot stay pending across flushSync at the
		// React level — verified empirically; the default-priority exclusion
		// schedule is pinned engine-side (cosignal concurrent-battery). The
		// React-reachable exclusion window is a DEFERRED batch, exercised here
		// with case 2's real payload: the excluded write is logged (a receipt
		// exists despite producing no React work yet) and folds later.
		h = makeHarness();
		const a = new Atom(0);
		const b = new Atom(0);
		const { container } = await h.mount(
			<>
				<Reader id="a" atom={a} />
				<Reader id="b" atom={b} />
			</>,
		);
		let mid = '';
		await act(async () => {
			React.startTransition(() => a.set(1)); // pending deferred batch
			flushSync(() => b.set(2)); // urgent synchronous commit excludes it
			mid = text(container);
			// Always-log: the excluded write already holds a receipt.
			const node = h.bridge.byKernelId.get(a._id) as AtomNode;
			expect(node.tp.length).toBe(1);
		});
		expect(mid).toBe('a:0;b:2;');
		await act(async () => {});
		expect(text(container)).toBe('a:1;b:2;'); // the excluded batch folded
	});

	test('case 3 — rebase parity: reducer replay matches React updater-queue arithmetic', async () => {
		h = makeHarness();
		const r = new ReducerAtom((s: string, x: string) => s + x, '');
		function View() {
			return <span>{useSignal(r) || 'empty'}</span>;
		}
		const { container } = await h.mount(<View />);
		await act(async () => {
			React.startTransition(() => r.dispatch('T'));
			flushSync(() => r.dispatch('U'));
			// The urgent world excludes the pending transition dispatch: U alone
			// (React renders the urgent update over base, skipping T's lane).
			expect(text(container)).toBe('U');
		});
		await act(async () => {});
		// The transition commit replays the WHOLE op sequence in seq order —
		// exactly React's rebase arithmetic for a transition queued before an
		// urgent update (T then U), not a lost or reordered fold.
		expect(text(container)).toBe('TU');
	});

	test('case 4 — two batches writing one atom: both fold, order by sequence, retire once each', async () => {
		h = makeHarness();
		const a = new Atom(0);
		const { container } = await h.mount(<Reader id="a" atom={a} />);
		await act(async () => {
			React.startTransition(() => a.set(1));
			React.startTransition(() => a.set(2));
		});
		await act(async () => {});
		expect(text(container)).toBe('a:2;');
		const retired = h.events.eventsOfType('retired');
		const byBatch = new Map<number, number>();
		for (const e of retired) byBatch.set(e.batch, (byBatch.get(e.batch) ?? 0) + 1);
		for (const [, count] of byBatch) expect(count).toBe(1); // exactly once per batch
		// React's committed/abandoned report is recorded AT ITS SOURCE (the
		// shim's protocol handler) as a batch-disposition trace record — the
		// engine's retirement is disposition-blind. Both transitions here
		// reached the screen, so every report says committed, and every report
		// names a batch that then retired. (The ambient batch, which no
		// protocol report ever names, correctly mints none.)
		const dispositions = h.events.tracer.events('batch-disposition');
		expect(dispositions.length).toBeGreaterThan(0);
		for (const d of dispositions) {
			expect(d.data['committed']).toBe(true);
			expect(byBatch.has(d.data['batch'] as number)).toBe(true);
		}
	});

	test('case 5 — cutoff-suppressed first write, effective second write (same batch)', async () => {
		h = makeHarness();
		const a = new Atom(10, { isEqual: (x, y) => x === y });
		const { container } = await h.mount(<Reader id="a" atom={a} />);
		await act(async () => {
			a.set(10); // equal write against an atom with no history: dropped entirely
			a.set(11); // effective
		});
		expect(text(container)).toBe('a:11;');
		expect(h.events.eventsOfType('write-dropped').length).toBe(1);
		expect(h.events.eventsOfType('write').length).toBeGreaterThanOrEqual(1);
	});

	test('case 6 — grouped writes in one handler: per-write receipts, one commit, consistent lane', async () => {
		h = makeHarness();
		const a = new Atom(0);
		const b = new Atom(0);
		let renders = 0;
		function Both() {
			renders++;
			return (
				<span>
					{useSignal(a)},{useSignal(b)}
				</span>
			);
		}
		const { container } = await h.mount(
			<button
				onClick={() => {
					a.set(1);
					b.set(2);
				}}
			>
				<Both />
			</button>,
		);
		const before = renders;
		await act(async () => {
			container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		});
		expect(text(container)).toBe('1,2');
		expect(renders).toBe(before + 1); // one commit for the event's writes
		// Both writes carry batch attribution (receipts with batches), no grouping
		// machinery anywhere: two write events, each with a batch.
		const writes = h.events.eventsOfType('write');
		expect(writes.length).toBe(2);
		for (const w of writes) expect(w.batch).toBeGreaterThan(0);
	});

	test('case 8 — equality drops never lose receipts once history exists', async () => {
		h = makeHarness();
		const a = new Atom(0, { isEqual: (x, y) => x === y });
		const { container } = await h.mount(<Reader id="a" atom={a} />);
		await act(async () => {
			React.startTransition(() => a.set(5)); // pending deferred receipt
			// Equal to the PENDING newest value — but history is non-empty, so
			// the receipt must be kept (the equality drop applies only to an
			// atom with an empty tape): without it the urgent world (which
			// excludes the transition) would still show 0.
			flushSync(() => a.set(5));
			expect(text(container)).toBe('a:5;'); // the urgent receipt rendered
		});
		await act(async () => {});
		expect(text(container)).toBe('a:5;');
		const node = h.bridge.byKernelId.get(a._id) as AtomNode;
		// Both writes held receipts (the retained referee event log counts
		// them; the receipts themselves compacted into base at retirement).
		expect(h.events.eventsOfType('write').filter((e) => e.node === node.name).length).toBe(2);
	});

	test('case 9(a) — mount inside the batch pass: k-world value on FIRST render, no correction', async () => {
		h = makeHarness();
		const a = new Atom(0);
		let freshRenders = 0;
		function Fresh() {
			freshRenders++;
			return <span>f:{useSignal(a)};</span>;
		}
		let setShow: (b: boolean) => void = () => {};
		function App() {
			const [show, s] = React.useState(false);
			setShow = s;
			return (
				<>
					<Reader id="r1" atom={a} />
					{show ? <Fresh /> : null}
				</>
			);
		}
		const { container } = await h.mount(<App />);
		await act(async () => {
			React.startTransition(() => {
				a.set(1);
				setShow(true); // Fresh mounts inside k's own pass
			});
		});
		expect(text(container)).toBe('r1:1;f:1;'); // k-world value on first render
		expect(freshRenders).toBe(1); // no double render for the included batch
		expect(h.events.eventsOfType('mount-urgent-correction').length).toBe(0);
		expect(h.events.eventsOfType('mount-corrective').length).toBe(0); // fully included: skipped
	});

	test('case 9(e) — Offscreen/Activity reveal takes the conservative compare and shows fresh truth', async () => {
		h = makeHarness();
		const a = new Atom(1);
		const Activity = (React as unknown as Record<string, unknown>).Activity as React.ComponentType<{
			mode: 'visible' | 'hidden';
			children?: React.ReactNode;
		}>;
		expect(Activity).toBeDefined();
		function App({ mode }: { mode: 'visible' | 'hidden' }) {
			return (
				<>
					<Reader id="out" atom={a} />
					<Activity mode={mode}>
						<Reader id="in" atom={a} />
					</Activity>
				</>
			);
		}
		const { root, container } = await h.mount(<App mode="visible" />);
		expect(text(container)).toBe('out:1;in:1;');
		await act(async () => {
			root.render(<App mode="hidden" />);
		});
		await act(async () => {
			a.set(2); // truth moves while the subtree is hidden
		});
		expect(text(container)).toContain('out:2;');
		await act(async () => {
			root.render(<App mode="visible" />); // reveal
		});
		await act(async () => {}); // debounce/fixup settle
		expect(text(container)).toBe('out:2;in:2;'); // no stale reveal
		await act(async () => {
			a.set(3); // the revealed subscription is live again
		});
		expect(text(container)).toBe('out:3;in:3;');
	});

	test('case 10 — late subscriber joins the pending batch: exactly one commit carries k', async () => {
		h = makeHarness();
		const a = new Atom(0);
		function App({ extra }: { extra: boolean }) {
			return (
				<>
					<Reader id="r1" atom={a} />
					{extra ? <Reader id="r2" atom={a} /> : null}
				</>
			);
		}
		const { root, container } = await h.mount(<App extra={false} />);
		await act(async () => {
			React.startTransition(() => a.set(1)); // k, pending
			flushSync(() => root.render(<App extra />)); // W mounts excluding k
			expect(text(container)).toBe('r1:0;r2:0;'); // committed world rendered
		});
		await act(async () => {});
		expect(text(container)).toBe('r1:1;r2:1;');
		const k = h.events.eventsOfType('write')[0]!.batch;
		// The corrective re-render rode k's own lane — k committed exactly
		// once on this root (a fresh transition would have produced a second).
		const kCommits = h.events.eventsOfType('per-root-commit').filter((e) => e.batch === k);
		expect(kCommits.length).toBe(1);
		expect(h.events.eventsOfType('retired').filter((e) => e.batch === k).length).toBe(1);
	});

	test('case 11 — one batch spanning two roots: per-root commits, one retirement, no cross-root contradiction', async () => {
		h = makeHarness();
		const a = new Atom(0);
		const one = await h.mount(<Reader id="one" atom={a} />);
		const two = await h.mount(<Reader id="two" atom={a} />);
		await act(async () => {
			React.startTransition(() => a.set(4)); // spans both roots
		});
		await act(async () => {});
		expect(text(one.container)).toBe('one:4;');
		expect(text(two.container)).toBe('two:4;');
		const k = h.events.eventsOfType('write')[0]!.batch;
		const roots = new Set(h.events.eventsOfType('per-root-commit').filter((e) => e.batch === k).map((e) => e.root));
		expect(roots.size).toBe(2); // each root's commit reported separately
		expect(h.events.eventsOfType('retired').filter((e) => e.batch === k).length).toBe(1); // exactly once
	});

	test('case 12 — store-only transition persists (an abandoned batch folds identically)', async () => {
		h = makeHarness();
		const shown = new Atom(0);
		const orphan = new Atom(0); // never read by any component
		const { container } = await h.mount(<Reader id="s" atom={shown} />);
		await act(async () => {
			React.startTransition(() => orphan.set(5)); // no React work at all
		});
		await act(async () => {});
		// The batch retired through the same disposition-blind path: fold
		// happened. React's "abandoned" report survives only as the shim's
		// source-minted batch-disposition record — pin it with the right value.
		const orphanNode = h.bridge.byKernelId.get(orphan._id)!;
		expect(h.events.eventsOfType('retired').length).toBeGreaterThan(0);
		const dispositions = h.events.tracer.events('batch-disposition');
		expect(dispositions.some((d) => d.data['committed'] === false)).toBe(true);
		expect(h.bridge.committedValue(orphanNode, 'root-1')).toBe(5); // persistence
		expect(text(container)).toBe('s:0;'); // untouched subscriber unaffected
	});

	test('case 13 — quiescence renumbers and the app keeps working (epoch smoke)', async () => {
		h = makeHarness();
		const a = new Atom(0);
		const { container } = await h.mount(<Reader id="a" atom={a} />);
		await act(async () => {
			a.set(1);
			React.startTransition(() => a.set(2));
		});
		await act(async () => {});
		expect(text(container)).toBe('a:2;');
		expect(h.bridge.quiescent()).toBe(true); // everything retired
		h.bridge.quiesce(); // bumps the epoch and renumbers the counters
		expect(h.events.eventsOfType('epoch-reset').length).toBe(1);
		await act(async () => {
			a.set(3); // life continues in the new episode
		});
		expect(text(container)).toBe('a:3;');
	});

	test('case 14 — StrictMode: replayed renders reuse the committed useComputed node (rows 4/5)', async () => {
		h = makeHarness();
		const a = new Atom(1);
		const committedNodeIds: number[] = [];
		function View({ dep }: { dep: number }) {
			const c = useComputed<number>(() => (a.state as number) + dep, [dep]);
			React.useEffect(() => {
				committedNodeIds.push(c._id); // the committed render's node (S-C: the kernel record id IS the node identity)
			});
			return <span>{useSignal(c)}</span>;
		}
		const { root, container } = await h.mount(
			<React.StrictMode>
				<View dep={100} />
			</React.StrictMode>,
		);
		expect(text(container)).toBe('101');
		await act(async () => {
			root.render(
				<React.StrictMode>
					<View dep={100} />
				</React.StrictMode>,
			);
		});
		// Equal deps across renders (and across StrictMode double-invokes): the
		// committed node identity is stable.
		expect(new Set(committedNodeIds).size).toBe(1);
		await act(async () => {
			root.render(
				<React.StrictMode>
					<View dep={200} />
				</React.StrictMode>,
			);
		});
		expect(text(container)).toBe('201');
		expect(new Set(committedNodeIds).size).toBe(2); // changed deps: fresh node
	});

	test('case 15 — Suspense across worlds: node-scoped keyed cache, cross-key isolation, no refetch livelock (rows 2/3)', async () => {
		h = makeHarness();
		const q = new Atom('q1');
		let fetches = 0;
		const gates: Record<string, ReturnType<typeof deferred<string>>> = {
			q1: deferred<string>(),
			q2: deferred<string>(),
		};
		const fetchLike = (query: string): Promise<string> => {
			fetches++;
			return gates[query]!.promise;
		};
		function Show({ id, data }: { id: string; data: { state: string } }) {
			return (
				<span>
					{id}:{useSignal(data as never)};
				</span>
			);
		}
		function App({ two }: { two: boolean }) {
			// The key carries the world-varying input (the query): each world
			// resolves its own entry in the LIVING node's per-key cache.
			const data = useComputed<string>((ctx) => {
				const query = q.state as string;
				return ctx.use(['fetch', query], () => fetchLike(query));
			}, []);
			return (
				<React.Suspense fallback={<span>fb;</span>}>
					<Show id="one" data={data} />
					{two ? <Show id="two" data={data} /> : null}
				</React.Suspense>
			);
		}
		const { root, container } = await h.mount(<App two={false} />);
		expect(text(container)).toBe('fb;'); // suspended on the q1 entry
		expect(fetches).toBe(1);
		await act(async () => {
			gates.q1!.resolve('DATA1');
		});
		expect(text(container)).toBe('one:DATA1;');
		// App (the node's owner) lives OUTSIDE the Suspense boundary, so the
		// node — and its keyed cache — survived the discarded child attempt:
		// the retry replays the same q1 entry. (Contrast case 15b, where the
		// owner itself dies with the attempt and the factory re-runs.)
		expect(fetches).toBe(1);
		// Mid-transition world split: the pending world asks a DIFFERENT key
		// (q2) and fetches it; the committed world's q1 entry is untouched.
		await act(async () => {
			React.startTransition(() => q.set('q2'));
		});
		expect(text(container)).toBe('one:DATA1;'); // pending; no fallback; no leak
		// THE CROSS-KEY TEST: with q2's promise still pending, a mid-transition
		// mount re-reads the node in the COMMITTED world (q1) — it must serve
		// q1's settled entry synchronously, not suspend on q2's promise and
		// not refetch q1.
		await act(async () => {
			root.render(<App two />);
		});
		expect(text(container)).toBe('one:DATA1;two:DATA1;');
		expect(fetches).toBe(2); // exactly one fetch per distinct key
		await act(async () => {
			gates.q2!.resolve('DATA2');
		});
		await act(async () => {});
		expect(text(container)).toBe('one:DATA2;two:DATA2;');
		expect(fetches).toBe(2); // settled entries replay everywhere — no livelock
	});

	test('case 15b — mount-retry parity: a discarded mount attempt discards the node, and the factory MAY re-run', async () => {
		// RE-PINNED CONTRACT (was: `fetches === 1` across a discarded initial
		// mount, served by the shim's capsule store keyed on fn source + value
		// prefix). The capsule system is gone; the ctx.use cache now lives on
		// the node, and the node is hook state — a mount attempt that suspends
		// and is discarded takes its node (and cache) with it, so the retry
		// re-creates both and re-runs the factory. That is React's own
		// uncached-promise story for consumers that die with discarded work.
		// Apps that want cross-death dedup cache the promise in their data
		// layer (as `gate.promise` does here — the re-run factory returns the
		// SAME settled promise, so the refetch costs nothing) or pass a
		// caller-cached promise via the one-argument form.
		h = makeHarness();
		const gate = deferred<string>();
		let factoryRuns = 0;
		function Inner() {
			// The node's owner is INSIDE the boundary: it dies with the attempt.
			const data = useComputed<string>((ctx) => ctx.use('the-query', () => {
				factoryRuns++;
				return gate.promise;
			}), []);
			return <span>v:{useSignal(data)};</span>;
		}
		const { container } = await h.mount(
			<React.Suspense fallback={<span>fb;</span>}>
				<Inner />
			</React.Suspense>,
		);
		expect(text(container)).toBe('fb;');
		// How many attempts React makes before/after the fallback is the
		// scheduler's business (observed: the initial mount already renders
		// the child twice, minting two nodes) — the CONTRACT pinned here is
		// only that discarded attempts do NOT share one cache: every attempt
		// re-ran the factory, and the retry after settlement re-ran it again
		// on a fresh node instead of replaying a dead node's entry.
		const runsAtFallback = factoryRuns;
		expect(runsAtFallback).toBeGreaterThanOrEqual(1);
		await act(async () => {
			gate.resolve('DATA');
		});
		expect(text(container)).toBe('v:DATA;'); // the retry unwraps the settled promise synchronously
		expect(factoryRuns).toBeGreaterThan(runsAtFallback); // fresh node, fresh cache: the factory re-ran
	});

	test('case 16 — useSignalEffect observes committed-only; core effect() observes newest', async () => {
		h = makeHarness();
		const a = new Atom(0);
		const gate = deferred<void>();
		const committedSeen: number[] = [];
		const newestSeen: number[] = [];
		function Suspender() {
			const v = useSignal(a);
			if (v > 0 && gate.settled !== true) throw gate.promise;
			return <span>s:{v};</span>;
		}
		function App() {
			useSignalEffect(() => {
				committedSeen.push(a.state as number);
			}, []);
			return (
				<React.Suspense fallback={null}>
					<Suspender />
				</React.Suspense>
			);
		}
		const { container } = await h.mount(<App />);
		const disposeCore = effect(() => {
			newestSeen.push(a.state as number);
		});
		await act(async () => {
			React.startTransition(() => a.set(1)); // applied, not committed
		});
		expect(newestSeen).toContain(1); // core contract: newest, immediately
		expect(committedSeen).not.toContain(1); // committed-for-root: excluded
		expect(text(container)).toBe('s:0;');
		gate.settled = true;
		await act(async () => {
			gate.resolve();
		});
		expect(text(container)).toBe('s:1;');
		expect(committedSeen).toContain(1); // re-fired at the durable flip
		disposeCore();
	});

	test('case 17 — no truncation surface; optimistic UI composes from atoms + actions', async () => {
		h = makeHarness();
		// API snapshot: no rollback/truncation affordance is exported.
		const names = Object.keys(CosignalReact);
		expect(names.filter((n) => /truncat|rollback|revert|restore/i.test(n))).toEqual([]);
		// The documented pattern: render optimistic ?? base; clear when the
		// result arrives. Post-await writes classify like any write at that
		// moment (React's own async-transition rule) — both land in the same
		// continuation, so they share one urgent batch and apply atomically.
		const base = new Atom<string>('saved-0');
		const optimistic = new Atom<string | null>(null);
		const io = deferred<void>();
		const settled = deferred<void>();
		function View() {
			const b = useSignal(base);
			const o = useSignal(optimistic);
			return <span>{o ?? b}</span>;
		}
		const { container } = await h.mount(<View />);
		expect(text(container)).toBe('saved-0');
		await act(async () => {
			optimistic.set('pending-1'); // urgent optimistic write
			startSignalTransition(async () => {
				await io.promise;
				base.set('saved-1'); // real result: ordinary post-await writes…
				optimistic.set(null); // …clear + result share one urgent batch
				settled.resolve();
			});
		});
		expect(text(container)).toBe('pending-1'); // optimistic state visible
		await act(async () => {
			io.resolve();
			await settled.promise;
		});
		await act(async () => {});
		expect(text(container)).toBe('saved-1'); // applied atomically
	});
});

describe('W20 — startSignalTransition passes nothing to fn; the settled action fails loudly', () => {
	test('fn receives zero arguments; sync writes classify into the action; the settled batch accepts no writes', async () => {
		h = makeHarness();
		const a = new Atom(0);
		const { container } = await h.mount(<Reader id="a" atom={a} />);
		const io = deferred<void>();
		const settled = deferred<void>();
		const argCounts: number[] = [];
		let actionBatch: number | undefined;
		const aNode = h.handle.shim.nodeForAtom(a as Atom<unknown>);
		await act(async () => {
			startSignalTransition(async function (...args: unknown[]) {
				argCounts.push(args.length); // the action callback gets NO scope object — nothing at all
				a.set(1); // ordinary write, classified into the action's batch by the one classifier
				await io.promise;
				settled.resolve();
			});
			actionBatch = h.bridge.liveBatches().find((t) => t.parked)?.id;
		});
		expect(argCounts).toEqual([0]);
		expect(actionBatch).toBeDefined(); // the action's batch opened parked, eagerly
		expect(text(container)).toBe('a:0;'); // parked: the sync write renders pending, commits nothing durable
		await act(async () => {
			io.resolve();
			await settled.promise;
		});
		await act(async () => {});
		expect(text(container)).toBe('a:1;'); // the action settled: its batch folded
		// KEEP AND RE-PIN: "the action's batch is gone" still fails loudly.
		// The scope object is deleted, so no userspace handle can outlive the
		// action — the one remaining way to name the settled batch is its
		// engine batch id, and the engine's write guard throws rather than
		// silently classifying the write urgent: 'write into retired batch'
		// while the retired record lingers, 'unknown batch' once the engine
		// reclaims it (mid-episode batch reclamation frees fully-drained
		// retired records).
		const settledState = h.bridge.idToBatch.get(actionBatch!)?.state;
		expect(settledState === undefined || settledState === 'retired').toBe(true);
		expect(() => h.bridge.write(actionBatch!, aNode, 0, 9)).toThrow(/retired batch|unknown batch/);
	});
});

describe('context-free writes (React batch id 0 is unreachable once a renderer provider exists)', () => {
	test('post-handshake, an out-of-React-context write STILL rides a protocol batch: the id-0 state is unreachable', async () => {
		// Unreachability, proven on the happy path: once a renderer provider
		// exists (the shim's handshake asserts one),
		// unstable_getCurrentWriteBatch() mints a nonzero React batch id for EVERY
		// write — even from a bare timer-style call stack — with a guaranteed
		// close edge. So the classifier's id-0 protocol-violation check
		// (devChecks, armed by this harness) never fires in the React path,
		// and no ambient batch is ever minted. dev-checks.spec.ts drives the
		// id-0 state itself in a renderer-less environment.
		h = makeHarness();
		const a = new Atom(0);
		const flag = new Atom(0); // written outside any React context; observed by no component
		const io = deferred<void>();
		const settled = deferred<void>();
		const { container } = await h.mount(<Reader id="a" atom={a} />);
		expect(h.bridge.quiet).toBe(true);
		await act(async () => {
			startSignalTransition(async () => {
				await io.promise;
				a.set(1); // post-await: classifies like any write at that moment (urgent protocol batch)
				settled.resolve();
			});
		});
		// The action is parked: the pipeline is armed until it settles.
		expect(h.bridge.liveBatches().some((t) => t.parked)).toBe(true);
		expect(h.bridge.quiet).toBe(false);
		// The out-of-context write while the window is open: NOT ambient — the
		// protocol supplies a real write batch (urgent), with a close edge.
		flag.set(7);
		expect(h.bridge.ambientBatch).toBeUndefined(); // no ambient mint, ever
		expect(h.bridge.liveBatches().some((t) => !t.parked && !t.ambient)).toBe(true); // it rode a protocol batch
		// The window closes: the action settles; the write's own batch closes
		// via the protocol's guaranteed close edge. Nothing lives on.
		await act(async () => {
			io.resolve();
			await settled.promise;
		});
		await act(async () => {});
		expect(h.bridge.liveBatches()).toHaveLength(0);
		expect(h.bridge.quiescent()).toBe(true); // quiesce() reachable (tapes compacted)
		expect(h.bridge.quiet).toBe(true); // quiet mode re-armed for the next episode
		const flagNode = h.bridge.byKernelId.get(flag._id)!;
		expect(h.bridge.committedValue(flagNode, 'root-1')).toBe(7); // the write persisted (committed truth)
		expect(text(container)).toBe('a:1;');
	});

	// (The shim's ambient-batch retirement policy — and its pin here — died
	// with the classifier's bareWrite fallback: the classifier never routes
	// to the engine's ambient batch anymore, so the shim owns no ambient
	// retirement. The engine KEEPS bareWrite/ambient minting for
	// classifier-less hosts (host-agnostic embedding); the engine suites and
	// the oracle corpus pin that capability.)
});

describe('EF2 boundary semantics for useSignalEffect (amended 2026-07-06 — effects-unification re-pin)', () => {
	// Production originally revalidated effects IMMEDIATELY at writes into a
	// batch some root had already committed (the member-write trigger). The
	// amended EF2 rules those BOUNDARY semantics: never mid-write, coalesced
	// to one run at the boundary value. These pins are mutation-style: the
	// old immediate revalidation fails them.

	test('member writes coalesce: no mid-write fire, ONE cleanup+run at the settlement boundary value', async () => {
		h = makeHarness();
		const a = new Atom(0);
		const b = new Atom(0);
		const runs: number[] = [];
		const cleans: number[] = [];
		function View() {
			// NOTE: no component subscribes to `a` — the member writes below
			// schedule no re-render, so no commit boundary lands before the
			// settlement; the window stays open for the assertions.
			useSignalEffect(() => {
				const v = a.state as number;
				runs.push(v);
				return () => cleans.push(v);
			}, []);
			return <span>b:{useSignal(b)};</span>;
		}
		await h.mount(<View />);
		expect(runs).toEqual([0]);
		const gate = deferred<void>();
		const wrote = deferred<void>();
		const hold = deferred<void>();
		// Post-await writes no longer rejoin the action (W20: fn gets no scope;
		// React's own async-transition rule applies), so the member writes are
		// driven at the engine level — writes attributed to the action's
		// still-live engine batch, the shape a protocol lane merge or a
		// runInBatch-delivered write produces.
		const aNode = h.handle.shim.nodeForAtom(a as Atom<unknown>);
		let actionBatch: number | undefined;
		await act(async () => {
			startSignalTransition(async () => {
				b.set(1); // sync part classifies into the action's batch: the transition renders + commits (locks in) while parked
				await gate.promise;
				h.bridge.write(actionBatch!, aNode, 0, 1); // member writes: committed truth moves at each…
				h.bridge.write(actionBatch!, aNode, 0, 2);
				h.bridge.write(actionBatch!, aNode, 0, 3);
				wrote.resolve();
				await hold.promise; // …but the action stays parked past the assertion
			});
			actionBatch = h.bridge.liveBatches().find((t) => t.parked)?.id;
		});
		expect(runs).toEqual([0]); // b's lock-in commit: value gate holds (a unchanged)
		await act(async () => {
			gate.resolve();
			await wrote.promise;
		});
		expect(runs).toEqual([0]); // NEVER mid-write (the old adapter fired here at 1, 2, and 3)
		expect(cleans).toEqual([]);
		await act(async () => {
			hold.resolve();
		});
		await act(async () => {});
		expect(runs).toEqual([0, 3]); // ONE re-fire at the settlement boundary, at the boundary value
		expect(cleans).toEqual([0]); // exactly one cleanup before it — 1 and 2 were never observed
	});

	test('unmount before the boundary: cleanup is guaranteed; the boundary after teardown fires nothing (OL2 — a make-up fire is not owed)', async () => {
		h = makeHarness();
		const a = new Atom(0);
		const b = new Atom(0);
		const runs: number[] = [];
		const cleans: number[] = [];
		function Eff() {
			useSignalEffect(() => {
				const v = a.state as number;
				runs.push(v);
				return () => cleans.push(v);
			}, []);
			return null;
		}
		function View({ on }: { on: boolean }) {
			return (
				<div>
					b:{useSignal(b)};{on ? <Eff /> : null}
				</div>
			);
		}
		const { root } = await h.mount(<View on={true} />);
		expect(runs).toEqual([0]);
		const gate = deferred<void>();
		const wrote = deferred<void>();
		const hold = deferred<void>();
		// Engine-level member write into the action's still-live batch (see the
		// coalescing test above for why the React surface no longer spells this).
		const aNode = h.handle.shim.nodeForAtom(a as Atom<unknown>);
		let actionBatch: number | undefined;
		await act(async () => {
			startSignalTransition(async () => {
				b.set(1);
				await gate.promise;
				h.bridge.write(actionBatch!, aNode, 0, 7); // the member write lands while the effect is live…
				wrote.resolve();
				await hold.promise; // …but its durable flip is the settlement, later
			});
			actionBatch = h.bridge.liveBatches().find((t) => t.parked)?.id;
		});
		await act(async () => {
			gate.resolve();
			await wrote.promise;
		});
		expect(runs).toEqual([0]); // no boundary has exposed a=7 yet
		await act(async () => {
			root.render(<View on={false} />); // unmount the effect before the boundary
		});
		expect(cleans).toEqual([0]); // cleanup is GUARANTEED at unmount
		await act(async () => {
			hold.resolve(); // the settlement boundary arrives AFTER teardown
		});
		await act(async () => {});
		expect(runs).toEqual([0]); // nothing runs after teardown (RCC-OL2); a make-up fire is not owed
		expect(cleans).toEqual([0]);
	});

	test('16d — a still-pending suspended dep is not a flip; the SETTLEMENT DRAIN re-fires with the settled value (amended P2.S-A 2026-07-06)', async () => {
		h = makeHarness();
		const gate = deferred<string>();
		const kick = new Atom(0);
		const seen: unknown[] = [];
		function View() {
			const data = useComputed<string>((ctx) => {
				void (kick.state as number); // the request's key input (a tracked dep)
				return ctx.use('k', () => gate.promise);
			}, []);
			useSignalEffect(() => {
				seen.push(data.state); // background read: pending folds to its stable sentinel
			}, [data]);
			return <span>k:{useSignal(kick)};</span>;
		}
		await h.mount(<View />);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toBeInstanceOf(SuspendedRead); // the snapshot holds the stable sentinel
		await act(async () => {
			kick.set(1); // a boundary while the dep is still pending
		});
		expect(seen).toHaveLength(1); // still-pending is NOT a flip (battery 16d)
		await act(async () => {
			gate.resolve('DATA');
		});
		// AMENDED P2.S-A (plans/2026-07-06 §4.5.4, fourth pass; RCC-SU5 MUST:
		// "settlement re-evaluates the consumers that suspended"): thenable
		// settlement IS the EF2 settlement boundary — the settle tap's drain
		// re-checks the suspended consumer FROM the settlement event itself,
		// with NO unrelated operation (the background-settlement coverage
		// fable M2 showed this battery lacked). The pre-P2 pin ("not a batch
		// boundary; no re-fire until committed truth next moves") described
		// the engine's GAP, not the contract.
		expect(seen).toHaveLength(2);
		expect(seen[1]).toBe('DATA'); // re-fired with the settled value, from the drain
		await act(async () => {
			kick.set(2); // the next boundary re-checks value-gated: no extra fire
		});
		expect(seen).toHaveLength(2);
	});
});
