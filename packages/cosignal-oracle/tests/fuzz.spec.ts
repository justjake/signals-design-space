/**
 * The randomized referee run:
 *  - N seeded schedules, self-check invariants after EVERY applied step;
 *  - per-seed determinism: the same schedule replayed twice must produce a
 *    byte-identical observable fingerprint (events + all world values);
 *  - long walks for episode-lifecycle churn (quiescence, epoch reset, recycling).
 *
 * Every failure prints its seed and a shrunk schedule (see expectSeedClean).
 * Reproduce locally with: `fuzzSeed(<seed>, <steps>)` — see README.md.
 */
import { describe, expect, it } from 'vitest';
import { diffAgainstModel, modelAsEngine } from '../src/adapter.js';
import { expectSeedClean, fingerprint, generateSchedule, runSchedule } from '../src/schedule.js';

const CI_SEEDS = 300;
const CI_STEPS = 80;
const DOUBLE_RUN_SEEDS = 100;
const LONG_SEEDS = 8;
const LONG_STEPS = 400;

describe('randomized schedules against the naive model', () => {
	it(`${CI_SEEDS} seeds × ${CI_STEPS} steps hold every invariant at every step`, () => {
		for (let seed = 1; seed <= CI_SEEDS; seed++) {
			expectSeedClean(seed, CI_STEPS);
		}
	});

	it(`${LONG_SEEDS} long seeds × ${LONG_STEPS} steps (episode churn: recycle, epoch reset, backstop)`, () => {
		for (let seed = 9001; seed < 9001 + LONG_SEEDS; seed++) {
			expectSeedClean(seed, LONG_STEPS);
		}
	});

	it(`determinism: ${DOUBLE_RUN_SEEDS} seeds double-run to identical fingerprints`, () => {
		for (let seed = 1; seed <= DOUBLE_RUN_SEEDS; seed++) {
			const ops = generateSchedule(seed, CI_STEPS);
			const a = fingerprint(runSchedule(ops, false));
			const b = fingerprint(runSchedule(ops, false));
			expect(a, `seed ${seed} fingerprints diverged`).toBe(b);
		}
	});

	it('adapter self-test: a conforming engine (the model itself) diffs clean on 25 seeds', () => {
		for (let seed = 1; seed <= 25; seed++) {
			const ops = generateSchedule(seed, CI_STEPS);
			const diff = diffAgainstModel(modelAsEngine(), ops, seed);
			expect(diff, diff === undefined ? '' : `seed ${seed} step ${diff.step}: ${diff.message}`).toBeUndefined();
		}
	});

	it('coverage: the generated corpus actually exercises the interesting machinery', () => {
		const totals = {
			deliveries: 0, interleaved: 0, suppressed: 0, corrective: 0, urgentFix: 0,
			reconcile: 0, retires: 0, perRoot: 0, epochs: 0, drops: 0,
			released: 0, claimed: 0,
		};
		for (let seed = 1; seed <= 60; seed++) {
			const r = runSchedule(generateSchedule(seed, CI_STEPS), false);
			const m = r.model;
			totals.deliveries += m.eventsOfType('delivery').length;
			totals.interleaved += m.eventsOfType('delivery').filter((e) => e.mode === 'interleaved').length;
			totals.suppressed += m.eventsOfType('suppressed').length;
			totals.corrective += m.eventsOfType('mount-corrective').length;
			totals.urgentFix += m.eventsOfType('mount-urgent-correction').length;
			totals.reconcile += m.eventsOfType('reconcile-correction').length;
			totals.retires += m.eventsOfType('retired').length;
			totals.perRoot += m.eventsOfType('per-root-commit').length;
			totals.epochs += m.eventsOfType('epoch-reset').length;
			totals.drops += m.eventsOfType('write-dropped').length;
			totals.released += m.eventsOfType('slot-released').length;
			totals.claimed += m.eventsOfType('slot-claimed').length;
		}
		for (const [key, count] of Object.entries(totals)) {
			expect(count, `corpus never hit: ${key}`).toBeGreaterThan(0);
		}
	});
});
