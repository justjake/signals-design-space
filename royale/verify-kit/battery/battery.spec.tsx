// @vitest-environment jsdom
/**
 * Signals Royale — shared Real-React gate battery (RULES.md scenarios 1-18).
 *
 * Entrant-independent by construction: every engine and React touch goes
 * through the RoyaleAdapter default-exported by ./ADAPTER (a per-entrant
 * shim the orchestrator provisions). JSX compiles to React.createElement
 * against the adapter's own React binding — this file never imports 'react'.
 * Assertions are DOM-observable or adapter-surface only.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import adapter from './ADAPTER'
import type { RoyaleHandle } from './royale-types'

const React = adapter.React

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let handle: RoyaleHandle
let roots: Array<{ render(node: unknown): void; unmount(): void }> = []
let containers: HTMLElement[] = []

beforeEach(() => {
	handle = adapter.register()
})

afterEach(async () => {
	await adapter.act(async () => {
		for (const r of roots) {
			r.unmount()
		}
	})
	// Snapshot before the scrub: reset must not be able to hide an error.
	const errors = [...handle.errors]
	for (const c of containers) {
		c.remove()
	}
	roots = []
	containers = []
	adapter.resetForTest()
	;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
	expect(errors).toEqual([])
})

function newRoot(): {
	root: { render(node: unknown): void; unmount(): void }
	container: HTMLElement
} {
	const container = document.createElement('div')
	document.body.appendChild(container)
	const root = adapter.ReactDOMClient.createRoot(container)
	roots.push(root)
	containers.push(container)
	return { root, container }
}

async function mount(node: unknown) {
	const made = newRoot()
	await adapter.act(() => {
		made.root.render(node)
	})
	return made
}

function text(container: HTMLElement): string {
	return (container.textContent ?? '').replace(/\s+/g, '')
}

function deferred<T>(): {
	promise: Promise<T>
	resolve: (v: T) => void
	settled: boolean
} {
	let resolve!: (v: T) => void
	const promise = new Promise<T>((res) => {
		resolve = res
	})
	const d = {
		promise,
		resolve: (v: T) => {
			d.settled = true
			resolve(v)
		},
		settled: false,
	}
	return d
}

function tick(ms = 0): Promise<void> {
	return new Promise((res) => setTimeout(res, ms))
}

/** A shared-atom reader; renders `id:value;`. */
function Reader({ id, atom }: { id: string; atom: unknown }) {
	return (
		<span>
			{id}:{adapter.useValue(atom)};
		</span>
	)
}

describe('scenario 1 — urgent write: one commit; batch of writes: one commit', () => {
	test('a single urgent write produces exactly one extra commit', async () => {
		const a = adapter.atom(0)
		let renders = 0
		function App() {
			renders++
			return <span>{adapter.useValue(a)}</span>
		}
		const { container } = await mount(<App />)
		expect(text(container)).toBe('0')
		const before = renders
		await adapter.act(async () => {
			adapter.set(a, 1)
		})
		expect(text(container)).toBe('1')
		expect(renders).toBe(before + 1)
	})

	test('batched writes to two atoms coalesce into one commit', async () => {
		const a = adapter.atom(0)
		const b = adapter.atom(0)
		let renders = 0
		function App() {
			renders++
			return (
				<span>
					{adapter.useValue(a)},{adapter.useValue(b)}
				</span>
			)
		}
		const { container } = await mount(<App />)
		const before = renders
		await adapter.act(async () => {
			adapter.batch(() => {
				adapter.set(a, 1)
				adapter.set(b, 2)
			})
		})
		expect(text(container)).toBe('1,2')
		expect(renders).toBe(before + 1)
	})
})

