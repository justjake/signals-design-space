import type { Plugin } from 'vite'

/**
 * Vite plugin that lets the devtools' stack-trace links open real files with no
 * setup. The browser only sees URLs (e.g. /src/App.tsx); the dev server knows
 * those live under its filesystem root, so this publishes that root to the page
 * as a global the panel reads when building an editor link. A path typed into
 * the panel still wins, and without this plugin the panel just asks for one.
 *
 * Serve-only: a production build has no local filesystem to open.
 *
 *   // vite.config.ts
 *   import { signalsDevtools } from 'signals-devtools/vite'
 *   export default { plugins: [signalsDevtools()] }
 */
export function signalsDevtools(): Plugin {
	let root = ''
	return {
		name: 'signals-devtools',
		apply: 'serve',
		configResolved(config) {
			root = config.root
		},
		transformIndexHtml() {
			return [
				{
					tag: 'script',
					children: `window.__SIGNALS_DEVTOOLS_PROJECT_ROOT__=${JSON.stringify(root)}`,
					injectTo: 'head-prepend',
				},
			]
		},
	}
}
