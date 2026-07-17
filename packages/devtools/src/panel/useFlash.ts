import { useEffect, useRef, useState } from 'react'

/**
 * Tracks which ids should be flashing and returns a per-id flash counter that
 * increments on every genuine version bump (e.g. a node's last-event id
 * advancing). Callers turn the counter's parity into one of two animation
 * classes (flash-a / flash-b): a one-shot CSS animation won't replay while its
 * class stays applied, so alternating the class name is what makes a spammed
 * update flash on *every* event instead of once. The animation ends transparent,
 * so a held class reads as un-flashed until the next bump flips it.
 *
 * A node's first appearance never flashes — only a real change does — so
 * revealing a node (relayout, search, expanding the frontier) or selecting one
 * doesn't flash it.
 */
export function useFlashOnChange(versions: Array<[number, number]>): ReadonlyMap<number, number> {
	const seen = useRef(new Map<number, number>())
	const [gen, setGen] = useState<ReadonlyMap<number, number>>(() => new Map())
	// Runs after every commit; compares versions against the last committed ones.
	useEffect(() => {
		const bumped: number[] = []
		for (const [id, v] of versions) {
			const prev = seen.current.get(id)
			if (prev !== undefined && v > prev) bumped.push(id)
			seen.current.set(id, v)
		}
		if (bumped.length === 0) return
		setGen((g) => {
			const next = new Map(g)
			for (const id of bumped) next.set(id, (next.get(id) ?? 0) + 1)
			return next
		})
	})
	return gen
}

/** The flash class for an id given its counter (from useFlashOnChange): two
 * alternating names so the animation restarts each bump; empty when never bumped. */
export function flashClass(gen: ReadonlyMap<number, number>, id: number): string {
	const c = gen.get(id)
	return c === undefined ? '' : c % 2 === 1 ? 'flash-a' : 'flash-b'
}
