/** ReactiveFramework adapter for the milomg js-reactivity-benchmark. */
import {
	atom,
	computed,
	batch,
	EffectNode,
	EffectScope,
	type Atom,
	type Computed,
} from '../src/index';

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

let buildScope: EffectScope | null = null;

export const royaleFm2Framework: ReactiveFramework = {
	name: 'Royale FM2',
	createSignal: (initialValue) =>
		atom(typeof initialValue === 'function' ? () => initialValue : initialValue),
	readSignal: (signal) => (signal as Atom<unknown>).get(),
	writeSignal: (signal, value) => (signal as Atom<unknown>).set(value),
	createComputed: (fn) => computed(fn),
	readComputed: (cell) => (cell as Computed<unknown>).get(),
	effect(fn) {
		new EffectNode(fn);
	},
	withBatch: (fn) => batch(fn),
	withBuild<T>(fn: () => T): T {
		buildScope = new EffectScope();
		return buildScope.run(fn);
	},
	cleanup() {
		buildScope?.dispose();
		buildScope = null;
	},
};

export default royaleFm2Framework;
