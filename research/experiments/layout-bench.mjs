// Micro-experiments grounding the layout ideas.
const N = 1 << 17; // 131072 links

function time(label, iters, fn) {
  fn(); fn(); // warmup
  const t0 = process.hrtime.bigint();
  let sink = 0;
  for (let i = 0; i < iters; i++) sink += fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`${label}: ${(ms / iters).toFixed(3)} ms/iter (sink ${sink % 1000})`);
}

// ---- Experiment A: array.length truncation vs endIndex ----
{
  const M = 1000;
  const arrs = Array.from({ length: M }, () => Array.from({ length: 64 }, (_, i) => i + 1));
  time('A: truncate via .length=8 then refill to 64', 50, () => {
    let s = 0;
    for (const a of arrs) {
      a.length = 8;
      for (let i = 8; i < 64; i++) a.push(i);
      s += a.length;
    }
    return s;
  });
  const ends = new Array(M).fill(64);
  time('A: truncate via endIndex then refill (overwrite)', 50, () => {
    let s = 0;
    for (let k = 0; k < M; k++) {
      const a = arrs[k];
      let end = 8;
      for (let i = 8; i < 64; i++) a[end++] = i;
      ends[k] = end;
      s += end;
    }
    return s;
  });
}

// ---- Experiment B: link traversal — objects vs SoA vs packed AoS ----
// Build identical "nextSub" chains in three representations, in two orders:
// sequential (allocation order) and shuffled (graph-realistic scattered order).
function makePerm(n, shuffled) {
  const p = Uint32Array.from({ length: n }, (_, i) => i);
  if (shuffled) {
    let seed = 12345;
    for (let i = n - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const j = seed % (i + 1);
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
  }
  return p;
}

for (const shuffled of [false, true]) {
  const order = makePerm(N, shuffled);
  const label = shuffled ? 'shuffled' : 'sequential';

  // Objects (7 fields like upstream Link)
  const objs = Array.from({ length: N }, () => ({
    version: 1, dep: null, sub: null, prevSub: null, nextSub: null, prevDep: null, nextDep: null,
  }));
  for (let i = 0; i < N - 1; i++) objs[order[i]].nextSub = objs[order[i + 1]];
  const objHead = objs[order[0]];
  time(`B: objects       ${label}`, 30, () => {
    let s = 0; let l = objHead;
    while (l !== null) { s += l.version; l = l.nextSub; }
    return s;
  });

  // SoA typed arrays (id 0 = null; ids 1..N)
  const version = new Uint32Array(N + 1).fill(1);
  const nextSub = new Uint32Array(N + 1);
  for (let i = 0; i < N - 1; i++) nextSub[order[i] + 1] = order[i + 1] + 1;
  const soaHead = order[0] + 1;
  time(`B: SoA typed     ${label}`, 30, () => {
    let s = 0; let l = soaHead;
    while (l !== 0) { s += version[l]; l = nextSub[l]; }
    return s;
  });

  // Packed AoS: 8 u32 slots per link, VERSION=0, NEXT_SUB=4
  const arena = new Uint32Array((N + 1) * 8);
  for (let i = 1; i <= N; i++) arena[i * 8] = 1;
  for (let i = 0; i < N - 1; i++) arena[(order[i] + 1) * 8 + 4] = order[i + 1] + 1;
  time(`B: AoS packed    ${label}`, 30, () => {
    let s = 0; let l = soaHead;
    while (l !== 0) { s += arena[l << 3]; l = arena[(l << 3) + 4]; }
    return s;
  });
}

// ---- Experiment C: allocation — N objects vs arena bump ----
time('C: allocate 131k Link objects', 10, () => {
  const a = Array.from({ length: N }, () => ({
    version: 1, dep: null, sub: null, prevSub: null, nextSub: null, prevDep: null, nextDep: null,
  }));
  return a.length;
});
time('C: arena bump-alloc 131k links (7 u32 stores)', 10, () => {
  const version = new Uint32Array(N + 1), dep = new Uint32Array(N + 1), sub = new Uint32Array(N + 1),
    prevSub = new Uint32Array(N + 1), nextSub = new Uint32Array(N + 1),
    prevDep = new Uint32Array(N + 1), nextDep = new Uint32Array(N + 1);
  for (let i = 1; i <= N; i++) { version[i] = 1; dep[i] = i; sub[i] = i; prevSub[i] = 0; nextSub[i] = 0; prevDep[i] = 0; nextDep[i] = 0; }
  return nextDep[N] + version[N];
});
