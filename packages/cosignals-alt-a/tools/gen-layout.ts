/**
 * §15.2 — the layout generator. Emits, deterministically (sorted iteration,
 * no timestamps):
 *
 *   1. the `const enum C` region spliced between GENERATED markers in
 *      src/engine.ts (the only generated text inside a handwritten file);
 *   2. the debug twin `src/debug/layout.debug.ts` (whole file generated,
 *      imports nothing from the kernel: field tables as runtime data plus
 *      record hydrators);
 *   3. the docs table `docs/layout.md`.
 *
 * The regen-diff test (§15.5) regenerates in memory and string-compares
 * against the checked-in artifacts; drift is a test failure, not a review
 * burden. Run `pnpm gen` (node --experimental-strip-types, no const enums
 * in this file) to rewrite the artifacts.
 */
import { schema, type Schema } from './schema.ts';

export const START_MARKER = '// #region GENERATED — layout v';
export const END_MARKER = '// #endregion GENERATED layout';

export function generateEnumRegion(s: Schema): string {
	const lines: string[] = [];
	lines.push(`${START_MARKER}${s.layoutVersion} (from tools/schema.ts; run pnpm gen) — DO NOT EDIT`);
	lines.push('const enum C {');
	for (const rec of s.records) {
		const plane = s.planes[rec.plane];
		lines.push(`\t// ---- ${rec.name} record (plane ${rec.plane}, stride ${plane.stride}): ${plane.doc} ----`);
		for (const f of rec.fields) {
			lines.push(`\t/** ${f.doc} [${f.kind}; owner: ${f.owner}] */`);
			lines.push(`\t${f.name} = ${f.slot},`);
		}
		// Aliases keep the two names-per-slot fields readable.
		if (rec.name === 'node') {
			lines.push('\t/** non-atoms: the walk ticket of the last notify walk that visited me (alias of LOG_HEAD) */');
			lines.push('\tOVERLAY_STAMP = 6,');
			lines.push("\t/** computeds: the first memo record's world key (alias of LOG_TAIL) */");
			lines.push('\tMEMO_KEY = 7,');
		}
	}
	lines.push('\t// ---- flags (one 4-byte load carries state + kind) ----');
	for (const b of s.flags) {
		lines.push(`\t/** ${b.doc} */`);
		lines.push(`\t${b.name} = ${b.value},`);
	}
	for (const m of s.derivedMasks) {
		lines.push(`\t/** ${m.doc} */`);
		lines.push(`\t${m.name} = ${m.of.join(' | ')},`);
	}
	for (const g of s.groups) {
		lines.push(`\t// ---- ${g.name}: ${g.doc} ----`);
		for (const mem of g.members) {
			lines.push(`\t/** ${mem.doc} */`);
			lines.push(`\t${mem.name} = ${mem.value},`);
		}
	}
	lines.push('\t// ---- named constants ----');
	for (const c of s.constants) {
		lines.push(`\t/** ${c.doc} */`);
		lines.push(`\t${c.name} = ${c.value === 0x7fffffff ? '0x7fffffff' : c.value},`);
	}
	lines.push('}');
	lines.push(`${END_MARKER} v${s.layoutVersion}`);
	return lines.join('\n');
}

export function generateDebugTwin(s: Schema): string {
	const lines: string[] = [];
	lines.push('/**');
	lines.push(' * GENERATED debug twin (from tools/schema.ts; run pnpm gen) — DO NOT EDIT.');
	lines.push(' * Imports nothing from the kernel; field tables are runtime data and the');
	lines.push(' * hydrators decode record ids into plain objects (§15.2). None of this');
	lines.push(' * ships in the hot build.');
	lines.push(' */');
	lines.push('');
	lines.push(`export const LAYOUT_VERSION = ${s.layoutVersion};`);
	lines.push('');
	lines.push('export type FieldInfo = { name: string; slot: number; kind: string; doc: string };');
	lines.push('');
	lines.push('export const FIELDS_BY_RECORD: Record<string, FieldInfo[]> = {');
	for (const rec of s.records) {
		lines.push(`\t${rec.name}: [`);
		for (const f of rec.fields) {
			lines.push(`\t\t{ name: ${JSON.stringify(f.name)}, slot: ${f.slot}, kind: ${JSON.stringify(f.kind)}, doc: ${JSON.stringify(f.doc)} },`);
		}
		lines.push('\t],');
	}
	lines.push('};');
	lines.push('');
	lines.push('export const FLAG_BITS: Record<string, number> = {');
	for (const b of s.flags) {
		lines.push(`\t${b.name}: ${b.value},`);
	}
	lines.push('};');
	lines.push('');
	lines.push('export const STRIDES = { M: 8, G: 4, W: 8 } as const;');
	lines.push('');
	lines.push('export function decodeFlags(word: number): string[] {');
	lines.push('\tconst out: string[] = [];');
	lines.push('\tfor (const [name, bit] of Object.entries(FLAG_BITS)) {');
	lines.push('\t\tif ((word & bit) !== 0) {');
	lines.push('\t\t\tout.push(name);');
	lines.push('\t\t}');
	lines.push('\t}');
	lines.push('\treturn out;');
	lines.push('}');
	lines.push('');
	lines.push('function hydrate(plane: Int32Array, id: number, family: string): Record<string, number | string[]> {');
	lines.push('\tconst out: Record<string, number | string[]> = { id };');
	lines.push('\tfor (const f of FIELDS_BY_RECORD[family]) {');
	lines.push("\t\tout[f.name] = f.kind === 'flags' ? decodeFlags(plane[id + f.slot]) : plane[id + f.slot];");
	lines.push('\t}');
	lines.push('\treturn out;');
	lines.push('}');
	lines.push('');
	lines.push('export function nodeRecord(M: Int32Array, id: number): Record<string, number | string[]> {');
	lines.push("\treturn hydrate(M, id, 'node');");
	lines.push('}');
	lines.push('');
	lines.push('export function linkRecord(M: Int32Array, id: number): Record<string, number | string[]> {');
	lines.push("\treturn hydrate(M, id, 'link');");
	lines.push('}');
	lines.push('');
	lines.push('export function logRecord(G: Int32Array, gid: number): Record<string, number | string[]> {');
	lines.push("\treturn hydrate(G, gid, 'log');");
	lines.push('}');
	lines.push('');
	lines.push('export function memoRecord(W: Int32Array, wid: number): Record<string, number | string[]> {');
	lines.push("\treturn hydrate(W, wid, 'memo');");
	lines.push('}');
	lines.push('');
	return lines.join('\n');
}

