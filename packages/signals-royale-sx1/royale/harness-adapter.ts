import { atom, computed, effect, effectScope, endBatch, startBatch, untracked } from '../src/index.js';

export interface AdapterSignal<T> { read(): T; write(value: T): void }
export interface AdapterComputed<T> { read(): T }
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
	name: 'signals-royale-sx1',
	signal(initialValue) {
		const value = atom(initialValue);
		return { read: () => value.read(), write: next => value.set(next) };
	},
	computed(fn) {
		const value = computed(fn);
		return { read: () => value.read() };
	},
	effect,
	effectScope,
	startBatch,
	endBatch,
	untracked,
};

export default adapter;
