/**
 * §15.2 — the layout generator. No dependencies; run via `pnpm gen`
 * (node --experimental-strip-types tools/gen-layout.ts).
 *
 * Emits (deterministically — sorted where order is not schema order, no
 * timestamps) and rewrites in place:
 *
 * 1. the `const enum C` region in src/engine.ts, bracketed by GENERATED
 *    markers — the only generated text inside a handwritten file; the
 *    generator only ever rewrites text between its own markers and fails
 *    hard when they are missing or duplicated;
 * 2. the debug twin src/debug/layout.debug.ts (whole file generated; imports
 *    nothing from the kernel): field tables as runtime data, flag decoding,
 *    and record hydrators.
 *
 * The regen-diff test (test/gen.test.ts) regenerates in memory and
 * string-compares — drift is a test failure, not a review burden.
 */

import { schema } from './schema.ts'
import type { Schema } from './schema.ts'

export const MARKER_START =
	'// #region GENERATED — layout v{V} (from tools/schema.ts; run `pnpm gen`) — DO NOT EDIT'
export const MARKER_END = '// #endregion GENERATED layout'

function markerStart(s: Schema): string {
	return MARKER_START.replace('{V}', String(s.layoutVersion))
}

export function generateEnumBlock(s: Schema): string {
	const lines: string[] = []
	lines.push(markerStart(s))
	lines.push('const enum C {')
	for (const plane of s.planes) {
		for (const fam of plane.families) {
			lines.push(
				`\t// ${fam.name} record (plane ${plane.name}, stride ${plane.stride}; ids pre-multiplied: id = record * ${plane.stride}).`,
			)
			for (const f of fam.fields) {
				// Aliases of a slot already emitted for another family (node
				// fields shadow link fields by name, never by value).
				lines.push(`\t${f.name} = ${f.slot}, // ${f.doc}`)
			}
			lines.push('')
		}
	}
	lines.push('\t// node FLAGS word (spec §7.2).')
	for (const f of s.flags) {
		lines.push(`\t${f.name} = ${f.bit}, // ${f.doc}`)
	}
	const kindMask = s.flags.filter((f) => s.kindBits.includes(f.name)).reduce((m, f) => m | f.bit, 0)
	lines.push(`\tKIND_MASK = ${kindMask}, // ${s.kindBits.join(' | ')}`)
	lines.push('')
	lines.push('\t// log L_META packing (spec §7.3).')
	for (const c of s.packedConsts) {
		lines.push(`\t${c.name} = ${c.value}, // ${c.doc}`)
	}
	lines.push('')
	for (const c of s.namedConsts) {
		lines.push(`\t${c.name} = ${c.value}, // ${c.doc}`)
	}
	lines.push('}')
	lines.push(MARKER_END)
	return lines.join('\n')
}

