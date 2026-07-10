import 'react'

declare module 'react' {
	interface StrataRuntimeCallbacks {
		begin(root: object, container: object, lanes: number, remainingLanes: number): void
		abort(root: object, remainingLanes: number): void
		pause(root: object): void
		end(root: object, committed: boolean, lanes: number, remainingLanes: number): void
		current(): unknown
		reset(): void
		mutation(active: boolean, container: Element): void
	}

	interface StrataBridge {
		register(runtime: StrataRuntimeCallbacks): () => void
		write<T>(fn: (lane: number, deferred: boolean) => T): T
		run<T>(lane: number, fn: () => T): T
		urgent<T>(fn: () => T): T
		current(): unknown
	}

	export const unstable_strata: StrataBridge
}
