/**
 * Engine-level smoke tests for the vendored Solid core with the [react-adapt]
 * evolutions — no React involved. Pins:
 *  - plain reactivity (signals/memos/effects) still behaves like Solid,
 *  - E1: async suspensions do NOT create ambient transitions; settlement
 *    commits immediately,
 *  - E2/E8/E10: a bridge transition stages writes without touching committed
 *    values, holds user effects, and commits atomically on release,
 *  - E3: an urgent write to a transition-held signal commits now and rebases
 *    into the staged world (arrival-order fold),
 *  - E5: refresh-pending reads serve stale values to stale-posture readers;
 *    first loads throw.
 *
 * Graphs are hosted in a root: unowned memos keep Solid's stock
 * lazy+autodispose semantics (an untracked read of an unobserved memo tears
 * it down), which is noise here.
 */
import { describe, expect, it } from 'vitest'
import {
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	createTrackedEffect,
	flush,
	isPending,
	NotReadyError,
} from '../src/index.js'
import {
	activeTransition,
	createBridgeTransition,
	isTransitionLive,
	releaseTransition,
	retainTransition,
	runInTransition,
	setActiveTransition,
	staleValues,
} from '../src/solid/index.js'
import { probeRead } from '../src/reader.js'
import type { Transition } from '../src/solid/scheduler.js'

