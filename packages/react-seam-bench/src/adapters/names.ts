/**
 * CSV framework-column keys, one per child process. Listed here without
 * importing any adapter so the isolated runner can enumerate contenders
 * without loading any contender code. Order is the round-robin order.
 */
export const contenderNames = [
  "cosignals",
  "cosignals-arena",
  "cosignals-reducer",
  "alien-uses",
  "dalien-uses",
  "redux-toolkit",
  "baseline-context",
  "baseline-local",
] as const

export type ContenderName = (typeof contenderNames)[number]
