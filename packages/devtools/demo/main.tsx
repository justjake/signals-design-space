/**
 * Inline demo: a tiny live signals program with the devtools panel mounted
 * beside it. Doubles as the Playwright e2e target — driving the button
 * exercises the whole stack (engine → collector → panel) in a real browser.
 *
 * `?engine=dalien` runs the same program on the arena fork; the default is
 * fx2. Both engines expose the same public API and the same `/debug`
 * contract, so everything below the engine pick is shared.
 */
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import * as fx2 from 'signals-royale-fx2'
import { useValue, wrapCreateRoot } from 'signals-royale-fx2/react'
import * as dalienEngine from 'signals-royale-fx2-dalien'
import { attachDalienDevtools } from '../src/dalien.ts'
import { attachFx2Devtools } from '../src/fx2.ts'
import { mountDevtools } from '../src/panel/mount.tsx'

const useDalien = new URLSearchParams(location.search).get('engine') === 'dalien'
// The two packages export one public API shape; the cast picks fx2's
// declarations as the shared type surface.
const { createAtom, createComputed, effect, read, set } = useDalien
	? (dalienEngine as unknown as typeof fx2)
	: fx2
const { collector } = useDalien ? attachDalienDevtools() : attachFx2Devtools()

document.getElementById('engine')!.textContent = useDalien ? 'fx2-dalien' : 'fx2'
document.getElementById(useDalien ? 'pick-dalien' : 'pick-fx2')!.setAttribute('aria-current', 'page')

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

// ?react=1: mount a small SIGNAL-DRIVEN React tree, so the always-on render
// channel has app fibers to observe and the e2e can verify signal → render
// causality end to end. A write to `count` wakes the reader, React re-renders
// Reader (and its Leaf children cascade), and bippy chains those renders back
// through the notify to the write. The vanilla program above is separate DOM;
// this is the only observed React app besides the panel (which is excluded).
// fx2 only — it uses fx2's React binding; the e2e drives the default fx2 page.
if (new URLSearchParams(location.search).get('react') === '1' && !useDalien) {
	// A child with no props: when Reader re-renders on a count change, this
	// re-renders purely because its parent did — a genuine cascade ("parent
	// rendered"), distinct from a prop change.
	function Cascaded() {
		return h('span', { 'data-testid': 'react-cascaded' }, 'child')
	}
	function Reader() {
		const v = useValue(count)
		return h('ul', { 'data-testid': 'react-count' }, [h('li', { key: 'v' }, `v:${v}`), h(Cascaded, { key: 'c' })])
	}
	function ReactApp() {
		return h('div', null, [
			h('button', { key: 'btn', 'data-testid': 'react-inc', onClick: () => set(count, read(count) + 1) }, 'react-inc'),
			h(Reader, { key: 'reader' }),
		])
	}
	const create = wrapCreateRoot(createRoot)
	create(document.getElementById('react-app')!).render(h(ReactApp))
}
