/**
 * Daishi tearing-matrix adapter: three hooks over one module-level store
 * holding a counter that starts at 0. Module load registers the runtime.
 */
import { useCallback } from 'react';
import { atom } from 'signals-royale-fh1';
import { register, useValue } from '../src/index';

register();

const count = atom(0);

export default {
	useCount(): number {
		return useValue(count);
	},
	useIncrement(): () => void {
		return useCallback(() => count.update((c) => c + 1), []);
	},
	useDouble(): () => void {
		return useCallback(() => count.update((c) => c * 2), []);
	},
};
