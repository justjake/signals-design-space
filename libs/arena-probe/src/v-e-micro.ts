/**
 * VARIANT A+D+E — growth off + link split + walker micro-structure.
 * Same as v-d-linksplit, plus:
 * - propagate: scratch stack + sp cached in locals (propagate never re-enters
 *   user code, so module state only needs a growth write-back).
 * - checkDirty: scratch stack + sp cached in locals; module checkSp synced
 *   only around update() calls (which can re-enter checkDirty via getters);
 *   try/finally removed (PROBE ONLY: a throwing getter now leaks stack slots).
 * Measures the module-let context-traffic + try/finally tax in the walkers.
 */

// ---- record layout ---------------------------------------------------------
const FLAGS = 0
const DEPS = 1
const DEPS_TAIL = 2
const SUBS = 3
const SUBS_TAIL = 4
const GEN = 5

const VERSION = 0
const DEP = 1
const SUB = 2
const PREV_SUB = 3
const NEXT_SUB = 4
const PREV_DEP = 5
const NEXT_DEP = 6

const MUTABLE = 1
const WATCHING = 2
const RECURSED_CHECK = 4
const RECURSED = 8
const DIRTY = 16
const PENDING = 32
const HAS_CHILD_EFFECT = 64
const K_SIGNAL = 128
const K_COMPUTED = 256
const K_EFFECT = 512
const K_SCOPE = 1024
const KIND_MASK = K_SIGNAL | K_COMPUTED | K_EFFECT | K_SCOPE

// ---- state ------------------------------------------------------------------
let nodeNext = 8
let linkNext = 8
let nodeFreeHead = 0
let linkFreeHead = 0

let cycle = 0
let runDepth = 0
let batchDepth = 0
let notifyIndex = 0
let queuedLength = 0
let activeSub = 0

const queued: number[] = []

const values: unknown[] = [undefined, undefined]
const fns: (Function | undefined)[] = [undefined]

let propStack = new Int32Array(4096)
let propSp = 0
let checkStack = new Int32Array(4096)
let checkSp = 0

const initialRecords = (() => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.ARENA_PROBE_INITIAL_RECORDS
  const n = env !== undefined ? Number(env) : NaN
  return Number.isFinite(n) && n >= 2 ? Math.ceil(n) : 1 << 20
})()

const N = new Int32Array(initialRecords * 8)
const L = new Int32Array(initialRecords * 2 * 8)

// ---- allocation ----------------------------------------------------------

function allocNode(flags: number): number {
  let id: number
  if (nodeFreeHead !== 0) {
    id = nodeFreeHead
    nodeFreeHead = N[id + DEPS]
    N[id + DEPS] = 0
  } else {
    id = nodeNext
    if (id >= N.length) {
      throw new Error("@lab/arena-probe: node arena exhausted; raise ARENA_PROBE_INITIAL_RECORDS")
    }
    nodeNext = id + 8
  }
  N[id + FLAGS] = flags
  const v = id >> 2
  while (values.length <= v + 1) {
    values.push(undefined)
  }
  while (fns.length <= id >> 3) {
    fns.push(undefined)
  }
  return id
}

function allocLink(): number {
  let id: number
  if (linkFreeHead !== 0) {
    id = linkFreeHead
    linkFreeHead = L[id + NEXT_DEP]
  } else {
    id = linkNext
    if (id >= L.length) {
      throw new Error("@lab/arena-probe: link arena exhausted; raise ARENA_PROBE_INITIAL_RECORDS")
    }
    linkNext = id + 8
  }
  return id
}

function freeLink(id: number): void {
  L[id + NEXT_DEP] = linkFreeHead
  linkFreeHead = id
}

// ---- system.ts transliteration -------------------------------------------

function link(dep: number, sub: number, version: number): void {
  const prevDep = N[sub + DEPS_TAIL]
  if (prevDep !== 0 && L[prevDep + DEP] === dep) {
    return
  }
  const nextDep = prevDep !== 0 ? L[prevDep + NEXT_DEP] : N[sub + DEPS]
  if (nextDep !== 0 && L[nextDep + DEP] === dep) {
    L[nextDep + VERSION] = version
    N[sub + DEPS_TAIL] = nextDep
    return
  }
  linkInsert(dep, sub, version, prevDep, nextDep)
}

