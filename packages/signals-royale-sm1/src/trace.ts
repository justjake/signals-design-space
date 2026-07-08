export type TraceEvent = {
  id: number;
  kind: string;
  cause?: number;
  batch?: number;
  label?: string;
  detail?: string;
};

let activeTrace: Trace | null = null;
let nextEventId = 1;
let ambientCause: number | undefined;

export class Trace {
  readonly capacity: number;
  overflow = 0;
  private readonly ring: Array<TraceEvent | undefined>;
  private readonly byId = new Map<number, TraceEvent>();
  private readonly latestDelivery = new WeakMap<object, number>();
  private start = 0;
  private size = 0;
  private stopped = false;

  constructor(capacity = 1024) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Trace capacity must be a positive integer.");
    }
    this.capacity = capacity;
    this.ring = new Array(capacity);
    activeTrace = this;
  }

  add(event: TraceEvent, target?: object): void {
    if (this.stopped) return;
    if (this.size === this.capacity) {
      const removed = this.ring[this.start];
      if (removed !== undefined) this.byId.delete(removed.id);
      this.start = (this.start + 1) % this.capacity;
      this.size--;
      this.overflow++;
    }
    const index = (this.start + this.size) % this.capacity;
    this.ring[index] = event;
    this.byId.set(event.id, event);
    this.size++;
    if (target !== undefined && event.kind === "component delivery") {
      this.latestDelivery.set(target, event.id);
    }
  }

  events(): TraceEvent[] {
    const result: TraceEvent[] = [];
    for (let i = 0; i < this.size; i++) {
      const event = this.ring[(this.start + i) % this.capacity];
      if (event !== undefined) result.push(event);
    }
    return result;
  }

  whyLastDelivery(target: object): string[] {
    let id = this.latestDelivery.get(target);
    const result: string[] = [];
    const seen = new Set<number>();
    while (id !== undefined && !seen.has(id)) {
      seen.add(id);
      const event = this.byId.get(id);
      if (event === undefined) {
        result.push(`#${id} [discarded from ring]`);
        break;
      }
      let line = `#${event.id} ${event.kind}`;
      if (event.label !== undefined) line += ` ${event.label}`;
      if (event.batch !== undefined) line += ` [lane ${event.batch}]`;
      if (event.detail !== undefined) line += `: ${event.detail}`;
      result.push(line);
      id = event.cause;
    }
    if (this.overflow !== 0) result.push(`[trace overflow: ${this.overflow}]`);
    return result;
  }

  stop(): void {
    this.stopped = true;
    if (activeTrace === this) activeTrace = null;
  }
}

export function startTrace(capacity?: number): Trace {
  if (activeTrace !== null) activeTrace.stop();
  return new Trace(capacity);
}

export function traceEmit(
  kind: string,
  options?: {
    cause?: number;
    target?: object;
    batch?: number;
    label?: string;
    detail?: string;
  },
): number {
  const trace = activeTrace;
  if (trace === null) return 0;
  const id = nextEventId++;
  trace.add(
    {
      id,
      kind,
      cause: options?.cause ?? ambientCause,
      batch: options?.batch,
      label: options?.label,
      detail: options?.detail,
    },
    options?.target,
  );
  return id;
}

export function withTraceCause<T>(cause: number | undefined, fn: () => T): T {
  const previous = ambientCause;
  ambientCause = cause;
  try {
    return fn();
  } finally {
    ambientCause = previous;
  }
}

export function currentTraceCause(): number | undefined {
  return ambientCause;
}

export function resetTraceForTest(): void {
  if (activeTrace !== null) activeTrace.stop();
  activeTrace = null;
  ambientCause = undefined;
}
