// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createRoot } from 'react-dom/client'
import { committed, createAtom, createComputed, latest, nodeOf, read } from 'signals-royale-fx2'
import {
	SignalsFrameworkProvider,
	startSignalTransition,
	useSignalEffect,
	useSignalLayoutEffect,
	useValue,
} from 'signals-royale-fx2/react'
import { act, deferred, makeHarness, React, type Harness } from './helpers.tsx'

let h: Harness
beforeEach(() => {
	h = makeHarness()
})
afterEach(async () => {
	await h.cleanup()
})

describe('scheduled React signal effects', () => {
	class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
		state = { failed: false }
		static getDerivedStateFromError() {
			return { failed: true }
		}
		render() {
			return this.state.failed ? null : this.props.children
		}
	}

	test('graph flush only schedules; layout follows root commit and passive follows layout', async () => {
		const atom = createAtom(0)
		const events: string[] = []
		let container: HTMLElement | undefined
		function App() {
			useSignalLayoutEffect(() => {
				events.push(
					`layout:${atom.get()}:${container === undefined ? 'mount' : committed(atom, container)}`,
				)
			})
			useSignalEffect(() => {
				events.push(`passive:${atom.get()}`)
			})
			return null
		}
		const mounted = await h.mount(<App />)
		container = mounted.container
		expect(events).toEqual(['layout:0:mount', 'passive:0'])
		events.length = 0
		await act(() => {
			events.push('write:start')
			atom.set(1)
			events.push('write:end')
			// The graph flush may schedule React work, but never invokes either
			// user effect body itself.
			expect(events).toEqual(['write:start', 'write:end'])
		})
		expect(events).toEqual(['write:start', 'write:end', 'layout:1:1', 'passive:1'])
		events.length = 0
		await act(() => {
			startSignalTransition(() => {
				events.push('transition:start')
				atom.set(2)
				events.push('transition:end')
			})
			expect(events).toEqual(['transition:start', 'transition:end'])
		})
		expect(events).toEqual(['transition:start', 'transition:end', 'layout:2:2', 'passive:2'])
	})

	test('cleanup precedes each rerun and the final cleanup runs on unmount', async () => {
		const atom = createAtom(0)
		const events: string[] = []
		function App() {
			useSignalLayoutEffect(() => {
				const value = atom.get()
				events.push(`layout:run:${value}`)
				return () => events.push(`layout:cleanup:${value}`)
			})
			useSignalEffect(() => {
				const value = atom.get()
				events.push(`passive:run:${value}`)
				return () => events.push(`passive:cleanup:${value}`)
			})
			return null
		}
		const { root } = await h.mount(<App />)
		expect(events).toEqual(['layout:run:0', 'passive:run:0'])
		events.length = 0
		await act(() => atom.set(1))
		expect(events).toEqual([
			'layout:cleanup:0',
			'layout:run:1',
			'passive:cleanup:0',
			'passive:run:1',
		])
		await act(() => root.render(null))
		expect(events).toEqual([
			'layout:cleanup:0',
			'layout:run:1',
			'passive:cleanup:0',
			'passive:run:1',
			'layout:cleanup:1',
			'passive:cleanup:1',
		])
	})

	test('latest reads are tracked in both React effect phases', async () => {
		const atom = createAtom(0)
		const layout: number[] = []
		const passive: number[] = []
		function App() {
			useSignalLayoutEffect(() => {
				layout.push(latest(atom))
			})
			useSignalEffect(() => {
				passive.push(latest(atom))
			})
			return null
		}
		await h.mount(<App />)
		expect(layout).toEqual([0])
		expect(passive).toEqual([0])
		await act(() => atom.set(1))
		expect(layout).toEqual([0, 1])
		expect(passive).toEqual([0, 1])
	})

	test('a dependency write from the body queues a later React-phase rerun', async () => {
		const atom = createAtom(0)
		const seen: number[] = []
		function App() {
			useSignalEffect(() => {
				const value = atom.get()
				seen.push(value)
				if (value === 0) {
					atom.set(1)
				}
			})
			return null
		}
		await h.mount(<App />)
		expect(seen).toEqual([0, 1])
	})

	test('dependency snapshots shrink and expand with the watcher links', async () => {
		for (const phase of ['layout', 'passive'] as const) {
			const wide = createAtom(true)
			const first = createAtom(0)
			const second = createAtom(0)
			const seen: string[] = []
			function App() {
				const usePhase = phase === 'layout' ? useSignalLayoutEffect : useSignalEffect
				usePhase(() => {
					const isWide = wide.get()
					const values = `${isWide}:${first.get()}`
					seen.push(isWide ? `${values}:${second.get()}` : values)
				})
				return null
			}
			await h.mount(<App />)
			expect(seen, phase).toEqual(['true:0:0'])
			await act(() => wide.set(false))
			expect(seen, phase).toEqual(['true:0:0', 'false:0'])
			await act(() => second.set(1))
			expect(seen, phase).toEqual(['true:0:0', 'false:0'])
			await act(() => wide.set(true))
			expect(seen, phase).toEqual(['true:0:0', 'false:0', 'true:0:1'])
			await act(() => second.set(2))
			expect(seen, phase).toEqual(['true:0:0', 'false:0', 'true:0:1', 'true:0:2'])
		}
	})

	test('a throwing initial body disposes its watcher in either phase', async () => {
		for (const phase of ['layout', 'passive'] as const) {
			const atom = createAtom(0)
			function Broken() {
				const usePhase = phase === 'layout' ? useSignalLayoutEffect : useSignalEffect
				usePhase(() => {
					atom.get()
					throw new Error(`${phase} boom`)
				})
				return null
			}
			await h.mount(
				<Boundary>
					<Broken />
				</Boundary>,
			)
			expect(nodeOf(atom).observerCount, phase).toBe(0)
		}
	})

	test('a held transition exposes no draft value to either effect phase', async () => {
		const atom = createAtom(0)
		const hold = createAtom(false)
		const gate = deferred<void>()
		const events: string[] = []
		function Effects() {
			useSignalLayoutEffect(() => {
				events.push(`layout:${atom.get()}`)
			})
			useSignalEffect(() => {
				events.push(`passive:${atom.get()}`)
			})
			return null
		}
		function Suspender() {
			if (useValue(hold) && !gate.settled) {
				throw gate.promise
			}
			return null
		}
		await h.mount(
			<React.Suspense fallback={null}>
				<Effects />
				<Suspender />
			</React.Suspense>,
		)
		expect(events).toEqual(['layout:0', 'passive:0'])
		events.length = 0
		await act(() => {
			startSignalTransition(() => {
				atom.set(1)
				hold.set(true)
			})
		})
		expect(events).toEqual([])
		expect(read(atom)).toBe(0)
		expect(latest(atom)).toBe(1)
		await act(async () => {
			gate.resolve()
			await gate.promise
		})
		expect(events).toEqual(['layout:1', 'passive:1'])
	})

	test('an effect mounted urgently while a transition is held observes its later commit', async () => {
		const atom = createAtom(0)
		const hold = createAtom(false)
		const gate = deferred<void>()
		const seen: number[] = []
		let showEffect!: (show: boolean) => void
		function Effect() {
			useSignalLayoutEffect(() => {
				seen.push(atom.get())
			})
			return null
		}
		function Suspender() {
			if (useValue(hold) && !gate.settled) {
				throw gate.promise
			}
			return null
		}
		function App() {
			const [show, setShow] = React.useState(false)
			showEffect = setShow
			return (
				<React.Suspense fallback={null}>
					{show && <Effect />}
					<Suspender />
				</React.Suspense>
			)
		}
		await h.mount(<App />)
		await act(() => {
			startSignalTransition(() => {
				atom.set(1)
				hold.set(true)
			})
		})
		expect(seen).toEqual([])
		await act(() => showEffect(true))
		expect(seen).toEqual([0])
		await act(async () => {
			gate.resolve()
			await gate.promise
		})
		expect(seen).toEqual([0, 1])
	})

	test('containerless providers run effects in their own committed worlds', async () => {
		const atom = createAtom(0)
		const hold = createAtom(false)
		const gate = deferred<void>()
		const firstSeen: number[] = []
		const secondSeen: number[] = []
		function Effect({ seen }: { seen: number[] }) {
			useSignalLayoutEffect(() => {
				seen.push(atom.get())
			})
			return null
		}
		function Suspender() {
			if (useValue(hold) && !gate.settled) {
				throw gate.promise
			}
			return null
		}
		const firstContainer = document.body.appendChild(document.createElement('div'))
		const secondContainer = document.body.appendChild(document.createElement('div'))
		const firstRoot = createRoot(firstContainer)
		const secondRoot = createRoot(secondContainer)
		try {
			await act(() => {
				firstRoot.render(
					<SignalsFrameworkProvider>
						<React.Suspense fallback={null}>
							<Effect seen={firstSeen} />
							<Suspender />
						</React.Suspense>
					</SignalsFrameworkProvider>,
				)
				secondRoot.render(
					<SignalsFrameworkProvider>
						<Effect seen={secondSeen} />
					</SignalsFrameworkProvider>,
				)
			})
			expect(firstSeen).toEqual([0])
			expect(secondSeen).toEqual([0])
			await act(() => {
				startSignalTransition(() => {
					atom.set(1)
					hold.set(true)
				})
			})
			expect(firstSeen).toEqual([0])
			expect(secondSeen).toEqual([0, 1])
			expect(read(atom)).toBe(0)
			await act(async () => {
				gate.resolve()
				await gate.promise
			})
			expect(firstSeen).toEqual([0, 1])
			expect(secondSeen).toEqual([0, 1])
			expect(read(atom)).toBe(1)
		} finally {
			await act(() => {
				firstRoot.unmount()
				secondRoot.unmount()
			})
			firstContainer.remove()
			secondContainer.remove()
		}
	})

	test('an equal world-only computed branch rewires its committed root effect', async () => {
		const flag = createAtom(false)
		const left = createAtom(10)
		const right = createAtom(10)
		const hold = createAtom(false)
		const pick = createComputed(() => (flag.get() ? right.get() : left.get()))
		const gate = deferred<void>()
		const seen: number[] = []
		const cleaned: number[] = []
		let renders = 0
		function Effect() {
			renders++
			useSignalLayoutEffect(() => {
				seen.push(pick.get())
				return () => cleaned.push(pick.get())
			})
			return null
		}
		function Suspender() {
			if (useValue(hold) && !gate.settled) {
				throw gate.promise
			}
			return null
		}
		const first = await h.mount(<Effect />)
		await h.mount(
			<React.Suspense fallback={null}>
				<Suspender />
			</React.Suspense>,
		)
		expect(seen).toEqual([10])
		expect(renders).toBe(1)
		await act(() => {
			startSignalTransition(() => {
				flag.set(true)
				hold.set(true)
			})
		})
		expect(committed(flag, first.container)).toBe(true)
		expect(committed(pick, first.container)).toBe(10)
		expect(seen).toEqual([10])
		expect(renders).toBe(2)
		expect(read(flag)).toBe(false)

		await act(() => right.set(20))
		expect(seen).toEqual([10, 20])
		expect(cleaned).toEqual([20])
		expect(renders).toBe(3)
		expect(read(flag)).toBe(false)

		await act(async () => {
			gate.resolve()
			await gate.promise
		})
		expect(seen).toEqual([10, 20])
		expect(cleaned).toEqual([20])
		expect(renders).toBe(3)
		expect(read(flag)).toBe(true)
	})
})
