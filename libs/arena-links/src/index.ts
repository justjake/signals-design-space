/**
 * @lab/arena-links — alien-signals v3.2.1 semantics with Link records stored
 * in ONE stride-8 Int32Array arena while nodes stay plain JS objects.
 *
 * This is the links-only A/B partner to the full-arena library (@lab/arena):
 * it isolates "integer link records" as the experimental variable. Nodes keep
 * upstream's four monomorphic shapes (signal/computed/effect/scope) and field
 * access; links lose their 80 B heap objects (32 B flat records, no GC
 * headers, no write barriers on splices).
 *
 * Layout
 * - Link record: stride 8 ints, fields {VERSION, DEP, SUB, PREV_SUB,
 *   NEXT_SUB, PREV_DEP, NEXT_DEP} + 1 pad. Link id = recordIndex*8, so field
 *   access is L[id + F_X]; id 0 = null (record 0 is burned).
 * - Node objects mirror upstream ReactiveNode but deps/depsTail/subs/subsTail
 *   hold link ids (0 = null) and each node carries an integer `id` used
 *   inside link records. `nodesById` (plain array, index = id) maps id ->
 *   node during traversal. Ids are assigned lazily on first link and recycled
 *   through a free list once a node is fully unlinked (subs==0 && deps==0),
 *   so unwatched signals/computeds stay GC-able like upstream and disposed
 *   effects/scopes return their ids.
 * - Link free list is threaded through NEXT_DEP; freed records get
 *   VERSION = TOMBSTONE, which also makes double-unlink a graceful no-op.
 *
 * Growth (per ~/src/react-signals-fable-v2/docs/research/
 * v8-growable-buffer-bindings.md): the engine is a factory closure over a
 * `const L` buffer so TurboFan embeds the base address; growth rebuilds the
 * closure over a doubled buffer (copy via .set) and swaps the ONE module-
 * level `engine` reference. Public operations pay one `engine.` load; walks
 * inside are const-bound. Growth can only trigger at the top of link() (the
 * only allocator), before it takes L into locals. Because a user getter run
 * from checkDirty->update can allocate and therefore grow mid-walk, every
 * closure walk that suspends into user code re-checks `arenaEpoch` right
 * after the call and re-dispatches through the current engine: checkDirty
 * restarts from the root (verification is idempotent — updates already
 * performed read as clean, shallowPropagate marks survive), and the purge/
 * dispose walks resume from their node-object cursors. Link ids are stable
 * across growth, so only the buffer binding ever goes stale. While any such
 * guarded walk is active, freed link records and node ids go to a pending
 * list and are only recycled when the outermost walk exits — a stale
 * traversal therefore sees frozen records, exactly like upstream traversals
 * see stale-but-intact GC'd Link objects.
 *
 * Everything else is a field-for-field transliteration of upstream
 * src/system.ts + src/index.ts: all six flags + HasChildEffect, link()'s
 * three-way dedup with depsTail cursor reuse, purgeDeps, unlink,
 * propagate/checkDirty with persistent Int32Array scratch stacks
 * (base-pointer save/restore for re-entrancy), isValidLink, the checkDirty
 * graph-mutation guard (`dirty && !!sub.flags`), two-slot signal values,
 * effectScope hierarchy + cleanup fns, notify parent-chain queue with
 * in-place reversal, innerWrite/runDepth.
 *
 * Zero runtime dependencies; no Date.now/Math.random in any code path.
 */

export interface ReactiveNode {
  id: number
  deps: number
  depsTail: number
  subs: number
  subsTail: number
  flags: number
}

interface EffectScopeNode extends ReactiveNode {}

interface EffectNode extends ReactiveNode {
  fn(): (() => void) | void
  cleanup: (() => void) | void
}

interface ComputedNode<T = any> extends ReactiveNode {
  value: T | undefined
  getter: (previousValue?: T) => T
}

interface SignalNode<T = any> extends ReactiveNode {
  currentValue: T
  pendingValue: T
}

// ReactiveFlags (plain consts so esbuild/V8 always inline them).
const Mutable = 1
const Watching = 2
const RecursedCheck = 4
const Recursed = 8
const Dirty = 16
const Pending = 32
// API-layer bit, outside the system flags' range (see upstream index.ts).
const HasChildEffect = 64

