import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Serves demo/ (the inline devtools demo + Playwright e2e target).
export default defineConfig({
	root: fileURLToPath(new URL('./demo', import.meta.url)),
	plugins: [react()],
	optimizeDeps: {
		// react/react-dom resolve to the workspace's patched (CJS) React build
		// via the pnpm override; force-include so vite serves them as ESM in dev.
		include: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'scheduler'],
	},
})
