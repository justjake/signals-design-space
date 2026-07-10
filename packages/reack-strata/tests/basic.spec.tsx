// @vitest-environment jsdom

import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { Atom } from 'strata-signals'
import { resetForTest, useSignal, useSignalEffect } from '../src/index'

;(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
	container = document.createElement('div')
	document.body.append(container)
	root = createRoot(container)
})

afterEach(async () => {
	await act(() => root.unmount())
	container.remove()
	resetForTest()
})

test('an urgent signal write schedules and commits its reader', async () => {
	const count = new Atom(0)
	let renders = 0

	function App() {
		renders++
		return <span>{useSignal(count)}</span>
	}

	await act(() => root.render(<App />))
	expect(container.textContent).toBe('0')
	expect(renders).toBe(1)

	await act(() => count.set(1))
	expect(container.textContent).toBe('1')
	expect(renders).toBe(2)
})

test('urgent work commits through a suspended transition and the transition rebases', async () => {
	const value = new Atom(1)
	const suspend = new Atom(false)
	let release!: () => void
	let settled = false
	const gate = new Promise<void>((resolve) => {
		release = () => {
			settled = true
			resolve()
		}
	})

	function App() {
		const current = useSignal(value)
		if (useSignal(suspend) && !settled) {
			throw gate
		}
		return <span>{current}</span>
	}

	await act(() =>
		root.render(
			<React.Suspense fallback={<i>waiting</i>}>
				<App />
			</React.Suspense>,
		),
	)
	expect(container.textContent).toBe('1')

	await act(() => {
		React.startTransition(() => {
			value.update((current) => current + 1)
			suspend.set(true)
		})
	})
	expect(container.textContent).toBe('1')

	await act(() => value.update((current) => current * 2))
	expect(container.textContent).toBe('2')

	await act(async () => {
		release()
		await gate
	})
	expect(container.textContent).toBe('4')
	expect(value.state).toBe(4)
})

test('a signal-only useSignalEffect update does not render its component', async () => {
	const value = new Atom(0)
	const seen: number[] = []
	let renders = 0

	function App() {
		renders++
		useSignalEffect(() => {
			seen.push(value.state)
		})
		return <span>stable</span>
	}

	await act(async () => {
		root.render(<App />)
		await Promise.resolve()
	})
	expect(seen).toEqual([0])
	expect(renders).toBe(1)

	await act(async () => {
		value.set(1)
		await new Promise((resolve) => setTimeout(resolve, 0))
	})
	expect(seen).toEqual([0, 1])
	expect(renders).toBe(1)
})

test('React and signal causes coalesce into one useSignalEffect run', async () => {
	const value = new Atom(0)
	const seen: string[] = []
	let setLabel!: React.Dispatch<React.SetStateAction<string>>

	function App() {
		const [label, set] = React.useState('a')
		setLabel = set
		useSignalEffect(() => {
			seen.push(`${label}:${value.state}`)
		}, [label])
		return <span>{label}</span>
	}

	await act(async () => {
		root.render(<App />)
		await Promise.resolve()
	})
	seen.length = 0

	await act(async () => {
		value.set(1)
		setLabel('b')
		await Promise.resolve()
		await Promise.resolve()
	})
	expect(seen).toEqual(['b:1'])
})

test('React subscriptions participate in one debounced lifetime observation', async () => {
	const events: string[] = []
	const value = new Atom(0, {
		effect: () => {
			events.push('start')
			return () => events.push('stop')
		},
	})

	function Reader() {
		return <span>{useSignal(value)}</span>
	}

	await act(async () => {
		root.render(
			<React.StrictMode>
				<Reader />
			</React.StrictMode>,
		)
		await Promise.resolve()
	})
	expect(events).toEqual(['start'])

	await act(async () => {
		root.render(null)
		await Promise.resolve()
	})
	expect(events).toEqual(['start', 'stop'])
})
