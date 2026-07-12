// @vitest-environment jsdom
/**
 * Production-round regressions.
 *
 * Tear family: latest()/isPending() in ANY render body must resolve that
 * pass's world or fall back to BASE. Wrong-toward-base is
 * acceptable; wrong-toward-stale-world or wrong-toward-drafts never is.
 * Each shape below renders a component that did NOT refresh the scope's
 * render-world note and asserts it cannot consume a stale one.
 *
 * Wake family: a transition's render passes re-render ONLY subscribers of
 * cells the transition drafted (plus what React re-renders for its own
 * reasons: pending uncommitted updates, cascades). Render counts on every
 * subscriber are the proof.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, deferred, makeHarness, text, tick, React, type Harness } from './helpers.tsx'
import { latest, read, createAtom } from 'signals-royale-fx2-dalien'
import { startSignalTransition, useValue } from 'signals-royale-fx2-dalien/react'
import { openDraft, runWithDraftWrites, sealDraft, type Draft } from '../src/worlds.ts'
import { broadcastDraft, draftWakeStats } from '../src/react/host.ts'

let h: Harness
beforeEach(() => {
	h = makeHarness()
})
afterEach(async () => {
	const errors = [...h.handle.errors]
	await h.cleanup()
	expect(errors).toEqual([])
})

/** A held transition over `a`: drafts a.set(2), suspends until gate. */
function makeHeld() {
	const a = createAtom(1)
	const hold = createAtom(false)
	const gate = deferred<void>()
	function Holder() {
		const v = useValue(a)
		const held = useValue(hold)
		if (held && !gate.settled) {
			throw gate.promise
		}
		return <b>h:{v};</b>
	}
	const start = () =>
		act(() => {
			startSignalTransition(() => {
				a.set(2)
				hold.set(true)
			})
		})
	const release = () =>
		act(async () => {
			gate.resolve()
			await gate.promise
		})
	return { a, Holder, start, release }
}

