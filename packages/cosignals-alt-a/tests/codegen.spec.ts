/**
 * §15.5 — drift is a build failure, not a review burden: regenerate the
 * layout artifacts in memory and string-compare against the checked-in
 * files/regions. Failure message: run `pnpm gen`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { schema, defineSchema } from '../tools/schema'
import {
	END_MARKER,
	START_MARKER,
	generateDebugTwin,
	generateDocs,
	generateEnumRegion,
	spliceEnumRegion,
} from '../tools/gen-layout'

const root = join(__dirname, '..')

describe('§15 codegen: regenerate-and-diff', () => {
	it('the engine enum region matches the schema (run pnpm gen)', () => {
		const source = readFileSync(join(root, 'src', 'engine.ts'), 'utf8')
		const start = source.indexOf(START_MARKER)
		const endIdx = source.indexOf(END_MARKER)
		expect(start).toBeGreaterThanOrEqual(0)
		expect(endIdx).toBeGreaterThan(start)
		const endLine = source.indexOf('\n', endIdx)
		const checkedIn = source.slice(start, endLine)
		expect(checkedIn).toBe(generateEnumRegion(schema))
		// The generator only ever rewrites text between its own markers.
		expect(spliceEnumRegion(source, schema)).toBe(source)
		// Exactly one region.
		expect(source.indexOf(START_MARKER, start + 1)).toBe(-1)
	})

	it('the debug twin matches the schema (run pnpm gen)', () => {
		const checkedIn = readFileSync(join(root, 'src', 'debug', 'layout.debug.ts'), 'utf8')
		expect(checkedIn).toBe(generateDebugTwin(schema))
	})

	it('the docs table matches the schema (run pnpm gen)', () => {
		const checkedIn = readFileSync(join(root, 'docs', 'layout.md'), 'utf8')
		expect(checkedIn).toBe(generateDocs(schema))
	})
})

describe('§15 codegen: schema self-checks', () => {
	it('rejects overlapping flag bits', () => {
		expect(() =>
			defineSchema({
				...schema,
				flags: [
					{ name: 'A', value: 1, doc: 'a' },
					{ name: 'B', value: 1, doc: 'b' },
				],
			}),
		).toThrow(/overlaps/)
	})

	it('rejects out-of-stride slots and duplicate slots', () => {
		expect(() =>
			defineSchema({
				...schema,
				records: [
					{
						name: 'bad',
						plane: 'G',
						fields: [{ name: 'X', slot: 4, kind: 'u31', doc: 'x', owner: 'x' }],
					},
				],
			}),
		).toThrow(/outside stride/)
	})

	it('rejects masks referencing unknown flags', () => {
		expect(() =>
			defineSchema({
				...schema,
				derivedMasks: [{ name: 'BAD', of: ['NOPE'], doc: 'bad' }],
			}),
		).toThrow(/unknown flag/)
	})

	it('the debug twin decodes flag words', async () => {
		const twin = await import('../src/debug/layout.debug')
		expect(twin.decodeFlags(1 | 1024)).toEqual(['MUTABLE', 'K_ATOM'])
		expect(twin.FIELDS_BY_RECORD.node.find((f) => f.name === 'LOG_HEAD')?.slot).toBe(6)
		expect(twin.LAYOUT_VERSION).toBe(schema.layoutVersion)
	})
})
