/**
 * The battery's view of the five implementations. Segments, labels, and
 * shim names come straight from the app's own implementation table
 * (src/shims/implementations.ts), so a new implementation row automatically
 * becomes a candidate battery project.
 *
 * `holdStyle` is declared here rather than imported: each shim declares its
 * TransitionHoldStyle in its own module, and importing those modules in Node would initialize the
 * engines. The smoke spec verifies this table against the running page
 * (window.__store.holdStyle under ?test=1), so drift fails loudly.
 */
import { implementationHref, implementations } from '../src/shims/implementations'

export type HoldStyle = 'suspense' | 'defer-write'

export interface BatteryEntry {
	/** Playwright project name; also the app tab label. */
	readonly label: string
	/** Shim `name` — the impl-name HUD tile must show exactly this. */
	readonly name: string
	/** Page path for this implementation ('/royale-fx2/', '/alt-a/', ...). */
	readonly path: string
	/** How this implementation holds a transition open on async data. */
	readonly holdStyle: HoldStyle
}

const HOLD_STYLES: Record<string, HoldStyle> = {
	cosignals: 'suspense',
	'alt-a': 'suspense',
	'alt-b': 'suspense',
	'solid-react': 'defer-write',
	'royale-fx2': 'suspense',
	'royale-fx2-dalien': 'suspense',
}

export const ENTRIES: readonly BatteryEntry[] = implementations.map((impl) => {
	const holdStyle = HOLD_STYLES[impl.label]
	if (holdStyle === undefined) {
		throw new Error(
			`battery/entries.ts has no holdStyle for implementation "${impl.label}" — ` +
				'add it here and to the expectations table',
		)
	}
	return {
		label: impl.label,
		name: impl.name,
		path: implementationHref(impl),
		holdStyle,
	}
})
