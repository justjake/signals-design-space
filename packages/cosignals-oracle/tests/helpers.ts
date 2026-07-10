/** Shared shorthand for the acceptance-battery and regression-schedule tests. */
import {
	CosignalModel,
	type AnyNode,
	type RenderPass,
	type Batch,
	type Watcher,
} from '../src/model.js'
import { checkInvariants } from '../src/invariants.js'

/** A model with the bridge registered during setup. */
export function concurrent(): CosignalModel {
	const m = new CosignalModel()
	return m
}

/** Mount a watcher on `node` via a clean committed render on `root` (no pending batches included). */
export function mountCommitted(
	m: CosignalModel,
	root: string,
	node: AnyNode,
	name: string,
): Watcher {
	const p = m.renderStart(root, [])
	const w = m.mountWatcher(p.id, node, name)
	m.renderEnd(p.id, 'commit')
	return w
}

/** Render `batch` on `root` (all watchers re-rendered), commit, and retire the batch. */
export function commitAndRetire(
	m: CosignalModel,
	root: string,
	batch: Batch,
	watchers: Watcher[] = [],
): void {
	const p = m.renderStart(root, [batch.id])
	for (const w of watchers) m.renderWatcher(p.id, w.id)
	m.renderEnd(p.id, 'commit', { retireAtCommit: [batch.id] })
}

/** Open a render pass including the given batches. */
export function openRender(m: CosignalModel, root: string, batches: Batch[]): RenderPass {
	return m.renderStart(
		root,
		batches.map((t) => t.id),
	)
}

/** Run the full invariant battery (used at the end of scenario tests). */
export function selfCheck(m: CosignalModel): void {
	checkInvariants(m)
}

export function set(value: unknown): { kind: 'set'; value: unknown } {
	return { kind: 'set', value }
}

export function update(fn: (p: unknown) => unknown): {
	kind: 'update'
	fn: (p: unknown) => unknown
} {
	return { kind: 'update', fn }
}
