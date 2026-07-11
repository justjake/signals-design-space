/**
 * Two-tier graph mechanics: promotion into the watched tier (subscriber
 * edges installed, push marks trustworthy) and demotion back to the
 * unwatched tier (forward edges only, validAt-gated pull validation on read).
 *
 * Regime labels, per standing verification orders:
 * - [falsify-first] tests were run against the pre-rebuild graph and failed
 *   with the quoted output; the rebuild makes them pass.
 * - [parity] tests pin structure or exact counts; the full suites (265
 *   tests, 1200-seed oracle, battery) are the behavioral referee.
 */
import { describe, expect, test } from 'vitest'
import {
	type CellNode,
	type DerivedNode,
	type Link,
	type ReactiveNode,
	Flag,
	batch,
	currentGraphChange,
	makeDerived,
	makeEffect,
	observeNode,
	readCell,
	readDerived,
	writeCell,
} from '../src/graph.ts'
import { nodeOf, signal, type SignalOptions } from '../src/index.ts'
import { appendDraftIntent, discardDraft, openDraft } from '../src/worlds.ts'

function cell<T>(initial: T | (() => T), opts?: SignalOptions<T>): CellNode<T> {
	return nodeOf(signal(initial, opts)) as CellNode<T>
}

/** Edges in dep's subscriber list pointing at sub (watched edges only). */
function subEdgeCount(dep: ReactiveNode, sub?: ReactiveNode): number {
	let n = 0
	for (let l: Link | undefined = dep.subs; l !== undefined; l = l.nextSub) {
		if (sub === undefined || l.sub === sub) {
			n++
		}
	}
	return n
}

/** Edges in sub's dependency list pointing at dep (both tiers). */
function depEdgeCount(sub: ReactiveNode, dep: ReactiveNode): number {
	let n = 0
	for (let l: Link | undefined = sub.deps; l !== undefined; l = l.nextDep) {
		if (l.dep === dep) {
			n++
		}
	}
	return n
}

function isWatched(n: ReactiveNode): boolean {
	return (n.flags & Flag.Watched) !== 0
}

/** The tier invariant promote/demote must maintain: for cells and deriveds
 * the Watched bit mirrors observerCount (watchers own their bit through
 * create/dispose). A path that set Watched without promote-validation would
 * resurrect the stale-Clean serve that promote exists to prevent. */
function expectTierInvariant(nodes: ReactiveNode[]): void {
	for (const n of nodes) {
		if ((n.flags & Flag.Watching) !== 0) {
			continue
		}
		expect(isWatched(n)).toBe(n.observerCount > 0)
	}
}

describe('two-tier graph: promote validation', () => {
	test('T1 [falsify-first] subscribe-without-pull then read serves the fresh value', () => {
		// Pre-rebuild failure: AssertionError: expected 2 to be 4 — promote
		// installed back-edges and trusted the stale Clean flags, so the watched
		// fast path served the cached value.
		const a = cell(1)
		const d = makeDerived(() => readCell(a) * 2)
		expect(readDerived(d)).toBe(2) // caches while unwatched
		writeCell(a, 2) // no back-edges: no push mark reaches d
		const stop = observeNode(d, () => {}) // subscribe WITHOUT pulling
		expect(readDerived(d)).toBe(4)
		stop()
	})

	test('T2 [falsify-first] subscribing to a stale node delivers the pending edge once; a pull re-arms', () => {
		// Pre-rebuild failure: AssertionError: expected +0 to be 1 — the node
		// was stale when the subscriber arrived, and the wave's early-return on
		// pre-existing staleness meant the new subscriber never heard anything.
		const a = cell(1)
		const d = makeDerived(() => readCell(a) * 2)
		const stopEffect = makeEffect(() => void readDerived(d))
		batch(() => {
			writeCell(a, 2) // marks d through the watched edge
			stopEffect() // demote runs while d is stale
		})
		let notifies = 0
		const stop = observeNode(d, () => notifies++)
		expect(notifies).toBe(1) // the missed staleness edge, delivered at subscribe
		expect(readDerived(d)).toBe(4) // pull re-arms the edge trigger
		writeCell(a, 3)
		expect(notifies).toBe(2)
		stop()
	})

	test('T3 [falsify-first] promote validates transitively through the dep closure', () => {
		// Pre-rebuild failure: AssertionError: expected 20 to be 30 — the write
		// invalidated c -> d1 while everything was unwatched; promote linked the
		// closure without checking whether the flags deserved trust.
		const c = cell(1)
		const d1 = makeDerived(() => readCell(c) + 1)
		const d2 = makeDerived(() => readDerived(d1) * 10)
		expect(readDerived(d2)).toBe(20)
		writeCell(c, 2)
		const stop = observeNode(d2, () => {})
		expect(readDerived(d2)).toBe(30)
		stop()
	})
})

