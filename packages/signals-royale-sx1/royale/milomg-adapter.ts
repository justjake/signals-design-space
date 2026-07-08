import { atom, batch, computed, effect, effectScope } from '../src/index.js';

export interface ReactiveFramework<S = unknown> {
	name: string;
	createSignal(initialValue: unknown): S;
	readSignal(signal: S): unknown;
	writeSignal(signal: S, value: unknown): void;
	createComputed(fn: () => unknown): S;
	readComputed(cell: S): unknown;
	effect(fn: () => void): void;
	withBatch(fn: () => void): void;
	withBuild<T>(fn: () => T): T;
	cleanup(): void;
}

type Cell = ReturnType<typeof atom<unknown>> | ReturnType<typeof computed<unknown>>;
let dispose: (() => void) | undefined;

const adapter: ReactiveFramework<Cell> = {
	name: 'Royale SX1',
	createSignal: atom,
	readSignal: value => value.read(),
	writeSignal(value, next) {
		if ('set' in value) value.set(next);
	},
	createComputed: computed,
	readComputed: value => value.read(),
	effect(fn) {
		effect(fn);
	},
	withBatch: batch,
	withBuild(fn) {
		let result!: ReturnType<typeof fn>;
		dispose = effectScope(() => {
			result = fn();
		});
		return result;
	},
	cleanup() {
		dispose?.();
		dispose = undefined;
	},
};

export default adapter;
