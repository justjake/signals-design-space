/**
 * Causality debug log.
 *
 * Every engine and host operation emits an event with a causal parent, so
 * "why did this component re-render?" is answered by walking parents from
 * the delivery back to the originating write or batch retirement. Unrelated
 * operations never chain: causes are threaded through the actual dispatch
 * path (write → notify → deliver → render), not through wall-clock adjacency.
 *
 * The tracer is attachable at runtime; when detached every emit site costs a
 * single null check. Ring mode keeps memory bounded: overflow evicts the
 * oldest events and counts them (never silently).
 */
import { setTraceSink, type TraceEventId, type TraceSink } from "./engine";

export interface TraceEvent {
  id: TraceEventId;
  kind: string;
  cause: TraceEventId;
  detail?: string;
  /** The signal/computed involved, when the event is about one. */
  node?: object;
}

export interface TracerOptions {
  /** Ring capacity in events. Default 4096. */
  capacity?: number;
}

export class Tracer implements TraceSink {
  private ring: Array<TraceEvent | undefined>;
  private capacity: number;
  private nextId: TraceEventId = 1;
  /** Events evicted by the ring; counted, never silent. */
  overflow = 0;
  private stopped = false;

  constructor(opts?: TracerOptions) {
    this.capacity = Math.max(16, opts?.capacity ?? 4096);
    this.ring = new Array(this.capacity);
  }

  emit(kind: string, cause: TraceEventId, detail?: string, node?: object): TraceEventId {
    if (this.stopped) return 0;
    const id = this.nextId++;
    const slot = id % this.capacity;
    if (this.ring[slot] !== undefined) this.overflow++;
    this.ring[slot] = { id, kind, cause, detail, node };
    return id;
  }

  get(id: TraceEventId): TraceEvent | undefined {
    if (id <= 0) return undefined;
    const e = this.ring[id % this.capacity];
    return e !== undefined && e.id === id ? e : undefined;
  }

  /** All retained events, oldest first. */
  events(): TraceEvent[] {
    const out: TraceEvent[] = [];
    for (const e of this.ring) if (e !== undefined) out.push(e);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  /** Newest retained event matching a predicate. */
  findLast(match: (e: TraceEvent) => boolean): TraceEvent | undefined {
    const all = this.events();
    for (let i = all.length - 1; i >= 0; i--) if (match(all[i]!)) return all[i];
    return undefined;
  }

  /** The causal chain ending at `id`, oldest cause first. */
  chain(id: TraceEventId): TraceEvent[] {
    const out: TraceEvent[] = [];
    let cur = this.get(id);
    let guard = 0;
    while (cur !== undefined && guard++ < 1000) {
      out.push(cur);
      if (cur.cause === 0) break;
      const parent = this.get(cur.cause);
      if (parent === undefined) {
        out.push({ id: cur.cause, kind: "(evicted)", cause: 0 });
        break;
      }
      cur = parent;
    }
    return out.reverse();
  }

  format(e: TraceEvent): string {
    const causeText = e.cause !== 0 ? ` ← #${e.cause}` : "";
    const detail = e.detail !== undefined ? ` ${e.detail}` : "";
    return `#${e.id} ${e.kind}${detail}${causeText}`;
  }

  formatChain(id: TraceEventId): string[] {
    return this.chain(id).map((e) => this.format(e));
  }

  /**
   * Human answer to "why did the component watching x last re-render?":
   * the chain from the most recent render/delivery event about `node` back
   * to the write or batch retirement that started it.
   */
  whyLastDelivery(node: object): string[] {
    const hit = this.findLast(
      (e) => e.node === node && (e.kind === "render" || e.kind === "deliver"),
    );
    if (hit === undefined) return [`no delivery recorded for this node`];
    return this.formatChain(hit.id);
  }

  stop(): void {
    this.stopped = true;
    setTraceSink(null);
  }
}

/** Attach a tracer (replacing any previous one) and return it. */
export function startTrace(opts?: TracerOptions): Tracer {
  const tracer = new Tracer(opts);
  setTraceSink(tracer);
  return tracer;
}
