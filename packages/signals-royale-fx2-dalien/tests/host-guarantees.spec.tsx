// @vitest-environment jsdom
/** Host guarantees: loud registration, unmount reclamation, quiescence. */
import { describe, expect, test } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { nodeOf, createAtom, read, type Signal } from 'signals-royale-fx2-dalien'
import { liveDraftCount, openDraft, runInDraft, sealDraft } from '../src/worlds.ts'
import {
	registerReactSignals,
	resetReactSignalsForTest,
	startTransitionWrite,
	useValue,
} from 'signals-royale-fx2-dalien/react'
import { broadcastDraft, registerProvider } from '../src/react/host.ts'
import { nextSubscriber } from '../src/graph.ts'
import { makeHarness, text } from './helpers.tsx'

function subCount(x: Signal<number>): number {
	let n = 0
	for (let l = nodeOf(x).subs; l !== undefined; l = nextSubscriber(l)) {
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
	})
})

describe('hosted draft lifetime', () => {
	test('a draft with no providers retires after its writing scope', async () => {
		resetReactSignalsForTest()
		const a = createAtom(0)
		const draft = openDraft()
		broadcastDraft(draft)
		runInDraft(draft, () => a.set(1))
		sealDraft(draft)
		expect(liveDraftCount()).toBe(1)
		await Promise.resolve()
		expect(liveDraftCount()).toBe(0)
		expect(read(a)).toBe(1)
	})

	test('unregistering the last recipient retires its live drafts', () => {
		resetReactSignalsForTest()
		const delivered: number[] = []
		const unregister = registerProvider({
			container: null,
			dispatch: (id) => delivered.push(id),
		})
		const a = createAtom(0)
		const draft = openDraft()
		broadcastDraft(draft)
		runInDraft(draft, () => a.set(2))
		sealDraft(draft)
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
			startTransitionWrite(() => a.set(1))
		})
		await act(async () => {})
		expect(text(container)).toContain('1')
		expect(liveDraftCount()).toBe(0) // retired at commit: quiescent
		expect(nodeOf(a).worldMemos).toBeNull()
		await act(() => {
			root.render(null)
		})
		expect(subCount(a)).toBe(0) // deterministic unsubscription at unmount
		await h.cleanup()
		expect(h.handle.errors).toEqual([])
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
			startTransitionWrite(() => a.set(5))
		})
		await act(async () => {})
		expect(text(m1.container)).toBe('5')
		expect(text(m2.container)).toBe('5')
		expect(liveDraftCount()).toBe(0)
		await h.cleanup()
		expect(liveDraftCount()).toBe(0)
	})
})