function linkInsert(
  dep: number,
  sub: number,
  version: number,
  prevDep: number,
  nextDep: number,
): void {
  const prevSub = N[dep + SUBS_TAIL]
  if (prevSub !== 0 && L[prevSub + VERSION] === version && L[prevSub + SUB] === sub) {
    return
  }
  const newLink = allocLink()
  N[sub + DEPS_TAIL] = newLink
  N[dep + SUBS_TAIL] = newLink
  L[newLink + VERSION] = version
  L[newLink + DEP] = dep
  L[newLink + SUB] = sub
  L[newLink + PREV_DEP] = prevDep
  L[newLink + NEXT_DEP] = nextDep
  L[newLink + PREV_SUB] = prevSub
  L[newLink + NEXT_SUB] = 0
  if (nextDep !== 0) {
    L[nextDep + PREV_DEP] = newLink
  }
  if (prevDep !== 0) {
    L[prevDep + NEXT_DEP] = newLink
  } else {
    N[sub + DEPS] = newLink
  }
  if (prevSub !== 0) {
    L[prevSub + NEXT_SUB] = newLink
  } else {
    N[dep + SUBS] = newLink
  }
}

function unlink(id: number, sub = L[id + SUB]): number {
  const dep = L[id + DEP]
  const prevDep = L[id + PREV_DEP]
  const nextDep = L[id + NEXT_DEP]
  const nextSub = L[id + NEXT_SUB]
  const prevSub = L[id + PREV_SUB]
  if (nextDep !== 0) {
    L[nextDep + PREV_DEP] = prevDep
  } else {
    N[sub + DEPS_TAIL] = prevDep
  }
  if (prevDep !== 0) {
    L[prevDep + NEXT_DEP] = nextDep
  } else {
    N[sub + DEPS] = nextDep
  }
  if (nextSub !== 0) {
    L[nextSub + PREV_SUB] = prevSub
  } else {
    N[dep + SUBS_TAIL] = prevSub
  }
  freeLink(id)
  if (prevSub !== 0) {
    L[prevSub + NEXT_SUB] = nextSub
  } else if ((N[dep + SUBS] = nextSub) === 0) {
    unwatched(dep)
  }
  return nextDep
}

function propagate(startLink: number, innerWrite: boolean): void {
  let cur = startLink
  let next = L[cur + NEXT_SUB]
  let stack = propStack
  let sp = propSp
  const stackBase = sp

  top: do {
    const sub = L[cur + SUB]
    let flags = N[sub + FLAGS]

    if (!(flags & (RECURSED_CHECK | RECURSED | DIRTY | PENDING))) {
      N[sub + FLAGS] = flags | PENDING
      if (innerWrite) {
        N[sub + FLAGS] |= RECURSED
      }
    } else if (!(flags & (RECURSED_CHECK | RECURSED))) {
      flags = 0
    } else if (!(flags & RECURSED_CHECK)) {
      N[sub + FLAGS] = (flags & ~RECURSED) | PENDING
    } else if (!(flags & (DIRTY | PENDING)) && isValidLink(cur, sub)) {
      N[sub + FLAGS] = flags | (RECURSED | PENDING)
      flags &= MUTABLE
    } else {
      flags = 0
    }

    if (flags & WATCHING) {
      notify(sub)
    }

    if (flags & MUTABLE) {
      const subSubs = N[sub + SUBS]
      if (subSubs !== 0) {
        cur = subSubs
        const nextSub = L[cur + NEXT_SUB]
        if (nextSub !== 0) {
          if (sp === stack.length) {
            const bigger = new Int32Array(stack.length * 2)
            bigger.set(stack)
            propStack = stack = bigger
          }
          stack[sp++] = next
          next = nextSub
        }
        continue
      }
    }

    if ((cur = next) !== 0) {
      next = L[cur + NEXT_SUB]
      continue
    }

    while (sp > stackBase) {
      cur = stack[--sp]
      if (cur !== 0) {
        next = L[cur + NEXT_SUB]
        continue top
      }
    }

    break
  } while (true)
}

