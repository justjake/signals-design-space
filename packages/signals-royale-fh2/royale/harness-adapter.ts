/**
 * FrameworkAdapter for the shared conformance/benchmark harness: wraps the
 * engine's public API in uniform read/write handles.
 */
import { atom, computed, effect, effectScope, startBatch, endBatch, untracked, read, set } from '../src/index';

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
	name: 'signals-royale-fh2',
	signal<T>(initialValue: T) {
		const a = atom(initialValue);
		return {
			read: () => read(a),
			write: (v: T) => set(a, v),
		};
	},
	computed<T>(fn: () => T) {
		const c = computed(fn);
		return { read: () => read(c) };
	},
	effect,
	effectScope,
	startBatch,
	endBatch,
	untracked,
};

export default adapter;
