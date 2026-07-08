export interface TraceEvent {
  id: number;
  kind: string;
  cause?: number;
  target?: number;
  detail?: string;
}

export interface TraceView {
  whyLastDelivery(target: unknown): string[];
  events(): TraceEvent[];
  stop(): void;
}

interface Recorder {
  capacity: number;
  events: TraceEvent[];
  overflow: number;
  latest: Map<number, number>;
}

const recorders = new Set<Recorder>();
const causes = new Map<number, number>();
let nextEvent = 1;

export function emit(kind: string, target?: number, cause?: number, detail?: string): number {
  if (recorders.size === 0) return 0;
  const id = nextEvent++;
  const event = { id, kind, cause, target, detail };
  for (const recorder of recorders) {
    if (recorder.events.length === recorder.capacity) {
      recorder.events.shift();
      recorder.overflow++;
    }
    recorder.events.push(event);
    if (target !== undefined && (kind === 'component delivery' || kind === 'effect run')) {
      recorder.latest.set(target, id);
    }
  }
  if (target !== undefined && kind !== 'component delivery' && kind !== 'effect run') causes.set(target, id);
  return id;
}

export function causeFor(target: number): number | undefined {
  return causes.get(target);
}

export function createTrace(capacity = 1024): TraceView {
  const recorder: Recorder = { capacity, events: [], overflow: 0, latest: new Map() };
  recorders.add(recorder);
  return {
    whyLastDelivery(target: unknown): string[] {
      const cell = target as { id?: number };
      let id = cell?.id === undefined ? undefined : recorder.latest.get(cell.id);
      const chain: string[] = [];
      while (id !== undefined) {
        const event = recorder.events.find(candidate => candidate.id === id);
        if (event === undefined) break;
        chain.push(`${event.id}: ${event.kind}${event.detail === undefined ? '' : ` (${event.detail})`}`);
        id = event.cause;
      }
      if (recorder.overflow !== 0) chain.push(`overflow: ${recorder.overflow} event(s) dropped`);
      return chain;
    },
    events: () => recorder.events.slice(),
    stop() { recorders.delete(recorder); },
  };
}