// Link record field offsets (stride 8; slot 7 is padding).
const F_VERSION = 0
const F_DEP = 1
const F_SUB = 2
const F_PREV_SUB = 3
const F_NEXT_SUB = 4
const F_PREV_DEP = 5
const F_NEXT_DEP = 6

/**
 * VERSION value marking a freed/unlinked record. `cycle` wraps as int32 and
 * passes -1 only once per 2^32 updates; the dedup that reads VERSION also
 * matches dep/sub ids, so a collision cannot produce a false positive link.
 */
const TOMBSTONE = -1

/**
 * Initial arena capacity in records. Overridable via env so the growth +
 * epoch-restart machinery can be stress-tested (e.g. conformance with 2).
 */
const INITIAL_LINK_RECORDS = (() => {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.ARENA_LINKS_INITIAL_RECORDS
  const n = raw === undefined ? 0 : Number(raw)
  return Number.isFinite(n) && n >= 2 ? Math.floor(n) : 1024
})()

// ---------------------------------------------------------------------------
// Module-level state. Everything mutable lives here so a closure rebuild
// (growth) only has to copy the Int32Array itself.
// ---------------------------------------------------------------------------

/**
 * id -> node. Index 0 burned. Entries are cleared (set undefined, stays
 * PACKED) when a node's id is recycled.
 */
const nodesById: (ReactiveNode | undefined)[] = [undefined]
const nodeFree: number[] = []
let nodeFreeTop = 0

/** Link allocator: bump pointer (in ints) + free-list head (link id). */
let linkTop = 8 // record 0 burned
let linkFreeHead = 0
let linkRecordCap = INITIAL_LINK_RECORDS

/**
 * Deferred frees while a guarded walk (checkDirty/purge/dispose) is active:
 * records/ids must stay frozen so stale traversals behave like upstream's
 * stale-but-intact Link objects. Drained when guardDepth returns to 0.
 */
let guardDepth = 0
const pendingLinks: number[] = []
let pendingLinkTop = 0
const pendingNodes: (ReactiveNode | undefined)[] = []
let pendingNodeTop = 0

/** Bumped on every growth; walks compare it to detect a stale L binding. */
let arenaEpoch = 0

// Persistent traversal scratch stacks (Int32Array, doubling growth, base-
// pointer save/restore per activation so re-entrant calls stay isolated).
let propStack = new Int32Array(1024)
let propTop = 0
let cdStack = new Int32Array(1024)
let cdTop = 0

// API-layer state (transliterated from upstream index.ts).
let cycle = 0
let runDepth = 0
let batchDepth = 0
let notifyIndex = 0
let queuedLength = 0
let activeSub: ReactiveNode | undefined
const queued: (EffectNode | undefined)[] = []

// The ONE mutable engine reference + a module alias of its buffer for the
// rare L reads that happen outside the closure (notify, drain, epoch-restart
// glue). Hot walks never read these.
let engine = createEngine(linkRecordCap, undefined)
let LM = engine.L

// ---------------------------------------------------------------------------
// Allocation helpers (module level; no L access except via LM in drain).
// ---------------------------------------------------------------------------

function registerNode(node: ReactiveNode): number {
  let id: number
  if (nodeFreeTop !== 0) {
    id = nodeFree[--nodeFreeTop]
    nodesById[id] = node
  } else {
    id = nodesById.length
    nodesById.push(node)
  }
  node.id = id
  return id
}

/**
 * Recycle a node's id once it is fully unlinked. Deferred while a guarded
 * walk is active (stale link records may still name this id).
 */
function maybeFreeNodeId(node: ReactiveNode): void {
  if (node.id === 0 || node.subs !== 0 || node.deps !== 0 || node.depsTail !== 0) {
    return
  }
  if (guardDepth > 0) {
    pendingNodes[pendingNodeTop++] = node
    return
  }
  nodesById[node.id] = undefined
  nodeFree[nodeFreeTop++] = node.id
  node.id = 0
}

function drainPendingFrees(): void {
  for (let i = 0; i < pendingLinkTop; ++i) {
    const id = pendingLinks[i]
    LM[id + F_NEXT_DEP] = linkFreeHead
    linkFreeHead = id
  }
  pendingLinkTop = 0
  for (let i = 0; i < pendingNodeTop; ++i) {
    const node = pendingNodes[i]!
    pendingNodes[i] = undefined
    // Re-check: the node may have been re-linked inside the guarded window,
    // and duplicates are filtered by the id === 0 check.
    maybeFreeNodeId(node)
  }
  pendingNodeTop = 0
}

