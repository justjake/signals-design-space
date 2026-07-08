import { computed, refresh, resolveComputed, type Cell, type ComputedOptions } from "./core.ts";
import { emit } from "./trace.ts";

interface PromiseRecord {
  status: 0 | 1 | 2;
  value?: unknown;
}

const records = new WeakMap<object, PromiseRecord>();

export function asyncComputed<T>(
  calculate: (use: <U>(thenable: PromiseLike<U>) => U) => T,
  options?: ComputedOptions<T>,
): Cell<T> {
  let cell: Cell<T>;
  let lastPending: PromiseLike<unknown>[] = [];
  let gate: Promise<void> | undefined;
  cell = computed(() => {
    const pending: PromiseLike<unknown>[] = [];
    const use = <U>(thenable: PromiseLike<U>): U => {
      let record = records.get(thenable as object);
      if (record === undefined) {
        record = { status: 0 };
        records.set(thenable as object, record);
        thenable.then(
          (value) => {
            record!.status = 1;
            record!.value = value;
          },
          (error) => {
            record!.status = 2;
            record!.value = error;
          },
        );
      }
      if (record.status === 1) return record.value as U;
      if (record.status === 2) throw record.value;
      pending.push(thenable);
      return undefined as U;
    };
    let result: T | undefined;
    let failure: unknown;
    try {
      result = calculate(use);
    } catch (error) {
      failure = error;
    }
    if (pending.length !== 0) {
      let same = pending.length === lastPending.length;
      for (let i = 0; same && i < pending.length; i++) same = pending[i] === lastPending[i];
      if (!same) {
        lastPending = pending;
        gate = Promise.all(pending.map((value) => Promise.resolve(value))).then(
          (resolved) => {
            if (pending.length === 1 && result === undefined)
              resolveComputed(cell, resolved[0] as T);
            else {
              emit("suspense settlement", cell.id);
              refresh(cell);
            }
          },
          () => {
            emit("suspense settlement", cell.id);
            refresh(cell);
          },
        );
      }
      throw gate!;
    }
    if (failure !== undefined) throw failure;
    return result as T;
  }, options);
  return cell;
}
