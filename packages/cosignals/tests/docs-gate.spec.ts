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
 *  - SELF-CONTAINED SOURCE COMMENTS: shipped source comments explain
 *    themselves in place. Section-sign references (§N) and internal
 *    document paths (plans/, research/) may not appear anywhere in a
 *    source file, and research-stage shorthand (NF2, RCC, CR5, OL1/OL2,
 *    S5R, RT6, EF2, W9, SPK-*, S-A…S-D) may not appear in comment text.
 *    The stage-code list is deliberately the low-collision subset: short
 *    codes that alias plausible identifiers or test-family names (D1…D7 —
 *    index.ts's own deviation enumeration — K1, B2, P1, m2, R-2, T1…) are
 *    not machine-checked; prose review owns those.
 *
 * Scope: every .ts source under packages/cosignals/src and
 * packages/cosignals-react/src (subdirectories included), and both
 * packages' README.md files.
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

/** Source-wide patterns: internal-document references never belong in a
 * shipped source file (comments or otherwise; `§` cannot occur in code). */
const SRC_INTERNAL_REFS: RegExp[] = [
	/§\d?/, // section-sign references into internal documents
	/\bplans\//, // the repo's planning-document paths
	/\bresearch\//, // the repo's research-notes paths
];

/** Comment-text-only patterns: research-stage shorthand (the low-collision
 * subset — see the module header for what is deliberately not checked). */
const COMMENT_STAGE_CODES: RegExp[] = [
	/\b(?:NF2|RCC|CR5|OL[12]|S5R|RT6|EF2|W9)\b/,
	/\bSPK-?[A-Za-z0-9]+\b/,
	/\bS-[ABCD]\b/,
];

/** Every .ts source under `dir`, subdirectories included; asserts the scan
 * found something, so a moved directory can never silently empty the gate. */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
		if (entry.isFile() && entry.name.endsWith('.ts')) {
			out.push(join(entry.parentPath, entry.name));
		}
	}
	expect(out, `docs-gate scanned no sources under ${dir}`).not.toEqual([]);
	return out;
}

/** The comment text of a TS source, line-aligned with the original (code
 * stripped, so identifier hits can never trip a comment-only pattern; string
 * contents are not parsed — a `//` inside a string over-approximates, which
 * only errs toward strictness). */
function commentTextByLine(text: string): string[] {
	const out: string[] = [];
	let inBlock = false;
	for (const line of text.split('\n')) {
		let kept = '';
		let rest = line;
		while (rest.length > 0) {
			if (inBlock) {
				const end = rest.indexOf('*/');
				if (end === -1) {
					kept += rest;
					rest = '';
				} else {
					kept += rest.slice(0, end);
					rest = rest.slice(end + 2);
					inBlock = false;
				}
			} else {
				const lineStart = rest.indexOf('//');
				const blockStart = rest.indexOf('/*');
				if (lineStart !== -1 && (blockStart === -1 || lineStart < blockStart)) {
					kept += rest.slice(lineStart + 2);
					rest = '';
				} else if (blockStart !== -1) {
					rest = rest.slice(blockStart + 2);
					inBlock = true;
				} else {
					rest = '';
				}
			}
		}
		out.push(kept);
	}
	return out;
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

describe('docs gate: test-seam naming (__TEST__ prefix)', () => {
	const srcDirs = [join(pkgDir, 'src'), join(reactPkgDir, 'src')];

	/** Production seams that legitimately carry a __ prefix without being
	 * test-only (each is consumed by the package's own runtime paths):
	 * the policy layer's plain write tail and lifecycle write path, the
	 * standalone fast-arm flag's setter, and the engine's handle-free
	 * write-path resolution pair. Everything else exported with a __ prefix
	 * must be a __TEST__-prefixed test seam. */
	const PRODUCTION_DUNDER_EXPORTS = new Set([
		'__plainAtomWrite',
		'__lifecycleWrite',
		'__setStandaloneQuiet',
		'__engineAtomInternalsById',
		'__engineWriteNode',
	]);

	/** Exported identifiers of a TS source: declaration exports and export
	 * lists (aliases count by their EXPORTED name). */
	function exportedNames(text: string): string[] {
		const out: string[] = [];
		for (const m of text.matchAll(/export (?:function|const|var|let|class|type|interface) ([A-Za-z_$][\w$]*)/g)) {
			out.push(m[1]!);
		}
		for (const m of text.matchAll(/export \{([^}]*)\}/g)) {
			for (const entry of m[1]!.split(',')) {
				const name = (entry.includes(' as ') ? entry.split(' as ')[1]! : entry).trim();
				if (name.length > 0) out.push(name);
			}
		}
		return out;
	}

	it('no identifier anywhere uses the retired *ForTest suffix', () => {
		// Scans every identifier, not just exports: internal helpers must not
		// carry the retired convention either (test-only naming is __TEST__*).
		// Foreign API names we call but do not define are allowlisted: the
		// React fork follows the reconciler's own naming conventions.
		const foreignApi = new Set(['externalRuntimeResetBatchRegistryForTest', 'unstable_resetBatchRegistryForTest']);
		for (const dir of srcDirs) {
			for (const file of sourceFiles(dir)) {
				const hits = [...readFileSync(file, 'utf8').matchAll(/\b_{0,2}\w+ForTests?\b/g)]
					.map((m) => m[0])
					.filter((n) => !foreignApi.has(n));
				expect(hits, `${file}\n${hits.join('\n')}`).toEqual([]);
			}
		}
	});

	it('every exported __-identifier is a __TEST__ seam or an allowlisted production seam', () => {
		for (const dir of srcDirs) {
			for (const file of sourceFiles(dir)) {
				const hits = exportedNames(readFileSync(file, 'utf8')).filter(
					(n) => n.startsWith('__') && !n.startsWith('__TEST__') && !PRODUCTION_DUNDER_EXPORTS.has(n),
				);
				expect(hits, `${file}\n${hits.join('\n')}`).toEqual([]);
			}
		}
	});
});

describe('docs gate: source comments are self-contained', () => {
	const srcDirs = [join(pkgDir, 'src'), join(reactPkgDir, 'src')];

	it('no internal-document references anywhere in shipped sources (§N, plans/, research/)', () => {
		for (const dir of srcDirs) {
			for (const file of sourceFiles(dir)) {
				const hits = offendingLines(readFileSync(file, 'utf8'), SRC_INTERNAL_REFS);
				expect(hits, `${file}\n${hits.join('\n')}`).toEqual([]);
			}
		}
	});

	it('no research-stage shorthand in source comment text', () => {
		for (const dir of srcDirs) {
			for (const file of sourceFiles(dir)) {
				const comments = commentTextByLine(readFileSync(file, 'utf8'));
				const hits: string[] = [];
				for (let i = 0; i < comments.length; i++) {
					for (const p of COMMENT_STAGE_CODES) {
						if (p.test(comments[i]!)) hits.push(`line ${i + 1} [${String(p)}]: ${comments[i]!.trim()}`);
					}
				}
				expect(hits, `${file}\n${hits.join('\n')}`).toEqual([]);
			}
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
