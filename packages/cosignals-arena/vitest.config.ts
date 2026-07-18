import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

/**
 * COSIGNALS_REACT=18 runs the suite against the pinned React 18 line in
 * ./react18 (see its package.json for why it is a separate package). The
 * aliases point react, react-dom, and scheduler at that package's copies;
 * scheduler must come from the same place so the host shares react-dom's
 * scheduler task heap (host.ts relies on that for render-note expiry).
 */
const react18 = (name: string): string =>
  fileURLToPath(new URL(`./react18/node_modules/${name}`, import.meta.url))

const alias =
  process.env["COSIGNALS_REACT"] === "18"
    ? {
        react: react18("react"),
        "react-dom": react18("react-dom"),
        scheduler: react18("scheduler"),
      }
    : undefined

export default defineConfig({
  resolve: {
    alias,
  },
  test: {
    alias,
    pool: "forks",
    poolOptions: {
      forks: {
        execArgv: ["--expose-gc"],
      },
    },
    include: ["tests/**/*.spec.{ts,tsx}"],
  },
})
