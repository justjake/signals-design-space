// M0 — fork test double: protocol-surface conformance (spec §6, §17.7 shape).
import { describe, expect, it } from 'vitest';
import { ForkDouble } from '../src/fork';

describe('ForkDouble: batch tokens (§6.2)', () => {
	it('encodes tokens as (serial << 1) | deferredBit, nonzero', () => {
		const f = new ForkDouble();
		const t1 = f.openBatch(true);
		const t2 = f.openBatch(false);
		expect(t1 & 1).toBe(1);
		expect(t2 & 1).toBe(0);
		expect(t1).not.toBe(0);
		expect(t2).not.toBe(0);
		expect(t2 >> 1).toBe((t1 >> 1) + 1); // serials increment
	});

	it('never reuses a serial while live and enforces the 31-live cap', () => {
		const f = new ForkDouble();
		const seen = new Set<number>();
		for (let i = 0; i < 31; ++i) {
			const t = f.openBatch(i % 2 === 0);
			expect(seen.has(t)).toBe(false);
			seen.add(t);
		}
		expect(() => f.openBatch(true)).toThrow(/31/);
	});

	it('retires exactly once, ever', () => {
		const f = new ForkDouble();
		const t = f.openBatch(true);
		const retired: Array<[number, boolean]> = [];
		f.subscribeToExternalRuntime({
			onBatchRetired: (token, committed) => retired.push([token, committed]),
		});
		f.retireBatch(t, false);
		expect(retired).toEqual([[t, false]]);
		expect(() => f.retireBatch(t, false)).toThrow(/twice/);
	});

	it('emits the onBatchOpened gate edge at claim/mint', () => {
		const f = new ForkDouble();
		const opened: number[] = [];
		f.subscribeToExternalRuntime({ onBatchOpened: (t) => opened.push(t) });
		const t = f.openBatch(true);
		expect(opened).toEqual([t]);
	});
});

describe('ForkDouble: write classification and attribution (§6.4)', () => {
	it('classifies writes by the innermost batch context', () => {
		const f = new ForkDouble();
		const d = f.openBatch(true);
		const u = f.openBatch(false);
		expect(f.isCurrentWriteDeferred()).toBe(false);
		f.inBatch(d, () => {
			expect(f.isCurrentWriteDeferred()).toBe(true);
			expect(f.getCurrentWriteBatch()).toBe(d);
			f.inBatch(u, () => {
				expect(f.isCurrentWriteDeferred()).toBe(false);
				expect(f.getCurrentWriteBatch()).toBe(u);
			});
			expect(f.getCurrentWriteBatch()).toBe(d);
		});
	});

	it('mints an ambient urgent token for writes outside any batch', () => {
		const f = new ForkDouble();
		const t = f.getCurrentWriteBatch();
		expect(t & 1).toBe(0);
		expect(f.getCurrentWriteBatch()).toBe(t); // stable while live
		f.retireBatch(t, false);
		const t2 = f.getCurrentWriteBatch();
		expect(t2).not.toBe(t); // re-minted after retirement
	});
});

