// @vitest-environment jsdom
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { createAtom, createComputed, effect, set } from 'signals-royale-fx2'
import { attachFx2Devtools } from '../src/fx2.ts'
import { mountDevtools } from '../src/panel/mount.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tick = () => act(async () => { await Promise.resolve() })

describe('inline host renders and live-updates from fx2', () => {
	it('mounts, shows live entries, and re-renders on new engine activity', async () => {
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

			// The log shows real entries with fx2's verbatim kind strings.
			expect(el.innerHTML).toContain('count')
			expect(el.innerHTML).toContain('set')
			expect(el.innerHTML).toContain('compute')
			expect(el.innerHTML).toContain('effect')
			expect(el.innerHTML).toContain('--base00') // base16 theme inlined

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
