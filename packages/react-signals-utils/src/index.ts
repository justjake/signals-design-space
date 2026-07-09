export type Lane = number;
export type Lanes = number;
export type BatchToken = number;
export type RootToken = object;

export interface TapConsumer {
	onRootUpdated(root: RootToken, container: unknown, updatedLanes: Lanes): void;
	onScheduledRootPending(root: RootToken, container: unknown, pendingLanes: Lanes): void;
	onEventClosed(actionLane: Lane, actionThenable: PromiseLike<void> | null): void;
	onRenderPassStart(root: RootToken, container: unknown, entangledRenderLanes: Lanes): void;
	onRenderPassYield(root: RootToken, container: unknown): void;
	onRenderPassResume(root: RootToken, container: unknown): void;
	onRootCommitted(
		root: RootToken,
		container: unknown,
		finishedEntangledLanes: Lanes,
		remainingLanes: Lanes,
		rependedLanes: Lanes,
	): void;
	onBeforeMutation(container: unknown): void;
	onAfterMutation(container: unknown): void;
}

export interface ReactSignalsTaps {
	readonly forkProtocolVersion: 1;
	consumer: TapConsumer | null;
	watchedLanes: Lanes;
	getCurrentWriteLane(): number;
	getRenderContext(): { root: RootToken; container: unknown } | null;
	runInBatch<R>(packedLane: number, fn: () => R): R;
}

export interface RegistryListener {
	onBatchOpened?(token: BatchToken): void;
	onRenderPassStart?(container: unknown, includedTokens: readonly BatchToken[]): void;
	onRenderPassYield?(container: unknown): void;
	onRenderPassResume?(container: unknown): void;
	onRenderPassEnd?(container: unknown, committed: boolean): void;
	onRootCommitted?(container: unknown, committedTokens: readonly BatchToken[]): void;
	onBatchRetired?(token: BatchToken, committed: boolean): void;
	onBeforeMutation?(container: unknown): void;
	onAfterMutation?(container: unknown): void;
}

interface Slot {
	token: BatchToken;
	deferred: boolean;
	lane: Lane;
	roots?: Set<RootToken>;
	committedRoots?: Set<RootToken>;
	parked?: PromiseLike<void>;
}

interface Frame {
	readonly container: unknown;
	yielded: boolean;
}

interface ReactLike {
	__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: {
		E?: ReactSignalsTaps | null;
	};
}

const SIGN_BIT = 0x80000000;

export class ReactBatchRegistry {
	readonly errors: unknown[] = [];
	private readonly taps: ReactSignalsTaps;
	private readonly slots: Array<Slot | undefined> = new Array(31);
	private readonly live = new Map<BatchToken, Slot>();
	private readonly listeners = new Set<RegistryListener>();
	private renderedLanes = new WeakMap<RootToken, Lanes>();
	private frames = new WeakMap<RootToken, Frame>();
	private serial = 0;
	private disposed = false;
	private readonly consumer: TapConsumer;

	constructor(react: unknown) {
		const taps = (react as ReactLike).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?.E;
		if (taps === null || taps === undefined || taps.forkProtocolVersion !== 1) {
			throw new Error('react-signals-utils requires React signals fork protocol 1.');
		}
		if (taps.consumer !== null) {
			throw new Error('A React signals registry is already attached.');
		}
		this.taps = taps;
		this.consumer = {
			onRootUpdated: (root, container, lanes) => this.onRootUpdated(root, container, lanes),
			onScheduledRootPending: (root, container, lanes) =>
				this.onScheduledRootPending(root, container, lanes),
			onEventClosed: (lane, thenable) => this.onEventClosed(lane, thenable),
			onRenderPassStart: (root, container, lanes) =>
				this.onRenderPassStart(root, container, lanes),
			onRenderPassYield: (root, container) => this.onRenderPassYield(root, container),
			onRenderPassResume: (root, container) => this.onRenderPassResume(root, container),
			onRootCommitted: (root, container, finished, remaining, repended) =>
				this.onRootCommitted(root, container, finished, remaining, repended),
			onBeforeMutation: (container) => this.emit('onBeforeMutation', container),
			onAfterMutation: (container) => this.emit('onAfterMutation', container),
		};
		taps.consumer = this.consumer;
	}

