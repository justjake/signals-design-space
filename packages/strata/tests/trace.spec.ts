import { describe, expect, it } from 'vitest'
import { Runtime } from '../src/index.js'
import { trace } from '../src/trace.js'

describe('causality log', () => {
	it('links a write to the effect it provoked', () => {
		const runtime = new Runtime()
		const log = trace(runtime, 32)
		const value = runtime.atom(0, { label: 'value' })
		let runs = 0
		const dispose = runtime.effect(() => {
			value.state
			runs++
		})

		value.set(1)
		expect(runs).toBe(2)
		let latestEffect = 0
		const events = log.events()
		for (let i = 0; i < events.length; i++) {
			if (events[i]!.kind === 'effect-run') {
				latestEffect = events[i]!.id
			}
		}
		const chain = log.causeChain(latestEffect)
		expect(chain[0]?.kind).toBe('effect-run')
		expect(chain[1]?.kind).toBe('write')
		expect(chain[1]?.target).toBe('value')

		dispose()
		log.stop()
	})

	it('keeps a bounded tail and reports every overwritten event', () => {
		const runtime = new Runtime()
		const log = trace(runtime, 3)
		const value = runtime.atom(0)
		for (let i = 1; i <= 5; i++) {
			value.set(i)
		}
		expect(log.events()).toHaveLength(3)
		expect(log.overflow).toBe(2)
		expect(log.events()[2]?.id).toBe(5)
		log.stop()
	})
})
