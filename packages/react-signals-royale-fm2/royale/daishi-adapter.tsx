/** Daishi tearing-matrix adapter: one module-level counter store. */
import { atom, update } from 'signals-royale-fm2';
import { register } from '../src/host.ts';
import { useValue } from '../src/hooks.ts';

register();

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
