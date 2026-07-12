/** Lifetime effects, lazy initializers, SSR, tracer. */
import { describe, expect, test } from 'vitest'
import * as fx2 from '../src/index.ts'
import {
	attachTracer,
	createComputed,
	effect,
	initializeAtomState,
	installState,
	isPending,
	nodeOf,
	read,
	reducerAtom,
	serializeAtomState,
	createAtom,
	type Atom,
	type Computed,
	untracked,
	update,
} from '../src/index.ts'
import {
	FORBID_WRITE_FROM_COMPUTED,
	SignalReadForbidden,
	SignalWriteForbidden,
	observeNode,
} from '../src/graph.ts'
import { openDraft, retireDraft, runWithDraftWrites, sealDraft } from '../src/worlds.ts'

type Animal = { name: string }
type Dog = Animal & { bark(): void }
type ExpectFalse<T extends false> = T
type ExpectTrue<T extends true> = T
type AtomIsInvariant = ExpectFalse<Atom<Dog> extends Atom<Animal> ? true : false>
type ComputedIsCovariant = ExpectTrue<Computed<Dog> extends Computed<Animal> ? true : false>

const tick = () => new Promise<void>((r) => setTimeout(r))

describe('lifetime effects', () => {
	test('first subscriber of any kind activates; last of every kind deactivates', async () => {
		const log: string[] = []
		const a = createAtom(0, {
			onObserved: (ctx) => {
				log.push(`on:${ctx.get()}`)
				return () => log.push('off')
			},
		})
		const c = createComputed(() => a.get() * 2)
		read(c) // unobserved computed chain: no observation
		await tick()
		expect(log).toEqual([])
		const dispose = effect(() => void c.get()) // observes the chain into a
		await tick()
		expect(log).toEqual(['on:0'])
		const unsub = observeNode(nodeOf(a), () => {}) // second kind: store subscription
		await tick()
		expect(log).toEqual(['on:0']) // union: still one observation
		dispose()
		await tick()
		expect(log).toEqual(['on:0']) // the subscription still holds it
		unsub()
		await tick()
		expect(log).toEqual(['on:0', 'off'])
	})

	test('flaps within one tick coalesce; ctx.set writes urgently', async () => {
		const log: string[] = []
		const a = createAtom(1, {
			onObserved: (ctx) => {
				log.push('on')
				ctx.set(ctx.get() + 41)
				return () => log.push('off')
			},
		})
		const d1 = effect(() => void a.get())
		d1()
		const d2 = effect(() => void a.get())
		await tick()
		expect(log).toEqual(['on']) // net one activation across the flap
		expect(read(a)).toBe(42)
		d2()
		await tick()
		expect(log).toEqual(['on', 'off'])
	})
})

test('forbidden-operation errors name themselves', () => {
	expect(new SignalReadForbidden().name).toBe('SignalReadForbidden')
	expect(new SignalWriteForbidden().name).toBe('SignalWriteForbidden')
})

describe('lazy initializers', () => {
	test('runs once at first read, not at construction', () => {
		let runs = 0
		const a = createAtom(() => {
			runs++
			return 7
		})
		expect(runs).toBe(0)
		expect(read(a)).toBe(7)
		expect(read(a)).toBe(7)
		expect(runs).toBe(1)
	})

	test('set before first read runs the initializer first (equality base)', () => {
		let runs = 0
		const a = createAtom(() => {
			runs++
			return 1
		})
		a.set(5)
		expect(runs).toBe(1)
		expect(read(a)).toBe(5)
	})

	test('update before first read applies against the initialized base', () => {
		const a = createAtom(() => 10)
		update(a, (x) => x + 5)
		expect(read(a)).toBe(15)
	})

	test('an initializer is forbidden from writing', () => {
		const b = createAtom(0)
		const a = createAtom((): number => {
			b.set(1)
			return 0
		})
		expect(() => read(a)).toThrow(/initializer/)
	})

	test('a throwing initializer retries on the next read', () => {
		let runs = 0
		const a = createAtom(() => {
			runs++
			if (runs === 1) {
				throw new Error('flaky')
			}
			return 5
		})
		expect(() => read(a)).toThrow('flaky')
		expect(read(a)).toBe(5)
		expect(runs).toBe(2)
	})

	test('a cyclic initializer throws a clear error', () => {
		const a = createAtom((): number => a.get() + 1)
		expect(() => read(a)).toThrow(/cyclic lazy initializer/)
	})

	test('subscription materializes', () => {
		let runs = 0
		const a = createAtom(() => {
			runs++
			return 3
		})
		const unsub = observeNode(nodeOf(a), () => {})
		expect(runs).toBe(1)
		unsub()
	})
})