describe('two-tier graph: promote/demote structure', () => {
	test('T4 [parity] promote links the dep closure; demote reverses it exactly', () => {
		const c = cell(1)
		const d1 = makeDerived(() => readCell(c) + 1)
		const d2 = makeDerived(() => readDerived(d1) + 1)
		expect(readDerived(d2)).toBe(3)
		// Unwatched evaluation registered nothing subscriber-side.
		expect(subEdgeCount(c)).toBe(0)
		expect(subEdgeCount(d1)).toBe(0)
		expectTierInvariant([c, d1, d2])

		const stop = observeNode(d2, () => {})
		expect(subEdgeCount(c, d1)).toBe(1)
		expect(subEdgeCount(d1, d2)).toBe(1)
		expect(subEdgeCount(d2)).toBe(1) // the subscription
		expect(c.observerCount).toBe(1)
		expect(d1.observerCount).toBe(1)
		expect(d2.observerCount).toBe(1)
		expect(isWatched(c) && isWatched(d1) && isWatched(d2)).toBe(true)
		expectTierInvariant([c, d1, d2])

		stop()
		expect(subEdgeCount(c)).toBe(0)
		expect(subEdgeCount(d1)).toBe(0)
		expect(subEdgeCount(d2)).toBe(0)
		expect(c.observerCount).toBe(0)
		expect(d1.observerCount).toBe(0)
		expect(d2.observerCount).toBe(0)
		expect(isWatched(c) || isWatched(d1) || isWatched(d2)).toBe(false)
		expectTierInvariant([c, d1, d2])
		// Forward edges survive for the unwatched tier's pull validation.
		expect(depEdgeCount(d2, d1)).toBe(1)
		expect(depEdgeCount(d1, c)).toBe(1)
	})

	test('T5 [parity] demote seeds validAtGraphChange: the clock reading when Clean, 0 when stale', () => {
		const c = cell(1)
		const d1 = makeDerived(() => readCell(c) + 1)
		const d2 = makeDerived(() => readDerived(d1) + 1)
		const stop = observeNode(d2, () => {})
		expect(readDerived(d2)).toBe(3)
		stop() // Clean at demote: the next quiet read must short-circuit O(1)
		expect(d1.validAtGraphChange).toBe(currentGraphChange())
		expect(d2.validAtGraphChange).toBe(currentGraphChange())

		const stop2 = observeNode(d2, () => {})
		batch(() => {
			writeCell(c, 2) // wave marks d1/d2 before the flush is due
			stop2() // stale at demote: force the up-walk on next read
		})
		expect(d1.validAtGraphChange).toBe(0)
		expect(d2.validAtGraphChange).toBe(0)
		expect(readDerived(d2)).toBe(4)
	})

	test('T6 [parity pin] recompute counts across watch -> demote -> quiet-read cycles', () => {
		let e1 = 0
		let e2 = 0
		const c = cell(1)
		const d1 = makeDerived(() => (e1++, readCell(c) + 1))
		const d2 = makeDerived(() => (e2++, readDerived(d1) + 1))
		expect(readDerived(d2)).toBe(3)
		expect([e1, e2]).toEqual([1, 1])

		const stop = observeNode(d2, () => {})
		expect([e1, e2]).toEqual([1, 1]) // subscribing evaluates nothing
		writeCell(c, 2)
		expect([e1, e2]).toEqual([1, 1]) // marking is lazy
		expect(readDerived(d2)).toBe(4)
		expect([e1, e2]).toEqual([2, 2])

		stop() // Clean at demote
		expect(readDerived(d2)).toBe(4) // quiet read: no walk, no recompute
		expect(readDerived(d2)).toBe(4)
		expect([e1, e2]).toEqual([2, 2])

		writeCell(c, 3) // unwatched: versions move, no marks
		expect(readDerived(d2)).toBe(5) // up-walk finds the moved version
		expect([e1, e2]).toEqual([3, 3])

		writeCell(c, 3) // equal write: no version movement
		expect(readDerived(d2)).toBe(5)
		expect([e1, e2]).toEqual([3, 3])
	})

	test('T8 [parity] quiet reads short-circuit: zero recomputes on a wide validated graph', () => {
		const cells = Array.from({ length: 50 }, (_, i) => cell(i))
		let evals = 0
		const wide = makeDerived(() => {
			evals++
			let sum = 0
			for (const c of cells) {
				sum += readCell(c)
			}
			return sum
		})
		expect(readDerived(wide)).toBe(1225)
		expect(evals).toBe(1)
		// Precondition of the O(1) return: Clean plus a current validAtGraphChange reading.
		expect(wide.validAtGraphChange).toBe(currentGraphChange())
		expect((wide.flags & (Flag.StaleCheck | Flag.StaleDirty)) === 0).toBe(true)
		for (let i = 0; i < 100; i++) {
			readDerived(wide)
		}
		expect(evals).toBe(1)
	})

	test('T12 [parity] promoting a computing node with an unmatched deps suffix stays consistent', () => {
		const x = cell(1)
		const y = cell(2)
		let subscribeNow = false
		let stop: (() => void) | undefined
		let notified = 0
		const d: DerivedNode<number> = makeDerived(() => {
			const vx = readCell(x)
			if (subscribeNow) {
				subscribeNow = false
				// Subscribe to the node mid-evaluation: promote walks the full deps
				// list, including the y edge beyond the cursor that this pass will
				// not re-read.
				stop = observeNode(d, () => notified++)
				return vx
			}
			return vx + readCell(y)
		})
		expect(readDerived(d)).toBe(3) // deps [x, y], unwatched
		subscribeNow = true
		writeCell(x, 5) // unwatched: versions move, no marks
		expect(readDerived(d)).toBe(5) // mid-eval promote; trimDeps drops the y suffix
		expect(y.subs).toBeUndefined()
		expect(y.observerCount).toBe(0) // suffix unlink kept observer bookkeeping symmetric
		expect(x.observerCount).toBe(1)
		expect(d.observerCount).toBe(1)
		expect(isWatched(d) && isWatched(x)).toBe(true)
		expect(isWatched(y)).toBe(false)
		expectTierInvariant([x, y, d as ReactiveNode])

		writeCell(y, 9) // the dropped edge must not notify
		expect(notified).toBe(0)
		writeCell(x, 6) // the kept edge must
		expect(notified).toBe(1)
		// The pull re-evaluates the full body: y is re-read, re-linked, and —
		// because d is watched now — promoted back into the watched tier.
		expect(readDerived(d)).toBe(15)
		expect(y.observerCount).toBe(1)
		expect(isWatched(y)).toBe(true)
		expectTierInvariant([x, y, d as ReactiveNode])
		stop!()
		expect(y.observerCount).toBe(0)
	})
})

