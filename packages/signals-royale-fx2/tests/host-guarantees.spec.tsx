// @vitest-environment jsdom
/** Host guarantees: loud registration, unmount reclamation, quiescence. */
import { describe, expect, test } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import {
	createAtom,
	effect,
	flushScheduledEffects,
	nodeOf,
	read,
	type Atom,
} from 'signals-royale-fx2'
import { liveDraftCount, openDraft, runWithDraftWrites } from '../src/worlds.ts'
import {
	registerReactSignals,
	resetReactSignalsForTest,
	SignalsFrameworkProvider,
	startSignalTransition,
	useValue,
} from 'signals-royale-fx2/react'
import { broadcastDraft, registerRootConnection } from '../src/react/host.ts'
import { ReactRootConnectionContext } from '../src/react/SignalsFrameworkProvider.ts'
import { makeHarness, text } from './helpers.tsx'

function subCount(x: Atom<number>): number {
	let n = 0
	for (let l = nodeOf(x).subs; l !== undefined; l = l.nextSub) {
		n++
	}
	return n
}

describe('registration', () => {
	test('registers on stock React (no build marker) and is idempotent', () => {
		// This suite runs against an unpatched React build; registration must
		// succeed with no global handshake of any kind.
		const g = globalThis as Record<string, unknown>
		expect(g.__FX2_REACT_PROTOCOL__).toBeUndefined()
		expect(g.__FX2_MUTATION_WINDOW__).toBeUndefined()
		const h1 = registerReactSignals()
		const h2 = registerReactSignals()
		expect(h1).toBe(h2)
		expect('errors' in h1).toBe(false)
	})

	test('[falsify-first] reset preserves registration until the handle is disposed', async () => {
		resetReactSignalsForTest()
		const handle = registerReactSignals()
		resetReactSignalsForTest()

		const drafted = createAtom(0)
		startSignalTransition(() => drafted.set(1))
		expect(read(drafted)).toBe(0)
		await Promise.resolve()
		expect(read(drafted)).toBe(1)

		handle.dispose()
		resetReactSignalsForTest()
		const urgent = createAtom(0)
		startSignalTransition(() => urgent.set(1))
		expect(read(urgent)).toBe(1)
	})

	test('reset keeps disposal from a pending lifetime cleanup', async () => {
		resetReactSignalsForTest()
		const handle = registerReactSignals()
		let cleaned = false
		const observed = createAtom(0, {
			onObserved: () => () => {
				cleaned = true
				handle.dispose()
			},
		})
		const stop = effect(
			() => observed.get(),
			() => {},
		)
		flushScheduledEffects() // settle the onObserved activation now
		stop()

		resetReactSignalsForTest()
		expect(cleaned).toBe(true)
		const urgent = createAtom(0)
		startSignalTransition(() => urgent.set(1))
		expect(read(urgent)).toBe(1)
	})

	test('a detached connection record has no trace-only fields', async () => {
		resetReactSignalsForTest()
		registerReactSignals()
		let connection: React.ContextType<typeof ReactRootConnectionContext> = null
		function Child() {
			connection = React.useContext(ReactRootConnectionContext)
			return null
		}
		const container = document.createElement('div')
		const root = createRoot(container)
		try {
			await act(() => {
				root.render(
					<SignalsFrameworkProvider>
						<Child />
					</SignalsFrameworkProvider>,
				)
			})
			expect(Object.keys(connection!)).toEqual(['dispatch', 'committing'])
		} finally {
			await act(() => root.unmount())
		}
	})

	test('root commit bookkeeping precedes descendant layout effects', async () => {
		resetReactSignalsForTest()
		registerReactSignals()
		const atom = createAtom(0)
		const container = document.createElement('div')
		document.body.appendChild(container)
		const root = createRoot(container)
		const seen: Array<[rendered: number, committed: number, liveDrafts: number]> = []
		function Child() {
			const value = useValue(atom)
			React.useLayoutEffect(() => {
				seen.push([value, read(atom), liveDraftCount()])
			})
			return null
		}
		try {
			await act(() => {
				root.render(
					<SignalsFrameworkProvider>
						<Child />
					</SignalsFrameworkProvider>,
				)
			})
			expect(seen).toEqual([[0, 0, 0]])
			await act(() => {
				startSignalTransition(() => atom.set(1))
			})
			// The first-child marker retired the draft before this descendant
			// layout effect ran: the committed view already shows the fold.
			expect(seen).toContainEqual([1, 1, 0])
			expect(seen).not.toContainEqual([1, 0, 1])
		} finally {
			await act(() => root.unmount())
			container.remove()
		}
	})
})

describe('hosted draft lifetime', () => {
	test('a draft with no providers retires after its writing callback', async () => {
		resetReactSignalsForTest()
		const a = createAtom(0)
		const draft = openDraft()
		broadcastDraft(draft)
		runWithDraftWrites(draft, () => a.set(1))
		expect(liveDraftCount()).toBe(1)
		await Promise.resolve()
		expect(liveDraftCount()).toBe(0)
		expect(read(a)).toBe(1)
	})

	test('unregistering the last recipient retires its live drafts', () => {
		resetReactSignalsForTest()
		const delivered: number[] = []
		const unregister = registerRootConnection({
			committing: false,
			dispatch: (id) => delivered.push(id),
		})
		const a = createAtom(0)
		const draft = openDraft()
		broadcastDraft(draft)
		runWithDraftWrites(draft, () => a.set(2))
		expect(delivered).toEqual([draft.id])
		expect(liveDraftCount()).toBe(1)
		unregister()
		expect(liveDraftCount()).toBe(0)
		expect(read(a)).toBe(2)
	})
})

describe('unmount reclamation', () => {
	test('50 readers unmount back to zero subscriptions; transitions quiesce', async () => {
		const h = makeHarness()
		const a = createAtom(0)
		function Many() {
			const kids = []
			for (let i = 0; i < 50; i++) {
				kids.push(<Item key={i} />)
			}
			return <>{kids}</>
		}
		function Item() {
			return <i>{useValue(a)}</i>
		}
		const { root, container } = await h.mount(<Many />)
		expect(subCount(a)).toBe(50)
		await act(() => {
			startSignalTransition(() => a.set(1))
		})
		await act(async () => {})
		expect(text(container)).toContain('1')
		expect(liveDraftCount()).toBe(0) // retired at commit: quiescent
		expect(nodeOf(a).worldMemos).toBeUndefined()
		await act(() => {
			root.render(null)
		})
		expect(subCount(a)).toBe(0) // deterministic unsubscription at unmount
		await h.cleanup()
		expect(read(a)).toBe(1)
	})

	test('a full mount/write/transition/unmount cycle leaves no live drafts', async () => {
		const h = makeHarness()
		const a = createAtom(0)
		function App() {
			return <span>{useValue(a)}</span>
		}
		const m1 = await h.mount(<App />)
		const m2 = await h.mount(<App />)
		await act(() => {
			startSignalTransition(() => a.set(5))
		})
		await act(async () => {})
		expect(text(m1.container)).toBe('5')
		expect(text(m2.container)).toBe('5')
		expect(liveDraftCount()).toBe(0)
		await h.cleanup()
		expect(liveDraftCount()).toBe(0)
	})
})
