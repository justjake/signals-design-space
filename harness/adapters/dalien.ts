/**
 * Adapter for packages/dalien-signals (the fork being optimized). Imports the
 * TypeScript SOURCE directly (not the built esm/) so benches always reflect
 * the working tree; the bench child esbuild-bundles it like every lab lib.
 */
import {
	computed,
	effect,
	effectScope,
	endBatch,
	setActiveSub,
	signal,
	startBatch,
} from '../../packages/dalien-signals/src/index.js';
import type { FrameworkAdapter } from './types';

const adapter: FrameworkAdapter = {
	name: 'dalien',
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
