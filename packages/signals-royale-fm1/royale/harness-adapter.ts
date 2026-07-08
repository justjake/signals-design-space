/** FrameworkAdapter for the shared conformance harness. */
import {
	atom,
	computed,
	effect,
	effectScope,
	endBatch,
	startBatch,
	untracked,
} from '../src/index.ts';

export interface AdapterSignal<T> {
	read(): T;
	write(value: T): void;
}
export interface AdapterComputed<T> {
	read(): T;
}
export interface FrameworkAdapter {
	name: string;
	signal<T>(initialValue: T): AdapterSignal<T>;
	computed<T>(fn: () => T): AdapterComputed<T>;
	effect(fn: () => void | (() => void)): () => void;
	effectScope(fn: () => void): () => void;
	startBatch(): void;
	endBatch(): void;
	untracked<T>(fn: () => T): T;
}

const adapter: FrameworkAdapter = {
	name: 'signals-royale-fm1',
	signal<T>(initialValue: T): AdapterSignal<T> {
		const a = atom(initialValue);
		return { read: () => a.get(), write: (v: T) => a.set(v) };
	},
	computed<T>(fn: () => T): AdapterComputed<T> {
		const c = computed(fn);
		return { read: () => c.get() };
	},
	effect(fn) {
		return effect(fn);
	},
	effectScope(fn) {
		return effectScope(fn);
	},
	startBatch,
	endBatch,
	untracked,
};

export default adapter;
