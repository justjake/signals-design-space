var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// ../signals-royale-fh2/src/graph.ts
function setActiveSub(sub) {
  const prev = activeSub;
  activeSub = sub;
  return prev;
}
function untracked(fn) {
  const prev = setActiveSub(void 0);
  try {
    return fn();
  } finally {
    activeSub = prev;
  }
}
function startBatch() {
  ++batchDepth;
}
function endBatch() {
  if (!--batchDepth) {
    flush();
  }
}
function batch(fn) {
  startBatch();
  try {
    return fn();
  } finally {
    endBatch();
  }
}
function link(dep, sub, version) {
  const prevDep = sub.depsTail;
  if (prevDep !== void 0 && prevDep.dep === dep) {
    return;
  }
  const nextDep = prevDep !== void 0 ? prevDep.nextDep : sub.deps;
  if (nextDep !== void 0 && nextDep.dep === dep) {
    nextDep.version = version;
    sub.depsTail = nextDep;
    return;
  }
  const prevSub = dep.subsTail;
  if (prevSub !== void 0 && prevSub.version === version && prevSub.sub === sub) {
    return;
  }
  const hadSubs = dep.subs !== void 0;
  const newLink = {
    version,
    dep,
    sub,
    prevDep,
    nextDep,
    prevSub,
    nextSub: void 0
  };
  sub.depsTail = newLink;
  dep.subsTail = newLink;
  if (nextDep !== void 0) {
    nextDep.prevDep = newLink;
  }
  if (prevDep !== void 0) {
    prevDep.nextDep = newLink;
  } else {
    sub.deps = newLink;
  }
  if (prevSub !== void 0) {
    prevSub.nextSub = newLink;
  } else {
    dep.subs = newLink;
  }
  if (!hadSubs) {
    worldHooks.onWatched(dep);
  }
}
function unlink(l, sub = l.sub) {
  const { dep, prevDep, nextDep, nextSub, prevSub } = l;
  if (nextDep !== void 0) {
    nextDep.prevDep = prevDep;
  } else {
    sub.depsTail = prevDep;
  }
  if (prevDep !== void 0) {
    prevDep.nextDep = nextDep;
  } else {
    sub.deps = nextDep;
  }
  if (nextSub !== void 0) {
    nextSub.prevSub = prevSub;
  } else {
    dep.subsTail = prevSub;
  }
  if (prevSub !== void 0) {
    prevSub.nextSub = nextSub;
  } else if ((dep.subs = nextSub) === void 0) {
    unwatched(dep);
    worldHooks.onUnwatched(dep);
  }
  return nextDep;
}
function unwatched(node) {
  if (node.kind === 1 /* Computed */) {
    if (node.depsTail !== void 0) {
      node.flags = 1 /* Mutable */ | 16 /* Dirty */;
      disposeAllDepsInReverse(node);
    }
  } else if (node.kind === 2 /* Effect */ || node.kind === 3 /* Scope */) {
    disposeEffect(node);
  }
}
function propagate(current, innerWrite) {
  let next = current.nextSub;
  let stack;
  top: do {
    const sub = current.sub;
    let flags = sub.flags;
    if (!(flags & (4 /* RecursedCheck */ | 8 /* Recursed */ | 16 /* Dirty */ | 32 /* Pending */))) {
      sub.flags = flags | 32 /* Pending */;
      if (innerWrite) {
        sub.flags |= 8 /* Recursed */;
      }
    } else if (!(flags & (4 /* RecursedCheck */ | 8 /* Recursed */))) {
      flags = 0 /* None */;
    } else if (!(flags & 4 /* RecursedCheck */)) {
      sub.flags = flags & ~8 /* Recursed */ | 32 /* Pending */;
    } else if (!(flags & (16 /* Dirty */ | 32 /* Pending */)) && isValidLink(current, sub)) {
      sub.flags = flags | (8 /* Recursed */ | 32 /* Pending */);
      flags &= 1 /* Mutable */;
    } else {
      flags = 0 /* None */;
    }
    if (flags & 2 /* Watching */) {
      notify(sub);
    }
    if (flags & 1 /* Mutable */) {
      const subSubs = sub.subs;
      if (subSubs !== void 0) {
        const nextSub = (current = subSubs).nextSub;
        if (nextSub !== void 0) {
          stack = { value: next, prev: stack };
          next = nextSub;
        }
        continue;
      }
    }
    if ((current = next) !== void 0) {
      next = current.nextSub;
      continue;
    }
    while (stack !== void 0) {
      current = stack.value;
      stack = stack.prev;
      if (current !== void 0) {
        next = current.nextSub;
        continue top;
      }
    }
    break;
  } while (true);
}
function checkDirty(current, sub) {
  let stack;
  let checkDepth = 0;
  let dirty = false;
  top: do {
    const dep = current.dep;
    const flags = dep.flags;
    if (sub.flags & 16 /* Dirty */) {
      dirty = true;
    } else if ((flags & (1 /* Mutable */ | 16 /* Dirty */)) === (1 /* Mutable */ | 16 /* Dirty */)) {
      const subs = dep.subs;
      if (update(dep)) {
        if (subs.nextSub !== void 0) {
          shallowPropagate(subs);
        }
        dirty = true;
      }
    } else if ((flags & (1 /* Mutable */ | 32 /* Pending */)) === (1 /* Mutable */ | 32 /* Pending */)) {
      stack = { value: current, prev: stack };
      current = dep.deps;
      sub = dep;
      ++checkDepth;
      continue;
    }
    if (!dirty) {
      const nextDep = current.nextDep;
      if (nextDep !== void 0) {
        current = nextDep;
        continue;
      }
    }
    while (checkDepth--) {
      current = stack.value;
      stack = stack.prev;
      if (dirty) {
        const subs = sub.subs;
        if (update(sub)) {
          if (subs.nextSub !== void 0) {
            shallowPropagate(subs);
          }
          sub = current.sub;
          continue;
        }
        dirty = false;
      } else {
        sub.flags &= ~32 /* Pending */;
      }
      sub = current.sub;
      const nextDep = current.nextDep;
      if (nextDep !== void 0) {
        current = nextDep;
        continue top;
      }
    }
    return dirty && !!sub.flags;
  } while (true);
}
function shallowPropagate(current) {
  do {
    const sub = current.sub;
    const flags = sub.flags;
    if ((flags & (32 /* Pending */ | 16 /* Dirty */)) === 32 /* Pending */) {
      sub.flags = flags | 16 /* Dirty */;
      if ((flags & (2 /* Watching */ | 4 /* RecursedCheck */)) === 2 /* Watching */) {
        notify(sub);
      }
    }
  } while ((current = current.nextSub) !== void 0);
}
function isValidLink(checkLink, sub) {
  let l = sub.depsTail;
  while (l !== void 0) {
    if (l === checkLink) {
      return true;
    }
    l = l.prevDep;
  }
  return false;
}
function update(node) {
  if (node.kind === 1 /* Computed */) {
    return updateComputed(node);
  }
  if (node.kind === 0 /* Atom */) {
    return updateAtom(node);
  }
  node.flags = 1 /* Mutable */;
  return true;
}
function notify(e) {
  let insertIndex = queuedLength;
  const firstInsertedIndex = insertIndex;
  let node = e;
  do {
    queued[insertIndex++] = node;
    node.flags &= ~2 /* Watching */;
    node = node.subs?.sub;
    if (node === void 0 || !(node.flags & 2 /* Watching */)) {
      break;
    }
  } while (true);
  queuedLength = insertIndex;
  let lo = firstInsertedIndex;
  let hi = insertIndex;
  while (lo < --hi) {
    const left = queued[lo];
    queued[lo++] = queued[hi];
    queued[hi] = left;
  }
}
function updateAtom(s) {
  s.flags = 1 /* Mutable */;
  const changed = !s.equals(s.value, s.staged);
  s.value = s.staged;
  return changed;
}
function updateComputed(c) {
  if (c.flags & 64 /* HasChildEffect */) {
    let l = c.depsTail;
    while (l !== void 0) {
      const prev = l.prevDep;
      const dep = l.dep;
      if (dep.kind === 2 /* Effect */ || dep.kind === 3 /* Scope */) {
        unlink(l, c);
      }
      l = prev;
    }
  }
  c.depsTail = void 0;
  c.flags = 1 /* Mutable */ | 4 /* RecursedCheck */;
  const prevSub = setActiveSub(c);
  try {
    ++cycle;
    const oldValue = c.value;
    const newValue = c.fn();
    const changed = !c.equals(oldValue, newValue);
    if (changed) {
      c.value = newValue;
    }
    return changed;
  } finally {
    activeSub = prevSub;
    c.flags &= ~4 /* RecursedCheck */;
    purgeDeps(c);
  }
}
function run(e) {
  const flags = e.flags;
  if (flags & 16 /* Dirty */ || flags & 32 /* Pending */ && checkDirty(e.deps, e)) {
    if (e.draftNotify !== void 0) {
      e.flags = 2 /* Watching */ | flags & 64 /* HasChildEffect */;
      runWatcher(e);
      return;
    }
    if (flags & 64 /* HasChildEffect */) {
      let l = e.depsTail;
      while (l !== void 0) {
        const prev = l.prevDep;
        const dep = l.dep;
        if (dep.kind === 2 /* Effect */ || dep.kind === 3 /* Scope */) {
          unlink(l, e);
        }
        l = prev;
      }
    }
    if (e.cleanup !== void 0) {
      runCleanup(e);
      if (!e.flags) {
        return;
      }
    }
    e.depsTail = void 0;
    e.flags = 2 /* Watching */ | 4 /* RecursedCheck */;
    const prevSub = setActiveSub(e);
    try {
      ++cycle;
      ++runDepth;
      e.cleanup = e.fn();
    } finally {
      --runDepth;
      activeSub = prevSub;
      e.flags &= ~4 /* RecursedCheck */;
      purgeDeps(e);
    }
  } else if (e.deps !== void 0) {
    e.flags = 2 /* Watching */ | flags & 64 /* HasChildEffect */;
  }
}
function runCleanup(e) {
  const cleanup = e.cleanup;
  e.cleanup = void 0;
  const prevSub = activeSub;
  activeSub = void 0;
  try {
    cleanup();
  } finally {
    activeSub = prevSub;
  }
}
function runWatcher(e) {
  const prevSub = setActiveSub(void 0);
  try {
    e.draftNotify(e.deps !== void 0 ? e.deps.dep : e);
  } finally {
    activeSub = prevSub;
  }
}
function flush() {
  try {
    while (notifyIndex < queuedLength) {
      const e = queued[notifyIndex];
      queued[notifyIndex++] = void 0;
      run(e);
    }
  } finally {
    while (notifyIndex < queuedLength) {
      const e = queued[notifyIndex];
      queued[notifyIndex++] = void 0;
      e.flags |= 2 /* Watching */ | 8 /* Recursed */;
    }
    notifyIndex = 0;
    queuedLength = 0;
  }
}
function createAtomNode(value, equals) {
  return {
    kind: 0 /* Atom */,
    flags: 1 /* Mutable */,
    subs: void 0,
    subsTail: void 0,
    deps: void 0,
    depsTail: void 0,
    value,
    staged: value,
    equals
  };
}
function createComputedNode(fn, equals) {
  return {
    kind: 1 /* Computed */,
    flags: 0 /* None */,
    subs: void 0,
    subsTail: void 0,
    deps: void 0,
    depsTail: void 0,
    value: void 0,
    fn,
    equals
  };
}
function readAtom(s) {
  if (worldHooks.active) {
    return worldHooks.atomValue(s);
  }
  if (s.flags & 16 /* Dirty */) {
    if (updateAtom(s)) {
      const subs = s.subs;
      if (subs !== void 0) {
        shallowPropagate(subs);
      }
    }
  }
  const sub = activeSub;
  if (sub !== void 0) {
    link(s, sub, cycle);
  }
  return s.value;
}
function canonicalAtomValue(s) {
  if (s.flags & 16 /* Dirty */) {
    if (updateAtom(s)) {
      const subs = s.subs;
      if (subs !== void 0) {
        shallowPropagate(subs);
      }
    }
  }
  return s.value;
}
function invalidateComputed(c) {
  c.flags |= 16 /* Dirty */;
  const subs = c.subs;
  if (subs !== void 0) {
    propagate(subs, runDepth > 0);
    if (!batchDepth) {
      flush();
    }
  }
}
function writeAtom(s, value) {
  if (!s.equals(s.staged, value)) {
    s.staged = value;
    s.flags = 1 /* Mutable */ | 16 /* Dirty */;
    const subs = s.subs;
    if (subs !== void 0) {
      propagate(subs, runDepth > 0);
      if (!batchDepth) {
        flush();
      }
    }
  }
}
function readComputed(c) {
  if (worldHooks.active) {
    return worldHooks.computedValue(c);
  }
  const flags = c.flags;
  if (flags & 16 /* Dirty */ || flags & 32 /* Pending */ && (checkDirty(c.deps, c) || (c.flags = flags & ~32 /* Pending */, false))) {
    if (updateComputed(c)) {
      const subs = c.subs;
      if (subs !== void 0) {
        shallowPropagate(subs);
      }
    }
  } else if (!flags) {
    c.flags = 1 /* Mutable */ | 4 /* RecursedCheck */;
    const prevSub = setActiveSub(c);
    try {
      c.value = c.fn();
    } finally {
      activeSub = prevSub;
      c.flags &= ~4 /* RecursedCheck */;
    }
  }
  const sub = activeSub;
  if (sub !== void 0) {
    link(c, sub, cycle);
  }
  return c.value;
}
function createEffect(fn, options) {
  const e = {
    kind: 2 /* Effect */,
    flags: 2 /* Watching */ | 4 /* RecursedCheck */,
    subs: void 0,
    subsTail: void 0,
    deps: void 0,
    depsTail: void 0,
    fn,
    cleanup: void 0,
    draftNotify: options?.draftNotify
  };
  const prevSub = setActiveSub(e);
  if (prevSub !== void 0) {
    link(e, prevSub, 0);
    prevSub.flags |= 64 /* HasChildEffect */;
  }
  try {
    ++runDepth;
    e.cleanup = e.fn();
  } finally {
    --runDepth;
    activeSub = prevSub;
    e.flags &= ~4 /* RecursedCheck */;
  }
  return e;
}
function createScope(fn) {
  const e = {
    kind: 3 /* Scope */,
    flags: 1 /* Mutable */,
    subs: void 0,
    subsTail: void 0,
    deps: void 0,
    depsTail: void 0,
    fn: void 0,
    cleanup: void 0,
    draftNotify: void 0
  };
  const prevSub = setActiveSub(e);
  if (prevSub !== void 0) {
    link(e, prevSub, 0);
    prevSub.flags |= 64 /* HasChildEffect */;
  }
  try {
    fn();
  } finally {
    activeSub = prevSub;
  }
  return e;
}
function disposeEffect(e) {
  e.flags = 0 /* None */;
  disposeAllDepsInReverse(e);
  const sub = e.subs;
  if (sub !== void 0) {
    unlink(sub);
  }
  if (e.kind === 2 /* Effect */ && e.cleanup !== void 0) {
    runCleanup(e);
  }
}
function disposeAllDepsInReverse(sub) {
  let l = sub.depsTail;
  while (l !== void 0) {
    const prev = l.prevDep;
    unlink(l, sub);
    l = prev;
  }
}
function purgeDeps(sub) {
  const depsTail = sub.depsTail;
  let dep = depsTail !== void 0 ? depsTail.nextDep : sub.deps;
  while (dep !== void 0) {
    dep = unlink(dep, sub);
  }
}
function collectWatchers(node, out2, seen) {
  const visited = seen ?? /* @__PURE__ */ new Set();
  if (visited.has(node)) {
    return;
  }
  visited.add(node);
  let l = node.subs;
  while (l !== void 0) {
    const sub = l.sub;
    if (sub.draftNotify !== void 0) {
      out2.add(sub);
    } else if (sub.kind === 1 /* Computed */) {
      collectWatchers(sub, out2, visited);
    }
    l = l.nextSub;
  }
}
function graphQuiescent() {
  return queuedLength === 0 && batchDepth === 0;
}
var worldHooks, cycle, runDepth, batchDepth, notifyIndex, queuedLength, activeSub, queued;
var init_graph = __esm({
  "../signals-royale-fh2/src/graph.ts"() {
    "use strict";
    worldHooks = {
      active: false,
      atomValue: (node) => node.value,
      computedValue: (node) => node.value,
      onWatched: () => {
      },
      onUnwatched: () => {
      }
    };
    cycle = 0;
    runDepth = 0;
    batchDepth = 0;
    notifyIndex = 0;
    queuedLength = 0;
    queued = [];
  }
});