function checkDirty(startLink: number, startSub: number): boolean {
  let cur = startLink
  let sub = startSub
  let stack = checkStack
  let sp = checkSp
  const stackBase = sp
  let checkDepth = 0
  let dirty = false

  // PROBE ONLY: try/finally removed — a throwing getter leaks stack slots.
  top: do {
    const dep = L[cur + DEP]
    const depFlags = N[dep + FLAGS]

    if (N[sub + FLAGS] & DIRTY) {
      dirty = true
    } else if ((depFlags & (MUTABLE | DIRTY)) === (MUTABLE | DIRTY)) {
      const depSubs = N[dep + SUBS]
      checkSp = sp // publish: update() may re-enter checkDirty
      if (update(dep)) {
        stack = checkStack // reload: inner call may have grown it
        if (L[depSubs + NEXT_SUB] !== 0) {
          shallowPropagate(depSubs)
        }
        dirty = true
      } else {
        stack = checkStack
      }
    } else if ((depFlags & (MUTABLE | PENDING)) === (MUTABLE | PENDING)) {
      if (sp === stack.length) {
        const bigger = new Int32Array(stack.length * 2)
        bigger.set(stack)
        checkStack = stack = bigger
      }
      stack[sp++] = cur
      cur = N[dep + DEPS]
      sub = dep
      ++checkDepth
      continue
    }

    if (!dirty) {
      const nextDep = L[cur + NEXT_DEP]
      if (nextDep !== 0) {
        cur = nextDep
        continue
      }
    }

    while (checkDepth--) {
      cur = stack[--sp]
      if (dirty) {
        const subSubs = N[sub + SUBS]
        checkSp = sp // publish: update() may re-enter checkDirty
        if (update(sub)) {
          stack = checkStack
          if (L[subSubs + NEXT_SUB] !== 0) {
            shallowPropagate(subSubs)
          }
          sub = L[cur + SUB]
          continue
        }
        stack = checkStack
        dirty = false
      } else {
        N[sub + FLAGS] &= ~PENDING
      }
      sub = L[cur + SUB]
      const nextDep = L[cur + NEXT_DEP]
      if (nextDep !== 0) {
        cur = nextDep
        continue top
      }
    }

    checkSp = stackBase
    return dirty && N[sub + FLAGS] !== 0
  } while (true)
}

function shallowPropagate(startLink: number): void {
  let cur = startLink
  do {
    const sub = L[cur + SUB]
    const flags = N[sub + FLAGS]
    if ((flags & (PENDING | DIRTY)) === PENDING) {
      N[sub + FLAGS] = flags | DIRTY
      if ((flags & (WATCHING | RECURSED_CHECK)) === WATCHING) {
        notify(sub)
      }
    }
  } while ((cur = L[cur + NEXT_SUB]) !== 0)
}

function isValidLink(checkLink: number, sub: number): boolean {
  let cur = N[sub + DEPS_TAIL]
  while (cur !== 0) {
    if (cur === checkLink) {
      return true
    }
    cur = L[cur + PREV_DEP]
  }
  return false
}

// ---- index.ts transliteration ---------------------------------------------

function update(node: number): boolean {
  const flags = N[node + FLAGS]
  if (flags & K_COMPUTED) {
    return updateComputed(node)
  }
  if (flags & K_SIGNAL) {
    return updateSignal(node)
  }
  N[node + FLAGS] = (flags & KIND_MASK) | MUTABLE
  return true
}

function notify(e: number): void {
  let insertIndex = queuedLength
  const firstInsertedIndex = insertIndex

  do {
    queued[insertIndex++] = e
    N[e + FLAGS] &= ~WATCHING
    const subs = N[e + SUBS]
    e = subs !== 0 ? L[subs + SUB] : 0
    if (e === 0 || !(N[e + FLAGS] & WATCHING)) {
      break
    }
  } while (true)

  queuedLength = insertIndex

  let left = firstInsertedIndex
  while (left < --insertIndex) {
    const tmp = queued[left]
    queued[left++] = queued[insertIndex]
    queued[insertIndex] = tmp
  }
}

function unwatched(node: number): void {
  const flags = N[node + FLAGS]
  if (flags & K_COMPUTED) {
    if (N[node + DEPS_TAIL] !== 0) {
      N[node + FLAGS] = K_COMPUTED | MUTABLE | DIRTY
      disposeAllDepsInReverse(node)
    }
  } else if (flags & K_SIGNAL) {
    // Nothing to do for signals.
  } else if (flags & (K_EFFECT | K_SCOPE)) {
    dispose(node)
  }
}

