import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    watch: false,
    pool: 'forks',
    execArgv: ['--expose-gc'],
  },
});
