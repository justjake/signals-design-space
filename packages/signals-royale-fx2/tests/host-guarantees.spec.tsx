// @vitest-environment jsdom
/** Host guarantees: loud registration, unmount reclamation, quiescence. */
import { describe, expect, test } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { nodeOf, signal, read, type Signal } from 'signals-royale-fx2'
import { liveDraftCount } from '../src/worlds.ts'
import { registerReactSignals, startTransitionWrite, useValue } from 'signals-royale-fx2/react'
import { makeHarness, text } from './helpers.tsx'

function subCount(x: Signal<number>): number {
	let n = 0
	for (let l = nodeOf(x).subs; l !== undefined; l = l.nextSub) n++
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

describe('unmount reclamation', () => {
	test('50 readers unmount back to zero subscriptions; transitions quiesce', async () => {
		const h = makeHarness()
		const a = signal(0)
		function Many() {
			const kids = []
			for (let i = 0; i < 50; i++) kids.push(<Item key={i} />)
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
		const a = signal(0)
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
