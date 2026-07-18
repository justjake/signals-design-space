/**
 * Root creation for engine pages: a plain React root whose tree is wrapped
 * in the engine's CosignalsProvider (subscribing hooks require one provider
 * at the top of each root). main.tsx uses it for the page root; the
 * testkit uses it for the battery's second-root scenarios.
 */
import * as React from "react"
import { createRoot as createReactRoot } from "react-dom/client"
import { CosignalsProvider } from "#engine"

export interface AppRoot {
  render(node: React.ReactNode): void
  unmount(): void
}

export function createAppRoot(container: Element): AppRoot {
  const root = createReactRoot(container)
  return {
    render(node: React.ReactNode) {
      root.render(<CosignalsProvider>{node}</CosignalsProvider>)
    },
    unmount() {
      root.unmount()
    },
  }
}
