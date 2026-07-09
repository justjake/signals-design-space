import { describe, expect, it } from 'vitest';

import type {
	Lane,
	Lanes,
	ReactSignalsTaps,
	RegistryListener,
	RootToken,
	TapConsumer,
} from '../src/index.ts';
import { ReactBatchRegistry } from '../src/index.ts';

class TapsDouble implements ReactSignalsTaps {
	readonly forkProtocolVersion = 1;
	consumer: TapConsumer | null = null;
	watchedLanes = 0;
	writeLane = 0;
	renderContext: { root: RootToken; container: unknown } | null = null;
	readonly runs: Lane[] = [];
	readonly react = {
		__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { E: this },
	};

	getCurrentWriteLane(): number {
		return this.writeLane;
	}

	getRenderContext(): { root: RootToken; container: unknown } | null {
		return this.renderContext;
	}

	runInBatch<R>(lane: Lane, fn: () => R): R {
		this.runs.push(lane);
		return fn();
	}

	writeIn(lane: Lane, deferred = false): void {
		this.writeLane = deferred ? lane | 0x80000000 : lane;
	}

	emit<K extends keyof TapConsumer>(name: K, ...args: Parameters<TapConsumer[K]>): void {
		const consumer = this.consumer;
		if (consumer === null) throw new Error('No tap consumer is attached.');
		(consumer[name] as (...args: Parameters<TapConsumer[K]>) => void)(...args);
	}
}

function listen(registry: ReactBatchRegistry): string[] {
	const events: string[] = [];
	const listener: RegistryListener = {
		onBatchOpened: (token) => events.push(`open:${token}`),
		onRenderPassStart: (_container, tokens) => events.push(`start:${tokens.join(',')}`),
		onRenderPassYield: () => events.push('yield'),
		onRenderPassResume: () => events.push('resume'),
		onRenderPassEnd: (_container, committed) => events.push(`end:${committed}`),
		onRootCommitted: (_container, tokens) => events.push(`commit:${tokens.join(',')}`),
		onBatchRetired: (token, committed) => events.push(`retire:${token}:${committed}`),
		onBeforeMutation: () => events.push('before-mutation'),
		onAfterMutation: () => events.push('after-mutation'),
	};
	registry.subscribe(listener);
	return events;
}

