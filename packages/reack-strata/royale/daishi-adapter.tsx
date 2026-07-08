import { Runtime } from 'strata-signals';
import { registerStrata, useSignal } from '../src/index';

const runtime = new Runtime();
const count = runtime.atom(0);
registerStrata(runtime);

const increment = () => count.update((value) => value + 1);
const double = () => count.update((value) => value * 2);

export default {
	useCount(): number {
		return useSignal(count);
	},
	useIncrement(): () => void {
		return increment;
	},
	useDouble(): () => void {
		return double;
	},
};
