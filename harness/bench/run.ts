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
 *   pnpm -C harness bench --runtime bun                      # run children under bun/JSC
 *
 * --runtime node|bun (default node) selects the engine the bundled child runs
 * under. bun also honors --expose-gc (maps to a synchronous JSC full GC), so
 * the suites' between-run gc() calls work in both runtimes.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterNames } from '../adapters/index';
import {
	bundleChild,
	type ChildResult,
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

/**
 * Local bun equivalent of util/cli.ts runChild (which hardcodes
 * `node --expose-gc`): spawns `bun --expose-gc <script>` and speaks the same
 * `@@ROW <json>` stdout protocol. bun's --expose-gc installs a globalThis.gc
 * backed by JSC's synchronous collector, so suite gc() calls keep working.
 */
function runBunChild(options: {
	script: string;
	cwd: string;
	env: Record<string, string>;
	timeoutMs: number;
}): Promise<ChildResult> {
	return new Promise((resolve) => {
		const child = spawn('bun', ['--expose-gc', options.script], {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ['ignore', 'pipe', 'inherit'],
		});

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
					} catch {
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

async function main(): Promise<void> {
	const flags = parseFlags(process.argv.slice(2));
	const frameworks = parseList(flags.get('frameworks'), adapterNames);
	const suites = parseList(flags.get('suites'), ALL_SUITES);
	const timeoutMs = Number(flags.get('timeout') ?? 15 * 60 * 1000);
	const runtime = flags.get('runtime') ?? 'node';
	if (runtime !== 'node' && runtime !== 'bun') {
		console.error(`unknown --runtime ${JSON.stringify(runtime)}; expected node or bun`);
		process.exit(1);
	}
	const spawnChild = runtime === 'bun' ? runBunChild : runChild;
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
			console.log(`\n=== ${framework} :: ${suite} (${runtime}) ===`);
			const result = await spawnChild({
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
				`${stamp}-${framework}${runtime === 'bun' ? '-bun' : ''}`,
				{
					kind: 'bench',
					framework,
					suites,
					timestamp: stamp,
					node: process.version,
					runtime,
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
