/**
 * Self-check assertions, run after every step of every schedule. Each backs
 * one clause of the behavioral contract (stated in README.md):
 *
 * 1. fold determinism — evaluating any node twice in the same world agrees:
 *    folds (replays of a world's visible log entries over the atom's base —
 *    README vocabulary) and evaluations are pure, so a world's answer is a
 *    function of the schedule prefix, never of when you ask.
 * 2. tenancy orderings — the three sequence orderings that make slot
 *    recycling safe: an un-retired log entry bearing a slot belongs to the
 *    slot's current tenant (stamp-before-release), every previous tenant's
 *    retirement precedes the current claim (claim-after-release), and the
 *    current tenant's log entries and pins postdate the claim
 *    (pin/seq-after-claim). Together they let folds tell tenants apart by
 *    sequence alone.
 * 3. monotone sequence relations — write logs strictly increase, nothing exceeds
 *    the global counter, retirement stamps follow the writes they stamp.
 * 4. log-entry retention soundness — a pinned render can always reconstruct its
 *    world: the base+log fold equals the full-history
 *    (origin+archive+log) fold for every live world, i.e. compaction never
 *    changed any live world's answer.
 * 5. quiescence residue is zero — whenever no live pins/batches exist, every
 *    write log has fully compacted into its base.
 * 6. structural coherence — at most 31 live batches, slot↔batch bindings
 *    agree both ways, per-root commit rows never name retired batches (rows
 *    clear at retirement, before slot release), one open render per root.
 */

import {
	CosignalModel,
	InvariantViolation,
	type AtomNode,
	type World,
} from './model.js';

function fail(msg: string): never {
	throw new InvariantViolation(msg);
}

/** Every world the model can currently name. */
export function relevantWorlds(m: CosignalModel): World[] {
	const worlds: World[] = [{ kind: 'newest' }];
	for (const p of m.idToRenderPass.values()) {
		if (p.state !== 'ended') worlds.push({ kind: 'render', render: p });
	}
	for (const root of m.roots.keys()) worlds.push({ kind: 'committed', root });
	return worlds;
}

function worldName(w: World): string {
	switch (w.kind) {
		case 'newest': return 'newest';
		case 'render': return `render#${w.render.id}(pin ${w.render.pin})`;
		case 'committed': return `committed(${w.root})`;
		case 'mountFix': return 'mountFix';
	}
}

export function checkInvariants(m: CosignalModel): void {
	checkFoldDeterminism(m);
	checkTenancy(m);
	checkMonotone(m);
	checkRetention(m);
	checkResidue(m);
	checkStructure(m);
}

function atoms(m: CosignalModel): AtomNode[] {
	return [...m.idToNode.values()].filter((n): n is AtomNode => n.kind === 'atom');
}

/** Invariant 1 — evaluating any node twice in the same world agrees (purity). */
function checkFoldDeterminism(m: CosignalModel): void {
	for (const w of relevantWorlds(m)) {
		for (const n of m.idToNode.values()) {
			const a = m.evaluate(n, w);
			const b = m.evaluate(n, w);
			if (!Object.is(a, b)) {
				fail(`fold determinism: ${n.name} in ${worldName(w)} gave ${String(a)} then ${String(b)}`);
			}
		}
	}
}

/** Invariant 2 — the tenancy orderings that make slot recycling safe. */
function checkTenancy(m: CosignalModel): void {
	for (const slot of m.slots) {
		const tenant = slot.tenant;
		for (const atom of atoms(m)) {
			for (const e of atom.log) {
				if (e.slot !== slot.id) continue;
				if (e.retiredSeq === undefined) {
					// Stamp-before-release: un-retired entries bearing slot s belong to exactly its current tenant.
					if (tenant !== e.batch) {
						fail(`tenancy: un-retired log entry (seq ${e.seq}, batch ${e.batch}) bears slot ${slot.id} owned by ${String(tenant)}`);
					}
				} else if (tenant !== undefined && tenant !== e.batch) {
					// Claim-after-release: every retirement sequence of a previous tenant precedes the current claim.
					if (e.retiredSeq >= slot.claimSeq) {
						fail(`tenancy: old tenant ${e.batch} retiredSeq ${e.retiredSeq} ≥ claim ${slot.claimSeq} of slot ${slot.id}`);
					}
				}
				if (tenant === e.batch && e.seq <= slot.claimSeq) {
					// Pin/seq-after-claim: any log entry of the current tenant has a sequence above the claim.
					fail(`tenancy: tenant ${e.batch} log entry seq ${e.seq} ≤ claim ${slot.claimSeq} of slot ${slot.id}`);
				}
			}
		}
		// Pin-after-claim: any open render whose mask means the CURRENT tenant pinned after the claim.
		if (tenant !== undefined) {
			for (const p of m.idToRenderPass.values()) {
				if (p.state === 'ended' || !p.maskBatches.has(tenant) || !p.maskSlots.has(slot.id)) continue;
				if (p.pin < slot.claimSeq) {
					fail(`tenancy: render pass ${p.id} pinned at ${p.pin} but masks slot ${slot.id} claimed at ${slot.claimSeq}`);
				}
			}
		}
	}
}

