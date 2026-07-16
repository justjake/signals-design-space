/**
 * Mounts the signals devtools launch button on the royale-fx2 and
 * royale-fx2-dalien pages. Loaded on demand (see main.tsx) so default loads
 * and the battery never pull the devtools. Attaches the collector to the
 * page's own engine, then renders the launcher into its own React root — the
 * heavy panel itself is code-split and loads only when the button is first
 * clicked.
 *
 * The engine binding is dynamically imported: each `signals-devtools/<engine>`
 * entry imports that engine's module, and a page's non-selected engine must
 * never initialize (the shim selector's isolation rule).
 */
import { createRoot } from 'react-dom/client'
import { DevtoolsPanelButton } from 'signals-devtools/button'

export async function mountDevtoolsButton(
	defaultOpen: boolean,
	engine: 'fx2' | 'dalien',
): Promise<void> {
	if (document.getElementById('fx2-devtools-launcher') !== null) return
	const { collector } =
		engine === 'dalien'
			? (await import('signals-devtools/dalien')).attachDalienDevtools()
			: (await import('signals-devtools/fx2')).attachFx2Devtools()
	const host = document.createElement('div')
	host.id = 'fx2-devtools-launcher'
	document.body.appendChild(host)
	createRoot(host).render(<DevtoolsPanelButton backend={collector} defaultCorner="bottom-right" defaultOpen={defaultOpen} />)
}
