// SP-F8 runner: N child processes per variant, spawn order round-robin so
// machine drift is shared across variants (in-session control). Reports
// min-of-mins and mean-of-means per-event time + overhead vs native.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const CHILDREN = 7;
const VARIANTS = ["native", "dual", "dual-armed", "gen", "als"];

const samples = Object.fromEntries(VARIANTS.map((v) => [v, []]));
for (let c = 0; c < CHILDREN; c++) {
  for (const v of VARIANTS) {
    const out = execFileSync(process.execPath, [join(dir, "bench.mjs"), v], {
      encoding: "utf8",
    });
    samples[v].push(JSON.parse(out.trim().split("\n").pop()));
    process.stderr.write(`child ${c} ${v} done\n`);
  }
}

const stats = {};
for (const v of VARIANTS) {
  const mins = samples[v].map((s) => Math.min(...s.perEventUs));
  const means = samples[v].map(
    (s) => s.perEventUs.reduce((a, b) => a + b, 0) / s.perEventUs.length,
  );
  stats[v] = {
    min: Math.min(...mins),
    mean: means.reduce((a, b) => a + b, 0) / means.length,
    childMins: mins.map((x) => +x.toFixed(2)),
  };
}
const base = stats.native;
console.log("\nvariant      min µs/evt  mean µs/evt   min ovh    mean ovh");
for (const v of VARIANTS) {
  const s = stats[v];
  const om = ((s.min / base.min - 1) * 100).toFixed(2);
  const oM = ((s.mean / base.mean - 1) * 100).toFixed(2);
  console.log(
    `${v.padEnd(12)} ${s.min.toFixed(2).padStart(9)} ${s.mean.toFixed(2).padStart(12)} ${(om + "%").padStart(9)} ${(oM + "%").padStart(10)}`,
  );
}
console.log("\nper-child mins (µs/evt):");
for (const v of VARIANTS) console.log(`  ${v.padEnd(12)} ${stats[v].childMins.join("  ")}`);
