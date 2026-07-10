/**
 * Hook behavior unit tests: render/update/unmount, StrictMode double-mount
 * netting, deps-keyed recreation of useComputed nodes, the ctx.previous
 * hint, useReducerAtom's useReducer parity, and useSignalEffect's
 * committed-world contract.
 */
import { describe, expect, test, afterEach } from 'vitest'
import * as React from 'react'
import {
	Atom,
	ReducerAtom,
	BATCH_NONE,
	__TEST__internalsById,
	__TEST__resetEngine,
	attachDriver,
	untracked,
	type AtomInternals,
} from 'cosignals'
import {
	registerCosignalReact,
	requireShim,
	useSignal,
	useComputed,
	useReducerAtom,
	useSignalEffect,
} from '../src/index.js'
import { makeHarness, act, text, deferred, type Harness } from './helpers.js'

let h: Harness
afterEach(async () => {
	await h.cleanup()
})

describe('useSignal', () => {
	test('renders the atom value and re-renders on set', async () => {
		h = makeHarness()
		const a = new Atom(1)
		function View() {
			return <span>{useSignal(a)}</span>
		}
		const { container } = await h.mount(<View />)
		expect(text(container)).toBe('1')
		await act(async () => {
			a.set(2)
		})
		expect(text(container)).toBe('2')
	})

	test('functional update routes the whole op (replay fidelity)', async () => {
		h = makeHarness()
		const a = new Atom(10)
		function View() {
			return <span>{useSignal(a)}</span>
		}
		const { container } = await h.mount(<View />)
		await act(async () => {
			a.update((n) => n + 5)
		})
		expect(text(container)).toBe('15')
		// The log entry holds the updater function itself, not a pre-folded value,
		// so each world can replay it against its own view.
		const node = __TEST__internalsById(a._id) as AtomInternals
		const ops = [
			...node.log.materialize(),
			...h.compacted.filter((c) => c.atom === node).map((c) => c.entry),
		].map((r) => r.op.kind)
		expect(ops).toContain('update')
	})

	test('unmount unsubscribes (no delivery to dead components)', async () => {
		h = makeHarness()
		const a = new Atom(0)
		let renders = 0
		function View() {
			renders++
			return <span>{useSignal(a)}</span>
		}
		const { root, container } = await h.mount(<View />)
		expect(text(container)).toBe('0')
		await act(async () => {
			root.render(<div />)
		})
		await act(async () => {}) // debounced unsubscribe finalizes
		expect(h.bridge.watchers.size).toBe(0)
		const before = renders
		await act(async () => {
			a.set(9)
		})
		expect(renders).toBe(before)
	})

	test('two components over one atom stay consistent in one commit', async () => {
		h = makeHarness()
		const a = new Atom('x')
		function View({ id }: { id: string }) {
			return (
				<span>
					{id}={useSignal(a)}{' '}
				</span>
			)
		}
		const { container } = await h.mount(
			<>
				<View id="a" />
				<View id="b" />
			</>,
		)
		await act(async () => {
			a.set('y')
		})
		expect(text(container)).toBe('a=y b=y')
	})

	test('write during render throws (§3.6)', async () => {
		h = makeHarness()
		const a = new Atom(0)
		let thrown: unknown
		function Bad() {
			try {
				a.set(1)
			} catch (err) {
				thrown = err
			}
			return <span>{useSignal(a)}</span>
		}
		await h.mount(<Bad />)
		expect(String(thrown)).toMatch(/write during render/)
	})

	test('StrictMode double render/effects net to one subscription', async () => {
		h = makeHarness()
		const a = new Atom(1)
		function View() {
			return <span>{useSignal(a)}</span>
		}
		const { container } = await h.mount(
			<React.StrictMode>
				<View />
			</React.StrictMode>,
		)
		expect(text(container)).toBe('1')
		await act(async () => {}) // orphan sweep + unsub debounce settle
		expect(h.bridge.watchers.size).toBe(1)
		await act(async () => {
			a.set(2)
		})
		expect(text(container)).toBe('2')
		expect(h.bridge.watchers.size).toBe(1)
	})
})

