/**
 * SPK-G8 parent — world-evaluation gate (spec §7 "World evaluation": "cost
 * ∝ flagged region; restart-heavy typeahead; prefix length"). Fallbacks on
 * failure (pre-named, NOT implemented): pinless-frontier hybrid (O18);
 * whole-mask clock vector (O21).
 */
import { median, medianOfProcesses, stat } from './util.mjs';

const DIR = '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench';
const PROCS = parseInt(process.env.PROCS ?? '5', 10);

const out = [];
const burstBase = new Map();
for (const G of [4, 16, 64]) {
	for (const HELD of [0, 1]) {
		const shape = `G${G}${HELD ? '+held' : ''}`;
		console.log(`== burst ${shape} ==`);
		const r = await medianOfProcesses(`${DIR}/spkg8-logged.mjs`, {
			MODE: 'burst', G: String(G), HELD: String(HELD),
		}, PROCS);
		const w = r.byMetric.get(`writeNs:${shape}`);
		if (!HELD) burstBase.set(G, median(w));
		out.push({
			row: `burst ${shape}`,
			writeNs: stat(w, 0),
			heldTax: HELD ? (median(w) / burstBase.get(G)).toFixed(2) : '1 (base)',
			evalsPerWrite: stat(r.byMetric.get(`evalsPerWrite:${shape}`), 1),
			tapeLenHeld: stat(r.byMetric.get(`tapeLen:${shape}`), 0),
		});
	}
}
for (const G of [16]) {
	const shape = `type-G${G}xK50`;
	console.log(`== typeahead ${shape} ==`);
	const r = await medianOfProcesses(`${DIR}/spkg8-logged.mjs`, {
		MODE: 'typeahead', G: String(G), KEYS: '50',
	}, PROCS);
	out.push({
		row: `typeahead ${shape}`,
		writeNs: stat(r.byMetric.get(`keyNs:${shape}`), 0),
		heldTax: '-',
		evalsPerWrite: stat(r.byMetric.get(`evalsPerKey:${shape}`), 1),
		tapeLenHeld: stat(r.byMetric.get(`tapeLen:${shape}`), 0),
	});
}
console.log('\nSPK-G8 results (ns; median [min..max] across processes)');
console.table(out);
console.log(JSON.stringify(out, null, 1));
