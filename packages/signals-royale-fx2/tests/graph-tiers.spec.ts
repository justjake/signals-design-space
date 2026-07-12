/**
 * Watched/unwatched graph mechanics: promotion into the watched state
 * (subscriber edges installed, push marks trustworthy) and demotion back
 * to unwatched (forward edges only, clock-gated validation on read).
 *
 * Test-name labels:
 * - [falsify-first]: written to fail against a known-bad implementation
 *   of the behavior under test, then made to pass.
 * - [parity]: pins internal structure or exact recompute counts.
 */
import { describe, expect, test } from 'vitest'
import {
	type AtomNode,
	type ComputedNode,
	type ConsumerNode,
	type Link,
	type ReactiveNode,
	Flag,
	NO_EVENT,
	batch,
	currentGraphChange,
	invalidateComputed,
	makeEffect,
	makeScheduledEffect,
	makeScope,
	observeNode,
	readAtom,
	readComputed,
	trackWorldRead,
	writeAtom,
} from '../src/graph.ts'
import {
	createAtom,
	createComputed,
	nodeOf,
	type AtomOptions,
	type Computed,
} from '../src/index.ts'
import { appendDraftIntent, discardDraft, openDraft, withWorld } from '../src/worlds.ts'

function atom<T>(initial: T | (() => T), opts?: AtomOptions<T>): AtomNode<T> {
	return nodeOf(createAtom(initial, opts)) as AtomNode<T>
}

