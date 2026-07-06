// Follow-up configs: shipped-bridge sync anchor + pure-revalidation eval decomposition.
import { medianOfProcesses, stat } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench/util.mjs';
const DIR = '/Users/jitl/src/alien-signals-opt/milomg-reactivity-benchmark/.claude/worktrees/agent-a9d009b875849ef38/spike/bench';
async function cfg(script, env, label) {
	process.stdout.write(`== ${label} ...\n`);
	const { byMetric } = await medianOfProcesses(`${DIR}/${script}`, env, 5);
	for (const [metric, values] of byMetric) console.log(`   ${metric}: ${stat(values, 1)}`);
}
await cfg('sync-child.mjs', { SHAPE: 'chain', IMPL: 'head-bridge', WORLDS: '0', ITERS: '50000' }, 'sync chain head-bridge');
await cfg('sync-child.mjs', { SHAPE: 'fan', IMPL: 'head-bridge', WORLDS: '0', ITERS: '50000' }, 'sync fan head-bridge');
await cfg('eval-child.mjs', { IMPL: 'head-newest', MODE: 'none' }, 'eval none head-newest');
await cfg('eval-child.mjs', { IMPL: 'head-pass', MODE: 'none' }, 'eval none head-pass');
await cfg('eval-child.mjs', { IMPL: 'proto', MODE: 'none' }, 'eval none proto');