export function generateDocs(s: Schema): string {
	const lines: string[] = [];
	lines.push(`# Layout v${s.layoutVersion} (generated from tools/schema.ts — run pnpm gen)`);
	lines.push('');
	for (const rec of s.records) {
		const plane = s.planes[rec.plane];
		lines.push(`## ${rec.name} record (plane ${rec.plane}, stride ${plane.stride})`);
		lines.push('');
		lines.push(plane.doc);
		lines.push('');
		lines.push('| offset | name | kind | meaning | owner |');
		lines.push('| --- | --- | --- | --- | --- |');
		for (const f of rec.fields) {
			lines.push(`| +${f.slot} | \`${f.name}\` | ${f.kind} | ${f.doc} | ${f.owner} |`);
		}
		lines.push('');
	}
	lines.push('## Flags word');
	lines.push('');
	lines.push('| bit | name | meaning |');
	lines.push('| --- | --- | --- |');
	for (const b of s.flags) {
		lines.push(`| ${b.value} | \`${b.name}\` | ${b.doc} |`);
	}
	for (const m of s.derivedMasks) {
		lines.push(`| — | \`${m.name}\` | ${m.doc} (${m.of.join(' \\| ')}) |`);
	}
	lines.push('');
	for (const g of s.groups) {
		lines.push(`## ${g.name}`);
		lines.push('');
		lines.push(g.doc);
		lines.push('');
		lines.push('| value | name | meaning |');
		lines.push('| --- | --- | --- |');
		for (const mem of g.members) {
			lines.push(`| ${mem.value} | \`${mem.name}\` | ${mem.doc} |`);
		}
		lines.push('');
	}
	lines.push('## Side columns');
	lines.push('');
	lines.push('| column | index | holds |');
	lines.push('| --- | --- | --- |');
	for (const c of s.sideColumns) {
		lines.push(`| \`${c.name}\` | \`${c.index}\` | ${c.doc} |`);
	}
	lines.push('');
	return lines.join('\n');
}

/** Splice the generated enum region into the kernel source text. */
export function spliceEnumRegion(source: string, s: Schema): string {
	const start = source.indexOf(START_MARKER);
	const endIdx = source.indexOf(END_MARKER);
	if (start < 0 || endIdx < 0) {
		throw new Error('gen-layout: GENERATED markers missing from engine source');
	}
	const endLine = source.indexOf('\n', endIdx);
	return source.slice(0, start) + generateEnumRegion(s) + source.slice(endLine);
}

// ---- CLI entry (dev-time; CI relies on the regen-diff test) --------------------
const isMain = typeof process !== 'undefined' && process.argv[1] !== undefined
	&& (process.argv[1].endsWith('gen-layout.ts') || process.argv[1].endsWith('gen-layout.js'));
if (isMain) {
	const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
	const { dirname, join } = await import('node:path');
	const here = dirname(new URL(import.meta.url).pathname);
	const enginePath = join(here, '..', 'src', 'engine.ts');
	writeFileSync(enginePath, spliceEnumRegion(readFileSync(enginePath, 'utf8'), schema));
	mkdirSync(join(here, '..', 'src', 'debug'), { recursive: true });
	writeFileSync(join(here, '..', 'src', 'debug', 'layout.debug.ts'), generateDebugTwin(schema));
	mkdirSync(join(here, '..', 'docs'), { recursive: true });
	writeFileSync(join(here, '..', 'docs', 'layout.md'), generateDocs(schema));
	console.log('gen-layout: wrote engine enum region, debug twin, docs table');
}
