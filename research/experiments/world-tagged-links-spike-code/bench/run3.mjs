// Post fanout-dedup re-measurement of the configs the dedup touches.
import { medianOfProcesses, stat } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench/util.mjs';
const DIR = '/Users/jitl/src/alien-signals-opt/milomg-reactivity-benchmark/.claude/worktrees/agent-a9d009b875849ef38/spike/bench';
async function cfg(script, env, label) {
	process.stdout.write(`== ${label} ...\n`);
	const { byMetric } = await medianOfProcesses(`${DIR}/${script}`, env, 5);
	for (const [metric, values] of byMetric) console.log(`   ${metric}: ${stat(values, 1)}`);
}
for (const SHAPE of ['chain', 'fan']) {
	await cfg('sync-child.mjs', { SHAPE, IMPL: 'proto', WORLDS: '1' }, `sync ${SHAPE} proto w1 (dedup)`);
	await cfg('sync-child.mjs', { SHAPE, IMPL: 'proto', WORLDS: '4' }, `sync ${SHAPE} proto w4 (dedup)`);
}
await cfg('churn-child.mjs', { IMPL: 'proto', MODE: 'bulk' }, 'churn proto bulk (dedup)');
await cfg('churn-child.mjs', { IMPL: 'proto', MODE: 'surgical' }, 'churn proto surgical (dedup)');
for (const MODE of ['one', 'all', 'none']) {
	await cfg('eval-child.mjs', { IMPL: 'proto', MODE }, `eval ${MODE} proto (dedup)`);
}
