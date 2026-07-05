/**
 * Spec §6 acceptance battery at the React level (task 4c): every case whose
 * React semantics are exercisable outside the fork's internal harness, case
 * numbers cited in test names. Not exercisable here (documented):
 *  - case 7 (yield-gap writes) — needs deterministic time-slicing control;
 *    pinned by fork tests 7-10 and the engine conformance suite.
 *  - case 9 rows c/d (foreign retirement / post-pin write IN the
 *    render→commit window) and case 10 races (i)/(ii) — sub-millisecond
 *    windows the public API cannot schedule; oracle + fork tests 22/24/25
 *    pin them. Rows a/e and the entanglement path are covered below.
 *  - case 13 rows 6-9 (counter wrap/horizon) — engine counters; the
 *    quiescence/epoch half is smoke-tested below.
 */
import { describe, expect, test, afterEach } from 'vitest';
import * as React from 'react';
import { flushSync } from 'react-dom';
import { Atom, ReducerAtom, effect } from 'cosignal/logged';
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
		const node = h.bridge.byKernelId.get(a._id)!;
		expect(h.bridge.newestValue(node)).toBe(2);
		gate.settled = true;
		await act(async () => {
			gate.resolve();
		});
		expect(text(container)).toBe('c:20;s:2;');
	});

	test('case 2 — flushSync excludes a pending batch (always-log premise)', async () => {
		// NOTE: this React generation entangles Default with Sync (unified sync
		// lane), so a DEFAULT batch cannot stay pending across flushSync at the
		// React level — verified empirically; the default-priority exclusion
		// schedule is pinned engine-side (cosignal logged-battery). The
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
			const node = h.bridge.byKernelId.get(a._id)!;
			expect(node.tape.length).toBe(1);
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
		const retired = h.bridge.eventsOfType('retired');
		const byToken = new Map<number, number>();
		for (const e of retired) byToken.set(e.token, (byToken.get(e.token) ?? 0) + 1);
		for (const [, count] of byToken) expect(count).toBe(1); // exactly once per token
	});

	test('case 5 — cutoff-suppressed first write, effective second write (same batch)', async () => {
		h = makeHarness();
		const a = new Atom(10, { isEqual: (x, y) => x === y });
		const { container } = await h.mount(<Reader id="a" atom={a} />);
		await act(async () => {
			a.set(10); // equal against empty history: dropped (§5.3 step 2)
			a.set(11); // effective
		});
		expect(text(container)).toBe('a:11;');
		expect(h.bridge.eventsOfType('write-dropped').length).toBe(1);
		expect(h.bridge.eventsOfType('write').length).toBeGreaterThanOrEqual(1);
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
		// Both writes carry batch attribution (receipts with tokens), no grouping
		// machinery anywhere: two write events, each with a token.
		const writes = h.bridge.eventsOfType('write');
		expect(writes.length).toBe(2);
		for (const w of writes) expect(w.token).toBeGreaterThan(0);
	});

	test('case 8 — equality drops never lose receipts once history exists', async () => {
		h = makeHarness();
		const a = new Atom(0, { isEqual: (x, y) => x === y });
		const { container } = await h.mount(<Reader id="a" atom={a} />);
		await act(async () => {
			React.startTransition(() => a.set(5)); // pending deferred receipt
			// Equal to the PENDING newest value — but history is non-empty, so
			// the receipt must be kept (drop check is empty-tape only, §5.3):
			// without it the urgent world (which excludes the transition) would
			// still show 0.
			flushSync(() => a.set(5));
			expect(text(container)).toBe('a:5;'); // the urgent receipt rendered
		});
		await act(async () => {});
		expect(text(container)).toBe('a:5;');
		const node = h.bridge.byKernelId.get(a._id)!;
		const receiptCount = node.tape.length + node.archive.length;
		expect(receiptCount).toBe(2); // both writes hold receipts
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
		expect(freshRenders).toBe(1); // no double render for the included token
		expect(h.bridge.eventsOfType('mount-urgent-correction').length).toBe(0);
		expect(h.bridge.eventsOfType('mount-corrective').length).toBe(0); // fully included: skipped
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
		const k = h.bridge.eventsOfType('write')[0]!.token;
		// §4.1 fact 4: the corrective rode k's own lane — k committed exactly
		// once on this root (a fresh transition would have produced a second).
		const kCommits = h.bridge.eventsOfType('per-root-commit').filter((e) => e.token === k);
		expect(kCommits.length).toBe(1);
		expect(h.bridge.eventsOfType('retired').filter((e) => e.token === k).length).toBe(1);
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
		const k = h.bridge.eventsOfType('write')[0]!.token;
		const roots = new Set(h.bridge.eventsOfType('per-root-commit').filter((e) => e.token === k).map((e) => e.root));
		expect(roots.size).toBe(2); // each root's commit reported separately
		expect(h.bridge.eventsOfType('retired').filter((e) => e.token === k).length).toBe(1); // exactly once
	});

	test('case 12 — store-only transition persists (committed=false folds identically)', async () => {
		h = makeHarness();
		const shown = new Atom(0);
		const orphan = new Atom(0); // never read by any component
		const { container } = await h.mount(<Reader id="s" atom={shown} />);
		await act(async () => {
			React.startTransition(() => orphan.set(5)); // no React work at all
		});
		await act(async () => {});
		// The batch retired committed=false through the same path: fold happened.
		const orphanNode = h.bridge.byKernelId.get(orphan._id)!;
		const retired = h.bridge.eventsOfType('retired');
		expect(retired.some((e) => e.committed === false)).toBe(true);
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
		h.bridge.quiesce(); // §5.12: epoch bump + renumber
		expect(h.bridge.eventsOfType('epoch-reset').length).toBe(1);
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
				committedNodeIds.push(c._node.id); // the committed render's node
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

	test('case 15 — Suspense across worlds: capsule identity by content, no refetch livelock (rows 2/3)', async () => {
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
			// Read the query BEFORE ctx.use: pre-use reads form the capsule's
			// validity prefix (§5.8); factory-internal reads run at mint only.
			const data = useComputed<string>((ctx) => {
				const query = q.state as string;
				return ctx.use(() => fetchLike(query));
			}, []);
			return (
				<React.Suspense fallback={<span>fb;</span>}>
					<Show id="one" data={data} />
					{two ? <Show id="two" data={data} /> : null}
				</React.Suspense>
			);
		}
		const { root, container } = await h.mount(<App two={false} />);
		expect(text(container)).toBe('fb;'); // suspended on the q1 capsule
		expect(fetches).toBe(1);
		await act(async () => {
			gates.q1!.resolve('DATA1');
		});
		expect(text(container)).toBe('one:DATA1;');
		expect(fetches).toBe(1); // the retry consumed the SAME capsule (row 3)
		// Mid-transition world split: the transition refetches (moved prefix),
		// the committed world keeps serving the settled q1 capsule.
		await act(async () => {
			React.startTransition(() => q.set('q2'));
		});
		expect(text(container)).toBe('one:DATA1;'); // pending; no fallback; no leak
		await act(async () => {
			root.render(<App two />); // mid-transition mount reads the SAME capsule (row 2)
		});
		expect(text(container)).toBe('one:DATA1;two:DATA1;');
		expect(fetches).toBe(2); // exactly one fetch per distinct world content
		await act(async () => {
			gates.q2!.resolve('DATA2');
		});
		await act(async () => {});
		expect(text(container)).toBe('one:DATA2;two:DATA2;');
		expect(fetches).toBe(2); // settled capsule served everywhere — no livelock
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
		// The documented pattern: render optimistic ?? base; clear at settle.
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
			startSignalTransition(async (scope) => {
				await io.promise;
				scope.set(base, 'saved-1'); // real result rides the action
				scope.set(optimistic, null); // clear at settle
				settled.resolve();
			});
		});
		expect(text(container)).toBe('pending-1'); // optimistic state visible
		await act(async () => {
			io.resolve();
			await settled.promise;
		});
		await act(async () => {});
		expect(text(container)).toBe('saved-1'); // settled atomically
	});
});
