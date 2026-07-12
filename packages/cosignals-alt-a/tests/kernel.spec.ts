import { describe, expect, it } from 'vitest'
import { createCosignalEngine } from '../src/engine'

// M1 — canonical kernel semantics in DIRECT mode (no fork attached).
// These pin the alien-signals behaviors the arena donor implements: laziness,
// equality cutoff, dynamic dependency trimming, exact pull counts, effect
// ordering, batching, disposal, and growth stress.

describe('M1 kernel: atoms and computeds (DIRECT)', () => {
	it('reads and writes atoms', () => {
		const e = createCosignalEngine()
		const a = e.atom(1)
		expect(a.state).toBe(1)
		a.set(5)
		expect(a.state).toBe(5)
		a.update((x) => x + 1)
		expect(a.state).toBe(6)
	})

	it('computeds are lazy and cached with exact pull counts', () => {
		const e = createCosignalEngine()
		const a = e.atom(1)
		let evals = 0
		const c = e.computed(() => {
			++evals
			return a.state * 2
		})
		expect(evals).toBe(0) // lazy
		expect(c.state).toBe(2)
		expect(evals).toBe(1)
		expect(c.state).toBe(2)
		expect(evals).toBe(1) // cached
		a.set(3)
		expect(evals).toBe(1) // push marks, no eager recompute
		expect(c.state).toBe(6)
		expect(evals).toBe(2)
	})

	it('equality cutoff stops propagation (diamond, no glitch)', () => {
		const e = createCosignalEngine()
		const a = e.atom(1)
		const b = e.computed(() => a.state % 2) // 1
		let downstreamEvals = 0
		const c = e.computed(() => {
			++downstreamEvals
			return b.state + 10
		})
		expect(c.state).toBe(11)
		expect(downstreamEvals).toBe(1)
		a.set(3) // b recomputes to 1 — unchanged
		expect(c.state).toBe(11)
		expect(downstreamEvals).toBe(1) // cutoff: c never re-ran
	})

	it('custom equality returns the previous reference (§11.2)', () => {
		const e = createCosignalEngine()
		const a = e.atom(1)
		const c = e.computed(() => ({ v: a.state % 2 }), {
			isEqual: (x, y) => x.v === y.v,
		})
		const first = c.state
		a.set(3)
		expect(c.state).toBe(first) // same reference, not just deep-equal
	})

	it('dynamic dependency trimming: untaken branches stop tracking', () => {
		const e = createCosignalEngine()
		const flag = e.atom(true)
		const x = e.atom(1)
		const y = e.atom(100)
		let evals = 0
		const c = e.computed(() => {
			++evals
			return flag.state ? x.state : y.state
		})
		expect(c.state).toBe(1)
		flag.set(false)
		expect(c.state).toBe(100)
		expect(evals).toBe(2)
		x.set(2) // no longer a dependency
		expect(c.state).toBe(100)
		expect(evals).toBe(2) // not re-run for the trimmed dep
		y.set(200)
		expect(c.state).toBe(200)
		expect(evals).toBe(3)
	})

	it('atom equality gate drops equal writes', () => {
		const e = createCosignalEngine()
		const a = e.atom({ n: 1 }, { isEqual: (p, q) => p.n === q.n })
		let runs = 0
		e.effect(() => {
			a.state
			++runs
		})
		expect(runs).toBe(1)
		a.set({ n: 1 }) // equal per custom equality
		expect(runs).toBe(1)
		a.set({ n: 2 })
		expect(runs).toBe(2)
	})
})