function pushProp(value: number): void {
  if (propTop === propStack.length) {
    const bigger = new Int32Array(propStack.length << 1)
    bigger.set(propStack)
    propStack = bigger
  }
  propStack[propTop++] = value
}

function pushCd(value: number): void {
  if (cdTop === cdStack.length) {
    const bigger = new Int32Array(cdStack.length << 1)
    bigger.set(cdStack)
    cdStack = bigger
  }
  cdStack[cdTop++] = value
}

function grow(): void {
  linkRecordCap <<= 1
  const next = createEngine(linkRecordCap, LM)
  engine = next
  LM = next.L
  ++arenaEpoch
}

// ---------------------------------------------------------------------------
// The engine factory: every function that walks the arena closes over the
// const L buffer. Rebuilt (over a doubled copy) on growth.
// ---------------------------------------------------------------------------

function createEngine(recordCap: number, old: Int32Array | undefined) {
  const L = new Int32Array(recordCap << 3)
  if (old !== undefined) {
    L.set(old)
  }
  const END = recordCap << 3

  return {
    L,
    link,
    unlink,
    propagate,
    checkDirty,
    checkDirtyRestart,
    shallowPropagate,
    purgeDeps,
    disposeAllDepsInReverse,
    purgeChildDeps,
  }

  /**
   * Recycle or thread a freed record. Deferred while a guarded walk is
   * active so stale traversals see frozen fields. VERSION is already
   * TOMBSTONE (set by unlink) by the time this runs.
   */
  function freeLink(link: number): void {
    if (guardDepth > 0) {
      pendingLinks[pendingLinkTop++] = link
    } else {
      L[link + F_NEXT_DEP] = linkFreeHead
      linkFreeHead = link
    }
  }

  function link(dep: ReactiveNode, sub: ReactiveNode, version: number): void {
    // Growth check BEFORE any L state enters locals: this is the only
    // allocation site, hence the only place a rebuild can originate.
    if (linkFreeHead === 0 && linkTop === END) {
      grow()
      engine.link(dep, sub, version)
      return
    }
    const prevDep = sub.depsTail
    // Live records always carry nonzero DEP/SUB ids, so comparing against a
    // (possibly 0) node id can never false-positive.
    if (prevDep !== 0 && L[prevDep + F_DEP] === dep.id) {
      return
    }
    const nextDep = prevDep !== 0 ? L[prevDep + F_NEXT_DEP] : sub.deps
    if (nextDep !== 0 && L[nextDep + F_DEP] === dep.id) {
      L[nextDep + F_VERSION] = version
      sub.depsTail = nextDep
      return
    }
    const prevSub = dep.subsTail
    if (prevSub !== 0 && L[prevSub + F_VERSION] === version && L[prevSub + F_SUB] === sub.id) {
      return
    }
    const depId = dep.id !== 0 ? dep.id : registerNode(dep)
    const subId = sub.id !== 0 ? sub.id : registerNode(sub)
    let newLink = linkFreeHead
    if (newLink !== 0) {
      linkFreeHead = L[newLink + F_NEXT_DEP]
    } else {
      newLink = linkTop
      linkTop += 8
    }
    sub.depsTail = newLink
    dep.subsTail = newLink
    L[newLink + F_VERSION] = version
    L[newLink + F_DEP] = depId
    L[newLink + F_SUB] = subId
    L[newLink + F_PREV_SUB] = prevSub
    L[newLink + F_NEXT_SUB] = 0
    L[newLink + F_PREV_DEP] = prevDep
    L[newLink + F_NEXT_DEP] = nextDep
    if (nextDep !== 0) {
      L[nextDep + F_PREV_DEP] = newLink
    }
    if (prevDep !== 0) {
      L[prevDep + F_NEXT_DEP] = newLink
    } else {
      sub.deps = newLink
    }
    if (prevSub !== 0) {
      L[prevSub + F_NEXT_SUB] = newLink
    } else {
      dep.subs = newLink
    }
  }

  function unlink(link: number, sub: ReactiveNode = nodesById[L[link + F_SUB]]!): number {
    // Double-unlink (reachable only through upstream's own stale-traversal
    // corners) degrades to a graceful walk-terminating no-op instead of
    // corrupting the free list.
    if (L[link + F_VERSION] === TOMBSTONE) {
      return 0
    }
    const dep = nodesById[L[link + F_DEP]]!
    const prevDep = L[link + F_PREV_DEP]
    const nextDep = L[link + F_NEXT_DEP]
    const nextSub = L[link + F_NEXT_SUB]
    const prevSub = L[link + F_PREV_SUB]
    L[link + F_VERSION] = TOMBSTONE
    if (nextDep !== 0) {
      L[nextDep + F_PREV_DEP] = prevDep
    } else {
      sub.depsTail = prevDep
    }
    if (prevDep !== 0) {
      L[prevDep + F_NEXT_DEP] = nextDep
    } else {
      sub.deps = nextDep
    }
    if (nextSub !== 0) {
      L[nextSub + F_PREV_SUB] = prevSub
    } else {
      dep.subsTail = prevSub
    }
    freeLink(link)
    if (prevSub !== 0) {
      L[prevSub + F_NEXT_SUB] = nextSub
    } else if ((dep.subs = nextSub) === 0) {
      unwatched(dep)
    }
    return nextDep
  }

  function propagate(link: number, innerWrite: boolean): void {
    let next = L[link + F_NEXT_SUB]
    const base = propTop

    try {
      top: do {
        const sub = nodesById[L[link + F_SUB]]!
        let flags = sub.flags

        if (!(flags & (RecursedCheck | Recursed | Dirty | Pending))) {
          sub.flags = flags | Pending
          if (innerWrite) {
            sub.flags |= Recursed
          }
        } else if (!(flags & (RecursedCheck | Recursed))) {
          flags = 0
        } else if (!(flags & RecursedCheck)) {
          sub.flags = (flags & ~Recursed) | Pending
        } else if (!(flags & (Dirty | Pending)) && isValidLink(link, sub)) {
          sub.flags = flags | (Recursed | Pending)
          flags &= Mutable
        } else {
          flags = 0
        }

        if (flags & Watching) {
          notify(sub as EffectNode)
        }

        if (flags & Mutable) {
          const subSubs = sub.subs
          if (subSubs !== 0) {
            const nextSub = L[(link = subSubs) + F_NEXT_SUB]
            if (nextSub !== 0) {
              pushProp(next)
              next = nextSub
            }
            continue
          }
        }

        if ((link = next) !== 0) {
          next = L[link + F_NEXT_SUB]
          continue
        }

        while (propTop > base) {
          link = propStack[--propTop]
          if (link !== 0) {
            next = L[link + F_NEXT_SUB]
            continue top
          }
        }

        break
      } while (true)
    } finally {
      propTop = base
    }
  }

  function checkDirty(link: number, sub: ReactiveNode): boolean {
    const rootSub = sub
    const epoch = arenaEpoch
    const base = cdTop
    let dirty = false

    ++guardDepth
    try {
      top: do {
        const dep = nodesById[L[link + F_DEP]]!
        const depFlags = dep.flags

        if (sub.flags & Dirty) {
          dirty = true
        } else if ((depFlags & (Mutable | Dirty)) === (Mutable | Dirty)) {
          const subs = dep.subs
          const changed = update(dep)
          if (arenaEpoch !== epoch) {
            // The arena grew inside update(): this closure's L is stale.
            // Finish the mandatory sibling upgrade through the current
            // engine, then restart verification from the root — updates
            // already performed read as clean, so no getter reruns.
            if (changed && LM[subs + F_NEXT_SUB] !== 0) {
              engine.shallowPropagate(subs)
            }
            return engine.checkDirtyRestart(rootSub)
          }
          if (changed) {
            if (L[subs + F_NEXT_SUB] !== 0) {
              shallowPropagate(subs)
            }
            dirty = true
          }
        } else if ((depFlags & (Mutable | Pending)) === (Mutable | Pending)) {
          pushCd(link)
          link = dep.deps
          sub = dep
          continue
        }

        if (!dirty) {
          const nextDep = L[link + F_NEXT_DEP]
          if (nextDep !== 0) {
            link = nextDep
            continue
          }
        }

        while (cdTop > base) {
          link = cdStack[--cdTop]
          if (dirty) {
            const subs = sub.subs
            const changed = update(sub)
            if (arenaEpoch !== epoch) {
              if (changed && LM[subs + F_NEXT_SUB] !== 0) {
                engine.shallowPropagate(subs)
              }
              return engine.checkDirtyRestart(rootSub)
            }
            if (changed) {
              if (L[subs + F_NEXT_SUB] !== 0) {
                shallowPropagate(subs)
              }
              sub = nodesById[L[link + F_SUB]]!
              continue
            }
            dirty = false
          } else {
            sub.flags &= ~Pending
          }
          sub = nodesById[L[link + F_SUB]]!
          const nextDep = L[link + F_NEXT_DEP]
          if (nextDep !== 0) {
            link = nextDep
            continue top
          }
        }

        return dirty && !!sub.flags
      } while (true)
    } finally {
      cdTop = base
      if (--guardDepth === 0) {
        drainPendingFrees()
      }
    }
  }

  /**
   * Restart glue for growth-during-checkDirty; always entered through the
   * CURRENT engine reference.
   */
  function checkDirtyRestart(sub: ReactiveNode): boolean {
    const deps = sub.deps
    return deps !== 0 && checkDirty(deps, sub)
  }

  function shallowPropagate(link: number): void {
    do {
      const sub = nodesById[L[link + F_SUB]]!
      const flags = sub.flags
      if ((flags & (Pending | Dirty)) === Pending) {
        sub.flags = flags | Dirty
        if ((flags & (Watching | RecursedCheck)) === Watching) {
          notify(sub as EffectNode)
        }
      }
    } while ((link = L[link + F_NEXT_SUB]) !== 0)
  }

  function isValidLink(checkLink: number, sub: ReactiveNode): boolean {
    let link = sub.depsTail
    while (link !== 0) {
      if (link === checkLink) {
        return true
      }
      link = L[link + F_PREV_DEP]
    }
    return false
  }

  /**
   * Upstream purgeDeps: trim every dep past the depsTail cursor. Guarded +
   * epoch-resumable (unlink -> unwatched can run user cleanup that grows the
   * arena; the cursor re-derives from node fields, so resuming through the
   * current engine continues exactly where this one stopped).
   */
  function purgeDeps(sub: ReactiveNode): void {
    const depsTail = sub.depsTail
    let dep = depsTail !== 0 ? L[depsTail + F_NEXT_DEP] : sub.deps
    if (dep === 0) {
      // Stable-graph fast path: nothing past the cursor, skip the guard.
      return
    }
    const epoch = arenaEpoch
    ++guardDepth
    try {
      while (dep !== 0) {
        dep = unlink(dep, sub)
        if (arenaEpoch !== epoch) {
          engine.purgeDeps(sub)
          return
        }
      }
    } finally {
      if (--guardDepth === 0) {
        drainPendingFrees()
      }
    }
  }

  /**
   * Upstream disposeAllDepsInReverse. Same guard + resume discipline;
   * unlinking the tail keeps sub.depsTail as the resume cursor.
   */
  function disposeAllDepsInReverse(sub: ReactiveNode): void {
    let link = sub.depsTail
    if (link === 0) {
      return
    }
    const epoch = arenaEpoch
    ++guardDepth
    try {
      while (link !== 0) {
        const prev = L[link + F_PREV_DEP]
        unlink(link, sub)
        if (arenaEpoch !== epoch) {
          engine.disposeAllDepsInReverse(sub)
          return
        }
        link = prev
      }
    } finally {
      if (--guardDepth === 0) {
        drainPendingFrees()
      }
    }
  }

  /**
   * The HasChildEffect pre-walk from upstream updateComputed/run: unlink
   * every dep that is neither a computed nor a signal (i.e. child effects/
   * scopes), in reverse. Restart-from-tail is idempotent.
   */
  function purgeChildDeps(sub: ReactiveNode): void {
    const epoch = arenaEpoch
    ++guardDepth
    try {
      let link = sub.depsTail
      while (link !== 0) {
        const prev = L[link + F_PREV_DEP]
        const dep = nodesById[L[link + F_DEP]]!
        if (!("getter" in dep) && !("currentValue" in dep)) {
          unlink(link, sub)
          if (arenaEpoch !== epoch) {
            engine.purgeChildDeps(sub)
            return
          }
        }
        link = prev
      }
    } finally {
      if (--guardDepth === 0) {
        drainPendingFrees()
      }
    }
  }
}

