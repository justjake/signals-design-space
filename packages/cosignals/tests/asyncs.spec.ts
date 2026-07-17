/** Async semantics: pending/error as graph state, suspensions, refetching. */
import { describe, expect, test } from 'vitest'
import {
	createAtom,
	createComputed,
	createEffect,
	isPending,
	latest,
} from '../src/index.ts'
import { nodeOf } from '../src/unstable.ts'
import { ErrorBox, makeSuspension, trackThenable } from '../src/asyncs.ts'
import { currentCause, observeNode, setCurrentCause } from '../src/graph.ts'
import { BASE_WORLD, resolveState } from '../src/worlds.ts'

function deferred<T>() {
	let resolve!: (v: T) => void
	let reject!: (e: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

function controlledThenable<T>() {
	let fulfill!: (value: T) => unknown
	let reject!: (reason: unknown) => unknown
	const thenable = {
		then(
			onFulfilled: (value: T) => unknown,
			onRejected: (reason: unknown) => unknown,
		): undefined {
			fulfill = onFulfilled
			reject = onRejected
			return undefined
		},
	} as unknown as PromiseLike<T>
	return {
		thenable,
		fulfill: (value: T) => fulfill(value),
		reject: (reason: unknown) => reject(reason),
	}
}

const tick = () => new Promise<void>((r) => setTimeout(r))

test('detached async records contain only execution state', () => {
	const suspension = makeSuspension()
	const box = trackThenable(new Promise<never>(() => {}))
	expect(Object.keys(suspension)).toEqual(['promise', 'resolve'])
	expect(Object.keys(box)).toEqual([
		'status',
		'result',
		'parkedNodes',
		'parkedSuspensions',
	])
})

describe('pending as graph state', () => {
	test('the resolver owns pendingness and remains one-shot when captured', async () => {
		const suspension = makeSuspension()
		const resolve = suspension.resolve!
		let retries = 0
		suspension.promise.then(() => retries++)

		expect(suspension.resolve).toBe(resolve)
		resolve()
		resolve()
		suspension.resolve?.()
		expect(suspension.resolve).toBeNull()

		await suspension.promise
		expect(retries).toBe(1)
	})

	test('never-settled read throws a stable thenable; settlement converges', async () => {
		const gate = deferred<string>()
		const c = createComputed((use) => use(gate.promise))
		let thrown1: unknown
		let thrown2: unknown
		try {
			c.get()
		} catch (e) {
			thrown1 = e
		}
		try {
			c.get()
		} catch (e) {
			thrown2 = e
		}
		expect(typeof (thrown1 as PromiseLike<void>).then).toBe('function')
		expect(thrown1).toBe(thrown2) // stable suspension thenable across retries
		// A first load is not pending — there is no stale data to indicate
		// over; suspending is Suspense's job.
		expect(isPending(c)).toBe(false)
		gate.resolve('done')
		await tick()
		expect(c.get()).toBe('done')
		expect(isPending(c)).toBe(false)
	})

	test('sequential thenables share one continuous pending span', async () => {
		const first = deferred<number>()
		const second = deferred<number>()
		const c = createComputed((use) => use(first.promise) + use(second.promise))
		let firstSuspension: unknown
		let secondSuspension: unknown
		try {
			c.get()
		} catch (error) {
			firstSuspension = error
		}

		first.resolve(1)
		await tick()
		try {
			c.get()
		} catch (error) {
			secondSuspension = error
		}
		expect(secondSuspension).toBe(firstSuspension)

		second.resolve(2)
		await tick()
		expect(c.get()).toBe(3)
	})

	test('stale value keeps serving while a refetch is pending; latest never suspends', async () => {
		const gates = [deferred<number>(), deferred<number>()]
		// A user-owned nonce atom is the refetch trigger: the computed reads it,
		// so a bump invalidates with the data inputs unchanged and starts a new
		// fetch through the ordinary write path.
		const nonce = createAtom(0)
		const c = createComputed((use) => use(gates[nonce.get()].promise))
		gates[0].resolve(1)
		try {
			c.get() // first touch attaches to the (already resolved) thenable
		} catch {
			/* parks until the settlement microtask */
		}
		await tick()
		expect(c.get()).toBe(1)
		nonce.set(1)
		expect(c.get()).toBe(1) // stale serves
		expect(latest(c)).toBe(1)
		expect(isPending(c)).toBe(true)
		gates[1].resolve(2)
		await tick()
		expect(c.get()).toBe(2)
		expect(isPending(c)).toBe(false)
	})

	test('pending forwards: a computed reading a pending computed parks too', async () => {
		const gate = deferred<number>()
		const inner = createComputed((use) => use(gate.promise))
		const outer = createComputed(() => inner.get() + 1)
		expect(isPending(outer)).toBe(false)
		expect(() => outer.get()).toThrow()
		// A forwarded first load is still a first load: not pending.
		expect(isPending(outer)).toBe(false)
		gate.resolve(41)
		await tick()
		expect(outer.get()).toBe(42)
	})

	test('settlement behaves as a write: effects observing downstream re-run', async () => {
		const gate = deferred<number>()
		const c = createComputed((use) => use(gate.promise) * 2)
		const seen: unknown[] = []
		createEffect(
			() => c.get(),
			(v) => {
				seen.push(v)
			},
		)
		// A parked first evaluation is silent; the handler first fires at
		// settlement, which behaves as a write.
		expect(seen).toEqual([])
		gate.resolve(21)
		await tick()
		expect(seen).toEqual([42])
	})

	test('disposing a parked effect unlinks its dynamic sources and settlement stays silent', () => {
		const source = createAtom(1)
		const gate = controlledThenable<number>()
		const seen: number[] = []
		const stop = createEffect(
			(use) => source.get() + use(gate.thenable),
			(value) => {
				seen.push(value)
			},
		)
		expect(nodeOf(source).observerCount).toBe(1)
		expect(seen).toEqual([])

		stop()
		expect(nodeOf(source).observerCount).toBe(0)
		gate.fulfill(2)
		expect(seen).toEqual([])
	})

	test('throwing settlement notification restores cause and releases suspension', () => {
		const gate = controlledThenable<number>()
		const box = trackThenable(gate.thenable)
		let ownerAbsentDuringCompute = false
		const c = createComputed((use) => {
			const value = use(gate.thenable)
			ownerAbsentDuringCompute = box.parkedNodes === null
			return value
		})
		const boom = new Error('notification')
		let ownerAbsentDuringNotification = false
		const stop = observeNode(nodeOf(c), () => {
			ownerAbsentDuringNotification = box.parkedNodes === null
			throw boom
		})

		expect(() => c.get()).toThrow()
		expect(box.parkedNodes!.size).toBe(1)
		expect(box.parkedSuspensions!.size).toBe(1)
		const suspension = box.parkedSuspensions!.values().next().value!
		const previousCause = setCurrentCause(123)
		try {
			let thrown: unknown
			try {
				gate.fulfill(1)
			} catch (error) {
				thrown = error
			}
			expect(thrown).toBe(boom)
			expect(currentCause).toBe(123)
			expect(suspension.resolve).toBeNull()
			expect(ownerAbsentDuringCompute).toBe(true)
			expect(ownerAbsentDuringNotification).toBe(true)
			expect(box.parkedNodes).toBeNull()
			expect(box.parkedSuspensions).toBeNull()
		} finally {
			setCurrentCause(previousCause)
			stop()
		}
	})

	test('the first terminal callback wins and later scheduling still flushes', () => {
		const fulfilled = controlledThenable<number>()
		const value = createComputed((use) => use(fulfilled.thenable))
		expect(() => value.get()).toThrow()
		fulfilled.fulfill(1)
		expect(value.get()).toBe(1)
		expect(() => fulfilled.reject(new Error('late rejection'))).not.toThrow()
		expect(() => fulfilled.fulfill(2)).not.toThrow()
		expect(value.get()).toBe(1)

		const rejected = controlledThenable<number>()
		const failure = createComputed((use) => use(rejected.thenable))
		const firstError = new Error('first rejection')
		expect(() => failure.get()).toThrow()
		rejected.reject(firstError)
		expect(() => failure.get()).toThrow(firstError)
		expect(() => rejected.fulfill(2)).not.toThrow()
		expect(() => rejected.reject(new Error('late rejection'))).not.toThrow()
		expect(() => failure.get()).toThrow(firstError)

		const source = createAtom(0)
		const seen: number[] = []
		const stop = createEffect(
			() => source.get(),
			(v) => {
				seen.push(v)
			},
		)
		source.set(1)
		expect(seen).toEqual([0, 1])
		stop()
	})

	test('status distinguishes undefined fulfillment from undefined rejection', async () => {
		const fulfilled = deferred<undefined>()
		const rejected = deferred<never>()
		const value = createComputed((use) => use(fulfilled.promise))
		const failure = createComputed((use) => use(rejected.promise))
		expect(() => value.get()).toThrow()
		expect(() => failure.get()).toThrow()

		fulfilled.resolve(undefined)
		rejected.reject(undefined)
		await tick()
		expect(value.get()).toBeUndefined()
		let didThrow = false
		try {
			failure.get()
		} catch (reason) {
			didThrow = true
			expect(reason).toBeUndefined()
		}
		expect(didThrow).toBe(true)
	})
})

describe('errors are reference-stable boxes', () => {
	test('only engine error boxes are recognized in resolved values', () => {
		const source = createAtom(0)
		const boom = new Error('boxed')
		const failure = createComputed(() => {
			source.get()
			throw boom
		})
		try {
			failure.get()
		} catch {}
		const first = resolveState(nodeOf(failure), BASE_WORLD).throwable
		expect(first instanceof ErrorBox).toBe(true)

		source.set(1)
		try {
			failure.get()
		} catch {}
		expect(resolveState(nodeOf(failure), BASE_WORLD).throwable).toBe(first)

		const value = createComputed(() => ({ error: boom }))
		const spoof = resolveState(nodeOf(value), BASE_WORLD).value
		expect(spoof).toEqual({ error: boom })
		expect(spoof instanceof ErrorBox).toBe(false)
	})

	test('a rejected thenable rethrows the same reason at every read site', async () => {
		const gate = deferred<never>()
		const boom = new Error('boom')
		const c = createComputed((use) => use(gate.promise))
		try {
			c.get()
		} catch {
			/* pending */
		}
		gate.reject(boom)
		await tick()
		let e1: unknown
		let e2: unknown
		try {
			c.get()
		} catch (e) {
			e1 = e
		}
		try {
			c.get()
		} catch (e) {
			e2 = e
		}
		expect(e1).toBe(boom)
		expect(e2).toBe(boom)
	})

	test('a throwing computed forwards the same reason to downstream readers', () => {
		const boom = new Error('sync-boom')
		const c = createComputed(() => {
			throw boom
		})
		const d = createComputed(() => c.get())
		expect(() => d.get()).toThrow(boom)
		expect(() => d.get()).toThrow(boom)
	})
})
