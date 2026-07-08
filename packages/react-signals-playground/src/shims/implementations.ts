/**
 * The one table of selectable implementations. The shim selector
 * (./index.ts) resolves the page's implementation from it, and the app's tab
 * bar renders one tab per row — adding an implementation here updates both
 * at once, so the loader and the navigation can never disagree about what
 * exists.
 */
import type { ConcurrentSignalsShim } from './interface';

export interface Implementation {
	/** First URL path segment that selects this implementation; '' is the root entry. */
	readonly segment: string;
	/** Short tab text. */
	readonly label: string;
	/** The shim's exported `name` — the tab bar marks the active tab by comparing against it. */
	readonly name: string;
	/** Typed loader: the import() namespace is checked against the shim interface here. */
	readonly load: () => Promise<ConcurrentSignalsShim>;
}

export const implementations: readonly Implementation[] = [
	{ segment: '', label: 'cosignals', name: 'cosignals', load: () => import('./cosignals') },
	{ segment: 'alt-a', label: 'alt-a', name: 'cosignals-alt-a', load: () => import('./alt-a') },
	{ segment: 'alt-b', label: 'alt-b', name: 'cosignals-alt-b', load: () => import('./alt-b') },
	{
		segment: 'solid-react',
		label: 'solid-react',
		name: 'concurrent-solid-react',
		load: () => import('./solid-react'),
	},
];

/** The entry URL for an implementation; segments map to directory entries served with a trailing slash. */
export function implementationHref(impl: Implementation): string {
	return impl.segment === '' ? '/' : `/${impl.segment}/`;
}
