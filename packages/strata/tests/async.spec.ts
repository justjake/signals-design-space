import { expect, test } from 'vitest'
import { Computed, isPending, latest, refresh } from '../src/index'

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((done, fail) => {
		resolve = done
		reject = fail
	})
	return { promise, resolve, reject }
}

test('pending is cached graph state and parallel reads all register', async () => {
	const a = deferred<number>()
	const b = deferred<number>()
	let runs = 0
	const sum = new Computed<number>((context) => {
		runs++
		const left = context.use(a.promise)
		const right = context.use(b.promise)
		return left + right
	})

	let first: unknown
	try {
		void sum.state
	} catch (error) {
		first = error
	}
	expect(first).toBeInstanceOf(Promise)
	expect(runs).toBe(1)
	expect(() => sum.state).toThrow(first)
	expect(runs).toBe(1)

	a.resolve(2)
	b.resolve(3)
	await Promise.all([a.promise, b.promise])
	await Promise.resolve()
	expect(sum.state).toBe(5)
})

test('refresh preserves latest, advances the epoch, and ignores superseded settlement', async () => {
	const requests: Array<ReturnType<typeof deferred<number>>> = []
	const data = new Computed<number>((context) => {
		let request = requests[context.refreshEpoch]
		if (request === undefined) {
			request = deferred<number>()
			requests[context.refreshEpoch] = request
		}
		return context.use(request.promise)
	})

	expect(latest(data)).toBeUndefined()
	expect(isPending(data)).toBe(false)
	requests[0].resolve(10)
	await requests[0].promise
	await Promise.resolve()
	expect(data.state).toBe(10)

	refresh(data)
	expect(latest(data)).toBe(10)
	expect(isPending(data)).toBe(true)
	refresh(data)
	expect(requests).toHaveLength(3)
	requests[1].resolve(100)
	await requests[1].promise
	await Promise.resolve()
	expect(latest(data)).toBe(10)
	expect(isPending(data)).toBe(true)

	requests[2].resolve(20)
	await requests[2].promise
	await Promise.resolve()
	expect(data.state).toBe(20)
	expect(isPending(data)).toBe(false)
})

test('a rejected async value becomes a stable read error', async () => {
	const request = deferred<number>()
	const data = new Computed((context) => context.use(request.promise))
	expect(latest(data)).toBeUndefined()
	const failure = new Error('nope')
	request.reject(failure)
	await request.promise.catch(() => undefined)
	await Promise.resolve()
	expect(() => data.state).toThrow(failure)
	expect(() => latest(data)).toThrow(failure)
})
