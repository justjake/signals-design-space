// @vitest-environment jsdom

import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'
import { Computed, refresh } from 'strata-signals'
import { resetForTest, useIsPending, useSignal } from '../src/index'

;(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ root: ReturnType<typeof createRoot>; container: HTMLDivElement }> = []

afterEach(async () => {
	for (let i = 0; i < mounted.length; i++) {
		await act(() => mounted[i]!.root.unmount())
	}
	for (let i = 0; i < mounted.length; i++) {
		mounted[i]!.container.remove()
	}
	mounted.length = 0
	resetForTest()
})

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

test('first load suspends once; refresh serves stale content with a pending indicator', async () => {
	const requests = new Map<number, ReturnType<typeof deferred<number>>>()
	let fetches = 0
	const data = new Computed<number>((context) => {
		let request = requests.get(context.refreshEpoch)
		if (request === undefined) {
			request = deferred<number>()
			requests.set(context.refreshEpoch, request)
			fetches++
		}
		return context.use(request.promise)
	})
	const container = document.createElement('div')
	document.body.append(container)
	const root = createRoot(container)
	mounted.push({ root, container })

	function App() {
		const value = useSignal(data)
		const pending = useIsPending(data)
		return (
			<span>
				{value}:{pending ? 'pending' : 'ready'}
			</span>
		)
	}

	await act(() =>
		root.render(
			<React.Suspense fallback={<i>loading</i>}>
				<App />
			</React.Suspense>,
		),
	)
	expect(container.textContent).toBe('loading')
	expect(fetches).toBe(1)

	await act(async () => {
		requests.get(0)!.resolve(10)
		await requests.get(0)!.promise
	})
	expect(container.textContent).toBe('10:ready')
	expect(fetches).toBe(1)

	await act(() => refresh(data))
	expect(container.textContent).toBe('10:pending')
	expect(fetches).toBe(2)

	await act(async () => {
		requests.get(1)!.resolve(20)
		await requests.get(1)!.promise
	})
	expect(container.textContent).toBe('20:ready')
	expect(fetches).toBe(2)
})
