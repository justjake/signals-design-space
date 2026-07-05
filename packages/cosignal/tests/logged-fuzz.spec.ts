/**
 * Differential fuzzing of the LOGGED engine against the reference model
 * (`cosignal-oracle`); the required outcome is zero diffs over the full
 * corpus. Identical seeded schedules replay into the engine and the model
 * side by side, comparing — after EVERY step — op legality, the full
 * observable snapshot (newest / committed-per-root / every open pass
 * world), and the comparable event stream (deliveries, suppressions,
 * corrections, commits, retirements, effect runs). Corpus: the reference
 * model's own CI scale (300 seeds × 80 steps) plus the 8 long episode-churn
 * seeds × 400 steps.
 *
 * Every failure prints its seed and a shrunk schedule (the reference
 * model's greedy op-removal shrinker, re-run against a FRESH engine per
 * candidate).
 */
import { describe, expect, it } from 'vitest';
import { generateSchedule, shrink, type ScheduleOp } from '../../cosignal-oracle/src/schedule.js';
import { diffAgainstModelTolerant, engineAsAdapter } from './oracle-adapter.js';

const CI_SEEDS = 300;
const CI_STEPS = 80;
const LONG_SEEDS = 8;
const LONG_STEPS = 400;

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
	const ops = generateSchedule(seed, steps);
	const diff = diffAgainstModelTolerant(engineAsAdapter(), ops, seed);
	if (diff === undefined) return;
	const failing = (candidate: ScheduleOp[]): boolean => diffAgainstModelTolerant(engineAsAdapter(), candidate) !== undefined;
	const shrunk = shrink(ops, failing);
	const finalDiff = diffAgainstModelTolerant(engineAsAdapter(), shrunk);
	expect.fail(
		`seed ${seed} diverged at step ${diff.step}: ${diff.message}\n` +
		`shrunk schedule (${shrunk.length} ops): ${JSON.stringify(shrunk)}\n` +
		`shrunk divergence: step ${finalDiff?.step}: ${finalDiff?.message}`,
	);
}

describe('LOGGED engine vs oracle (diffAgainstModel, step-by-step)', () => {
	it('smoke: seeds 1..5 diff clean', () => {
		for (let seed = 1; seed <= 5; seed++) expectSeedDiffClean(seed, CI_STEPS);
	});

	it(`${CI_SEEDS} seeds × ${CI_STEPS} steps diff clean`, () => {
		for (let seed = 1; seed <= CI_SEEDS; seed++) expectSeedDiffClean(seed, CI_STEPS);
	});

	it(`${LONG_SEEDS} long seeds × ${LONG_STEPS} steps (episode churn: recycle, renumber, backstop)`, () => {
		for (let seed = 9001; seed < 9001 + LONG_SEEDS; seed++) expectSeedDiffClean(seed, LONG_STEPS);
	});

	it('the flag-5 finding seeds (29, 97, 173) diff clean', () => {
		// The schedules that first exposed the mount-fixup fast-out corner covered
		// by the "flag 5" tests (logged-flags.spec.ts) — pinned so it can never
		// silently regress.
		for (const seed of [29, 97, 173]) expectSeedDiffClean(seed, CI_STEPS);
	});
});
