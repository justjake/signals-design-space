/**
 * Shared bootstrap for every entry html. Import order is load-bearing:
 * react-dom/client evaluates first (the patched renderer registers its
 * external-runtime protocol provider at module init), then the shim
 * selector (whose top-level await binds this page's implementation), so
 * register() below couples the selected engine to a provider that already
 * exists — before any root renders.
 */
import { createRoot } from 'react-dom/client';
import { register } from '#concurrent-signals-shim';
import { App } from './App';

register();

const container = document.getElementById('root');
if (container === null) {
	throw new Error('react-signals-playground: missing #root container');
}
createRoot(container).render(<App />);
