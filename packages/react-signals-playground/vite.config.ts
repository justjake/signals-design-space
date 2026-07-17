import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { signalsDevtools } from 'cosignals-devtools/vite'
import { defineConfig, type Connect, type Plugin } from 'vite'
import { DEFAULT_SEGMENT } from './src/shims/default-segment'

const entry = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

// Cross-origin isolation: without it browsers clamp performance.now() to ~1ms,
// so the devtools' span timings round to 0µs. Isolation raises precision to
// ~5µs. Every resource here is same-origin, so require-corp is safe.
const COI_HEADERS = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp',
}

/**
 * Static hosts serve a directory's index.html at both `/dir` and `/dir/`
 * (via a redirect); vite's dev and preview servers 404 the bare form under
 * appType 'mpa'. Mirror the host behavior so every spelling of an entry
 * path lands on the same page.
 */
function redirectDirEntries(dirs: readonly string[]): Plugin {
	const middleware: Connect.NextHandleFunction = (req, res, next) => {
		const [path = '', query] = (req.url ?? '').split('?')
		const suffix = query === undefined ? '' : `?${query}`
		// The bare root forwards to the default implementation. Static hosts
		// get the same behavior from the root index.html redirect stub.
		if (path === '/' || path === '/index.html') {
			res.statusCode = 301
			res.setHeader('Location', `/${DEFAULT_SEGMENT}/${suffix}`)
			res.end()
			return
		}
		if (dirs.includes(path)) {
			res.statusCode = 301
			res.setHeader('Location', `${path}/${suffix}`)
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

export default defineConfig({
	plugins: [
		react(),
		// Publishes the dev server's filesystem root so the cosignals devtools'
		// stack-trace links open real files without anyone typing a project path.
		signalsDevtools(),
		redirectDirEntries(['/cosignals', '/cosignals-arena', '/control']),
	],
	// MPA: every implementation is its own html entry under a named path;
	// the root entry is only the redirect stub. Disabling the SPA fallback
	// makes an unmapped path 404 instead of silently serving some page under
	// the wrong URL.
	server: { headers: COI_HEADERS },
	preview: { headers: COI_HEADERS },
	appType: 'mpa',
	build: {
		rollupOptions: {
			input: {
				// The bare-root redirect stub (static hosts; dev/preview 301 first).
				root: entry('index.html'),
				cosignals: entry('cosignals/index.html'),
				'cosignals-arena': entry('cosignals-arena/index.html'),
				// The vanilla-React control page (the battery's host-baseline group).
				control: entry('control/index.html'),
			},
		},
	},
})
