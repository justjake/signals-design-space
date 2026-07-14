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
const INLINE_LIMIT = 460

// Node 24.16 bytecode length plus narrow slack. Every ordinary budget stays
// below V8's per-function inline ceiling; an over-limit function is pinned
// separately so growth remains explicit.
const FX2_BYTECODE_BUDGETS: Record<string, number> = {
	readAtom: 50,
	getComputed: 100,
	readComputed: 100,
	// This includes the sole-caller propagation and flush tail. Keeping that
	// tail inline measured faster, and 130 remains far below the inline limit.
	writeAtom: 130,
	runEffectCleanup: 160,
	scheduleWatcher: 210,
	runHandler: 240,
	trackRead: 260,
	propagateWave: 280,
	flush: 330,
	chainResolve: 390,
	ensureFreshAt: 400,
}

const FX2_WORLD_BYTECODE_BUDGETS: Record<string, number> = {
	memoFor: 30,
	inheritCertificate: 70,
	recordSource: 85,
	unwrapComputedWorldState: 130,
	memoValid: 260,
}

const cleanups: Array<() => void> = []
afterAll(() => {
	for (const cleanup of cleanups) {
		cleanup()
	}
})

/** Emit FX2 with the same explicit TypeScript 7 invocation used by its
 * performance probes. */
function emitFx2Smoke(dir: string, entry = 'fx2-smoke'): string {
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
			files: [path.join(harnessRoot, `inlining/${entry}.ts`)],
			include: [],
		}),
	)
	execFileSync(
		process.execPath,
		[path.join(harnessRoot, 'node_modules/typescript/bin/tsc'), '-p', config],
		{ cwd: repoRoot },
	)
	return path.join(dir, `harness/inlining/${entry}.js`)
}

async function probeFramework(framework: string, chainDepth: number): Promise<OptTrace> {
	const dir = mkdtempSync(path.join(tmpdir(), `inline-probe-${framework}-${chainDepth}-`))
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
	if (framework === 'fx2') {
		return traceOptimization({
			script: emitFx2Smoke(dir),
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

function bytecodeLength(script: string, name: string): number {
	const output = execFileSync(
		process.execPath,
		['--print-bytecode', `--print-bytecode-filter=${name}`, script],
		{
			cwd: repoRoot,
			encoding: 'utf8',
			env: { ...process.env, SMOKE_DEPTH: '32', SMOKE_WARM: '2000', SMOKE_STEADY: '1' },
			maxBuffer: 32 * 1024 * 1024,
		},
	)
	let size: number | undefined
	for (const match of output.matchAll(/^Bytecode length: (\d+)$/gm)) {
		const candidate = Number(match[1])
		size = size === undefined ? candidate : Math.max(size, candidate)
	}
	expect(size, `bytecode length of ${name}`).toBeDefined()
	return size!
}

describe.skipIf(NODE_MAJOR !== 24)('fx2 bytecode budgets (tsc-emitted smoke, Node 24)', () => {
	let script: string
	let worldScript: string
	beforeAll(() => {
		const dir = mkdtempSync(path.join(tmpdir(), 'fx2-bytecode-'))
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
		script = emitFx2Smoke(dir)
		const worldDir = mkdtempSync(path.join(tmpdir(), 'fx2-world-bytecode-'))
		cleanups.push(() => rmSync(worldDir, { recursive: true, force: true }))
		worldScript = emitFx2Smoke(worldDir, 'fx2-world-smoke')
	}, 180_000)

	for (const [name, budget] of Object.entries(FX2_BYTECODE_BUDGETS)) {
		test(`${name} <= ${budget}`, () => {
			expect(bytecodeLength(script, name)).toBeLessThanOrEqual(budget)
			expect(budget).toBeLessThanOrEqual(INLINE_LIMIT)
		})
	}

	for (const [name, budget] of Object.entries(FX2_WORLD_BYTECODE_BUDGETS)) {
		test(`${name} <= ${budget}`, () => {
			expect(bytecodeLength(worldScript, name)).toBeLessThanOrEqual(budget)
			expect(budget).toBeLessThanOrEqual(INLINE_LIMIT)
		})
	}

	// The two-phase drain owns pull/cleanup/handler sequencing for a whole
	// lane round; it is over the inline limit by design — callers pay one
	// call per drain, not per entry.
	test('drainLane pinned at 720 (over the inline limit)', () => {
		const size = bytecodeLength(script, 'drainLane')
		expect(size).toBeLessThanOrEqual(720)
		expect(size).toBeGreaterThan(INLINE_LIMIT)
	})

	// The evaluation owner (dependency re-tracking, tracing, park/error
	// folding, the self-affecting stamp discipline). Callers pay one call
	// per actual recomputation, so being out of line is tolerable — but the
	// pin keeps further growth explicit.
	test('recompute pinned at 520 (over the inline limit)', () => {
		const size = bytecodeLength(script, 'recompute')
		expect(size).toBeLessThanOrEqual(520)
		expect(size).toBeGreaterThan(INLINE_LIMIT)
	})

	// Draft-world tracing emits compute, suspension, error, and world identity
	// events here. The untraced branch bypasses that work; this owner was
	// already deliberately over the inline limit before tracing was added.
	test('resolveState pinned at 1129 (over the inline limit)', () => {
		const size = bytecodeLength(worldScript, 'resolveState')
		expect(size).toBeLessThanOrEqual(1129)
		expect(size).toBeGreaterThan(INLINE_LIMIT)
	})
})

describe.skipIf(NODE_MAJOR !== 24)('fx2 committed-world inlining (tsc-emitted, Node 24)', () => {
	let trace: OptTrace
	beforeAll(() => {
		const dir = mkdtempSync(path.join(tmpdir(), 'fx2-world-inline-'))
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
		trace = traceOptimization({ script: emitFx2Smoke(dir, 'fx2-world-smoke') })
	}, 180_000)

	test('inlines draft-world read helpers', () => {
		const inlined = new Set(trace.inlined.map((edge) => edge.callee))
		const required = ['getComputed', 'unwrapComputedWorldState', 'memoValid']
		expect(
			required.filter((name) => !inlined.has(name)),
			`not inlined; inlined callees: ${[...inlined].sort().join(', ')}`,
		).toEqual([])
	})

	test('world kernel reaches top tier', () => {
		const inlined = new Set(trace.inlined.map((edge) => edge.callee))
		const required = ['resolveState']
		expect(
			required.filter((name) => !trace.optimized.has(name) && !inlined.has(name)),
			`not top-tier; optimized: ${[...trace.optimized].sort().join(', ')}`,
		).toEqual([])
	})

	test('steady committed-world execution is free of eager deopts', () => {
		expect(
			steadyEagerDeopts(trace).map((d) => `${d.fn}: ${d.reason}`),
			'eager deopts inside the committed-world steady bracket',
		).toEqual([])
	})
})

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
