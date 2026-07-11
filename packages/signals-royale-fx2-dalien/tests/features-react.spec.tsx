// @vitest-environment jsdom
/** Scenarios 11, 14-18, plus fx2-specific surfaces (ambient transitions,
 * useSignalTransition, useCommitted, useAtom, useComputed, useSignalEffect). */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act, deferred, makeHarness, text, tick, React, type Harness } from './helpers.tsx'
import {
	attachTracer,
	computed,
	nodeOf,
	read,
	serializeAtomState,
	initializeAtomState,
	signal,
	update,
	type Signal,
} from 'signals-royale-fx2-dalien'
import {
	startTransitionWrite,
	useAtom,
	useCommitted,
	useComputed,
	useIsPending,
	useSignalEffect,
	useSignalTransition,
	useValue,
} from 'signals-royale-fx2-dalien/react'

let h: Harness
beforeEach(() => {
	h = makeHarness()
})
afterEach(async () => {
	const errors = [...h.handle.errors]
	await h.cleanup()
	expect(errors).toEqual([])
})

describe('scenario 11 — suspense family', () => {
	/** The resource idiom: one request per param key, so requests are stable
	 * across re-evaluations and a param change is what refetches. */
	function makeResource(param: Signal<number>) {
		let fetchCount = 0
		const gates = new Map<string, ReturnType<typeof deferred<string>>>()
		const data = computed((use) => {
			const key = `${param.get()}`
			let g = gates.get(key)
			if (g === undefined) {
				g = deferred<string>()
				gates.set(key, g)
				fetchCount++
			}
			return use(g.promise)
		})
		return {
			data,
			fetchCount: () => fetchCount,
			async settle(key: string, v: string) {
				await act(async () => {
					gates.get(key)!.resolve(v)
					await gates.get(key)!.promise
					await Promise.resolve()
				})
			},
		}
	}

	function DataView({ data }: { data: unknown }) {
		return <span>d:{useValue(data as never)}</span>
	}

	test('first load: fallback then converge; one fetch across retries', async () => {
		const param = signal(0)
		const r = makeResource(param)
		const { container } = await h.mount(
			<React.Suspense fallback={<i>loading</i>}>
				<DataView data={r.data} />
			</React.Suspense>,
		)
		expect(text(container)).toBe('loading')
		await r.settle('0', 'one')
		expect(text(container)).toBe('d:one')
		expect(r.fetchCount()).toBe(1)
	})

	test('settlement inside a transition commits with the transition', async () => {
		const param = signal(0)
		const r = makeResource(param)
		const { container } = await h.mount(
			<React.Suspense fallback={<i>loading</i>}>
				<DataView data={r.data} />
			</React.Suspense>,
		)
		await r.settle('0', 'one')
		await act(() => {
			startTransitionWrite(() => {
				param.set(1)
			})
		})
		expect(text(container)).toBe('d:one') // transition holds on the fetch
		await r.settle('1', 'TWO')
		expect(text(container)).toBe('d:TWO') // lands with the transition
		expect(read(r.data)).toBe('TWO')
	})
})

describe('scenario 14 — lifetime effects across subscriber kinds', () => {
	test('React subscribers mount one observation; ctx.set feeds the UI', async () => {
		const log: string[] = []
		const a = signal(0, {
			onObserved: (ctx) => {
				log.push(`observe:${ctx.get()}`)
				ctx.set(42)
				return () => log.push('unobserve')
			},
		})
		function Sub({ id }: { id: string }) {
			return (
				<span>
					{id}:{useValue(a)};
				</span>
			)
		}
		function App({ n }: { n: number }) {
			return (
				<>
					{n >= 1 ? <Sub id="A" /> : null}
					{n >= 2 ? <Sub id="B" /> : null}
				</>
			)
		}
		const { root, container } = await h.mount(<App n={2} />)
		await act(async () => {})
		expect(log).toEqual(['observe:0'])
		expect(text(container)).toBe('A:42;B:42;')
		await act(() => {
			root.render(<App n={1} />)
		})
		await act(async () => {})
		expect(log).toEqual(['observe:0'])
		await act(() => {
			root.render(<App n={0} />)
		})
		await act(async () => {})
		expect(log).toEqual(['observe:0', 'unobserve'])
	})
})

