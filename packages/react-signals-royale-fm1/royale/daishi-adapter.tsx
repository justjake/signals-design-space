/** Daishi tearing-matrix adapter: one module-level counter store. */
import { atom } from 'signals-royale-fm1';
import { register, set, update, useValue } from '../src/index.ts';

register();

const count = atom(0, { label: 'daishi-count' });

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
