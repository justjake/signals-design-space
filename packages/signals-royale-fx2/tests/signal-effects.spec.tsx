// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createRoot } from 'react-dom/client'
import { createAtom, createComputed, latest, nodeOf, read } from 'signals-royale-fx2'
import {
	SignalsFrameworkProvider,
	startSignalTransition,
	useSignalEffect,
	useSignalLayoutEffect,
	useValue,
} from 'signals-royale-fx2/react'
import { act, deferred, flushEffects, makeHarness, React, type Harness } from './helpers.tsx'

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

	test('setup runs in the React phase; a write only marks and enqueues', async () => {
		const atom = createAtom(0)
		const events: string[] = []
		function App() {
			useSignalLayoutEffect(
				() => atom.get(),
				(v) => {
					events.push(`layout:${v}`)
				},
				[],
			)
			useSignalEffect(
				() => atom.get(),
				(v) => {
					events.push(`passive:${v}`)
				},
				[],
			)
			return null
		}
		await h.mount(<App />)
		// First runs land exactly in the React phases, in order.
		expect(events).toEqual(['layout:0', 'passive:0'])
		events.length = 0
		await act(() => {
			events.push('write:start')
			atom.set(1)
			events.push('write:end')
			// The write path only marks and enqueues; neither handler runs
			// inside it.
			expect(events).toEqual(['write:start', 'write:end'])
		})
		await flushEffects()
		// The useLayoutEffect lane drains ahead of the useEffect lane.
		expect(events).toEqual(['write:start', 'write:end', 'layout:1', 'passive:1'])
		events.length = 0
		await act(() => {
			startSignalTransition(() => {
				events.push('transition:start')
				atom.set(2)
				events.push('transition:end')
			})
			expect(events).toEqual(['transition:start', 'transition:end'])
		})
		await flushEffects()
		// The drafted write was invisible; retirement delivered it once.
		expect(events).toEqual(['transition:start', 'transition:end', 'layout:2', 'passive:2'])
	})

	test('cleanup precedes each rerun and the final cleanup runs on unmount', async () => {
		const atom = createAtom(0)
		const events: string[] = []
		function App() {
			useSignalLayoutEffect(
				() => atom.get(),
				(value) => {
					events.push(`layout:run:${value}`)
					return () => events.push(`layout:cleanup:${value}`)
				},
				[],
			)
			useSignalEffect(
				() => atom.get(),
				(value) => {
					events.push(`passive:run:${value}`)
					return () => events.push(`passive:cleanup:${value}`)
				},
				[],
			)
			return null
		}
		const { root } = await h.mount(<App />)
		expect(events).toEqual(['layout:run:0', 'passive:run:0'])
		events.length = 0
		await act(() => atom.set(1))
		await flushEffects()
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

	test('latest reads are tracked in both phases (compute-side)', async () => {
		const atom = createAtom(0)
		const layout: number[] = []
		const passive: number[] = []
		function App() {
			useSignalLayoutEffect(
				() => latest(atom),
				(v) => {
					layout.push(v)
				},
				[],
			)
			useSignalEffect(
				() => latest(atom),
				(v) => {
					passive.push(v)
				},
				[],
			)
			return null
		}
		await h.mount(<App />)
		expect(layout).toEqual([0])
		expect(passive).toEqual([0])
		await act(() => atom.set(1))
		await flushEffects()
		expect(layout).toEqual([0, 1])
		expect(passive).toEqual([0, 1])
	})

	test('a dependency write from the handler queues a later lane rerun', async () => {
		const atom = createAtom(0)
		const seen: number[] = []
		function App() {
			useSignalEffect(
				() => atom.get(),
				(value) => {
					seen.push(value)
					if (value === 0) {
						atom.set(1)
					}
				},
				[],
			)
			return null
		}
		await h.mount(<App />)
		await flushEffects()
		expect(seen).toEqual([0, 1])
	})

	test('handler runs are gated by the value anchor: net reverts deliver nothing', async () => {
		const atom = createAtom(0)
		const seen: number[] = []
		function App() {
			useSignalLayoutEffect(
				() => atom.get(),
				(v) => {
					seen.push(v)
				},
				[],
			)
			return null
		}
		await h.mount(<App />)
		expect(seen).toEqual([0])
		await act(() => {
			atom.set(5)
			atom.set(0) // reverted before the lane drained
		})
		await flushEffects()
		expect(seen).toEqual([0]) // net-of-window cutoff: no run at all
		await act(() => atom.set(5))
		await flushEffects()
		expect(seen).toEqual([0, 5])
	})

	test('dependency tracking shrinks and expands with the compute branches', async () => {
		for (const phase of ['layout', 'passive'] as const) {
			const wide = createAtom(true)
			const first = createAtom(0)
			const second = createAtom(0)
			const seen: string[] = []
			function App() {
				const usePhase = phase === 'layout' ? useSignalLayoutEffect : useSignalEffect
				usePhase(
					() => {
						const isWide = wide.get()
						const values = `${isWide}:${first.get()}`
						return isWide ? `${values}:${second.get()}` : values
					},
					(s) => {
						seen.push(s)
					},
					[],
				)
				return null
			}
			await h.mount(<App />)
			expect(seen, phase).toEqual(['true:0:0'])
			await act(() => wide.set(false))
			await flushEffects()
			expect(seen, phase).toEqual(['true:0:0', 'false:0'])
			await act(() => second.set(1))
			await flushEffects()
			expect(seen, phase).toEqual(['true:0:0', 'false:0']) // pruned branch: silent
			await act(() => wide.set(true))
			await flushEffects()
			expect(seen, phase).toEqual(['true:0:0', 'false:0', 'true:0:1'])
			await act(() => second.set(2))
			await flushEffects()
			expect(seen, phase).toEqual(['true:0:0', 'false:0', 'true:0:1', 'true:0:2'])
		}
	})

	test('a throwing initial compute disposes its watcher in either phase', async () => {
		for (const phase of ['layout', 'passive'] as const) {
			const atom = createAtom(0)
			function Broken() {
				const usePhase = phase === 'layout' ? useSignalLayoutEffect : useSignalEffect
				usePhase(
					() => {
						atom.get()
						throw new Error(`${phase} boom`)
					},
					() => {},
					[],
				)
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
			useSignalLayoutEffect(
				() => atom.get(),
				(v) => {
					events.push(`layout:${v}`)
				},
				[],
			)
			useSignalEffect(
				() => atom.get(),
				(v) => {
					events.push(`passive:${v}`)
				},
				[],
			)
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
		await flushEffects()
		expect(events).toEqual([]) // drafts are invisible to effects
		expect(read(atom)).toBe(0)
		expect(latest(atom)).toBe(1)
		await act(async () => {
			gate.resolve()
			await gate.promise
		})
		await flushEffects()
		expect(events).toEqual(['layout:1', 'passive:1'])
	})

	test('an effect mounted urgently while a transition is held observes its later retirement', async () => {
		const atom = createAtom(0)
		const hold = createAtom(false)
		const gate = deferred<void>()
		const seen: number[] = []
		let showEffect!: (show: boolean) => void
		function Effect() {
			useSignalLayoutEffect(
				() => atom.get(),
				(v) => {
					seen.push(v)
				},
				[],
			)
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
		expect(seen).toEqual([0]) // mounted mid-hold: base state
		await act(async () => {
			gate.resolve()
			await gate.promise
		})
		await flushEffects()
		expect(seen).toEqual([0, 1])
	})

	test('effects observe base state: a multi-root transition delivers at retirement', async () => {
		// One transition spans two roots; the second root commits it while the
		// first holds. Effects are base-only, so neither root's effect sees the
		// draft until every root commits and the fold lands — the per-root skew
		// window is invisible to effects by design (see docs/effects.md).
		const atom = createAtom(0)
		const hold = createAtom(false)
		const gate = deferred<void>()
		const firstSeen: number[] = []
		const secondSeen: number[] = []
		function Effect({ seen }: { seen: number[] }) {
			useSignalLayoutEffect(
				() => atom.get(),
				(v) => {
					seen.push(v)
				},
				[],
			)
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
			await flushEffects()
			// The second root committed the transition, but the draft is not
			// retired until the first root does too — base is unchanged and
			// both effects stay silent.
			expect(firstSeen).toEqual([0])
			expect(secondSeen).toEqual([0])
			expect(read(atom)).toBe(0)
			await act(async () => {
				gate.resolve()
				await gate.promise
			})
			await flushEffects()
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

	test('a held transition never rewires a base effect; retirement delivers the switched branch', async () => {
		const flag = createAtom(false)
		const left = createAtom(10)
		const right = createAtom(11)
		const hold = createAtom(false)
		const pick = createComputed(() => (flag.get() ? right.get() : left.get()))
		const gate = deferred<void>()
		const seen: number[] = []
		function Effect() {
			useSignalLayoutEffect(
				() => pick.get(),
				(v) => {
					seen.push(v)
				},
				[],
			)
			return null
		}
		function Suspender() {
			if (useValue(hold) && !gate.settled) {
				throw gate.promise
			}
			return null
		}
		await h.mount(<Effect />)
		await h.mount(
			<React.Suspense fallback={null}>
				<Suspender />
			</React.Suspense>,
		)
		expect(seen).toEqual([10])
		await act(() => {
			startSignalTransition(() => {
				flag.set(true)
				hold.set(true)
			})
		})
		await flushEffects()
		expect(seen).toEqual([10])
		expect(read(flag)).toBe(false)

		// Only the drafted world reads `right`; the base effect still tracks
		// the base branch and stays silent.
		await act(() => right.set(20))
		await flushEffects()
		expect(seen).toEqual([10])

		// The base branch is live: it delivers.
		await act(() => left.set(12))
		await flushEffects()
		expect(seen).toEqual([10, 12])

		// Retirement folds the branch switch; the effect re-tracks and sees
		// the drafted branch's current value.
		await act(async () => {
			gate.resolve()
			await gate.promise
		})
		await flushEffects()
		expect(seen).toEqual([10, 12, 20])
		expect(read(flag)).toBe(true)
	})

	test('deps-array changes re-create the effect in the React phase', async () => {
		const atom = createAtom(0)
		const events: string[] = []
		let bump!: () => void
		function App() {
			const [gen, setGen] = React.useState(0)
			bump = () => setGen((g) => g + 1)
			useSignalLayoutEffect(
				() => atom.get(),
				(v) => {
					events.push(`run:${gen}:${v}`)
					return () => events.push(`cleanup:${gen}:${v}`)
				},
				[gen],
			)
			return null
		}
		await h.mount(<App />)
		expect(events).toEqual(['run:0:0'])
		await act(() => bump())
		// Old effect disposed and the new one first-ran, both inside React's
		// layout phase for the deps-change commit.
		expect(events).toEqual(['run:0:0', 'cleanup:0:0', 'run:1:0'])
		await act(() => atom.set(1))
		await flushEffects()
		expect(events).toEqual(['run:0:0', 'cleanup:0:0', 'run:1:0', 'cleanup:1:0', 'run:1:1'])
	})

	test('the handler sees the latest committed render props without re-creating the effect', async () => {
		const atom = createAtom(0)
		const seen: string[] = []
		let setLabel!: (label: string) => void
		function App() {
			const [label, set] = React.useState('a')
			setLabel = set
			useSignalLayoutEffect(
				() => atom.get(),
				(v) => {
					seen.push(`${label}:${v}`)
				},
				[],
			)
			return null
		}
		await h.mount(<App />)
		expect(seen).toEqual(['a:0'])
		await act(() => setLabel('b')) // re-render only: no signal change, no run
		expect(seen).toEqual(['a:0'])
		await act(() => atom.set(1))
		await flushEffects()
		expect(seen).toEqual(['a:0', 'b:1']) // latest-ref: the committed props
	})
})