describe('scenario 2 — transition write: invisible until commit; useIsPending meanwhile', () => {
	function makeHeld() {
		const a = adapter.atom(0)
		const holdFlag = adapter.atom(false)
		const gate = deferred<void>()
		function Suspender() {
			const v = adapter.useValue(a)
			const h = adapter.useValue(holdFlag)
			if (h && !gate.settled) {
				throw gate.promise
			} // holds the transition's render open
			return <span>v:{v};</span>
		}
		return { a, holdFlag, gate, Suspender }
	}

	test('pending transition state never appears in the committed DOM; read family agrees', async () => {
		const { a, holdFlag, gate, Suspender } = makeHeld()
		const { container } = await mount(
			<React.Suspense fallback={<i>fb;</i>}>
				<Suspender />
			</React.Suspense>,
		)
		expect(text(container)).toBe('v:0;')
		await adapter.act(async () => {
			adapter.startTransitionWrite(() => {
				adapter.set(a, 1)
				adapter.set(holdFlag, true)
			})
		})
		expect(text(container)).toBe('v:0;') // held: no draft leak, no fallback
		expect(adapter.read(a)).toBe(0) // canonical: committed ∪ applied-urgent
		expect(adapter.committed(a)).toBe(0)
		expect(adapter.latest(a)).toBe(1) // newest intent includes the draft
		await adapter.act(async () => {
			gate.resolve()
			await gate.promise
		})
		expect(text(container)).toBe('v:1;')
		expect(adapter.read(a)).toBe(1)
	})

	test('useIsPending(x) reports true while a transition write on x is pending', async () => {
		const { a, holdFlag, gate, Suspender } = makeHeld()
		const pendingSeen: boolean[] = []
		function Probe() {
			const p = adapter.useIsPending(a)
			pendingSeen.push(p)
			return <em>{p ? 'P' : 'i'};</em>
		}
		const { container } = await mount(
			<>
				<Probe />
				<React.Suspense fallback={<i>fb;</i>}>
					<Suspender />
				</React.Suspense>
			</>,
		)
		expect(text(container)).toBe('i;v:0;')
		await adapter.act(async () => {
			adapter.startTransitionWrite(() => {
				adapter.set(a, 1)
				adapter.set(holdFlag, true)
			})
		})
		// Newer data (the draft) exists behind the stale committed value.
		expect(text(container)).toBe('P;v:0;')
		await adapter.act(async () => {
			gate.resolve()
			await gate.promise
		})
		expect(text(container)).toBe('i;v:1;')
		expect(pendingSeen).toContain(true)
	})
})

describe('scenario 3 — urgent write during a live transition: commits alone, then rebased retirement', () => {
	test('update replay: urgent x*2 shows 2 now; retirement lands (1+1)*2 = 4', async () => {
		const a = adapter.atom(1)
		const holdFlag = adapter.atom(false)
		const gate = deferred<void>()
		function App() {
			const v = adapter.useValue(a)
			const h = adapter.useValue(holdFlag)
			if (h && !gate.settled) {
				throw gate.promise
			}
			return <span>v:{v}</span>
		}
		const { container } = await mount(
			<React.Suspense fallback={<i>fb</i>}>
				<App />
			</React.Suspense>,
		)
		expect(text(container)).toBe('v:1')
		await adapter.act(async () => {
			adapter.startTransitionWrite(() => {
				adapter.update(a, (x) => (x as number) + 1)
				adapter.set(holdFlag, true)
			})
		})
		expect(text(container)).toBe('v:1') // transition held, draft invisible
		await adapter.act(async () => {
			adapter.update(a, (x) => (x as number) * 2)
		})
		expect(text(container)).toBe('v:2') // urgent alone: 1*2, transition still excluded
		expect(adapter.read(a)).toBe(2)
		await adapter.act(async () => {
			gate.resolve()
			await gate.promise
		})
		// Updater-queue arithmetic: replay in scheduling order — (1+1)*2.
		expect(text(container)).toBe('v:4')
		expect(adapter.read(a)).toBe(4)
	})
})

