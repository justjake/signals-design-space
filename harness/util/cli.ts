/**
 * Shared plumbing for the per-process runners (bench/run.ts, memory/run.ts):
 * flag parsing, child-process spawning with the @@ROW line protocol, results
 * writing, and table printing.
 *
 * Methodology (RESEARCH.md §1.8): same-process suite runs are order-biased
 * and megamorphic — every framework gets its own child process, spawned
 * sequentially, with --expose-gc.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

/** Parse `--name value` and `--name=value` flags from argv. */
export function parseFlags(argv: string[]): Map<string, string> {
	const flags = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith('--')) continue;
		const eq = arg.indexOf('=');
		if (eq >= 0) {
			flags.set(arg.slice(2, eq), arg.slice(eq + 1));
		} else {
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith('--')) {
				flags.set(arg.slice(2), next);
				i++;
			} else {
				flags.set(arg.slice(2), 'true');
			}
		}
	}
	return flags;
}

export function parseList(value: string | undefined, fallback: readonly string[]): string[] {
	if (!value) return [...fallback];
	return value
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Bundle a child entrypoint to plain ES2022 JS in a temp dir.
 *
 * Children are NOT run through the tsx loader on purpose: tsx transpiles
 * with esbuild `keepNames: true`, whose `__defProp(fn, "name", ...)` wrapper
 * pushes every named closure into dictionary-mode properties (~500 B extra
 * per closure, measured). That would tax the TS-source lab libraries while
 * upstream alien-signals runs prebuilt .mjs untransformed — biasing both the
 * memory probe and allocation-heavy benchmarks. Bundling everything with
 * keepNames OFF gives every framework the identical runtime treatment.
 *
 * esbuild inlines dynamic imports as lazy module initializers, so the
 * adapter registry's one-broken-lib-cannot-break-others property survives
 * bundling.
 *
 * Returns the bundle path and a cleanup function for the temp dir.
 */
export async function bundleChild(
	entry: string,
): Promise<{ script: string; cleanup: () => void }> {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'signals-harness-'));
	const script = path.join(dir, `${path.basename(entry, '.ts')}.mjs`);
	await build({
		entryPoints: [entry],
		outfile: script,
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'es2022',
		keepNames: false,
		sourcemap: false,
	});
	return {
		script,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

export interface ChildResult {
	ok: boolean;
	rows: Record<string, unknown>[];
	exitCode: number | null;
	error?: string;
}

/**
 * Spawn `node --expose-gc <script>` with extra env vars.
 * The child reports result rows on stdout as lines of `@@ROW <json>`;
 * all other output is streamed through for progress visibility.
 */
export function runChild(options: {
	script: string;
	cwd: string;
	env: Record<string, string>;
	timeoutMs: number;
}): Promise<ChildResult> {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			['--expose-gc', options.script],
			{
				cwd: options.cwd,
				env: { ...process.env, ...options.env },
				stdio: ['ignore', 'pipe', 'inherit'],
			},
		);

		const rows: Record<string, unknown>[] = [];
		let timedOut = false;
		let buffer = '';
		child.stdout.on('data', (chunk: Buffer) => {
			buffer += chunk.toString();
			let newline: number;
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.startsWith('@@ROW ')) {
					try {
						rows.push(JSON.parse(line.slice('@@ROW '.length)));
					} catch (e) {
						console.error(`bad @@ROW line: ${line}`);
					}
				} else if (line.trim()) {
					console.log(line);
				}
			}
		});

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, options.timeoutMs);

		child.on('error', (err) => {
			clearTimeout(timer);
			resolve({ ok: false, rows, exitCode: null, error: String(err) });
		});
		child.on('exit', (code) => {
			clearTimeout(timer);
			resolve({
				ok: code === 0 && !timedOut,
				rows,
				exitCode: code,
				error: timedOut ? `timed out after ${options.timeoutMs} ms` : undefined,
			});
		});
	});
}

/** Filesystem-safe local timestamp, e.g. 2026-07-03T14-05-22. */
export function timestamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
		`T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
	);
}

function csvField(value: unknown): string {
	const s = String(value);
	return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Write rows to <resultsDir>/<basename>.json and .csv; returns the paths. */
export function writeResults(
	resultsDir: string,
	basename: string,
	meta: Record<string, unknown>,
	rows: Record<string, unknown>[],
	columns: string[],
): { jsonPath: string; csvPath: string } {
	mkdirSync(resultsDir, { recursive: true });
	const jsonPath = path.join(resultsDir, `${basename}.json`);
	const csvPath = path.join(resultsDir, `${basename}.csv`);
	writeFileSync(jsonPath, JSON.stringify({ ...meta, rows }, null, 2) + '\n');
	const csvLines = [columns.join(',')];
	for (const row of rows) {
		csvLines.push(columns.map((c) => csvField(row[c] ?? '')).join(','));
	}
	writeFileSync(csvPath, csvLines.join('\n') + '\n');
	return { jsonPath, csvPath };
}

/**
 * Print a pivot table: one row per `rowKey`, one column per framework,
 * cell = numeric `valueKey` (fixed decimals) or an em dash when missing.
 */
export function printPivotTable(
	rows: Record<string, unknown>[],
	frameworks: string[],
	rowKeyOf: (row: Record<string, unknown>) => string,
	valueKey: string,
	valueHeader: string,
): void {
	const rowKeys: string[] = [];
	const cells = new Map<string, Map<string, number>>();
	for (const row of rows) {
		const key = rowKeyOf(row);
		if (!cells.has(key)) {
			cells.set(key, new Map());
			rowKeys.push(key);
		}
		cells.get(key)!.set(String(row.framework), Number(row[valueKey]));
	}

	const keyWidth = Math.max(4, ...rowKeys.map((k) => k.length));
	const colWidth = Math.max(10, ...frameworks.map((f) => f.length));
	const header =
		`${valueHeader.padEnd(keyWidth)} | ` +
		frameworks.map((f) => f.padStart(colWidth)).join(' | ');
	console.log(header);
	console.log('-'.repeat(header.length));
	for (const key of rowKeys) {
		const line =
			`${key.padEnd(keyWidth)} | ` +
			frameworks
				.map((f) => {
					const v = cells.get(key)!.get(f);
					return (v === undefined ? '—' : v.toFixed(2)).padStart(colWidth);
				})
				.join(' | ');
		console.log(line);
	}
}
