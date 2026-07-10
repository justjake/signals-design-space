/**
 * Per-framework optimization expectations, asserted by inlining.spec.ts
 * against a live --trace-turbo-inlining run of the smoke workload.
 *
 * Deliberately COARSE: specific inlining decisions shift between V8
 * versions and pinning them is churn, not signal. The contract is
 * "the kernel runs fast": TurboFan inlines a healthy number of distinct
 * named kernel pairs, the hot-path entry points reach a completed
 * top-tier compile, and the steady state is free of eager deopts (the
 * spec asserts that last one for every framework unconditionally).
 *
 * For ad-hoc investigation of a SPECIFIC edge, use hasEdge() from
 * util/inline-probe against a manual probe run — don't pin it here
 * unless a measurement shows the edge is worth real time AND it stays
 * stable across runs.
 */
import type { AdapterName } from '../adapters/index'

export interface InliningExpectation {
	framework: AdapterName
	/** Floor on DISTINCT named (callee → into) pairs TurboFan inlines. */
	minInlinedPairs: number
	/** Functions that must reach a completed TURBOFAN_JS compile. */
	mustOptimize: string[]
}

const SHARED_OPTIMIZE = [
	'propagate',
	'flush',
	'run',
	'checkDirty',
	'checkDirtyLoop',
	'link',
	'read',
	'write',
]

// Floors sit far under observed reality (~40 distinct named pairs each on
// Node 24) but far above a cold or deopt-looping run (0).
export const expectations: InliningExpectation[] = [
	{
		framework: 'cosignals',
		minInlinedPairs: 10,
		mustOptimize: [...SHARED_OPTIMIZE, 'computedReadSlow', 'writeAtom'],
	},
	{
		framework: 'dalien',
		minInlinedPairs: 10,
		mustOptimize: [...SHARED_OPTIMIZE, 'computedReadWith'],
	},
]