describe('scenario 4 — sibling readers never tear within any commit', () => {
	test('pairs of reads agree in every render, including interleaved transitions', async () => {
		const a = adapter.atom(0)
		const observedPairs: Array<[unknown, unknown]> = []
		function Pair() {
			const v1 = adapter.useValue(a)
			const v2 = adapter.useValue(a)
			observedPairs.push([v1, v2])
			return (
				<span>
					{v1},{v2};
				</span>
			)
		}
		const { container } = await mount(
			<>
				<Pair />
				<Pair />
			</>,
		)
		await adapter.act(async () => {
			adapter.set(a, 1)
			adapter.startTransitionWrite(() => adapter.set(a, 2))
		})
		await adapter.act(async () => {})
		expect(text(container)).toBe('2,2;2,2;')
		for (const [v1, v2] of observedPairs) {
			expect(v1).toBe(v2)
		}
	})
})

describe('scenario 5 — mount mid-transition', () => {
	test('late mount shows committed value, then joins the transition commit; suspending pending state holds', async () => {
		const a = adapter.atom(0)
		const gate = deferred<void>()
		function Suspender() {
			const v = adapter.useValue(a)
			// Reads pending transition state (1) inside the transition render
			// and suspends — holding the transition without breaking it.
			if ((v as number) > 0 && !gate.settled) {
				throw gate.promise
			}
			return <span>s:{v};</span>
		}
		function App({ extra }: { extra: boolean }) {
			return (
				<>
					<Reader id="r1" atom={a} />
					<React.Suspense fallback={<span>fb;</span>}>
						<Suspender />
					</React.Suspense>
					{extra ? <Reader id="r2" atom={a} /> : null}
				</>
			)
		}
		const { root, container } = await mount(<App extra={false} />)
		expect(text(container)).toBe('r1:0;s:0;')
		await adapter.act(async () => {
			adapter.startTransitionWrite(() => adapter.set(a, 1))
		})
		expect(text(container)).toBe('r1:0;s:0;') // held: no fallback, no leak
		// A NEW component mounts urgently mid-transition: it must read the
		// COMMITTED world (0), never the pending draft (1).
		await adapter.act(async () => {
			root.render(<App extra={true} />)
		})
		expect(text(container)).toBe('r1:0;s:0;r2:0;')
		expect(text(container)).not.toContain(':1')
		await adapter.act(async () => {
			gate.resolve()
			await gate.promise
		})
		expect(text(container)).toBe('r1:1;s:1;r2:1;') // one consistent world
	})
})

describe('scenario 6 — flushSync excludes pending deferred work', () => {
	test('a synchronous urgent commit never carries the pending transition batch', async () => {
		const a = adapter.atom(0) // transition-written, held
		const b = adapter.atom(0) // urgent-written via flushSync
		const gate = deferred<void>()
		function Suspender() {
			const v = adapter.useValue(a)
			if ((v as number) > 0 && !gate.settled) {
				throw gate.promise
			}
			return <span>s:{v};</span>
		}
		const { container } = await mount(
			<>
				<Reader id="a" atom={a} />
				<Reader id="b" atom={b} />
				<React.Suspense fallback={null}>
					<Suspender />
				</React.Suspense>
			</>,
		)
		await adapter.act(async () => {
			adapter.startTransitionWrite(() => adapter.set(a, 9))
		})
		expect(text(container)).toBe('a:0;b:0;s:0;')
		await adapter.act(async () => {
			adapter.flushSync(() => adapter.set(b, 1))
			expect(text(container)).toBe('a:0;b:1;s:0;') // a's batch excluded
		})
		await adapter.act(async () => {
			gate.resolve()
			await gate.promise
		})
		expect(text(container)).toBe('a:9;b:1;s:9;')
	})
})

