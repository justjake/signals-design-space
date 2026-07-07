/**
 * Documentation vocabulary gate — a source/docs scan in the style of
 * trace-off.spec.ts's source-discipline checks. It pins the shipped
 * vocabulary:
 *
 *  - BANNED WORDS, everywhere in shipped sources and READMEs (code,
 *    comments, identifiers, prose): "mint"/"minting"/"minted" (say
 *    create/created), "plane" as a word (world storage is an arena, never
 *    a plane), and "token" (a grouped update is always a BATCH / BatchId).
 *  - INTERNAL-DOCUMENT REFERENCES in the two README files: a published
 *    README must be self-contained, so section-sign references (§N) and
 *    references to the repo's internal planning documents ("plans/2026-")
 *    may not appear there.
 *
 * Scope: every packages/cosignals/src/*.ts, every
 * packages/cosignals-react/src/*.ts, and both packages' README.md files.
 * Allowance: in cosignals-react sources ONLY, occurrences inside the string
 * names of React's own `unstable_*` protocol entry points are exempt (the
 * protocol's names are React's to choose); cosignals itself has no
 * allowance.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const reactPkgDir = join(pkgDir, '..', 'cosignals-react');

/** Whole-word banned terms (case-insensitive). */
const BANNED_WORDS: RegExp[] = [
	/\bmint(?:ing|ed)?\b/i,
	/\bplane\b/i,
	/\btoken\b/i,
];

/** README-only patterns: internal planning-document references. */
const README_INTERNAL_REFS: RegExp[] = [
	/§\d/, // section-sign references into internal documents
	/plans\/2026-/, // the repo's planning-document paths
];

function sourceFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith('.ts'))
		.map((f) => join(dir, f));
}

/** The cosignals-react allowance: drop React's own `unstable_*` protocol
 * entry-point names before scanning, so a banned fragment inside one of
 * React's names can never trip the gate (nothing else is exempt). */
function stripUnstableNames(text: string): string {
	return text.replace(/unstable_[A-Za-z0-9_]*/g, 'unstable_');
}

function offendingLines(text: string, patterns: RegExp[]): string[] {
	const out: string[] = [];
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		for (const p of patterns) {
			if (p.test(lines[i]!)) {
				out.push(`line ${i + 1} [${String(p)}]: ${lines[i]!.trim()}`);
			}
		}
	}
	return out;
}

describe('docs gate: banned vocabulary in shipped sources', () => {
	it('cosignals sources carry no banned words (no allowance)', () => {
		for (const file of sourceFiles(join(pkgDir, 'src'))) {
			const hits = offendingLines(readFileSync(file, 'utf8'), BANNED_WORDS);
			expect(hits, `${file}\n${hits.join('\n')}`).toEqual([]);
		}
	});

	it('cosignals-react sources carry no banned words (React unstable_* names exempt)', () => {
		for (const file of sourceFiles(join(reactPkgDir, 'src'))) {
			const text = stripUnstableNames(readFileSync(file, 'utf8'));
			const hits = offendingLines(text, BANNED_WORDS);
			expect(hits, `${file}\n${hits.join('\n')}`).toEqual([]);
		}
	});
});

describe('docs gate: the READMEs are self-contained', () => {
	const readmes = [join(pkgDir, 'README.md'), join(reactPkgDir, 'README.md')];

	it('no banned words', () => {
		for (const file of readmes) {
			const hits = offendingLines(readFileSync(file, 'utf8'), BANNED_WORDS);
			expect(hits, `${file}\n${hits.join('\n')}`).toEqual([]);
		}
	});

	it('no internal planning-document references (§N, plans/2026-)', () => {
		for (const file of readmes) {
			const hits = offendingLines(readFileSync(file, 'utf8'), README_INTERNAL_REFS);
			expect(hits, `${file}\n${hits.join('\n')}`).toEqual([]);
		}
	});
});