describe('tear: the render-world note is validity-gated', () => {
	test('an urgent pass over an unrelated subtree (same root) resolves base state', async () => {
		const { a, Holder, start, release } = makeHeld()
		const probed: number[] = []
		let bump!: () => void
		function NoHookProbe() {
			const [n, setN] = React.useState(0)
			bump = () => setN((x) => x + 1)
			if (n > 0) {
				probed.push(latest(a))
			} // sample only the urgent re-renders
			return <i>p:{n};</i>
		}
		const { container } = await h.mount(
			<>
				<React.Suspense fallback={null}>
					<Holder />
				</React.Suspense>
				<NoHookProbe />
			</>,
		)
		await start() // held: the transition pass noted its world and suspended
		// Urgent pass dirties ONLY the probe; the scope (and every fx2 hook)
		// bails out, so nothing refreshed the note for this pass.
		await act(() => bump())
		expect(text(container)).toContain('p:1;')
		expect(read(a)).toBe(1)
		expect(probed).toEqual([1]) // base state, never the held draft
		await release()
		expect(text(container)).toBe('h:2;p:1;')
	})

	test('two roots back-to-back: a hook-free second root resolves base state', async () => {
		const { Holder, a, start, release } = makeHeld()
		await h.mount(
			<React.Suspense fallback={null}>
				<Holder />
			</React.Suspense>,
		)
		await start()
		// A plain root (no SignalScope, zero hooks — plain latest() calls are
		// legal anywhere) rendered right after the transition pass: no pass of
		// this root ever refreshed any note.
		const sampled: number[] = []
		function Plain() {
			sampled.push(latest(a))
			return <i>plain</i>
		}
		const div = document.body.appendChild(document.createElement('div'))
		const plainRoot = createRoot(div)
		await act(() => {
			plainRoot.render(<Plain />)
		})
		expect(sampled).toEqual([1]) // base-state fallback, not the scoped draft
		await release()
		await act(() => plainRoot.unmount())
		div.remove()
	})

	test('interleaved passes: flushSync render while a transition pass is mid-flight', async () => {
		const { flushSync } = await import('react-dom')
		const a = createAtom(1)
		const items = createAtom(0)
		let itemRenders = 0
		function SlowItem({ k }: { k: number }) {
			itemRenders++
			const end = performance.now() + 4
			while (performance.now() < end) {
				/* burn a slice */
			}
			return <i>{k},</i>
		}
		function List() {
			const n = useValue(items)
			const kids = []
			for (let k = 0; k < n; k++) {
				kids.push(<SlowItem key={k} k={k} />)
			}
			return (
				<div>
					n:{n};{kids}
				</div>
			)
		}
		const { container } = await h.mount(<List />)
		// Root B: no scope, no fx2 hooks; re-rendered by flushSync mid-slice.
		const sampled: number[] = []
		let bump!: () => void
		function Probe() {
			const [n, setN] = React.useState(0)
			bump = () => setN((x) => x + 1)
			if (n > 0) {
				sampled.push(latest(a))
			}
			return <i>q:{n}</i>
		}
		const div = document.body.appendChild(document.createElement('div'))
		const probeRoot = createRoot(div)
		await act(() => {
			probeRoot.render(<Probe />)
		})
		;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
		try {
			startSignalTransition(() => {
				items.set(24)
				a.set(2)
			})
			const deadline = Date.now() + 5000
			while (itemRenders < 3 && Date.now() < deadline) {
				await tick(5)
			}
			expect(itemRenders).toBeGreaterThanOrEqual(3)
			expect(itemRenders).toBeLessThan(24) // the transition pass is mid-flight
			flushSync(() => bump())
			expect(sampled).toEqual([1]) // urgent interleave: base state, not the draft
			const done = Date.now() + 15000
			while (!text(container).includes('n:24;') && Date.now() < done) {
				await tick(10)
			}
			expect(text(container)).toContain('n:24;')
		} finally {
			;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
		}
		await act(() => probeRoot.unmount())
		div.remove()
	}, 30000)

	test('StrictMode double render: both invocations of an urgent pass resolve base state', async () => {
		const { a, Holder, start, release } = makeHeld()
		const probed: number[] = []
		let bump!: () => void
		function NoHookProbe() {
			const [n, setN] = React.useState(0)
			bump = () => setN((x) => x + 1)
			if (n > 0) {
				probed.push(latest(a))
			}
			return <i>p:{n};</i>
		}
		const { container } = await h.mount(
			<React.StrictMode>
				<React.Suspense fallback={null}>
					<Holder />
				</React.Suspense>
				<NoHookProbe />
			</React.StrictMode>,
		)
		await start()
		await act(() => bump())
		expect(probed.length).toBeGreaterThanOrEqual(1) // double-invoked in dev
		expect(probed.every((v) => v === 1)).toBe(true) // base state in every invocation
		await release()
		expect(text(container)).toBe('h:2;p:1;')
	})
})

