// Parent orchestrator for the NF2 spike benches: one config per child process,
// 5 processes per config, medians + ranges (methodology per packages/cosignal/bench/util.mjs).
import { medianOfProcesses, stat } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench/util.mjs';

const DIR = '/Users/jitl/src/alien-signals-opt/milomg-reactivity-benchmark/.claude/worktrees/agent-a9d009b875849ef38/spike/bench';
const PROCS = 5;
const results = [];

async function cfg(script, env, label) {
	process.stdout.write(`== ${label} ...\n`);
	const { byMetric } = await medianOfProcesses(`${DIR}/${script}`, env, PROCS);
	for (const [metric, values] of byMetric) {
		results.push({ label, metric, stat: stat(values, 1) });
		console.log(`   ${metric}: ${stat(values, 1)}`);
	}
}

const only = process.env.ONLY; // sync | churn | eval

if (!only || only === 'sync') {
	for (const SHAPE of ['chain', 'fan', 'read']) {
		await cfg('sync-child.mjs', { SHAPE, IMPL: 'head', WORLDS: '0' }, `sync ${SHAPE} head`);
		await cfg('sync-child.mjs', { SHAPE, IMPL: 'proto', WORLDS: '0' }, `sync ${SHAPE} proto w0`);
		await cfg('sync-child.mjs', { SHAPE, IMPL: 'proto', WORLDS: '1' }, `sync ${SHAPE} proto w1`);
		await cfg('sync-child.mjs', { SHAPE, IMPL: 'proto', WORLDS: '4' }, `sync ${SHAPE} proto w4`);
	}
}

if (!only || only === 'churn') {
	await cfg('churn-child.mjs', { IMPL: 'head' }, 'churn head (pass memos)');
	await cfg('churn-child.mjs', { IMPL: 'proto', MODE: 'bulk' }, 'churn proto bulk');
	await cfg('churn-child.mjs', { IMPL: 'proto', MODE: 'surgical' }, 'churn proto surgical');
}

if (!only || only === 'eval') {
	for (const MODE of ['one', 'all']) {
		await cfg('eval-child.mjs', { IMPL: 'head-newest', MODE }, `eval ${MODE} head-newest`);
		await cfg('eval-child.mjs', { IMPL: 'head-pass', MODE }, `eval ${MODE} head-pass`);
		await cfg('eval-child.mjs', { IMPL: 'proto', MODE }, `eval ${MODE} proto`);
	}
}

console.log('\n==== SUMMARY (median [min..max]) ====');
for (const r of results) console.log(`${r.metric.padEnd(28)} ${r.stat}`);