// ---------------------------------------------------------------------------
// API layer (transliterated from upstream index.ts). Module-level functions
// touch the arena only through `engine.*` calls / the LM alias, so they can
// never hold a stale buffer across user code.
// ---------------------------------------------------------------------------

function update(node: ReactiveNode): boolean {
  if ("getter" in node) {
    return updateComputed(node as ComputedNode)
  }
  if ("currentValue" in node) {
    return updateSignal(node as SignalNode)
  }
  node.flags = Mutable
  return true
}

function notify(effect: EffectNode): void {
  let insertIndex = queuedLength
  let firstInsertedIndex = insertIndex

  do {
    queued[insertIndex++] = effect
    effect.flags &= ~Watching
    const subs = effect.subs
    if (subs === 0) {
      break
    }
    const parent = nodesById[LM[subs + F_SUB]] as EffectNode
    if (!(parent.flags & Watching)) {
      break
    }
    effect = parent
  } while (true)

  queuedLength = insertIndex

  while (firstInsertedIndex < --insertIndex) {
    const left = queued[firstInsertedIndex]
    queued[firstInsertedIndex++] = queued[insertIndex]
    queued[insertIndex] = left
  }
}

function unwatched(node: ReactiveNode): void {
  if ("getter" in node) {
    if (node.depsTail !== 0) {
      node.flags = Mutable | Dirty
      engine.disposeAllDepsInReverse(node)
    }
    maybeFreeNodeId(node)
  } else if ("currentValue" in node) {
    // Nothing to do for signals semantically; just recycle the id.
    maybeFreeNodeId(node)
  } else if ("fn" in node) {
    effectOper.call(node as EffectNode)
  } else {
    effectScopeOper.call(node)
  }
}

