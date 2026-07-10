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
import { describe, expect, it } from 'vitest'
import { diffAgainstModel, modelAsEngine } from '../src/adapter.js'
import {
	expectSeedClean,
	fingerprint,
	generateSchedule,
	runSchedule,
	type ScheduleOp,
} from '../src/schedule.js'
import frozen from './frozen-schedules.json'

/** Frozen finding-seed schedules (captured before the writing-core-effect /
 * custom-equals generator bands landed — see the engine-side fuzz spec). */
const FROZEN = frozen as Record<string, ScheduleOp[]>

const CI_SEEDS = 300
const CI_STEPS = 80
const DOUBLE_RUN_SEEDS = 100
const LONG_SEEDS = 8
const LONG_STEPS = 400

describe('randomized schedules against the naive model', () => {
	it(`${CI_SEEDS} seeds × ${CI_STEPS} steps hold every invariant at every step`, () => {
		for (let seed = 1; seed <= CI_SEEDS; seed++) {
			expectSeedClean(seed, CI_STEPS)
		}
	})

	it(`${LONG_SEEDS} long seeds × ${LONG_STEPS} steps (episode churn: recycle, epoch reset, backstop) — FROZEN literals + fresh regenerations`, () => {
		for (let seed = 9001; seed < 9001 + LONG_SEEDS; seed++) {
			const ops = FROZEN[`s${seed}x400`]!
			const r = runSchedule(ops, true)
			if (r.failure !== undefined) {
				throw new Error(
					`frozen seed ${seed} failed at step ${r.failure.step}: ${r.failure.error.message}`,
				)
			}
			expectSeedClean(seed, LONG_STEPS) // and the regenerated schedule (new bands included)
		}
	})

	it(`determinism: ${DOUBLE_RUN_SEEDS} seeds double-run to identical fingerprints`, () => {
		for (let seed = 1; seed <= DOUBLE_RUN_SEEDS; seed++) {
			const ops = generateSchedule(seed, CI_STEPS)
			const a = fingerprint(runSchedule(ops, false))
			const b = fingerprint(runSchedule(ops, false))
			expect(a, `seed ${seed} fingerprints diverged`).toBe(b)
		}
	})

	// [SANCTIONED CO-EVOLUTION: converged-terminal referee, review finding #8]
	// The converged committed terminal's regression pins: the naive model must
	// hold every invariant while it drives the two wave-1 scenarios (bug 1 — a
	// core/quiet-path write to a terminal's dependency; bug 2 — a terminal body
	// writing a sibling's dependency), and a conforming engine (the model
	// itself) must diff clean over them. The engine-side pin (the pre-fix
	// catch) lives in the CONCURRENT fuzz spec.
	it('converged-terminal pins hold invariants and self-diff clean — FROZEN literals', () => {
		for (const key of ['terminal-bug1-quiet', 'terminal-bug2-quiet']) {
			const ops = FROZEN[key]!
			const r = runSchedule(ops, true)
			expect(r.failure, `${key}: ${r.failure?.error.message ?? ''}`).toBeUndefined()
			expect(
				r.model.eventsOfType('react-effect-run').length,
				`${key} never re-fired the terminal`,
			).toBeGreaterThanOrEqual(2)
			const diff = diffAgainstModel(modelAsEngine(), ops)
			expect(
				diff,
				diff === undefined ? '' : `${key} step ${diff.step}: ${diff.message}`,
			).toBeUndefined()
		}
	})

	it('adapter self-test: a conforming engine (the model itself) diffs clean on 25 seeds', () => {
		for (let seed = 1; seed <= 25; seed++) {
			const ops = generateSchedule(seed, CI_STEPS)
			const diff = diffAgainstModel(modelAsEngine(), ops, seed)
			expect(
				diff,
				diff === undefined ? '' : `seed ${seed} step ${diff.step}: ${diff.message}`,
			).toBeUndefined()
		}
	})

	it('coverage: the generated corpus actually exercises the interesting machinery', () => {
		const totals = {
			deliveries: 0,
			interleaved: 0,
			suppressed: 0,
			corrective: 0,
			urgentFix: 0,
			reconcile: 0,
			retires: 0,
			perRoot: 0,
			epochs: 0,
			drops: 0,
			released: 0,
			claimed: 0,
		}
		for (let seed = 1; seed <= 60; seed++) {
			const r = runSchedule(generateSchedule(seed, CI_STEPS), false)
			const m = r.model
			totals.deliveries += m.eventsOfType('delivery').length
			totals.interleaved += m
				.eventsOfType('delivery')
				.filter((e) => e.mode === 'interleaved').length
			totals.suppressed += m.eventsOfType('suppressed').length
			totals.corrective += m.eventsOfType('mount-corrective').length
			totals.urgentFix += m.eventsOfType('mount-urgent-correction').length
			totals.reconcile += m.eventsOfType('reconcile-correction').length
			totals.retires += m.eventsOfType('retired').length
			totals.perRoot += m.eventsOfType('per-root-commit').length
			totals.epochs += m.eventsOfType('epoch-reset').length
			totals.drops += m.eventsOfType('write-dropped').length
			totals.released += m.eventsOfType('slot-released').length
			totals.claimed += m.eventsOfType('slot-claimed').length
		}
		for (const [key, count] of Object.entries(totals)) {
			expect(count, `corpus never hit: ${key}`).toBeGreaterThan(0)
		}
	})

	it('coverage: the R-2/R-3 bands actually run (custom-equals writes; writing core effects)', () => {
		let qWrites = 0
		let qDrops = 0
		let effectWrites = 0
		for (let seed = 1; seed <= 60; seed++) {
			const ops = generateSchedule(seed, CI_STEPS)
			qWrites += ops.filter((o) => o.t === 'writeQ' || o.t === 'bareWriteQ').length
			const r = runSchedule(ops, true)
			expect(r.failure, `seed ${seed}: ${r.failure?.error.message ?? ''}`).toBeUndefined()
			const m = r.model
			qDrops += m.eventsOfType('write-dropped').filter((e) => e.node === 'q').length
			// A writing core effect leaves observable history on its output atom.
			for (const n of m.idToNode.values()) {
				if ((n.name === 'out1' || n.name === 'out2') && n.kind === 'atom' && m.newestValue(n) !== 0)
					effectWrites++
			}
		}
		expect(qWrites, 'the custom-equals band never emitted').toBeGreaterThan(0)
		expect(qDrops, 'the asymmetric comparator never dropped a write').toBeGreaterThan(0)
		expect(effectWrites, 'no writing core effect ever produced an effective write').toBeGreaterThan(
			0,
		)
	})

	// [SANCTIONED CO-EVOLUTION: converged-terminal referee, review finding #8]
	// The RANDOM corpus must keep DRIVING the converged terminal — this is the
	// guard that keeps the referee from going blind again. It asserts the band
	// mounts terminals and their causes, applies quiet tap triggers, and — the
	// two wave-1 scenarios — that the bug-1 cause (a core writing `sig`) and the
	// bug-2 cause (a terminal body writing `sib`) both actually fire.
	it('coverage: the converged-terminal band drives the terminal (both bug scenarios fire)', () => {
		let mounts = 0
		let tapApplied = 0
		let sigWritten = 0 // bug-1 cause: a core wrote the terminal's dep on the quiet path
		let sibWritten = 0 // bug-2 cause: a terminal body wrote a sibling's dep
		let reFires = 0
		for (let seed = 1; seed <= CI_SEEDS; seed++) {
			const ops = generateSchedule(seed, CI_STEPS)
			mounts += ops.filter(
				(o) => o.t === 'mountTermReader' || o.t === 'mountSibWriter' || o.t === 'mountTapCore',
			).length
			const r = runSchedule(ops, true)
			expect(r.failure, `seed ${seed}: ${r.failure?.error.message ?? ''}`).toBeUndefined()
			const m = r.model
			const quiet = m.eventsOfType('quiet-write')
			tapApplied += quiet.filter((e) => e.node === 'tap').length
			sigWritten += quiet.filter((e) => e.node === 'sig').length
			sibWritten += quiet.filter((e) => e.node === 'sib').length
			reFires += m.eventsOfType('react-effect-run').length
		}
		expect(mounts, 'the terminal band never mounted a terminal or its cause').toBeGreaterThan(0)
		expect(tapApplied, 'no quiet tap trigger ever applied').toBeGreaterThan(0)
		expect(
			sigWritten,
			'bug-1 cause never fired (no core wrote the terminal dep sig)',
		).toBeGreaterThan(0)
		expect(sibWritten, 'bug-2 cause never fired (no terminal body wrote sib)').toBeGreaterThan(0)
		expect(reFires, 'terminals never re-fired').toBeGreaterThan(0)
	})
})