describe('two-tier graph: tracking and waves', () => {
	test('T9 [falsify-first] non-adjacent re-reads in one watched pass dedup to a single edge', () => {
		// Pre-rebuild failure: AssertionError: expected 2 to be 1 — the second
		// read of `a` (non-adjacent, past the cursor) created a duplicate
		// watched edge, double-counting the observer.
		const a = cell(1)
		const b = cell(2)
		const d = makeDerived(() => readCell(a) + readCell(b) + readCell(a))
		const stop = observeNode(d, () => {})
		expect(readDerived(d)).toBe(4)
		expect(subEdgeCount(a, d)).toBe(1)
		expect(depEdgeCount(d, a)).toBe(1)
		expect(a.observerCount).toBe(1)
		// The dedup is stable across re-evaluations.
		writeCell(b, 5)
		expect(readDerived(d)).toBe(7)
		expect(subEdgeCount(a, d)).toBe(1)
		expect(a.observerCount).toBe(1)
		stop()
		expect(a.observerCount).toBe(0)
	})

	test('T10 [parity pin] render notification is edge-triggered; a pull re-arms', () => {
		const a = cell(1)
		const d = makeDerived(() => readCell(a) * 2)
		expect(readDerived(d)).toBe(2) // Clean before subscribing: no wake due
		let n = 0
		const stop = observeNode(d, () => n++)
		writeCell(a, 2)
		const afterFirst = n
		writeCell(a, 3) // no pull between: the edge already fired
		const afterSecond = n
		expect(readDerived(d)).toBe(6) // re-arm
		writeCell(a, 4)
		const afterThird = n
		expect({ afterFirst, afterSecond, afterThird }).toEqual({
			afterFirst: 1,
			afterSecond: 1,
			afterThird: 2,
		})
		stop()
	})

	test('T11b [falsify-first] a drafted write pokes subscribers through a deep watched chain', () => {
		// The drafted twin of T11: a draft intent travels the same watched
		// closure as the wave (draft activity must reach subscribers of
		// computeds over the drafted cell), so its walk needs the same
		// iterative discipline. Pre-change failure quoted in the commit.
		const DEPTH = 150_000
		const base = cell(0)
		const disposers: Array<() => void> = []
		let topNotified = 0
		const wakes: number[] = []
		let prev: ReactiveNode = base
		for (let i = 0; i < DEPTH; i++) {
			const p = prev
			const d = makeDerived(
				() =>
					((p.flags & Flag.KindCell) !== 0
						? readCell(p as CellNode<number>)
						: readDerived(p as DerivedNode<number>)) + 1,
			)
			disposers.push(
				i === DEPTH - 1
					? observeNode(
							d,
							() => topNotified++,
							(id) => wakes.push(id),
						)
					: observeNode(d, () => {}),
			)
			readDerived(d)
			prev = d
		}
		const draft = openDraft()
		appendDraftIntent(draft, base as CellNode<unknown>, 'set', 1)
		expect(topNotified).toBe(1) // the poke reached the deepest subscriber
		expect(wakes).toEqual([draft.id]) // and so did the draft-lane wake
		discardDraft(draft.id) // rollback pokes the same closure again
		expect(topNotified).toBe(2)
		for (let i = disposers.length - 1; i >= 0; i--) {
			disposers[i]()
		}
		expect(subEdgeCount(base)).toBe(0)
	})

	test('T11 [falsify-first] a write through a deep watched chain completes', () => {
		// Pre-rebuild failure: RangeError: Maximum call stack size exceeded —
		// the recursive wave overflowed at this depth; the iterative propagate
		// carries it. (Pull-side recursion is consciously retained; this test
		// never deep-pulls.)
		const DEPTH = 150_000
		const base = cell(0)
		const disposers: Array<() => void> = []
		let topNotified = 0
		let prev: ReactiveNode = base
		for (let i = 0; i < DEPTH; i++) {
			const p = prev
			const d = makeDerived(
				() =>
					((p.flags & Flag.KindCell) !== 0
						? readCell(p as CellNode<number>)
						: readDerived(p as DerivedNode<number>)) + 1,
			)
			// Watch and evaluate incrementally so promote and pull stay depth-1;
			// only the write's wave spans the whole chain.
			disposers.push(observeNode(d, i === DEPTH - 1 ? () => topNotified++ : () => {}))
			readDerived(d)
			prev = d
		}
		expect((prev as DerivedNode<number>).value).toBe(DEPTH)
		writeCell(base, 1)
		expect(topNotified).toBe(1)
		// Reverse order keeps demote cascades depth-1 as well.
		for (let i = disposers.length - 1; i >= 0; i--) {
			disposers[i]()
		}
		expect(subEdgeCount(base)).toBe(0)
	})
})

