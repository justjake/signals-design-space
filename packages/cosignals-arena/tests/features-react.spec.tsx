// @vitest-environment jsdom
/**
 * Scenarios 11, 14-18, plus cosignals-arena-specific surfaces (ambient transitions,
 * useSignalTransition, useAtom, useComputed,
 * useSignalEffect/useSignalLayoutEffect).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
	act,
	deferred,
	flushEffects,
	makeHarness,
	text,
	React,
	type Harness,
} from './helpers.tsx'
import {
	attachTracer,
	createComputed,
	effect,
	endBatch,
	nodeOf,
	read,
	createAtom,
	startBatch,
	update,
	type Atom,
} from 'cosignals-arena'
import { initializeAtomState, serializeAtomState } from 'cosignals-arena/ssr'
import {
	SignalsFrameworkProvider,
	startSignalTransition,
	useAtom,
	useComputed,
	useIsPending,
	useSignalEffect,
	useSignalTransition,
	useValue,
} from 'cosignals-arena/react'

let h: Harness
beforeEach(() => {
	h = makeHarness()
})
afterEach(async () => {
	await h.cleanup()
})

describe('scenario 11 — suspense family', () => {
	/**
	 * The resource idiom: one request per param key, so requests are stable
	 * across re-evaluations and a param change is what refetches.
	 */
	function makeResource(param: Atom<number>) {
		let fetchCount = 0
		const gates = new Map<string, ReturnType<typeof deferred<string>>>()
		const data = createComputed((use) => {
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
		const param = createAtom(0)
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
		const param = createAtom(0)
		const r = makeResource(param)
		const { container } = await h.mount(
			<React.Suspense fallback={<i>loading</i>}>
				<DataView data={r.data} />
			</React.Suspense>,
		)
		await r.settle('0', 'one')
		await act(() => {
			startSignalTransition(() => {
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
		const a = createAtom(0, {
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
	test('a suspension records observed render and readiness branches with shared identities', async () => {
		const key = createAtom(0, { label: 'key' })
		const gate = deferred<string>()
		const data = createComputed((use) => (key.get() === 0 ? 'zero' : use(gate.promise)), {
			label: 'data',
		})
		function App() {
			return <span>{useValue(data)}</span>
		}
		const { container } = await h.mount(
			<React.Suspense fallback={<i>loading</i>}>
				<App />
			</React.Suspense>,
		)
		expect(text(container)).toBe('zero')

		const tracer = attachTracer()
		await act(() => {
			startSignalTransition(() => key.set(1))
		})
		expect(text(container)).toBe('zero')
		let events = tracer.events()
		const write = events.find((event) => event.kind === 'set' && event.label === 'key')!
		const compute = events.find((event) => event.kind === 'compute' && event.label === 'data')!
		expect(compute.cause).toBe(write.id) // the background recompute chains through the drafted write
		expect(compute.draftId).toBeUndefined()
		expect(compute.world).toEqual([write.draftId])
		const suspended = events.find(
			(event) => event.kind === 'compute-suspend' && event.cause === compute.id,
		)!
		const encountered = events.find((event) => event.kind === 'render-suspend')!
		expect(suspended.suspensionId).toBeDefined()
		expect(encountered.suspensionId).toBe(suspended.suspensionId)
		expect(encountered.cause).toBe(0)
		expect(encountered.rootId).toBeDefined()
		expect(events.some((event) => event.kind === 'root-park')).toBe(false)

		await act(async () => {
			gate.resolve('one')
			await gate.promise
			await Promise.resolve()
		})
		expect(text(container)).toBe('one')
		events = tracer.events()
		const settled = events.find((event) => event.kind === 'settle')!
		const ready = events.find(
			(event) => event.kind === 'retry' && event.cause === settled.id,
		)!
		const woken = events.find((event) => event.kind === 'transition-notify')!
		const commit = events.find((event) => event.kind === 'transition-commit')!
		expect(settled.status).toBe('fulfilled')
		expect(ready.suspensionId).toBe(suspended.suspensionId)
		expect(woken.cause).toBe(write.id) // the drafted write causes the wake
		expect(commit.cause).toBe(write.id) // the commit chains to the transition's write
		expect(commit.rootId).toBe(encountered.rootId)
		expect(events.some((event) => event.kind === 'render')).toBe(false)
		expect(events.some((event) => event.kind === 'retry-schedule')).toBe(false)
		expect(events.some((event) => event.kind === 'render-retry')).toBe(false)
		for (const event of events) {
			if (event.cause !== 0) {
				expect(event.cause).toBeLessThan(event.id)
			}
		}
		tracer.stop()
	})

	test('urgent chain reaches the write; post-retirement chain passes the retirement', async () => {
		const t = attachTracer()
		const a = createAtom(1, { label: 'a' })
		const hold = createAtom(false)
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
			startSignalTransition(() => {
				update(a, (x) => x + 1)
				hold.set(true)
			})
		})
		await act(() => {
			update(a, (x) => x * 2)
		})
		expect(text(container)).toBe('v:2')
		const urgentChain = t.whyLastDelivery(nodeOf(a))
		expect(urgentChain.join(' ')).toMatch(/set|update/i)
		await act(async () => {
			gate.resolve()
			await gate.promise
		})
		expect(text(container)).toBe('v:4')
		const retiredChain = t.whyLastDelivery(nodeOf(a))
		expect(retiredChain.join(' ')).toMatch(/retire|set|update/i)
		// Structure: causes always reference earlier events.
		for (const e of t.events()) {
			if (e.cause !== 0) {
				expect(e.cause).toBeLessThan(e.id)
			}
		}
		t.stop()
	})

	test('two sibling suspensions retain distinct identities when they settle in reverse', async () => {
		const firstGate = deferred<string>()
		const secondGate = deferred<string>()
		const first = createComputed((use) => use(firstGate.promise), { label: 'first' })
		const second = createComputed((use) => use(secondGate.promise), { label: 'second' })
		function Value({ signal }: { signal: typeof first }) {
			return <span>{useValue(signal)}</span>
		}
		const tracer = attachTracer()
		const { container } = await h.mount(
			<>
				<React.Suspense fallback={<i>first-pending</i>}>
					<Value signal={first} />
				</React.Suspense>
				<React.Suspense fallback={<i>second-pending</i>}>
					<Value signal={second} />
				</React.Suspense>
			</>,
		)
		expect(text(container)).toBe('first-pendingsecond-pending')
		let firstSuspend
		let secondSuspend
		for (const event of tracer.events()) {
			if (event.kind === 'render-suspend' && event.label === 'first') {
				firstSuspend = event
			} else if (event.kind === 'render-suspend' && event.label === 'second') {
				secondSuspend = event
			}
		}
		expect(firstSuspend).toBeDefined()
		expect(secondSuspend).toBeDefined()
		const firstEvent = firstSuspend!
		const secondEvent = secondSuspend!
		expect(firstEvent.rootId).toBe(secondEvent.rootId)
		expect(firstEvent.suspensionId).not.toBe(secondEvent.suspensionId)

		await act(async () => {
			secondGate.resolve('second-ready')
			await secondGate.promise
		})
		expect(text(container)).toBe('first-pendingsecond-ready')
		const secondReady = tracer.events().find(
			(event) => event.kind === 'retry' && event.suspensionId === secondEvent.suspensionId,
		)
		expect(secondReady).toBeDefined()
		expect(
			tracer.events().some(
				(event) =>
					event.kind === 'retry' && event.suspensionId === firstEvent.suspensionId,
			),
		).toBe(false)

		await act(async () => {
			firstGate.resolve('first-ready')
			await firstGate.promise
		})
		expect(text(container)).toBe('first-readysecond-ready')
		expect(
			tracer.events().some(
				(event) =>
					event.kind === 'retry' && event.suspensionId === firstEvent.suspensionId,
			),
		).toBe(true)
		tracer.stop()
	})

	test('one suspension shared by two roots keeps one suspension id and two root ids', async () => {
		const gate = deferred<string>()
		const shared = createComputed((use) => use(gate.promise), { label: 'shared' })
		function App() {
			return <span>{useValue(shared)}</span>
		}
		const tracer = attachTracer()
		const first = await h.mount(
			<React.Suspense fallback={<i>pending</i>}>
				<App />
			</React.Suspense>,
		)
		const second = await h.mount(
			<React.Suspense fallback={<i>pending</i>}>
				<App />
			</React.Suspense>,
		)
		expect(text(first.container)).toBe('pending')
		expect(text(second.container)).toBe('pending')
		const rootIds = new Set<number>()
		let suspensionId: number | undefined
		for (const event of tracer.events()) {
			if (event.kind !== 'render-suspend' || event.label !== 'shared') {
				continue
			}
			suspensionId ??= event.suspensionId
			expect(event.suspensionId).toBe(suspensionId)
			rootIds.add(event.rootId!)
		}
		expect(rootIds.size).toBe(2)

		await act(async () => {
			gate.resolve('ready')
			await gate.promise
		})
		expect(text(first.container)).toBe('ready')
		expect(text(second.container)).toBe('ready')
		expect(tracer.events().some((event) => event.kind === 'render')).toBe(false)
		expect(
			tracer.events().some(
				(event) => event.kind === 'retry' && event.suspensionId === suspensionId,
			),
		).toBe(true)
		tracer.stop()
	})

	test('replacing a tracer while pending does not import the old suspension cause', async () => {
		const gate = deferred<string>()
		const data = createComputed((use) => use(gate.promise), { label: 'pending-replacement' })
		function App() {
			return <span>{useValue(data)}</span>
		}
		const first = attachTracer()
		const mounted = await h.mount(
			<React.Suspense fallback={<i>pending</i>}>
				<App />
			</React.Suspense>,
		)
		expect(text(mounted.container)).toBe('pending')
		expect(first.events().some((event) => event.kind === 'render-suspend')).toBe(true)
		first.stop()
		const second = attachTracer()
		await act(async () => {
			gate.resolve('ready')
			await gate.promise
		})
		expect(text(mounted.container)).toBe('ready')
		const settled = second.events().find((event) => event.kind === 'settle')!
		const ready = second.events().find((event) => event.kind === 'retry')!
		expect(settled.cause).toBe(0)
		expect(ready.cause).toBe(settled.id)
		for (const event of second.events()) {
			if (event.cause !== 0) {
				expect(second.find(event.cause)).toBeDefined()
			}
		}
		second.stop()
	})

	test('replacing a tracer between a write and its delivery sanitizes the stale cause', async () => {
		const value = createAtom(1, { label: 'commit-replacement' })
		function App() {
			return <span>{useValue(value)}</span>
		}
		const mounted = await h.mount(<App />)
		const first = attachTracer()
		let second!: ReturnType<typeof attachTracer>
		await act(() => {
			startBatch()
			try {
				value.set(2) // recorded by the first tracer; stamps the watcher's cause
				first.stop()
				second = attachTracer()
			} finally {
				endBatch() // delivery runs here, emitting into the second tracer
			}
		})
		expect(text(mounted.container)).toBe('2')
		expect(first.events().some((event) => event.kind === 'set')).toBe(true)
		expect(first.whyLastDelivery(nodeOf(value))).toEqual([
			'(no delivery recorded for this node)',
		])
		const delivery = second.events().find((event) => event.kind === 'notify')!
		expect(delivery.cause).toBe(0) // the write belongs to the first session
		expect(second.whyLastDelivery(nodeOf(value))[0]).toMatch(/notify/)
		second.stop()
	})

	test('a base write causes the watcher notification; React owns render tracing', async () => {
		const a = createAtom(1, { label: 'count' })
		function App() {
			return <span>{useValue(a)}</span>
		}
		const { container } = await h.mount(<App />)
		const tracer = attachTracer()
		await act(() => {
			a.set(2)
		})
		expect(text(container)).toBe('2')
		const events = tracer.events()
		const write = events.find((event) => event.kind === 'set' && event.label === 'count')!
		// notify/render belong to the watcher (the component's subscription), not
		// the atom it reads — so they never carry the atom's 'count' label.
		const woken = events.find((event) => event.kind === 'notify')!
		expect(woken.label).not.toBe('count') // recorded against the watcher, not the atom
		expect(woken.cause).toBe(write.id) // the state change causes the notify
		expect(events.some((event) => event.kind === 'render')).toBe(false)
		for (const event of events) {
			if (event.cause !== 0) {
				expect(event.cause).toBeLessThan(event.id)
			}
		}
		tracer.stop()
	})

	test('a mount emits no notification or engine render event', async () => {
		const tracer = attachTracer()
		const a = createAtom(5, { label: 'mounted' })
		function App() {
			return <span>{useValue(a)}</span>
		}
		const { container } = await h.mount(<App />)
		expect(text(container)).toBe('5')
		const events = tracer.events()
		expect(events.some((event) => event.kind === 'notify')).toBe(false)
		expect(events.some((event) => event.kind === 'render')).toBe(false)
		tracer.stop()
	})

	test('a transition roots at the ambient operation and its whole subtree chains to it', async () => {
		const trigger = createAtom(0, { label: 'trigger' })
		const key = createAtom(0, { label: 'key' })
		function App() {
			return <span>k:{useValue(key)}</span>
		}
		const { container } = await h.mount(<App />)
		// The handler's run is the operation in flight when the transition
		// opens — the same seam a devtools adapter uses to attribute a DOM
		// event — so the transition's subtree roots under the triggering write.
		const dispose = effect(trigger, (v) => {
			if (v === 1) {
				startSignalTransition(() => key.set(1))
			}
		})
		const tracer = attachTracer()
		await act(() => {
			trigger.set(1)
		})
		expect(text(container)).toBe('k:1')
		const events = tracer.events()
		const triggerWrite = events.find(
			(event) => event.kind === 'set' && event.label === 'trigger',
		)!
		const run = events.find((event) => event.kind === 'effect')!
		expect(run.cause).toBe(triggerWrite.id)
		const open = events.find((event) => event.kind === 'transition-open')!
		expect(open.cause).toBe(run.id) // the transition roots at the ambient operation
		const draftWrite = events.find((event) => event.kind === 'set' && event.label === 'key')!
		expect(draftWrite.cause).toBe(open.id)
		expect(draftWrite.draftId).toBe(open.draftId)
		const woken = events.find((event) => event.kind === 'transition-notify')!
		expect(woken.cause).toBe(draftWrite.id)
		expect(events.some((event) => event.kind === 'render')).toBe(false)
		const commit = events.find((event) => event.kind === 'transition-commit')!
		expect(commit.cause).toBe(draftWrite.id)
		for (const event of events) {
			if (event.cause !== 0) {
				expect(event.cause).toBeLessThan(event.id)
			}
		}
		dispose()
		tracer.stop()
	})
})

// Scenario 16 (the DOM mutation window) is intentionally absent:
// bracketing React's mutation phase needs reconciler cooperation, which
// is out of scope for a stock-React package.

describe('scenario 17 — lazy initializers under React', () => {
	test('initializer runs at first render read, once', async () => {
		let runs = 0
		const a = createAtom((): number => {
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
		const s1 = createAtom(1)
		const s2 = createAtom('x')
		s1.set(5)
		const json = serializeAtomState([s1, s2])
		// "Client": fresh atoms; install skips initializers, is not a write.
		let initRuns = 0
		const c1 = createAtom((): number => {
			initRuns++
			return 0
		})
		const c2 = createAtom('default')
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

describe('hooks demand a SignalsFrameworkProvider', () => {
	// Hooks have no provider-free mode. The root connection carries
	// transition worlds, so a subscriber without one has no channel for
	// them. Rendering a provider-dependent hook without a provider throws
	// with a message naming the fixes.
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

	test('[falsify-first] provider-dependent hooks throw without a provider and name the fixes', async () => {
		const { createRoot } = await import('react-dom/client')
		const tracer = attachTracer()
		const a = createAtom(1)
		// useSignalEffect and useSignalLayoutEffect are absent deliberately:
		// they observe base state, which needs no root channel, so they work
		// without a provider.
		const cases: Array<[string, () => React.ReactNode]> = [
			['useValue', () => <span>{useValue(a)}</span>],
			['useComputed', () => <span>{useComputed(() => a.peek() + 1, [])}</span>],
			['useIsPending', () => <span>{String(useIsPending(a))}</span>],
		]
		for (const [name, render] of cases) {
			const Hooked = () => <>{render()}</>
			const div = document.body.appendChild(document.createElement('div'))
			const root = createRoot(div) // deliberately no SignalsFrameworkProvider
			await act(() => {
				root.render(
					<Boundary>
						<Hooked />
					</Boundary>,
				)
			})
			expect(text(div), name).toContain('caught:')
			expect(text(div), name).toContain(`caught:${name}wasrendered`)
			expect(text(div), name).toContain('SignalsFrameworkProvider')
			expect(text(div), name).toContain('wrapCreateRoot')
			await act(() => root.unmount())
			div.remove()
		}
		const missingProviderErrors = []
		for (const event of tracer.events()) {
			if (event.kind === 'policy-error' && event.phase === 'missing-provider') {
				missingProviderErrors.push(event)
			}
		}
		expect(missingProviderErrors.length).toBeGreaterThanOrEqual(cases.length)
		for (const event of missingProviderErrors) {
			expect(event.error).toBeInstanceOf(Error)
		}
		tracer.stop()
	})

	test('[falsify-first] a descendant provider throws before its connection mounts', async () => {
		const { createRoot } = await import('react-dom/client')
		const tracer = attachTracer()
		const div = document.body.appendChild(document.createElement('div'))
		const root = createRoot(div)
		try {
			await act(() => {
				root.render(
					<SignalsFrameworkProvider>
						<Boundary>
							<SignalsFrameworkProvider>
								<span>nested child</span>
							</SignalsFrameworkProvider>
						</Boundary>
					</SignalsFrameworkProvider>,
				)
			})
			expect(text(div)).toContain(
				'caught:SignalsFrameworkProvidercannotbenestedinsideanotherSignalsFrameworkProvider.',
			)
			expect(text(div)).toContain('wrapCreateRoot(createRoot)')
			expect(text(div)).not.toContain('nestedchild')
			const errors = []
			for (const event of tracer.events()) {
				if (event.kind === 'policy-error' && event.phase === 'nested-provider') {
					errors.push(event)
				}
			}
			expect(errors.length).toBeGreaterThan(0)
			for (const event of errors) {
				expect(event.cause).toBe(0)
				expect(event.error).toBeInstanceOf(Error)
			}
		} finally {
			tracer.stop()
			await act(() => root.unmount())
			div.remove()
		}
	})
})

describe('cosignals-arena extras', () => {
	test('plain React.startTransition writes classify ambiently (no helper needed)', async () => {
		const a = createAtom(0)
		const hold = createAtom(false)
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
		const a = createAtom(0)
		const hold = createAtom(false)
		const gate = deferred<void>()
		let start!: (fn: () => void) => void
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

	test('[falsify-first] the pending snapshot flips while a draft is held, without extra renders', async () => {
		const a = createAtom(0)
		const hold = createAtom(false)
		const gate = deferred<void>()
		let pendingRenders = 0
		function PendingProbe() {
			pendingRenders++
			return <i>p:{useIsPending(hold) ? 1 : 0};</i>
		}
		function Suspender() {
			if (useValue(hold) && !gate.settled) {
				throw gate.promise
			}
			return null
		}
		const { container } = await h.mount(
			<>
				<PendingProbe />
				<React.Suspense fallback={null}>
					<Suspender />
				</React.Suspense>
			</>,
		)
		expect(text(container)).toBe('p:0;')
		await act(() => {
			startSignalTransition(() => {
				a.set(1)
				hold.set(true)
			})
		})
		expect(text(container)).toBe('p:1;')
		expect(pendingRenders).toBe(2)
		await act(async () => {
			gate.resolve()
			await gate.promise
		})
		expect(text(container)).toBe('p:0;')
		expect(pendingRenders).toBe(3)
	})

	test('useAtom is component-owned; useComputed derives; useSignalEffect observes base', async () => {
		const base = createAtom(2)
		const effectSeen: number[] = []
		function App() {
			const own = useAtom(10)
			const sum = useComputed(() => base.get() + own.get(), [own])
			useSignalEffect(
				() => ({
					watch: () => base.get(),
					run: (v) => {
						effectSeen.push(v)
					},
				}),
				[],
			)
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
		await flushEffects()
		expect(text(container)).toBe('s:13;o:10;')
		expect(effectSeen).toEqual([2, 3])
	})
})