describe('scenario 7 — one transition batch spanning two roots: per-root consistency', () => {
	test('both roots converge; sibling readers agree within each root at every frame', async () => {
		const a = adapter.atom(0)
		const frames: string[][] = [[], []]
		const boxes: Array<{ el?: HTMLElement }> = [{}, {}]
		function TwoReaders({ i }: { i: number }) {
			const v1 = adapter.useValue(a)
			const v2 = adapter.useValue(a)
			React.useLayoutEffect(() => {
				if (boxes[i].el) {
					frames[i].push(text(boxes[i].el!))
				}
			})
			return (
				<span>
					{v1},{v2};
				</span>
			)
		}
		const one = await mount(<TwoReaders i={0} />)
		const two = await mount(<TwoReaders i={1} />)
		boxes[0].el = one.container
		boxes[1].el = two.container
		await adapter.act(async () => {
			adapter.startTransitionWrite(() => adapter.set(a, 1))
		})
		expect(text(one.container)).toBe('1,1;')
		expect(text(two.container)).toBe('1,1;')
		for (const f of [...frames[0], ...frames[1]]) {
			expect(f === '0,0;' || f === '1,1;').toBe(true) // never a torn frame
		}
	})

	test('a transition held on one root: the other commits; per-root committed views diverge then join', async () => {
		const a = adapter.atom(0)
		const gate = deferred<void>()
		function Suspender() {
			const v = adapter.useValue(a)
			if ((v as number) > 0 && !gate.settled) {
				throw gate.promise
			}
			return <span>s:{v};</span>
		}
		const one = await mount(
			<React.Suspense fallback={null}>
				<Suspender />
			</React.Suspense>,
		)
		const two = await mount(<Reader id="r" atom={a} />)
		await adapter.act(async () => {
			adapter.startTransitionWrite(() => adapter.set(a, 1))
		})
		// Root one holds (its render suspended); root two commits its slice.
		expect(text(one.container)).toBe('s:0;')
		expect(text(two.container)).toBe('r:1;')
		// Per-root committed views mirror each screen.
		expect(adapter.committed(a, one.container)).toBe(0)
		expect(adapter.committed(a, two.container)).toBe(1)
		await adapter.act(async () => {
			gate.resolve()
			await gate.promise
		})
		expect(text(one.container)).toBe('s:1;')
		expect(adapter.committed(a, one.container)).toBe(1)
	})
})

describe('scenario 8 — StrictMode: double-mount nets one subscription and one lifetime observation', () => {
	test('one observe across the double-mount; the subscription survives; unmount cleans up once', async () => {
		const log: string[] = []
		const a = adapter.atom(0)
		const observed = adapter.atom(0, {
			onObserved: () => {
				log.push('observe')
				return () => log.push('unobserve')
			},
		})
		function App() {
			return (
				<span>
					{adapter.useValue(a)}:{adapter.useValue(observed)}
				</span>
			)
		}
		const { root, container } = await mount(
			<React.StrictMode>
				<App />
			</React.StrictMode>,
		)
		await adapter.act(async () => {}) // let observe/unobserve flaps coalesce
		expect(log).toEqual(['observe'])
		await adapter.act(async () => {
			adapter.set(a, 2)
		})
		expect(text(container)).toBe('2:0') // subscription survived the simulated remount
		await adapter.act(async () => {
			root.render(null)
		})
		await adapter.act(async () => {})
		expect(log).toEqual(['observe', 'unobserve'])
	})
})

describe('scenario 9 — unmount: no further deliveries; subscriptions return to baseline', () => {
	test('writes after unmount deliver nothing; the lifetime observation is released', async () => {
		const log: string[] = []
		const a = adapter.atom(0, {
			onObserved: () => {
				log.push('observe')
				return () => log.push('unobserve')
			},
		})
		let renders = 0
		function View() {
			renders++
			return <span>{adapter.useValue(a)}</span>
		}
		const { root } = await mount(<View />)
		await adapter.act(async () => {})
		expect(log).toEqual(['observe'])
		await adapter.act(async () => {
			root.render(<div />)
		})
		await adapter.act(async () => {})
		expect(log).toEqual(['observe', 'unobserve']) // baseline restored
		const before = renders
		await adapter.act(async () => {
			adapter.set(a, 1)
			adapter.startTransitionWrite(() => adapter.set(a, 2))
		})
		await adapter.act(async () => {})
		expect(renders).toBe(before)
	})
})

