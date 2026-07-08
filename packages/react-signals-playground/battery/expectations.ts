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

/** solid-react: a thrown promise (the gate harness) freezes all commits — its documented defer-write divergence. */
const GATE_FREEZE: Expectation = {
	kind: 'skip',
	reason: 'gate-freeze: thrown promises freeze all commits on defer-write (documented divergence)',
};

type PerImpl = Partial<Record<string, Expectation>>;

const TABLE: Record<string, PerImpl> = {
	'RCC-RT1.scope-read': {
		// Bare accessor inside its own transition scope reads the committed
		// value, not the staged write (pinned 2026-07-08).
		'solid-react': { kind: 'variant', variant: 'hidden-even-in-scope' },
	},
	'RCC-RT3.hold': { 'solid-react': GATE_FREEZE },
	'RCC-RT2.late-write': { 'solid-react': GATE_FREEZE },
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
	'RCC-RT6.mount-mid-count-hold': { 'solid-react': GATE_FREEZE },
	'RCC-UM2.render-write': {
		'solid-react': {
			kind: 'finding',
			note: 'render-phase writes are accepted silently — no guard in the bridge (pinned 2026-07-08)',
		},
	},
	'RCC-SU3.interleaved-gates': { 'solid-react': GATE_FREEZE },
	'RCC-AT2.post-await-urgent': { 'solid-react': GATE_FREEZE },
	'RCC-AT3.rejoin': { 'solid-react': GATE_FREEZE },
	'RCC-SP3.flushsync-hold': { 'solid-react': GATE_FREEZE },
	'RCC-PR2.quiet-then-defer': { 'solid-react': GATE_FREEZE },
	'RCC-EF1.count-hold': { 'solid-react': GATE_FREEZE },
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
	'FIND-THENABLE.gate': {
		'solid-react': {
			kind: 'finding',
			note: 'a thrown foreign thenable freezes all commits until it resolves, then React recovers with a sync render',
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
