/**
 * The vanilla-React control page: the same patched React build the five
 * implementation entries run on, but ONLY React state — useState,
 * startTransition, Suspense, thrown promises. No signals engine loads and
 * register() is never called.
 *
 * Purpose: when all five implementations show the same behavior, this page
 * decides whether that behavior is React's own (reproduces here) or an
 * assumption every engine happens to share (does not reproduce here). The
 * battery's k1-host-control spec pins what this page does; entangle-class
 * rows in the manifest cite it.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'

interface ControlGate {
	status: 'idle' | 'pending'
	payload: Promise<void> | null
	settle: (() => void) | null
}

function createGate(): ControlGate {
	return { status: 'idle', payload: null, settle: null }
}

const gates: Record<'a' | 'b', ControlGate> = { a: createGate(), b: createGate() }

function openGate(gate: ControlGate): void {
	gate.status = 'pending'
	let resolve!: () => void
	// Created once per hold: re-renders re-throw the same reference.
	gate.payload = new Promise<void>((r) => {
		resolve = r
	})
	gate.settle = () => {
		gate.status = 'idle'
		resolve()
	}
}

export interface ControlHandles {
	/** startTransition(() => { valueA += 10; gate A suspends }) */
	holdA(): void
	/** startTransition(() => { valueB += 5; gate B suspends }) */
	holdB(): void
	releaseA(): void
	releaseB(): void
}

declare global {
	interface Window {
		__control: ControlHandles
	}
}

function GateView(props: { id: string; epoch: number; gate: ControlGate }): React.ReactElement {
	if (props.epoch > 0 && props.gate.status === 'pending') {
		// Suspend the transition render on the held promise, exactly like the
		// implementation pages' write-hold gates.
		throw props.gate.payload
	}
	return <span data-testid={`gate-${props.id}`} data-epoch={props.epoch} />
}

function ControlApp(): React.ReactElement {
	const [valueA, setValueA] = React.useState(0)
	const [epochA, setEpochA] = React.useState(0)
	const [valueB, setValueB] = React.useState(0)
	const [epochB, setEpochB] = React.useState(0)
	const [clock, setClock] = React.useState(0)

	React.useEffect(() => {
		const timer = window.setInterval(() => setClock(Math.round(performance.now())), 100)
		return () => window.clearInterval(timer)
	}, [])

	React.useEffect(() => {
		window.__control = {
			holdA() {
				openGate(gates.a)
				React.startTransition(() => {
					setValueA((value) => value + 10)
					setEpochA((epoch) => epoch + 1)
				})
			},
			holdB() {
				openGate(gates.b)
				React.startTransition(() => {
					setValueB((value) => value + 5)
					setEpochB((epoch) => epoch + 1)
				})
			},
			releaseA: () => gates.a.settle?.(),
			releaseB: () => gates.b.settle?.(),
		}
	}, [])

	return (
		<main>
			<h1>react control</h1>
			<p>
				Vanilla React on the same patched build: useState + startTransition + Suspense only. No
				signals engine loads on this page.
			</p>
			<span data-testid="impl-name">react-control</span>
			<span data-testid="control-clock">{clock}</span>
			<output data-testid="value-a">{valueA}</output>
			<output data-testid="value-b">{valueB}</output>
			<React.Suspense fallback={<span data-testid="gate-a-fallback">gate-a pending</span>}>
				<GateView id="a" epoch={epochA} gate={gates.a} />
			</React.Suspense>
			<React.Suspense fallback={<span data-testid="gate-b-fallback">gate-b pending</span>}>
				<GateView id="b" epoch={epochB} gate={gates.b} />
			</React.Suspense>
		</main>
	)
}

const container = document.getElementById('root')
if (container === null) {
	throw new Error('react-signals-playground control: missing #root container')
}
createRoot(container).render(<ControlApp />)