// ../signals-royale-fh2/src/tracer.ts
function tracing() {
  return active !== null;
}
function emit(kind, data, cause) {
  const t = active;
  if (t === null) {
    return 0;
  }
  const id = nextEventId++;
  const parent = cause ?? currentCause;
  const e = { id, kind, data };
  if (parent !== 0) {
    e.cause = parent;
  }
  if (t.ring > 0) {
    const evicted = t.buf[t.head];
    if (evicted !== void 0) {
      t.byId.delete(evicted.id);
      t.dropped++;
    }
    t.buf[t.head] = e;
    t.head = (t.head + 1) % t.ring;
  } else {
    t.buf.push(e);
  }
  t.byId.set(id, e);
  t.count++;
  return id;
}
function withCause(cause, fn) {
  if (active === null) {
    return fn();
  }
  const prev = currentCause;
  currentCause = cause;
  try {
    return fn();
  } finally {
    currentCause = prev;
  }
}
function describe(e) {
  const bits = e.data ? Object.entries(e.data).map(([k, v]) => `${k}=${String(v)}`).join(" ") : "";
  return `#${e.id} ${e.kind}${bits ? " " + bits : ""}${e.cause ? ` <- #${e.cause}` : ""}`;
}
function attachTracer(options) {
  const ring = options?.ring ?? 0;
  const state = {
    buf: ring > 0 ? new Array(ring) : [],
    ring,
    head: 0,
    count: 0,
    dropped: 0,
    byId: /* @__PURE__ */ new Map()
  };
  active = state;
  const ordered = () => {
    if (state.ring === 0) {
      return state.buf.filter((e) => e !== void 0);
    }
    const out2 = [];
    for (let i = 0; i < state.ring; i++) {
      const e = state.buf[(state.head + i) % state.ring];
      if (e !== void 0) {
        out2.push(e);
      }
    }
    return out2;
  };
  const chain = (id) => {
    const out2 = [];
    let cur = state.byId.get(id);
    const seen = /* @__PURE__ */ new Set();
    while (cur !== void 0 && !seen.has(cur.id)) {
      seen.add(cur.id);
      out2.unshift(cur);
      cur = cur.cause !== void 0 ? state.byId.get(cur.cause) : void 0;
    }
    return out2;
  };
  return {
    events: (kind) => kind ? ordered().filter((e) => e.kind === kind) : ordered(),
    dropped: () => state.dropped,
    last: (pred) => {
      const all = ordered();
      for (let i = all.length - 1; i >= 0; i--) {
        if (pred(all[i])) {
          return all[i];
        }
      }
      return void 0;
    },
    chain,
    explain: (id) => chain(id).map(describe),
    stop() {
      if (active === state) {
        active = null;
      }
    }
  };
}
var active, nextEventId, currentCause;
var init_tracer = __esm({
  "../signals-royale-fh2/src/tracer.ts"() {
    "use strict";
    active = null;
    nextEventId = 1;
    currentCause = 0;
  }
});

