/** Shared shorthand for the acceptance-battery and regression-schedule tests. */
import { CosignalModel, type AnyNode, type Pass, type Token, type Watcher } from '../src/model.js';
import { checkInvariants } from '../src/invariants.js';

/** A model in concurrent mode — the bridge is registered during setup. */
export function concurrent(): CosignalModel {
	const m = new CosignalModel();
	m.registerBridge();
	return m;
}

/** Mount a watcher on `node` via a clean committed render on `root` (no pending batches included). */
export function mountCommitted(m: CosignalModel, root: string, node: AnyNode, name: string): Watcher {
	const p = m.passStart(root, []);
	const w = m.mountWatcher(p.id, node, name);
	m.passEnd(p.id, 'commit');
	return w;
}

/** Render `token`'s pass on `root` (all watchers re-rendered), commit, and retire the token. */
export function commitAndRetire(m: CosignalModel, root: string, token: Token, watchers: Watcher[] = []): void {
	const p = m.passStart(root, [token.id]);
	for (const w of watchers) m.renderWatcher(p.id, w.id);
	m.passEnd(p.id, 'commit', { retireAtCommit: [token.id] });
}

/** Open a pass including the given tokens. */
export function pass(m: CosignalModel, root: string, tokens: Token[]): Pass {
	return m.passStart(root, tokens.map((t) => t.id));
}

/** Run the full invariant battery (used at the end of scenario tests). */
export function selfCheck(m: CosignalModel): void {
	checkInvariants(m);
}

export function set(value: unknown): { kind: 'set'; value: unknown } {
	return { kind: 'set', value };
}

export function update(fn: (p: unknown) => unknown): { kind: 'update'; fn: (p: unknown) => unknown } {
	return { kind: 'update', fn };
}
