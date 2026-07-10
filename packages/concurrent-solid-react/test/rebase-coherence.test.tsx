// @vitest-environment jsdom
/**
 * The RCC-RT3.hold shape: a gate-held transition stages count+10 while an
 * urgent +1 commits alone. Pins committed-world coherence for memos over the
 * rebased signal — an urgent frame must never paint count=1 beside
 * doubled=0 (the committed-refresh pass keeps sync memos aligned).
 */
import { afterEach, beforeEach, expect, it } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { createRoot as createDomRoot, type Root } from 'react-dom/client'
import {
	createMemo,
	createRoot,
	createSignal,
	flush,
	registerConcurrentSolidReact,
	useSignal,
	type BridgeHandle,
} from '../src/index.js'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function deferred<T>() {
	let resolve!: (v: T) => void
	const promise = new Promise<T>((r) => (resolve = r))
	return { promise, resolve }
}

let handle: BridgeHandle
let roots: Array<{ root: Root; el: HTMLElement }> = []
beforeEach(() => {
	handle = registerConcurrentSolidReact()
})
afterEach(async () => {
	await act(async () => {
		for (const { root, el } of roots) {
			root.unmount()
			el.remove()
		}
	})
	roots = []
	handle.dispose()
	flush()
})

it('RT3.hold shape: verdict memo never observes count without doubled', async () => {
	const gate = deferred<string>()
	const { count, setCount, doubled, verdict, setFlag, blocker } = createRoot(() => {
		const [count, setCount] = createSignal(0)
		const doubled = createMemo(() => count() * 2)
		const verdict = createMemo(() => (doubled() === count() * 2 ? 'consistent' : 'TORN'))
		const [flag, setFlag] = createSignal(false)
		const blocker = createMemo(() => (flag() ? gate.promise : 'idle'))
		return { count, setCount, doubled, verdict, setFlag, blocker }
	})
	const frames: string[] = []
	function App() {
		const c = useSignal(count)
		const d = useSignal(doubled)
		const v = useSignal(verdict)
		const b = useSignal(blocker)
		frames.push(`${c}/${d}/${v}/${b}`)
		return (
			<span>
				{c}/{d}/{v}/{b}
			</span>
		)
	}
	const el = await mountApp(<App />)
	expect(el.textContent).toBe('0/0/consistent/idle')
	// hold: transition stages count+10 and suspends on the gate
	await act(async () => {
		React.startTransition(() => {
			setCount((c) => c + 10)
			setFlag(true)
		})
	})
	expect(el.textContent).toBe('0/0/consistent/idle')
	// urgent +1 while held
	await act(async () => {
		setCount((c) => c + 1)
	})
	// the committed pair stays coherent: doubled refreshed alongside count
	expect(el.textContent).toBe('1/2/consistent/idle')
	// release
	await act(async () => {
		gate.resolve('done')
		await gate.promise
	})
	for (const f of frames) expect(f).not.toContain('TORN')
	expect(el.textContent).toBe('11/22/consistent/done')
})

async function mountApp(node: React.ReactNode): Promise<HTMLElement> {
	const el = document.createElement('div')
	document.body.appendChild(el)
	const root = createDomRoot(el)
	roots.push({ root, el })
	await act(async () => {
		root.render(<React.Suspense fallback={<span>fallback</span>}>{node}</React.Suspense>)
	})
	return el
}