export function getActiveSub(): ReactiveNode | undefined {
  return activeSub
}

export function setActiveSub(sub?: ReactiveNode): ReactiveNode | undefined {
  const prevSub = activeSub
  activeSub = sub
  return prevSub
}

export function startBatch(): void {
  ++batchDepth
}

export function endBatch(): void {
  if (!--batchDepth) {
    flush()
  }
}

export function untracked<T>(fn: () => T): T {
  const prevSub = activeSub
  activeSub = undefined
  try {
    return fn()
  } finally {
    activeSub = prevSub
  }
}

export function signal<T>(): {
  (): T | undefined
  (value: T | undefined): void
}
export function signal<T>(initialValue: T): {
  (): T
  (value: T): void
}
export function signal<T>(initialValue?: T): {
  (): T | undefined
  (value: T | undefined): void
} {
  return signalOper.bind({
    id: 0,
    currentValue: initialValue,
    pendingValue: initialValue,
    deps: 0,
    depsTail: 0,
    subs: 0,
    subsTail: 0,
    flags: Mutable,
  } as SignalNode<T | undefined>) as () => T | undefined
}

export function computed<T>(getter: (previousValue?: T) => T): () => T {
  return computedOper.bind({
    id: 0,
    value: undefined,
    deps: 0,
    depsTail: 0,
    subs: 0,
    subsTail: 0,
    flags: 0,
    getter: getter as (previousValue?: unknown) => unknown,
  } as ComputedNode) as () => T
}