function makeGraphComputed<T>(fn: ComputedNode<T>['fn']): ComputedNode<T> {
	return nodeOf(createComputed(fn)) as ComputedNode<T>
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
function depEdgeCount(sub: ConsumerNode, dep: ReactiveNode): number {
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

/** The tier invariant promote/demote must maintain: for atoms and computeds
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
		const a = atom(1)
		const d = makeGraphComputed(() => readAtom(a) * 2)
		expect(readComputed(d)).toBe(2) // caches while unwatched
		writeAtom(a, 2) // no back-edges: no push mark reaches d
		const stop = observeNode(d, () => {}) // subscribe without pulling
		expect(readComputed(d)).toBe(4)
		stop()
	})

	test('T2 [falsify-first] subscribing to a stale node delivers the pending edge once; a pull re-arms', () => {
		// Pre-rebuild failure: AssertionError: expected +0 to be 1 — the node
		// was stale when the subscriber arrived, and the wave's early-return on
		// pre-existing staleness meant the new subscriber never heard anything.
		const a = atom(1)
		const d = makeGraphComputed(() => readAtom(a) * 2)
		const stopEffect = makeEffect(() => void readComputed(d))
		batch(() => {
			writeAtom(a, 2) // marks d through the watched edge
			stopEffect() // demote runs while d is stale
		})
		let notifies = 0
		const stop = observeNode(d, () => notifies++)
		expect(notifies).toBe(1) // the missed staleness edge, delivered at subscribe
		expect(readComputed(d)).toBe(4) // pull re-arms the edge trigger
		writeAtom(a, 3)
		expect(notifies).toBe(2)
		stop()
	})

	test('T3 [falsify-first] promote validates transitively through the dep closure', () => {
		// Pre-rebuild failure: AssertionError: expected 20 to be 30 — the write
		// invalidated c -> d1 while everything was unwatched; promote linked the
		// closure without checking whether the flags deserved trust.
		const c = atom(1)
		const d1 = makeGraphComputed(() => readAtom(c) + 1)
		const d2 = makeGraphComputed(() => readComputed(d1) * 10)
		expect(readComputed(d2)).toBe(20)
		writeAtom(c, 2)
		const stop = observeNode(d2, () => {})
		expect(readComputed(d2)).toBe(30)
		stop()
	})
})

describe('two-tier graph: promote/demote structure', () => {
	test('atoms do not carry consumer-only graph state', () => {
		const source = atom(1)
		const computed = makeGraphComputed(() => readAtom(source))
		expect(Object.hasOwn(source, 'deps')).toBe(false)
		expect(Object.hasOwn(source, 'depsTail')).toBe(false)
		expect(Object.hasOwn(source, 'pokePass')).toBe(false)
		expect(Object.hasOwn(computed, 'deps')).toBe(true)
		expect(Object.hasOwn(computed, 'depsTail')).toBe(true)
		expect(Object.hasOwn(computed, 'pokePass')).toBe(true)
	})

	test('T4 [parity] promote links the dep closure; demote reverses it exactly', () => {
		const c = atom(1)
		const d1 = makeGraphComputed(() => readAtom(c) + 1)
		const d2 = makeGraphComputed(() => readComputed(d1) + 1)
		expect(readComputed(d2)).toBe(3)
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
		const c = atom(1)
		const d1 = makeGraphComputed(() => readAtom(c) + 1)
		const d2 = makeGraphComputed(() => readComputed(d1) + 1)
		const stop = observeNode(d2, () => {})
		expect(readComputed(d2)).toBe(3)
		stop() // Clean at demote: the next quiet read must short-circuit O(1)
		expect(d1.validAtGraphChange).toBe(currentGraphChange())
		expect(d2.validAtGraphChange).toBe(currentGraphChange())

		const stop2 = observeNode(d2, () => {})
		batch(() => {
			writeAtom(c, 2) // wave marks d1/d2 before the flush is due
			stop2() // stale at demote: force the up-walk on next read
		})
		expect(d1.validAtGraphChange).toBe(0)
		expect(d2.validAtGraphChange).toBe(0)
		expect(readComputed(d2)).toBe(4)
	})

	test('T6 [parity pin] recompute counts across watch -> demote -> quiet-read cycles', () => {
		let e1 = 0
		let e2 = 0
		const c = atom(1)
		const d1 = makeGraphComputed(() => (e1++, readAtom(c) + 1))
		const d2 = makeGraphComputed(() => (e2++, readComputed(d1) + 1))
		expect(readComputed(d2)).toBe(3)
		expect([e1, e2]).toEqual([1, 1])

		const stop = observeNode(d2, () => {})
		expect([e1, e2]).toEqual([1, 1]) // subscribing evaluates nothing
		writeAtom(c, 2)
		expect([e1, e2]).toEqual([1, 1]) // marking is lazy
		expect(readComputed(d2)).toBe(4)
		expect([e1, e2]).toEqual([2, 2])

		stop() // Clean at demote
		expect(readComputed(d2)).toBe(4) // quiet read: no walk, no recompute
		expect(readComputed(d2)).toBe(4)
		expect([e1, e2]).toEqual([2, 2])

		writeAtom(c, 3) // unwatched: versions move, no marks
		expect(readComputed(d2)).toBe(5) // up-walk finds the moved version
		expect([e1, e2]).toEqual([3, 3])

		writeAtom(c, 3) // equal write: no version movement
		expect(readComputed(d2)).toBe(5)
		expect([e1, e2]).toEqual([3, 3])
	})

	test('T8 [parity] quiet reads short-circuit: zero recomputes on a wide validated graph', () => {
		const atoms = Array.from({ length: 50 }, (_, i) => atom(i))
		let evals = 0
		const wide = makeGraphComputed(() => {
			evals++
			let sum = 0
			for (const c of atoms) {
				sum += readAtom(c)
			}
			return sum
		})
		expect(readComputed(wide)).toBe(1225)
		expect(evals).toBe(1)
		// Precondition of the O(1) return: Clean plus a current validAtGraphChange reading.
		expect(wide.validAtGraphChange).toBe(currentGraphChange())
		expect((wide.flags & (Flag.StaleCheck | Flag.StaleDirty)) === 0).toBe(true)
		for (let i = 0; i < 100; i++) {
			readComputed(wide)
		}
		expect(evals).toBe(1)
	})

	test('T12 [parity] promoting a computing node with an unmatched deps suffix stays consistent', () => {
		const x = atom(1)
		const y = atom(2)
		let subscribeNow = false
		let stop: (() => void) | undefined
		let notified = 0
		const d: ComputedNode<number> = makeGraphComputed(() => {
			const vx = readAtom(x)
			if (subscribeNow) {
				subscribeNow = false
				// Subscribe to the node mid-evaluation: promote walks the full deps
				// list, including the y edge beyond the cursor that this pass will
				// not re-read.
				stop = observeNode(d, () => notified++)
				return vx
			}
			return vx + readAtom(y)
		})
		expect(readComputed(d)).toBe(3) // deps [x, y], unwatched
		subscribeNow = true
		writeAtom(x, 5) // unwatched: versions move, no marks
		expect(readComputed(d)).toBe(5) // mid-eval promote; trimDeps drops the y suffix
		expect(y.subs).toBeUndefined()
		expect(y.observerCount).toBe(0) // suffix unlink kept observer bookkeeping symmetric
		expect(x.observerCount).toBe(1)
		expect(d.observerCount).toBe(1)
		expect(isWatched(d) && isWatched(x)).toBe(true)
		expect(isWatched(y)).toBe(false)
		expectTierInvariant([x, y, d])

		writeAtom(y, 9) // the dropped edge must not notify
		expect(notified).toBe(0)
		writeAtom(x, 6) // the kept edge must
		expect(notified).toBe(1)
		// The pull re-evaluates the full body: y is re-read, re-linked, and —
		// because d is watched now — promoted back into the watched tier.
		expect(readComputed(d)).toBe(15)
		expect(y.observerCount).toBe(1)
		expect(isWatched(y)).toBe(true)
		expectTierInvariant([x, y, d])
		stop!()
		expect(y.observerCount).toBe(0)
	})
})

describe('two-tier graph: tracking and waves', () => {
	test('T9 [falsify-first] non-adjacent re-reads in one watched pass dedup to a single edge', () => {
		// Pre-rebuild failure: AssertionError: expected 2 to be 1 — the second
		// read of `a` (non-adjacent, past the cursor) created a duplicate
		// watched edge, double-counting the observer.
		const a = atom(1)
		const b = atom(2)
		const d = makeGraphComputed(() => readAtom(a) + readAtom(b) + readAtom(a))
		const stop = observeNode(d, () => {})
		expect(readComputed(d)).toBe(4)
		expect(subEdgeCount(a, d)).toBe(1)
		expect(depEdgeCount(d, a)).toBe(1)
		expect(a.observerCount).toBe(1)
		// The dedup is stable across re-evaluations.
		writeAtom(b, 5)
		expect(readComputed(d)).toBe(7)
		expect(subEdgeCount(a, d)).toBe(1)
		expect(a.observerCount).toBe(1)
		stop()
		expect(a.observerCount).toBe(0)
	})

	test('T10 [parity pin] render notification is edge-triggered; a pull re-arms', () => {
		const a = atom(1)
		const d = makeGraphComputed(() => readAtom(a) * 2)
		expect(readComputed(d)).toBe(2) // Clean before subscribing: no wake due
		let n = 0
		const stop = observeNode(d, () => n++)
		writeAtom(a, 2)
		const afterFirst = n
		writeAtom(a, 3) // no pull between: the edge already fired
		const afterSecond = n
		expect(readComputed(d)).toBe(6) // re-arm
		writeAtom(a, 4)
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
		// computeds over the drafted atom), so its walk needs the same
		// iterative discipline. Pre-change failure quoted in the commit.
		const DEPTH = 150_000
		const base = createAtom(0)
		const disposers: Array<() => void> = []
		let topNotified = 0
		const wakes: number[] = []
		const cutoffBreaker = atom(0)
		let prev: Computed<number> = base
		for (let i = 0; i < DEPTH; i++) {
			const p = prev
			const d = createComputed(() => p.get() + 1)
			const node = nodeOf(d)
			disposers.push(
				i === DEPTH - 1
					? observeNode(
							node,
							() => topNotified++,
							(id) => wakes.push(id),
						)
					: observeNode(node, () => {}),
			)
			d.get()
			prev = d
		}
		const draft = openDraft()
		// Isolate the iterative poke walk: the cutoff's dependency certificates
		// are a separate concern from this deliberately 150k-deep traversal.
		writeAtom(cutoffBreaker, 1)
		appendDraftIntent(draft, nodeOf(base) as AtomNode<unknown>, 'set', 1)
		expect(topNotified).toBe(1) // the poke reached the deepest subscriber
		expect(wakes).toEqual([draft.id]) // and so did the draft-lane wake
		discardDraft(draft.id) // rollback pokes the same closure again
		expect(topNotified).toBe(2)
		for (let i = disposers.length - 1; i >= 0; i--) {
			disposers[i]()
		}
		expect(subEdgeCount(nodeOf(base))).toBe(0)
	})

	test('T11 [falsify-first] a write through a deep watched chain completes', () => {
		// Pre-rebuild failure: RangeError: Maximum call stack size exceeded —
		// the recursive wave overflowed at this depth; the iterative propagate
		// carries it. The final read also guards pull-side validation.
		const DEPTH = 150_000
		const base = atom(0)
		const side = atom(0)
		const disposers: Array<() => void> = []
		let topNotified = 0
		let prev: ReactiveNode = makeGraphComputed(() => readAtom(base) + readAtom(side))
		disposers.push(observeNode(prev, () => {}))
		readComputed(prev as ComputedNode<number>)
		for (let i = 0; i < DEPTH; i++) {
			const p = prev
			const d = makeGraphComputed(
				() =>
					((p.flags & Flag.KindAtom) !== 0
						? readAtom(p as AtomNode<number>)
						: readComputed(p as ComputedNode<number>)) + 1,
			)
			// Watch and evaluate incrementally so promote and pull stay depth-1;
			// only the write's wave spans the whole chain.
			disposers.push(observeNode(d, i === DEPTH - 1 ? () => topNotified++ : () => {}))
			readComputed(d)
			prev = d
		}
		expect((prev as ComputedNode<number>).value).toBe(DEPTH)
		writeAtom(base, 1)
		expect(topNotified).toBe(1)
		expect(readComputed(prev as ComputedNode<number>)).toBe(DEPTH + 1)
		// Reverse order keeps demote cascades depth-1 as well.
		for (let i = disposers.length - 1; i >= 0; i--) {
			disposers[i]()
		}
		expect(subEdgeCount(base)).toBe(0)
	})

	test('T11c reentrant disposal cannot strand the chain top stale', () => {
		const base = createAtom(1)
		const side = createAtom(0)
		let stop = () => {}
		const first = createComputed(() => {
			const value = base.get()
			if (value === 2) {
				stop()
			}
			return value * 10 + side.get()
		})
		let top = first
		for (let i = 0; i < 20; i++) {
			const previous = top
			top = createComputed(() => previous.get() + 1)
		}
		stop = makeEffect(() => void top.get())
		base.set(2)
		expect((nodeOf(top) as ComputedNode<number>).value).toBe(40)
		expect(top.get()).toBe(40)
	})
})

describe('two-tier graph: render-notify delivery re-entrancy', () => {
	// A subscriber's onNotify may write, and that write flushes re-entrantly (the
	// effect stage is guarded by the flushing flag; delivery is not). These
	// tests pin the wave-snapshot contract: a wave's iteration never sees
	// subscribers marked during its own delivery — they are delivered by the nested
	// wave the marking write triggers, exactly once.

	test('Q1 [guard: passes pre- and post-storage-change] a subscriber marked during delivery is delivered by the nested wave, not the current iteration', () => {
		const x = atom(0)
		const y = atom(0)
		const events: string[] = []
		const stopL1 = observeNode(x, () => {
			events.push('L1:begin')
			writeAtom(y, readAtom(y) + 1) // marks L2; flushes re-entrantly
			events.push('L1:end')
		})
		const stopL2 = observeNode(y, () => events.push('L2'))
		const stopL3 = observeNode(x, () => events.push('L3'))
		writeAtom(x, 1)
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
		const x = atom(0)
		const y = atom(0)
		const z = atom(0)
		const events: string[] = []
		const stops: Array<() => void> = []
		stops.push(
			observeNode(x, () => {
				events.push('L1:begin')
				writeAtom(y, readAtom(y) + 1) // marks L2
				events.push('L1:end')
			}),
		)
		stops.push(
			observeNode(y, () => {
				events.push('L2:begin')
				writeAtom(z, readAtom(z) + 1) // marks L4a, L4b two waves deep
				events.push('L2:end')
			}),
		)
		stops.push(observeNode(z, () => events.push('L4a')))
		stops.push(observeNode(z, () => events.push('L4b')))
		stops.push(observeNode(x, () => events.push('L5')))
		writeAtom(x, 1)
		expect(events).toEqual(['L1:begin', 'L2:begin', 'L4a', 'L4b', 'L2:end', 'L1:end', 'L5'])
		for (const stop of stops) {
			stop()
		}
	})
})

describe('watcher ownership', () => {
	test('failed watcher setup releases every edge before rethrowing', () => {
		const source = atom(0)
		expect(() =>
			makeEffect(() => {
				readAtom(source)
				throw new Error('effect setup')
			}),
		).toThrow('effect setup')
		expect(source.observerCount).toBe(0)

		expect(() =>
			makeScope(() => {
				makeEffect(() => {
					readAtom(source)
				})
				throw new Error('scope setup')
			}),
		).toThrow('scope setup')
		expect(source.observerCount).toBe(0)

		const computed = makeGraphComputed<unknown>(() => readAtom(source))
		readComputed(computed)
		invalidateComputed(computed, NO_EVENT)
		expect(() =>
			observeNode(computed, () => {
				throw new Error('subscription setup')
			}),
		).toThrow('subscription setup')
		expect(computed.observerCount).toBe(0)
		expect(source.observerCount).toBe(0)
	})

	test('a throwing child cleanup does not retain its siblings', () => {
		const first = atom(0)
		const second = atom(0)
		const stop = makeScope(() => {
			makeEffect(() => {
				readAtom(first)
				return () => {
					throw new Error('cleanup')
				}
			})
			makeEffect(() => {
				readAtom(second)
			})
		})
		expect([first.observerCount, second.observerCount]).toEqual([1, 1])
		expect(stop).toThrow('cleanup')
		expect([first.observerCount, second.observerCount]).toEqual([0, 0])
		expect(stop).not.toThrow()
	})

	test('an effect replaces the children owned by its previous run', () => {
		const source = atom(0)
		const events: string[] = []
		const stop = makeEffect(() => {
			const value = readAtom(source)
			events.push(`parent:${value}`)
			void makeEffect(() => {
				events.push(`child:${value}`)
				return () => events.push(`cleanup:${value}`)
			})
		})

		writeAtom(source, 1)
		expect(events).toEqual([
			'parent:0',
			'child:0',
			'cleanup:0',
			'parent:1',
			'child:1',
		])
		stop()
		expect(events.at(-1)).toBe('cleanup:1')
	})

	test('an effect created after its owner disposes itself remains independent', () => {
		const parentSource = atom(0)
		const childSource = atom(0)
		let parentRuns = 0
		let childRuns = 0
		let stopParent = () => {}
		let stopChild = () => {}
		stopParent = makeEffect(() => {
			readAtom(parentSource)
			parentRuns++
			if (parentRuns === 2) {
				stopParent()
				stopChild = makeEffect(() => {
					readAtom(childSource)
					childRuns++
				})
			}
		})

		writeAtom(parentSource, 1)
		writeAtom(parentSource, 2)
		writeAtom(childSource, 1)
		stopParent()
		writeAtom(childSource, 2)
		expect([parentRuns, childRuns]).toEqual([2, 3])
		stopChild()
	})
})

describe('scheduled effect tracking', () => {
	test('base invalidations validate equality before scheduling the deferred body', () => {
		const source = atom(1)
		let computedRuns = 0
		const parity = makeGraphComputed(() => {
			computedRuns++
			return readAtom(source) & 1
		})
		let schedules = 0
		let bodyRuns = 0
		const effect = makeScheduledEffect(
			() => schedules++,
			() => {},
		)
		const first = effect.run(() => {
			bodyRuns++
			readComputed(parity)
		})
		expect(first?.dep).toBe(parity)
		expect([computedRuns, bodyRuns, schedules]).toEqual([1, 1, 0])

		writeAtom(source, 3) // parity stays odd: validate, then cut off
		expect([computedRuns, bodyRuns, schedules]).toEqual([2, 1, 0])
		writeAtom(source, 4) // parity changes: schedule, but do not run the body
		expect([computedRuns, bodyRuns, schedules]).toEqual([3, 1, 1])
		effect.run(() => {
			bodyRuns++
			readComputed(parity)
		})
		expect(bodyRuns).toBe(2)
		effect.dispose()
		expect(source.observerCount).toBe(0)
	})

	test('world reads link explicitly and draft ids use the separate wake callback', () => {
		const source = atom(1)
		let schedules = 0
		const wakes: number[] = []
		const effect = makeScheduledEffect(
			() => schedules++,
			(id) => wakes.push(id),
		)
		const deps = effect.run(() => trackWorldRead(source))
		expect(deps?.dep).toBe(source)
		expect(source.observerCount).toBe(1)

		const draft = openDraft()
		appendDraftIntent(draft, source as AtomNode<unknown>, 'set', 2)
		expect(schedules).toBe(0) // the draft wake is the write-time host channel
		expect(wakes).toEqual([draft.id])
		discardDraft(draft.id)
		expect(schedules).toBe(1) // no wake: refresh the root-relative world directly
		expect(wakes).toEqual([draft.id]) // discard pokes but carries no new id
		effect.dispose()
		expect(source.observerCount).toBe(0)
	})

	test('run replaces the tracked dependency set and dispose unlinks it', () => {
		const left = atom(0)
		const right = atom(0)
		let schedules = 0
		const effect = makeScheduledEffect(
			() => schedules++,
			() => {},
		)
		effect.run(() => trackWorldRead(left))
		const deps = effect.run(() => trackWorldRead(right))
		expect(deps?.dep).toBe(right)
		expect([left.observerCount, right.observerCount]).toEqual([0, 1])
		writeAtom(left, 1)
		expect(schedules).toBe(0)
		writeAtom(right, 1)
		expect(schedules).toBe(1)
		effect.dispose()
		expect(right.observerCount).toBe(0)
	})

	test('phase reruns clean up the previous body and dispose cleans up the last', () => {
		const source = atom(0)
		const events: string[] = []
		const effect = makeScheduledEffect(
			() => events.push('schedule'),
			() => {},
		)
		effect.run(() => {
			events.push('run:0')
			readAtom(source)
			return () => events.push('cleanup:0')
		})
		writeAtom(source, 1)
		expect(events).toEqual(['run:0', 'schedule'])
		effect.run(() => {
			events.push('run:1')
			readAtom(source)
			return () => events.push('cleanup:1')
		})
		expect(events).toEqual(['run:0', 'schedule', 'cleanup:0', 'run:1'])
		effect.dispose()
		expect(events).toEqual(['run:0', 'schedule', 'cleanup:0', 'run:1', 'cleanup:1'])
		expect(source.observerCount).toBe(0)
	})

	test('cleanup reads do not become committed-world wake sources', () => {
		const marker = atom(0)
		const mainSource = createAtom(1)
		const hiddenSource = createAtom(1)
		const main = createComputed(() => mainSource.get())
		const hidden = createComputed(() => hiddenSource.get())
		const draft = openDraft()
		appendDraftIntent(draft, marker as AtomNode<unknown>, 'set', 1)
		let schedules = 0
		let wakes = 0
		const effect = makeScheduledEffect(
			() => schedules++,
			() => wakes++,
		)
		withWorld(draft.world, () =>
			effect.run(() => {
				main.get()
				return () => {
					hidden.get()
				}
			}),
		)
		withWorld(draft.world, () => effect.run(() => void main.get()))
		expect(nodeOf(hiddenSource).observerCount).toBe(0)
		hiddenSource.set(2)
		expect([schedules, wakes]).toEqual([0, 0])
		effect.dispose()
		discardDraft(draft.id)
	})
})

describe('watermark validation ordering (the changedAt/validAt discipline)', () => {
	test('lazy chain: deps freshen before their readings are compared', () => {
		// a → c1 → c2, all unwatched. After a write, reading c2 must freshen
		// c1 first (its recompute stamps changedAt with the current clock)
		// and only then compare; comparing before freshening would miss the
		// change.
		let c1Runs = 0
		let c2Runs = 0
		const a = atom(1)
		const c1 = makeGraphComputed(() => {
			c1Runs++
			return readAtom(a) * 10
		})
		const c2 = makeGraphComputed(() => {
			c2Runs++
			return readComputed(c1) + 1
		})
		expect(readComputed(c2)).toBe(11)
		expect([c1Runs, c2Runs]).toEqual([1, 1])
		writeAtom(a, 2)
		expect(readComputed(c2)).toBe(21)
		expect([c1Runs, c2Runs]).toEqual([2, 2])
	})

	test('equality cutoff does not advance changedAt: downstream skips recompute', () => {
		// c1 collapses distinct inputs; its recompute must not advance its
		// changedAt reading, so c2 validates as unchanged and never re-runs.
		let c1Runs = 0
		let c2Runs = 0
		const a = atom(1)
		const c1 = makeGraphComputed(() => {
			c1Runs++
			return readAtom(a) % 2
		})
		const c2 = makeGraphComputed(() => {
			c2Runs++
			return readComputed(c1) * 100
		})
		expect(readComputed(c2)).toBe(100)
		writeAtom(a, 3) // parity unchanged
		expect(readComputed(c2)).toBe(100)
		expect(c1Runs).toBe(2) // c1 had to confirm
		expect(c2Runs).toBe(1) // c2 did not
	})

	test('a computed read between a write and its batch net-revert cannot leave a stale cache', () => {
		const a = atom(1)
		const c1 = makeGraphComputed(() => readAtom(a) * 10)
		expect(readComputed(c1)).toBe(10)
		batch(() => {
			writeAtom(a, 5)
			expect(readComputed(c1)).toBe(50)
			writeAtom(a, 1) // net-revert
		})
		expect(readComputed(c1)).toBe(10)
	})
})

describe('deps-from-eval invariant (test-side check, was a shipped dev assertion)', () => {
	/** The invariant: a computed's deps list is exactly what its last
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
		const flag = atom(true, { label: 'flag' })
		const x = atom(1, { label: 'x' })
		const y = atom(2, { label: 'y' })
		const d = makeGraphComputed(() => (readAtom(flag) ? readAtom(x) : readAtom(y)))
		expect(readComputed(d)).toBe(1)
		expect(depsOf(d)).toEqual([flag, x])
		writeAtom(flag, false)
		expect(readComputed(d)).toBe(2)
		expect(depsOf(d)).toEqual([flag, y]) // x pruned, y appended, order = read order
		writeAtom(flag, true)
		expect(readComputed(d)).toBe(1)
		expect(depsOf(d)).toEqual([flag, x])
	})

	test('repeat reads within one evaluation keep one edge', () => {
		const x = atom(3, { label: 'x' })
		const d = makeGraphComputed(() => readAtom(x) + readAtom(x) + readAtom(x))
		expect(readComputed(d)).toBe(9)
		expect(depsOf(d)).toEqual([x])
	})
})
