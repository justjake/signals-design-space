/**
 * Inline demo: a tiny live signals program with the devtools panel mounted
 * beside it. Doubles as the Playwright e2e target — driving the button
 * exercises the whole stack (engine → collector → panel) in a real browser.
 *
 * `?engine=dalien` runs the same program on the arena fork; the default is
 * fx2. Both engines expose the same public API and the same `/debug`
 * contract, so everything below the engine pick is shared.
 */
import * as fx2 from 'signals-royale-fx2'
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

// ?react=1: mount a small real React tree and turn on the bippy render channel,
// so the render observer has app fibers to watch — a parent whose state change
// cascades to its children (Parent → List → Leaf). The signal program above is
// vanilla DOM, so this is the only React app under observation besides the panel
// (which the observer excludes). Drives the render-causality e2e.
if (new URLSearchParams(location.search).get('react') === '1') {
	collector.setReactRenderMode(true)
	const [{ createElement: h, useState }, { createRoot }] = await Promise.all([import('react'), import('react-dom/client')])
	function Leaf({ n }: { n: number }) {
		return h('li', { 'data-testid': `leaf-${n}` }, `leaf ${n}`)
	}
	function List({ tick }: { tick: number }) {
		return h('ul', null, [0, 1, 2].map((n) => h(Leaf, { key: n, n: n + tick * 0 })))
	}
	function Parent() {
		const [tick, setTick] = useState(0)
		return h('div', null, [
			h('button', { key: 'b', 'data-testid': 'react-inc', onClick: () => setTick((t) => t + 1) }, `react-inc ${tick}`),
			h(List, { key: 'l', tick }),
		])
	}
	createRoot(document.getElementById('react-app')!).render(h(Parent))
}
