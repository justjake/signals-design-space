/**
 * `cosignals/graphviz` — the DOT renderers of the diagnostics story. Both
 * functions emit DOT source (render with `dot -Tsvg`). Layering is strict:
 * `cosignals/trace` records without importing any visualizer, and this entry
 * imports ONLY TYPES from the trace and engine modules — its runtime module
 * graph is exactly {graphviz.ts}; either diagnostics entry loads without
 * the other.
 *
 *  - `dependencyGraphToDot(bridge)` — a snapshot of the live dependency
 *    graph: atoms (annotated with how many log entries their history currently
 *    holds), computeds, the dependency edges the live per-world arenas
 *    currently hold (the structure the routing walks consult — links follow
 *    each world's latest evaluations and persist with their arenas), and
 *    live watchers and effects with their observation edges. Diffing two
 *    dumps is the workhorse for wiring bugs.
 *  - `traceToDot(events, filter?)` — the causal graph of a decoded trace
 *    (CAUSE edges: write → delivery → correction chains), one node per
 *    event, clustered by nothing (time flows top to bottom).
 *
 * Rendered-label glossary:
 *  - box = atom; ellipse = computed; house = watcher (one subscribed UI
 *    component); cds = subscription (a committed-world effect record).
 *  - `log:N` = N recorded writes not yet folded into the atom's base value.
 *  - solid edge = dependency; dashed = watcher's node; dotted = effect dep.
 */

import type { CosignalEngine } from './concurrent.js';
import type { TraceRecord, TraceKind } from './trace.js';

/** Escape + quote a string as a DOT-source string literal. */
function quoteDotString(s: string): string {
	return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Snapshot of the live dependency graph: nodes, recorded dependency edges, observers. */
export function dependencyGraphToDot(bridge: CosignalEngine): string {
	const lines: string[] = ['digraph cosignals {', '\trankdir=LR;', '\tnode [fontname="monospace"];'];
	for (const n of bridge.idToNode.values()) {
		if (n.kind === 'atom') {
			const log = n.log.length > 0 ? `|log:${n.log.length}` : '';
			lines.push(`\tn${n.id} [shape=box, label=${quoteDotString(`${n.name}#${n.id}${log}`)}];`);
		} else {
			lines.push(`\tn${n.id} [shape=ellipse, label=${quoteDotString(`${n.name}#${n.id}`)}];`);
		}
	}
	for (const [dep, outs] of bridge.dependencyEdges) {
		for (const out of outs) lines.push(`\tn${dep} -> n${out};`);
	}
	for (const w of bridge.watchers.values()) {
		if (!w.live) continue;
		lines.push(`\tw${w.id} [shape=house, label=${quoteDotString(`${w.name}@${w.root}`)}];`);
		lines.push(`\tn${w.node} -> w${w.id} [style=dashed];`);
	}
	for (const sub of bridge.idToSubscription.values()) {
		lines.push(`\te${sub.id} [shape=cds, label=${quoteDotString(`${sub.name}@${sub.root} runs:${sub.runs}`)}];`);
		for (const d of sub.deps) lines.push(`\tn${d.node.id} -> e${sub.id} [style=dotted];`);
	}
	lines.push('}');
	return lines.join('\n');
}

/** The causal graph of a decoded trace slice; `filter` keeps matching events only. */
export function traceToDot(events: TraceRecord[], filter?: (e: TraceRecord) => boolean): string {
	const kept = filter === undefined ? events : events.filter(filter);
	const ids = new Set(kept.map((e) => e.id));
	const lines: string[] = ['digraph trace {', '\tnode [fontname="monospace", shape=box];'];
	const shade: Partial<Record<TraceKind, string>> = {
		'write': 'lightblue',
		'batch-retire': 'lightyellow',
		'root-commit': 'lightyellow',
		'render-end': 'lightyellow',
		'delivery': 'lightgreen',
		'suppressed': 'lightgray',
		'mount-correction': 'salmon',
		'reconcile-correction': 'salmon',
		'truncation': 'red',
	};
	for (const e of kept) {
		const subject = Object.values(e.data)[0];
		const label = `#${e.id} ${e.kind}(${typeof subject === 'string' ? subject : String(subject)})`;
		const fill = shade[e.kind];
		const style = fill === undefined ? '' : `, style=filled, fillcolor=${fill}`;
		lines.push(`\tt${e.id} [label=${quoteDotString(label)}${style}];`);
	}
	for (const e of kept) {
		if (e.cause !== undefined && ids.has(e.cause)) lines.push(`\tt${e.cause} -> t${e.id};`);
	}
	lines.push('}');
	return lines.join('\n');
}
