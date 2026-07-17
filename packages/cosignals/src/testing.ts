/**
 * cosignals/testing — helpers for test suites.
 *
 * Signal state is module-global, so tests that create drafts, effects,
 * or tracers must reset between cases to stay independent. Application
 * code should never import this entry.
 */
export { resetEngineForTest } from './signals.ts'