export function generateDebugTwin(s: Schema): string {
	const lines: string[] = []
	lines.push('// GENERATED FILE — from tools/schema.ts; run `pnpm gen`. DO NOT EDIT.')
	lines.push('// The debug twin (§15.2): field tables as runtime data, flag decoding,')
	lines.push('// and record hydrators. Imports nothing from the kernel; none of it')
	lines.push('// ships on a hot path.')
	lines.push('')
	lines.push(`export const LAYOUT_VERSION = ${s.layoutVersion};`)
	lines.push('')
	lines.push('export type FieldInfo = {')
	lines.push('\tname: string;')
	lines.push('\tslot: number;')
	lines.push('\tkind: string;')
	lines.push('\tdoc: string;')
	lines.push('};')
	lines.push('')
	lines.push('export const FIELDS_BY_RECORD: Record<string, readonly FieldInfo[]> = {')
	for (const plane of s.planes) {
		for (const fam of plane.families) {
			lines.push(`\t${fam.name}: [`)
			for (const f of fam.fields) {
				lines.push(
					`\t\t{ name: ${JSON.stringify(f.name)}, slot: ${f.slot}, kind: ${JSON.stringify(f.kind)}, doc: ${JSON.stringify(f.doc)} },`,
				)
			}
			lines.push('\t],')
		}
	}
	lines.push('};')
	lines.push('')
	lines.push('export const STRIDES: Record<string, number> = {')
	for (const plane of s.planes) {
		lines.push(`\t${plane.name}: ${plane.stride},`)
	}
	lines.push('};')
	lines.push('')
	lines.push('export const FLAG_BITS: Record<string, number> = {')
	for (const f of s.flags) {
		lines.push(`\t${f.name}: ${f.bit},`)
	}
	lines.push('};')
	lines.push('')
	lines.push('/** Decode a FLAGS word into the set flag names. */')
	lines.push('export function decodeFlags(flags: number): string[] {')
	lines.push('\tconst out: string[] = [];')
	lines.push('\tfor (const [name, bit] of Object.entries(FLAG_BITS)) {')
	lines.push('\t\tif ((flags & bit) !== 0) {')
	lines.push('\t\t\tout.push(name);')
	lines.push('\t\t}')
	lines.push('\t}')
	lines.push('\treturn out;')
	lines.push('}')
	lines.push('')
	for (const plane of s.planes) {
		for (const fam of plane.families) {
			const fname = `hydrate${fam.name[0].toUpperCase()}${fam.name.slice(1)}`
			lines.push(`/** Decode one ${fam.name} record (plane ${plane.name}) into a plain object. */`)
			lines.push(
				`export function ${fname}(plane: Int32Array, id: number): Record<string, unknown> {`,
			)
			lines.push('\tconst out: Record<string, unknown> = { id };')
			lines.push(`\tfor (const f of FIELDS_BY_RECORD.${fam.name}) {`)
			lines.push('\t\tout[f.name] = plane[id + f.slot];')
			lines.push('\t}')
			if (fam.fields.some((f) => f.kind === 'flags')) {
				lines.push('\tout.flagNames = decodeFlags(plane[id + 0]);')
			}
			lines.push('\treturn out;')
			lines.push('}')
			lines.push('')
		}
	}
	lines.push('export const BYTECODE_BUDGETS: Record<string, number> = {')
	for (const [name, budget] of Object.entries(s.budgets)) {
		lines.push(`\t${name}: ${budget},`)
	}
	lines.push('};')
	lines.push('')
	return lines.join('\n')
}

/** Rewrite the generated region of a file; fails hard on missing or
 * duplicated markers. Returns the new content. */
export function spliceEnumBlock(engineSource: string, s: Schema): string {
	const start = markerStart(s)
	const first = engineSource.indexOf(start)
	if (first === -1) {
		throw new Error('gen-layout: start marker not found in src/engine.ts')
	}
	if (engineSource.indexOf(start, first + 1) !== -1) {
		throw new Error('gen-layout: duplicated start marker')
	}
	const endIdx = engineSource.indexOf(MARKER_END, first)
	if (endIdx === -1) {
		throw new Error('gen-layout: end marker not found')
	}
	return (
		engineSource.slice(0, first) +
		generateEnumBlock(s) +
		engineSource.slice(endIdx + MARKER_END.length)
	)
}

// ---- CLI entry ------------------------------------------------------------------

async function main(): Promise<void> {
	const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs')
	const { dirname, join } = await import('node:path')
	const { fileURLToPath } = await import('node:url')
	const here = dirname(fileURLToPath(import.meta.url))
	const enginePath = join(here, '..', 'src', 'engine.ts')
	const twinPath = join(here, '..', 'src', 'debug', 'layout.debug.ts')
	const engine = readFileSync(enginePath, 'utf8')
	writeFileSync(enginePath, spliceEnumBlock(engine, schema))
	mkdirSync(dirname(twinPath), { recursive: true })
	writeFileSync(twinPath, generateDebugTwin(schema))
	// eslint-disable-next-line no-console
	;(globalThis as { console?: { log(m: string): void } }).console?.log(
		'gen-layout: wrote src/engine.ts region + src/debug/layout.debug.ts',
	)
}

const isMain = (() => {
	const argv1 = (globalThis as { process?: { argv?: string[] } }).process?.argv?.[1]
	return argv1 !== undefined && import.meta.url.endsWith(argv1.split('/').pop() ?? '!')
})()

if (isMain) {
	void main()
}
