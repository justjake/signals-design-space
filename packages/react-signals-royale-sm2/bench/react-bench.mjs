import { spawnSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";

const directory = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(directory, ".react-bench-runner.mjs");

await build({
  entryPoints: [path.join(directory, "react-bench-runner.tsx")],
  outfile: runner,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  external: ["jsdom", "react", "react-dom", "react-dom/*", "scheduler"],
});

console.log("scenario,contender,stat,ms");
let failed = false;
try {
  for (const scenario of ["fanout", "transition", "mount"]) {
    for (const contender of ["sm2", "stock"]) {
      const result = spawnSync(
        process.execPath,
        [runner, scenario, contender],
        {
          cwd: path.dirname(directory),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "inherit"],
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      process.stdout.write(result.stdout ?? "");
      if (result.status !== 0) {
        failed = true;
        console.error(
          `${scenario}/${contender} exited ${result.status ?? result.signal}`,
        );
      }
    }
  }
} finally {
  unlinkSync(runner);
}
if (failed) process.exitCode = 1;
