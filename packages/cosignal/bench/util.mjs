/**
 * Shared helpers for the cosignal gate battery (research/experiments/cosignal-gates.md).
 * Methodology (pre-registered): ONE measurement config per CHILD PROCESS,
 * median of >=5 process runs, medians AND ranges reported, checksums printed
 * to defeat dead-code elimination. Children run under `node --expose-gc
 * --import tsx` with cwd=harness/ (tsx 4.23.0 resolves there); imports inside
 * children are absolute file paths, so cwd is only a loader concern.
 */
import { spawn } from 'node:child_process';

export const HARNESS_CWD = '/Users/jitl/src/alien-signals-opt/harness';

// ---------------------------------------------------------------- parent side

/** Spawn one child config; collect @@ROW jsonl rows from stdout. */
export function runChild(script, env, timeoutMs = 300_000) {
	return new Promise((resolve) => {
		const child = spawn('node', ['--expose-gc', '--import', 'tsx', script], {
			cwd: HARNESS_CWD,
			env: { ...process.env, ...env },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const rows = [];
		let out = '';
		let err = '';
		let timedOut = false;
		child.stdout.on('data', (c) => {
			out += c.toString();
			let nl;
			while ((nl = out.indexOf('\n')) >= 0) {
				const line = out.slice(0, nl);
				out = out.slice(nl + 1);
				if (line.startsWith('@@ROW ')) rows.push(JSON.parse(line.slice(6)));
				else if (line.trim()) console.log(`  [child] ${line}`);
			}
		});
		child.stderr.on('data', (c) => { err += c.toString(); });
		const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
		child.on('exit', (code) => {
			clearTimeout(timer);
			resolve({ ok: code === 0 && !timedOut, code, rows, stderr: err, timedOut });
		});
	});
}

export function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export const min = (xs) => Math.min(...xs);
export const max = (xs) => Math.max(...xs);

/** "median [min..max]" with fixed digits. */
export function stat(xs, digits = 1) {
	return `${median(xs).toFixed(digits)} [${min(xs).toFixed(digits)}..${max(xs).toFixed(digits)}]`;
}

/**
 * Run `script` PROCS times sequentially with `env`; returns rows grouped by
 * row.metric -> number[] (one value per process), plus raw rows.
 */
export async function medianOfProcesses(script, env, procs = 5, timeoutMs = 300_000) {
	const byMetric = new Map();
	const raw = [];
	for (let i = 0; i < procs; i++) {
		const res = await runChild(script, { ...env, RUN_INDEX: String(i) }, timeoutMs);
		if (!res.ok) {
			throw new Error(`child failed (${script} ${JSON.stringify(env)}) run ${i}: code=${res.code} timedOut=${res.timedOut}\n${res.stderr.slice(-2000)}`);
		}
		for (const row of res.rows) {
			raw.push(row);
			if (typeof row.value === 'number') {
				const key = row.metric;
				if (!byMetric.has(key)) byMetric.set(key, []);
				byMetric.get(key).push(row.value);
			}
		}
	}
	return { byMetric, raw };
}

// ---------------------------------------------------------------- child side

/** Print one result row for the parent. */
export function row(obj) {
	console.log(`@@ROW ${JSON.stringify(obj)}`);
}

/** Time fn() over `n` iterations; returns total nanoseconds as a Number. */
export function timeNs(fn) {
	const t0 = process.hrtime.bigint();
	fn();
	const t1 = process.hrtime.bigint();
	return Number(t1 - t0);
}

/**
 * Standard child measurement: warmups, then `reps` timed calls of fn();
 * returns per-rep ns array. Calls global.gc() between reps when exposed.
 */
export function repsNs(fn, { warmup = 2, reps = 7 } = {}) {
	for (let i = 0; i < warmup; i++) fn();
	const out = [];
	for (let i = 0; i < reps; i++) {
		globalThis.gc?.();
		out.push(timeNs(fn));
	}
	return out;
}

export function env(name, dflt) {
	const v = process.env[name];
	return v === undefined || v === '' ? dflt : v;
}

export function envInt(name, dflt) {
	return parseInt(env(name, String(dflt)), 10);
}
