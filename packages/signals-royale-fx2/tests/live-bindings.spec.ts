import { expect, test } from 'vitest'
import * as graph from '../src/graph.ts'
import * as publicApi from '../src/index.ts'
import * as worlds from '../src/worlds.ts'

test('internal live bindings do not widen the public entry point', () => {
	expect('activeConsumer' in publicApi).toBe(false)
	expect('currentWorld' in publicApi).toBe(false)
	expect('currentPark' in publicApi).toBe(false)
	expect(publicApi.getActiveTracer).toBeTypeOf('function')
})

test('[falsify-first] canonical ambient owners expose live internal bindings', () => {
	const graphState = graph as typeof graph & {
		readonly activeConsumer: unknown
		readonly currentWorld: unknown
	}
	const worldState = worlds as typeof worlds & {
		readonly currentPark: unknown
	}

	expect(graphState.activeConsumer).toBeNull()
	expect(graphState.currentWorld).toBeNull()
	expect(worldState.currentPark).toBeNull()

	const source = publicApi.createAtom(1)
	let seenConsumer: unknown
	const computed = publicApi.createComputed(() => {
		seenConsumer = graphState.activeConsumer
		return source.get()
	})
	expect(computed.get()).toBe(1)
	expect(seenConsumer).toBe(publicApi.nodeOf(computed))
	expect(graphState.activeConsumer).toBeNull()

	graph.withWorld(worlds.BASE_WORLD, () => {
		expect(graphState.currentWorld).toBe(worlds.BASE_WORLD)
		graph.withWorld(null, () => {
			expect(graphState.currentWorld).toBeNull()
		})
		expect(graphState.currentWorld).toBe(worlds.BASE_WORLD)
	})
	expect(graphState.currentWorld).toBeNull()

	const draft = worlds.openDraft()
	try {
		worlds.runWithDraftWrites(draft, () => source.set(2))
		const world = worlds.worldOf([draft.id])
		let seenWorld: unknown
		let seenPark: unknown
		const worldComputed = publicApi.createComputed(() => {
			seenWorld = graphState.currentWorld
			seenPark = worldState.currentPark
			return source.get()
		})
		expect(worlds.resolveState(publicApi.nodeOf(worldComputed), world)).toEqual({
			flags: 0,
			value: 2,
		})
		expect(seenWorld).toBe(world)
		expect(seenPark).toBeTypeOf('function')
		expect(graphState.currentWorld).toBeNull()
		expect(worldState.currentPark).toBeNull()
	} finally {
		worlds.discardDraft(draft.id)
	}
})
