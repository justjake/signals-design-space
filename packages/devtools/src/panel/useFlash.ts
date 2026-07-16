import { useEffect, useRef, useState } from 'react'

/**
 * Returns the set of ids whose version (e.g. last-event id) increased since the
 * previous commit, held for `durationMs` so a flash animation can play out.
 *
 * A node's first appearance never flashes — only a real change does — so
 * revealing a node (relayout, search, expanding the frontier) or selecting one
 * doesn't flash it. Only new activity does.
 *
 * Each flashing id owns its removal timer, kept in a ref. This effect has no
 * dependency array (it diffs against the previous commit's versions), so it
 * re-runs on every commit — a cleanup that cancelled the timer would be run by
 * the very re-render `setFlashing` triggers, and the flash would never clear.
 * Ref-held timers survive those re-runs; re-flashing an id resets its timer.
 */
export function useFlashOnChange(versions: Array<[number, number]>, durationMs = 800): Set<number> {
	const seen = useRef(new Map<number, number>())
	const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
	const [flashing, setFlashing] = useState<Set<number>>(() => new Set())
	useEffect(() => {
		const newly: number[] = []
		for (const [id, v] of versions) {
			const prev = seen.current.get(id)
			if (prev !== undefined && v > prev) newly.push(id)
			seen.current.set(id, v)
		}
		if (newly.length === 0) return
		setFlashing((f) => {
			const n = new Set(f)
			for (const id of newly) n.add(id)
			return n
		})
		for (const id of newly) {
			const prev = timers.current.get(id)
			if (prev !== undefined) clearTimeout(prev)
			timers.current.set(
				id,
				setTimeout(() => {
					timers.current.delete(id)
					setFlashing((f) => {
						const n = new Set(f)
						n.delete(id)
						return n
					})
				}, durationMs),
			)
		}
	})
	// Cancel pending timers on unmount so they don't set state on a gone component.
	useEffect(() => {
		const pending = timers.current
		return () => {
			for (const t of pending.values()) clearTimeout(t)
			pending.clear()
		}
	}, [])
	return flashing
}