// ../signals-royale-fh2/src/engine.ts
function applyOp(v, op) {
  return op.update !== void 0 ? op.update(v) : op.set;
}
function isPendingValue(v) {
  return typeof v === "object" && v !== null && v.pending === true && typeof v.of === "number";
}
function bumpPending() {
  pendingEpochCounter++;
  for (const cb of pendingListeners) {
    cb();
  }
}
function onPendingFlip(cb) {
  pendingListeners.add(cb);
  return () => {
    pendingListeners.delete(cb);
  };
}
function currentPendingEpoch() {
  return pendingEpochCounter;
}
function currentGraphEpoch() {
  return graphEpoch;
}
function openBatch(key) {
  const id = nextBatchId++;
  const b = {
    id,
    key: key ?? id,
    touched: /* @__PURE__ */ new Set(),
    refreshes: /* @__PURE__ */ new Set(),
    version: 0,
    open: true,
    deliveredTo: /* @__PURE__ */ new Set()
  };
  openBatchesByKey.set(b.key, b);
  bumpPending();
  if (tracing()) {
    emit("batch-open", { batch: id, key: String(b.key) });
  }
  return b;
}
function batchForKey(key) {
  return openBatchesByKey.get(key) ?? openBatch(key);
}
function openBatchForKey(key) {
  return openBatchesByKey.get(key);
}
function openBatches() {
  return [...openBatchesByKey.values()];
}
function replayQueue(rec, include) {
  let v = rec.baseValue;
  const equals = rec.node.equals;
  for (const op of rec.queue) {
    if (op.b === null || include !== null && include.includes(op.b)) {
      const next = applyOp(v, op);
      if (!equals(v, next)) {
        v = next;
      }
    }
  }
  return v;
}
function compactQueue(rec) {
  const q = rec.queue;
  let i = 0;
  while (i < q.length && q[i].b === null) {
    rec.baseValue = applyOp(rec.baseValue, q[i]);
    i++;
  }
  if (i === q.length) {
    rec.queue = null;
    rec.baseValue = void 0;
  } else if (i > 0) {
    q.splice(0, i);
  }
}
function retireBatch(b) {
  if (!b.open) {
    return;
  }
  b.open = false;
  openBatchesByKey.delete(b.key);
  const retireEvent = tracing() ? emit("batch-retire", { batch: b.id }) : 0;
  withCause(retireEvent, () => {
    startBatch();
    try {
      for (const rec of b.touched) {
        if (rec.queue === null) {
          continue;
        }
        for (const op of rec.queue) {
          if (op.b === b) {
            op.b = null;
          }
        }
        const next = replayQueue(rec, null);
        compactQueue(rec);
        applyCanonicalWrite(rec, next);
      }
      const promoted = /* @__PURE__ */ new Set();
      const solo = worldCaches.get(String(b.id));
      if (solo !== void 0) {
        for (const [rec, entry] of solo.entries) {
          entry.world = null;
          promoted.add(rec);
          if (entry.refresh) {
            if (rec.refreshing === entry || rec.refreshing === void 0) {
              adoptRefreshEntry(rec, entry);
            }
          } else {
            killEntry(rec.canonicalEntry);
            rec.canonicalEntry = entry;
          }
        }
        solo.entries.clear();
      }
      pruneWorldsWith(b);
      for (const rec of b.refreshes) {
        if (!promoted.has(rec)) {
          refreshCanonical(rec);
        }
      }
    } finally {
      endBatch();
    }
  });
  graphEpoch++;
  for (const rec of b.touched) {
    wakeOpenWorlds(rec);
  }
  b.touched.clear();
  b.refreshes.clear();
  b.deliveredTo.clear();
  bumpPending();
  maybeQuiesce();
}
function wakeOpenWorlds(rec) {
  if (rec.queue === null) {
    return;
  }
  for (const b2 of openBatchesByKey.values()) {
    if (b2.touched.has(rec)) {
      b2.version++;
      draftDeliver(b2, rec);
    }
  }
}
function discardBatch(b) {
  if (!b.open) {
    return;
  }
  b.open = false;
  openBatchesByKey.delete(b.key);
  const ev = tracing() ? emit("batch-discard", { batch: b.id }) : 0;
  pruneWorldsWith(b);
  graphEpoch++;
  for (const rec of b.touched) {
    if (rec.queue !== null) {
      rec.queue = rec.queue.filter((op) => op.b !== b);
      compactQueue(rec);
    }
    wakeOpenWorlds(rec);
  }
  const seen = [...b.deliveredTo];
  b.touched.clear();
  b.refreshes.clear();
  b.deliveredTo.clear();
  withCause(ev, () => {
    for (const sub of seen) {
      if (!sub.disposed) {
        deliver(sub, null);
      }
    }
  });
  bumpPending();
  maybeQuiesce();
}
function worldFingerprint(batches) {
  let fp = String(graphEpoch);
  for (const b of batches) {
    fp += ":" + b.version;
  }
  return fp;
}
function worldFor(batches) {
  const sorted = [...batches].sort((a, b) => a.id - b.id);
  let key = "";
  for (const b of sorted) {
    key += (key ? "," : "") + b.id;
  }
  let wc = worldCaches.get(key);
  if (wc === void 0) {
    wc = {
      key,
      batches: sorted,
      fingerprint: worldFingerprint(sorted),
      values: /* @__PURE__ */ new Map(),
      reads: /* @__PURE__ */ new Map(),
      entries: /* @__PURE__ */ new Map()
    };
    worldCaches.set(key, wc);
  } else {
    const fp = worldFingerprint(sorted);
    if (wc.fingerprint !== fp) {
      wc.fingerprint = fp;
      wc.values.clear();
      wc.reads.clear();
    }
  }
  return wc;
}
function pruneWorldsWith(b) {
  for (const [key, wc] of worldCaches) {
    if (wc.batches.includes(b)) {
      for (const entry of wc.entries.values()) {
        killEntry(entry);
      }
      worldCaches.delete(key);
    }
  }
}
function killEntry(entry) {
  if (entry !== void 0) {
    entry.dead = true;
  }
}
function recordRead(rec) {
  const wc = activeWorld;
  if (wc !== null && worldEvalStack.length > 0) {
    let readers = wc.reads.get(rec);
    if (readers === void 0) {
      readers = /* @__PURE__ */ new Set();
      wc.reads.set(rec, readers);
    }
    readers.add(worldEvalStack[worldEvalStack.length - 1]);
  }
}
function atomValueInWorld(rec, wc) {
  materialize(rec);
  if (rec.queue === null) {
    return canonicalAtomValue(rec.node);
  }
  return replayQueue(rec, wc.batches);
}
function computedValueInWorld(rec, wc) {
  if (wc.values.has(rec)) {
    return wc.values.get(rec);
  }
  let entry = wc.entries.get(rec);
  if (entry === void 0) {
    const refreshed = wc.batches.some((b) => b.refreshes.has(rec));
    entry = freshEntry(rec, wc, refreshed);
    if (!refreshed && rec.canonicalEntry !== void 0) {
      for (const [k, slot] of rec.canonicalEntry.slots) {
        entry.slots.set(k, slot);
      }
    }
    wc.entries.set(rec, entry);
  }
  worldEvalStack.push(rec);
  const value = runEvaluation(rec, entry, false);
  worldEvalStack.pop();
  wc.values.set(rec, value);
  return value;
}
function withWorld(wc, fn) {
  const prevWorld = activeWorld;
  const prevActive = worldHooks.active;
  const prevSub = setActiveSub(void 0);
  activeWorld = wc;
  worldHooks.active = true;
  try {
    return fn();
  } finally {
    activeWorld = prevWorld;
    worldHooks.active = prevActive;
    setActiveSub(prevSub);
  }
}
function recOfAtomNode(node) {
  return atomRecs.get(node);
}
function recOfComputedNode(node) {
  return computedRecs.get(node);
}
function recOf(x) {
  return x;
}
function asAtomRec(x) {
  const rec = x;
  if (rec.t !== 0) {
    throw new TypeError("expected a writable atom");
  }
  return rec;
}
function atom(initial, options) {
  const lazy = typeof initial === "function";
  const node = createAtomNode(lazy ? void 0 : initial, options?.equals ?? defaultEquals);
  const rec = {
    t: 0,
    id: nextRecId++,
    node,
    label: options?.label,
    baseValue: void 0,
    queue: null,
    init: lazy ? initial : void 0,
    observed: options?.effect,
    obsCleanup: void 0,
    obsActive: false,
    obsScheduled: false
  };
  atomRecs.set(node, rec);
  return rec;
}
function computed(fn, options) {
  const userEquals = options?.equals ?? defaultEquals;
  const equals = (a, b) => isPendingValue(a) || isPendingValue(b) || a instanceof AsyncError || b instanceof AsyncError ? Object.is(a, b) : userEquals(a, b);
  const node = createComputedNode(() => runEvaluation(rec, canonicalEntryOf(rec), false), equals);
  const rec = {
    t: 1,
    id: nextRecId++,
    node,
    userFn: fn,
    equals,
    label: options?.label,
    pendingBox: void 0,
    lastSettled: void 0,
    hasSettled: false,
    canonicalEntry: void 0,
    reuseEntry: void 0,
    refreshing: void 0
  };
  computedRecs.set(node, rec);
  return rec;
}
function materialize(rec) {
  const init = rec.init;
  if (init !== void 0) {
    rec.init = void 0;
    initDepth++;
    try {
      const v = untracked(init);
      rec.node.value = v;
      rec.node.staged = v;
    } finally {
      initDepth--;
    }
  }
}
function pendingBoxFor(rec) {
  if (rec.pendingBox === void 0) {
    rec.pendingBox = { pending: true, of: rec.id, _rec: rec };
  }
  return rec.pendingBox;
}
function canonicalEntryOf(rec) {
  if (rec.canonicalEntry === void 0 || rec.canonicalEntry.dead) {
    rec.canonicalEntry = freshEntry(rec, null, false);
  }
  return rec.canonicalEntry;
}
function freshEntry(rec, world, refresh2) {
  return {
    rec,
    slots: /* @__PURE__ */ new Map(),
    world,
    refresh: refresh2,
    retry: null,
    resolveRetry: null,
    pendingInner: [],
    evalStamp: 0,
    dead: false
  };
}
function attachSlot(slot) {
  slot.thenable.then(
    (v) => {
      if (slot.status === 0) {
        slot.status = 1;
        slot.value = v;
        onSlotSettled(slot);
      }
    },
    (e) => {
      if (slot.status === 0) {
        slot.status = 2;
        slot.errorBox = new AsyncError(e);
        onSlotSettled(slot);
      }
    }
  );
}
function runEvaluation(rec, entry, readonly) {
  const stamp = evalStampCounter++;
  entry.evalStamp = stamp;
  const prev = activeEval;
  activeEval = { entry, pendingSlots: [], pendingInner: [], stamp, readonly };
  let result;
  let threw = false;
  let error;
  try {
    result = rec.userFn(useFn);
  } catch (e) {
    threw = true;
    error = e;
  }
  const ctx = activeEval;
  activeEval = prev;
  entry.pendingInner = ctx.pendingInner;
  if (ctx.pendingSlots.length > 0 || ctx.pendingInner.length > 0) {
    return pendingBoxFor(rec);
  }
  if (threw) {
    if (error instanceof AsyncError) {
      return error;
    }
    throw error;
  }
  if (!readonly && entry.world === null && !entry.refresh && !isPendingValue(result) && !(result instanceof AsyncError)) {
    rec.lastSettled = result;
    rec.hasSettled = true;
  }
  return result;
}
function onSlotSettled(slot) {
  for (const entry of [...slot.owners]) {
    if (entry.dead) {
      slot.owners.delete(entry);
      continue;
    }
    const rec = entry.rec;
    const ev = tracing() ? emit("settle", { tid: rec.id, label: rec.label, ok: slot.status === 1 }) : 0;
    const rr = entry.resolveRetry;
    entry.retry = null;
    entry.resolveRetry = null;
    if (rr !== null) {
      rr();
    }
    if (entry.world === null) {
      if (entry.refresh) {
        if (rec.refreshing === entry) {
          probeRefresh(rec, entry);
        }
      } else {
        graphEpoch++;
        withCause(ev, () => invalidateComputed(rec.node));
      }
    } else {
      const wc = entry.world;
      for (const b of wc.batches) {
        b.version++;
      }
      wc.fingerprint = "";
      wc.values.clear();
      withCause(ev, () => draftDeliverIn(wc, rec));
    }
    bumpPending();
  }
}
function guardWrite() {
  if (initDepth > 0) {
    throw new Error("a lazy initializer must not write signals");
  }
  if (host.assertCanWrite !== null) {
    host.assertCanWrite();
  }
}
function set(a, value) {
  const rec = asAtomRec(a);
  guardWrite();
  materialize(rec);
  const b = host.classify !== null ? host.classify() : null;
  if (b !== null) {
    draftWrite(b, rec, { b, set: value });
  } else {
    urgentWrite(rec, { b: null, set: value });
  }
}
function update2(a, fn) {
  const rec = asAtomRec(a);
  guardWrite();
  materialize(rec);
  const b = host.classify !== null ? host.classify() : null;
  if (b !== null) {
    draftWrite(b, rec, { b, update: fn });
  } else {
    urgentWrite(rec, { b: null, update: fn });
  }
}
function setInBatch(b, a, value) {
  const rec = asAtomRec(a);
  guardWrite();
  materialize(rec);
  draftWrite(b, rec, { b, set: value });
}
function updateInBatch(b, a, fn) {
  const rec = asAtomRec(a);
  guardWrite();
  materialize(rec);
  draftWrite(b, rec, { b, update: fn });
}
function urgentWrite(rec, op) {
  const value = applyOp(rec.node.staged, op);
  const equal = rec.node.equals(rec.node.staged, value);
  if (op.update === void 0 && equal) {
    if (tracing()) {
      emit("write-dropped", { tid: rec.id, label: rec.label, batch: 0 });
    }
    return;
  }
  if (rec.queue !== null) {
    rec.queue.push(op);
    if (equal) {
      graphEpoch++;
      for (const b of openBatchesByKey.values()) {
        if (b.touched.has(rec)) {
          b.version++;
          if (tracing()) {
            const w = emit("write", { tid: rec.id, label: rec.label, batch: b.id });
            withCause(w, () => draftDeliver(b, rec));
          } else {
            draftDeliver(b, rec);
          }
        }
      }
      return;
    }
  }
  applyCanonicalWrite(rec, value);
}
function applyCanonicalWrite(rec, value) {
  const node = rec.node;
  if (node.equals(node.staged, value)) {
    if (tracing()) {
      emit("write-dropped", { tid: rec.id, label: rec.label, batch: 0 });
    }
    return;
  }
  graphEpoch++;
  if (tracing()) {
    const w = emit("write", { tid: rec.id, label: rec.label, batch: 0 });
    withCause(w, () => writeAtom(node, value));
  } else {
    writeAtom(node, value);
  }
}
function draftWrite(b, rec, op) {
  if (!b.open) {
    throw new Error("write into a retired batch");
  }
  if (op.update === void 0) {
    const current = atomValueInWorld(rec, worldFor([b]));
    if (rec.node.equals(current, op.set)) {
      if (tracing()) {
        emit("write-dropped", { tid: rec.id, label: rec.label, batch: b.id });
      }
      return;
    }
  }
  if (rec.queue === null) {
    rec.baseValue = rec.node.staged;
    rec.queue = [];
  }
  rec.queue.push(op);
  b.touched.add(rec);
  b.version++;
  bumpPending();
  if (tracing()) {
    const w = emit("write", { tid: rec.id, label: rec.label, batch: b.id });
    withCause(w, () => draftDeliver(b, rec));
  } else {
    draftDeliver(b, rec);
  }
}
function refresh(x) {
  const rec = recOf(x);
  if (rec.t !== 1) {
    throw new TypeError("refresh expects a computed");
  }
  guardWrite();
  const b = host.classify !== null ? host.classify() : null;
  if (tracing()) {
    emit("refresh", { tid: rec.id, label: rec.label, batch: b === null ? 0 : b.id });
  }
  if (b !== null) {
    b.refreshes.add(rec);
    b.version++;
    for (const wc of worldCaches.values()) {
      if (wc.batches.includes(b)) {
        killEntry(wc.entries.get(rec));
        wc.entries.delete(rec);
      }
    }
    bumpPending();
    draftDeliver(b, rec);
  } else {
    refreshCanonical(rec);
  }
}
function refreshCanonical(rec) {
  if (rec.canonicalEntry === void 0) {
    graphEpoch++;
    invalidateComputed(rec.node);
    return;
  }
  if (rec.refreshing !== void 0) {
    rec.refreshing.dead = true;
  }
  const entry = freshEntry(rec, null, true);
  rec.refreshing = entry;
  bumpPending();
  probeRefresh(rec, entry);
}
function probeRefresh(rec, entry) {
  let v;
  try {
    v = untracked(() => runEvaluation(rec, entry, false));
  } catch {
    v = pendingBoxFor(rec);
    adoptRefreshEntry(rec, entry);
    return;
  }
  if (!isPendingValue(v)) {
    adoptRefreshEntry(rec, entry);
  }
}
function adoptRefreshEntry(rec, entry) {
  if (rec.refreshing === entry) {
    rec.refreshing = void 0;
  }
  entry.refresh = false;
  killEntry(rec.canonicalEntry);
  rec.canonicalEntry = entry;
  graphEpoch++;
  invalidateComputed(rec.node);
  bumpPending();
}
function deliver(sub, batch2) {
  if (sub.disposed) {
    return;
  }
  if (tracing()) {
    sub.lastDeliverEvent = emit("deliver", {
      tid: sub.target.id,
      label: sub.label ?? sub.target.label,
      batch: batch2 === null ? 0 : batch2.id
    });
  }
  try {
    sub.onDeliver({ batch: batch2 });
  } catch (e) {
    subscriberErrors.push(e);
  }
}
function subscribe(x, onDeliver, opts) {
  const rec = recOf(x);
  if (rec.t === 0) {
    materialize(rec);
  }
  const sub = {
    effect: void 0,
    target: rec,
    onDeliver,
    disposed: false,
    lastDeliverEvent: 0,
    label: opts?.label
  };
  const prevSub = setActiveSub(void 0);
  try {
    sub.effect = createEffect(
      () => {
        try {
          if (rec.t === 0) {
            readAtom(rec.node);
          } else {
            readComputed(rec.node);
          }
        } catch {
        }
      },
      { draftNotify: () => deliver(sub, null) }
    );
  } finally {
    setActiveSub(prevSub);
  }
  subByEffect.set(sub.effect, sub);
  return {
    dispose() {
      if (sub.disposed) {
        return;
      }
      sub.disposed = true;
      disposeEffect(sub.effect);
    },
    lastDeliveryEvent: () => sub.lastDeliverEvent
  };
}
function draftDeliver(b, rec) {
  const found = /* @__PURE__ */ new Set();
  collectWatchers(rec.node, found);
  for (const wc of worldCaches.values()) {
    if (wc.batches.includes(b)) {
      chaseWorldReads(wc, rec, found);
    }
  }
  notifyFound(found, b);
}
function draftDeliverIn(wc, rec) {
  const found = /* @__PURE__ */ new Set();
  collectWatchers(rec.node, found);
  chaseWorldReads(wc, rec, found);
  notifyFound(found, wc.batches[wc.batches.length - 1] ?? null);
}
function chaseWorldReads(wc, rec, found) {
  const stack = [rec];
  const seen = /* @__PURE__ */ new Set([rec]);
  while (stack.length > 0) {
    const r = stack.pop();
    const readers = wc.reads.get(r);
    if (readers === void 0) {
      continue;
    }
    for (const reader of readers) {
      if (!seen.has(reader)) {
        seen.add(reader);
        collectWatchers(reader.node, found);
        stack.push(reader);
      }
    }
  }
}
function notifyFound(found, b) {
  for (const e of found) {
    const sub = subByEffect.get(e);
    if (sub !== void 0 && !sub.disposed) {
      if (b !== null) {
        b.deliveredTo.add(sub);
      }
      deliver(sub, b);
    }
  }
}
function scheduleObservation(rec) {
  if (rec.obsScheduled) {
    return;
  }
  rec.obsScheduled = true;
  microtask.then(() => settleObservation(rec));
}
function settleObservation(rec) {
  rec.obsScheduled = false;
  const shouldBeActive = rec.node.subs !== void 0;
  if (shouldBeActive === rec.obsActive) {
    return;
  }
  if (shouldBeActive) {
    rec.obsActive = true;
    materialize(rec);
    rec.obsCleanup = rec.observed({
      get: () => untracked(() => canonicalAtomValue(rec.node)),
      set: (v) => applyCanonicalWrite(rec, v)
    });
  } else {
    rec.obsActive = false;
    const cleanup = rec.obsCleanup;
    rec.obsCleanup = void 0;
    if (typeof cleanup === "function") {
      cleanup();
    }
  }
}
function rootViewFor(key) {
  let v = rootViews.get(key);
  if (v === void 0) {
    v = { map: /* @__PURE__ */ new WeakMap() };
    rootViews.set(key, v);
  }
  return v;
}
function reportCommittedValue(key, x, value) {
  const rec = recOf(x);
  globalView.map.set(rec, value);
  if (key !== void 0) {
    rootViewFor(key).map.set(rec, value);
  }
}
function committedAtomValue(rec, view) {
  materialize(rec);
  if (view.map.has(rec)) {
    return view.map.get(rec);
  }
  return canonicalAtomValue(rec.node);
}
function committedComputedValue(rec, view) {
  const prevCommitted = committedRead;
  const prevActive = worldHooks.active;
  const prevSub = setActiveSub(void 0);
  committedRead = view;
  worldHooks.active = true;
  try {
    return runEvaluation(rec, rec.canonicalEntry ?? freshEntry(rec, null, false), true);
  } finally {
    committedRead = prevCommitted;
    worldHooks.active = prevActive;
    setActiveSub(prevSub);
  }
}
function resolveRead(rec, v) {
  if (activeEval !== null && isPendingValue(v)) {
    activeEval.pendingInner.push(v._rec);
    return POISON;
  }
  if (v instanceof AsyncError) {
    throw v;
  }
  return v;
}
function read(x) {
  const rec = recOf(x);
  if (!worldHooks.active && activeEval === null && host.renderWorld !== null) {
    const rw = host.renderWorld();
    if (rw !== null && rw.length > 0) {
      return resolveRead(rec, readInWorld(x, rw));
    }
  }
  let v;
  if (rec.t === 0) {
    if (rec.init !== void 0) {
      materialize(rec);
    }
    v = readAtom(rec.node);
  } else {
    v = readComputed(rec.node);
  }
  return resolveRead(rec, v);
}
function readInWorld(x, batches) {
  const rec = recOf(x);
  if (batches.length === 0) {
    return untracked(
      () => rec.t === 0 ? (rec.init !== void 0 ? materialize(rec) : void 0, canonicalAtomValue(rec.node)) : readComputed(rec.node)
    );
  }
  const wc = worldFor(batches);
  return withWorld(wc, () => rec.t === 0 ? atomValueInWorld(rec, wc) : computedValueInWorld(rec, wc));
}
function latest(x) {
  const rec = recOf(x);
  if (worldHooks.active || activeEval !== null) {
    return read(x);
  }
  if (host.renderWorld !== null && host.renderWorld() !== null) {
    return read(x);
  }
  let v;
  if (rec.t === 0) {
    if (rec.init !== void 0) {
      materialize(rec);
    }
    v = readAtom(rec.node);
  } else {
    v = readComputed(rec.node);
  }
  const open = openBatchesByKey.size > 0 ? [...openBatchesByKey.values()] : null;
  if (open !== null) {
    v = readInWorld(x, open);
  }
  if (isPendingValue(v) && rec.t === 1 && rec.hasSettled) {
    return rec.lastSettled;
  }
  if (v instanceof AsyncError) {
    throw v;
  }
  return v;
}
function committed(x, container) {
  const rec = recOf(x);
  const view = container !== void 0 && typeof container === "object" && container !== null ? rootViews.get(container) ?? globalView : globalView;
  const v = rec.t === 0 ? committedAtomValue(rec, view) : committedComputedValue(rec, view);
  if (isPendingValue(v) && rec.t === 1 && rec.hasSettled) {
    return rec.lastSettled;
  }
  if (v instanceof AsyncError) {
    throw v;
  }
  return v;
}
function isPending(x) {
  const rec = recOf(x);
  if (rec.t === 0) {
    for (const b of openBatchesByKey.values()) {
      if (b.touched.has(rec)) {
        return true;
      }
    }
    return false;
  }
  if (rec.refreshing !== void 0) {
    return true;
  }
  const v = untracked(() => readComputed(rec.node));
  if (isPendingValue(v)) {
    return true;
  }
  const seen = /* @__PURE__ */ new Set();
  const stack = [rec.node];
  while (stack.length > 0) {
    const node = stack.pop();
    if (seen.has(node)) {
      continue;
    }
    seen.add(node);
    for (let l = node.deps; l !== void 0; l = l.nextDep) {
      const dep = l.dep;
      if (dep.kind === 0 /* Atom */) {
        const depRec = atomRecs.get(dep);
        if (depRec !== void 0) {
          for (const b of openBatchesByKey.values()) {
            if (b.touched.has(depRec)) {
              return true;
            }
          }
        }
      } else if (dep.kind === 1 /* Computed */) {
        const depRec = computedRecs.get(dep);
        if (depRec !== void 0) {
          if (depRec.refreshing !== void 0) {
            return true;
          }
          for (const b of openBatchesByKey.values()) {
            if (b.refreshes.has(depRec)) {
              return true;
            }
          }
        }
        stack.push(dep);
      }
    }
  }
  for (const b of openBatchesByKey.values()) {
    if (rec.t === 1 && b.refreshes.has(rec)) {
      return true;
    }
  }
  return false;
}
function worldStamp(batches) {
  let s = String(graphEpoch);
  for (const b of batches) {
    s += ":" + b.id + "." + b.version;
  }
  return s;
}
function pendingBatchesFor(x) {
  const out2 = /* @__PURE__ */ new Set();
  const rec = recOf(x);
  const roots = /* @__PURE__ */ new Set();
  const stack = [rec.node];
  while (stack.length > 0) {
    const node = stack.pop();
    if (roots.has(node)) {
      continue;
    }
    roots.add(node);
    if (node.kind === 0 /* Atom */) {
      const depRec = atomRecs.get(node);
      if (depRec !== void 0) {
        for (const b of openBatchesByKey.values()) {
          if (b.touched.has(depRec)) {
            out2.add(b);
          }
        }
      }
    } else if (node.kind === 1 /* Computed */) {
      const depRec = computedRecs.get(node);
      if (depRec !== void 0) {
        for (const b of openBatchesByKey.values()) {
          if (b.refreshes.has(depRec)) {
            out2.add(b);
          }
        }
      }
      for (let l = node.deps; l !== void 0; l = l.nextDep) {
        stack.push(l.dep);
      }
    }
  }
  return [...out2];
}
function debugId(x) {
  return recOf(x).id;
}
function retryThenable(x, batches) {
  const rec = recOf(x);
  if (rec.t !== 1) {
    return Promise.resolve();
  }
  const wc = batches.length > 0 ? worldFor(batches) : null;
  return entryRetry(rec, wc, /* @__PURE__ */ new Set());
}
function entryRetry(rec, wc, seen) {
  seen.add(rec);
  const entry = wc !== null ? wc.entries.get(rec) : rec.canonicalEntry;
  const waits = [];
  if (entry !== void 0) {
    let hasPending = false;
    for (const slot of entry.slots.values()) {
      if (slot.status === 0) {
        hasPending = true;
        break;
      }
    }
    if (hasPending) {
      if (entry.retry === null) {
        entry.retry = new Promise((r) => {
          entry.resolveRetry = r;
        });
      }
      waits.push(entry.retry);
    }
    for (const inner of entry.pendingInner) {
      if (!seen.has(inner)) {
        waits.push(entryRetry(inner, wc, seen));
      }
    }
  }
  if (waits.length === 0) {
    return Promise.resolve();
  }
  return Promise.race(waits).then(() => void 0);
}
function settledHistory(x) {
  const rec = recOf(x);
  if (rec.t !== 1) {
    return { has: false, value: void 0 };
  }
  return { has: rec.hasSettled, value: rec.lastSettled };
}
function effect(fn) {
  const wrapped = () => {
    if (tracing()) {
      const ev = emit("effect-run", {});
      return withCause(ev, fn);
    }
    return fn();
  };
  const e = createEffect(wrapped);
  return () => disposeEffect(e);
}
function effectScope(fn) {
  const e = createScope(fn);
  return () => disposeEffect(e);
}
function ssrKey(rec, i) {
  return rec.label ?? String(i);
}
function serializeAtomState(atoms, replacer) {
  const out2 = {};
  atoms.forEach((a, i) => {
    const rec = asAtomRec(a);
    materialize(rec);
    out2[ssrKey(rec, i)] = canonicalAtomValue(rec.node);
  });
  return JSON.stringify(out2, replacer);
}
function initializeAtomState(json, atoms, reviver) {
  const data = JSON.parse(json, reviver);
  atoms.forEach((a, i) => {
    const rec = asAtomRec(a);
    const key = ssrKey(rec, i);
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      installState(a, data[key]);
    }
  });
}
function installState(a, value) {
  const rec = asAtomRec(a);
  rec.init = void 0;
  rec.node.value = value;
  rec.node.staged = value;
  graphEpoch++;
  if (tracing()) {
    emit("install", { tid: rec.id, label: rec.label });
  }
}
function maybeQuiesce() {
  if (openBatchesByKey.size === 0 && worldCaches.size > 0) {
    for (const wc of worldCaches.values()) {
      for (const entry of wc.entries.values()) {
        killEntry(entry);
      }
    }
    worldCaches.clear();
  }
}
function quiescent() {
  return openBatchesByKey.size === 0 && worldCaches.size === 0 && graphQuiescent();
}
function __internals() {
  return {
    openBatches: openBatchesByKey.size,
    worldCaches: worldCaches.size,
    pendingListeners: pendingListeners.size
  };
}
function __resetEngine() {
  openBatchesByKey.clear();
  worldCaches.clear();
  globalView.map = /* @__PURE__ */ new WeakMap();
  pendingListeners.clear();
  subscriberErrors.length = 0;
  host.classify = null;
  host.assertCanWrite = null;
  host.renderWorld = null;
}
var defaultEquals, AsyncError, pendingListeners, nextRecId, evalStampCounter, graphEpoch, pendingEpochCounter, host, nextBatchId, openBatchesByKey, worldCaches, activeWorld, worldEvalStack, activeEval, committedRead, atomRecs, computedRecs, initDepth, POISON, DUMMY_SLOT, useFn, subByEffect, subscriberErrors, microtask, rootViews, globalView;
var init_engine = __esm({
  "../signals-royale-fh2/src/engine.ts"() {
    "use strict";
    init_graph();
    init_tracer();
    defaultEquals = (a, b) => Object.is(a, b);
    AsyncError = class extends Error {
      reason;
      constructor(reason) {
        super(`async computed rejected: ${String(reason)}`);
        this.reason = reason;
      }
    };
    pendingListeners = /* @__PURE__ */ new Set();
    nextRecId = 1;
    evalStampCounter = 1;
    graphEpoch = 1;
    pendingEpochCounter = 0;
    host = { classify: null, assertCanWrite: null, renderWorld: null };
    nextBatchId = 1;
    openBatchesByKey = /* @__PURE__ */ new Map();
    worldCaches = /* @__PURE__ */ new Map();
    activeWorld = null;
    worldEvalStack = [];
    activeEval = null;
    committedRead = null;
    worldHooks.atomValue = (node) => {
      const rec = recOfAtomNode(node);
      if (committedRead !== null) {
        return committedAtomValue(rec, committedRead);
      }
      recordRead(rec);
      return atomValueInWorld(rec, activeWorld);
    };
    worldHooks.computedValue = (node) => {
      const rec = recOfComputedNode(node);
      if (committedRead !== null) {
        return committedComputedValue(rec, committedRead);
      }
      recordRead(rec);
      return computedValueInWorld(rec, activeWorld);
    };
    atomRecs = /* @__PURE__ */ new WeakMap();
    computedRecs = /* @__PURE__ */ new WeakMap();
    initDepth = 0;
    POISON = void 0;
    DUMMY_SLOT = {
      key: void 0,
      thenable: { then: () => void 0 },
      status: 0,
      value: void 0,
      errorBox: void 0,
      stamp: 0,
      owners: /* @__PURE__ */ new Set()
    };
    useFn = (a, factory) => {
      const ctx = activeEval;
      if (ctx === null) {
        throw new Error("use() is only valid inside a computed evaluation");
      }
      const entry = ctx.entry;
      let slot = entry.slots.get(a);
      if (slot === void 0) {
        if (ctx.readonly) {
          ctx.pendingSlots.push(DUMMY_SLOT);
          return POISON;
        }
        const thenable = factory !== void 0 ? factory() : a;
        slot = {
          key: a,
          thenable,
          status: 0,
          value: void 0,
          errorBox: void 0,
          stamp: ctx.stamp,
          owners: /* @__PURE__ */ new Set([entry])
        };
        entry.slots.set(a, slot);
        attachSlot(slot);
      } else {
        slot.owners.add(entry);
        slot.stamp = ctx.stamp;
      }
      if (slot.status === 1) {
        return slot.value;
      }
      if (slot.status === 2) {
        throw slot.errorBox;
      }
      ctx.pendingSlots.push(slot);
      return POISON;
    };
    subByEffect = /* @__PURE__ */ new WeakMap();
    subscriberErrors = [];
    worldHooks.onWatched = (node) => {
      const rec = atomRecs.get(node);
      if (rec !== void 0) {
        materialize(rec);
        if (rec.observed !== void 0) {
          scheduleObservation(rec);
        }
      }
    };
    worldHooks.onUnwatched = (node) => {
      const rec = atomRecs.get(node);
      if (rec !== void 0 && rec.observed !== void 0) {
        scheduleObservation(rec);
      }
    };
    microtask = Promise.resolve();
    rootViews = /* @__PURE__ */ new WeakMap();
    globalView = { map: /* @__PURE__ */ new WeakMap() };
  }
});

