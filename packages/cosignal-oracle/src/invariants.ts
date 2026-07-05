/**
 * Self-check assertions, run after every step of every schedule. Each backs
 * one clause of the behavioral contract (stated in README.md):
 *
 * 1. fold determinism — evaluating any node twice in the same world agrees:
 *    folds and evaluations are pure, so a world's answer is a function of
 *    the schedule prefix, never of when you ask.
 * 2. tenancy orderings — the three sequence orderings that make slot
 *    recycling safe: an un-retired receipt bearing a slot belongs to the
 *    slot's current tenant (stamp-before-release), every previous tenant's
 *    retirement precedes the current claim (claim-after-release), and the
 *    current tenant's receipts and pins postdate the claim
 *    (pin/seq-after-claim). Together they let folds tell tenants apart by
 *    sequence alone.
 * 3. monotone sequence relations — tapes strictly increase, nothing exceeds
 *    the global counter, retirement stamps follow the writes they stamp.
 * 4. receipt-retention soundness — a pinned pass can always reconstruct its
 *    world: the base+tape fold equals the full-history
 *    (origin+archive+tape) fold for every live world, i.e. compaction never
 *    changed any live world's answer.
 * 5. quiescence residue is zero — whenever no live pins/tokens exist, every
 *    tape has fully compacted into its base.
 * 6. structural coherence — at most 31 live batches, slot↔token bindings
 *    agree both ways, per-root commit rows never name retired tokens (rows
 *    clear at retirement, before slot release), one open pass per root.
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
	for (const p of m.passes.values()) {
		if (p.state !== 'ended') worlds.push({ kind: 'pass', pass: p });
	}
	for (const root of m.roots.keys()) worlds.push({ kind: 'committed', root });
	return worlds;
}

function worldName(w: World): string {
	switch (w.kind) {
		case 'newest': return 'newest';
		case 'pass': return `pass#${w.pass.id}(pin ${w.pass.pin})`;
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
	return [...m.nodes.values()].filter((n): n is AtomNode => n.kind === 'atom');
}

/** Invariant 1 — evaluating any node twice in the same world agrees (purity). */
function checkFoldDeterminism(m: CosignalModel): void {
	for (const w of relevantWorlds(m)) {
		for (const n of m.nodes.values()) {
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
			for (const e of atom.tape) {
				if (e.slot !== slot.id) continue;
				if (e.retiredSeq === undefined) {
					// Stamp-before-release: un-retired entries bearing slot s belong to exactly its current tenant.
					if (tenant !== e.token) {
						fail(`tenancy: un-retired receipt (seq ${e.seq}, token ${e.token}) bears slot ${slot.id} owned by ${String(tenant)}`);
					}
				} else if (tenant !== undefined && tenant !== e.token) {
					// Claim-after-release: every retirement sequence of a previous tenant precedes the current claim.
					if (e.retiredSeq >= slot.claimSeq) {
						fail(`tenancy: old tenant ${e.token} retiredSeq ${e.retiredSeq} ≥ claim ${slot.claimSeq} of slot ${slot.id}`);
					}
				}
				if (tenant === e.token && e.seq <= slot.claimSeq) {
					// Pin/seq-after-claim: any receipt of the current tenant has a sequence above the claim.
					fail(`tenancy: tenant ${e.token} receipt seq ${e.seq} ≤ claim ${slot.claimSeq} of slot ${slot.id}`);
				}
			}
		}
		// Pin-after-claim: any open pass whose mask means the CURRENT tenant pinned after the claim.
		if (tenant !== undefined) {
			for (const p of m.passes.values()) {
				if (p.state === 'ended' || !p.maskTokens.has(tenant) || !p.maskSlots.has(slot.id)) continue;
				if (p.pin < slot.claimSeq) {
					fail(`tenancy: pass ${p.id} pinned at ${p.pin} but masks slot ${slot.id} claimed at ${slot.claimSeq}`);
				}
			}
		}
	}
}

/** Invariant 3 — monotone sequence relations. */
function checkMonotone(m: CosignalModel): void {
	for (const atom of atoms(m)) {
		let prev = atom.baseSeq;
		for (const e of atom.tape) {
			if (e.seq <= prev) fail(`monotone: tape of ${atom.name} not strictly increasing at seq ${e.seq}`);
			prev = e.seq;
			if (e.seq > m.seq) fail(`monotone: receipt seq ${e.seq} above the global counter ${m.seq}`);
			if (e.retiredSeq !== undefined && e.retiredSeq <= e.seq) {
				fail(`monotone: retiredSeq ${e.retiredSeq} ≤ write seq ${e.seq} on ${atom.name}`);
			}
			const tok = m.tokens.get(e.token);
			if (tok === undefined) fail(`receipt names unknown token ${e.token}`);
			if (tok.state === 'retired') {
				if (e.retiredSeq !== tok.retiredSeq) {
					fail(`retired token ${tok.id} has receipt with retiredSeq ${String(e.retiredSeq)} ≠ token stamp ${String(tok.retiredSeq)}`);
				}
			} else if (e.retiredSeq !== undefined) {
				fail(`live token ${tok.id} has a retirement-stamped receipt`);
			}
		}
	}
	for (const p of m.passes.values()) {
		if (p.pin > m.seq) fail(`pass ${p.id} pin ${p.pin} above global counter ${m.seq}`);
	}
	for (const t of m.tokens.values()) {
		if (t.parked && t.state === 'retired') fail(`token ${t.id} both parked and retired — parked tokens may not retire before settlement`);
	}
}

/** Invariant 4 — receipt-retention soundness: compaction never changed any live world's fold. */
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

/** Invariant 5 — with no live pins and no live tokens, every tape has compacted to base. */
function checkResidue(m: CosignalModel): void {
	if (!m.quiescent()) return;
	for (const atom of atoms(m)) {
		if (atom.tape.length > 0) {
			fail(`residue: quiescent but ${atom.name} retains ${atom.tape.length} receipts`);
		}
	}
}

/** Invariant 6 — structural coherence. */
function checkStructure(m: CosignalModel): void {
	let liveCount = 0;
	for (const t of m.tokens.values()) {
		if (t.state === 'live') liveCount++;
		if (t.slot !== undefined) {
			const s = m.slots[t.slot];
			if (s === undefined || s.tenant !== t.id) {
				fail(`slot binding: token ${t.id} claims slot ${t.slot} but the table disagrees`);
			}
		}
	}
	if (liveCount > 31) fail(`more than 31 live tokens (${liveCount})`);
	for (const root of m.roots.values()) {
		for (const tid of root.committedTokens) {
			const t = m.tokens.get(tid);
			if (t === undefined || t.state !== 'live') {
				fail(`per-root row for root ${root.id} names non-live token ${tid} — per-root rows must clear at retirement`);
			}
		}
	}
	const openByRoot = new Set<string>();
	for (const p of m.passes.values()) {
		if (p.state === 'ended') continue;
		if (openByRoot.has(p.root)) fail(`two open passes on root ${p.root}`);
		openByRoot.add(p.root);
	}
}