describe('scenario 10 — write-during-render fails loudly', () => {
	test('a set() from a component body throws synchronously', async () => {
		const a = adapter.atom(0)
		let thrown: unknown
		function Bad() {
			const v = adapter.useValue(a)
			if (v === 0) {
				try {
					adapter.set(a, 1)
				} catch (err) {
					thrown = err
				}
			}
			return <span>{v}</span>
		}
		const { container } = await mount(<Bad />)
		expect(thrown).toBeTruthy()
		expect(text(container)).toBe('0')
	})
})

describe('scenario 11 — Suspense: first load, refresh, settlement-in-transition', () => {
	/** Resource idiom over the adapter surface: one request per (param, epoch)
	 * key. `epoch` lives outside the graph — the refresh helper bumps it and
	 * calls adapter.refresh, so a refresh with unchanged signal inputs still
	 * creates a fresh request. fetchCount counts REQUESTS (map misses), which
	 * is what "no refetch loop across Suspense retries" pins. */
	function makeResource(param: unknown) {
		let epoch = 0
		let fetchCount = 0
		const gates = new Map<string, ReturnType<typeof deferred<string>>>()
		const data = adapter.computed((use) => {
			const key = `${adapter.read(param)}:${epoch}`
			let g = gates.get(key)
			if (g === undefined) {
				g = deferred<string>()
				gates.set(key, g)
				fetchCount++
			}
			return use(g.promise)
		})
		return {
			data,
			fetchCount: () => fetchCount,
			refresh() {
				epoch++
				adapter.refresh(data)
			},
			async settle(key: string, v: string) {
				const g = gates.get(key)
				if (g === undefined) {
					throw new Error(`no request for key ${key}: ${[...gates.keys()]}`)
				}
				await adapter.act(async () => {
					g.resolve(v)
					await g.promise
					await Promise.resolve()
				})
			},
		}
	}

	function DataView({ data }: { data: unknown }) {
		return <span>d:{adapter.useValue(data)}</span>
	}

	test('first load: fallback, converge, fetch count stays 1 across retries', async () => {
		const param = adapter.atom(0)
		const r = makeResource(param)
		const { container } = await mount(
			<React.Suspense fallback={<i>loading</i>}>
				<DataView data={r.data} />
			</React.Suspense>,
		)
		expect(text(container)).toBe('loading')
		await r.settle('0:0', 'one')
		expect(text(container)).toBe('d:one')
		expect(r.fetchCount()).toBe(1) // stable thenable identity across retries
	})

	test('refresh: stale content + isPending, no fallback flash', async () => {
		const param = adapter.atom(0)
		const r = makeResource(param)
		const pendingFrames: string[] = []
		function Probe() {
			return <em>{adapter.useIsPending(r.data) ? 'P' : 'i'};</em>
		}
		const { container } = await mount(
			<>
				<Probe />
				<React.Suspense fallback={<i>loading</i>}>
					<DataView data={r.data} />
				</React.Suspense>
			</>,
		)
		await r.settle('0:0', 'one')
		expect(text(container)).toBe('i;d:one')
		await adapter.act(async () => {
			r.refresh()
		})
		pendingFrames.push(text(container))
		expect(text(container)).toBe('P;d:one') // stale serves; pending flips; no fallback
		expect(r.fetchCount()).toBe(2)
		await r.settle('0:1', 'two')
		expect(text(container)).toBe('i;d:two')
		for (const f of pendingFrames) {
			expect(f).not.toContain('loading')
		}
	})

	test('settlement inside a transition commits with the transition', async () => {
		const param = adapter.atom(0)
		const r = makeResource(param)
		const { container } = await mount(
			<React.Suspense fallback={<i>loading</i>}>
				<DataView data={r.data} />
			</React.Suspense>,
		)
		await r.settle('0:0', 'one')
		expect(text(container)).toBe('d:one')
		await adapter.act(async () => {
			adapter.startTransitionWrite(() => {
				adapter.set(param, 1)
				r.refresh() // refresh inside a transition belongs to that transition
			})
		})
		expect(text(container)).toBe('d:one') // held: stale stays, no fallback, no early commit
		await r.settle('1:1', 'TWO')
		expect(text(container)).toBe('d:TWO') // one settlement commit with the transition
	})
})

