import { describe, expect, test, vi } from 'vitest'
import { createCosignals } from '../src/index.js'

describe('createCosignals', () => {
	test('owns graph, values, effects, and policy state per instance', () => {
		const one = createCosignals()
		const two = createCosignals()
		const a = new one.Atom(1)
		const b = new two.Atom(10)
		const ca = new one.Computed(() => a.state * 2)
		const cb = new two.Computed(() => b.state * 3)
		const seenA: number[] = []
		const seenB: number[] = []
		const stopA = one.effect(() => {
			seenA.push(ca.state)
		})
		const stopB = two.effect(() => {
			seenB.push(cb.state)
		})

		a.set(2)
		expect(seenA).toEqual([2, 4])
		expect(seenB).toEqual([30])
		b.set(11)
		expect(seenA).toEqual([2, 4])
		expect(seenB).toEqual([30, 33])
		expect(one.Atom).not.toBe(two.Atom)
		expect(one.engine.idToInternals).not.toBe(two.engine.idToInternals)

		one.configure({ forbidWritesInComputeds: true })
		const oneTarget = new one.Atom(0)
		const twoTarget = new two.Atom(0)
		const oneWriter = new one.Computed(() => {
			oneTarget.set(1)
			return 1
		})
		const twoWriter = new two.Computed(() => {
			twoTarget.set(1)
			return 1
		})
		expect(() => oneWriter.state).toThrow(/writes inside computeds are forbidden/)
		expect(twoWriter.state).toBe(1)

		stopA()
		stopB()
	})

	test('serializes one request and initializes a separate hydration instance', () => {
		const server = createCosignals()
		const count = new server.Atom(1)
		const label = new server.Atom('server')
		count.set(7)
		const json = server.serializeAtomState({ count, label }, (key, value) =>
			key === 'count' ? (value as number) + 1 : value,
		)

		const client = createCosignals()
		const clientCount = new client.Atom(0)
		const clientLabel = new client.Atom('client')
		client.initializeAtomState(json, { count: clientCount, label: clientLabel }, (key, value) =>
			key === 'count' ? (value as number) - 1 : value,
		)

		expect(clientCount.state).toBe(7)
		expect(clientLabel.state).toBe('server')
		expect(count.state).toBe(7)
	})

	test('owns driver attachment and reset epochs per instance', () => {
		const one = createCosignals()
		const two = createCosignals()
		const driver = { currentBatch: () => one.BATCH_NONE, worldFor: () => undefined }
		one.attachDriver(driver)
		two.attachDriver(driver)
		expect(() => one.attachDriver(driver)).toThrow(/already attached/)
		one.__TEST__resetEngine()
		expect(one.engineEpoch).toBe(1)
		expect(two.engineEpoch).toBe(0)
		one.attachDriver(driver)
		expect(() => two.attachDriver(driver)).toThrow(/already attached/)
	})

	test('warns for serialized keys the client did not register', () => {
		const instance = createCosignals()
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		instance.initializeAtomState('{"missing":1}', {})
		expect(warn).toHaveBeenCalledWith('cosignals: initializeAtomState: unknown key "missing"')
		warn.mockRestore()
	})

	test('rejects serialization and initialization while request state is speculative', () => {
		const instance = createCosignals()
		const a = new instance.Atom(0)
		const batch = instance.engine.openBatch()
		expect(() => instance.serializeAtomState({ a })).toThrow(/no live batch or render/)
		expect(() => instance.initializeAtomState('{"a":1}', { a })).toThrow(/no live batch or render/)
		instance.engine.retire(batch.id)
		expect(instance.serializeAtomState({ a })).toBe('{"a":0}')
	})
})
