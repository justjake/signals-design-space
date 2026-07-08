/**
 * Daishi tearing-matrix adapter: one module-level counter, three hooks.
 */
import { atom, update } from 'signals-royale-fh2';
import { registerReactSignals, useValue } from '../src/index';

registerReactSignals();

const count = atom(0);
const increment = () => update(count, (x) => x + 1);
const double = () => update(count, (x) => x * 2);

export default {
	useCount(): number {
		return useValue(count);
	},
	useIncrement(): () => void {
		return increment;
	},
	useDouble(): () => void {
		return double;
	},
};
