/**
 * React seam benchmark: what a React app pays between an external write and
 * the committed DOM. Real createRoot from this package's fork build, jsdom,
 * real timers, no act. One scenario per child process; stdout is pure CSV
 * `scenario,contender,stat,ms`.
 *
 * Scenarios:
 * - fanout      5000 independent cells, one component each; 200 single-cell
 *               writes from outside React; median write->commit latency.
 * - transition  2000 cells rewritten inside a transition while an unrelated
 *               urgent useState input updates 30x at ~16ms; p95 urgent
 *               update->commit latency. A plain useSyncExternalStore store
 *               degrades to blocking renders here; these bindings must not.
 * - mount       mount + first commit of the 5000-cell tree, 5 fresh roots;
 *               median ms.
 *
 * Contenders: `cosignals` (these bindings) and `uses-baseline` (a minimal
 * useSyncExternalStore store with the same component shapes).
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const scenarios = ['fanout', 'transition', 'mount']
const contenders = ['cosignals', 'uses-baseline']

if (process.argv[2] === undefined) {
	process.stdout.write('scenario,contender,stat,ms\n')
	for (const scenario of scenarios) {
		for (const contender of contenders) {
			const r = spawnSync(
				process.execPath,
				['--experimental-transform-types', join(HERE, 'react-bench.mjs'), scenario, contender],
				{
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'inherit'],
					timeout: 180000,
				},
			)
			if (r.error !== undefined) {
				throw r.error
			}
			if (r.status !== 0) {
				process.exit(r.status ?? 1)
			}
			process.stdout.write(r.stdout ?? '')
		}
	}
	process.exit(0)
}

// ---------------------------------------------------------------------------
// Child: one (scenario, contender) run.
// ---------------------------------------------------------------------------

const [scenario, contender] = [process.argv[2], process.argv[3]]

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.MutationObserver = dom.window.MutationObserver

const React = (await import('react')).default ?? (await import('react'))
const ReactDOMClient = await import('react-dom/client')

function median(xs) {
	const s = [...xs].sort((a, b) => a - b)
	return s[Math.floor(s.length / 2)]
}
function p95(xs) {
	const s = [...xs].sort((a, b) => a - b)
	return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]
}
const row = (stat, ms) =>
	process.stdout.write(`${scenario},${contender},${stat},${ms.toFixed(3)}\n`)
const frame = () => new Promise((res) => setTimeout(res, 0))
async function waitFor(predicate, timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error('timeout waiting for commit')
		}
		await frame()
	}
}

// --- contender wiring -------------------------------------------------------

let impl
if (contender === 'cosignals') {
	const engine = await import('cosignals')
	const bindings = await import('../src/react/index.ts')
	bindings.registerReactSignals()
	const wrappedCreateRoot = bindings.wrapCreateRoot(ReactDOMClient.createRoot)
	impl = {
		createCells(n) {
			const cells = []
			for (let i = 0; i < n; i++) {
				cells.push(engine.createAtom(0))
			}
			return cells
		},
		useCell(cell) {
			return bindings.useValue(cell)
		},
		write(cell, v) {
			cell.set(v)
		},
		writeManyInTransition(cells, v) {
			bindings.startSignalTransition(() => {
				for (const c of cells) {
					c.set(v)
				}
			})
		},
		createRoot: (el) => wrappedCreateRoot(el),
	}
} else {
	// ~35-line useSyncExternalStore baseline over a plain store.
	const makeStore = (n) => {
		const values = new Array(n).fill(0)
		const listeners = new Array(n).fill(null).map(() => new Set())
		return {
			values,
			read: (i) => values[i],
			write(i, v) {
				values[i] = v
				for (const l of listeners[i]) {
					l()
				}
			},
			subscribe: (i) => (cb) => {
				listeners[i].add(cb)
				return () => listeners[i].delete(cb)
			},
		}
	}
	let store = null
	impl = {
		createCells(n) {
			store = makeStore(n)
			return new Array(n).fill(0).map((_, i) => i)
		},
		useCell(i) {
			return React.useSyncExternalStore(
				React.useCallback(store.subscribe(i), [i]),
				() => store.read(i),
				() => store.read(i),
			)
		},
		write(i, v) {
			store.write(i, v)
		},
		writeManyInTransition(cells, v) {
			React.startTransition(() => {
				for (const i of cells) {
					store.write(i, v)
				}
			})
		},
		createRoot: (el) => ReactDOMClient.createRoot(el),
	}
}

// --- scenarios ---------------------------------------------------------------

const e = React.createElement

// The transition scenario needs renders wide enough to span many time
// slices, or the "during a transition" measurement window would be empty.
const CELL_WORK_MS = scenario === 'transition' ? 0.15 : 0

function Cell({ cell }) {
	const v = impl.useCell(cell)
	if (CELL_WORK_MS > 0) {
		const end = performance.now() + CELL_WORK_MS
		while (performance.now() < end) {
			/* representative render work */
		}
	}
	return e('i', null, String(v))
}

