/**
 * Registry mapping framework name -> lazy adapter loader. Loading is a
 * dynamic import per adapter so one broken library cannot break the others.
 */
import type { FrameworkAdapter } from './types';

export type { AdapterComputed, AdapterSignal, FrameworkAdapter } from './types';

export const adapterNames = [
	'alien-v3',
	'control',
	'sweep',
	'arrayd',
	'arena',
	'arena-links',
	'arena-masked',
	'arena-host',
	'arena-host-fused',
	'arena-spkh',
	'arena-spkq',
	'cosignal',
	'cosignal-logged',
] as const;

export type AdapterName = (typeof adapterNames)[number];

const loaders: Record<AdapterName, () => Promise<{ default: FrameworkAdapter }>> = {
	'alien-v3': () => import('./alien-v3'),
	control: () => import('./control'),
	sweep: () => import('./sweep'),
	arrayd: () => import('./arrayd'),
	arena: () => import('./arena'),
	'arena-links': () => import('./arena-links'),
	'arena-masked': () => import('./arena-masked'),
	'arena-host': () => import('./arena-host'),
	'arena-host-fused': () => import('./arena-host-fused'),
	'arena-spkh': () => import('./arena-spkh'),
	'arena-spkq': () => import('./arena-spkq'),
	cosignal: () => import('./cosignal'),
	'cosignal-logged': () => import('./cosignal-logged'),
};

export function isAdapterName(name: string): name is AdapterName {
	return (adapterNames as readonly string[]).includes(name);
}

export async function loadAdapter(name: string): Promise<FrameworkAdapter> {
	if (!isAdapterName(name)) {
		throw new Error(
			`Unknown framework ${JSON.stringify(name)}. Known frameworks: ${adapterNames.join(', ')}`,
		);
	}
	const mod = await loaders[name]();
	return mod.default;
}