function unlinkChildEffects(sub: number): void {
  let cur = N[sub + DEPS_TAIL]
  while (cur !== 0) {
    const prev = L[cur + PREV_DEP]
    const dep = L[cur + DEP]
    if (!(N[dep + FLAGS] & (K_COMPUTED | K_SIGNAL))) {
      unlink(cur, sub)
    }
    cur = prev
  }
}

function updateComputed(c: number): boolean {
  if (N[c + FLAGS] & HAS_CHILD_EFFECT) {
    unlinkChildEffects(c)
  }
  N[c + DEPS_TAIL] = 0
  N[c + FLAGS] = K_COMPUTED | MUTABLE | RECURSED_CHECK
  const prevSub = activeSub
  activeSub = c
  try {
    ++cycle
    const v = c >> 2
    const oldValue = values[v]
    return (
      oldValue !== (values[v] = (fns[c >> 3] as (previousValue?: unknown) => unknown)(oldValue))
    )
  } finally {
    activeSub = prevSub
    N[c + FLAGS] &= ~RECURSED_CHECK
    purgeDeps(c)
  }
}

function updateSignal(s: number): boolean {
  N[s + FLAGS] = K_SIGNAL | MUTABLE
  const v = s >> 2
  return values[v] !== (values[v] = values[v + 1])
}

function run(e: number): void {
  const flags = N[e + FLAGS]
  if (flags & DIRTY || (flags & PENDING && checkDirty(N[e + DEPS], e))) {
    if (flags & HAS_CHILD_EFFECT) {
      unlinkChildEffects(e)
    }
    const cv = (e >> 2) + 1
    if (values[cv]) {
      runCleanup(e)
      if (N[e + FLAGS] === 0) {
        return
      }
    }
    N[e + DEPS_TAIL] = 0
    N[e + FLAGS] = K_EFFECT | WATCHING | RECURSED_CHECK
    const prevSub = activeSub
    activeSub = e
    try {
      ++cycle
      ++runDepth
      values[cv] = (fns[e >> 3] as () => (() => void) | void)()
    } finally {
      --runDepth
      activeSub = prevSub
      N[e + FLAGS] &= ~RECURSED_CHECK
      purgeDeps(e)
    }
  } else if (N[e + DEPS] !== 0) {
    N[e + FLAGS] = K_EFFECT | WATCHING | (flags & HAS_CHILD_EFFECT)
  }
}

function requeueAbort(e: number): void {
  if (N[e + FLAGS] & KIND_MASK) {
    N[e + FLAGS] |= WATCHING | RECURSED
  }
}

function runCleanup(e: number): void {
  const cv = (e >> 2) + 1
  const cleanup = values[cv] as () => void
  values[cv] = undefined
  const prevSub = activeSub
  activeSub = 0
  try {
    cleanup()
  } finally {
    activeSub = prevSub
  }
}

function dispose(e: number): void {
  const flags = N[e + FLAGS]
  if (!(flags & KIND_MASK)) {
    return
  }
  N[e + FLAGS] = 0
  disposeAllDepsInReverse(e)
  const sub = N[e + SUBS]
  if (sub !== 0) {
    unlink(sub)
  }
  if (flags & K_EFFECT && values[(e >> 2) + 1]) {
    runCleanup(e)
  }
  // probe variant: records leak (no sweep) — growth support is off.
}

function disposeAllDepsInReverse(sub: number): void {
  let cur = N[sub + DEPS_TAIL]
  while (cur !== 0) {
    const prev = L[cur + PREV_DEP]
    unlink(cur, sub)
    cur = prev
  }
}

function purgeDeps(sub: number): void {
  const depsTail = N[sub + DEPS_TAIL]
  let dep = depsTail !== 0 ? L[depsTail + NEXT_DEP] : N[sub + DEPS]
  while (dep !== 0) {
    dep = unlink(dep, sub)
  }
}

// ---- read/write ops ---------------------------------------------------------

function read(s: number): unknown {
  if (N[s + FLAGS] & DIRTY) {
    if (updateSignal(s)) {
      const subs = N[s + SUBS]
      if (subs !== 0) {
        shallowPropagate(subs)
      }
    }
  }
  if (activeSub !== 0) {
    link(s, activeSub, cycle)
  }
  return values[s >> 2]
}

