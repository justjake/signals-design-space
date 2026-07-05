/**
 * The engine adapter interface (spec §8 "every engine milestone diffs
 * against it"). A future engine plugs into the fuzz harness by implementing
 * this surface; the harness replays the same schedule into the engine and
 * the naive model and diffs every observable after every step.
 *
 * The comparable surface is deliberately the OBSERVABLE one:
 *   - values: read(node, world) for the newest world, every open pass world,
 *     and committed-for-root(r) for every root;
 *   - deliveries: the value-blind watcher setState decisions, in order, with
 *     their {watcher, token, slot} attribution (§5.9);
 *   - corrections: reconcile / mount correctives / urgent fixups (§5.3, §5.10);
 *   - committed values at quiescence.
 * Engine internals (memos, touched words, K1 records) are never compared —
 * they are free to be clever as long as the observables agree.
 */

import { CosignalModel, type ModelEvent, type Value } from './model.js';
import { applyOneOp, buildTopology, type ScheduleOp } from './schedule.js';

/** Event kinds an engine must reproduce 1:1, in order. Others are model-internal. */
const COMPARED_EVENTS: ModelEvent['type'][] = [
	'delivery',
	'suppressed',
	'reconcile-correction',
	'mount-corrective',
	'mount-urgent-correction',
	'per-root-commit',
	'retired',
	'core-effect-run',
	'react-effect-run',
];

export type ObservableSnapshot = {
	/** node name → value, for newest and committed-per-root worlds. */
	newest: Record<string, Value>;
	committed: Record<string, Record<string, Value>>; // root → node → value
	/** open pass id → node → value. */
	passes: Record<string, Record<string, Value>>;
};

export type EngineAdapter = {
	/** Apply one schedule op. Throwing a ScheduleError-equivalent skips it (must match the model's legality). */
	apply(op: ScheduleOp): 'applied' | 'skipped';
	/** The observable world values right now. */
	snapshot(): ObservableSnapshot;
	/** Comparable events emitted since the last call (same shapes as ModelEvent). */
	drainEvents(): ModelEvent[];
};

export function snapshotModel(m: CosignalModel): ObservableSnapshot {
	const newest: Record<string, Value> = {};
	const committed: Record<string, Record<string, Value>> = {};
	const passes: Record<string, Record<string, Value>> = {};
	for (const n of m.nodes.values()) newest[n.name] = m.newestValue(n);
	for (const root of m.roots.keys()) {
		committed[root] = {};
		for (const n of m.nodes.values()) committed[root]![n.name] = m.committedValue(n, root);
	}
	for (const p of m.passes.values()) {
		if (p.state === 'ended') continue;
		passes[String(p.id)] = {};
		for (const n of m.nodes.values()) passes[String(p.id)]![n.name] = m.passValue(n, p);
	}
	return { newest, committed, passes };
}

export function comparableEvents(events: ModelEvent[]): ModelEvent[] {
	return events.filter((e) => COMPARED_EVENTS.includes(e.type));
}

export type DiffResult = { seed: number | undefined; step: number; message: string } | undefined;

/**
 * Replay `ops` into the engine and the naive model side by side; return the
 * first observable divergence (or undefined). This is the harness a real
 * engine build wires into CI; `modelAsEngine` below is its self-test.
 */
export function diffAgainstModel(engine: EngineAdapter, ops: ScheduleOp[], seed?: number): DiffResult {
	const reference = runScheduleStepwise(ops);
	for (let step = 0; step < ops.length; step++) {
		const expected = reference[step]!;
		const applied = engine.apply(ops[step]!);
		if (applied !== expected.applied) {
			return { seed, step, message: `legality diverged: engine ${applied}, model ${expected.applied}` };
		}
		const snap = JSON.stringify(engine.snapshot());
		if (snap !== expected.snapshot) {
			return { seed, step, message: `snapshot diverged:\nengine ${snap}\nmodel  ${expected.snapshot}` };
		}
		const events = JSON.stringify(comparableEvents(engine.drainEvents()));
		if (events !== expected.events) {
			return { seed, step, message: `events diverged:\nengine ${events}\nmodel  ${expected.events}` };
		}
	}
	return undefined;
}

type StepRecord = { applied: 'applied' | 'skipped'; snapshot: string; events: string };

function runScheduleStepwise(ops: ScheduleOp[]): StepRecord[] {
	const m = new CosignalModel();
	buildTopology(m);
	m.registerBridge();
	let drained = 0;
	return ops.map((op) => {
		const ok = applyOneOp(m, op);
		const events = comparableEvents(m.events.slice(drained));
		drained = m.events.length;
		return {
			applied: ok ? 'applied' as const : 'skipped' as const,
			snapshot: JSON.stringify(snapshotModel(m)),
			events: JSON.stringify(events),
		};
	});
}

/**
 * The self-test adapter: a second copy of the naive model presented through
 * the engine interface. Proves the diff harness accepts a conforming engine
 * (and is the template a real engine adapter replaces).
 */
export function modelAsEngine(): EngineAdapter {
	const m = new CosignalModel();
	buildTopology(m);
	m.registerBridge();
	let drained = 0;
	return {
		apply: (op) => (applyOneOp(m, op) ? 'applied' : 'skipped'),
		snapshot: () => snapshotModel(m),
		drainEvents() {
			const out = comparableEvents(m.events.slice(drained));
			drained = m.events.length;
			return out;
		},
	};
}