	subscribe(listener: RegistryListener): () => void {
		if (this.disposed) throw new Error('React signals registry is disposed.');
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	getCurrentWriteBatch(): BatchToken {
		const packed = this.taps.getCurrentWriteLane();
		const lane = packed & 0x7fffffff;
		if (lane === 0) return 0;
		const index = 31 - Math.clz32(lane);
		let slot = this.slots[index];
		if (slot !== undefined && slot.token !== 0) return slot.token;
		const deferred = (packed & SIGN_BIT) !== 0;
		const token = ++this.serial * 2 + (deferred ? 1 : 0);
		if (slot === undefined) {
			slot = { token, deferred, lane };
			this.slots[index] = slot;
		} else {
			slot.token = token;
			slot.deferred = deferred;
			slot.lane = lane;
		}
		this.live.set(token, slot);
		this.taps.watchedLanes |= lane;
		this.emit('onBatchOpened', token);
		return token;
	}

	getRenderContext(): { root: RootToken; container: unknown } | null {
		return this.taps.getRenderContext();
	}

	runInBatch<R>(token: BatchToken, fn: () => R): R {
		const slot = this.live.get(token);
		const lane = slot === undefined ? 0 : slot.lane | (slot.deferred ? SIGN_BIT : 0);
		return this.taps.runInBatch(lane, fn);
	}

	liveTokens(): BatchToken[] {
		const tokens: BatchToken[] = [];
		for (const token of this.live.keys()) tokens.push(token);
		return tokens;
	}

	hasLiveBatches(): boolean {
		return this.live.size !== 0;
	}

	isBatchLive(token: BatchToken): boolean {
		return this.live.has(token);
	}

	reset(): void {
		for (let i = 0; i < this.slots.length; i++) {
			const slot = this.slots[i];
			if (slot === undefined) continue;
			slot.token = 0;
			slot.deferred = false;
			slot.roots = undefined;
			slot.committedRoots = undefined;
			slot.parked = undefined;
		}
		this.live.clear();
		this.renderedLanes = new WeakMap();
		this.frames = new WeakMap();
		this.taps.watchedLanes = 0;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.taps.consumer === this.consumer) this.taps.consumer = null;
		this.reset();
		this.listeners.clear();
	}

	private onRootUpdated(root: RootToken, _container: unknown, updatedLanes: Lanes): void {
		let remaining = updatedLanes & this.taps.watchedLanes;
		while (remaining !== 0) {
			const index = 31 - Math.clz32(remaining);
			remaining &= ~(1 << index);
			const slot = this.slots[index];
			if (slot === undefined || slot.token === 0) continue;
			(slot.roots ??= new Set()).add(root);
		}
	}

	private onScheduledRootPending(root: RootToken, _container: unknown, pendingLanes: Lanes): void {
		let remaining = pendingLanes & this.taps.watchedLanes;
		while (remaining !== 0) {
			const index = 31 - Math.clz32(remaining);
			remaining &= ~(1 << index);
			const slot = this.slots[index];
			if (slot === undefined || slot.token === 0) continue;
			(slot.roots ??= new Set()).add(root);
		}
	}

	private onEventClosed(actionLane: Lane, actionThenable: PromiseLike<void> | null): void {
		for (let i = 0; i < this.slots.length; i++) {
			const slot = this.slots[i];
			if (
				slot === undefined ||
				slot.token === 0 ||
				slot.parked !== undefined ||
				(slot.roots !== undefined && slot.roots.size !== 0)
			) continue;
			if (slot.deferred && slot.lane === actionLane && actionThenable !== null) {
				slot.parked = actionThenable;
				const token = slot.token;
				const settle = () => {
					if (slot.parked !== actionThenable || slot.token !== token) return;
					slot.parked = undefined;
					if (slot.roots === undefined || slot.roots.size === 0) this.retire(slot, false);
				};
				actionThenable.then(settle, settle);
			} else {
				this.retire(slot, false);
			}
		}
	}