// ../signals-royale-fh2/src/index.ts
var src_exports = {};
__export(src_exports, {
  AsyncError: () => AsyncError,
  __internals: () => __internals,
  __resetEngine: () => __resetEngine,
  atom: () => atom,
  attachTracer: () => attachTracer,
  batch: () => batch,
  batchForKey: () => batchForKey,
  committed: () => committed,
  computed: () => computed,
  currentGraphEpoch: () => currentGraphEpoch,
  currentPendingEpoch: () => currentPendingEpoch,
  debugId: () => debugId,
  discardBatch: () => discardBatch,
  effect: () => effect,
  effectScope: () => effectScope,
  emit: () => emit,
  endBatch: () => endBatch,
  host: () => host,
  initializeAtomState: () => initializeAtomState,
  installState: () => installState,
  isPending: () => isPending,
  isPendingValue: () => isPendingValue,
  latest: () => latest,
  onPendingFlip: () => onPendingFlip,
  openBatch: () => openBatch,
  openBatchForKey: () => openBatchForKey,
  openBatches: () => openBatches,
  pendingBatchesFor: () => pendingBatchesFor,
  quiescent: () => quiescent,
  read: () => read,
  readInWorld: () => readInWorld,
  refresh: () => refresh,
  reportCommittedValue: () => reportCommittedValue,
  retireBatch: () => retireBatch,
  retryThenable: () => retryThenable,
  serializeAtomState: () => serializeAtomState,
  set: () => set,
  setInBatch: () => setInBatch,
  settledHistory: () => settledHistory,
  startBatch: () => startBatch,
  subscribe: () => subscribe,
  subscriberErrors: () => subscriberErrors,
  tracing: () => tracing,
  untracked: () => untracked,
  update: () => update2,
  updateInBatch: () => updateInBatch,
  withCause: () => withCause,
  worldStamp: () => worldStamp
});
var init_src = __esm({
  "../signals-royale-fh2/src/index.ts"() {
    "use strict";
    init_engine();
    init_graph();
    init_tracer();
  }
});

