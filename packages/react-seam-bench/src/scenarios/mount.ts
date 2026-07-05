/**
 * Mount cost: time from render() to the first committed 5000-cell tree,
 * the median of 5 fresh roots (fresh store and fresh container each, with
 * teardown drained between so one root's debounced cleanup never bills the
 * next root's timing).
 */
import type { Scenario } from './scenario.js';
import { drain, median, renderCells, until } from './support.js';

const N = 5000;
const ROOTS = 5;

const mount: Scenario = {
	name: 'mount',
	async run(contender, report) {
		const times: number[] = [];
		for (let r = 0; r < ROOTS; r++) {
			const store = contender.createCells(N);
			const t0 = performance.now();
			const tree = renderCells(store, N);
			await until(() => tree.readCell(N - 1) === '0', `mount root ${r}`);
			times.push(performance.now() - t0);
			await tree.unmount();
			store.dispose();
			await drain();
		}

		const sorted = [...times].sort((a, b) => a - b);
		report(median(times), {
			roots: ROOTS,
			minMs: Number(sorted[0].toFixed(2)),
			maxMs: Number(sorted[sorted.length - 1].toFixed(2)),
		});
	},
};

export default mount;
