import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Connect, type Plugin } from 'vite'

const entry = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

/**
 * Static hosts serve a directory's index.html at both `/dir` and `/dir/`
 * (via a redirect); vite's dev and preview servers 404 the bare form under
 * appType 'mpa'. Mirror the host behavior so every spelling of an entry
 * path lands on the same page.
 */
function redirectDirEntries(dirs: readonly string[]): Plugin {
	const middleware: Connect.NextHandleFunction = (req, res, next) => {
		const [path = '', query] = (req.url ?? '').split('?')
		if (dirs.includes(path)) {
			res.statusCode = 301
			res.setHeader('Location', `${path}/${query === undefined ? '' : `?${query}`}`)
			res.end()
			return
		}
		next()
	}
	return {
		name: 'playground:redirect-dir-entries',
		configureServer(server) {
			server.middlewares.use(middleware)
		},
		configurePreviewServer(server) {
			server.middlewares.use(middleware)
		},
	}
}

export default defineConfig(({ mode }) => ({
	plugins: [
		react(),
		redirectDirEntries(['/alt-a', '/alt-b', '/solid-react', '/royale-fx2', '/control']),
	],
	// MPA: /, /alt-a/, /alt-b/, /solid-react/ are separate html entries.
	// Disabling the SPA fallback makes an unmapped path 404 instead of
	// silently serving the cosignals page under the wrong URL.
	appType: 'mpa',
	// concurrent-solid-react's vendored Solid core guards its dev-mode
	// diagnostics behind the __DEV__ compile-time constant (see that
	// package's globals.d.ts): diagnostics on for dev serve, off for builds.
	define: {
		__DEV__: JSON.stringify(mode !== 'production'),
	},
	optimizeDeps: {
		// react/react-dom/scheduler resolve to the workspace's patched React
		// build (pnpm override → link:vendor/react/build/oss-experimental).
		// Vite skips prebundling linked packages by default, but these are
		// CJS and must go through the optimizer to be served as ESM in dev.
		include: [
			'react',
			'react/jsx-runtime',
			'react/jsx-dev-runtime',
			'react-dom',
			'react-dom/client',
			'scheduler',
		],
	},
	build: {
		rollupOptions: {
			input: {
				cosignals: entry('index.html'),
				'alt-a': entry('alt-a/index.html'),
				'alt-b': entry('alt-b/index.html'),
				'solid-react': entry('solid-react/index.html'),
				'royale-fx2': entry('royale-fx2/index.html'),
				// The vanilla-React control page (the battery's host-baseline group).
				control: entry('control/index.html'),
			},
		},
	},
}))