// src/runtime.ts
import {
  unstable_externalSignals
} from "react-dom/client";
function getSeam() {
  const seam = unstable_externalSignals;
  if (seam === void 0 || typeof seam.inject !== "function") {
    throw new Error(
      "react-signals-royale-fh2 requires a React build with the external-signals seam (react-dom/client must export 'unstable_externalSignals'); this React build does not have it."
    );
  }
  return seam;
}
function renderingPass() {
  return getSeam().isRenderPhase() ? currentPass : null;
}
function snapshotPass(root) {
  if (root === null) {
    return null;
  }
  return passByRoot.get(root) ?? null;
}
function laneBatches(lanes) {
  const out2 = [];
  for (const b of openBatches()) {
    if ((b.key & lanes) !== 0) {
      out2.push(b);
    }
  }
  return out2;
}
function classifyWrite() {
  const seam = getSeam();
  const lane = seam.currentTransitionLane();
  if (lane === 0) {
    return null;
  }
  let b = openBatchForKey(lane);
  if (b === void 0) {
    b = batchForKey(lane);
    const root = kickRoot?.deref();
    if (root !== void 0) {
      seam.scheduleRootLane(root, lane);
    } else {
      pendingKicks.add(lane);
    }
  }
  return b;
}
function assertWriteAllowed() {
  if (getSeam().isRenderPhase()) {
    throw new Error(
      "signals-royale-fh2: writing a signal during render is not allowed. Move the write to an event handler, an effect, or a transition scope."
    );
  }
}
function registerReactSignals() {
  const seam = getSeam();
  host.classify = classifyWrite;
  host.assertCanWrite = assertWriteAllowed;
  host.renderWorld = () => {
    const p = renderingPass();
    return p === null ? null : p.batches;
  };
  if (installed === null) {
    installed = seam.inject(runtime);
  }
  return {
    errors: subscriberErrors,
    dispose() {
      host.classify = null;
      host.assertCanWrite = null;
      host.renderWorld = null;
    }
  };
}
function onDomMutation(cb) {
  mutationListeners.add(cb);
  return () => {
    mutationListeners.delete(cb);
  };
}
function onRootCommit(cb) {
  commitListeners.add(cb);
  return () => {
    commitListeners.delete(cb);
  };
}
function resetReactSignalsForTest() {
  passByRoot.clear();
  currentPass = null;
  kickRoot = null;
  pendingKicks.clear();
  mutationListeners.clear();
  commitListeners.clear();
  __resetEngine();
}
var passByRoot, currentPass, kickRoot, pendingKicks, mutationListeners, commitListeners, runtime, installed;
var init_runtime = __esm({
  "src/runtime.ts"() {
    "use strict";
    init_src();
    passByRoot = /* @__PURE__ */ new Map();
    currentPass = null;
    kickRoot = null;
    pendingKicks = /* @__PURE__ */ new Set();
    mutationListeners = /* @__PURE__ */ new Set();
    commitListeners = /* @__PURE__ */ new Set();
    runtime = {
      onPassStarted(root, lanes) {
        kickRoot = new WeakRef(root);
        if (pendingKicks.size > 0) {
          const seam = getSeam();
          for (const lane of pendingKicks) {
            if (openBatchForKey(lane) !== void 0) {
              seam.scheduleRootLane(root, lane);
            }
          }
          pendingKicks.clear();
        }
        const rec = { root, lanes, batches: laneBatches(lanes) };
        passByRoot.set(root, rec);
        currentPass = rec;
        if (tracing()) {
          emit("pass-start", { lanes });
        }
      },
      onPassDiscarded(root, lanes) {
        passByRoot.delete(root);
        if (currentPass !== null && currentPass.root === root) {
          currentPass = null;
        }
        if (tracing()) {
          emit("pass-end", { lanes, disposition: "discard" });
        }
      },
      onCommitPhase(root, phase, lanes) {
        if (phase !== "committed") {
          if (tracing()) {
            emit("mutation-window", { phase: phase === "mutation-start" ? "start" : "stop" });
          }
          const p = phase === "mutation-start" ? "start" : "stop";
          for (const cb of mutationListeners) {
            try {
              cb(p, root.containerInfo);
            } catch (e) {
              subscriberErrors.push(e);
            }
          }
          return;
        }
        const commitEvent = tracing() ? emit("root-commit", { lanes }) : 0;
        if (tracing()) {
          emit("pass-end", { lanes, disposition: "commit" }, commitEvent);
        }
        for (const b of laneBatches(lanes)) {
          retireBatch(b);
        }
        passByRoot.delete(root);
        if (currentPass !== null && currentPass.root === root) {
          currentPass = null;
        }
        for (const cb of commitListeners) {
          try {
            cb();
          } catch (e) {
            subscriberErrors.push(e);
          }
        }
      }
    };
    installed = null;
  }
});