describe('computed policy and APIs', () => {
	test('factories return graph nodes without runtime handle classes', () => {
		const source = createAtom(1)
		const reduced = reducerAtom((state: number, action: number) => state + action, 1)
		const computedValue = createComputed(() => source.get() + 1)
		const otherComputed = createComputed(() => 0)
		expect(nodeOf(source)).toBe(source)
		expect(nodeOf(reduced)).toBe(reduced)
		expect(nodeOf(computedValue)).toBe(computedValue)
		expect(Object.getPrototypeOf(computedValue)).toBe(Object.prototype)
		expect(computedValue.get).toBe(otherComputed.get)
		expect(computedValue.peek).toBe(otherComputed.peek)
		expect(fx2).not.toHaveProperty('Atom')
		expect(fx2).not.toHaveProperty('ReducerAtom')
		expect(fx2).not.toHaveProperty('Computed')
		expect(fx2).not.toHaveProperty('signal')
		expect(fx2).not.toHaveProperty('computed')
		expect(fx2.createAtom).toBe(createAtom)
		expect(fx2.reducerAtom).toBe(reducerAtom)
		expect(fx2.createComputed).toBe(createComputed)
	})

	test('previous is the last settled canonical value', () => {
		const source = createAtom(1)
		const seen: Array<number | undefined> = []
		const doubled = createComputed<number>((_use, previous) => {
			seen.push(previous)
			return source.get() * 2
		})
		expect(doubled.get()).toBe(2)
		source.set(3)
		expect(doubled.get()).toBe(6)
		expect(seen).toEqual([undefined, 2])
	})

	test('a computed cannot read itself', () => {
		let self!: ReturnType<typeof createComputed<number>>
		self = createComputed(() => self.get())
		expect(() => self.get()).toThrow(/cycle detected in computed/)
	})

	test('a previously settled computed still cannot read itself', () => {
		const recurse = createAtom(false)
		let self!: ReturnType<typeof createComputed<number>>
		self = createComputed((_use, previous) => {
			if (recurse.get()) {
				return self.get()
			}
			return previous ?? 1
		})
		expect(self.get()).toBe(1)
		recurse.set(true)
		expect(() => self.get()).toThrow(/cycle detected in computed/)
	})

	test('updaters cannot read or write signals', () => {
		const a = createAtom(1)
		const b = createAtom(10)
		expect(() => a.update((value) => value + b.get())).toThrow(SignalReadForbidden)
		expect(() => a.update((value) => value + b.get())).toThrow(/reads are not allowed/)
		expect(() => a.update((value) => value + Number(isPending(b)))).toThrow(/reads are not allowed/)
		expect(() =>
			a.update((value) => {
				b.set(20)
				return value
			}),
		).toThrow(SignalWriteForbidden)
		expect(a.get()).toBe(1)
		expect(b.get()).toBe(10)
	})

	test('writes inside computeds are forbidden by policy', () => {
		expect(FORBID_WRITE_FROM_COMPUTED).toBe(true)
		const target = createAtom(0)
		const writer = createComputed(() => {
			target.set(1)
			return 1
		})
		expect(() => writer.get()).toThrow(/writes inside computeds are forbidden/)
		expect(target.get()).toBe(0)
	})

	test('untracked does not bypass computed write policy', () => {
		const target = createAtom(0)
		const writer = createComputed(() =>
			untracked(() => {
				target.set(1)
				return 1
			}),
		)
		expect(() => writer.get()).toThrow(/writes inside computeds are forbidden/)
		expect(target.get()).toBe(0)
	})

	test('ReducerAtom dispatches through its fixed reducer and inherits signal writes', () => {
		const count = reducerAtom((state: number, action: number) => state + action, 10)
		count.dispatch(5)
		expect(count.get()).toBe(15)
		count.set(1)
		count.update((value) => value * 3)
		expect(count.get()).toBe(3)
	})
})