describe('two-tier graph: render-notify delivery re-entrancy', () => {
	// A subscriber's onNotify may write, and that write flushes re-entrantly (the
	// effect stage is guarded by the flushing flag; delivery is not). These
	// tests pin the wave-snapshot contract: a wave's iteration never sees
	// subscribers marked during its own delivery — they are delivered by the nested
	// wave the marking write triggers, exactly once.

	test('Q1 [guard: passes pre- and post-storage-change] a subscriber marked during delivery is delivered by the nested wave, not the current iteration', () => {
		const x = cell(0)
		const y = cell(0)
		const events: string[] = []
		const stopL1 = observeNode(x, () => {
			events.push('L1:begin')
			writeCell(y, readCell(y) + 1) // marks L2; flushes re-entrantly
			events.push('L1:end')
		})
		const stopL2 = observeNode(y, () => events.push('L2'))
		const stopL3 = observeNode(x, () => events.push('L3'))
		writeCell(x, 1)
		// L2 rides the nested wave inside L1's callback; the outer wave's
		// iteration stays exactly its snapshot [L1, L3]. Each delivered once.
		expect(events).toEqual(['L1:begin', 'L2', 'L1:end', 'L3'])
		stopL1()
		stopL2()
		stopL3()
	})

	test('Q2 [guard: passes pre- and post-storage-change] doubly-nested delivery keeps every undelivered snapshot entry intact', () => {
		// Three waves deep: the outer wave still holds an undelivered subscriber (L5)
		// while two nested waves mark and deliver. A buffer-reuse scheme that
		// handed the outer wave's storage to a nested wave would overwrite L5's
		// slot with L4b and lose the notification; the sequence pins against it.
		const x = cell(0)
		const y = cell(0)
		const z = cell(0)
		const events: string[] = []
		const stops: Array<() => void> = []
		stops.push(
			observeNode(x, () => {
				events.push('L1:begin')
				writeCell(y, readCell(y) + 1) // marks L2
				events.push('L1:end')
			}),
		)
		stops.push(
			observeNode(y, () => {
				events.push('L2:begin')
				writeCell(z, readCell(z) + 1) // marks L4a, L4b two waves deep
				events.push('L2:end')
			}),
		)
		stops.push(observeNode(z, () => events.push('L4a')))
		stops.push(observeNode(z, () => events.push('L4b')))
		stops.push(observeNode(x, () => events.push('L5')))
		writeCell(x, 1)
		expect(events).toEqual(['L1:begin', 'L2:begin', 'L4a', 'L4b', 'L2:end', 'L1:end', 'L5'])
		for (const stop of stops) {
			stop()
		}
	})
})

