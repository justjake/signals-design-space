/** ReactiveFramework adapter for the milomg js-reactivity-benchmark. */
import {
	atom,
	computed,
	effect,
	effectScope,
	batch,
	type Atom,
	type Computed,
} from 'signals-royale-fh1';

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

export const royaleFh1Framework: ReactiveFramework = {
	name: 'Royale FH1',
	createSignal: (initialValue) => atom(initialValue),
	readSignal: (signal) => (signal as Atom<unknown>).get(),
	writeSignal: (signal, value) => (signal as Atom<unknown>).set(value),
	createComputed: (fn) => computed(fn),
	readComputed: (cell) => (cell as Computed<unknown>).get(),
	effect: (fn) => void effect(fn),
	withBatch: (fn) => batch(fn),
	withBuild<T>(fn: () => T): T {
		let out!: T;
		disposeScope = effectScope(() => {
			out = fn();
		});
		return out;
	},
	cleanup() {
		if (disposeScope !== null) {
			disposeScope();
			disposeScope = null;
		}
	},
};

export default royaleFh1Framework;
