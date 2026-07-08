import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Connect, type Plugin } from 'vite';

const entry = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * Static hosts serve a directory's index.html at both `/dir` and `/dir/`
 * (via a redirect); vite's dev and preview servers 404 the bare form under
 * appType 'mpa'. Mirror the host behavior so every spelling of an entry
 * path lands on the same page.
 */
function redirectDirEntries(dirs: readonly string[]): Plugin {
	const middleware: Connect.NextHandleFunction = (req, res, next) => {
		const [path = '', query] = (req.url ?? '').split('?');
		if (dirs.includes(path)) {
			res.statusCode = 301;
			res.setHeader('Location', `${path}/${query === undefined ? '' : `?${query}`}`);
			res.end();
			return;
		}
		next();
	};
	return {
		name: 'playground:redirect-dir-entries',
		configureServer(server) {
			server.middlewares.use(middleware);
		},
		configurePreviewServer(server) {
			server.middlewares.use(middleware);
		},
	};
}

export default defineConfig({
	plugins: [react(), redirectDirEntries(['/alt-a', '/alt-b'])],
	// MPA: /, /alt-a/, /alt-b/ are separate html entries. Disabling the SPA
	// fallback makes an unmapped path 404 instead of silently serving the
	// cosignals page under the wrong URL.
	appType: 'mpa',
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
			},
		},
	},
});
