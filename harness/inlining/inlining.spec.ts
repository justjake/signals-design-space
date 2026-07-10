/**
 * Inlining verification: proves V8 ACTUALLY inlines and top-tier-compiles
 * the kernel functions each framework's expectations pin, and that the
 * kernel is deopt-free at steady state.
 *
 * How it relates to the per-package bytecode budget suites: a bytecode
 * budget proves a function is small enough to be ELIGIBLE for inlining
 * (< --max-inlined-bytecode-size); this suite runs the smoke workload
 * under --trace-turbo-inlining/--trace-opt/--trace-deopt in a child node
 * and asserts the decisions actually happened. A budget failure says
 * "which function grew"; a failure here says "the inlining you care about
 * stopped happening" or "the kernel deopts under unchanged shapes".
 *
 * Per framework the spec generates a tiny entry that STATICALLY imports
 * one adapter (never the registry — see smoke.ts for why), bundles it
 * with the shared bundleChild helper, and probes it.
 *
 * V8-version-sensitive: trace formats and inlining heuristics move
 * between majors. CI pins Node 24; the suite skips elsewhere.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { steadyEagerDeopts, traceOptimization, type OptTrace } from '../util/inline-probe'
import { bundleChild } from '../util/cli'
import { expectations } from './expects'

const NODE_MAJOR = Number(process.versions.node.split('.')[0])
const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const cleanups: Array<() => void> = []
afterAll(() => {
	for (const cleanup of cleanups) {
		cleanup()
	}
})

async function probeFramework(framework: string): Promise<OptTrace> {
	const dir = mkdtempSync(path.join(tmpdir(), `inline-probe-${framework}-`))
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
	const entry = path.join(dir, `${framework}.ts`)
	writeFileSync(
		entry,
		[
			`import adapter from ${JSON.stringify(path.join(harnessRoot, 'adapters', `${framework}.ts`))};`,
			`import { runSmoke } from ${JSON.stringify(path.join(harnessRoot, 'inlining', 'smoke.ts'))};`,
			'runSmoke(adapter);',
			'',
		].join('\n'),
	)
	const bundle = await bundleChild(entry)
	cleanups.push(bundle.cleanup)
	return traceOptimization({ script: bundle.script })
}

describe.skipIf(NODE_MAJOR !== 24)('inlining probe (traced child, Node 24)', () => {
	for (const { framework, minInlinedPairs, mustOptimize } of expectations) {
		describe(framework, () => {
			let trace: OptTrace
			beforeAll(async () => {
				trace = await probeFramework(framework)
			}, 180_000)

			test(`inlines at least ${minInlinedPairs} distinct named pairs`, () => {
				const pairs = new Set(
					trace.inlined
						.filter((e) => e.callee !== '(anonymous)' && e.into !== '(anonymous)')
						.map((e) => `${e.callee} -> ${e.into}`),
				)
				expect(
					pairs.size,
					`distinct named inlined pairs:\n${[...pairs].sort().join('\n')}`,
				).toBeGreaterThanOrEqual(minInlinedPairs)
			})

			test(`optimizes ${mustOptimize.join(', ')}`, () => {
				const missing = mustOptimize.filter((name) => !trace.optimized.has(name))
				expect(
					missing,
					`never completed a TURBOFAN_JS compile; optimized set: ${[...trace.optimized].sort().join(', ')}`,
				).toEqual([])
			})

			test('steady state is free of eager deopts', () => {
				const bad = steadyEagerDeopts(trace)
				expect(
					bad.map((d) => `${d.fn}: ${d.reason}`),
					'eager deopts inside the steady bracket — a deopt loop under unchanged graph shapes',
				).toEqual([])
			})
		})
	}
})