describe('watermark validation ordering (the changedAt/validAt discipline)', () => {
	test('lazy chain: deps freshen before their readings are compared', () => {
		// a → c1 → c2, all unwatched. After a write, reading c2 must freshen c1
		// FIRST (whose recompute stamps changedAt with the current clock) and
		// only then compare — stamp-before-freshen order would miss the change.
		let c1Runs = 0
		let c2Runs = 0
		const a = cell(1)
		const c1 = makeDerived(() => {
			c1Runs++
			return readCell(a) * 10
		})
		const c2 = makeDerived(() => {
			c2Runs++
			return readDerived(c1) + 1
		})
		expect(readDerived(c2)).toBe(11)
		expect([c1Runs, c2Runs]).toEqual([1, 1])
		writeCell(a, 2)
		expect(readDerived(c2)).toBe(21)
		expect([c1Runs, c2Runs]).toEqual([2, 2])
	})

	test('equality cutoff does not advance changedAt: downstream skips recompute', () => {
		// c1 collapses distinct inputs; its recompute must NOT advance its
		// changedAt reading, so c2 validates as unchanged and never re-runs.
		let c1Runs = 0
		let c2Runs = 0
		const a = cell(1)
		const c1 = makeDerived(() => {
			c1Runs++
			return readCell(a) % 2
		})
		const c2 = makeDerived(() => {
			c2Runs++
			return readDerived(c1) * 100
		})
		expect(readDerived(c2)).toBe(100)
		writeCell(a, 3) // parity unchanged
		expect(readDerived(c2)).toBe(100)
		expect(c1Runs).toBe(2) // c1 had to confirm
		expect(c2Runs).toBe(1) // c2 did not
	})

	test('batch net-revert restores changedAt: consumers validate as unchanged', () => {
		let c1Runs = 0
		const a = cell(1)
		const c1 = makeDerived(() => {
			c1Runs++
			return readCell(a) * 10
		})
		expect(readDerived(c1)).toBe(10)
		batch(() => {
			writeCell(a, 5)
			writeCell(a, 1) // net-revert
		})
		expect(readDerived(c1)).toBe(10)
		expect(c1Runs).toBe(1) // the reverted batch cost no recompute
	})
})

describe('deps-from-eval invariant (test-side check, was a shipped dev assertion)', () => {
	/** The invariant: a derived's deps list is exactly what its last
	 * evaluation read, in read order — evaluation is the only site that
	 * creates or keeps dep edges. Checked from the test by walking the list,
	 * per the owner's rule that invariant nets live in tests, not the
	 * library. */
	const depsOf = (node: { deps?: unknown }) => {
		const out: unknown[] = []
		type L = { dep: { label?: string }; nextDep?: L }
		for (let l = (node as { deps?: L }).deps; l !== undefined; l = l.nextDep) {
			out.push(l.dep)
		}
		return out
	}

	test('a branch switch leaves exactly the taken branch, in read order', () => {
		const flag = cell(true, { label: 'flag' })
		const x = cell(1, { label: 'x' })
		const y = cell(2, { label: 'y' })
		const d = makeDerived(() => (readCell(flag) ? readCell(x) : readCell(y)))
		expect(readDerived(d)).toBe(1)
		expect(depsOf(d)).toEqual([flag, x])
		writeCell(flag, false)
		expect(readDerived(d)).toBe(2)
		expect(depsOf(d)).toEqual([flag, y]) // x pruned, y appended, order = read order
		writeCell(flag, true)
		expect(readDerived(d)).toBe(1)
		expect(depsOf(d)).toEqual([flag, x])
	})

	test('repeat reads within one evaluation keep one edge', () => {
		const x = cell(3, { label: 'x' })
		const d = makeDerived(() => readCell(x) + readCell(x) + readCell(x))
		expect(readDerived(d)).toBe(9)
		expect(depsOf(d)).toEqual([x])
	})
})