export function effect(fn: () => void | (() => void)): () => void {
  const e: EffectNode = {
    id: 0,
    fn,
    cleanup: undefined,
    deps: 0,
    depsTail: 0,
    subs: 0,
    subsTail: 0,
    flags: Watching | RecursedCheck,
  }
  const prevSub = activeSub
  activeSub = e
  if (prevSub !== undefined) {
    engine.link(e, prevSub, 0)
    prevSub.flags |= HasChildEffect
  }
  try {
    ++runDepth
    e.cleanup = e.fn()
  } finally {
    --runDepth
    activeSub = prevSub
    e.flags &= ~RecursedCheck
  }
  return effectOper.bind(e)
}

export function effectScope(fn: () => void): () => void {
  const e: EffectScopeNode = {
    id: 0,
    deps: 0,
    depsTail: 0,
    subs: 0,
    subsTail: 0,
    flags: Mutable,
  }
  const prevSub = activeSub
  activeSub = e
  if (prevSub !== undefined) {
    engine.link(e, prevSub, 0)
    prevSub.flags |= HasChildEffect
  }
  try {
    fn()
  } finally {
    activeSub = prevSub
  }
  return effectScopeOper.bind(e)
}

function updateComputed(c: ComputedNode): boolean {
  if (c.flags & HasChildEffect) {
    engine.purgeChildDeps(c)
  }
  c.depsTail = 0
  c.flags = Mutable | RecursedCheck
  const prevSub = activeSub
  activeSub = c
  try {
    // Mask keeps the int32 cycle non-negative so it can never collide with
    // the TOMBSTONE (-1) sentinel stored in the same VERSION field.
    cycle = (cycle + 1) & 0x7fffffff
    const oldValue = c.value
    return oldValue !== (c.value = c.getter(oldValue))
  } finally {
    activeSub = prevSub
    c.flags &= ~RecursedCheck
    engine.purgeDeps(c)
  }
}

