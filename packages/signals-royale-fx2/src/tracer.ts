/**
 * Causality debug log: an attachable tracer that answers "why did this
 * happen?". Every event carries a causal parent id, so the chain from a
 * component's latest re-render (or an effect's latest run) walks back to
 * the originating write, batch retirement, or thenable settlement.
 *
 * Detached cost is one null check per emit site. Attached, events go into a
 * bounded ring; overflow evicts the oldest events and counts them — never
 * silently.
 */

import { type ReactiveNode, type TraceEventId, NO_EVENT, setTraceHook } from './graph.ts';

export interface TraceEvent {
  id: TraceEventId;
  kind: string;
  /** Causal parent event id; NO_EVENT when the operation was a root cause. */
  cause: TraceEventId;
  label: string | undefined;
  data: unknown;
}

export interface TracerOptions {
  /** Ring capacity in events; overflow evicts oldest and is counted. */
  capacity?: number;
}

/** Hard ceilings and defaults for the ring and its walks. */
const enum Limit {
  /** Smallest allowed ring; tiny rings evict too fast to answer anything. */
  MinCapacity = 16,
  /** Default ring capacity in events. */
  DefaultCapacity = 4096,
  /** whyLastDelivery chain ceiling: a corrupt cause chain must not hang. */
  MaxChainWalk = 1000,
}

export class Tracer {
  private ring: (TraceEvent | undefined)[];
  private head = 0;
  private size = 0;
  private nextId: TraceEventId = 1;
  private stopped = false;
  /** Events evicted by ring overflow. */
  dropped = 0;
  /** Most recent delivery event per node (component re-render / effect run). */
  private lastDelivery = new Map<ReactiveNode | object, TraceEventId>();

  constructor(opts?: TracerOptions) {
    const capacity = Math.max(Limit.MinCapacity, opts?.capacity ?? Limit.DefaultCapacity);
    this.ring = new Array(capacity);
  }

  emit(kind: string, node: ReactiveNode | null, cause: TraceEventId, data?: unknown): TraceEventId {
    if (this.stopped) return NO_EVENT;
    const id = this.nextId++;
    const evt: TraceEvent = { id, kind, cause, label: node?.label, data };
    if (this.size === this.ring.length) {
      this.head = (this.head + 1) % this.ring.length;
      this.dropped++;
    } else {
      this.size++;
    }
    this.ring[(this.head + this.size - 1) % this.ring.length] = evt;
    if (kind === 'deliver' || kind === 'effect-run') {
      if (node !== null) this.lastDelivery.set(node, id);
    }
    return id;
  }

  /** All retained events, oldest first. */
  events(): TraceEvent[] {
    const out: TraceEvent[] = [];
    for (let i = 0; i < this.size; i++) {
      const evt = this.ring[(this.head + i) % this.ring.length];
      if (evt !== undefined) out.push(evt);
    }
    return out;
  }

  find(id: TraceEventId): TraceEvent | undefined {
    for (let i = this.size - 1; i >= 0; i--) {
      const evt = this.ring[(this.head + i) % this.ring.length];
      if (evt !== undefined && evt.id === id) return evt;
      if (evt !== undefined && evt.id < id) break;
    }
    return undefined;
  }

  format(evt: TraceEvent): string {
    const label = evt.label !== undefined ? ` ${JSON.stringify(evt.label)}` : '';
    const data =
      evt.data !== undefined && evt.data !== null ? ` ${JSON.stringify(evt.data)}` : '';
    return `#${evt.id} ${evt.kind}${label}${data}`;
  }

  /**
   * The causal chain from the most recent delivery caused by this node,
   * back to its originating write or retirement, human-readable.
   */
  whyLastDelivery(node: ReactiveNode | object): string[] {
    const start = this.lastDelivery.get(node);
    if (start === undefined) return ['(no delivery recorded for this node)'];
    const chain: string[] = [];
    let id: TraceEventId = start;
    let guard = 0;
    while (id !== NO_EVENT && guard++ < Limit.MaxChainWalk) {
      const evt = this.find(id);
      if (evt === undefined) {
        chain.push(`#${id} (evicted from ring; ${this.dropped} events dropped)`);
        break;
      }
      chain.push(this.format(evt));
      id = evt.cause;
    }
    return chain;
  }

  stop(): void {
    this.stopped = true;
    if (activeTracer === this) {
      activeTracer = null;
      setTraceHook(null);
    }
  }
}

let activeTracer: Tracer | null = null;

/** Attach a tracer (replacing any active one). Detach via session.stop(). */
export function attachTracer(opts?: TracerOptions): Tracer {
  activeTracer?.stop();
  const tracer = new Tracer(opts);
  activeTracer = tracer;
  setTraceHook((kind, node, cause, data) => tracer.emit(kind, node, cause, data));
  return tracer;
}

export function getActiveTracer(): Tracer | null {
  return activeTracer;
}
