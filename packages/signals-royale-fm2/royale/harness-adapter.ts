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
	name: 'signals-royale-fm2',
	signal<T>(initialValue: T): AdapterSignal<T> {
		// A function-valued initial would read as a lazy initializer; wrap it
		// so the function itself is the stored value.
		const a = atom<T>(typeof initialValue === 'function' ? () => initialValue : initialValue);
		return { read: () => a.get(), write: (v) => a.set(v) };
	},
	computed<T>(fn: () => T): AdapterComputed<T> {
		const c = computed<T>(fn);
		return { read: () => c.get() };
	},
	effect,
	effectScope,
	startBatch,
	endBatch,
	untracked,
};

export default adapter;
