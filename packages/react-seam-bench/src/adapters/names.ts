/**
 * CSV framework-column keys, one per child process. Listed here without
 * importing any adapter so the isolated runner can enumerate contenders
 * without loading any contender code. Order is the round-robin order.
 */
export const contenderNames = [
  "cosignals",
  "cosignals-arena",
  "alien-uses",
  "dalien-uses",
  "baseline-context",
  "baseline-local",
] as const

export type ContenderName = (typeof contenderNames)[number]
