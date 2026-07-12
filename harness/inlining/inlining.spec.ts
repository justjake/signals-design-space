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
 * Most frameworks get a statically imported adapter bundle (never the
 * registry — see smoke.ts for why). FX2 is emitted by its TypeScript 7
 * compiler so its trace has the same source shape as its perf probes.
 *
 * V8-version-sensitive: trace formats and inlining heuristics move
 * between majors. CI pins Node 24; the suite skips elsewhere.
 */
import { execFileSync } from 'node:child_process'
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
const repoRoot = path.resolve(harnessRoot, '..')

const cleanups: Array<() => void> = []
afterAll(() => {
	for (const cleanup of cleanups) {
		cleanup()
	}
})

async function probeFramework(framework: string, chainDepth: number): Promise<OptTrace> {
	const dir = mkdtempSync(path.join(tmpdir(), `inline-probe-${framework}-${chainDepth}-`))
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
	if (framework === 'fx2') {
		writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n')
		const config = path.join(dir, 'tsconfig.json')
		writeFileSync(
			config,
			JSON.stringify({
				extends: path.join(repoRoot, 'packages/signals-royale-fx2/tsconfig.perf.json'),
				compilerOptions: {
					rootDir: repoRoot,
					outDir: dir,
					noEmit: false,
					incremental: false,
					declaration: false,
					sourceMap: false,
					inlineSourceMap: false,
					types: ['node'],
					typeRoots: [path.join(harnessRoot, 'node_modules/@types')],
				},
				files: [path.join(harnessRoot, 'inlining/fx2-smoke.ts')],
				include: [],
			}),
		)
		execFileSync(
			process.execPath,
			[path.join(harnessRoot, 'node_modules/typescript/bin/tsc'), '-p', config],
			{ cwd: repoRoot },
		)
		return traceOptimization({
			script: path.join(dir, 'harness/inlining/fx2-smoke.js'),
			env: { SMOKE_DEPTH: String(chainDepth) },
		})
	}
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
	for (const { framework, minInlinedPairs, mustInline, mustReachTopTier } of expectations) {
		describe(framework, () => {
			let trace: OptTrace
			beforeAll(async () => {
				trace = await probeFramework(framework, 8)
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

			test(`top-tier compiles or inlines ${mustReachTopTier.join(', ')}`, () => {
				const inlinedCallees = new Set(trace.inlined.map((edge) => edge.callee))
				const missing = mustReachTopTier.filter(
					(name) => !trace.optimized.has(name) && !inlinedCallees.has(name),
				)
				expect(
					missing,
					`neither compiled standalone nor inlined; optimized: ${[...trace.optimized].sort().join(', ')}; inlined callees: ${[...inlinedCallees].sort().join(', ')}`,
				).toEqual([])
			})

			if (mustInline !== undefined) {
				test(`inlines ${mustInline.join(', ')}`, () => {
					const inlinedCallees = new Set(trace.inlined.map((edge) => edge.callee))
					const missing = mustInline.filter((name) => !inlinedCallees.has(name))
					expect(
						missing,
						`not inlined; inlined callees: ${[...inlinedCallees].sort().join(', ')}`,
					).toEqual([])
				})
			}

			if (framework === 'fx2') {
				test('deep chain resolver reaches top tier without steady eager deopts', async () => {
					const deepTrace = await probeFramework(framework, 32)
					const inlinedCallees = new Set(deepTrace.inlined.map((edge) => edge.callee))
					expect(
						deepTrace.optimized.has('chainResolve') || inlinedCallees.has('chainResolve'),
						'chainResolve neither compiled standalone nor inlined',
					).toBe(true)
					expect(
						steadyEagerDeopts(deepTrace).map((d) => `${d.fn}: ${d.reason}`),
						'eager deopts inside the deep steady bracket',
					).toEqual([])
				}, 180_000)
			}

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