function List({ cells }) {
	return e(
		'div',
		null,
		cells.map((c, i) => e(Cell, { key: i, cell: c })),
	)
}

async function mountTree(n) {
	const container = document.createElement('div')
	document.body.appendChild(container)
	const cells = impl.createCells(n)
	const root = impl.createRoot(container)
	root.render(e(List, { cells }))
	await waitFor(() => container.textContent.length >= n)
	return { container, cells, root }
}

if (scenario === 'fanout') {
	const { container, cells } = await mountTree(5000)
	const lat = []
	for (let k = 0; k < 200; k++) {
		const i = (k * 37) % 5000
		const v = k + 1
		const t0 = performance.now()
		impl.write(cells[i], v)
		await waitFor(() => container.textContent.includes(String(v)))
		lat.push(performance.now() - t0)
	}
	row('median-write-to-commit', median(lat))
} else if (scenario === 'transition') {
	const { container, cells } = await mountTree(2000)
	let urgentShown = 0
	// Urgent input is modeled as REAL discrete events (clicks) through
	// React's event system, the priority a user's keystroke gets — not a
	// plain setState from a timer, which rides the default lane and queues
	// FIFO behind other normal-priority scheduler tasks by design.
	function Urgent() {
		const [n, setN] = React.useState(0)
		React.useLayoutEffect(() => {
			urgentShown = n
		})
		return e('button', { id: 'urgent-btn', onClick: () => setN((x) => x + 1) }, `u:${n}`)
	}
	const uContainer = document.createElement('div')
	document.body.appendChild(uContainer)
	const uRoot = impl.createRoot(uContainer)
	uRoot.render(e(Urgent, null))
	await waitFor(() => uContainer.textContent === 'u:0')
	const button = uContainer.querySelector('#urgent-btn')
	const click = () =>
		button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
	// Urgent input at ~16ms intervals. In a single-threaded runtime a blocking
	// bulk render shows up as INPUT DELAY: the tick cannot even start until
	// the block ends. Measure per tick, from the moment the input was
	// INTENDED (this tick's 16ms mark) to its committed urgent update — the
	// gap a user would feel — without accumulating one tick's lag into the
	// next (each tick re-anchors to its own intended moment).
	const lat = []
	const t0 = performance.now()
	for (let k = 1; k <= 60; k++) {
		const intended = performance.now() + 16
		await new Promise((res) => setTimeout(res, 16))
		if (k === 5) {
			impl.writeManyInTransition(cells, 7) // the bulk rewrite lands mid-stream
		}
		click()
		await waitFor(() => urgentShown === k, 60000)
		lat.push(performance.now() - intended)
	}
	row('p95-urgent-during-transition', p95(lat))
	row('max-urgent-during-transition', Math.max(...lat))
	await waitFor(() => container.textContent.includes('7'), 60000)
	row('transition-completed-after', performance.now() - t0)
} else if (scenario === 'mount') {
	const times = []
	for (let k = 0; k < 5; k++) {
		const t0 = performance.now()
		await mountTree(5000)
		times.push(performance.now() - t0)
	}
	row('median-mount-5000', median(times))
}
process.exit(0)
