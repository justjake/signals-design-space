/**
 * Queue storage probe: per-wave heap allocation on a wide-fanout burst.
 *
 * Measures what one invalidation wave allocates when a single cell fans out
 * to many subscribers, for the two scheduling queues separately:
 * - leaf-notify burst: subscribers are leaf observers (onNotify), so every
 *   wave fills and drains the marked-leaves buffer;
 * - effect burst: subscribers are effects, so every wave fills and drains
 *   the watcher queue.
 *
 * Method: warm up, then per wave force GC, snapshot heapUsed, run the wave,
 * snapshot again. The delta is the wave's transient allocation (queue
 * backing-store regrowth + snapshot copies show up here; retained capacity
 * does not, by design). Seconds of runtime, not a benchmark.
 *
 * Run: node --expose-gc --import tsx bench/queue-probe.mts
 */
import { effect, nodeOf, signal } from '../src/index.ts';
import { observeNode } from '../src/graph.ts';

if (typeof gc !== 'function') throw new Error('run with --expose-gc');

const SUBS = 2000;
const WAVES = 50;
const WARMUP = 5;

/** Disposers must stay referenced: dropped handles arm a reclamation
 * registry, and this probe forces GC every wave. */
const held: Array<() => void> = [];

function measure(label: string, setup: () => (i: number) => void): void {
  const wave = setup();
  for (let i = 0; i < WARMUP; i++) wave(i);
  const deltas: number[] = [];
  for (let i = 0; i < WAVES; i++) {
    gc!();
    gc!();
    const before = process.memoryUsage().heapUsed;
    wave(WARMUP + i);
    const after = process.memoryUsage().heapUsed;
    deltas.push(after - before);
  }
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  console.log(
    `${label}: median ${median} B/wave, mean ${Math.round(mean)} B/wave ` +
      `(${SUBS} subscribers, ${WAVES} waves)`,
  );
}

measure('leaf-notify burst', () => {
  const cell = signal(0);
  let hits = 0;
  for (let s = 0; s < SUBS; s++) held.push(observeNode(nodeOf(cell), () => void hits++));
  return (i) => cell.set(i + 1);
});

measure('effect burst', () => {
  const cell = signal(0);
  let hits = 0;
  for (let s = 0; s < SUBS; s++)
    held.push(
      effect(() => {
        cell.get();
        hits++;
      }),
    );
  return (i) => cell.set(i + 1);
});

// Keep every subscription alive through the last GC of the last scenario.
if (held.length !== SUBS * 2) throw new Error('subscription bookkeeping drifted');
