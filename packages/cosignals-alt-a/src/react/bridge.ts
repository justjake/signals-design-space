import * as React from 'react'
import { ReactBatchRegistry } from 'react-signals-utils'

import type { CosignalEngine, Container } from '../engine'
import type { ExternalRuntimeListener, ForkAdapter } from '../fork-double'

function currentTransitionScope(react: unknown): { gesture?: unknown } | null | undefined {
	return (
		react as {
			__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: {
				T?: { gesture?: unknown } | null
			}
		}
	).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?.T
}

export function assertForkPresent(react: unknown = React): asserts react is typeof React {
	const channel = (
		react as {
			__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: {
				E?: { forkProtocolVersion?: unknown } | null
			}
		}
	).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?.E
	if (channel?.forkProtocolVersion !== 1) {
		throw new Error(
			'cosignals-alt-a/react requires the patched React signals protocol; stock React is unsupported.',
		)
	}
}

export type ReactBridgeHandle = {
	engine: CosignalEngine
	readonly errors: unknown[]
	dispose(): void
}

/** Attach after loading react-dom/client and before creating a root. */
export function attachReactBridge(
	engine: CosignalEngine,
	react: unknown = React,
): ReactBridgeHandle {
	assertForkPresent(react)
	const registry = new ReactBatchRegistry(react)
	const errors = registry.errors
	let openContainer: unknown
	let passOpen = false

	const adapter: ForkAdapter = {
		subscribeToExternalRuntime(listener: ExternalRuntimeListener): () => void {
			try {
				listener.onRootRegistered?.('react-bridge')
			} catch (error) {
				errors.push(error)
			}
			return registry.subscribe({
				onRenderPassStart: (container, included) => {
					if (passOpen) {
						listener.onRenderPassEnd?.(openContainer)
					}
					passOpen = true
					openContainer = container
					listener.onRenderPassStart?.(container, included, 0)
				},
				onRenderPassYield: (container) => {
					if (passOpen && openContainer === container) {
						listener.onRenderPassYield?.(container)
					}
				},
				onRenderPassResume: (container) => {
					if (passOpen && openContainer === container) {
						listener.onRenderPassResume?.(container)
					}
				},
				onRenderPassEnd: (container) => {
					if (!passOpen || openContainer !== container) {
						return
					}
					passOpen = false
					listener.onRenderPassEnd?.(container)
				},
				onBatchRetired: (token, committed) => listener.onBatchRetired?.(token, committed),
				onRootCommitted: (container, tokens) => {
					for (const token of tokens) {
						listener.onBatchCommitted?.(container, token)
					}
				},
			})
		},
		isCurrentWriteDeferred(): boolean {
			const transition = currentTransitionScope(react)
			return transition !== null && transition !== undefined && !transition.gesture
		},
		getCurrentWriteBatch(): number {
			return registry.getCurrentWriteBatch()
		},
		getRenderContext(): { container: Container } | undefined {
			return registry.getRenderContext() ?? undefined
		},
		runInBatch(token: number, fn: () => void): boolean {
			registry.runInBatch(token, fn)
			return true
		},
	}

	const detachEngine = engine.attachFork(adapter)
	return {
		engine,
		errors,
		dispose(): void {
			detachEngine()
			registry.dispose()
		},
	}
}