describe('M1 kernel: effects and scheduling (DIRECT)', () => {
	it('effects run synchronously on write, once per write outside batch', () => {
		const e = createCosignalEngine()
		const a = e.atom(0)
		const seen: number[] = []
		e.effect(() => {
			seen.push(a.state)
		})
		a.set(1)
		a.set(2)
		expect(seen).toEqual([0, 1, 2])
	})

	it('batch coalesces flushes', () => {
		const e = createCosignalEngine()
		const a = e.atom(0)
		const b = e.atom(0)
		const seen: string[] = []
		e.effect(() => {
			seen.push(`${a.state},${b.state}`)
		})
		e.batch(() => {
			a.set(1)
			b.set(2)
			expect(a.state).toBe(1) // fresh mid-batch reads
		})
		expect(seen).toEqual(['0,0', '1,2'])
	})

	it('effect cleanup runs before re-run and on dispose', () => {
		const e = createCosignalEngine()
		const a = e.atom(0)
		const log: string[] = []
		const disposeEffect = e.effect(() => {
			const v = a.state
			log.push(`run:${v}`)
			return () => log.push(`cleanup:${v}`)
		})
		a.set(1)
		disposeEffect()
		expect(log).toEqual(['run:0', 'cleanup:0', 'run:1', 'cleanup:1'])
		a.set(2)
		expect(log).toHaveLength(4) // disposed: no more runs
	})

	it('outer effects run before inner (parent chain ordering)', () => {
		const e = createCosignalEngine()
		const a = e.atom(0)
		const order: string[] = []
		e.effect(() => {
			a.state
			order.push('outer')
			e.effect(() => {
				a.state
				order.push('inner')
			})
		})
		order.length = 0
		a.set(1)
		expect(order[0]).toBe('outer')
		expect(order).toContain('inner')
	})

	it('effectScope disposes children in bulk', () => {
		const e = createCosignalEngine()
		const a = e.atom(0)
		let runs = 0
		const disposeScope = e.effectScope(() => {
			e.effect(() => {
				a.state
				++runs
			})
			e.effect(() => {
				a.state
				++runs
			})
		})
		expect(runs).toBe(2)
		a.set(1)
		expect(runs).toBe(4)
		disposeScope()
		a.set(2)
		expect(runs).toBe(4)
	})

	it('untracked reads register no dependency', () => {
		const e = createCosignalEngine()
		const a = e.atom(0)
		const b = e.atom(0)
		let runs = 0
		e.effect(() => {
			a.state
			e.untracked(() => b.state)
			++runs
		})
		b.set(5)
		expect(runs).toBe(1)
		a.set(1)
		expect(runs).toBe(2)
	})

	it('writes inside effects cascade without corruption', () => {
		const e = createCosignalEngine()
		const a = e.atom(0)
		const b = e.atom(0)
		e.effect(() => {
			const v = a.state
			if (v > 0 && b.peek() !== v) {
				b.set(v)
			}
		})
		const seen: number[] = []
		e.effect(() => {
			seen.push(b.state)
		})
		a.set(3)
		expect(b.state).toBe(3)
		expect(seen).toContain(3)
	})
})

describe('M1 kernel: growth stress and reclamation', () => {
	it('survives forced plane doubling (initialRecords: 2)', () => {
		const e = createCosignalEngine({
			initialRecords: 2,
			initialLogRecords: 1,
			initialMemoRecords: 1,
		})
		const atoms = Array.from({ length: 50 }, (_, i) => e.atom(i))
		const sum = e.computed(() => atoms.reduce((s, a) => s + a.state, 0))
		expect(sum.state).toBe((49 * 50) / 2)
		let runs = 0
		const disposers = atoms.map((a) =>
			e.effect(() => {
				a.state
				++runs
			}),
		)
		expect(runs).toBe(50)
		atoms[10].set(1000)
		expect(sum.state).toBe((49 * 50) / 2 - 10 + 1000)
		for (const d of disposers) {
			d()
		}
		e.debug.verify()
	})

	it('disposed records are reclaimed and stale disposers no-op', () => {
		const e = createCosignalEngine()
		const a = e.atom(0)
		const d1 = e.effect(() => {
			a.state
		})
		d1()
		d1() // stale second call: no-op
		const d2 = e.effect(() => {
			a.state
		})
		a.set(1)
		d2()
		e.debug.verify()
	})

	it('reducerAtom dispatch applies the reducer in DIRECT mode', () => {
		const e = createCosignalEngine()
		const r = e.reducerAtom(0, (s: number, action: { type: 'add' | 'mul'; n: number }) =>
			action.type === 'add' ? s + action.n : s * action.n,
		)
		r.dispatch({ type: 'add', n: 5 })
		r.dispatch({ type: 'mul', n: 3 })
		expect(r.state).toBe(15)
	})
})

describe('M1 kernel: DIRECT-mode watchers (broadcast list, §8.7.1)', () => {
	it('IMMEDIATE watchers broadcast synchronously with cutoff', () => {
		const e = createCosignalEngine()
		const a = e.atom(1)
		const c = e.computed(() => a.state % 2)
		const fired: unknown[] = []
		e.watch(c, (ev) => fired.push(ev.value))
		a.set(3) // c: 1 → 1, cutoff suppresses
		expect(fired).toEqual([])
		a.set(4) // c: 1 → 0
		expect(fired).toEqual([0])
		e.debug.verify()
	})

	it('watcher dispose stops broadcasts', () => {
		const e = createCosignalEngine()
		const a = e.atom(1)
		const fired: unknown[] = []
		const w = e.watch(a, (ev) => fired.push(ev.value))
		a.set(2)
		expect(fired).toEqual([2])
		w.dispose()
		a.set(3)
		expect(fired).toEqual([2])
	})
})
