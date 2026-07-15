import { useRef } from 'react'

/**
 * Compose the playground's split effect on an autorun-style bridge. The
 * handler stays inside the tracked body, preserving the bridge's cleanup
 * and dependency-array behavior.
 */
export function useSplitEffectFromAutorun<T>(
	useAutorunEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => void,
	compute: () => T,
	handler: (value: T, previous: T | undefined) => void | (() => void),
	deps?: readonly unknown[],
): void {
	const previous = useRef<T | undefined>(undefined)
	useAutorunEffect(() => {
		const value = compute()
		const cleanup = handler(value, previous.current)
		previous.current = value
		return cleanup
	}, deps)
}