describe('scenario 12 — time slicing: urgent input stays responsive during a large transition', () => {
	test('an urgent flushSync commit lands while the transition render is mid-flight', async () => {
		const items = adapter.atom(0)
		const urgent = adapter.atom(0)
		let itemRenders = 0
		function SlowItem({ k }: { k: number }) {
			itemRenders++
			const end = performance.now() + 4
			while (performance.now() < end) {
				/* burn most of one 5ms slice so the list spans many slices */
			}
			return <i>{k},</i>
		}
		function List() {
			const n = adapter.useValue(items) as number
			const kids: any[] = []
			for (let k = 0; k < n; k++) {
				kids.push(<SlowItem key={k} k={k} />)
			}
			return (
				<div>
					n:{n};{kids}
				</div>
			)
		}
		function Input() {
			return <b>u:{adapter.useValue(urgent)};</b>
		}
		const { container } = await mount(
			<>
				<Input />
				<List />
			</>,
		)
		expect(text(container)).toBe('u:0;n:0;')
		// This scenario needs the REAL scheduler: updates run outside act.
		;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
		try {
			adapter.startTransitionWrite(() => adapter.set(items, 24))
			// Wait until the transition render is demonstrably mid-flight.
			const deadline = Date.now() + 5000
			while (itemRenders < 3 && Date.now() < deadline) {
				await tick(5)
			}
			expect(itemRenders).toBeGreaterThanOrEqual(3)
			expect(itemRenders).toBeLessThan(24) // work remains: interruption is real
			adapter.flushSync(() => adapter.set(urgent, 1))
			// The urgent commit landed now — mid-transition, which has not committed.
			expect(text(container)).toContain('u:1;')
			expect(text(container)).toContain('n:0;')
			const done = Date.now() + 15000
			while (!text(container).includes('n:24;') && Date.now() < done) {
				await tick(10)
			}
			expect(text(container)).toContain('n:24;') // the interrupted transition still lands
			expect(text(container)).toContain('u:1;')
		} finally {
			;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
		}
	})
})

describe('scenario 13 — branch state: urgent double over a pending transition', () => {
	test('counter at 1: urgent double shows 2 now, 6 after the transition lands; never 3, never 4', async () => {
		const a = adapter.atom(1)
		const holdFlag = adapter.atom(false)
		const gate = deferred<void>()
		const seen: unknown[] = []
		function Value() {
			const v = adapter.useValue(a)
			React.useLayoutEffect(() => {
				seen.push(v)
			})
			return <span>v:{v};</span>
		}
		function Holder() {
			const h = adapter.useValue(holdFlag)
			if (h && !gate.settled) {
				throw gate.promise
			}
			return null
		}
		const { container } = await mount(
			<>
				<Value />
				<React.Suspense fallback={null}>
					<Holder />
				</React.Suspense>
			</>,
		)
		expect(text(container)).toBe('v:1;')
		await adapter.act(async () => {
			adapter.startTransitionWrite(() => {
				adapter.update(a, (x) => (x as number) + 2)
				adapter.set(holdFlag, true)
			})
		})
		expect(text(container)).toBe('v:1;')
		await adapter.act(async () => {
			adapter.update(a, (x) => (x as number) * 2)
		})
		expect(text(container)).toBe('v:2;') // urgent double against committed 1
		await adapter.act(async () => {
			gate.resolve()
			await gate.promise
		})
		expect(text(container)).toBe('v:6;') // (1+2)*2 — replay, not reorder
		// Committed frames only ever showed 1 → 2 → 6.
		const collapsed = seen.filter((v, i) => i === 0 || v !== seen[i - 1])
		expect(collapsed).toEqual([1, 2, 6])
		expect(seen).not.toContain(3) // torn transition-only value
		expect(seen).not.toContain(4) // 4→6 reorder artifact
	})
})