describe('wake: transition passes re-render only drafted-cell subscribers', () => {
	const N = 8

	function makeGrid() {
		const cells = Array.from({ length: N }, () => createAtom(0))
		const renders = new Array<number>(N).fill(0)
		function Item({ i }: { i: number }) {
			renders[i]++
			return <i>{useValue(cells[i])};</i>
		}
		const grid = (
			<>
				{Array.from({ length: N }, (_, i) => (
					<Item key={i} i={i} />
				))}
			</>
		)
		return { cells, renders, grid }
	}

	test('N subscribers, one drafted cell: exactly that subscriber renders in the transition pass', async () => {
		const { cells, renders, grid } = makeGrid()
		const { container } = await h.mount(grid)
		expect(renders).toEqual(new Array(N).fill(1))
		await act(() => {
			startSignalTransition(() => cells[3].set(7))
		})
		await act(async () => {})
		expect(text(container)).toBe('0;0;0;7;0;0;0;0;')
		// One transition pass rendered subscriber 3 once; nobody else moved —
		// and retirement stayed a silent fold (no post-commit repair render).
		const expected = new Array(N).fill(1)
		expected[3] = 2
		expect(renders).toEqual(expected)
	})

	test('late append to a live rendered draft re-dispatches only to affected subscribers, in the owning transition', async () => {
		const { cells, renders, grid } = makeGrid()
		const hold = createAtom(false)
		const gate = deferred<void>()
		function Suspender() {
			const held = useValue(hold)
			if (held && !gate.settled) {
				throw gate.promise
			}
			return <b>s;</b>
		}
		const { container } = await h.mount(
			<>
				{grid}
				<React.Suspense fallback={null}>
					<Suspender />
				</React.Suspense>
			</>,
		)
		const mounted = [...renders]
		let draft!: Draft
		await act(() => {
			React.startTransition(() => {
				draft = openDraft()
				broadcastDraft(draft)
				runWithDraftWrites(draft, () => {
					cells[0].set(1)
					hold.set(true)
				})
				// Deliberately NOT sealed: the batch continues below.
			})
		})
		expect(text(container)).toBe('0;0;0;0;0;0;0;0;s;') // held, invisible
		// Late append from a plain event context (no ambient transition): the
		// wake must ride the OWNING transition's lane, so the committed DOM
		// stays untouched and untouched subscribers stay asleep.
		await act(() => {
			runWithDraftWrites(draft, () => cells[1].set(2))
			sealDraft(draft)
		})
		expect(text(container)).toBe('0;0;0;0;0;0;0;0;s;') // still held, still invisible
		for (let i = 2; i < N; i++) {
			expect(renders[i]).toBe(mounted[i])
		} // never woken
		await act(async () => {
			gate.resolve()
			await gate.promise
		})
		expect(text(container)).toBe('1;2;0;0;0;0;0;0;s;') // the whole batch lands together
		for (let i = 2; i < N; i++) {
			expect(renders[i]).toBe(mounted[i])
		} // silent fold
	})

	test('two interleaved transitions keep distinct audiences', async () => {
		const a = createAtom(0)
		const b = createAtom(0)
		const hold = createAtom(false)
		const gate = deferred<void>()
		let bRenders = 0
		function AReader() {
			const v = useValue(a)
			const held = useValue(hold)
			if (held && !gate.settled) {
				throw gate.promise
			}
			return <b>a:{v};</b>
		}
		function BReader() {
			bRenders++
			return <i>b:{useValue(b)};</i>
		}
		const { container } = await h.mount(
			<>
				<React.Suspense fallback={null}>
					<AReader />
				</React.Suspense>
				<BReader />
			</>,
		)
		await act(() => {
			startSignalTransition(() => {
				a.set(1)
				hold.set(true)
			})
		})
		expect(text(container)).toBe('a:0;b:0;') // T1 held
		expect(bRenders).toBe(1) // T1's wakes never reached b's subscriber
		await act(() => {
			startSignalTransition(() => b.set(2))
		})
		await act(async () => {})
		// T2 woke exactly b's subscriber; its commit rides behind T1's hold
		// because both drafts flow through the scope's one reducer queue and
		// React entangles same-queue transition updates (stock updater rules).
		expect(bRenders).toBeGreaterThan(1)
		expect(text(container)).toBe('a:0;b:0;')
		await act(async () => {
			gate.resolve()
			await gate.promise
		})
		expect(text(container)).toBe('a:1;b:2;') // both worlds land, each its own values
	})

	test('a same-cell write burst dispatches one draft-lane wake per subscriber, not one per write', async () => {
		const SUBS = 4
		const cell = createAtom(0)
		const renders = new Array<number>(SUBS).fill(0)
		function Sub({ i }: { i: number }) {
			renders[i]++
			return <i>{useValue(cell)};</i>
		}
		const { container } = await h.mount(
			<>
				{Array.from({ length: SUBS }, (_, i) => (
					<Sub key={i} i={i} />
				))}
			</>,
		)
		draftWakeStats.dispatches = 0
		let dispatchesBeforeRender = -1
		await act(() => {
			startSignalTransition(() => {
				for (let k = 1; k <= 100; k++) {
					cell.set(k)
				}
			})
			// Sampled synchronously after the writes, before React renders the
			// transition pass: what the burst itself cost in reducer dispatches.
			dispatchesBeforeRender = draftWakeStats.dispatches
		})
		expect(dispatchesBeforeRender).toBe(SUBS) // one per subscribing hook
		await act(async () => {})
		expect(text(container)).toBe('100;'.repeat(SUBS))
		expect(renders).toEqual(new Array(SUBS).fill(2)) // mount + one transition pass
	})

	test('late append to a cell the transition pass already rendered re-dispatches and lands', async () => {
		// Guards the dedup's clear-on-render contract: after a pass consumed the
		// draft, a new intent on the SAME cell must re-dispatch (a swallowed wake
		// would let React bail out and commit a stale frame).
		const { cells, renders, grid } = makeGrid()
		const hold = createAtom(false)
		const gate = deferred<void>()
		function Suspender() {
			const held = useValue(hold)
			if (held && !gate.settled) {
				throw gate.promise
			}
			return <b>s;</b>
		}
		const { container } = await h.mount(
			<>
				{grid}
				<React.Suspense fallback={null}>
					<Suspender />
				</React.Suspense>
			</>,
		)
		let draft!: Draft
		await act(() => {
			React.startTransition(() => {
				draft = openDraft()
				broadcastDraft(draft)
				runWithDraftWrites(draft, () => {
					cells[0].set(1)
					hold.set(true)
				})
			})
		})
		// The held transition pass rendered subscriber 0 with the draft value.
		const afterHeldPass = renders[0]
		expect(afterHeldPass).toBe(2)
		await act(() => {
			runWithDraftWrites(draft, () => cells[0].set(2))
			sealDraft(draft)
		})
		expect(renders[0]).toBe(afterHeldPass + 1) // exactly one more transition render
		expect(text(container)).toBe('0;0;0;0;0;0;0;0;s;') // still held, still invisible
		await act(async () => {
			gate.resolve()
			await gate.promise
		})
		expect(text(container)).toBe('2;0;0;0;0;0;0;0;s;') // the appended value committed
	})

	test('StrictMode: append after a double-rendered pass still lands', async () => {
		const { cells, grid } = makeGrid()
		const hold = createAtom(false)
		const gate = deferred<void>()
		function Suspender() {
			const held = useValue(hold)
			if (held && !gate.settled) {
				throw gate.promise
			}
			return <b>s;</b>
		}
		const { container } = await h.mount(
			<React.StrictMode>
				{grid}
				<React.Suspense fallback={null}>
					<Suspender />
				</React.Suspense>
			</React.StrictMode>,
		)
		let draft!: Draft
		await act(() => {
			React.startTransition(() => {
				draft = openDraft()
				broadcastDraft(draft)
				runWithDraftWrites(draft, () => {
					cells[0].set(1)
					hold.set(true)
				})
			})
		})
		expect(text(container)).toBe('0;0;0;0;0;0;0;0;s;') // held
		await act(() => {
			runWithDraftWrites(draft, () => cells[0].set(2))
			sealDraft(draft)
		})
		await act(async () => {
			gate.resolve()
			await gate.promise
		})
		expect(text(container)).toBe('2;0;0;0;0;0;0;0;s;') // no swallowed re-render
	})

	test('StrictMode: double-dispatched wakes net to a consistent commit', async () => {
		const { cells, renders, grid } = makeGrid()
		const { container } = await h.mount(<React.StrictMode>{grid}</React.StrictMode>)
		const mounted = [...renders]
		await act(() => {
			startSignalTransition(() => cells[2].set(5))
		})
		await act(async () => {})
		expect(text(container)).toBe('0;0;5;0;0;0;0;0;')
		for (let i = 0; i < N; i++) {
			if (i !== 2) {
				expect(renders[i]).toBe(mounted[i])
			} // untouched subscribers stay asleep
		}
		expect(renders[2]).toBeGreaterThan(mounted[2])
	})
})
