/**
 * Adapter for upstream alien-signals v3.2.1 (the reference implementation).
 * Installed via "file:../upstream-alien-signals" (prebuilt esm/ + types/).
 */
import {
	computed,
	effect,
	effectScope,
	endBatch,
	setActiveSub,
	signal,
	startBatch,
} from 'alien-signals';
import type { FrameworkAdapter } from './types';

const adapter: FrameworkAdapter = {
	name: 'alien-v3',
	signal(initialValue) {
		const s = signal(initialValue);
		return {
			read: () => s(),
			write: (v) => s(v),
		};
	},
	computed(fn) {
		const c = computed(fn);
		return { read: () => c() };
	},
	effect,
	effectScope,
	startBatch,
	endBatch,
	untracked<T>(fn: () => T): T {
		const prev = setActiveSub(undefined);
		try {
			return fn();
		} finally {
			setActiveSub(prev);
		}
	},
};

export default adapter;
