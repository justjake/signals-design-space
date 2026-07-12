import { expect, test } from 'vitest'
import { Runtime } from '../src/index.js'

async function collect<T extends object>(reference: WeakRef<T>): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve))
	for (let i = 0; i < 30; i++) {
		global.gc!()
		await new Promise<void>((resolve) => setImmediate(resolve))
	}
	void reference
}

test('a dropped computed is not retained by its producers', async () => {
	const runtime = new Runtime()
	const source = runtime.atom(1)
	let reference!: WeakRef<object>
	;(() => {
		const derived = runtime.computed(() => source.state + 1)
		expect(derived.state).toBe(2)
		reference = new WeakRef(derived)
	})()

	await collect(reference)
	expect(reference.deref()).toBeUndefined()
})

test('quiescence compacts operation journals', () => {
	const runtime = new Runtime()
	let lane = 2
	runtime.attachHost({
		write(fn) {
			return fn(lane, lane !== 1)
		},
		run(_lane, fn) {
			return fn()
		},
	})
	const value = runtime.atom(0)
	value.set(1)
	const deferred = runtime.activeBranches().next().value!
	lane = 1
	value.set(2)
	let urgent!: typeof deferred
	for (const branch of runtime.activeBranches()) {
		if (branch !== deferred) {
			urgent = branch
		}
	}
	runtime.finishBranch(urgent, true)
	runtime.finishBranch(deferred, false)
	expect(runtime.activeBranches().next().done).toBe(true)
	expect(value._tape).toBeUndefined()
})