// src/hooks.ts
import * as React from "react";
function makeStore(x) {
  const store = {
    force: null,
    root: null,
    lastDeliveryEvent: 0,
    cacheKey: "",
    cacheVal: void 0,
    getSnapshot() {
      const pass = renderingPass() ?? snapshotPass(store.root);
      const batches = pass === null ? [] : pass.batches;
      if (batches.length === 0) {
        return readInWorld(x, batches);
      }
      const stamp = worldStamp(batches);
      if (store.cacheKey !== stamp) {
        store.cacheKey = stamp;
        store.cacheVal = readInWorld(x, batches);
      }
      return store.cacheVal;
    },
    subscribe(onStoreChange) {
      const seam = getSeam();
      const handle = subscribe(x, (d) => {
        store.lastDeliveryEvent = handle.lastDeliveryEvent();
        if (d.batch === null) {
          onStoreChange();
        } else {
          const batch2 = d.batch;
          seam.runWithLane(batch2.key, () => store.force?.());
        }
      });
      for (const b of pendingBatchesFor(x)) {
        seam.runWithLane(b.key, () => store.force?.());
      }
      return () => {
        handle.dispose();
      };
    }
  };
  return store;
}
function resolveAtBoundary(x, v) {
  if (isPendingValue(v)) {
    const pass = renderingPass();
    const batches = pass === null ? [] : pass.batches;
    if (batches.length === 0) {
      const history = settledHistory(x);
      if (history.has) {
        return history.value;
      }
    }
    throw retryThenable(x, batches);
  }
  if (v instanceof AsyncError) {
    throw v;
  }
  return v;
}
function useValue(x) {
  const [, force] = React.useReducer(bump, 0);
  const store = React.useMemo(() => makeStore(x), [x]);
  store.force = force;
  const pass = renderingPass();
  if (pass !== null) {
    store.root = pass.root;
  }
  const v = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (tracing()) {
    emit("render", { tid: debugId(x) }, store.lastDeliveryEvent || void 0);
  }
  const shown = resolveAtBoundary(x, v);
  const container = store.root?.containerInfo;
  React.useEffect(() => {
    reportCommittedValue(container, x, shown);
  });
  return shown;
}
function useComputed(fn, deps) {
  const c = React.useMemo(() => computed(() => fn()), deps);
  return useValue(c);
}
function useSignalEffect(fn) {
  const ref = React.useRef(fn);
  ref.current = fn;
  React.useEffect(() => effect(() => ref.current()), []);
}
function useIsPending(x) {
  const store = React.useMemo(
    () => ({
      subscribe: (cb) => onPendingFlip(cb),
      getSnapshot: () => isPending(x)
    }),
    [x]
  );
  return React.useSyncExternalStore(store.subscribe, store.getSnapshot);
}
function useCommitted(x) {
  const rootRef = React.useRef(null);
  const pass = renderingPass();
  if (pass !== null) {
    rootRef.current = pass.root;
  }
  const store = React.useMemo(
    () => ({
      subscribe(cb) {
        const offCommit = onRootCommit(cb);
        const sub = subscribe(x, () => cb());
        return () => {
          offCommit();
          sub.dispose();
        };
      },
      getSnapshot: () => committed(x, rootRef.current?.containerInfo)
    }),
    [x]
  );
  return React.useSyncExternalStore(store.subscribe, store.getSnapshot);
}
function useAtom(initial, options) {
  return React.useMemo(() => atom(initial, options), []);
}
function startTransitionWrite(scope) {
  React.startTransition(() => {
    scope();
  });
}
var bump;
var init_hooks = __esm({
  "src/hooks.ts"() {
    "use strict";
    init_src();
    init_runtime();
    bump = (c) => c + 1;
  }
});