function deferred<T>() {
	let resolve!: (v: T) => void
	let reject!: (e: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

const tick = () => new Promise<void>((res) => setTimeout(res, 0))

/** React-urgent-render posture: stale, no world, probe-tracked. */
function urgentRead<T>(fn: () => T): T {
	return staleValues(() => probeRead(fn)).value
}

/** React-transition-render posture: stale, inside the world. */
function worldRead<T>(t: Transition, fn: () => T): T {
	return runInTransition(t, () => staleValues(() => probeRead(fn)).value)
}

/** Simulate React retiring the world's last batch: complete the transition. */
function commitWorld(t: Transition, retainer: unknown): void {
	releaseTransition(t, retainer)
	setActiveTransition(t)
	try {
		flush()
	} finally {
		if (activeTransition !== null) setActiveTransition(null)
	}
}

describe('plain Solid reactivity survives the react-adapt edits', () => {
	it('signal -> memo -> effect propagates and commits at flush', () => {
		const log: number[] = []
		const { setA, double } = createRoot(() => {
			const [a, setA] = createSignal(1)
			const double = createMemo(() => a() * 2)
			createEffect(
				() => double(),
				(v) => {
					log.push(v)
				},
			)
			return { setA, double }
		})
		flush()
		expect(log).toEqual([2])
		setA(5)
		flush()
		expect(double()).toBe(10)
		expect(log).toEqual([2, 10])
	})

	it('diamond recomputes once per flush', () => {
		let runs = 0
		const { setA, d } = createRoot(() => {
			const [a, setA] = createSignal(1)
			const b = createMemo(() => a() + 1)
			const c = createMemo(() => a() + 2)
			const d = createMemo(() => (runs++, b() + c()))
			d()
			return { setA, d }
		})
		expect(runs).toBe(1)
		setA(2)
		flush()
		expect(d()).toBe(7)
		expect(runs).toBe(2)
	})
})

describe('E1: async without transitions', () => {
	it('async memo settles and commits immediately (no ambient held UI)', async () => {
		const gate = deferred<number>()
		const { remote, dependent } = createRoot(() => {
			const remote = createMemo(() => gate.promise)
			const dependent = createMemo(() => `v${remote()}`)
			return { remote, dependent }
		})
		flush()
		expect(activeTransition).toBeNull()
		expect(() => remote()).toThrow() // uninitialized untracked read throws
		gate.resolve(42)
		await tick()
		expect(activeTransition).toBeNull()
		expect(remote()).toBe(42)
		expect(dependent()).toBe('v42')
	})

	it('E5: refetch serves stale value to stale readers, throws for first load', async () => {
		const gate1 = deferred<number>()
		let gate = gate1
		const { dep, setDep, remote } = createRoot(() => {
			const [dep, setDep] = createSignal(1)
			const remote = createMemo(() => (dep(), gate.promise))
			return { dep, setDep, remote }
		})
		flush()
		// first load: stale-posture read still throws (uninitialized)
		expect(() => urgentRead(() => remote())).toThrow(NotReadyError)
		gate1.resolve(10)
		await tick()
		expect(remote()).toBe(10)
		// refetch: stale-posture read serves the previous value
		const gate2 = deferred<number>()
		gate = gate2
		setDep(2)
		flush()
		expect(urgentRead(() => remote())).toBe(10)
		// tracked internal read still aborts (execute-and-abort preserved)
		const downstream = createRoot(() => createMemo(() => remote() + 1))
		expect(() => downstream()).toThrow(NotReadyError)
		// isPending: true during refetch, false after settle
		expect(isPending(() => remote())).toBe(true)
		gate2.resolve(20)
		await tick()
		expect(remote()).toBe(20)
		expect(downstream()).toBe(21)
		expect(isPending(() => remote())).toBe(false)
		expect(dep()).toBe(2)
	})
})

describe('E2/E8/E10: bridge transitions stage and commit atomically', () => {
	it('deferred writes stage; committed view unchanged until release', () => {
		const { a, setA, upper } = createRoot(() => {
			const [a, setA] = createSignal('old')
			const upper = createMemo(() => a().toUpperCase())
			upper()
			return { a, setA, upper }
		})
		const t = createBridgeTransition()
		const retainer = {}
		retainTransition(t, retainer)
		runInTransition(t, () => setA('new'))
		flush()
		// committed world: unchanged (stale-posture read = React urgent render)
		expect(urgentRead(() => a())).toBe('old')
		expect(urgentRead(() => upper())).toBe('OLD')
		// transition world: staged values visible
		expect(worldRead(t, () => upper())).toBe('NEW')
		// release = React retired the batch -> atomic commit
		commitWorld(t, retainer)
		expect(activeTransition).toBeNull()
		expect(isTransitionLive(t)).toBe(false)
		expect(a()).toBe('new')
		expect(upper()).toBe('NEW')
	})

	it('user effects are held while the transition is live, run at commit', () => {
		const log: number[] = []
		const { setA } = createRoot(() => {
			const [a, setA] = createSignal(0)
			createEffect(
				() => a(),
				(v) => {
					log.push(v)
				},
			)
			return { setA }
		})
		flush()
		expect(log).toEqual([0])
		const t = createBridgeTransition()
		const key = {}
		retainTransition(t, key)
		runInTransition(t, () => setA(1))
		flush()
		expect(log).toEqual([0]) // held while transition is live
		commitWorld(t, key)
		expect(log).toEqual([0, 1]) // released at commit
	})

	it('urgent writes commit even while an unrelated transition is parked', () => {
		const { held, setHeld, urgent, setUrgent } = createRoot(() => {
			const [held, setHeld] = createSignal('h0')
			const [urgent, setUrgent] = createSignal('u0')
			return { held, setHeld, urgent, setUrgent }
		})
		const t = createBridgeTransition()
		const key = {}
		retainTransition(t, key)
		runInTransition(t, () => setHeld('h1'))
		flush()
		setUrgent('u1')
		flush()
		expect(urgentRead(() => urgent())).toBe('u1') // urgent committed
		expect(urgentRead(() => held())).toBe('h0') // still held
		commitWorld(t, key)
		expect(held()).toBe('h1')
	})
})

describe('E10: effect delivery is split by world (issue 4)', () => {
	it('urgent commits run tracked effects even while an unrelated transition is held', () => {
		const log: string[] = []
		const { setA, setB } = createRoot(() => {
			const [a, setA] = createSignal('a0')
			const [b, setB] = createSignal('b0')
			createTrackedEffect(() => {
				log.push(`${a()}:${b()}`)
			})
			return { setA, setB }
		})
		flush()
		expect(log).toEqual(['a0:b0'])
		const t = createBridgeTransition()
		const key = {}
		retainTransition(t, key)
		runInTransition(t, () => setA('a1'))
		flush()
		// the transition's draft is held: no effect run, no draft observation
		expect(log).toEqual(['a0:b0'])
		// an unrelated urgent commit still reaches the effect (committed values:
		// old a, new b) — the held transition must not defer it
		setB('b1')
		flush()
		expect(log).toEqual(['a0:b0', 'a0:b1'])
		// the transition's own commit re-runs it with the final committed pair
		commitWorld(t, key)
		expect(log).toEqual(['a0:b0', 'a0:b1', 'a1:b1'])
	})

	it('a transition-only change still reaches the effect exactly once, at its commit', () => {
		const log: number[] = []
		const { setA } = createRoot(() => {
			const [a, setA] = createSignal(0)
			createTrackedEffect(() => {
				log.push(a())
			})
			return { setA }
		})
		flush()
		const t = createBridgeTransition()
		const key = {}
		retainTransition(t, key)
		runInTransition(t, () => setA(1))
		runInTransition(t, () => setA(2)) // second poke must not double-queue
		flush()
		expect(log).toEqual([0])
		commitWorld(t, key)
		expect(log).toEqual([0, 2])
	})
})

describe('E3: urgent rebase over a transition-held signal', () => {
	it('committed applies now; transition rebases on top (React updater-queue fold)', () => {
		const { a, setA } = createRoot(() => {
			const [a, setA] = createSignal(1)
			a()
			return { a, setA }
		})
		const t = createBridgeTransition()
		const key = {}
		retainTransition(t, key)
		runInTransition(t, () => setA((x) => x + 1)) // transition: +1 (staged: 2)
		flush()
		setA((x) => x * 2) // urgent: *2
		flush()
		// urgent world sees 1*2 = 2
		expect(urgentRead(() => a())).toBe(2)
		// transition world rebases: (1+1)*2 = 4
		expect(worldRead(t, () => a())).toBe(4)
		commitWorld(t, key)
		expect(a()).toBe(4)
	})
})

describe('reader/probe frames', () => {
	it('probeRead collects deps and leaves no residue', () => {
		const { a, m } = createRoot(() => {
			const [a] = createSignal(7)
			const m = createMemo(() => a() + 1)
			return { a, m }
		})
		void a
		const r = probeRead(() => m())
		expect(r.value).toBe(8)
		expect(r.deps.length).toBe(1)
		// no subscribers left behind on the memo
		expect((r.deps[0] as any)._subs).toBeNull()
	})

	it('re-reads observe committed updates', () => {
		const { setA, m } = createRoot(() => {
			const [a, setA] = createSignal(1)
			const m = createMemo(() => a() * 3)
			return { setA, m }
		})
		expect(probeRead(() => m()).value).toBe(3)
		setA(2)
		flush()
		expect(probeRead(() => m()).value).toBe(6)
	})
})
