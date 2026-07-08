/**
 * Per-implementation expected behavior, keyed by manifest row id
 * (battery/MANIFEST.md is the narrative contract; this table is its
 * executable form). Every non-`pass` entry was pinned empirically against
 * the four implementations on 2026-07-08 — discovery details in the
 * manifest rows.
 *
 * Reading: FINDING rows assert the divergence (test.fail), so a silent fix
 * turns the run red and the manifest gets updated. skip rows name the
 * mechanism that is unreachable on that implementation. variant rows tell
 * the spec which ruled behavior to assert.
 */
import type { test as batteryTest } from './fixtures';
import type { BatteryEntry } from './entries';

export type Expectation =
	| { kind: 'pass' }
	| { kind: 'finding'; note: string }
	| { kind: 'variant'; variant: string }
	| { kind: 'skip'; reason: string };

const PASS: Expectation = { kind: 'pass' };

// History note: the gate harness (thrown promises in transition renders)
// was expected to freeze solid-react's commits — its shim documents that
// divergence from an earlier engine snapshot. Retested 2026-07-08 against
// current sources (with the shim's memo degradation in place): the hold
// behaves exactly like the suspense implementations, so no gate row skips
// solid-react anymore and FIND-THENABLE.gate pins the working hold.

type PerImpl = Partial<Record<string, Expectation>>;

const TABLE: Record<string, PerImpl> = {
	'RCC-RT1.scope-read': {
		// Bare accessor inside its own transition scope reads the committed
		// value, not the staged write (pinned 2026-07-08).
		'solid-react': { kind: 'variant', variant: 'hidden-even-in-scope' },
	},
	'RCC-RT4-newest': {
		cosignals: { kind: 'variant', variant: 'newest' },
		'alt-a': { kind: 'skip', reason: 'ruled drafts-hidden (ambient-W0)' },
		'alt-b': { kind: 'skip', reason: 'ruled drafts-hidden (ambient-W0)' },
		'solid-react': { kind: 'skip', reason: 'discovered drafts-hidden (bare accessor)' },
	},
	'RCC-RT4-drafts-hidden': {
		cosignals: { kind: 'skip', reason: 'ruled newest (scenario R15)' },
		'alt-a': { kind: 'variant', variant: 'drafts-hidden' },
		'alt-b': { kind: 'variant', variant: 'drafts-hidden' },
		'solid-react': { kind: 'variant', variant: 'drafts-hidden (discovered, unruled)' },
	},
	'RCC-EF1.count-hold': {
		// Its tracked effects are held while a transition is live and flush at
		// the transition's commit (documented engine design): urgent-commit
		// flips reach effects late, at the boundary, with the boundary value.
		'solid-react': { kind: 'variant', variant: 'effects-held-during-transition' },
	},
	'RCC-UM2.render-write': {
		'solid-react': {
			kind: 'finding',
			note: 'render-phase writes are accepted silently — no guard in the bridge (pinned 2026-07-08)',
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
	'DAISHI-2': {
		'solid-react': {
			kind: 'finding',
			note: 'mount-under-urgent-fire commits a torn frame: readers resolve their slice-time worlds (2,3,4,5,6 in one painted commit; passive-visible, pinned 2026-07-08)',
		},
	},
	'DAISHI-8': {
		'solid-react': {
			kind: 'finding',
			note: 'useDeferredValue mount-under-urgent-fire commits torn frames — same slice-time world drift as DAISHI-2 (pinned 2026-07-08)',
		},
	},
};

export function expectationFor(rowId: string, entry: BatteryEntry): Expectation {
	return TABLE[rowId]?.[entry.label] ?? PASS;
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
	const expectation = expectationFor(rowId, entry);
	if (expectation.kind === 'skip') {
		t.skip(true, `${rowId}: ${expectation.reason}`);
	} else if (expectation.kind === 'finding') {
		t.fail(true, `FINDING ${rowId}: ${expectation.note}`);
	}
	return expectation;
}
