import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["conformance/**/*.spec.ts", "inlining/**/*.spec.ts"],
    watch: false,
  },
})