describe('scenario 15 — causality traces', () => {
	test('urgent chain reaches the write; post-retirement chain passes the retirement', async () => {
		const t = attachTracer()
		const a = signal(1, { label: 'a' })
		const hold = signal(false)
		const gate = deferred<void>()
		function App() {
			const v = useValue(a)
			const held = useValue(hold)
			if (held && !gate.settled) {
				throw gate.promise
			}
			return <span>v:{v}</span>
		}
		const { container } = await h.mount(
			<React.Suspense fallback={<i>fb</i>}>
				<App />
			</React.Suspense>,
		)
		await act(() => {
			startTransitionWrite(() => {
				update(a, (x) => x + 1)
				hold.set(true)
			})
		})
		await act(() => {
			update(a, (x) => x * 2)
		})
		expect(text(container)).toBe('v:2')
		const urgentChain = t.whyLastDelivery(nodeOf(a))
		expect(urgentChain.join(' ')).toMatch(/write/i)
		await act(async () => {
			gate.resolve()
			await gate.promise
		})
		expect(text(container)).toBe('v:4')
		const retiredChain = t.whyLastDelivery(nodeOf(a))
		expect(retiredChain.join(' ')).toMatch(/retire|write/i)
		// Structure: causes always reference earlier events.
		for (const e of t.events()) {
			if (e.cause !== 0) {
				expect(e.cause).toBeLessThan(e.id)
			}
		}
		t.stop()
	})
})

// Scenario 16 (the DOM mutation window) is intentionally absent: bracketing
// React's mutation phase needs reconciler cooperation, which is out of scope
// for a stock-React package. Owner-ruled exemption; see README + REPORT.

describe('scenario 17 — lazy initializers under React', () => {
	test('initializer runs at first render read, once', async () => {
		let runs = 0
		const a = signal((): number => {
			runs++
			return 7
		})
		function App() {
			return <span>{useValue(a)}</span>
		}
		expect(runs).toBe(0)
		const { container } = await h.mount(<App />)
		expect(text(container)).toBe('7')
		expect(runs).toBe(1)
		await act(() => {
			a.set(8)
		})
		expect(text(container)).toBe('8')
		expect(runs).toBe(1)
	})
})

describe('scenario 18 — SSR', () => {
	// The fork build script emits client bundles only (no react-dom/server),
	// so the server half is exercised at the engine level: commit values on
	// the "server" engine, serialize under app keys, install client-side.
	test('serialize -> install on fresh atoms -> exact first client render', async () => {
		const s1 = signal(1)
		const s2 = signal('x')
		s1.set(5)
		const json = serializeAtomState([s1, s2])
		// "Client": fresh atoms; install skips initializers, is not a write.
		let initRuns = 0
		const c1 = signal((): number => {
			initRuns++
			return 0
		})
		const c2 = signal('default')
		initializeAtomState(json, [c1, c2])
		expect(initRuns).toBe(0)
		let renders = 0
		function App() {
			renders++
			return (
				<span>
					{useValue(c1)}:{useValue(c2)}
				</span>
			)
		}
		const { container } = await h.mount(<App />)
		expect(text(container)).toBe('5:x')
		expect(renders).toBe(1)
		expect(initRuns).toBe(0)
	})
})

describe('hooks demand a SignalScope', () => {
	// The hooks have no unscoped mode: a scope is the world carrier, and a
	// subscriber without one has no channel for transition worlds at all.
	// Rendering any scope-consuming hook outside a SignalScope throws with a
	// message naming the fixes.
	class Boundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
		state: { error: Error | null } = { error: null }
		static getDerivedStateFromError(error: Error) {
			return { error }
		}
		render() {
			return this.state.error !== null ? (
				<i>caught:{this.state.error.message}</i>
			) : (
				this.props.children
			)
		}
	}

	test('[falsify-first] every scope-consuming hook throws without a scope, naming the fixes', async () => {
		const { createRoot } = await import('react-dom/client')
		const a = signal(1)
		const cases: Array<[string, () => React.ReactNode]> = [
			['useValue', () => <span>{useValue(a)}</span>],
			['useComputed', () => <span>{useComputed(() => a.peek() + 1, [])}</span>],
			['useIsPending', () => <span>{String(useIsPending(a))}</span>],
			['useCommitted', () => <span>{useCommitted(a)}</span>],
		]
		for (const [name, render] of cases) {
			const Hooked = () => <>{render()}</>
			const div = document.body.appendChild(document.createElement('div'))
			const root = createRoot(div) // deliberately no SignalScope
			await act(() => {
				root.render(
					<Boundary>
						<Hooked />
					</Boundary>,
				)
			})
			expect(text(div), name).toContain('caught:')
			expect(text(div), name).toContain('SignalScope')
			expect(text(div), name).toContain('wrapCreateRoot')
			await act(() => root.unmount())
			div.remove()
		}
	})
})