function write(s: number, value: unknown): boolean {
  const p = (s >> 2) + 1
  if (values[p] !== (values[p] = value)) {
    N[s + FLAGS] = K_SIGNAL | MUTABLE | DIRTY
    const subs = N[s + SUBS]
    if (subs !== 0) {
      propagate(subs, runDepth !== 0)
      return true
    }
  }
  return false
}

function computedRead(c: number): unknown {
  const flags = N[c + FLAGS]
  if (
    flags & DIRTY ||
    (flags & PENDING && (checkDirty(N[c + DEPS], c) || ((N[c + FLAGS] = flags & ~PENDING), false)))
  ) {
    if (updateComputed(c)) {
      const subs = N[c + SUBS]
      if (subs !== 0) {
        shallowPropagate(subs)
      }
    }
  } else if (flags === K_COMPUTED) {
    N[c + FLAGS] = K_COMPUTED | MUTABLE | RECURSED_CHECK
    const prevSub = activeSub
    activeSub = c
    try {
      values[c >> 2] = (fns[c >> 3] as () => unknown)()
    } finally {
      activeSub = prevSub
      N[c + FLAGS] &= ~RECURSED_CHECK
    }
  }
  const sub = activeSub
  if (sub !== 0) {
    link(c, sub, cycle)
  }
  return values[c >> 2]
}

function flush(): void {
  try {
    while (notifyIndex < queuedLength) {
      const e = queued[notifyIndex]
      queued[notifyIndex++] = 0
      run(e)
    }
  } finally {
    while (notifyIndex < queuedLength) {
      const e = queued[notifyIndex]
      queued[notifyIndex++] = 0
      requeueAbort(e)
    }
    notifyIndex = 0
    queuedLength = 0
  }
}

// ---- public API ---------------------------------------------------------------

export interface SignalHandle<T> {
  (): T
  (value: T): void
}

export function signal<T>(): SignalHandle<T | undefined>
export function signal<T>(initialValue: T): SignalHandle<T>
export function signal<T>(initialValue?: T): SignalHandle<T | undefined> {
  const id = allocNode(K_SIGNAL | MUTABLE)
  const v = id >> 2
  values[v] = initialValue
  values[v + 1] = initialValue
  return function (...value: [T?]) {
    if (value.length) {
      if (write(id, value[0]) && !batchDepth) {
        flush()
      }
    } else {
      return read(id) as T | undefined
    }
  }
}

export function computed<T>(getter: (previousValue?: T) => T): () => T {
  const id = allocNode(K_COMPUTED)
  fns[id >> 3] = getter
  return () => computedRead(id) as T
}

export function effect(fn: () => void | (() => void)): () => void {
  const e = allocNode(K_EFFECT | WATCHING | RECURSED_CHECK)
  fns[e >> 3] = fn
  const prevSub = activeSub
  activeSub = e
  if (prevSub !== 0) {
    link(e, prevSub, 0)
    N[prevSub + FLAGS] |= HAS_CHILD_EFFECT
  }
  try {
    ++runDepth
    values[(e >> 2) + 1] = fn()
  } finally {
    --runDepth
    activeSub = prevSub
    N[e + FLAGS] &= ~RECURSED_CHECK
  }
  const gen = N[e + GEN]
  return () => {
    if (N[e + GEN] !== gen) {
      return
    }
    dispose(e)
  }
}

export function effectScope(fn: () => void): () => void {
  const e = allocNode(K_SCOPE | MUTABLE)
  const prevSub = activeSub
  activeSub = e
  if (prevSub !== 0) {
    link(e, prevSub, 0)
    N[prevSub + FLAGS] |= HAS_CHILD_EFFECT
  }
  try {
    fn()
  } finally {
    activeSub = prevSub
  }
  const gen = N[e + GEN]
  return () => {
    if (N[e + GEN] !== gen) {
      return
    }
    dispose(e)
  }
}

export function startBatch(): void {
  ++batchDepth
}

export function endBatch(): void {
  if (!--batchDepth && notifyIndex < queuedLength) {
    flush()
  }
}

export function untracked<T>(fn: () => T): T {
  const prevSub = activeSub
  activeSub = 0
  try {
    return fn()
  } finally {
    activeSub = prevSub
  }
}

export function getActiveSub(): number {
  return activeSub
}

export function setActiveSub(sub = 0): number {
  const prevSub = activeSub
  activeSub = sub
  return prevSub
}