describe('useComputed (§3.3 cut C3)', () => {
	test('deps-keyed recreation: equal deps reuse the node, changed deps create fresh', async () => {
		h = makeHarness()
		const a = new Atom(2)
		const seen: number[] = []
		function View({ mult }: { mult: number }) {
			const c = useComputed<number>((_ctx) => useSignalValueless(a) * mult, [mult])
			seen.push(c._id) // S-C: the kernel record id IS the node identity
			return <span>{useSignal(c)}</span>
		}
		// helper: read the atom inside the computed via its patched .state
		function useSignalValueless(atom: Atom<number>): number {
			return atom.state
		}
		const { root, container } = await h.mount(<View mult={10} />)
		expect(text(container)).toBe('20')
		await act(async () => {
			root.render(<View mult={10} />)
		})
		expect(new Set(seen).size).toBe(1) // same node reused
		await act(async () => {
			root.render(<View mult={100} />)
		})
		expect(text(container)).toBe('200')
		expect(new Set(seen).size).toBe(2) // fresh node for changed deps
	})

	test('computed re-renders when its atom dependency changes (K1 edges recorded)', async () => {
		h = makeHarness()
		const a = new Atom(1)
		function View() {
			const c = useComputed(() => a.state * 2, [])
			return <span>{useSignal(c)}</span>
		}
		const { container } = await h.mount(<View />)
		expect(text(container)).toBe('2')
		await act(async () => {
			a.set(5)
		})
		expect(text(container)).toBe('10')
	})

	test('ctx.previous returns the last committed value (§3.4 hint)', async () => {
		h = makeHarness()
		const a = new Atom(1)
		const previousSeen: Array<number | undefined> = []
		function View() {
			const c = useComputed<number>((ctx) => {
				previousSeen.push(ctx.previous)
				return a.state * 2
			}, [])
			return <span>{useSignal(c)}</span>
		}
		const { container } = await h.mount(<View />)
		expect(text(container)).toBe('2')
		expect(previousSeen[0]).toBeUndefined() // first evaluation: no committed value
		await act(async () => {
			a.set(3)
		})
		expect(text(container)).toBe('6')
		// Some later evaluation observed the previously committed value (2). The
		// contract licenses staleness/undefined but the committed hint must appear.
		expect(previousSeen).toContain(2)
	})
})

describe('useReducerAtom (§3.2)', () => {
	test('dispatch folds through the fixed reducer; ops are replayed whole', async () => {
		h = makeHarness()
		function View() {
			const [count, dispatch] = useReducerAtom(
				(s: number, action: 'inc' | 'dec') => (action === 'inc' ? s + 1 : s - 1),
				0,
			)
			return (
				<button onClick={() => dispatch('inc')}>
					<span>{count}</span>
				</button>
			)
		}
		const { container } = await h.mount(<View />)
		expect(text(container)).toBe('0')
		const button = container.querySelector('button')!
		await act(async () => {
			button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
		})
		expect(text(container)).toBe('1')
	})

	test('standalone ReducerAtom dispatch classifies as a whole update op (the closure carries the action)', async () => {
		h = makeHarness()
		const r = new ReducerAtom((s: number, a: number) => s + a, 100)
		function View() {
			return <span>{useSignal(r)}</span>
		}
		const { container } = await h.mount(<View />)
		await act(async () => {
			r.dispatch(7)
		})
		expect(text(container)).toBe('107')
		const node = __TEST__internalsById(r._id) as AtomInternals
		const kinds = [
			...node.log.materialize(),
			...h.compacted.filter((c) => c.atom === node).map((c) => c.entry),
		].map((x) => x.op.kind)
		expect(kinds).toContain('update') // re-pinned: dispatch → update(s => reduce(s, action))
	})
})

