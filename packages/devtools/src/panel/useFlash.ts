import { useEffect, useRef, useState } from 'react'

/**
 * Returns the set of ids whose version (e.g. last-event id) increased since the
 * previous commit, held for `durationMs` so a flash animation can play out.
 *
 * A node's first appearance never flashes — only a real change does — so
 * revealing a node (relayout, search, expanding the frontier) or selecting one
 * doesn't flash it. Only new activity does.
 */
export function useFlashOnChange(versions: Array<[number, number]>, durationMs = 800): Set<number> {
	const seen = useRef(new Map<number, number>())
	const [flashing, setFlashing] = useState<Set<number>>(() => new Set())
	// Runs after every commit; compares versions against the last committed ones.
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
		const t = setTimeout(() => {
			setFlashing((f) => {
				const n = new Set(f)
				for (const id of newly) n.delete(id)
				return n
			})
		}, durationMs)
		return () => clearTimeout(t)
	})
	return flashing
}
