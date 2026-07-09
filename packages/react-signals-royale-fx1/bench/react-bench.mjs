/**
 * React seam benchmark driver: one scenario per child process, CSV on stdout
 * (`scenario,contender,stat,ms`), commentary on stderr.
 *
 *   node bench/react-bench.mjs [rounds]
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const rounds = Number(process.argv[2] ?? 1);
const scenarios = ['fanout', 'transition', 'mount'];
const contenders = ['royale-fx1', 'uses-baseline'];

const rows = new Map(); // key -> ms per round
for (let round = 0; round < rounds; round++) {
  for (const scenario of scenarios) {
    for (const contender of contenders) {
      const res = spawnSync(
        'pnpm',
        ['exec', 'tsx', path.join(here, 'child.ts'), scenario, contender],
        { cwd: path.join(here, '..'), encoding: 'utf8', timeout: 180000 },
      );
      if (res.status !== 0) {
        console.error(`# FAILED ${scenario}/${contender}:\n${res.stderr}`);
        continue;
      }
      process.stderr.write(res.stderr);
      for (const line of res.stdout.trim().split('\n')) {
        if (!line) continue;
        const [s, c, stat, ms] = line.split(',');
        const key = `${s},${c},${stat}`;
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key).push(Number(ms));
      }
    }
  }
}
for (const [key, values] of rows) {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log(`${key},${median.toFixed(3)}`);
}
