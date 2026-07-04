/**
 * Benchmark parent: spawns ONE CHILD PROCESS PER FRAMEWORK (sequentially) so
 * rankings are not order-biased/megamorphic (RESEARCH.md §1.8), collects
 * {suite, framework, test, time} rows, writes JSON + CSV per framework to
 * harness/results/<timestamp>-<framework>.{json,csv}, and prints a pivot
 * table at the end.
 *
 * Usage (from repo root):
 *   pnpm -C harness bench                                    # all suites x all frameworks
 *   pnpm -C harness bench --frameworks alien-v3,arrayd --suites kairo,sbench
 *   pnpm -C harness bench --timeout 900000                   # per-child cap, ms
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterNames } from '../adapters/index';
import {
	bundleChild,
	parseFlags,
	parseList,
	printPivotTable,
	runChild,
	timestamp,
	writeResults,
} from '../util/cli';

const harnessDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = path.join(harnessDir, 'results');
const childScript = path.join(harnessDir, 'bench', 'child.ts');

const ALL_SUITES = ['kairo', 'sbench', 'cellx', 'dynamic'] as const;

async function main(): Promise<void> {
	const flags = parseFlags(process.argv.slice(2));
	const frameworks = parseList(flags.get('frameworks'), adapterNames);
	const suites = parseList(flags.get('suites'), ALL_SUITES);
	const timeoutMs = Number(flags.get('timeout') ?? 15 * 60 * 1000);
	const stamp = timestamp();

	const allRows: Record<string, unknown>[] = [];
	const failures: { framework: string; detail: string }[] = [];

	// Bundle once (shared by all frameworks; env selects the adapter).
	const bundle = await bundleChild(childScript);
	process.on('exit', bundle.cleanup);

	for (const framework of frameworks) {
		// One child per (framework, suite) pair: suites sharing a process
		// pollute each other's heap (measured: cellx1000 ran ~9x slower after
		// sbench in the same process).
		const rows: Record<string, unknown>[] = [];
		let ok = true;
		let firstError: string | undefined;
		for (const suite of suites) {
			console.log(`\n=== ${framework} :: ${suite} ===`);
			const result = await runChild({
				script: bundle.script,
				cwd: harnessDir,
				env: { FRAMEWORK: framework, SUITES: suite },
				timeoutMs,
			});
			rows.push(...result.rows);
			if (!result.ok) {
				ok = false;
				const detail = result.error ?? `exit code ${result.exitCode}`;
				firstError ??= `${suite}: ${detail}`;
				console.error(`!!! ${framework}/${suite} FAILED (${detail}); partial rows kept`);
			}
		}
		allRows.push(...rows);
		const result = { ok, rows, error: firstError ?? null };
		if (!result.ok) {
			failures.push({ framework, detail: result.error! });
		}
		if (result.rows.length > 0) {
			const { jsonPath, csvPath } = writeResults(
				resultsDir,
				`${stamp}-${framework}`,
				{
					kind: 'bench',
					framework,
					suites,
					timestamp: stamp,
					node: process.version,
					loadavg: os.loadavg(),
					ok: result.ok,
					error: result.error ?? null,
				},
				result.rows,
				['framework', 'suite', 'test', 'time'],
			);
			console.log(`results: ${jsonPath}`);
			console.log(`         ${csvPath}`);
		}
	}

	if (allRows.length > 0) {
		console.log('\ntime in ms (fastest-of-N per the milomg harness; lower is better)\n');
		printPivotTable(
			allRows,
			frameworks,
			(row) => `${row.suite}/${row.test}`,
			'time',
			'suite/test',
		);
	}

	if (failures.length > 0) {
		console.error(
			`\nframeworks with failures: ${failures
				.map((f) => `${f.framework} (${f.detail})`)
				.join(', ')}`,
		);
		process.exitCode = 1;
	}
}

await main();