describe('useSignalEffect (§5.11)', () => {
	test('converges one signal change delivered through React props and signal dependencies into one run', async () => {
		h = makeHarness()
		const a = new Atom(0)
		const observed: Array<{ aFromReact: number; aFromSignal: number }> = []

		function Child({ aFromReact }: { aFromReact: number }) {
			useSignalEffect(() => {
				observed.push({ aFromReact, aFromSignal: a.state })
			}, [aFromReact])
			return null
		}

		function Parent() {
			return <Child aFromReact={useSignal(a)} />
		}

		await h.mount(<Parent />)
		expect(observed).toEqual([{ aFromReact: 0, aFromSignal: 0 }])
		await act(async () => {
			a.set(1)
		})
		expect(observed).toEqual([
			{ aFromReact: 0, aFromSignal: 0 },
			{ aFromReact: 1, aFromSignal: 1 },
		])
	})

	test('signal-only notification runs without rendering the component', async () => {
		h = makeHarness()
		const a = new Atom(0)
		const observed: number[] = []
		let renders = 0
		function View() {
			renders++
			useSignalEffect(() => {
				observed.push(a.state)
			}, [])
			return null
		}
		await h.mount(<View />)
		const rendersAfterMount = renders
		await act(async () => {
			a.set(1)
		})
		expect(observed).toEqual([0, 1])
		expect(renders).toBe(rendersAfterMount)
	})

	test('a signal write from the body reruns only after the current dependency frame closes', async () => {
		h = makeHarness()
		const a = new Atom(0)
		const observed: number[] = []
		let renders = 0
		function View() {
			renders++
			useSignalEffect(() => {
				const value = a.state
				observed.push(value)
				if (value < 2) a.set(value + 1)
			}, [])
			return null
		}
		await h.mount(<View />)
		expect(observed).toEqual([0, 1, 2])
		expect(renders).toBe(1)
	})

	test('React-only dependency change runs once and retracks signal dependencies', async () => {
		h = makeHarness()
		const a = new Atom(10)
		const b = new Atom(20)
		const observed: number[] = []
		function View({ pickA }: { pickA: boolean }) {
			useSignalEffect(() => {
				observed.push((pickA ? a : b).state)
			}, [pickA])
			return null
		}
		const { root } = await h.mount(<View pickA={true} />)
		await act(async () => {
			root.render(<View pickA={false} />)
		})
		expect(observed).toEqual([10, 20])
		await act(async () => {
			a.set(11)
		})
		expect(observed).toEqual([10, 20])
		await act(async () => {
			b.set(21)
		})
		expect(observed).toEqual([10, 20, 21])
	})

	test('same-root React work with unchanged deps neither loses nor duplicates a signal request', async () => {
		h = makeHarness()
		const signalOnly = new Atom(0)
		const renderTick = new Atom(0)
		const observed: number[] = []
		function View() {
			void useSignal(renderTick)
			useSignalEffect(() => {
				observed.push(signalOnly.state)
			}, [])
			return null
		}
		await h.mount(<View />)
		await act(async () => {
			signalOnly.set(1)
			renderTick.set(1)
		})
		expect(observed).toEqual([0, 1])
	})

	test('the final report wins when a render-phase rerender reverts the React deps', async () => {
		h = makeHarness()
		const a = new Atom(0)
		const observed: number[] = []
		function View() {
			const value = useSignal(a)
			const [rerendered, setRerendered] = React.useState(false)
			const dep = value === 1 && !rerendered ? 1 : 0
			useSignalEffect(() => {
				observed.push(a.state)
			}, [dep])
			if (value === 1 && !rerendered) setRerendered(true)
			return null
		}
		await h.mount(<View />)
		await act(async () => {
			a.set(1)
		})
		expect(observed).toEqual([0, 1])
	})

	test('a matching suspended render never runs the old React closure early', async () => {
		h = makeHarness()
		const a = new Atom(0)
		const gate = deferred<void>()
		const observed: Array<{ prop: number; signal: number }> = []
		function Child({ value }: { value: number }) {
			useSignalEffect(() => {
				observed.push({ prop: value, signal: a.state })
			}, [value])
			if (value > 0 && !gate.settled) throw gate.promise
			return null
		}
		function Parent() {
			return (
				<React.Suspense fallback={null}>
					<Child value={useSignal(a)} />
				</React.Suspense>
			)
		}
		await h.mount(<Parent />)
		await act(async () => {
			React.startTransition(() => a.set(1))
		})
		expect(observed).toEqual([{ prop: 0, signal: 0 }])
		gate.settled = true
		await act(async () => {
			gate.resolve()
		})
		expect(observed).toEqual([
			{ prop: 0, signal: 0 },
			{ prop: 1, signal: 1 },
		])
	})

	test('StrictMode replay and signal reruns share one cleanup owner', async () => {
		h = makeHarness()
		const a = new Atom(0)
		const log: string[] = []
		function View() {
			useSignalEffect(() => {
				const value = a.state
				log.push(`run:${value}`)
				return () => log.push(`clean:${value}`)
			}, [])
			return null
		}
		const { root } = await h.mount(
			<React.StrictMode>
				<View />
			</React.StrictMode>,
		)
		expect(log).toEqual(['run:0', 'clean:0', 'run:0'])
		await act(async () => {
			a.set(1)
		})
		expect(log).toEqual(['run:0', 'clean:0', 'run:0', 'clean:0', 'run:1'])
		await act(async () => {
			root.render(
				<React.StrictMode>
					<div />
				</React.StrictMode>,
			)
		})
		expect(log).toEqual(['run:0', 'clean:0', 'run:0', 'clean:0', 'run:1', 'clean:1'])
	})

	test('dynamic and untracked dependencies move lifecycle liveness by real graph edge', async () => {
		h = makeHarness()
		const lifecycle: string[] = []
		const observed = (name: string) =>
			new Atom(0, {
				effect: () => {
					lifecycle.push(`observe:${name}`)
					return () => lifecycle.push(`unobserve:${name}`)
				},
			})
		const chooseA = new Atom(true)
		const a = observed('a')
		const b = observed('b')
		const ignored = observed('ignored')
		let runs = 0
		function View() {
			useSignalEffect(() => {
				runs++
				void (chooseA.state ? a.state : b.state)
				void untracked(() => ignored.state)
			}, [])
			return null
		}
		const { root } = await h.mount(<View />)
		await act(async () => {})
		expect(lifecycle).toEqual(['observe:a'])
		await act(async () => {
			ignored.set(1)
		})
		expect(runs).toBe(1)
		await act(async () => {
			chooseA.set(false)
		})
		await act(async () => {})
		expect(lifecycle).toEqual(['observe:a', 'observe:b', 'unobserve:a'])
		await act(async () => {
			root.render(<div />)
		})
		await act(async () => {})
		expect(lifecycle).toEqual(['observe:a', 'observe:b', 'unobserve:a', 'unobserve:b'])
	})

	test('observes committed values and re-fires on committed flips only', async () => {
		h = makeHarness()
		const a = new Atom(0)
		const observed: number[] = []
		function View() {
			useSignalEffect(() => {
				observed.push(a.state as number)
			}, [])
			return <span>{useSignal(a)}</span>
		}
		await h.mount(<View />)
		expect(observed).toEqual([0])
		await act(async () => {
			a.set(1)
		})
		expect(observed[observed.length - 1]).toBe(1)
	})

	test('cleanup runs before re-fire and at unmount', async () => {
		h = makeHarness()
		const a = new Atom(0)
		const log: string[] = []
		function View() {
			useSignalEffect(() => {
				const v = a.state as number
				log.push(`run:${v}`)
				return () => log.push(`clean:${v}`)
			}, [])
			return <span>{useSignal(a)}</span>
		}
		const { root } = await h.mount(<View />)
		await act(async () => {
			a.set(2)
		})
		await act(async () => {
			root.render(<div />)
		})
		expect(log[0]).toBe('run:0')
		expect(log).toContain('clean:0')
		expect(log).toContain('run:2')
		expect(log[log.length - 1]).toBe('clean:2')
	})
})

