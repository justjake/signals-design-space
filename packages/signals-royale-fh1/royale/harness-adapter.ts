/** FrameworkAdapter for the shared conformance harness. */
import {
	atom,
	computed,
	effect,
	effectScope,
	startBatch,
	endBatch,
	untracked,
} from '../src/index';

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
	name: 'signals-royale-fh1',
	signal<T>(initialValue: T): AdapterSignal<T> {
		const a = atom(initialValue);
		return { read: () => a.get(), write: (v) => a.set(v) };
	},
	computed<T>(fn: () => T): AdapterComputed<T> {
		const c = computed(fn);
		return { read: () => c.get() };
	},
	effect,
	effectScope,
	startBatch,
	endBatch,
	untracked,
};

export default adapter;
