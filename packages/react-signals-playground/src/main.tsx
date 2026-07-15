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

// fx2 devtools, on the royale-fx2 page only. A floating button toggles the
// panel; ?devtools=1 opens it on load. The overlay is dynamically imported
// (on click or when the flag is set), so default loads — and the battery —
// never fetch the devtools chunk.
if (location.pathname.includes('royale-fx2')) {
	const button = document.createElement('button')
	button.id = 'fx2-devtools-open'
	button.textContent = '⚙ signals devtools'
	button.style.cssText =
		'position:fixed;bottom:12px;left:12px;z-index:100000;padding:6px 12px;' +
		'font:12px system-ui,sans-serif;background:#1c2028;color:#d6dbe4;' +
		'border:1px solid #2b313d;border-radius:6px;cursor:pointer'
	button.addEventListener('click', () => {
		void import('./devtools-overlay').then((m) => m.toggleFx2Devtools(button))
	})
	document.body.appendChild(button)

	if (new URLSearchParams(location.search).has('devtools')) {
		const { toggleFx2Devtools } = await import('./devtools-overlay')
		toggleFx2Devtools(button)
	}
}

createRoot(container).render(<App />)
