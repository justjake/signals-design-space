'use client'

import { Suspense, useState } from 'react'
import {
	batch,
	createAtom,
	createComputed,
	reducerAtom,
	type Atom,
	type Computed,
} from 'signals-royale-fx2'
import { initializeAtomState, serializeAtomState } from 'signals-royale-fx2/ssr'
import {
	SignalsFrameworkProvider,
	registerReactSignals,
	useAtom,
	useComputed,
	useIsPending,
	useSignalEffect,
	useSignalTransition,
	useValue,
} from 'signals-royale-fx2/react'
import { attachFx2Devtools } from 'signals-devtools/fx2'
import { App as DevtoolsPanel } from 'signals-devtools/panel'

registerReactSignals()
const { collector } = attachFx2Devtools()

export type PlaygroundName =
	| 'counter'
	| 'reducer'
	| 'batch-effect'
	| 'transition'
	| 'async'
	| 'lifecycle'
	| 'ssr'

export function Playground({ name }: { name: PlaygroundName }) {
	const [showDevtools, setShowDevtools] = useState(false)
	let demo: React.ReactNode
	let label: string

	switch (name) {
		case 'counter':
			label = 'Atom and computed'
			demo = <CounterDemo />
			break
		case 'reducer':
			label = 'Reducer atom'
			demo = <ReducerDemo />
			break
		case 'batch-effect':
			label = 'Batched effect'
			demo = <BatchEffectDemo />
			break
		case 'transition':
			label = 'Signal transition'
			demo = <TransitionDemo />
			break
		case 'async':
			label = 'Suspense and stale data'
			demo = <AsyncDemo />
			break
		case 'lifecycle':
			label = 'Observed lifecycle'
			demo = <LifecycleDemo />
			break
		case 'ssr':
			label = 'Serialized atom state'
			demo = <SsrDemo />
			break
	}

	return (
		<div className="fx2-playground">
			<div className="fx2-playground-heading">
				<strong>{label}</strong>
				<button type="button" onClick={() => setShowDevtools((open) => !open)}>
					{showDevtools ? 'Hide devtools' : 'Open devtools'}
				</button>
			</div>
			<SignalsFrameworkProvider>{demo}</SignalsFrameworkProvider>
			{showDevtools ? (
				<div className="fx2-devtools">
					<DevtoolsPanel backend={collector} />
				</div>
			) : null}
		</div>
	)
}

function CounterDemo() {
	const count = useAtom(0, { label: 'example:count' })
	const value = useValue(count)
	const doubled = useComputed(() => count.get() * 2, [count])
	return (
		<div className="fx2-demo-row">
			<button type="button" onClick={() => count.update((n) => n - 1)}>
				−
			</button>
			<output>count {value} · doubled {doubled}</output>
			<button type="button" onClick={() => count.update((n) => n + 1)}>
				+
			</button>
		</div>
	)
}

function ReducerDemo() {
	const [counter] = useState(() =>
		reducerAtom(
			(state: number, action: 'increment' | 'reset') =>
				action === 'increment' ? state + 1 : 0,
			0,
			{ label: 'example:reducer' },
		),
	)
	const value = useValue(counter)
	return (
		<div className="fx2-demo-row">
			<output>{value}</output>
			<button type="button" onClick={() => counter.dispatch('increment')}>Increment</button>
			<button type="button" onClick={() => counter.dispatch('reset')}>Reset</button>
		</div>
	)
}

function BatchEffectDemo() {
	const width = useAtom(2, { label: 'example:width' })
	const height = useAtom(3, { label: 'example:height' })
	const area = useComputed(() => width.get() * height.get(), [width, height])
	const [log, setLog] = useState('Waiting for a change.')
	useSignalEffect(
		() => ({
			watch: { width, height },
			label: 'example:dimensions-effect',
			run: ({ width: nextWidth, height: nextHeight }) => {
				setLog(`effect received ${nextWidth} × ${nextHeight}`)
			},
		}),
		[width, height],
	)
	return (
		<div className="fx2-demo-stack">
			<div className="fx2-demo-row">
				<output>{width.get()} × {height.get()} = {area}</output>
				<button
					type="button"
					onClick={() => batch(() => {
						width.update((n) => n + 1)
						height.update((n) => n + 1)
					})}
				>
					Grow both in one batch
				</button>
			</div>
			<small>{log}</small>
		</div>
	)
}