describe('ReactBatchRegistry', () => {
	it('reuses a live lane identity and creates a fresh identity after retirement', () => {
		const taps = new TapsDouble();
		const registry = new ReactBatchRegistry(taps.react);
		const events = listen(registry);
		taps.writeIn(4);
		const first = registry.getCurrentWriteBatch();
		expect(first & 1).toBe(0);
		expect(registry.getCurrentWriteBatch()).toBe(first);
		expect(taps.watchedLanes).toBe(4);

		taps.emit('onEventClosed', 0, null);
		expect(registry.isBatchLive(first)).toBe(false);
		const second = registry.getCurrentWriteBatch();
		expect(second).not.toBe(first);
		expect(events).toEqual([
			`open:${first}`,
			`retire:${first}:false`,
			`open:${second}`,
		]);
	});

	it('backfills React work scheduled before the first store write', () => {
		const taps = new TapsDouble();
		const registry = new ReactBatchRegistry(taps.react);
		const events = listen(registry);
		const root = {};
		const container = {};

		taps.emit('onRootUpdated', root, container, 4);
		taps.writeIn(4, true);
		const token = registry.getCurrentWriteBatch();
		expect(token & 1).toBe(1);
		taps.emit('onScheduledRootPending', root, container, 4);
		taps.emit('onEventClosed', 0, null);
		expect(registry.isBatchLive(token)).toBe(true);

		taps.emit('onRenderPassStart', root, container, 4);
		taps.emit('onRootCommitted', root, container, 4, 0, 0);
		expect(events).toEqual([
			`open:${token}`,
			`start:${token}`,
			'end:true',
			`commit:${token}`,
			`retire:${token}:true`,
		]);
	});

	it('keeps a committed token locked into one root while another root is pending', () => {
		const taps = new TapsDouble();
		const registry = new ReactBatchRegistry(taps.react);
		const events = listen(registry);
		const rootA = {};
		const rootB = {};
		const containerA = {};
		const containerB = {};
		taps.writeIn(8, true);
		const token = registry.getCurrentWriteBatch();
		taps.emit('onRootUpdated', rootA, containerA, 8);
		taps.emit('onRootUpdated', rootB, containerB, 8);

		taps.emit('onRenderPassStart', rootA, containerA, 8);
		taps.emit('onRootCommitted', rootA, containerA, 8, 0, 0);
		expect(registry.isBatchLive(token)).toBe(true);
		taps.emit('onRenderPassStart', rootA, containerA, 2);
		taps.emit('onRootCommitted', rootA, containerA, 2, 0, 0);
		taps.emit('onRenderPassStart', rootB, containerB, 8);
		taps.emit('onRootCommitted', rootB, containerB, 8, 0, 0);

		expect(events).toEqual([
			`open:${token}`,
			`start:${token}`,
			'end:true',
			`commit:${token}`,
			`start:${token}`,
			'end:true',
			'commit:',
			`start:${token}`,
			'end:true',
			`commit:${token}`,
			`retire:${token}:true`,
		]);
	});

	it('reports a rendered batch that re-pends, then reports and retires it later', () => {
		const taps = new TapsDouble();
		const registry = new ReactBatchRegistry(taps.react);
		const events = listen(registry);
		const root = {};
		const container = {};
		taps.writeIn(16, true);
		const token = registry.getCurrentWriteBatch();
		taps.emit('onRootUpdated', root, container, 16);

		taps.emit('onRenderPassStart', root, container, 16);
		taps.emit('onRootCommitted', root, container, 16, 16, 16);
		expect(registry.isBatchLive(token)).toBe(true);
		taps.emit('onRenderPassStart', root, container, 16);
		taps.emit('onRootCommitted', root, container, 16, 0, 0);

		expect(events).toEqual([
			`open:${token}`,
			`start:${token}`,
			'end:true',
			`commit:${token}`,
			`start:${token}`,
			'end:true',
			`commit:${token}`,
			`retire:${token}:true`,
		]);
	});

	it('parks a store-only async action and ignores its stale settlement', async () => {
		const taps = new TapsDouble();
		const registry = new ReactBatchRegistry(taps.react);
		let settleFirst!: () => void;
		const firstAction = new Promise<void>((resolve) => {
			settleFirst = resolve;
		});
		taps.writeIn(32, true);
		const first = registry.getCurrentWriteBatch();
		taps.emit('onEventClosed', 32, firstAction);
		expect(registry.isBatchLive(first)).toBe(true);

		registry.reset();
		taps.writeIn(32, true);
		const second = registry.getCurrentWriteBatch();
		expect(second).not.toBe(first);
		settleFirst();
		await firstAction;
		await Promise.resolve();
		expect(registry.isBatchLive(second)).toBe(true);

		let settleSecond!: () => void;
		const secondAction = new Promise<void>((resolve) => {
			settleSecond = resolve;
		});
		taps.emit('onEventClosed', 32, secondAction);
		settleSecond();
		await secondAction;
		await Promise.resolve();
		expect(registry.isBatchLive(second)).toBe(false);
	});

	it('pairs restart, yield, resume, commit, and mutation events exactly', () => {
		const taps = new TapsDouble();
		const registry = new ReactBatchRegistry(taps.react);
		const events = listen(registry);
		const root = {};
		const container = {};

		taps.emit('onRenderPassStart', root, container, 2);
		taps.emit('onRenderPassYield', root, container);
		taps.emit('onRenderPassYield', root, container);
		taps.emit('onRenderPassResume', root, container);
		taps.emit('onRenderPassResume', root, container);
		taps.emit('onRenderPassStart', root, container, 2);
		taps.emit('onBeforeMutation', container);
		taps.emit('onAfterMutation', container);
		taps.emit('onRootCommitted', root, container, 2, 0, 0);

		expect(events).toEqual([
			'start:',
			'yield',
			'resume',
			'end:false',
			'start:',
			'before-mutation',
			'after-mutation',
			'end:true',
			'commit:',
		]);
	});

	it('distinguishes remounted roots that share a host container', () => {
		const taps = new TapsDouble();
		const registry = new ReactBatchRegistry(taps.react);
		const rootA = {};
		const rootB = {};
		const container = {};
		taps.writeIn(64, true);
		const token = registry.getCurrentWriteBatch();
		taps.emit('onRootUpdated', rootA, container, 64);
		taps.emit('onRootUpdated', rootB, container, 64);
		taps.emit('onRootCommitted', rootA, container, 64, 0, 0);
		expect(registry.isBatchLive(token)).toBe(true);
		taps.emit('onRootCommitted', rootB, container, 64, 0, 0);
		expect(registry.isBatchLive(token)).toBe(false);
	});

	it('pins live tokens and executes retired tokens urgently', () => {
		const taps = new TapsDouble();
		const registry = new ReactBatchRegistry(taps.react);
		taps.writeIn(128, true);
		const token = registry.getCurrentWriteBatch();
		expect(registry.runInBatch(token, () => 42)).toBe(42);
		taps.emit('onEventClosed', 0, null);
		expect(registry.runInBatch(token, () => 43)).toBe(43);
		expect(registry.runInBatch(0, () => 44)).toBe(44);
		expect(taps.runs).toEqual([128 | 0x80000000, 0, 0]);
	});

	it('isolates listener errors and enforces one attached registry', () => {
		const taps = new TapsDouble();
		const registry = new ReactBatchRegistry(taps.react);
		const seen: number[] = [];
		registry.subscribe({
			onBatchOpened: () => {
				throw new Error('listener failed');
			},
		});
		registry.subscribe({ onBatchOpened: (token) => seen.push(token) });
		taps.writeIn(256);
		const token = registry.getCurrentWriteBatch();
		expect(seen).toEqual([token]);
		expect(registry.errors).toHaveLength(1);
		expect(() => new ReactBatchRegistry(taps.react)).toThrow('already attached');

		registry.dispose();
		expect(taps.consumer).toBeNull();
		expect(taps.watchedLanes).toBe(0);
		expect(() => registry.subscribe({})).toThrow('disposed');
		new ReactBatchRegistry(taps.react).dispose();
	});

	it('forwards the opaque render context', () => {
		const taps = new TapsDouble();
		const registry = new ReactBatchRegistry(taps.react);
		const context = { root: {}, container: {} };
		taps.renderContext = context;
		expect(registry.getRenderContext()).toBe(context);
	});

	it('rejects stock React and protocol drift', () => {
		expect(() => new ReactBatchRegistry({})).toThrow('protocol 1');
		expect(
			() =>
				new ReactBatchRegistry({
					__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
						E: { forkProtocolVersion: 2 },
					},
				} as never),
		).toThrow('protocol 1');
	});

	it('preserves retirement invariants under deterministic tap interleavings', () => {
		const taps = new TapsDouble();
		const registry = new ReactBatchRegistry(taps.react);
		const opened = new Set<number>();
		const reported = new Set<number>();
		const retired = new Set<number>();
		const violations: string[] = [];
		registry.subscribe({
			onBatchOpened(token) {
				if (opened.has(token)) violations.push(`opened twice: ${token}`);
				opened.add(token);
			},
			onRootCommitted(_container, tokens) {
				for (const token of tokens) {
					if (!registry.isBatchLive(token)) violations.push(`reported dead: ${token}`);
					reported.add(token);
				}
			},
			onBatchRetired(token, committed) {
				if (!opened.has(token)) violations.push(`retired unopened: ${token}`);
				if (retired.has(token)) violations.push(`retired twice: ${token}`);
				if (committed && !reported.has(token)) violations.push(`retired before report: ${token}`);
				retired.add(token);
			},
		});
		const roots = [{}, {}, {}];
		const containers = [{}, {}, {}];
		const lanes = [2, 4, 8, 16];
		const allLanes = 30;
		let seed = 0x6d2b79f5;
		const random = (): number => {
			seed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			seed ^= seed + Math.imul(seed ^ (seed >>> 7), 61 | seed);
			return (seed ^ (seed >>> 14)) >>> 0;
		};

		for (let step = 0; step < 1_000; step++) {
			const rootIndex = random() % roots.length;
			const root = roots[rootIndex]!;
			const container = containers[rootIndex]!;
			const lane = lanes[random() % lanes.length]!;
			switch (random() % 8) {
				case 0:
				case 1:
					taps.writeIn(lane, (random() & 1) !== 0);
					registry.getCurrentWriteBatch();
					if ((random() & 1) !== 0) taps.emit('onRootUpdated', root, container, lane);
					break;
				case 2:
					taps.emit('onScheduledRootPending', root, container, random() & allLanes);
					break;
				case 3:
					taps.emit('onRenderPassStart', root, container, random() & allLanes);
					break;
				case 4:
					taps.emit('onRenderPassYield', root, container);
					taps.emit('onRenderPassResume', root, container);
					break;
				case 5: {
					const repended = (random() & 3) === 0 ? lane : 0;
					taps.emit('onRootCommitted', root, container, lane, repended, repended);
					break;
				}
				default:
					taps.emit('onEventClosed', 0, null);
			}
		}
		for (let i = 0; i < roots.length; i++) {
			taps.emit('onRenderPassStart', roots[i]!, containers[i]!, allLanes);
			taps.emit('onRootCommitted', roots[i]!, containers[i]!, allLanes, 0, 0);
		}
		taps.emit('onEventClosed', 0, null);

		expect(violations).toEqual([]);
		expect(retired).toEqual(opened);
		expect(registry.liveTokens()).toEqual([]);
		expect(taps.watchedLanes).toBe(0);
		expect(registry.errors).toEqual([]);
	});

	it.runIf(typeof globalThis.gc === 'function')(
		'releases root and container identities after retirement',
		async () => {
			const taps = new TapsDouble();
			const registry = new ReactBatchRegistry(taps.react);
			const references = (() => {
				const root = {};
				const container = {};
				taps.writeIn(512, true);
				registry.getCurrentWriteBatch();
				taps.emit('onRootUpdated', root, container, 512);
				taps.emit('onRenderPassStart', root, container, 512);
				taps.emit('onRootCommitted', root, container, 512, 0, 0);
				return [new WeakRef(root), new WeakRef(container)];
			})();
			expect(registry.liveTokens()).toEqual([]);
			for (let i = 0; i < 20; i++) {
				(globalThis.gc as () => void)();
				await new Promise((resolve) => setTimeout(resolve, 2));
			}
			expect(references[0]!.deref()).toBeUndefined();
			expect(references[1]!.deref()).toBeUndefined();
			registry.dispose();
		},
	);
});
