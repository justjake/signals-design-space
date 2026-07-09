#!/usr/bin/env node
/**
 * React seam benchmark: three scenarios (fanout, transition, mount), one
 * child process per (scenario, contender), stdout CSV `scenario,contender,
 * stat,ms`. Contenders: this package's bindings and a stock
 * useSyncExternalStore baseline over a plain store.
 *
 * Usage: node bench/react-bench.mjs [scenario ...]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, '..');

// Bundle the child once (TS -> ESM); react/jsdom stay external so the child
// resolves this package's fork-linked builds at runtime.
execFileSync(
	path.join(pkg, 'node_modules', '.bin', 'esbuild'),
	[
		path.join(here, 'child.ts'),
		'--bundle',
		'--platform=node',
		'--format=esm',
		'--target=esnext',
		`--outfile=${path.join(here, 'dist', 'child.mjs')}`,
		'--external:react',
		'--external:react-dom',
		'--external:scheduler',
		'--external:jsdom',
	],
	{ stdio: ['ignore', 'ignore', 'inherit'] },
);

const scenarios = process.argv.slice(2);
const run = scenarios.length > 0 ? scenarios : ['fanout', 'transition', 'mount'];
process.stdout.write('scenario,contender,stat,ms\n');
for (const scenario of run) {
	for (const contender of ['royale-fh1', 'baseline-uses']) {
		const res = spawnSync(
			process.execPath,
			[path.join(here, 'dist', 'child.mjs'), scenario, contender],
			{ encoding: 'utf8', timeout: 300_000, cwd: pkg },
		);
		if (res.status !== 0) {
			process.stderr.write(`# ${scenario}/${contender} FAILED:\n${res.stderr}\n`);
		} else {
			process.stdout.write(res.stdout);
			if (res.stderr) process.stderr.write(res.stderr.replace(/^/gm, '# '));
		}
	}
}