function TransitionDemo() {
	const count = useAtom(1, { label: 'example:transition-count' })
	const value = useValue(count)
	const [pending, start] = useSignalTransition()
	return (
		<div className="fx2-demo-row">
			<output>{value}{pending ? ' (transition pending)' : ''}</output>
			<button type="button" onClick={() => count.update((n) => n * 2)}>Urgent ×2</button>
			<button type="button" onClick={() => start(() => count.update((n) => n + 10))}>
				Transition +10
			</button>
		</div>
	)
}

const names = ['Ada', 'Grace', 'Linus', 'Margaret', 'Edsger']
const requests = new Map<number, Promise<string>>()

function requestName(id: number): Promise<string> {
	let request = requests.get(id)
	if (request === undefined) {
		request = new Promise((resolve) => {
			setTimeout(() => resolve(names[id % names.length]!), 700)
		})
		requests.set(id, request)
	}
	return request
}

function AsyncDemo() {
	const id = useAtom(0, { label: 'example:user-id' })
	const [user] = useState(() =>
		createComputed((use) => use(requestName(id.get())), { label: 'example:user' }),
	)
	const stale = useIsPending(user)
	const [transitionPending, start] = useSignalTransition()
	return (
		<div className="fx2-demo-row">
			<Suspense fallback={<output>Loading the first user…</output>}>
				<UserName user={user} />
			</Suspense>
			<button type="button" onClick={() => start(() => id.update((n) => n + 1))}>
				Next user
			</button>
			<small>{stale || transitionPending ? 'Loading newer data…' : 'Settled'}</small>
		</div>
	)
}

function UserName({ user }: { user: Computed<string> }) {
	return <output>{useValue(user)}</output>
}

function LifecycleDemo() {
	const [status, setStatus] = useState('disconnected')
	const [show, setShow] = useState(false)
	const value = useAtom(1, {
		label: 'example:lifecycle',
		onObserved: () => {
			setStatus('connected')
			return () => setStatus('disconnected')
		},
	})
	return (
		<div className="fx2-demo-row">
			<button type="button" onClick={() => setShow((visible) => !visible)}>
				{show ? 'Unmount subscriber' : 'Mount subscriber'}
			</button>
			{show ? <ObservedValue value={value} /> : null}
			<small>resource: {status}</small>
		</div>
	)
}

function ObservedValue({ value }: { value: Atom<number> }) {
	return <output>value {useValue(value)}</output>
}

function SsrDemo() {
	const name = useAtom('Ada', { label: 'example:ssr-name' })
	const visits = useAtom(1, { label: 'example:ssr-visits' })
	const currentName = useValue(name)
	const currentVisits = useValue(visits)
	const serialized = serializeAtomState({ name, visits })
	const [restored, setRestored] = useState('Not restored yet.')
	return (
		<div className="fx2-demo-stack">
			<div className="fx2-demo-row">
				<input aria-label="Name" value={currentName} onChange={(event) => name.set(event.target.value)} />
				<button type="button" onClick={() => visits.update((n) => n + 1)}>
					Visits: {currentVisits}
				</button>
				<button
					type="button"
					onClick={() => {
						const restoredName = createAtom('')
						const restoredVisits = createAtom(0)
						initializeAtomState(serialized, { name: restoredName, visits: restoredVisits })
						setRestored(`${restoredName.get()} · ${restoredVisits.get()} visits`)
					}}
				>
					Restore into fresh atoms
				</button>
			</div>
			<code>{serialized}</code>
			<small>{restored}</small>
		</div>
	)
}
