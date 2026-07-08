import { atom, batch, computed, effect, effectScope } from '../src/index';

type Cell = ReturnType<typeof atom<unknown>> | ReturnType<typeof computed<unknown>>;
let disposeScope: (() => void) | undefined;

export default {
	name: 'Royale SH1',
	createSignal: (value: unknown) => atom(value),
	readSignal: (cell: Cell) => cell.state,
	writeSignal: (cell: Cell, value: unknown) => (cell as ReturnType<typeof atom<unknown>>).set(value),
	createComputed: (fn: () => unknown) => computed(fn),
	readComputed: (cell: Cell) => cell.state,
	effect: (fn: () => void) => { effect(fn); },
	withBatch: (fn: () => void) => { batch(fn); },
	withBuild<T>(fn: () => T): T {
		let value!: T;
		disposeScope = effectScope(() => { value = fn(); });
		return value;
	},
	cleanup: () => { disposeScope?.(); disposeScope = undefined; },
};
