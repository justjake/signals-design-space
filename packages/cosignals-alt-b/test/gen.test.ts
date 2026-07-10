// §15.5 — codegen CI: regenerate-and-diff (drift is a test failure, not a
// review burden) plus the schema self-checks at generate time.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
	MARKER_END,
	generateDebugTwin,
	generateEnumBlock,
	spliceEnumBlock,
} from '../tools/gen-layout'
import { defineSchema, schema } from '../tools/schema'

const here = dirname(fileURLToPath(import.meta.url))

describe('regenerate-and-diff (§15.5)', () => {
	it('the const enum C region in src/engine.ts matches the schema — run `pnpm gen`', () => {
		const engine = readFileSync(join(here, '..', 'src', 'engine.ts'), 'utf8')
		// Splicing the freshly-generated block into the current source must be
		// a no-op (string equality: deterministic emit).
		expect(spliceEnumBlock(engine, schema)).toBe(engine)
		// And the region is present exactly once.
		const block = generateEnumBlock(schema)
		expect(engine.includes(block)).toBe(true)
		expect(engine.indexOf(MARKER_END)).toBe(engine.lastIndexOf(MARKER_END))
	})

	it('the debug twin matches the schema — run `pnpm gen`', () => {
		const twin = readFileSync(join(here, '..', 'src', 'debug', 'layout.debug.ts'), 'utf8')
		expect(twin).toBe(generateDebugTwin(schema))
	})
})

describe('schema self-checks (§15.5)', () => {
	it('rejects overlapping flag bits', () => {
		expect(() =>
			defineSchema({
				...schema,
				flags: [
					{ name: 'A', bit: 1, doc: 'a' },
					{ name: 'B', bit: 1, doc: 'b' },
				],
				kindBits: [],
			}),
		).toThrow(/overlapping/)
	})

	it('rejects multi-bit flags', () => {
		expect(() =>
			defineSchema({
				...schema,
				flags: [{ name: 'A', bit: 3, doc: 'a' }],
				kindBits: [],
			}),
		).toThrow(/single bit/)
	})

	it('rejects duplicate non-alias slots and out-of-stride fields', () => {
		expect(() =>
			defineSchema({
				...schema,
				planes: [
					{
						name: 'X',
						stride: 4,
						burnedRecordZero: true,
						families: [
							{
								name: 'x',
								fields: [
									{ name: 'A', slot: 0, kind: 'u31', doc: 'a' },
									{ name: 'B', slot: 0, kind: 'u31', doc: 'b' },
								],
							},
						],
					},
				],
			}),
		).toThrow(/duplicate slot/)
		expect(() =>
			defineSchema({
				...schema,
				planes: [
					{
						name: 'X',
						stride: 4,
						burnedRecordZero: true,
						families: [{ name: 'x', fields: [{ name: 'A', slot: 9, kind: 'u31', doc: 'a' }] }],
					},
				],
			}),
		).toThrow(/out of stride/)
	})

	it('KIND_MASK is the union of the kind bits and matches the twin', async () => {
		const twin = await import('../src/debug/layout.debug')
		const kindMask = schema.kindBits.reduce((m, k) => m | twin.FLAG_BITS[k], 0)
		expect(kindMask).toBe(1024 | 2048 | 4096 | 8192 | 16384)
		expect(twin.LAYOUT_VERSION).toBe(schema.layoutVersion)
		expect(twin.STRIDES).toEqual({ M: 8, G: 4, W: 8 })
	})

	it('hydrators decode records through the twin without kernel imports', async () => {
		const twin = await import('../src/debug/layout.debug')
		const M = new Int32Array(16)
		M[8 + 0] = 1024 | 1 | 16 // K_ATOM | MUTABLE | DIRTY
		M[8 + 5] = 7
		const node = twin.hydrateNode(M, 8)
		expect(node.FLAGS).toBe(1024 | 1 | 16)
		expect(node.GEN).toBe(7)
		expect(node.flagNames).toEqual(expect.arrayContaining(['K_ATOM', 'MUTABLE', 'DIRTY']))
	})
})
