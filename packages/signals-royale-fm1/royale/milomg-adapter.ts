/** ReactiveFramework adapter for the milomg js-reactivity-benchmark. */
import {
	Atom,
	Computed,
	atom,
	batch,
	computed,
	effect,
	effectScope,
} from '../src/index.ts';

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

type Node = Atom<unknown> | Computed<unknown>;

let disposeScope: (() => void) | null = null;

export const royaleFm1Framework: ReactiveFramework<Node> = {
	name: 'Royale FM1',
	createSignal: (initialValue) => atom(initialValue),
	readSignal: (signal) => (signal as Atom<unknown>).get(),
	writeSignal: (signal, value) => (signal as Atom<unknown>).set(value),
	createComputed: (fn) => computed(fn),
	readComputed: (cell) => (cell as Computed<unknown>).get(),
	effect: (fn) => {
		effect(fn);
	},
	withBatch: (fn) => {
		batch(fn);
	},
	withBuild<T>(fn: () => T): T {
		let result!: T;
		disposeScope = effectScope(() => {
			result = fn();
		});
		return result;
	},
	cleanup() {
		if (disposeScope !== null) {
			disposeScope();
			disposeScope = null;
		}
	},
};

export default royaleFm1Framework;
