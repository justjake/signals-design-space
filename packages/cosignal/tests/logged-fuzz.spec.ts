/**
 * Engine-vs-oracle differential fuzzing (spec §8; task gate "full corpus zero
 * diffs"): replay identical seeded schedules into the LOGGED engine and the
 * naive model side by side via the oracle's own `diffAgainstModel`, which
 * compares — after EVERY step — op legality, the full observable snapshot
 * (newest / committed-per-root / every open pass world), and the comparable
 * event stream (deliveries, suppressions, corrections, commits, retirements,
 * effect runs). Corpus: the oracle's CI scale (300 seeds × 80 steps) plus the
 * 8 long episode-churn seeds × 400 steps.
 *
 * Every failure prints its seed and a shrunk schedule (the oracle's greedy
 * op-removal shrinker, re-run against a FRESH engine per candidate).
 */
import { describe, expect, it } from 'vitest';
import { diffAgainstModel } from '../../cosignal-oracle/src/adapter.js';
import { generateSchedule, shrink, type ScheduleOp } from '../../cosignal-oracle/src/schedule.js';
import { engineAsAdapter } from './oracle-adapter.js';

const CI_SEEDS = 300;
const CI_STEPS = 80;
const LONG_SEEDS = 8;
const LONG_STEPS = 400;

/** Diff one schedule against a fresh engine; on failure, shrink and throw loudly. */
function expectSeedDiffClean(seed: number, steps: number): void {
	const ops = generateSchedule(seed, steps);
	const diff = diffAgainstModel(engineAsAdapter(), ops, seed);
	if (diff === undefined) return;
	const failing = (candidate: ScheduleOp[]): boolean => diffAgainstModel(engineAsAdapter(), candidate) !== undefined;
	const shrunk = shrink(ops, failing);
	const finalDiff = diffAgainstModel(engineAsAdapter(), shrunk);
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
		// tests/FLAGS.md: the schedules that forced the §5.10 errata.
		for (const seed of [29, 97, 173]) expectSeedDiffClean(seed, CI_STEPS);
	});
});
