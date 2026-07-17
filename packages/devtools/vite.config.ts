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
		// The fx2 React binding (used by the ?react=1 signal-driven demo app) is a
		// linked source package that imports scheduler directly — prebundle it too
		// so that CJS scheduler goes through the optimizer instead of served raw.
		include: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'scheduler', 'signals-royale-fx2/react'],
	},
})
