/**
 * ReactiveFramework adapter for the milomg js-reactivity-benchmark.
 */
import { atom, computed, effect, effectScope, batch, read, set, type Atom, type Computed } from '../src/index';

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

let disposeScope: (() => void) | null = null;

export const royaleFh2Framework: ReactiveFramework = {
	name: 'Royale FH2',
	createSignal: (initialValue) => atom(initialValue),
	readSignal: (signal) => read(signal as Atom<unknown>),
	writeSignal: (signal, value) => set(signal as Atom<unknown>, value),
	createComputed: (fn) => computed(fn),
	readComputed: (cell) => read(cell as Computed<unknown>),
	effect: (fn) => {
		effect(fn);
	},
	withBatch: (fn) => {
		batch(fn);
	},
	withBuild: <T,>(fn: () => T): T => {
		let out!: T;
		disposeScope = effectScope(() => {
			out = fn();
		});
		return out;
	},
	cleanup: () => {
		if (disposeScope !== null) {
			disposeScope();
			disposeScope = null;
		}
	},
};

export default royaleFh2Framework;
