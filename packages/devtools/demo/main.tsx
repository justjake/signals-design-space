/**
 * Inline demo: a tiny live fx2 program with the devtools panel mounted beside
 * it. Doubles as the Playwright e2e target — driving the button exercises the
 * whole stack (fx2 → collector → panel) in a real browser.
 */
import { createAtom, createComputed, effect, read, set } from 'signals-royale-fx2'
import { attachFx2Devtools } from '../src/fx2.ts'
import { mountDevtools } from '../src/panel/mount.tsx'

const { collector } = attachFx2Devtools()

const count = createAtom(0, { label: 'count' })
const doubled = createComputed(() => count.get() * 2, { label: 'doubled' })

const out = document.getElementById('out')!
effect(
	() => doubled.get(),
	(value) => {
		out.textContent = String(value)
	},
)

document.getElementById('inc')!.addEventListener('click', () => {
	set(count, read(count) + 1)
})

// Initialize with a write so the graph + log are populated on load (a read
// alone isn't traced, so an unwritten atom wouldn't appear yet).
set(count, 1)

mountDevtools(document.getElementById('panel')!, collector)
