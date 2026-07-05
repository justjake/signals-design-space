// src/isolated.ts
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// src/adapters/names.ts
var contenderNames = [
  "cosignal-react",
  "alien-uses",
  "dalien-uses",
  "baseline-context",
  "baseline-local"
];

// src/util/perfLogging.ts
var columnWidth = {
  framework: 32,
  test: 60,
  time: 8
};
function trimColumns(row) {
  const trimmed = { ...row };
  for (const key of Object.keys(columnWidth)) {
    trimmed[key] = (row[key] || "").slice(0, columnWidth[key]).padEnd(columnWidth[key]);
  }
  return trimmed;
}
function perfResultHeaders() {
  return { framework: "framework", test: "test", time: "time" };
}
function formatPerfResult(row) {
  const t = trimColumns(row);
  return [t.framework, t.test, t.time].join(" , ");
}

// src/isolated.ts
var childJs = path.join(path.dirname(fileURLToPath(import.meta.url)), "child.js");
var argv = process.argv.slice(2);
var rounds = 3;
var roundsAt = argv.indexOf("--rounds");
if (roundsAt !== -1) {
  rounds = Number(argv[roundsAt + 1]);
  if (!Number.isInteger(rounds) || rounds < 1) {
    console.error("--rounds expects a positive integer");
    process.exit(1);
  }
  argv.splice(roundsAt, 2);
}
var names = contenderNames;
var requested = argv;
var unknown = requested.filter((name) => !names.includes(name));
if (unknown.length > 0) {
  console.error(`unknown contenders: ${unknown.join(", ")}; available: ${names.join(", ")}`);
  process.exit(1);
}
var selected = requested.length > 0 ? requested : [...names];
function medianOf(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
var samples = /* @__PURE__ */ new Map();
for (const name of selected) samples.set(name, /* @__PURE__ */ new Map());
for (let round = 0; round < rounds; round++) {
  for (const name of selected) {
    console.error(`round ${round + 1}/${rounds}: ${name}`);
    const result = spawnSync(process.execPath, [childJs, name], {
      stdio: ["ignore", "pipe", "inherit"],
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    });
    if (result.status !== 0) {
      console.error(
        `\u26A0 ${name} round ${round + 1} exited with ${result.status !== null ? `code ${result.status}` : result.signal} (keeping rows from its other rounds)`
      );
    }
    const perTest = samples.get(name);
    for (const line of (result.stdout ?? "").split("\n")) {
      const parts = line.split(",").map((p) => p.trim());
      if (parts.length < 3 || parts[0] !== name) continue;
      const time = Number(parts[2]);
      if (!Number.isFinite(time)) continue;
      let arr = perTest.get(parts[1]);
      if (arr === void 0) {
        arr = [];
        perTest.set(parts[1], arr);
      }
      arr.push(time);
    }
  }
}
console.log(formatPerfResult(perfResultHeaders()));
for (const name of selected) {
  const perTest = samples.get(name);
  for (const [test, times] of perTest) {
    if (times.length < rounds) {
      console.error(`\u26A0 ${name} / ${test}: only ${times.length}/${rounds} rounds completed`);
    }
    console.log(
      formatPerfResult({
        framework: name,
        test,
        time: medianOf(times).toFixed(2)
      })
    );
  }
}
var empty = selected.filter((name) => samples.get(name).size === 0);
if (empty.length > 0) {
  console.error(`\u2717 no results for: ${empty.join(", ")}`);
}
process.exit(empty.length > 0 ? 1 : 0);
