/**
 * The one table of selectable implementations. The shim selector
 * (./index.ts) resolves the page's implementation from it, and the app's tab
 * bar renders one tab per row — adding an implementation here updates both
 * at once, so the loader and the navigation can never disagree about what
 * exists.
 */
import { DEFAULT_SEGMENT } from './default-segment'
import type { ConcurrentSignalsShim } from './interface'

export interface Implementation {
	/** First URL path segment that selects this implementation; '' is the root entry. */
	readonly segment: string
	/** Short tab text. */
	readonly label: string
	/** The shim's exported `name` — the tab bar marks the active tab by comparing against it. */
	readonly name: string
	/** Typed loader: the import() namespace is checked against the shim interface here. */
	readonly load: () => Promise<ConcurrentSignalsShim>
}

export const implementations: readonly Implementation[] = [
	{
		segment: 'royale-fx2',
		label: 'royale-fx2',
		name: 'signals-royale-fx2',
		load: () => import('./royale-fx2'),
	},
	{
		segment: 'royale-fx2-dalien',
		label: 'royale-fx2-dalien',
		name: 'signals-royale-fx2-dalien',
		load: () => import('./royale-fx2-dalien'),
	},
	{ segment: 'cosignals', label: 'cosignals', name: 'cosignals', load: () => import('./cosignals') },
	{ segment: 'alt-a', label: 'alt-a', name: 'cosignals-alt-a', load: () => import('./alt-a') },
	{ segment: 'alt-b', label: 'alt-b', name: 'cosignals-alt-b', load: () => import('./alt-b') },
	{
		segment: 'solid-react',
		label: 'solid-react',
		name: 'concurrent-solid-react',
		load: () => import('./solid-react'),
	},
]

const defaultRow = implementations.find((impl) => impl.segment === DEFAULT_SEGMENT)
if (defaultRow === undefined) {
	throw new Error(
		`react-signals-playground: DEFAULT_SEGMENT "${DEFAULT_SEGMENT}" has no implementation row`,
	)
}
/**
 * The implementation `/` redirects to (named in ./default-segment.ts; kept
 * first in the table so it also leads the tab bar). Every implementation
 * lives under its own named path; the bare root only forwards here — a
 * server redirect in dev/preview, the root index.html stub on static hosts.
 */
export const defaultImplementation: Implementation = defaultRow

/** The entry URL for an implementation; segments map to directory entries served with a trailing slash. */
export function implementationHref(impl: Implementation): string {
	return `/${impl.segment}/`
}
