/**
 * Per-implementation expected behavior, keyed by manifest row id
 * (battery/MANIFEST.md is the narrative contract; this table is its
 * executable form). Every non-`pass` entry was pinned empirically against
 * the original four implementations on 2026-07-08, plus royale-fx2 on
 * 2026-07-13 — discovery details in the
 * manifest rows.
 *
 * Reading: FINDING rows assert the divergence (test.fail), so a silent fix
 * turns the run red and the manifest gets updated. skip rows name the
 * mechanism that is unreachable on that implementation. variant rows tell
 * the spec which ruled behavior to assert.
 */
import type { test as batteryTest } from './fixtures'
import type { BatteryEntry } from './entries'

export type Expectation =
	| { kind: 'pass' }
	| { kind: 'finding'; note: string }
	| { kind: 'variant'; variant: string }
	| { kind: 'skip'; reason: string }

const PASS: Expectation = { kind: 'pass' }

// History note: the gate harness (thrown promises in transition renders)
// was expected to freeze solid-react's commits — its shim documents that
// divergence from an earlier engine snapshot. Retested 2026-07-08 against
// current sources (with the shim's memo degradation in place): the hold
// behaves exactly like the suspense implementations, so no gate row skips
// solid-react anymore and FIND-THENABLE.gate pins the working hold.

type PerImpl = Partial<Record<string, Expectation>>

const TABLE: Record<string, PerImpl> = {
	// RCC-RT1.scope-read: solid-react's bare accessor used to resolve
	// committed state even inside the scope that staged the write; fixed
	// 2026-07-08 (ambient-scope world resolver) — it now follows the
	// ambient-W0 branch like alt-a/alt-b.
	'RCC-RT1.scope-read': {
		'royale-fx2': { kind: 'variant', variant: 'scope-drafts-hidden' },
	},
	'RCC-RT4-newest': {
		cosignals: { kind: 'variant', variant: 'newest' },
		'alt-a': { kind: 'skip', reason: 'ruled drafts-hidden (ambient-W0)' },
		'alt-b': { kind: 'skip', reason: 'ruled drafts-hidden (ambient-W0)' },
		'solid-react': { kind: 'skip', reason: 'ruled drafts-hidden (documented in package README)' },
		'royale-fx2': { kind: 'skip', reason: 'drafts are hidden from outside-render reads' },
	},
	'RCC-RT4-drafts-hidden': {
		cosignals: { kind: 'skip', reason: 'ruled newest (scenario R15)' },
		'alt-a': { kind: 'variant', variant: 'drafts-hidden' },
		'alt-b': { kind: 'variant', variant: 'drafts-hidden' },
		'solid-react': { kind: 'variant', variant: 'drafts-hidden (ruled; README-documented)' },
		'royale-fx2': { kind: 'variant', variant: 'drafts-hidden' },
	},
	// RCC-EF1.count-hold: solid-react's tracked effects previously deferred
	// urgent-commit runs until an unrelated held transition ended; fixed
	// 2026-07-08 (world-split effect delivery) — effects now run at every
	// commit that changes committed state, like the other implementations.
	// RCC-UM2.render-write: solid-react accepted render-phase writes
	// silently; fixed 2026-07-08 (bridge rejects writes while React render
	// is on the callstack).
	'RCC-UM2.render-write': {
		'royale-fx2': {
			kind: 'finding',
			note: 'throws during render, but the shared atom is mutated before the guard rejects the write',
		},
	},
	'DAISHI-2': {
		'royale-fx2': {
			kind: 'finding',
			note: 'readers mounted during urgent interval writes can paint values from different commits',
		},
	},
	'DAISHI-8': {
		'royale-fx2': {
			kind: 'finding',
			note: 'deferred readers mounted during urgent interval writes can paint values from different commits',
		},
	},
	'FIND-ALTB-WEDGE.filter': {
		'alt-b': {
			kind: 'finding',
			note: 'value-changing derived write during a held transition wedges the main thread in an update loop',
		},
	},
	'FIND-ALTB-WEDGE.rows': {
		'alt-b': {
			kind: 'finding',
			note: 'add-rows during a held transition wedges the main thread (same class as the filter wedge)',
		},
	},
	// FIND-THENABLE.gate: the solid-react freeze did not reproduce on
	// retest (2026-07-08); the row now pins the working hold on all four.
	// DAISHI-2/DAISHI-8: solid-react's torn mounted frames (readers
	// resolving slice-time worlds) fixed 2026-07-08 — the bridge pins each
	// node's first-read value per render pass, and the commit fixup corrects
	// staleness pre-paint.
}

export function expectationFor(rowId: string, entry: BatteryEntry): Expectation {
	return TABLE[rowId]?.[entry.label] ?? PASS
}

/**
 * Standard row prologue: applies skip/fail annotations for this
 * implementation and hands back the expectation so the spec can branch on
 * variants. FINDING rows become test.fail — the assertions below then
 * describe the CORRECT behavior, and the finding keeps the row red-as-expected.
 */
export function applyExpectation(
	t: typeof batteryTest,
	rowId: string,
	entry: BatteryEntry,
): Expectation {
	const expectation = expectationFor(rowId, entry)
	if (expectation.kind === 'skip') {
		t.skip(true, `${rowId}: ${expectation.reason}`)
	} else if (expectation.kind === 'finding') {
		t.fail(true, `FINDING ${rowId}: ${expectation.note}`)
	}
	return expectation
}
