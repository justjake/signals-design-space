// @vitest-environment jsdom

import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { Atom } from 'strata-signals'
import { trace } from '../../strata/src/trace.js'
import { resetForTest, useSignal } from '../src/index.js'

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

test('links a signal write to its React component delivery and root commit', async () => {
	const value = new Atom(0, { label: 'value' })
	const log = trace(value.runtime, 64)

	function App() {
		return <span>{useSignal(value)}</span>
	}

	await act(() => root.render(<App />))
	await act(() => value.set(1))
	expect(container.textContent).toBe('1')

	const delivery = log.why(value)
	expect(delivery[0]?.kind).toBe('component-render')
	expect(delivery[1]?.kind).toBe('write')
	expect(delivery[2]?.kind).toBe('batch-open')
	let committed = false
	const events = log.events()
	for (let i = 0; i < events.length; i++) {
		if (events[i]!.kind === 'root-commit') {
			committed = true
		}
	}
	expect(committed).toBe(true)
	log.stop()
})