describe('SSR', () => {
	test('serialize/initialize round-trips; install skips initializers and is not a write', () => {
		const s1 = createAtom(1)
		const s2 = createAtom('x')
		s1.set(5)
		const json = serializeAtomState([s1, s2])
		let initRuns = 0
		const c1 = createAtom((): number => {
			initRuns++
			return 0
		})
		const c2 = createAtom('default')
		let effectRuns = 0
		const dispose = effect(() => {
			void c2.get()
			effectRuns++
		})
		initializeAtomState(json, [c1, c2])
		expect(initRuns).toBe(0)
		expect(effectRuns).toBe(1) // install did not count as a write
		expect(read(c1)).toBe(5)
		expect(read(c2)).toBe('x')
		expect(initRuns).toBe(0)
		dispose()
	})

	test('record keys and replacer/reviver pass through', () => {
		const a = createAtom(2)
		const json = serializeAtomState({ count: a }, (_k, v) => (typeof v === 'number' ? v * 10 : v))
		const b = createAtom(0)
		initializeAtomState(json, { count: b }, (_k, v) => (typeof v === 'number' ? v / 10 : v))
		expect(read(b)).toBe(2)
		const fresh = createAtom(0)
		installState(fresh, 9)
		expect(read(fresh)).toBe(9)
	})
})

describe('causality tracer', () => {
	test('chains: effect run -> write -> parent write; ring bounds with counted overflow', () => {
		const t = attachTracer({ capacity: 16 })
		const a = createAtom(0, { label: 'a' })
		const b = createAtom(0, { label: 'b' })
		effect(() => b.set(a.get() + 1)) // writes b whenever a changes
		a.set(1)
		const events = t.events()
		const kinds = events.map((e) => e.kind)
		expect(kinds).toContain('write')
		expect(kinds).toContain('effect-run')
		// The write to b is caused by the effect run, which is caused by the
		// write to a.
		const writeB = [...events].reverse().find((e) => e.kind === 'write' && e.label === 'b')!
		const effectRun = events.find((e) => e.id === writeB.cause)!
		expect(effectRun.kind).toBe('effect-run')
		const writeA = events.find((e) => e.id === effectRun.cause)!
		expect(writeA.kind).toBe('write')
		expect(writeA.label).toBe('a')
		// Unrelated operations never chain.
		const unrelated = createAtom(0, { label: 'u' })
		unrelated.set(1)
		const writeU = t.events().find((e) => e.kind === 'write' && e.label === 'u')!
		expect(writeU.cause).toBe(0)
		// Overflow is counted, never silent.
		for (let i = 0; i < 100; i++) {
			a.set(i + 10)
		}
		expect(t.dropped).toBeGreaterThan(0)
		expect(t.events().length).toBeLessThanOrEqual(16)
		t.stop()
	})

	test('draft chains: retire event points at the draft last write, opens the fold writes', () => {
		const t = attachTracer()
		const a = createAtom(1, { label: 'a' })
		const d = openDraft()
		runWithDraftWrites(d, () => a.update((x) => x + 1))
		sealDraft(d)
		retireDraft(d.id)
		const events = t.events()
		const retire = events.find((e) => e.kind === 'draft-retire')!
		const draftWrite = events.find((e) => e.id === retire.cause)!
		expect(draftWrite.kind).toBe('write')
		const foldWrite = [...events].reverse().find((e) => e.kind === 'write' && e.label === 'a')!
		expect(foldWrite.cause).toBe(retire.id)
		t.stop()
	})
})