// src/trace.ts
function traceView(options) {
  const tracer = attachTracer(options);
  return {
    whyLastDelivery(x) {
      const tid = debugId(x);
      const hit = tracer.last(
        (e) => (e.kind === "render" || e.kind === "deliver") && e.data?.tid === tid
      );
      if (hit === void 0) {
        return [];
      }
      return tracer.explain(hit.id);
    },
    events: () => tracer.events().map((e) => e.cause === void 0 ? { id: e.id, kind: e.kind } : { id: e.id, kind: e.kind, cause: e.cause }),
    dropped: () => tracer.dropped(),
    stop: () => tracer.stop()
  };
}
var init_trace = __esm({
  "src/trace.ts"() {
    "use strict";
    init_src();
  }
});

// src/index.ts
var src_exports2 = {};
__export(src_exports2, {
  getSeam: () => getSeam,
  onDomMutation: () => onDomMutation,
  registerReactSignals: () => registerReactSignals,
  resetReactSignalsForTest: () => resetReactSignalsForTest,
  startTransitionWrite: () => startTransitionWrite,
  traceView: () => traceView,
  useAtom: () => useAtom,
  useCommitted: () => useCommitted,
  useComputed: () => useComputed,
  useIsPending: () => useIsPending,
  useSignalEffect: () => useSignalEffect,
  useValue: () => useValue
});
var init_src2 = __esm({
  "src/index.ts"() {
    "use strict";
    init_runtime();
    init_hooks();
    init_trace();
  }
});

