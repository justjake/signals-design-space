/**
 * Mounts the fx2 devtools launch button on the royale-fx2 page. Loaded on
 * demand (see main.tsx) so default loads and the battery never pull the
 * devtools. Attaches the collector to the page's fx2 engine, then renders the
 * launcher into its own React root — the heavy panel itself is code-split and
 * loads only when the button is first clicked.
 */
import { createRoot } from 'react-dom/client'
import { attachFx2Devtools } from 'signals-devtools/fx2'
import { DevtoolsPanelButton } from 'signals-devtools/button'

export function mountDevtoolsButton(defaultOpen: boolean): void {
	if (document.getElementById('fx2-devtools-launcher') !== null) return
	const { collector } = attachFx2Devtools()
	const host = document.createElement('div')
	host.id = 'fx2-devtools-launcher'
	document.body.appendChild(host)
	createRoot(host).render(<DevtoolsPanelButton backend={collector} defaultCorner="bottom-right" defaultOpen={defaultOpen} />)
}