function updateSignal(s: SignalNode): boolean {
  s.flags = Mutable
  return s.currentValue !== (s.currentValue = s.pendingValue)
}

function run(e: EffectNode): void {
  const flags = e.flags
  if (flags & Dirty || (flags & Pending && engine.checkDirty(e.deps, e))) {
    if (flags & HasChildEffect) {
      engine.purgeChildDeps(e)
    }
    if (e.cleanup) {
      runCleanup(e)
      if (!e.flags) {
        return
      }
    }
    e.depsTail = 0
    e.flags = Watching | RecursedCheck
    const prevSub = activeSub
    activeSub = e
    try {
      cycle = (cycle + 1) & 0x7fffffff
      ++runDepth
      e.cleanup = e.fn()
    } finally {
      --runDepth
      activeSub = prevSub
      e.flags &= ~RecursedCheck
      engine.purgeDeps(e)
    }
  } else if (e.deps !== 0) {
    e.flags = Watching | (flags & HasChildEffect)
  }
}

function flush(): void {
  try {
    while (notifyIndex < queuedLength) {
      const effect = queued[notifyIndex]!
      queued[notifyIndex++] = undefined
      run(effect)
    }
  } finally {
    while (notifyIndex < queuedLength) {
      const effect = queued[notifyIndex]!
      queued[notifyIndex++] = undefined
      effect.flags |= Watching | Recursed
    }
    notifyIndex = 0
    queuedLength = 0
  }
}

function computedOper<T>(this: ComputedNode<T>): T {
  const flags = this.flags
  if (
    flags & Dirty ||
    (flags & Pending &&
      (engine.checkDirty(this.deps, this) || ((this.flags = flags & ~Pending), false)))
  ) {
    if (updateComputed(this)) {
      const subs = this.subs
      if (subs !== 0) {
        engine.shallowPropagate(subs)
      }
    }
  } else if (!flags) {
    this.flags = Mutable | RecursedCheck
    const prevSub = activeSub
    activeSub = this
    try {
      this.value = this.getter()
    } finally {
      activeSub = prevSub
      this.flags &= ~RecursedCheck
    }
  }
  const sub = activeSub
  if (sub !== undefined) {
    engine.link(this, sub, cycle)
  }
  return this.value!
}

function signalOper<T>(this: SignalNode<T>, ...value: [T]): T | void {
  if (value.length) {
    if (this.pendingValue !== (this.pendingValue = value[0])) {
      this.flags = Mutable | Dirty
      const subs = this.subs
      if (subs !== 0) {
        engine.propagate(subs, runDepth !== 0)
        if (!batchDepth) {
          flush()
        }
      }
    }
  } else {
    if (this.flags & Dirty) {
      if (updateSignal(this)) {
        const subs = this.subs
        if (subs !== 0) {
          engine.shallowPropagate(subs)
        }
      }
    }
    const sub = activeSub
    if (sub !== undefined) {
      engine.link(this, sub, cycle)
    }
    return this.currentValue
  }
}

function runCleanup(e: EffectNode): void {
  const cleanup = e.cleanup!
  e.cleanup = undefined
  const prevSub = activeSub
  activeSub = undefined
  try {
    cleanup()
  } finally {
    activeSub = prevSub
  }
}

function effectOper(this: EffectNode): void {
  effectScopeOper.call(this)
  if (this.cleanup) {
    runCleanup(this)
  }
}

function effectScopeOper(this: EffectScopeNode): void {
  this.flags = 0
  engine.disposeAllDepsInReverse(this)
  const sub = this.subs
  if (sub !== 0) {
    engine.unlink(sub)
  }
  maybeFreeNodeId(this)
}
