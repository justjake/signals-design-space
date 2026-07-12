/**
 * Optimization-trace probe: run a bundled script under V8's tracing flags
 * in a child node process and parse stdout into structured facts:
 *
 *   - inlined:   (callee → into) pairs TurboFan ACTUALLY inlined
 *   - optimized: named functions that completed a TURBOFAN_JS compile
 *   - deopts:    every bailout, tagged steady=true once the child prints
 *                the steady marker (warmup deopts are normal feedback
 *                churn; steady-state EAGER deopts are a bug)
 *
 * Complements the per-package bytecode budget tests: a budget proves a
 * function is small enough to be ELIGIBLE for inlining
 * (< --max-inlined-bytecode-size); the probe proves the decision actually
 * happened and the steady state is deopt-free.
 *
 * Trace line formats are V8-version-sensitive (verified on Node 24 /
 * V8 13.x; all three traces print to STDOUT there, which is what makes the
 * marker split sound). Callers must skip on other Node majors.
 */
import { execFileSync } from 'node:child_process'

/**
 * Lines the probe child prints around its steady phase. Deopts are only
 * a bug INSIDE the bracket: before it is warmup feedback churn, after it
 * is teardown code executing for the first time.
 */
export const STEADY_MARKER = '@@STEADY-START'
export const STEADY_END_MARKER = '@@STEADY-END'

export interface InlineEdge {
	callee: string
	into: string
}

export interface DeoptEvent {
	fn: string
	kind: string // deopt-eager | deopt-lazy | deopt-soft
	reason: string
	/** true when the bailout happened inside the steady bracket. */
	steady: boolean
}

export interface OptTrace {
	inlined: InlineEdge[]
	optimized: Set<string>
	deopts: DeoptEvent[]
	/** Raw child stdout, for debugging a failed expectation. */
	raw: string
}

// `Inlining 0x.. {0x.. <SharedFunctionInfo callee>} into 0x.. {0x.. <SharedFunctionInfo caller>}`
const INLINE_RE =
	/^Inlining .*?<SharedFunctionInfo ?([^>]*)>\} into .*?<SharedFunctionInfo ?([^>]*)>\}/
// `[completed compiling 0x.. <JSFunction name (sfi = 0x..)> (target TURBOFAN_JS) - took ..]`
// The name may be empty (anonymous) or contain spaces (`get state`).
const COMPLETED_RE =
	/^\[completed compiling 0x[0-9a-f]+ <JSFunction ([^(>]*)\(sfi = 0x[0-9a-f]+\)> \(target TURBOFAN_JS\)/
// `[bailout (kind: deopt-eager, reason: wrong map): begin. deoptimizing 0x.. <JSFunction name (sfi ..)>, ..]`
const DEOPT_RE =
	/^\[bailout \(kind: ([^,]+), reason: (.*?)\): begin\. deoptimizing 0x[0-9a-f]+ <JSFunction ([^(>]*)\(sfi/

export function parseTrace(stdout: string): OptTrace {
	const inlined: InlineEdge[] = []
	const optimized = new Set<string>()
	const deopts: DeoptEvent[] = []
	let steady = false
	for (const line of stdout.split('\n')) {
		if (line.includes(STEADY_MARKER)) {
			steady = true
			continue
		}
		if (line.includes(STEADY_END_MARKER)) {
			steady = false
			continue
		}
		const inl = INLINE_RE.exec(line)
		if (inl) {
			inlined.push({ callee: inl[1] || '(anonymous)', into: inl[2] || '(anonymous)' })
			continue
		}
		const done = COMPLETED_RE.exec(line)
		if (done) {
			optimized.add(done[1].trim() || '(anonymous)')
			continue
		}
		const bail = DEOPT_RE.exec(line)
		if (bail) {
			deopts.push({
				kind: bail[1],
				reason: bail[2],
				fn: bail[3].trim() || '(anonymous)',
				steady,
			})
		}
	}
	return { inlined, optimized, deopts, raw: stdout }
}

export interface ProbeOptions {
	/** Bundled .mjs entry (see util/cli.ts bundleChild). */
	script: string
	env?: Record<string, string>
	timeoutMs?: number
}

export function traceOptimization(options: ProbeOptions): OptTrace {
	const stdout = execFileSync(
		process.execPath,
		[
			'--trace-turbo-inlining',
			'--trace-opt',
			'--trace-deopt',
			// Synchronous tier-up: optimization happens at deterministic points
			// in the workload instead of racing a background compile thread.
			'--no-concurrent-recompilation',
			options.script,
		],
		{
			encoding: 'utf8',
			maxBuffer: 512 * 1024 * 1024,
			timeout: options.timeoutMs ?? 120_000,
			env: { ...process.env, ...options.env },
		},
	)
	if (!stdout.includes(STEADY_MARKER) || !stdout.includes(STEADY_END_MARKER)) {
		throw new Error(
			`probe child never printed both steady markers (${STEADY_MARKER} .. ${STEADY_END_MARKER})`,
		)
	}
	return parseTrace(stdout)
}

export function hasEdge(trace: OptTrace, callee: string, into: string): boolean {
	return trace.inlined.some((e) => e.callee === callee && e.into === into)
}

/** Every steady-state eager bailout — the deopt-loop signal. */
export function steadyEagerDeopts(trace: OptTrace): DeoptEvent[] {
	return trace.deopts.filter((d) => d.steady && d.kind === 'deopt-eager')
}
