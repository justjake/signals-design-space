/** Shared test harness: registration, roots, act plumbing. */
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { flushScheduledEffects } from 'signals-royale-fx2'
import {
	registerReactSignals,
	resetReactSignalsForTest,
	wrapCreateRoot,
	type ReactSignalsHandle,
} from 'signals-royale-fx2/react'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export interface Harness {
	handle: ReactSignalsHandle
	containers: HTMLElement[]
	roots: Array<{ render(node: unknown): void; unmount(): void }>
	mount(node: React.ReactNode): Promise<{
		root: { render(node: unknown): void; unmount(): void }
		container: HTMLElement
	}>
	cleanup(): Promise<void>
}

const frameworkCreateRoot = wrapCreateRoot(createRoot as never)

export function makeHarness(): Harness {
	resetReactSignalsForTest()
	;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
	const handle = registerReactSignals()
	const containers: HTMLElement[] = []
	const roots: Array<{ render(node: unknown): void; unmount(): void }> = []
	return {
		handle,
		containers,
		roots,
		async mount(node) {
			const container = document.createElement('div')
			document.body.appendChild(container)
			const root = frameworkCreateRoot(container)
			containers.push(container)
			roots.push(root)
			await act(() => {
				root.render(node)
			})
			return { root, container }
		},
		async cleanup() {
			await act(() => {
				for (const r of roots) {
					r.unmount()
				}
			})
			for (const c of containers) {
				c.remove()
			}
		},
	}
}

export function text(container: HTMLElement): string {
	return (container.textContent ?? '').replace(/\s+/g, '')
}

export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; settled: boolean } {
	let resolve!: (v: T) => void
	const d = {
		promise: undefined as unknown as Promise<T>,
		settled: false,
		resolve: (v: T) => {
			d.settled = true
			resolve(v)
		},
	}
	d.promise = new Promise<T>((res) => {
		resolve = res
	})
	return d
}

export const tick = (ms = 0): Promise<void> => new Promise((res) => setTimeout(() => res(), ms))

/**
 * Drain both deferred lanes deterministically — requests that fell back
 * to the built-in timer pumps are not flushed by act(), so lane-delivered
 * handlers are asserted after this. Wrapped in act so handler writes that
 * re-render components stay inside it.
 */
export const flushEffects = (): Promise<void> =>
	act(async () => {
		flushScheduledEffects()
	})

export { act, React }
