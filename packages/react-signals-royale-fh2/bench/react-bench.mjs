/**
 * React seam benchmark: fanout / transition / mount, one scenario per
 * child process, two contenders (these bindings vs a stock
 * useSyncExternalStore baseline over a plain store). stdout is pure CSV:
 * `scenario,contender,stat,ms`.
 *
 * The transition scenario is the one the fork exists for: a plain
 * useSyncExternalStore store mutated during a transition falls back to a
 * blocking synchronous render (documented React behavior), so urgent
 * updates queue behind the bulk re-render. Leak posture: both contenders
 * unmount their roots; neither retains cells after exit (process-per-run
 * makes residue irrelevant anyway).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const child = path.join(here, 'dist', 'child.mjs');
const esbuild = path.join(here, '..', 'node_modules', '.bin', 'esbuild');

// Bundle the TS bindings once; react/react-dom/jsdom stay external so the
// child uses the fork build through the package links.
const bundle = spawnSync(
	esbuild,
	[
		path.join(here, 'child-entry.mjs'),
		'--bundle',
		'--platform=node',
		'--format=esm',
		'--external:react',
		'--external:react-dom',
		'--external:jsdom',
		`--outfile=${child}`,
	],
	{ stdio: ['ignore', 'ignore', 'inherit'] },
);
if (bundle.status !== 0) {
	process.exit(bundle.status ?? 1);
}

console.log('scenario,contender,stat,ms');
for (const scenario of ['fanout', 'transition', 'mount']) {
	for (const contender of ['royale-fh2', 'stock-uses-baseline']) {
		const r = spawnSync(process.execPath, [child], {
			cwd: path.join(here, '..'),
			env: { ...process.env, BENCH_SCENARIO: scenario, BENCH_CONTENDER: contender },
			stdio: ['ignore', 'pipe', 'inherit'],
			timeout: 180000,
		});
		if (r.status !== 0) {
			console.error(`# ${scenario}/${contender} FAILED (exit ${r.status})`);
			continue;
		}
		process.stdout.write(r.stdout.toString());
	}
}