describe('AtomOptions.effect observed lifecycle on the React path (observation union)', () => {
	// MECHANISM. Observation is ONE core concept counted over the UNION of
	// consumer kinds: kernel subscribers (a live computed chain, a core
	// effect()) flip the kernel liveness bit (D1), and React subscribers —
	// bridge watchers created by useSignal — retain/release the SAME refcount
	// when their engine-side liveness flips (commit layout loop, reveal
	// resubscribe, orphan sweep, debounce-finalized unsubscribe). The callback
	// fires on the union's 0→1 transition, the cleanup on its 1→0, both
	// microtask-coalesced, so same-tick flaps net to nothing regardless of
	// which consumer kind produced them.

	function observedAtom(initial: number): { atom: Atom<number>; log: string[] } {
		const log: string[] = []
		const atom = new Atom(initial, {
			effect: () => {
				log.push('observe')
				return () => log.push('unobserve')
			},
		})
		return { atom, log }
	}

	test('useSignalEffect-only subscriber counts toward the union: observe after the first run, unobserve after unmount (OL1 re-pin, effects unification)', async () => {
		// Before the unification an atom observed ONLY by a useSignalEffect
		// never triggered its observe lifecycle — the incident-I3-shaped
		// asymmetry OL1 forbids ("ALL consumer kinds"). The SignalEffect's
		// ordinary strong edges now hold one retain per dependency.
		h = makeHarness()
		const { atom: a, log } = observedAtom(0)
		function View() {
			useSignalEffect(() => {
				void (a.state as number)
			}, [])
			return <span>x</span>
		}
		const { root } = await h.mount(<View />)
		await act(async () => {}) // observation delivery is microtask-coalesced
		expect(log).toEqual(['observe']) // an effect-only consumer observes
		await act(async () => {
			a.set(1) // re-fire re-captures the same dep: no flap
		})
		await act(async () => {})
		expect(log).toEqual(['observe'])
		await act(async () => {
			root.render(<div />)
		})
		await act(async () => {}) // teardown removes the terminal's edges
		expect(log).toEqual(['observe', 'unobserve'])
	})

	test('useSignal-only subscriber: observe after mount, unobserve after unmount', async () => {
		h = makeHarness()
		const { atom: a, log } = observedAtom(0)
		function View() {
			return <span>v:{useSignal(a)};</span>
		}
		const { root, container } = await h.mount(<View />)
		expect(text(container)).toBe('v:0;')
		await act(async () => {}) // observation delivery is microtask-coalesced
		expect(log).toEqual(['observe']) // a React-only subscriber observes
		await act(async () => {
			a.set(1)
		})
		expect(text(container)).toBe('v:1;')
		expect(log).toEqual(['observe']) // deliveries do not re-observe
		await act(async () => {
			root.render(<div />)
		})
		await act(async () => {}) // debounced unsubscribe + flap damping settle
		expect(log).toEqual(['observe', 'unobserve'])
		// CONTRAST (kernel subscriber): the union's other consumer kind — the
		// kernel liveness bit — drives the same callback after the React leg
		// is long gone.
		const { effect } = await import('cosignals')
		const dispose = effect(() => {
			void a.state
		})
		await act(async () => {}) // microtask delivery
		expect(log).toEqual(['observe', 'unobserve', 'observe'])
		dispose()
		await act(async () => {})
		expect(log).toEqual(['observe', 'unobserve', 'observe', 'unobserve'])
	})

	test('mixed kernel + watcher consumers: one observation; unobserve only after BOTH detach', async () => {
		h = makeHarness()
		const { atom: a, log } = observedAtom(0)
		const { effect } = await import('cosignals')
		const dispose = effect(() => {
			void a.state // kernel consumer attaches first
		})
		await act(async () => {})
		expect(log).toEqual(['observe'])
		function View() {
			return <span>{useSignal(a)}</span>
		}
		const { root } = await h.mount(<View />)
		await act(async () => {})
		expect(log).toEqual(['observe']) // watcher joined: interior transition, no re-observe
		await act(async () => {
			root.render(<div />) // React leg detaches…
		})
		await act(async () => {})
		expect(log).toEqual(['observe']) // …but the kernel effect still holds the atom
		dispose() // the LAST consumer leaves
		await act(async () => {})
		expect(log).toEqual(['observe', 'unobserve'])
	})

	test('StrictMode double render/effects: one observation, no flap', async () => {
		h = makeHarness()
		const { atom: a, log } = observedAtom(1)
		function View() {
			return <span>{useSignal(a)}</span>
		}
		const { root, container } = await h.mount(
			<React.StrictMode>
				<View />
			</React.StrictMode>,
		)
		expect(text(container)).toBe('1')
		await act(async () => {}) // orphan sweep + unsub debounce settle
		expect(log).toEqual(['observe']) // double mount/unmount netted — no unobserve flap
		await act(async () => {
			a.set(2)
		})
		expect(text(container)).toBe('2')
		expect(log).toEqual(['observe'])
		await act(async () => {
			root.render(
				<React.StrictMode>
					<div />
				</React.StrictMode>,
			)
		})
		await act(async () => {})
		expect(log).toEqual(['observe', 'unobserve'])
	})

	test('two components over one atom: observe once, unobserve after the LAST unmounts', async () => {
		h = makeHarness()
		const { atom: a, log } = observedAtom(0)
		function View() {
			return <span>{useSignal(a)};</span>
		}
		function App({ n }: { n: number }) {
			return (
				<>
					{n >= 1 ? <View /> : null}
					{n >= 2 ? <View /> : null}
				</>
			)
		}
		const { root } = await h.mount(<App n={2} />)
		await act(async () => {})
		expect(log).toEqual(['observe']) // two watchers, ONE observation
		await act(async () => {
			root.render(<App n={1} />)
		})
		await act(async () => {})
		expect(log).toEqual(['observe']) // one subscriber remains: no unobserve yet
		await act(async () => {
			root.render(<App n={0} />)
		})
		await act(async () => {})
		expect(log).toEqual(['observe', 'unobserve'])
	})

	test('Activity hide/reveal: same-tick toggle holds the observation; a real hide unobserves, the reveal re-observes', async () => {
		h = makeHarness()
		const { atom: a, log } = observedAtom(1)
		const Activity = (React as unknown as Record<string, unknown>).Activity as React.ComponentType<{
			mode: 'visible' | 'hidden'
			children?: React.ReactNode
		}>
		expect(Activity).toBeDefined()
		function View() {
			return <span>{useSignal(a)}</span>
		}
		function App({ mode }: { mode: 'visible' | 'hidden' }) {
			return (
				<Activity mode={mode}>
					<View />
				</Activity>
			)
		}
		const { root } = await h.mount(<App mode="visible" />)
		await act(async () => {})
		expect(log).toEqual(['observe'])
		// Hide + reveal inside one tick: the retained watcher's claim cancels
		// the debounced unsubscribe (the same netting StrictMode uses), so the
		// upstream subscription never flaps.
		await act(async () => {
			root.render(<App mode="hidden" />)
			root.render(<App mode="visible" />)
		})
		await act(async () => {})
		expect(log).toEqual(['observe'])
		// A real hide IS an unsubscription (deliveries stop while hidden —
		// case 9(e)): the union empties and the upstream subscription closes…
		await act(async () => {
			root.render(<App mode="hidden" />)
		})
		await act(async () => {})
		expect(log).toEqual(['observe', 'unobserve'])
		// …and the reveal resubscribe observes again, once.
		await act(async () => {
			root.render(<App mode="visible" />)
		})
		await act(async () => {})
		expect(log).toEqual(['observe', 'unobserve', 'observe'])
	})

	test('derived subscriber (was the KNOWN GAP): useComputed closure atoms observe on mount and unobserve after unmount, StrictMode-safe', async () => {
		// The component subscribes to a DERIVED node (useComputed + useSignal):
		// the watcher sits on the computed, not the atom — pre-fix the atom
		// underneath never observed (only DIRECT consumers fed the union;
		// kernel chains retained transitively but overlay chains did not).
		h = makeHarness()
		const { atom: a, log } = observedAtom(2)
		function View() {
			const doubled = useComputed(() => (a.state as number) * 2, [])
			return <span>{useSignal(doubled)}</span>
		}
		const { root, container } = await h.mount(
			<React.StrictMode>
				<View />
			</React.StrictMode>,
		)
		expect(text(container)).toBe('4')
		await act(async () => {}) // orphan sweep + unsub debounce + observe delivery settle
		expect(log).toEqual(['observe']) // the closure atom IS observed; StrictMode double-mount netted
		await act(async () => {
			a.set(3) // delivery through the derived node…
		})
		expect(text(container)).toBe('6')
		expect(log).toEqual(['observe']) // …re-renders without re-observing
		await act(async () => {
			root.render(
				<React.StrictMode>
					<div />
				</React.StrictMode>,
			)
		})
		await act(async () => {}) // debounced unsubscribe finalizes → closure released
		expect(log).toEqual(['observe', 'unobserve'])
	})

	test('quiet-mode interplay: observation transitions need no armed pipeline and leave none armed', async () => {
		h = makeHarness() // quiet derives on its own — observation (the harness tracer) never arms it
		const { atom: a, log } = observedAtom(0)
		expect(h.bridge.quiet).toBe(true)
		function View() {
			return <span>v:{useSignal(a)};</span>
		}
		const { root, container } = await h.mount(<View />)
		await act(async () => {})
		expect(log).toEqual(['observe']) // watcher attach worked while quiet
		expect(h.bridge.quiet).toBe(true) // and armed no pipeline
		await act(async () => {
			a.set(5) // quiet fold: no log entries — deliveries still flow
		})
		expect(text(container)).toBe('v:5;')
		expect(h.bridge.quiet).toBe(true)
		await act(async () => {
			root.render(<div />)
		})
		await act(async () => {})
		expect(log).toEqual(['observe', 'unobserve'])
		expect(h.bridge.quiet).toBe(true)
	})
})

