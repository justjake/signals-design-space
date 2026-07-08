import {
	atom,
	computed,
	effect,
	effectScope,
	endBatch,
	startBatch,
	untracked,
} from '../../packages/strata/src/index.js';
import type { FrameworkAdapter } from './types.js';

const adapter: FrameworkAdapter = {
	name: 'strata',
	signal(initialValue) {
		const value = atom(initialValue);
		return {
			read: () => value.state,
			write: (next) => value.set(next),
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
