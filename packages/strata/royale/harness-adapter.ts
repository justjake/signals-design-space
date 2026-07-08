import {
	atom,
	computed,
	effect,
	effectScope,
	endBatch,
	startBatch,
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
	name: 'strata-signals',
	signal(initialValue) {
		const signal = atom(initialValue);
		return {
			read: () => signal.state,
			write: (value) => signal.set(value),
		};
	},
	computed(fn) {
		const value = computed(fn);
		return { read: () => value.state };
	},
	effect,
	effectScope,
	startBatch,
	endBatch,
	untracked,
};

export default adapter;