// bench/child-entry.mjs
import { JSDOM } from "jsdom";
var dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.MutationObserver = dom.window.MutationObserver;
var React2 = await import("react");
var { createRoot } = await import("react-dom/client");
var royale = await Promise.resolve().then(() => (init_src2(), src_exports2));
var engine = await Promise.resolve().then(() => (init_src(), src_exports));
var SCENARIO = process.env.BENCH_SCENARIO;
var CONTENDER = process.env.BENCH_CONTENDER;
var tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function p95(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}
function makeStore2(n) {
  if (CONTENDER === "royale-fh2") {
    royale.registerReactSignals();
    const cells = Array.from({ length: n }, () => engine.atom(0));
    return {
      useCell: (i) => royale.useValue(cells[i]),
      write: (i, v) => engine.set(cells[i], v),
      writeAllInTransition: (v) => {
        royale.startTransitionWrite(() => {
          for (let i = 0; i < n; i++) {
            engine.set(cells[i], v);
          }
        });
      }
    };
  }
  const values = new Array(n).fill(0);
  const listeners = Array.from({ length: n }, () => /* @__PURE__ */ new Set());
  const subscribe2 = (i) => (cb) => {
    listeners[i].add(cb);
    return () => listeners[i].delete(cb);
  };
  const subs = Array.from({ length: n }, (_, i) => subscribe2(i));
  const notify2 = (i) => {
    for (const cb of listeners[i]) {
      cb();
    }
  };
  return {
    useCell: (i) => React2.useSyncExternalStore(subs[i], () => values[i]),
    write: (i, v) => {
      values[i] = v;
      notify2(i);
    },
    writeAllInTransition: (v) => {
      React2.startTransition(() => {
        for (let i = 0; i < n; i++) {
          values[i] = v;
          notify2(i);
        }
      });
    }
  };
}
function makeTree(store, n, withInput) {
  const Cell = ({ i }) => React2.createElement("span", null, store.useCell(i));
  const MemoCell = React2.memo(Cell);
  let setUrgentRef = { current: null };
  function Input() {
    const [v, setV] = React2.useState(0);
    setUrgentRef.current = setV;
    return React2.createElement("b", { id: "urgent" }, v);
  }
  function App() {
    const kids = [];
    if (withInput) {
      kids.push(React2.createElement(Input, { key: "input" }));
    }
    for (let i = 0; i < n; i++) {
      kids.push(React2.createElement(MemoCell, { key: i, i }));
    }
    return React2.createElement("div", null, kids);
  }
  return { App, setUrgentRef };
}
async function waitFor(pred, timeoutMs = 3e4) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) {
      throw new Error("timeout waiting for commit");
    }
    await tick(0);
  }
}
var out = (stat, ms) => console.log(`${SCENARIO},${CONTENDER},${stat},${ms.toFixed(3)}`);
if (SCENARIO === "fanout") {
  const N = 5e3;
  const store = makeStore2(N);
  const { App } = makeTree(store, N, false);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React2.createElement(App));
  await waitFor(() => container.querySelectorAll("span").length === N);
  const spans = container.querySelectorAll("span");
  const lat = [];
  for (let k = 0; k < 200; k++) {
    const i = k * 25 % N;
    const v = String(k + 1);
    const t0 = performance.now();
    store.write(i, k + 1);
    await waitFor(() => spans[i].textContent === v);
    lat.push(performance.now() - t0);
  }
  out("write-to-commit-median", median(lat));
  root.unmount();
} else if (SCENARIO === "transition") {
  const N = 2e3;
  const store = makeStore2(N);
  const { App, setUrgentRef } = makeTree(store, N, true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React2.createElement(App));
  await waitFor(() => container.querySelectorAll("span").length === N);
  const urgentEl = () => container.querySelector("#urgent");
  const lat = [];
  const t0 = performance.now();
  let started = false;
  for (let j = 1; j <= 30; j++) {
    if (j === 3 && !started) {
      started = true;
      store.writeAllInTransition(7);
    }
    const t1 = performance.now();
    setUrgentRef.current(j);
    await waitFor(() => urgentEl().textContent === String(j));
    lat.push(performance.now() - t1);
    const wait = 16 - (performance.now() - t1);
    if (wait > 0) {
      await tick(wait);
    }
  }
  await waitFor(() => container.querySelectorAll("span")[0].textContent === "7");
  console.error(`# ${CONTENDER} transition completed in ${(performance.now() - t0).toFixed(1)}ms`);
  console.error(`# ${CONTENDER} urgent latencies: ${lat.map((x) => x.toFixed(1)).join(" ")}`);
  out("urgent-p95", p95(lat));
  root.unmount();
} else if (SCENARIO === "mount") {
  const N = 5e3;
  const times = [];
  for (let r = 0; r < 5; r++) {
    const store = makeStore2(N);
    const { App } = makeTree(store, N, false);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const t0 = performance.now();
    root.render(React2.createElement(App));
    await waitFor(() => container.querySelectorAll("span").length === N);
    times.push(performance.now() - t0);
    root.unmount();
    container.remove();
  }
  out("mount-median", median(times));
} else {
  throw new Error(`unknown scenario ${SCENARIO}`);
}
process.exit(0);
