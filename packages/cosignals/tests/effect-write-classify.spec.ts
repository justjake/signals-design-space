/**
 * THE R-3 PIN — effect writes observed during the fused eager apply
 * CLASSIFY NORMALLY. A core `effect()` is a kernel subscriber: it runs
 * inside the kernel flush that the engine's eager apply triggers, i.e. in
 * the MIDDLE of the recording write's own operation. Its writes used to
 * silently bypass recording (the old recursion guard waved the whole flush
 * through the plain path — a latent bug, reproduced in review); the merge
 * fixed it: there is no recursion guard, the direct kernel apply's flush
 * re-enters the PUBLIC write path, and the effect's write takes the
 * ordinary classified arms — the ambient default batch while anything is
 * pending, the quiet fold at rest.
 *
 * The corpus checks the same semantics continuously through the model's
 * writing-core-effect vocabulary (schedule.ts 'coreEffectWrite'); this file
 * is the hand pin.
 */
import { describe, expect, it } from 'vitest';
import { Atom, effect, engine, __resetEngineForTest } from '../src/index.js';

function freshEngine(): void {
	engine.discardAllWip();
	for (const t of engine.liveBatches()) {
		if (t.parked) engine.settleAction(t.id);
		else engine.retire(t.id);
	}
	__resetEngineForTest();
}

describe('R-3: effect writes during the fused apply classify normally', () => {
	it('a live batch pending: the effect write RECORDS into the ambient default batch', () => {
		freshEngine();
		const src = engine.atom('src', 0);
		const out = engine.atom('out', 0);
		let runs = 0;
		const dispose = effect(() => {
			const v = src.handle.state as number;
			if (runs++ === 0) return; // mount baseline
			(out.handle as Atom<number>).set(v * 10); // the effect's write, mid-fused-apply
		});
		const t = engine.openBatch();
		engine.write(t.id, src, 0, 1); // the eager apply flushes the effect INSIDE this op
		// The effect's write RECORDED: a log entry exists, attributed to the
		// ambient default batch (the effect had no batch context of its own).
		const ambient = engine.ambientBatch;
		expect(ambient).toBeDefined();
		expect(out.log.materialize()).toHaveLength(1);
		expect(out.log.materialize()[0]!.op).toEqual({ kind: 'set', value: 10 });
		expect(out.log.materialize()[0]!.batch).toBe(ambient);
		expect(engine.newestValue(out)).toBe(10); // and applied eagerly, like any recorded write
		// Not committed yet — the recorded semantics are real, not a bypass:
		expect(engine.committedValue(out, 'A')).toBe(0);
		engine.retire(ambient!);
		expect(engine.committedValue(out, 'A')).toBe(10);
		engine.retire(t.id);
		dispose();
	});

	it('nothing pending: the effect write takes the quiet fold (no batch materializes)', () => {
		freshEngine();
		const src = engine.atom('src2', 0);
		const out = engine.atom('out2', 0);
		let runs = 0;
		const dispose = effect(() => {
			const v = src2read();
			if (runs++ === 0) return;
			(out.handle as Atom<number>).set(v * 10);
		});
		function src2read(): number {
			return src.handle.state as number;
		}
		(src.handle as Atom<number>).set(2); // quiet fold → kernel flush → effect writes
		expect(engine.ambientBatch).toBeUndefined(); // no batch materialized anywhere
		expect(out.log.materialize()).toHaveLength(0); // the nested write folded quietly too
		expect(engine.newestValue(out)).toBe(20);
		expect(engine.committedValue(out, 'A')).toBe(20); // committed truth advanced with it
		dispose();
	});
});
