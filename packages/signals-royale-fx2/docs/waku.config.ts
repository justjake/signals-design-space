import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import mdx from 'fumadocs-mdx/vite'
import press from 'fumapress/vite'
import { defineConfig } from 'waku/config'

const packageRoot = path.resolve(import.meta.dirname, '..')
const repoPackages = path.resolve(packageRoot, '..')

export default defineConfig({
	vite: {
		resolve: {
			dedupe: ['react', 'react-dom', 'fumadocs-ui'],
			alias: {
				'signals-royale-fx2/debug': path.join(packageRoot, 'src/debug/index.ts'),
				'signals-royale-fx2/react': path.join(packageRoot, 'src/react/index.ts'),
				'signals-royale-fx2/ssr': path.join(packageRoot, 'src/ssr.ts'),
				'signals-royale-fx2': path.join(packageRoot, 'src/index.ts'),
				'signals-devtools/fx2': path.join(repoPackages, 'devtools/src/fx2.ts'),
				'signals-devtools/button': path.join(
					repoPackages,
					'devtools/src/panel/DevtoolsPanelButton.tsx',
				),
			},
		},
		server: {
			fs: { allow: [path.resolve(import.meta.dirname, '../..')] },
		},
		plugins: [press(), mdx(), tailwindcss()],
	},
})
