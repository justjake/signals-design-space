/**
 * Upstream alien-signals consumed through the shared useSyncExternalStore
 * adapter. Store updates through useSyncExternalStore render synchronously
 * even inside React.startTransition (see useReactive.ts) — this contender
 * measures that consumption path, not the library's own scheduler.
 */
import { computed, effect, endBatch, signal, startBatch } from 'alien-signals';
import { startTransition } from 'react';
import type { Contender } from './types.js';
import { makeCells, makeUseCell, type CallableSignalLib } from './useReactive.js';

const lib: CallableSignalLib = {
	signal: (initial) => signal(initial),
	computed: (getter) => computed(getter),
	effect: (fn) => effect(fn),
	startBatch,
	endBatch,
};

const useCell = makeUseCell(lib);

const alienUses: Contender = {
	name: 'alien-uses',
	createCells(n) {
		const { cells, writeCell, writeMany } = makeCells(lib, n);
		return {
			useCell: (i) => useCell(cells[i]),
			writeCell,
			writeMany,
			writeManyInTransition: (updates) => startTransition(() => writeMany(updates)),
			dispose() {},
		};
	},
};

export default alienUses;
