/**
 * Contender registry. Adapters load lazily and a process loads exactly one:
 * the cosignals adapter calls registerCosignalReact() at module scope, which
 * patches Atom's prototype over to the concurrent engine for the whole
 * process — so even importing it in a process that benchmarks a different
 * contender would contaminate the measurement. The isolated runner spawns
 * one child per contender per round; the child resolves one loader here.
 */
import { contenderNames, type ContenderName } from './names.js';
import type { Contender } from './types.js';

const loaders: Record<ContenderName, () => Promise<{ default: Contender }>> = {
	'cosignals-react': () => import('./cosignals.js'),
	'alien-uses': () => import('./alien.js'),
	'dalien-uses': () => import('./dalien.js'),
	'baseline-context': () => import('./baselineContext.js'),
	'baseline-local': () => import('./baselineLocal.js'),
	'alt-a-uses': () => import('./altA.js'),
	'alt-a-react': () => import('./altAConcurrent.js'),
	'alt-b-uses': () => import('./altB.js'),
	'alt-b-react': () => import('./altBConcurrent.js'),
};

export async function loadContender(name: string): Promise<Contender> {
	if (!(contenderNames as readonly string[]).includes(name)) {
		throw new Error(`unknown contender: ${name}; available: ${contenderNames.join(', ')}`);
	}
	const mod = await loaders[name as ContenderName]();
	return mod.default;
}