describe('fx2 extras', () => {
	test('plain React.startTransition writes classify ambiently (no helper needed)', async () => {
		const a = signal(0)
		const hold = signal(false)
		const gate = deferred<void>()
		function Suspender() {
			const v = useValue(a)
			const held = useValue(hold)
			if (held && !gate.settled) {
				throw gate.promise
			}
			return <b>v:{v};</b>
		}
		const { container } = await h.mount(
			<React.Suspense fallback={<i>fb;</i>}>
				<Suspender />
			</React.Suspense>,
		)
		await act(() => {
			React.startTransition(() => {
				a.set(1) // no helper: the ambient classifier opens the draft
				hold.set(true)
			})
		})
		expect(text(container)).toBe('v:0;') // invisible, held, no fallback
		expect(read(a)).toBe(0)
		await act(async () => {
			gate.resolve()
			await gate.promise
		})
		expect(text(container)).toBe('v:1;')
		expect(read(a)).toBe(1)
	})

	test('useSignalTransition: isPending spans the batch lifetime', async () => {
		const a = signal(0)
		const hold = signal(false)
		const gate = deferred<void>()
		let start!: (scope: () => void) => void
		const pendingSeen: boolean[] = []
		function Controls() {
			const [isPending, startFn] = useSignalTransition()
			start = startFn
			pendingSeen.push(isPending)
			return <i>{isPending ? 'P' : 'i'};</i>
		}
		function Suspender() {
			const v = useValue(a)
			const held = useValue(hold)
			if (held && !gate.settled) {
				throw gate.promise
			}
			return <b>v:{v};</b>
		}
		const { container } = await h.mount(
			<>
				<Controls />
				<React.Suspense fallback={null}>
					<Suspender />
				</React.Suspense>
			</>,
		)
		await act(() => {
			start(() => {
				a.set(1)
				hold.set(true)
			})
		})
		expect(text(container)).toBe('P;v:0;')
		await act(async () => {
			gate.resolve()
			await gate.promise
		})
		expect(text(container)).toBe('i;v:1;')
		expect(pendingSeen).toContain(true)
	})

	test('useCommitted tracks this root screen, urgent and transitional', async () => {
		const a = signal(0)
		let renders = 0
		function App() {
			renders++
			const now = useValue(a)
			const shown = useCommitted(a)
			return (
				<span>
					n:{now};c:{shown};
				</span>
			)
		}
		const { container } = await h.mount(<App />)
		expect(text(container)).toBe('n:0;c:0;')
		expect(renders).toBe(1)
		await act(() => {
			a.set(1)
		})
		expect(text(container)).toBe('n:1;c:1;')
		expect(renders).toBe(2)
		await act(() => {
			startTransitionWrite(() => a.set(2))
		})
		await act(async () => {})
		expect(text(container)).toBe('n:2;c:2;')
		// The transition renders the draft, then confirmCommit advances the
		// root-local committed screen for useCommitted.
		expect(renders).toBe(4)
	})

	test('useAtom is component-owned; useComputed derives; useSignalEffect observes commits', async () => {
		const base = signal(2)
		const effectSeen: number[] = []
		function App() {
			const own = useAtom(10)
			const sum = useComputed(() => base.get() + own.get(), [own])
			useSignalEffect(() => {
				effectSeen.push(base.get())
			})
			return (
				<span>
					s:{sum};o:{useValue(own)};
				</span>
			)
		}
		const { container } = await h.mount(<App />)
		expect(text(container)).toBe('s:12;o:10;')
		await act(() => {
			base.set(3)
		})
		expect(text(container)).toBe('s:13;o:10;')
		expect(effectSeen).toEqual([2, 3])
	})
})