	private onRenderPassStart(root: RootToken, container: unknown, lanes: Lanes): void {
		const previous = this.frames.get(root);
		if (previous !== undefined) {
			this.frames.delete(root);
			this.emit('onRenderPassEnd', previous.container, false);
		}
		if (lanes === 0) {
			this.renderedLanes.delete(root);
			return;
		}
		this.frames.set(root, { container, yielded: false });
		this.renderedLanes.set(root, lanes);
		const included: BatchToken[] = [];
		let remaining = lanes;
		while (remaining !== 0) {
			const index = 31 - Math.clz32(remaining);
			remaining &= ~(1 << index);
			const slot = this.slots[index];
			if (slot !== undefined && slot.token !== 0) included.push(slot.token);
		}
		for (let i = 0; i < this.slots.length; i++) {
			const slot = this.slots[i];
			if (
				slot !== undefined &&
				slot.token !== 0 &&
				slot.committedRoots?.has(root) &&
				(lanes & slot.lane) === 0
			) included.push(slot.token);
		}
		this.emit('onRenderPassStart', container, included);
	}

	private onRenderPassYield(root: RootToken, container: unknown): void {
		const frame = this.frames.get(root);
		if (frame === undefined || frame.yielded) return;
		frame.yielded = true;
		this.emit('onRenderPassYield', container);
	}

	private onRenderPassResume(root: RootToken, container: unknown): void {
		const frame = this.frames.get(root);
		if (frame === undefined || !frame.yielded) return;
		frame.yielded = false;
		this.emit('onRenderPassResume', container);
	}

	private onRootCommitted(
		root: RootToken,
		container: unknown,
		finishedLanes: Lanes,
		remainingLanes: Lanes,
		rependedLanes: Lanes,
	): void {
		const frame = this.frames.get(root);
		if (frame !== undefined) {
			this.frames.delete(root);
			this.emit('onRenderPassEnd', frame.container, true);
		}
		const renderedLanes = this.renderedLanes.get(root) ?? finishedLanes;
		const committed: BatchToken[] = [];
		let retirements: Array<{ slot: Slot; committed: boolean }> | undefined;
		for (let i = 0; i < this.slots.length; i++) {
			const slot = this.slots[i];
			if (slot === undefined || slot.token === 0) continue;
			const roots = slot.roots;
			if ((remainingLanes & slot.lane) !== 0) {
				if (
					(rependedLanes & slot.lane) !== 0 &&
					(finishedLanes & slot.lane) !== 0 &&
					(renderedLanes & slot.lane) !== 0 &&
					roots?.has(root)
				) {
					committed.push(slot.token);
					(slot.committedRoots ??= new Set()).add(root);
				}
				continue;
			}
			if (!roots?.has(root)) continue;
			const visible = (finishedLanes & slot.lane) !== 0;
			if (visible) committed.push(slot.token);
			roots.delete(root);
			if (roots.size === 0) {
				(retirements ??= []).push({
					slot,
					committed: visible || (slot.committedRoots !== undefined && slot.committedRoots.size !== 0),
				});
			} else if (visible) {
				(slot.committedRoots ??= new Set()).add(root);
			}
		}
		this.renderedLanes.delete(root);
		this.emit('onRootCommitted', container, committed);
		if (retirements !== undefined) {
			for (let i = 0; i < retirements.length; i++) {
				const retirement = retirements[i]!;
				this.retire(retirement.slot, retirement.committed);
			}
		}
	}

	private retire(slot: Slot, committed: boolean): void {
		const token = slot.token;
		if (token === 0) return;
		slot.token = 0;
		slot.deferred = false;
		slot.roots = undefined;
		slot.committedRoots = undefined;
		slot.parked = undefined;
		this.live.delete(token);
		this.taps.watchedLanes &= ~slot.lane;
		this.emit('onBatchRetired', token, committed);
	}

	private emit(name: keyof RegistryListener, a?: unknown, b?: unknown): void {
		for (const listener of this.listeners) {
			const handler = listener[name] as ((a?: unknown, b?: unknown) => void) | undefined;
			if (handler === undefined) continue;
			try {
				handler(a, b);
			} catch (error) {
				this.errors.push(error);
				(globalThis as typeof globalThis & { reportError?: (error: unknown) => void }).reportError?.(error);
			}
		}
	}
}
