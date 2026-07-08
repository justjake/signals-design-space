import type { RuntimeEvent } from "signals-royale-sm2";
import { getRuntime } from "./protocol";

interface TraceEvent {
  id: number;
  kind: string;
  cause?: number;
  subject?: unknown;
  batchId?: number;
}

export interface TraceView {
  whyLastDelivery(subject: unknown): string[];
  events(): Array<{ id: number; kind: string; cause?: number }>;
  stop(): void;
}

export function trace(capacity = 1024): TraceView {
  const records: TraceEvent[] = [];
  const byId = new Map<number, TraceEvent>();
  const batchOpen = new Map<number, number>();
  const batchCause = new Map<number, number>();
  const subjectCause = new Map<unknown, number>();
  let nextId = 1;
  let overflow = 0;

  const unsubscribe = getRuntime().subscribeDebug((event: RuntimeEvent) => {
    let cause: number | undefined;
    if (event.batchId !== undefined) {
      cause = batchCause.get(event.batchId) ?? batchOpen.get(event.batchId);
    }
    if (cause === undefined && event.subject !== undefined) cause = subjectCause.get(event.subject);
    const record: TraceEvent = {
      id: nextId++,
      kind: event.kind,
      cause,
      subject: event.subject,
      batchId: event.batchId,
    };
    if (records.length === capacity) {
      const removed = records.shift();
      if (removed !== undefined) byId.delete(removed.id);
      ++overflow;
    }
    records.push(record);
    byId.set(record.id, record);
    if (event.kind === "batch-open" && event.batchId !== undefined) {
      batchOpen.set(event.batchId, record.id);
    }
    if (
      event.batchId !== undefined &&
      (event.kind === "write" ||
        event.kind === "refresh" ||
        event.kind === "render-pass-start" ||
        event.kind === "root-commit" ||
        event.kind === "batch-retire")
    ) {
      batchCause.set(event.batchId, record.id);
    }
    if (event.subject !== undefined) subjectCause.set(event.subject, record.id);
  });

  return {
    whyLastDelivery(subject) {
      let current: TraceEvent | undefined;
      for (let i = records.length - 1; i >= 0; --i) {
        const candidate = records[i];
        if (
          candidate.subject === subject &&
          (candidate.kind === "component-render" || candidate.kind === "component-delivery")
        ) {
          current = candidate;
          break;
        }
      }
      const lines: string[] = [];
      while (current !== undefined) {
        lines.push(`${current.kind}#${current.id}`);
        current = current.cause === undefined ? undefined : byId.get(current.cause);
      }
      return lines;
    },
    events() {
      const result: Array<{ id: number; kind: string; cause?: number }> = [];
      if (overflow !== 0) result.push({ id: 0, kind: `overflow:${overflow}` });
      for (const event of records) {
        result.push({ id: event.id, kind: event.kind, cause: event.cause });
      }
      return result;
    },
    stop: unsubscribe,
  };
}
