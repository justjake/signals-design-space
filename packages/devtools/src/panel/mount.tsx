/**
 * Inline host — mount the panel into any element, wired to an in-realm Backend.
 * The same App is what the Chrome extension panel renders; there it talks to a
 * postMessage-proxied Backend instead. The panel never knows the difference.
 */
import { createRoot } from 'react-dom/client'
import type { Backend } from '../protocol.ts'
import { App } from './App.tsx'

export interface DevtoolsHandle {
	unmount(): void
}

/** Render the devtools panel into `el`, reading from `backend`. */
export function mountDevtools(el: HTMLElement, backend: Backend): DevtoolsHandle {
	const root = createRoot(el)
	root.render(<App backend={backend} />)
	return {
		unmount() {
			root.unmount()
		},
	}
}

export { App } from './App.tsx'
