/**
 * Regen-diff gate for the generated layout: regenerate from tools/schema.ts
 * in memory and string-compare against what is checked in — drift between
 * the schema and the generated region (or the debug twin) is a test failure,
 * not a review burden. Also pins the generator's own failure modes (missing
 * or duplicated markers fail hard rather than corrupting the file).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateDebugTwin, generateLayoutBlock, schema, spliceLayoutBlock } from '../tools/schema.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('generated layout stays in sync with tools/schema.ts', () => {
	it('the engine layout region matches a fresh generation', () => {
		const engine = readFileSync(join(pkgDir, 'src', 'CosignalEngine.ts'), 'utf8');
		expect(spliceLayoutBlock(engine, schema)).toBe(engine);
	});

	it('the debug twin matches a fresh generation', () => {
		const twin = readFileSync(join(pkgDir, 'src', 'debug', 'layout.debug.ts'), 'utf8');
		expect(generateDebugTwin(schema)).toBe(twin);
	});

	it('splice fails hard on missing markers', () => {
		expect(() => spliceLayoutBlock('nothing here', schema)).toThrow(/start marker/);
	});

	it('splice fails hard on duplicated markers', () => {
		const block = generateLayoutBlock(schema);
		expect(() => spliceLayoutBlock(`${block}\n${block}`, schema)).toThrow(/duplicated/);
	});
});
