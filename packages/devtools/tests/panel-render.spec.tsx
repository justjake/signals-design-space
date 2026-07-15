// @vitest-environment jsdom
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { createAtom, createComputed, effect, set } from 'signals-royale-fx2'
import { attachFx2Devtools } from '../src/fx2.ts'
import { mountDevtools } from '../src/panel/mount.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tick = () => act(async () => { await Promise.resolve() })

function clickButton(root: HTMLElement, label: string) {
	const btn = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
	if (btn === undefined) throw new Error(`no button labeled "${label}"`)
	return act(async () => { btn.click() })
}

describe('inline host renders and live-updates from fx2', () => {
	it('mounts the graph, switches to the log, and re-renders on new activity', async () => {
		const dt = attachFx2Devtools()
		const el = document.createElement('div')
		document.body.appendChild(el)
		let handle: { unmount(): void } | undefined
		try {
			const count = createAtom(1, { label: 'count' })
			const doubled = createComputed(() => count.get() * 2, { label: 'doubled' })
			effect(
				() => doubled.get(),
				() => {},
			)
			set(count, 5)

			await act(async () => {
				handle = mountDevtools(el, dt.collector)
			})

			// Graph is the default view: the base16 theme is inlined and the
			// discovered nodes are listed.
			expect(el.innerHTML).toContain('--base00') // base16 theme inlined
			expect(el.innerHTML).toContain('count')
			expect(el.innerHTML).toContain('doubled')

			// The log shows real entries with fx2's verbatim kind strings.
			await clickButton(el, 'Log')
			expect(el.innerHTML).toContain('set')
			expect(el.innerHTML).toContain('compute')
			expect(el.innerHTML).toContain('effect')

			const before = (el.textContent ?? '').match(/#\d+/g)?.length ?? 0

			// New engine activity → collector flush → panel re-renders live.
			set(count, 9)
			await tick()
			const after = (el.textContent ?? '').match(/#\d+/g)?.length ?? 0
			expect(after).toBeGreaterThan(before)
		} finally {
			if (handle) await act(async () => handle!.unmount())
			dt.detach()
		}
	})
})
