'use client'

import { SignalsFrameworkProvider, registerReactSignals } from 'signals-royale-fx2/react'

registerReactSignals()

export function Playground({ children }: { children?: React.ReactNode }) {
	return (
		<div className="fx2-playground">
			<SignalsFrameworkProvider>{children ?? 'Interactive example coming next.'}</SignalsFrameworkProvider>
		</div>
	)
}
