/**
 * The notification queue: listener callbacks queued during a public
 * operation's own mutations and DELIVERED AT THE OPERATION BOUNDARY — queued
 * into reusable columns during the walk and invoked after the operation's
 * mutations complete, so a listener can never re-enter a half-finished
 * operation. The listener slots themselves (`onDelivery` /
 * `onMountCorrective` / `onCorrection` — the bindings' consumption surface)
 * live on the engine and come in through `deps`.
 *
 * `createDeliver` is a factory in the kernel's own style (index.ts
 * `createEngine`): it closes over the queue columns and returns its
 * operation table. The two live scalars every enqueue/flush moves (`n`,
 * `flushing`) sit in one shared `state` record the engine aliases, so its
 * resident hot checks (the quiet-write flush guard, the settle tap's
 * flushing guard) stay plain field reads instead of calls.
 */

import type { Batch, BatchSlot } from './Batch.js';
import type { Subscription, Watcher } from './concurrent.js';

/** The queued-notification kinds (the notify columns' kind codes). Same-file
 * const enum with its one consumer, the flush loop; resident enqueue sites
 * pass the bare 0-3 codes (numeric literals are assignable, so cross-module
 * callers never name this type — cross-module const enum access does not
 * survive esbuild). */
const enum NotifyKind {
	DELIVERY = 0,
	MOUNT_CORRECTIVE = 1,
	CORRECTION = 2,
	SUBSCRIPTION_REFIRE = 3,
}

/** The two live queue scalars (shared record — see the module header). */
export type NotifyState = { n: number; flushing: boolean };

export type DeliverDeps = {
	/** A value-blind delivery reached a live watcher (fresh or interleaved). */
	onDelivery(): ((w: Watcher, batch: Batch, slot: BatchSlot) => void) | undefined;
	/** Mount fixup scheduled a corrective re-render into a live batch's lane. */
	onMountCorrective(): ((w: Watcher, batch: Batch, slot: BatchSlot) => void) | undefined;
	/** An urgent pre-paint correction (mount window / committed-truth drift). */
	onCorrection(): ((w: Watcher) => void) | undefined;
};

export type DeliverTable = {
	state: NotifyState;
	queueNotify(kind: NotifyKind, w: Watcher | undefined, t: Batch | undefined, slot: BatchSlot, sub?: Subscription): void;
	flushNotify(): void;
};

export function createDeliver(deps: DeliverDeps): DeliverTable {
	// Queued-notification columns (reused across operations; no per-notify objects).
	const notifyKinds: number[] = [];
	const notifyWs: (Watcher | undefined)[] = [];
	const notifyBatches: (Batch | undefined)[] = [];
	const notifySlots: BatchSlot[] = [];
	const notifySubs: (Subscription | undefined)[] = [];
	const state: NotifyState = { n: 0, flushing: false };

	function queueNotify(kind: NotifyKind, w: Watcher | undefined, t: Batch | undefined, slot: BatchSlot, sub?: Subscription): void {
		const i = state.n++;
		notifyKinds[i] = kind;
		notifyWs[i] = w;
		notifyBatches[i] = t;
		notifySlots[i] = slot;
		notifySubs[i] = sub;
	}

	/** Invokes queued listeners at the end of the public operation. A nested
	 * public operation started BY a listener appends behind the live bound
	 * and drains in the same sweep (the flushing flag stops nested sweeps). */
	function flushNotify(): void {
		if (state.n === 0 || state.flushing) return;
		state.flushing = true;
		try {
			for (let i = 0; i < state.n; i++) {
				const kind = notifyKinds[i]!;
				const w = notifyWs[i];
				const t = notifyBatches[i];
				const s = notifySubs[i];
				notifyWs[i] = undefined; // release object refs eagerly
				notifyBatches[i] = undefined;
				notifySubs[i] = undefined;
				if (kind === NotifyKind.DELIVERY) {
					const l = deps.onDelivery();
					if (l !== undefined) l(w!, t!, notifySlots[i]!);
				} else if (kind === NotifyKind.MOUNT_CORRECTIVE) {
					const l = deps.onMountCorrective();
					if (l !== undefined) l(w!, t!, notifySlots[i]!);
				} else if (kind === NotifyKind.CORRECTION) {
					const l = deps.onCorrection();
					if (l !== undefined) l(w!);
				} else if (s !== undefined && s.live) {
					// Subscription refire (adapter-registered): the value gate
					// already passed at the boundary scan; the adapter owns the
					// body run (cleanup + fire + re-capture) and any React-phase
					// deferral. Removal flips `live`, so nothing runs after
					// teardown (RCC-OL2).
					const r = s.refire;
					if (r !== undefined) r();
				}
			}
		} finally {
			state.n = 0;
			state.flushing = false;
		}
	}

	return { state, queueNotify, flushNotify };
}
