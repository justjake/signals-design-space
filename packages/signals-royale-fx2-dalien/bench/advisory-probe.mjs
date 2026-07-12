/**
 * Probe: does the React dev-build advisory ("Detected a large number of
 * updates inside startTransition...") fire for (a) a same-cell write burst,
 * (b) a many-distinct-cells rewrite? Run with NODE_ENV=development so the
 * dev build loads. Prints one line per case.
 */
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })

const React = (await import('react')).default ?? (await import('react'))
const { createRoot } = await import('react-dom/client')
const { createAtom } = await import('signals-royale-fx2-dalien')
const { registerReactSignals, useValue, wrapCreateRoot, startSignalTransition } =
	await import('../src/react/index.ts')

registerReactSignals()

const advisories = []
const origWarn = console.warn
const origError = console.error
const capture = (orig) =>
	function (...args) {
		if (String(args[0]).includes('large number of updates inside startTransition')) {
			advisories.push(args[0])
			return
		}
		orig.apply(console, args)
	}
console.warn = capture(origWarn)
console.error = capture(origError)

const frame = () => new Promise((res) => setTimeout(res, 0))
async function settle(pred) {
	const deadline = Date.now() + 10000
	while (!pred()) {
		if (Date.now() > deadline) {
			throw new Error('timeout')
		}
		await frame()
	}
}

async function run(label, makeCase) {
	advisories.length = 0
	const el = document.createElement('div')
	document.body.appendChild(el)
	const root = wrapCreateRoot(createRoot)(el)
	const { node, write, done } = makeCase()
	root.render(node)
	await settle(() => el.textContent.length > 0)
	// Passive effects attach the store subscriptions after paint; give them a
	// beat so the write hits steady-state subscribers like in a real app.
	for (let i = 0; i < 20; i++) {
		await frame()
	}
	startSignalTransition(write)
	await settle(() => done(el))
	console.log(`${label}: advisory ${advisories.length > 0 ? 'FIRES' : 'silent'}`)
	root.unmount()
	el.remove()
}

// (a) one cell written 100x, 4 subscribers.
await run('same-cell burst (100 writes, 4 subs)', () => {
	const cell = createAtom(0)
	const Sub = () => React.createElement('i', null, String(useValue(cell)), ';')
	return {
		node: React.createElement(
			React.Fragment,
			null,
			...Array.from({ length: 4 }, (_, i) => React.createElement(Sub, { key: i })),
		),
		write: () => {
			for (let k = 1; k <= 100; k++) {
				cell.set(k)
			}
		},
		done: (el) => el.textContent.includes('100;'),
	}
})

// (a2) one cell written 100x, 15 subscribers (more fibers than the
// advisory's distinct-fiber threshold).
await run('same-cell burst (100 writes, 15 subs)', () => {
	const cell = createAtom(0)
	const Sub = () => React.createElement('i', null, String(useValue(cell)), ';')
	return {
		node: React.createElement(
			React.Fragment,
			null,
			...Array.from({ length: 15 }, (_, i) => React.createElement(Sub, { key: i })),
		),
		write: () => {
			for (let k = 1; k <= 100; k++) {
				cell.set(k)
			}
		},
		done: (el) => el.textContent.includes('100;'),
	}
})

// (b) 50 distinct cells rewritten once each, one subscriber per cell.
await run('many-distinct-cells rewrite (50 cells)', () => {
	const cells = Array.from({ length: 50 }, () => createAtom(0))
	const Sub = ({ i }) => React.createElement('i', null, String(useValue(cells[i])), ';')
	return {
		node: React.createElement(
			React.Fragment,
			null,
			...cells.map((_, i) => React.createElement(Sub, { key: i, i })),
		),
		write: () => {
			for (const c of cells) {
				c.set(1)
			}
		},
		done: (el) => !el.textContent.includes('0;'),
	}
})

process.exit(0)
