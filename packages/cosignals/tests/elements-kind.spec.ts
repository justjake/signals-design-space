/**
 * P2 SHAPE — elements-kind probes over the nodeIndex-keyed engine columns
 * (the monomorphic-array spot-check methodology, bytecode.spec.ts's sibling):
 * the smoke (tests/fixtures/elementsKindSmoke.ts) is esbuild-bundled — const
 * enums inline to literals, the codegen consumers execute — and run under
 * `node --allow-natives-syntax`, where it drives realistic traffic including
 * link-heavy graphs and record-reuse churn, then asserts every column is
 * still PACKED via %HasHoleyElements/%HasSmiElements. Nodes and links share
 * the kernel's one record allocator, so RECORD-ID indexing would go holey
 * on exactly this traffic; nodeIndex indexing must not.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smoke = path.join(pkgRoot, 'tests', 'fixtures', 'elementsKindSmoke.ts');
const esbuildBin = path.join(pkgRoot, 'node_modules', '.bin', 'esbuild');

describe('elements-kind probes (esbuild-bundled smoke, --allow-natives-syntax)', () => {
	test('nodeIndex-keyed engine columns stay PACKED under realistic traffic', () => {
		const outDir = mkdtempSync(path.join(tmpdir(), 'cosignals-elements-'));
		const bundle = path.join(outDir, 'elementsKindSmoke.mjs');
		execFileSync(
			esbuildBin,
			['--bundle', smoke, '--format=esm', '--platform=node', '--target=node24', `--outfile=${bundle}`, '--log-level=warning'],
			{ cwd: pkgRoot, encoding: 'utf8' },
		);
		const out = execFileSync(
			process.execPath,
			['--allow-natives-syntax', bundle],
			{ cwd: pkgRoot, encoding: 'utf8' },
		);
		expect(out).toContain('@@ELEMENTS-OK');
	});
});