/** Invariant 3 — monotone sequence relations. */
function checkMonotone(m: CosignalModel): void {
	for (const atom of atoms(m)) {
		let prev = atom.baseSeq;
		for (const e of atom.log) {
			if (e.seq <= prev) fail(`monotone: write log of ${atom.name} not strictly increasing at seq ${e.seq}`);
			prev = e.seq;
			if (e.seq > m.seq) fail(`monotone: log entry seq ${e.seq} above the global counter ${m.seq}`);
			if (e.retiredSeq !== undefined && e.retiredSeq <= e.seq) {
				fail(`monotone: retiredSeq ${e.retiredSeq} ≤ write seq ${e.seq} on ${atom.name}`);
			}
			const batch = m.idToBatch.get(e.batch);
			if (batch === undefined) fail(`log entry names unknown batch ${e.batch}`);
			if (batch.state === 'retired') {
				if (e.retiredSeq !== batch.retiredSeq) {
					fail(`retired batch ${batch.id} has log entry with retiredSeq ${String(e.retiredSeq)} ≠ batch stamp ${String(batch.retiredSeq)}`);
				}
			} else if (e.retiredSeq !== undefined) {
				fail(`live batch ${batch.id} has a retirement-stamped log entry`);
			}
		}
	}
	for (const p of m.idToRenderPass.values()) {
		if (p.pin > m.seq) fail(`render pass ${p.id} pin ${p.pin} above global counter ${m.seq}`);
	}
	for (const t of m.idToBatch.values()) {
		if (t.parked && t.state === 'retired') fail(`batch ${t.id} both parked and retired — parked batches may not retire before settlement`);
	}
}

/** Invariant 4 — log-entry retention soundness: compaction never changed any live world's fold. */
function checkRetention(m: CosignalModel): void {
	for (const w of relevantWorlds(m)) {
		for (const atom of atoms(m)) {
			const folded = m.foldAtom(atom, w);
			const shadow = m.shadowFoldAtom(atom, w);
			if (!Object.is(folded, shadow)) {
				fail(`retention: ${atom.name} in ${worldName(w)} folds ${String(folded)} but full history says ${String(shadow)}`);
			}
		}
	}
}

/** Invariant 5 — with no live pins and no live batches, every write log has compacted to base. */
function checkResidue(m: CosignalModel): void {
	if (!m.quiescent()) return;
	for (const atom of atoms(m)) {
		if (atom.log.length > 0) {
			fail(`residue: quiescent but ${atom.name} retains ${atom.log.length} log entries`);
		}
	}
}

/** Invariant 6 — structural coherence. */
function checkStructure(m: CosignalModel): void {
	let liveCount = 0;
	for (const t of m.idToBatch.values()) {
		if (t.state === 'live') liveCount++;
		if (t.slot !== undefined) {
			const s = m.slots[t.slot];
			if (s === undefined || s.tenant !== t.id) {
				fail(`slot binding: batch ${t.id} claims slot ${t.slot} but the table disagrees`);
			}
		}
	}
	if (liveCount > 31) fail(`more than 31 live batches (${liveCount})`);
	for (const root of m.roots.values()) {
		for (const tid of root.committedBatches) {
			const t = m.idToBatch.get(tid);
			if (t === undefined || t.state !== 'live') {
				fail(`per-root row for root ${root.id} names non-live batch ${tid} — per-root rows must clear at retirement`);
			}
		}
	}
	const openByRoot = new Set<string>();
	for (const p of m.idToRenderPass.values()) {
		if (p.state === 'ended') continue;
		if (openByRoot.has(p.root)) fail(`two open renders on root ${p.root}`);
		openByRoot.add(p.root);
	}
}
