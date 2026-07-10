/**
 * Differential fuzzing of the CONCURRENT engine against the reference model
 * (`cosignals-oracle`); the required outcome is zero diffs over the full
 * corpus. Identical seeded schedules replay into the engine and the model
 * side by side, comparing — after EVERY step — op legality, the full
 * observable snapshot (newest / committed-per-root / every open render
 * world), and the comparable event stream (deliveries, suppressions,
 * corrections, commits, retirements, effect runs). Corpus: the reference
 * model's own CI scale (300 seeds × 80 steps) plus the 8 long episode-churn
 * seeds × 400 steps.
 *
 * Every failure prints its seed and a shrunk schedule (the reference
 * model's greedy op-removal shrinker, re-run against a FRESH engine per
 * candidate).
 */
import { describe, expect, it } from 'vitest'
import {
	generateSchedule,
	runSchedule,
	shrink,
	type ScheduleOp,
} from '../../cosignals-oracle/src/schedule.js'
import { diffAgainstModelTolerant, engineAsAdapter } from './oracle-adapter.js'
import frozen from '../../cosignals-oracle/tests/frozen-schedules.json'

/** THE FROZEN FINDING SEEDS (R-3's executable-spec order): the named seeds'
 * schedules were captured as literal op lists BEFORE the generator gained
 * the writing-core-effect and custom-equals bands — their pinned
 * regressions survive any generator change (generator output for the same
 * seed numbers is now different, and that is fine: fresh sweeps regenerate,
 * archives replay literals). */
const FROZEN = frozen as Record<string, ScheduleOp[]>

const CI_SEEDS = 300
const CI_STEPS = 80
const LONG_SEEDS = 8
const LONG_STEPS = 400

/**
 * Diff one schedule against a fresh engine; on failure, shrink and throw
 * loudly. The differ is the TOLERANT one (`diffAgainstModelTolerant` in
 * ./oracle-adapter.ts) — identical to the reference model's
 * `diffAgainstModel` except that delivery-decision events compare under the
 * "engine ⊇ required, ⊆ union-conservative" relaxation documented in the
 * reference model's README; legality, snapshots, and all other events stay
 * exact per step.
 */
function expectSeedDiffClean(seed: number, steps: number): void {
	expectOpsDiffClean(generateSchedule(seed, steps), seed)
}

/** Diff a concrete (frozen or generated) op list; shrink on failure. */
function expectOpsDiffClean(ops: ScheduleOp[], seed?: number): void {
	const diff = diffAgainstModelTolerant(engineAsAdapter(), ops, seed)
	if (diff === undefined) return
	const failing = (candidate: ScheduleOp[]): boolean =>
		diffAgainstModelTolerant(engineAsAdapter(), candidate) !== undefined
	const shrunk = shrink(ops, failing)
	const finalDiff = diffAgainstModelTolerant(engineAsAdapter(), shrunk)
	expect.fail(
		`seed ${seed} diverged at step ${diff.step}: ${diff.message}\n` +
			`shrunk schedule (${shrunk.length} ops): ${JSON.stringify(shrunk)}\n` +
			`shrunk divergence: step ${finalDiff?.step}: ${finalDiff?.message}`,
	)
}

describe('CONCURRENT engine vs oracle (diffAgainstModel, step-by-step)', () => {
	it('smoke: seeds 1..5 diff clean', () => {
		for (let seed = 1; seed <= 5; seed++) expectSeedDiffClean(seed, CI_STEPS)
	})

	it(`${CI_SEEDS} seeds × ${CI_STEPS} steps diff clean`, () => {
		for (let seed = 1; seed <= CI_SEEDS; seed++) expectSeedDiffClean(seed, CI_STEPS)
	})

	it(`${LONG_SEEDS} long seeds × ${LONG_STEPS} steps (episode churn: recycle, epoch reset, backstop) — FROZEN literals`, () => {
		for (let seed = 9001; seed < 9001 + LONG_SEEDS; seed++)
			expectOpsDiffClean(FROZEN[`s${seed}x400`]!, seed)
	})

	it('the flag-5 finding seeds (29, 97, 173) diff clean — FROZEN literals', () => {
		// The schedules that first exposed the mount-fixup fast-out corner covered
		// by the "flag 5" tests (concurrent-flags.spec.ts) — stored as literal op
		// lists (tests/frozen-schedules.json) so no generator change can ever
		// silently rewrite them.
		for (const seed of [29, 97, 173]) expectOpsDiffClean(FROZEN[`s${seed}x80`]!, seed)
	})

	// [SANCTIONED CO-EVOLUTION: converged-terminal referee, review finding #8]
	// The durable regression pins for the converged committed terminal. Each
	// FROZEN schedule drives the exact wave-1 scenario on the quiet path and is
	// what makes the randomized referee no longer BLIND to the terminal:
	//  - bug 1: a core/quiet-path write to a terminal's dependency (`sig`) —
	//    the terminal must keep its dep and re-fire on EVERY committed change,
	//    never run inside the core-effect frame (where its reads record no dep);
	//  - bug 2: a terminal body writing a sibling terminal's dependency (`sib`)
	//    — the write must schedule the sibling at the boundary, never nest.
	// The assertions pin BOTH that the terminal actually re-fires (else the pin
	// is vacuous) AND that the engine matches the model step-for-step; the
	// pre-fix engine diverges here (see the STEP-3 proof in the change report).
	it('the converged-terminal pins (bugs 1 & 2) exercise the terminal AND diff clean — FROZEN literals', () => {
		for (const key of ['terminal-bug1-quiet', 'terminal-bug2-quiet']) {
			const ops = FROZEN[key]!
			const model = runSchedule(ops, true) // the naive spec: invariants after every step
			expect(model.failure, `${key}: ${model.failure?.error.message}`).toBeUndefined()
			const reFires = model.model.eventsOfType('react-effect-run').length
			expect(
				reFires,
				`${key} never re-fired the terminal — the pin is vacuous`,
			).toBeGreaterThanOrEqual(2)
			expectOpsDiffClean(ops) // engine ≡ model, step by step
		}
	})
})
