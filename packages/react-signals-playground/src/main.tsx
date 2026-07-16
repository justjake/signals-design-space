/**
 * Shared bootstrap for every entry html. Import order is load-bearing:
 * react-dom/client evaluates first (the patched renderer registers its
 * external-runtime protocol provider at module init), then the shim
 * selector (whose top-level await binds this page's implementation), so
 * register() below couples the selected engine to a provider that already
 * exists — before any root renders.
 */
import { createRoot, register } from '#concurrent-signals-shim'
import { App } from './App'

register()

const container = document.getElementById('root')
if (container === null) {
	throw new Error('react-signals-playground: missing #root container')
}

// fx2 devtools, on the royale-fx2 page only. Renders the devtools launch
// button (a React component the devtools package ships); it lazy-loads the
// panel on first open. Dynamically imported so default loads — and the
// battery — never fetch the devtools. ?devtools=1 opens it on load.
if (location.pathname.includes('royale-fx2')) {
	const engine = location.pathname.includes('royale-fx2-dalien') ? 'dalien' : 'fx2'
	const open = new URLSearchParams(location.search).has('devtools')
	if (open) {
		// ?devtools: attach the collector before the first render (top-level await),
		// so every node and watcher is captured from the start — including watcher
		// component names, which are only read at a hook's first render while the
		// tracer is attached. Gated on the flag so the default load and the battery
		// never pay for tracing.
		const m = await import('./devtools-button')
		await m.mountDevtoolsButton(true, engine)
	} else {
		void import('./devtools-button').then((m) => m.mountDevtoolsButton(false, engine))
	}
}

createRoot(container).render(<App />)
