/**
 * Memory probe parent: one child process per framework (node --expose-gc via
 * tsx), collects {framework, metric, kb} rows, writes them to
 * harness/results/<timestamp>-memory-<framework>.{json,csv}, prints a table.
 *
 * Usage (from repo root):
 *   pnpm -C harness memory                          # all frameworks
 *   pnpm -C harness memory --frameworks alien-v3
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { adapterNames } from '../adapters/index'
import {
	bundleChild,
	parseFlags,
	parseList,
	printPivotTable,
	runChild,
	timestamp,
	writeResults,
} from '../util/cli'

const harnessDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resultsDir = path.join(harnessDir, 'results')
const childScript = path.join(harnessDir, 'memory', 'child.ts')

async function main(): Promise<void> {
	const flags = parseFlags(process.argv.slice(2))
	const frameworks = parseList(flags.get('frameworks'), adapterNames)
	const timeoutMs = Number(flags.get('timeout') ?? 5 * 60 * 1000)
	const stamp = timestamp()

	const allRows: Record<string, unknown>[] = []
	const failures: { framework: string; detail: string }[] = []

	// Bundle once (shared by all frameworks; env selects the adapter).
	const bundle = await bundleChild(childScript)
	process.on('exit', bundle.cleanup)

	for (const framework of frameworks) {
		console.log(`\n=== memory probe: ${framework} ===`)
		const result = await runChild({
			script: bundle.script,
			cwd: harnessDir,
			env: { FRAMEWORK: framework },
			timeoutMs,
		})
		allRows.push(...result.rows)
		if (!result.ok) {
			const detail = result.error ?? `exit code ${result.exitCode}`
			failures.push({ framework, detail })
			console.error(`!!! ${framework} FAILED (${detail})`)
		}
		if (result.rows.length > 0) {
			const { jsonPath, csvPath } = writeResults(
				resultsDir,
				`${stamp}-memory-${framework}`,
				{
					kind: 'memory',
					framework,
					timestamp: stamp,
					node: process.version,
					loadavg: os.loadavg(),
					ok: result.ok,
					error: result.error ?? null,
				},
				result.rows,
				['framework', 'metric', 'kb'],
			)
			console.log(`results: ${jsonPath}`)
			console.log(`         ${csvPath}`)
		}
	}

	if (allRows.length > 0) {
		console.log('\nretained heap in KB (measured through the shared adapter; lower is better)\n')
		printPivotTable(allRows, frameworks, (row) => String(row.metric), 'kb', 'metric')
	}

	if (failures.length > 0) {
		console.error(
			`\nframeworks with failures: ${failures
				.map((f) => `${f.framework} (${f.detail})`)
				.join(', ')}`,
		)
		process.exitCode = 1
	}
}

await main()