describe('scenario 14 — lifetime effects: observation spans the union of subscriber kinds', () => {
	test('first React subscriber mounts the observation; last unmount cleans up; ctx can write', async () => {
		const log: string[] = []
		const a = adapter.atom(0, {
			onObserved: (ctx) => {
				log.push(`observe:${ctx.get()}`)
				ctx.set(42) // the socket idiom: data arrives while someone watches
				return () => log.push('unobserve')
			},
		})
		function App({ showA, showB }: { showA: boolean; showB: boolean }) {
			return (
				<>
					{showA ? <Reader id="A" atom={a} /> : null}
					{showB ? <Reader id="B" atom={a} /> : null}
				</>
			)
		}
		const { root, container } = await mount(<App showA={true} showB={true} />)
		await adapter.act(async () => {})
		expect(log).toEqual(['observe:0']) // two subscribers, ONE observation
		expect(text(container)).toBe('A:42;B:42;')
		await adapter.act(async () => {
			root.render(<App showA={false} showB={true} />)
		})
		await adapter.act(async () => {})
		expect(log).toEqual(['observe:0']) // still observed by B
		await adapter.act(async () => {
			root.render(<App showA={false} showB={false} />)
		})
		await adapter.act(async () => {})
		expect(log).toEqual(['observe:0', 'unobserve'])
	})

	test('engine effects count toward the union; same-tick flaps coalesce', async () => {
		const log: string[] = []
		const a = adapter.atom(0, {
			onObserved: () => {
				log.push('observe')
				return () => log.push('unobserve')
			},
		})
		const dispose1 = adapter.effect(() => {
			void adapter.read(a)
		})
		await tick()
		expect(log).toEqual(['observe'])
		// Unobserve/observe flap within one tick nets to nothing.
		dispose1()
		const dispose2 = adapter.effect(() => {
			void adapter.read(a)
		})
		await tick()
		expect(log).toEqual(['observe'])
		dispose2()
		await tick()
		expect(log).toEqual(['observe', 'unobserve'])
	})
})

describe('scenario 15 — causality: the trace explains re-renders after scenario 3', () => {
	test('urgent chain reaches a write; post-retirement chain reaches the retirement or write', async () => {
		const t = adapter.trace()
		const a = adapter.atom(1)
		const holdFlag = adapter.atom(false)
		const gate = deferred<void>()
		function App() {
			const v = adapter.useValue(a)
			const h = adapter.useValue(holdFlag)
			if (h && !gate.settled) {
				throw gate.promise
			}
			return <span>v:{v}</span>
		}
		const { container } = await mount(
			<React.Suspense fallback={<i>fb</i>}>
				<App />
			</React.Suspense>,
		)
		await adapter.act(async () => {
			adapter.startTransitionWrite(() => {
				adapter.update(a, (x) => (x as number) + 1)
				adapter.set(holdFlag, true)
			})
		})
		await adapter.act(async () => {
			adapter.update(a, (x) => (x as number) * 2)
		})
		expect(text(container)).toBe('v:2')
		const urgentChain = t.whyLastDelivery(a)
		expect(urgentChain.length).toBeGreaterThan(0)
		expect(urgentChain.join(' ')).toMatch(/write/i) // chains to the urgent write
		await adapter.act(async () => {
			gate.resolve()
			await gate.promise
		})
		expect(text(container)).toBe('v:4')
		const retiredChain = t.whyLastDelivery(a)
		expect(retiredChain.length).toBeGreaterThan(0)
		expect(retiredChain.join(' ')).toMatch(/retire|write/i) // chains through the retirement
		// Structural: every causal parent is an earlier, real event.
		const events = t.events()
		expect(events.length).toBeGreaterThan(0)
		const ids = new Set(events.map((e) => e.id))
		for (const e of events) {
			if (e.cause !== undefined) {
				expect(e.cause).toBeLessThan(e.id)
				expect(ids.has(e.cause)).toBe(true)
			}
		}
		t.stop()
	})
})

