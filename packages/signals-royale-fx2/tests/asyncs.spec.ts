/** Async semantics: pending/error as graph state, suspensions, refetching. */
import { describe, expect, test } from 'vitest'
import { computed, effect, isPending, latest, read, signal } from '../src/index.ts'

function deferred<T>() {
	let resolve!: (v: T) => void
	let reject!: (e: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

const tick = () => new Promise<void>((r) => setTimeout(r))

describe('pending as graph state', () => {
	test('never-settled read throws a stable thenable; settlement converges', async () => {
		const gate = deferred<string>()
		const c = computed((use) => use(gate.promise))
		let thrown1: unknown
		let thrown2: unknown
		try {
			read(c)
		} catch (e) {
			thrown1 = e
		}
		try {
			read(c)
		} catch (e) {
			thrown2 = e
		}
		expect(typeof (thrown1 as PromiseLike<void>).then).toBe('function')
		expect(thrown1).toBe(thrown2) // stable suspension thenable across retries
		// Solid 2.0's pending rule: a FIRST LOAD is not pending — there is no
		// stale data to indicate over; suspending is Suspense's job.
		expect(isPending(c)).toBe(false)
		gate.resolve('done')
		await tick()
		expect(read(c)).toBe('done')
		expect(isPending(c)).toBe(false)
	})

	test('stale value keeps serving while a refetch is pending; latest never suspends', async () => {
		const gates = [deferred<number>(), deferred<number>()]
		// A user-owned nonce cell is the refetch trigger: the computed reads it,
		// so a bump invalidates with the data inputs unchanged and starts a new
		// fetch through the ordinary write path.
		const nonce = signal(0)
		const c = computed((use) => use(gates[nonce.get()].promise))
		gates[0].resolve(1)
		try {
			read(c) // first touch attaches to the (already resolved) thenable
		} catch {
			/* parks until the settlement microtask */
		}
		await tick()
		expect(read(c)).toBe(1)
		nonce.set(1)
		expect(read(c)).toBe(1) // stale serves
		expect(latest(c)).toBe(1)
		expect(isPending(c)).toBe(true)
		gates[1].resolve(2)
		await tick()
		expect(read(c)).toBe(2)
		expect(isPending(c)).toBe(false)
	})

	test('pending forwards: a computed reading a pending computed parks too', async () => {
		const gate = deferred<number>()
		const inner = computed((use) => use(gate.promise))
		const outer = computed(() => inner.get() + 1)
		expect(isPending(outer)).toBe(false)
		expect(() => read(outer)).toThrow()
		// Forwarded first load is still a first load: not pending (Solid rule).
		expect(isPending(outer)).toBe(false)
		gate.resolve(41)
		await tick()
		expect(read(outer)).toBe(42)
	})

	test('settlement behaves as a write: effects observing downstream re-run', async () => {
		const gate = deferred<number>()
		const c = computed((use) => use(gate.promise) * 2)
		const seen: unknown[] = []
		effect(() => {
			try {
				seen.push(c.get())
			} catch {
				seen.push('pending')
			}
		})
		expect(seen).toEqual(['pending'])
		gate.resolve(21)
		await tick()
		expect(seen).toEqual(['pending', 42])
	})
})

describe('errors are reference-stable boxes', () => {
	test('a rejected thenable rethrows the same reason at every read site', async () => {
		const gate = deferred<never>()
		const boom = new Error('boom')
		const c = computed((use) => use(gate.promise))
		try {
			read(c)
		} catch {
			/* pending */
		}
		gate.reject(boom)
		await tick()
		let e1: unknown
		let e2: unknown
		try {
			read(c)
		} catch (e) {
			e1 = e
		}
		try {
			read(c)
		} catch (e) {
			e2 = e
		}
		expect(e1).toBe(boom)
		expect(e2).toBe(boom)
	})

	test('a throwing computed forwards the same reason to downstream readers', () => {
		const boom = new Error('sync-boom')
		const c = computed(() => {
			throw boom
		})
		const d = computed(() => c.get())
		expect(() => read(d)).toThrow(boom)
		expect(() => read(d)).toThrow(boom)
	})
})
