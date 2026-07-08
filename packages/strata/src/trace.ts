import { Atom, Computed, defaultRuntime, type Runtime, type TraceSink } from './index.js';

export interface CausalityEvent {
	readonly id: number;
	readonly kind: string;
	readonly cause: number;
	readonly target?: string;
	readonly detail?: unknown;
}

export class CausalityLog implements TraceSink {
	readonly capacity: number;
	overflow = 0;
	private nextEvent = 1;
	private nextTarget = 1;
	private cursor = 0;
	private size = 0;
	private readonly ring: Array<CausalityEvent | undefined>;
	private readonly byId = new Map<number, CausalityEvent>();
	private readonly targetIds = new WeakMap<object, number>();
	private readonly lastByTarget = new WeakMap<object, number>();
	private readonly detach: () => void;

	constructor(readonly runtime: Runtime = defaultRuntime, capacity = 1024) {
		this.capacity = capacity;
		this.ring = new Array(capacity);
		this.detach = runtime.attachTrace(this);
	}

	emit(kind: string, target: object | undefined, cause: number, detail?: unknown): number {
		const id = this.nextEvent++;
		let targetName: string | undefined;
		if (target !== undefined) {
			let targetId = this.targetIds.get(target);
			if (targetId === undefined) {
				targetId = this.nextTarget++;
				this.targetIds.set(target, targetId);
			}
			if (target instanceof Atom) {
				targetName = target.label ?? `atom#${targetId}`;
			} else if (target instanceof Computed) {
				targetName = target.label ?? `computed#${targetId}`;
			} else {
				targetName = `object#${targetId}`;
			}
			this.lastByTarget.set(target, id);
		}
		const event: CausalityEvent = { id, kind, cause, target: targetName, detail };
		const evicted = this.ring[this.cursor];
		if (evicted !== undefined) {
			this.byId.delete(evicted.id);
			this.overflow++;
		} else {
			this.size++;
		}
		this.ring[this.cursor] = event;
		this.cursor = (this.cursor + 1) % this.capacity;
		this.byId.set(id, event);
		return id;
	}

	events(): CausalityEvent[] {
		const result: CausalityEvent[] = [];
		const start = this.size === this.capacity ? this.cursor : 0;
		for (let i = 0; i < this.size; i++) {
			const event = this.ring[(start + i) % this.capacity];
			if (event !== undefined) result.push(event);
		}
		return result;
	}

	why(target: object): CausalityEvent[] {
		return this.causeChain(this.lastByTarget.get(target) ?? 0);
	}

	decode(id: number): CausalityEvent | undefined {
		return this.byId.get(id);
	}

	causeChain(id: number): CausalityEvent[] {
		const result: CausalityEvent[] = [];
		while (id !== 0) {
			const event = this.byId.get(id);
			if (event === undefined) break;
			result.push(event);
			id = event.cause;
		}
		return result;
	}

	explain(target: object): string[] {
		const chain = this.why(target);
		const result: string[] = [];
		for (let i = 0; i < chain.length; i++) {
			const event = chain[i]!;
			result.push(
				`#${event.id} ${event.kind}${
					event.target === undefined ? '' : ` ${event.target}`
				} cause=${event.cause === 0 ? 'root' : `#${event.cause}`}`,
			);
		}
		return result;
	}

	stop(): void {
		this.detach();
	}
}

export function trace(runtime: Runtime = defaultRuntime, capacity = 1024): CausalityLog {
	return new CausalityLog(runtime, capacity);
}