describe('ForkDouble: render passes, yields, lineage (§6.3)', () => {
	it('delivers start/yield/resume/end with strict alternation', () => {
		const f = new ForkDouble();
		const log: string[] = [];
		f.subscribeToExternalRuntime({
			onRenderPassStart: (c, inc, lin) => log.push(`start:${String(c)}:${inc.join(',')}:${lin}`),
			onRenderPassYield: (c) => log.push(`yield:${String(c)}`),
			onRenderPassResume: (c) => log.push(`resume:${String(c)}`),
			onRenderPassEnd: (c) => log.push(`end:${String(c)}`),
		});
		const t = f.openBatch(true);
		f.startRenderPass('rootA', [t], 7);
		expect(f.getRenderContext()).toEqual({ container: 'rootA' });
		f.yieldPass();
		expect(f.getRenderContext()).toBeUndefined(); // yield gap ≠ render
		expect(() => f.yieldPass()).toThrow(/alternation/);
		f.resumePass();
		expect(() => f.resumePass()).toThrow(/alternation/);
		f.endRenderPass();
		expect(f.getRenderContext()).toBeUndefined();
		expect(log).toEqual([
			`start:rootA:${t}:7`,
			'yield:rootA',
			'resume:rootA',
			'end:rootA',
		]);
	});

	it('one pass at a time; restart preserves lineage and re-delivers includes', () => {
		const f = new ForkDouble();
		const starts: Array<[readonly number[], number]> = [];
		f.subscribeToExternalRuntime({
			onRenderPassStart: (_c, inc, lin) => starts.push([inc, lin]),
		});
		const t1 = f.openBatch(true);
		f.startRenderPass('root', [t1], 3);
		expect(() => f.startRenderPass('root2', [])).toThrow(/already open/);
		const t2 = f.openBatch(true);
		f.restartRenderPass([t1, t2]);
		f.endRenderPass();
		expect(starts).toEqual([
			[[t1], 3],
			[[t1, t2], 3], // same lineage across the restart
		]);
	});
});

describe('ForkDouble: entanglement (§6.5)', () => {
	it('runs fn in the batch context while live; false after retirement', () => {
		const f = new ForkDouble();
		const t = f.openBatch(true);
		let sawDeferred = false;
		let sawToken = 0;
		const ok = f.runInBatch(t, () => {
			sawDeferred = f.isCurrentWriteDeferred();
			sawToken = f.getCurrentWriteBatch();
		});
		expect(ok).toBe(true);
		expect(sawDeferred).toBe(true);
		expect(sawToken).toBe(t);
		f.retireBatch(t, true);
		let ran = false;
		const ok2 = f.runInBatch(t, () => {
			ran = true;
		});
		expect(ok2).toBe(false);
		expect(ran).toBe(false);
		expect(f.entangleLog).toEqual([
			{ token: t, ran: true },
			{ token: t, ran: false },
		]);
	});
});

describe('ForkDouble: per-root commits and retirement ordering (§6.1)', () => {
	it('onBatchCommitted fires exactly once per (token, root), before final retirement', () => {
		const f = new ForkDouble();
		const log: string[] = [];
		f.subscribeToExternalRuntime({
			onBatchCommitted: (c, t) => log.push(`commit:${String(c)}:${t}`),
			onBatchRetired: (t, committed) => log.push(`retire:${t}:${committed}`),
		});
		const t = f.openBatch(true);
		f.commitBatchOnRoot('A', t);
		expect(() => f.commitBatchOnRoot('A', t)).toThrow(/exactly once/);
		f.retireBatch(t, undefined, 'B'); // final root B commits, then retires
		expect(log).toEqual([`commit:A:${t}`, `commit:B:${t}`, `retire:${t}:true`]);
	});

	it('quiescence: no live batches, no open pass', () => {
		const f = new ForkDouble();
		expect(f.isQuiescent()).toBe(true);
		const t = f.openBatch(true);
		expect(f.isQuiescent()).toBe(false);
		f.startRenderPass('root', [t]);
		f.endRenderPass();
		expect(f.isQuiescent()).toBe(false);
		f.retireBatch(t, true);
		expect(f.isQuiescent()).toBe(true);
	});
});

describe('ForkDouble: mutation window (§6.6)', () => {
	it('brackets the scripted window', () => {
		const f = new ForkDouble();
		const log: string[] = [];
		f.subscribeToExternalRuntime({
			onBeforeMutation: (c) => log.push(`before:${String(c)}`),
			onAfterMutation: (c) => log.push(`after:${String(c)}`),
		});
		f.mutationWindow('root', () => log.push('mutate'));
		expect(log).toEqual(['before:root', 'mutate', 'after:root']);
	});
});