describe('scenario 16 — DOM mutation window: exact bracket around React DOM mutation', () => {
	test('a MutationObserver blinded during the window sees zero React mutations, all third-party ones', async () => {
		const a = adapter.atom(0)
		const { container } = await mount(<Reader id="r" atom={a} />)
		const leaked: MutationRecord[] = []
		const mo = new MutationObserver((records) => leaked.push(...records))
		const observe = () =>
			mo.observe(container, { childList: true, characterData: true, subtree: true })
		observe()
		const phases: string[] = []
		const off = adapter.onDomMutation((phase, c) => {
			phases.push(`${phase}:${c === container ? 'here' : 'other'}`)
			if (phase === 'start') {
				leaked.push(...mo.takeRecords()) // drain pre-window third-party noise
				mo.disconnect()
			} else {
				observe()
			}
		})
		await adapter.act(async () => {
			adapter.set(a, 1)
		})
		leaked.push(...mo.takeRecords())
		expect(text(container)).toBe('r:1;')
		expect(leaked).toEqual([]) // React mutated ONLY inside the window
		// The bracket fired for this root's commit, start-then-stop.
		const here = phases.filter((p) => p.endsWith(':here'))
		expect(here.length).toBeGreaterThanOrEqual(2)
		expect(here.length % 2).toBe(0)
		for (let i = 0; i < here.length; i += 2) {
			expect(here[i]).toBe('start:here')
			expect(here[i + 1]).toBe('stop:here')
		}
		// Third-party mutations are still observed (the observer reconnected).
		container.appendChild(document.createElement('div'))
		const thirdParty = mo.takeRecords()
		expect(thirdParty.length).toBeGreaterThan(0)
		mo.disconnect()
		off()
	})
})

describe('scenario 17 — lazy state initializers', () => {
	test('the initializer runs at first render read, exactly once', async () => {
		let runs = 0
		const a = adapter.atom((): number => {
			runs++
			return 7
		})
		expect(runs).toBe(0) // construction never materializes
		function App() {
			return <span>{adapter.useValue(a)}</span>
		}
		const { container } = await mount(<App />)
		expect(text(container)).toBe('7')
		expect(runs).toBe(1)
		await adapter.act(async () => {
			adapter.set(a, 8)
		})
		expect(text(container)).toBe('8')
		expect(runs).toBe(1)
	})

	test('a set before the first read still runs the initializer (the equality contract needs the base)', async () => {
		let runs = 0
		const a = adapter.atom((): number => {
			runs++
			return 1
		})
		adapter.set(a, 5)
		expect(runs).toBe(1) // ran at the write, before the new value applied
		expect(adapter.read(a)).toBe(5)
		expect(runs).toBe(1)
	})
})

describe('scenario 18 — SSR: serialize, install on a fresh engine, hydration-clean first render', () => {
	test('first client render matches with zero corrective re-renders; install skips initializers', async () => {
		if (typeof adapter.serialize !== 'function' || typeof adapter.initialize !== 'function') {
			// The ONLY scenario allowed to fail-as-skip, and only for a missing
			// serialize/initialize pair (still a required feature — scored missing).
			throw new Error(
				'SKIP scenario 18: adapter.serialize/adapter.initialize are absent — SSR is unimplemented for this entry',
			)
		}
		// "Server": commit values, then serialize with app-supplied (positional) keys.
		const s1 = adapter.atom(1)
		const s2 = adapter.atom('x')
		adapter.set(s1, 5)
		const json = adapter.serialize([s1, s2])
		// "Client": a fresh engine; install MUST NOT run lazy initializers
		// (install is not a write) and MUST make the first render exact.
		adapter.resetForTest()
		handle = adapter.register()
		let initRuns = 0
		const c1 = adapter.atom((): number => {
			initRuns++
			return 0
		})
		const c2 = adapter.atom('default')
		adapter.initialize(json, [c1, c2])
		expect(initRuns).toBe(0)
		let renders = 0
		function App() {
			renders++
			return (
				<span>
					{adapter.useValue(c1)}:{adapter.useValue(c2)}
				</span>
			)
		}
		const { container } = await mount(<App />)
		expect(text(container)).toBe('5:x')
		expect(renders).toBe(1) // zero corrective re-renders
		expect(initRuns).toBe(0) // the installed value satisfied the first read
	})
})
