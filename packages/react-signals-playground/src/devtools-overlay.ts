/**
 * fx2 devtools overlay for the royale-fx2 page. Loaded on demand — either by
 * clicking the on-page button or with `?devtools=1` — so default page loads
 * (and the verification battery) never fetch the devtools chunk.
 *
 * The collector attaches to the page's fx2 engine (the same module instance
 * the shim uses, via the shared trace seam) on first open and keeps recording,
 * so closing/reopening the panel preserves history. The panel mounts in a
 * fixed side pane.
 */
import { attachFx2Devtools } from 'signals-devtools/fx2'
import { mountDevtools } from 'signals-devtools/panel'

const OVERLAY_CSS =
	'position:fixed;top:0;right:0;width:46vw;height:100vh;z-index:99999;' +
	'border-left:1px solid #2b313d;box-shadow:-2px 0 16px rgba(0,0,0,.5)'

let collector: ReturnType<typeof attachFx2Devtools>['collector'] | null = null
let handle: { unmount(): void } | null = null

/** Open the panel if closed, close it if open. Updates the trigger button's
 * label when one is passed. */
export function toggleFx2Devtools(button?: HTMLButtonElement): void {
	const existing = document.getElementById('fx2-devtools')
	if (existing !== null) {
		handle?.unmount()
		handle = null
		existing.remove()
		if (button) button.textContent = '⚙ signals devtools'
		return
	}
	// Attach once and keep recording for the page's lifetime.
	if (collector === null) collector = attachFx2Devtools().collector
	const host = document.createElement('div')
	host.id = 'fx2-devtools'
	host.style.cssText = OVERLAY_CSS
	document.body.appendChild(host)
	handle = mountDevtools(host, collector)
	if (button) button.textContent = '✕ close devtools'
}