describe('registration lifecycle (module active-shim slot)', () => {
	test('disposing an old shim after a new one has registered must not unregister the new one', async () => {
		h = makeHarness() // registration A (afterEach re-disposes it; that late dispose must stay slot-neutral too)
		const handleA = h.handle
		// A's shim goes dead without its handle's dispose having run, so the
		// slot still points at the disposed shim; registration B must get past
		// the liveness-filtered guard. A's DRIVER record is still attached
		// (dispose never detaches), so the engine resets first — the one way
		// the driver slot clears — before B can attach its own.
		handleA.shim.dispose()
		__TEST__resetEngine({ devChecks: true })
		const handleB = registerCosignalReact()
		try {
			expect(requireShim()).toBe(handleB.shim)
			// The old handle's dispose arrives AFTER the successor registered:
			// it may clear only its own registration, never B's.
			handleA.dispose()
			expect(requireShim()).toBe(handleB.shim)
			// The double-register throw is the SHIM slot's guard — it fires
			// before any driver attach could be attempted.
			expect(() => registerCosignalReact()).toThrow(/already registered/)
		} finally {
			handleB.dispose()
		}
		// B's own dispose (the slot points at B) does clear the slot.
		expect(() => requireShim()).toThrow(/registerCosignalReact/)
	})

	test('one driver per composition: a second attachDriver throws until the engine resets', () => {
		h = makeHarness() // the shim's constructor attached THE driver for this composition
		expect(() =>
			attachDriver({ currentBatch: () => BATCH_NONE, worldFor: () => undefined }),
		).toThrow(/driver is already attached/)
	})
})
