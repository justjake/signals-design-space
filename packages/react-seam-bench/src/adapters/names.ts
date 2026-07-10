/**
 * CSV framework-column keys, one per child process. Listed here without
 * importing any adapter so the isolated runner can enumerate contenders
 * without loading any contender code. Order is the round-robin order.
 */
export const contenderNames = [
	'cosignals-react',
	'alien-uses',
	'dalien-uses',
	'baseline-context',
	'baseline-local',
	'alt-a-uses',
	'alt-a-react',
	'alt-b-uses',
	'alt-b-react',
	'fx2-react',
] as const;

export type ContenderName = (typeof contenderNames)[number];
