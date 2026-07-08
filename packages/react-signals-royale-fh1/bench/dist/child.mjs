// bench/child.ts
import { JSDOM } from "jsdom";
import * as React3 from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useSyncExternalStore, useState as useState2, startTransition as startTransition2 } from "react";

// ../signals-royale-fh1/src/tracer.ts
var tracing = false;
var events = [];
var ringCap = 0;
var ringStart = 0;
var droppedCount = 0;
var nextId = 1;
var ambientCause = 0;
function emit(kind, label, data) {
  const id = nextId++;
  const ev = { id, kind, cause: ambientCause };
  if (label !== void 0) ev.label = label;
  if (data !== void 0) ev.data = data;
  if (ringCap > 0 && events.length >= ringCap) {
    events[ringStart] = ev;
    ringStart = (ringStart + 1) % ringCap;
    droppedCount++;
  } else {
    events.push(ev);
  }
  return id;
}
function setCause(id) {
  const prev = ambientCause;
  ambientCause = id;
  return prev;
}
function withCause(id, fn) {
  const prev = ambientCause;
  ambientCause = id;
  try {
    return fn();
  } finally {
    ambientCause = prev;
  }
}

// ../signals-royale-fh1/src/engine.ts
var URGENT = 0;
var CLEAN = 0;
var CHECK = 1;
var DIRTY = 2;
var UNSET = /* @__PURE__ */ Symbol("unset");
var writeSeq = 1;
function currentSeq() {
  return writeSeq;
}
var activeSub = null;
var initializing = null;
var activeWorld = null;
var activeWorldEntry = null;
var batchDepth = 0;
var effectQueue = [];
var flushing = false;
var logged = /* @__PURE__ */ new Set();
var liveBatches = /* @__PURE__ */ new Map();
var openWorlds = 0;
var ambientBatch = null;
var stampProvider = () => null;
function setStampProvider(fn) {
  stampProvider = fn ?? (() => null);
}
var writeGuard = null;
function setWriteGuard(fn) {
  writeGuard = fn;
}
function writeBatch() {
  if (ambientBatch !== null && ambientBatch.state === 0) return ambientBatch;
  return stampProvider();
}
var nextBatchId = 1;
var Batch = class {
  id;
  /** 0 live, 1 retired, 2 discarded. */
  state = 0;
  /** Atoms holding drafts of this batch. */
  atoms = /* @__PURE__ */ new Set();
  /** Host-side identity (a React lane); opaque to the engine. */
  meta = null;
  openEv = 0;
  constructor() {
    this.id = nextBatchId++;
    liveBatches.set(this.id, this);
    if (tracing) this.openEv = emit("batch-open", `B${this.id}`);
  }
  /** Run `fn` with writes classified into this batch. */
  run(fn) {
    const prev = ambientBatch;
    ambientBatch = this;
    try {
      return fn();
    } finally {
      ambientBatch = prev;
    }
  }
  /** Replay this batch's drafts onto canonical state, oldest first. */
  retire() {
    if (this.state !== 0) return;
    this.state = 1;
    const retireEv = tracing ? emit("batch-retire", `B${this.id}`) : 0;
    const prevCause = setCause(retireEv);
    startBatch();
    try {
      for (const a of this.atoms) retireAtomBatch(a, this.id);
    } finally {
      this.atoms.clear();
      liveBatches.delete(this.id);
      setCause(prevCause);
      endBatch();
      maybeQuiesce();
    }
  }
  /** Drop this batch's drafts and re-notify anyone who saw them. */
  discard() {
    if (this.state !== 0) return;
    this.state = 2;
    writeSeq++;
    const ev = tracing ? emit("batch-discard", `B${this.id}`) : 0;
    const prevCause = setCause(ev);
    try {
      for (const a of this.atoms) {
        if (a.log !== null) {
          a.log = a.log.filter((r) => r.batch !== this.id);
        }
        pokeHooks(a, this.id, ev);
      }
    } finally {
      this.atoms.clear();
      liveBatches.delete(this.id);
      setCause(prevCause);
      maybeQuiesce();
    }
  }
};
function createBatch() {
  return new Batch();
}
function episodeActive() {
  return liveBatches.size > 0 || openWorlds > 0;
}
function maybeQuiesce() {
  if (episodeActive()) return;
  for (const a of logged) {
    a.hist = null;
    a.log = null;
    a.episodeBase = void 0;
    a.episodeBaseSeq = 0;
  }
  logged.clear();
  for (const s of draftEdgeSources) {
    if (s.draftSubs !== null) pokeTargets -= s.draftSubs.size;
    s.draftSubs = null;
  }
  draftEdgeSources.clear();
}
function valueAt(hist, cutoff) {
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].seq <= cutoff) return hist[i].value;
  }
  return hist[0].value;
}
function recordHist(a) {
  if (!episodeActive()) return;
  if (a.hist === null) {
    a.hist = [{ seq: 0, value: a.v }];
    logged.add(a);
  }
}
var PendingValue = class extends Error {
  constructor(thenable) {
    super("signal value is pending");
    this.thenable = thenable;
    this.name = "PendingValue";
  }
  thenable;
};
var thenRecs = /* @__PURE__ */ new WeakMap();
function thenRecord(t) {
  let rec = thenRecs.get(t);
  if (rec === void 0) {
    const owner = activeWorld !== null && activeWorld.batches.length > 0 ? activeWorld.batches[0] : writeBatch()?.id ?? URGENT;
    rec = { status: 0, value: void 0, reason: void 0, box: new PendingValue(t), owner, waiters: /* @__PURE__ */ new Set() };
    thenRecs.set(t, rec);
    const r = rec;
    t.then(
      (v) => settleThenable(r, 1, v),
      (e) => settleThenable(r, 2, e)
    );
  }
  return rec;
}
function settleThenable(rec, status, val) {
  if (rec.status !== 0) return;
  rec.status = status;
  if (status === 1) rec.value = val;
  else rec.reason = val;
  writeSeq++;
  const ev = tracing ? emit("settle", void 0, { owner: rec.owner, status }) : 0;
  const prevCause = setCause(ev);
  startBatch();
  try {
    for (const c of rec.waiters) {
      if (c.pend === rec.box) {
        c.state = DIRTY;
        markObs(c, CHECK);
      }
      pokeHooks(c, rec.owner, ev);
    }
  } finally {
    rec.waiters.clear();
    setCause(prevCause);
    endBatch();
  }
}
var World = class {
  cutoff;
  batches;
  /** Computeds holding a cached evaluation for this world, for release. */
  touched = null;
  released = false;
  constructor(batches, cutoff = writeSeq) {
    this.cutoff = cutoff;
    this.batches = batches;
    openWorlds++;
  }
  release() {
    if (this.released) return;
    this.released = true;
    openWorlds--;
    if (this.touched !== null) {
      for (const c of this.touched) releaseWorldEntry(c, this);
      this.touched = null;
    }
    maybeQuiesce();
  }
};
function refEq(a, b) {
  return Object.is(a, b);
}
var Atom = class {
  k = 0;
  label;
  eq;
  /** Canonical value. Meaningless until `inited`. */
  v = void 0;
  ver = 0;
  inited;
  init;
  hist = null;
  /** Interleaved updater log; non-null exactly while deferred drafts target
   * this atom (and until quiescence reclaims it). */
  log = null;
  /** Canonical value and seq when the log opened: the replay base. */
  episodeBase = void 0;
  episodeBaseSeq = 0;
  obs = [];
  obSlots = [];
  hookSubs = null;
  draftSubs = null;
  onObserved;
  obCleanup = null;
  pokedAt = 0;
  lastDeliveryEv = 0;
  constructor(initial, opts) {
    this.eq = opts?.equals ?? refEq;
    this.label = opts?.label;
    this.onObserved = opts?.effect;
    if (typeof initial === "function") {
      this.init = initial;
      this.inited = false;
    } else {
      this.v = initial;
      this.init = null;
      this.inited = true;
    }
  }
  get() {
    if (activeWorld !== null) return foldAtom(this, activeWorld);
    materialize(this);
    trackRead(this);
    return this.v;
  }
  peek() {
    materialize(this);
    return this.v;
  }
  set(v) {
    writeAtom(this, null, v);
  }
  update(fn) {
    writeAtom(this, fn, void 0);
  }
};
function materialize(a) {
  if (a.inited) return;
  a.inited = true;
  const init = a.init;
  a.init = null;
  const prevSub = activeSub;
  const prevInit = initializing;
  activeSub = null;
  initializing = a;
  try {
    a.v = init();
  } finally {
    activeSub = prevSub;
    initializing = prevInit;
  }
}
function writeAtom(a, fn, v) {
  if (initializing !== null) {
    throw new Error("a lazy initializer must not write to signals");
  }
  if (writeGuard !== null) writeGuard();
  const b = writeBatch();
  materialize(a);
  const apply = fn === null ? () => v : fn;
  if (b === null) {
    const next = fn === null ? v : fn(a.v);
    if (a.log !== null) {
      a.log.push({ batch: URGENT, seq: ++writeSeq, apply, folded: 0 });
      if (a.eq(a.v, next)) {
        const ev = tracing ? emit("write", a.label, { batch: URGENT }) : 0;
        pokeHooks(a, URGENT, ev);
        return;
      }
    } else if (a.eq(a.v, next)) {
      return;
    }
    applyCanonical(a, next, URGENT);
    flushEffects();
  } else {
    if (a.log === null) {
      a.log = [];
      a.episodeBase = a.v;
      a.episodeBaseSeq = writeSeq;
    }
    a.log.push({ batch: b.id, seq: ++writeSeq, apply, folded: 0 });
    b.atoms.add(a);
    logged.add(a);
    const ev = tracing ? emit("write", a.label, { batch: b.id, draft: true }) : 0;
    pokeHooks(a, b.id, ev);
  }
}
function applyCanonical(a, next, stamp) {
  recordHist(a);
  a.v = next;
  a.ver++;
  const seq = ++writeSeq;
  if (a.hist !== null) a.hist.push({ seq, value: next });
  const ev = tracing ? emit("write", a.label, { batch: stamp }) : 0;
  startBatch();
  try {
    markObs(a, CHECK);
    pokeHooks(a, stamp, ev);
  } finally {
    endBatch();
  }
}
function retireAtomBatch(a, bid) {
  const log = a.log;
  if (log === null) return;
  let any = false;
  for (const r of log) {
    if (r.batch === bid && r.folded === 0) {
      r.folded = writeSeq + 1;
      any = true;
    }
  }
  if (!any) return;
  let v = a.episodeBase;
  for (const r of log) {
    if (r.batch === URGENT || r.folded !== 0) v = r.apply(v);
  }
  if (!a.eq(a.v, v)) {
    applyCanonical(a, v, bid);
  } else {
    pokeHooks(a, URGENT, 0);
  }
}
function foldAtom(a, w) {
  materialize(a);
  let v;
  const log = a.log;
  if (log === null || w.batches.length === 0) {
    v = a.v;
    if (a.hist !== null && a.hist.length > 0 && a.hist[a.hist.length - 1].seq > w.cutoff) {
      v = valueAt(a.hist, w.cutoff);
    }
  } else if (w.cutoff < a.episodeBaseSeq) {
    v = a.hist !== null ? valueAt(a.hist, w.cutoff) : a.episodeBase;
    for (const r of log) {
      if (r.batch !== URGENT && w.batches.indexOf(r.batch) >= 0) v = r.apply(v);
    }
  } else {
    v = a.episodeBase;
    for (const r of log) {
      const visible = r.batch === URGENT ? r.seq <= w.cutoff : r.folded !== 0 && r.folded <= w.cutoff || w.batches.indexOf(r.batch) >= 0;
      if (visible) v = r.apply(v);
    }
  }
  if (activeWorldEntry !== null) recordWorldDep(a, v);
  return v;
}
function isLive(n) {
  if (n.k === 2) return !n.disposed;
  return n.obs.length > 0 || n.hookSubs !== null && n.hookSubs.size > 0;
}
function linkBack(src, sub, i) {
  sub.srcSlots[i] = src.obs.length;
  src.obs.push(sub);
  src.obSlots.push(i);
  if (src.obs.length === 1) {
    if (src.k === 1) activate(src);
    else observedMaybeChanged(src);
  }
}
var deferredStack = [];
var deferredDepth = 0;
function unlinkBack(src, sub, i) {
  const slot = sub.srcSlots[i];
  if (slot < 0) return;
  sub.srcSlots[i] = -1;
  const lastObs = src.obs.pop();
  const lastSlot = src.obSlots.pop();
  if (slot < src.obs.length) {
    src.obs[slot] = lastObs;
    src.obSlots[slot] = lastSlot;
    lastObs.srcSlots[lastSlot] = slot;
  }
  if (src.obs.length === 0) {
    if (deferredDepth > 0) {
      deferredStack.push(src);
    } else {
      settleUnobserved(src);
    }
  }
}
function settleUnobserved(src) {
  if (src.obs.length !== 0) return;
  if (src.k === 1) {
    if (src.hookSubs === null || src.hookSubs.size === 0) deactivate(src);
  } else {
    observedMaybeChanged(src);
  }
}
function activate(c) {
  const srcs = c.srcs;
  for (let i = 0; i < srcs.length; i++) linkBack(srcs[i], c, i);
  c.state = c.checked === writeSeq && c.ver !== 0 ? CLEAN : CHECK;
}
function deactivate(c) {
  const srcs = c.srcs;
  for (let i = 0; i < srcs.length; i++) unlinkBack(srcs[i], c, i);
  c.checked = 0;
  c.state = CHECK;
}
function trackRead(src) {
  const sub = activeSub;
  if (sub === null) return;
  const i = sub.trackCursor;
  const srcs = sub.srcs;
  if (i < srcs.length) {
    if (srcs[i] === src) {
      sub.srcVers[i] = src.k === 0 ? src.v : src.ver;
      sub.trackCursor = i + 1;
      return;
    }
    trimSourcesFrom(sub, i);
  }
  sub.trackCursor = i + 1;
  srcs.push(src);
  sub.srcVers.push(src.k === 0 ? src.v : src.ver);
  sub.srcSlots.push(-1);
  if (sub.k === 2 || isLive(sub)) linkBack(src, sub, i);
}
function trimSourcesFrom(sub, from) {
  const srcs = sub.srcs;
  for (let j = from; j < srcs.length; j++) {
    if (sub.srcSlots[j] >= 0) unlinkBack(srcs[j], sub, j);
  }
  srcs.length = from;
  sub.srcVers.length = from;
  sub.srcSlots.length = from;
}
function markObs(source, state) {
  const obs = source.obs;
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i];
    if (o.k === 2) {
      if (o.state < state) o.state = state;
      if (!o.queued) {
        o.queued = true;
        effectQueue.push(o);
      }
    } else if (o.state < state) {
      const was = o.state;
      o.state = state;
      if (was === CLEAN) markObs(o, CHECK);
    }
  }
}
function flushEffects() {
  if (flushing || batchDepth > 0) return;
  flushing = true;
  effectQueue.sort((a, b) => a.serial - b.serial);
  try {
    for (let i = 0; i < effectQueue.length; i++) {
      if (i > 1e5) throw new Error("effect flush did not settle (cyclic writes?)");
      try {
        effectQueue[i].maybeRun();
      } catch (e) {
        reportUncaught(e);
      }
    }
  } finally {
    effectQueue.length = 0;
    flushing = false;
  }
}
var pendingError = UNSET;
function reportUncaught(e) {
  if (pendingError === UNSET) pendingError = e;
}
function startBatch() {
  batchDepth++;
}
function endBatch() {
  if (--batchDepth === 0) {
    flushEffects();
    if (pendingError !== UNSET) {
      const e = pendingError;
      pendingError = UNSET;
      throw e;
    }
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
function untracked(fn) {
  const prev = activeSub;
  activeSub = null;
  try {
    return fn();
  } finally {
    activeSub = prev;
  }
}
var pokeEpoch = 0;
var pokeTargets = 0;
function pokeHooks(origin, stamp, causeEv) {
  if (pokeTargets === 0) return;
  const epoch = ++pokeEpoch;
  const prevCause = causeEv !== 0 ? setCause(causeEv) : -1;
  const stack = [origin];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n.pokedAt === epoch) continue;
    n.pokedAt = epoch;
    if (n.hookSubs !== null && n.hookSubs.size > 0) {
      const ev = tracing ? emit("delivery", n.label, { batch: stamp }) : 0;
      n.lastDeliveryEv = ev;
      const prevCause2 = ev !== 0 ? setCause(ev) : -1;
      for (const cb of [...n.hookSubs]) cb(stamp, ev);
      if (prevCause2 !== -1) setCause(prevCause2);
    }
    const obs = n.obs;
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      if (o.k === 1) stack.push(o);
    }
    if (n.draftSubs !== null) {
      for (const c of n.draftSubs) stack.push(c);
    }
  }
  if (prevCause !== -1) setCause(prevCause);
}
function subscribeHook(xx, cb) {
  const x = xx;
  const wasLive = x.k === 1 && isLive(x);
  (x.hookSubs ??= /* @__PURE__ */ new Set()).add(cb);
  pokeTargets++;
  if (x.k === 1) {
    if (!wasLive && x.obs.length === 0) activate(x);
  } else {
    observedMaybeChanged(x);
  }
  return () => {
    if (x.hookSubs === null || !x.hookSubs.has(cb)) return;
    x.hookSubs.delete(cb);
    pokeTargets--;
    if (x.hookSubs.size === 0) {
      if (x.k === 1) {
        if (x.obs.length === 0) deactivate(x);
      } else {
        observedMaybeChanged(x);
      }
    }
  };
}
var observedDirty = /* @__PURE__ */ new Set();
var observedScheduled = false;
function observedMaybeChanged(node) {
  if (node.k !== 0) return;
  if (node.onObserved === void 0) return;
  observedDirty.add(node);
  if (!observedScheduled) {
    observedScheduled = true;
    queueMicrotask(settleObserved);
  }
}
function settleObserved() {
  observedScheduled = false;
  for (const a of observedDirty) {
    const wanted = a.obs.length > 0 || a.hookSubs !== null && a.hookSubs.size > 0;
    if (wanted && a.obCleanup === null) {
      materialize(a);
      const ctx = {
        get: () => untracked(() => a.get()),
        set: (v) => a.set(v)
      };
      a.obCleanup = a.onObserved(ctx) ?? noopCleanup;
      if (tracing) emit("observe", a.label);
    } else if (!wanted && a.obCleanup !== null) {
      const cleanup = a.obCleanup;
      a.obCleanup = null;
      if (cleanup !== noopCleanup) cleanup();
      if (tracing) emit("unobserve", a.label);
    }
  }
  observedDirty.clear();
}
function noopCleanup() {
}
var activeUseEpoch = 0;
function makeUse(c, entry) {
  return ((a, factory) => {
    const epochVal = activeUseEpoch;
    let t;
    if (factory !== void 0) {
      const epochCache = c.useCache ??= /* @__PURE__ */ new Map();
      let cache = epochCache.get(epochVal);
      if (cache === void 0) {
        cache = /* @__PURE__ */ new Map();
        epochCache.set(epochVal, cache);
      }
      let ue = cache.get(a);
      if (ue === void 0) {
        const made = untracked(factory);
        if (typeof made?.then !== "function") {
          ue = { thenable: null, value: made, settled: true };
          cache.set(a, ue);
          return made;
        }
        ue = { thenable: made, value: void 0, settled: false };
        cache.set(a, ue);
      }
      if (ue.thenable === null) return ue.value;
      t = ue.thenable;
    } else {
      t = a;
    }
    const rec = thenRecord(t);
    if (rec.status === 1) return rec.value;
    if (rec.status === 2) throw rec.reason;
    rec.waiters.add(c);
    throw rec.box;
  });
}
var draftEdgeSources = /* @__PURE__ */ new Set();
var activeWorldConsumer = null;
function recordWorldDep(src, token) {
  const entry = activeWorldEntry;
  entry.deps.push(src);
  entry.depVals.push(token);
  const consumer = activeWorldConsumer;
  if (consumer !== null && consumer !== src) {
    const subs = src.draftSubs ??= /* @__PURE__ */ new Set();
    if (!subs.has(consumer)) {
      subs.add(consumer);
      pokeTargets++;
    }
    draftEdgeSources.add(src);
  }
}
function worldToken(src, w) {
  if (src.k === 0) return foldAtom(src, w);
  try {
    return readComputedInWorld(src, w);
  } catch (e) {
    return e;
  }
}
function worldDepsMatch(entry, w) {
  if (entry.validAt < 0) return false;
  if (entry.pend !== null && thenRecord(entry.pend.thenable).status !== 0) return false;
  const prevEntry = activeWorldEntry;
  activeWorldEntry = null;
  try {
    for (let i = 0; i < entry.deps.length; i++) {
      if (!Object.is(worldToken(entry.deps[i], w), entry.depVals[i])) return false;
    }
  } finally {
    activeWorldEntry = prevEntry;
  }
  return true;
}
function readComputedInWorld(c, w) {
  let entry;
  if (c.wc !== null) {
    for (const e of c.wc) {
      if (e.w === w) {
        entry = e;
        break;
      }
    }
  }
  if (entry !== void 0 && entry.validAt === writeSeq) return worldOutcome(c, entry);
  if (entry !== void 0 && worldDepsMatch(entry, w)) {
    entry.validAt = writeSeq;
    return worldOutcome(c, entry);
  }
  if (entry === void 0) {
    entry = {
      w,
      v: void 0,
      err: UNSET,
      pend: null,
      deps: [],
      depVals: [],
      validAt: 0,
      uses: null
    };
    (c.wc ??= []).push(entry);
    (w.touched ??= /* @__PURE__ */ new Set()).add(c);
  } else {
    entry.deps.length = 0;
    entry.depVals.length = 0;
    entry.err = UNSET;
    entry.pend = null;
  }
  evaluateWorldEntry(c, w, entry);
  return worldOutcome(c, entry);
}
function evaluateWorldEntry(c, w, entry) {
  const prevEntry = activeWorldEntry;
  const prevWorld = activeWorld;
  const prevSub = activeSub;
  const prevConsumer = activeWorldConsumer;
  activeWorldEntry = entry;
  activeWorld = w;
  activeSub = null;
  activeWorldConsumer = c;
  try {
    activeUseEpoch = c.epoch !== null ? foldAtom(c.epoch, w) : 0;
    entry.v = c.fn(makeUse(c, entry));
  } catch (e) {
    if (e instanceof PendingValue) entry.pend = e;
    else entry.err = e;
  } finally {
    activeWorldEntry = prevEntry;
    activeWorld = prevWorld;
    activeSub = prevSub;
    activeWorldConsumer = prevConsumer;
    entry.validAt = writeSeq;
  }
}
function worldOutcome(c, entry) {
  if (activeWorldEntry !== null) {
    const token = entry.err !== UNSET ? entry.err : entry.pend !== null ? entry.pend : entry.v;
    recordWorldDep(c, token);
  }
  if (entry.err !== UNSET) throw entry.err;
  if (entry.pend !== null) throw entry.pend;
  return entry.v;
}
function releaseWorldEntry(c, w) {
  if (c.wc === null) return;
  c.wc = c.wc.filter((e) => e.w !== w);
  if (c.wc.length === 0) c.wc = null;
}
function readInWorld(xx, w) {
  const x = xx;
  if (x.k === 0) return foldAtom(x, w);
  return readComputedInWorld(x, w);
}
function makeWorld(batches) {
  return new World(batches);
}
function read(x) {
  return x.get();
}
var committedCutoffProvider = () => writeSeq;
function setCommittedCutoffProvider(fn) {
  committedCutoffProvider = fn ?? (() => writeSeq);
}
function hasSettled(xx) {
  const x = xx;
  return x.k === 1 && x.settled !== UNSET;
}
function lastSettled(xx) {
  const x = xx;
  return x.k === 1 && x.settled !== UNSET ? x.settled : void 0;
}

// ../signals-royale-fh1/src/index.ts
function atom(initial, opts) {
  return new Atom(initial, opts);
}

// src/seam.ts
import * as React from "react";
function internalsOf(react) {
  const r = react;
  const internals = r.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ?? r.__CLIENT_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  if (internals === void 0) {
    throw new Error("react-signals-royale-fh1: this React build exposes no client internals");
  }
  return internals;
}
var host = null;
function getHost() {
  if (host === null) {
    throw new Error(
      "react-signals-royale-fh1: register() has not run \u2014 call register() before rendering"
    );
  }
  return host;
}
function register() {
  if (host !== null) {
    installProviders(host);
    return host;
  }
  const internals = internalsOf(React);
  const seam = internals.signalSeam;
  if (seam === void 0 || typeof seam !== "object" || seam === null) {
    throw new Error(
      "react-signals-royale-fh1: this React build does not implement the signal seam. Build React from the patches/ series in this package (see build.sh)."
    );
  }
  const h = {
    seam,
    internals,
    batchByLane: /* @__PURE__ */ new Map(),
    batchRoots: /* @__PURE__ */ new WeakMap(),
    worldByRoot: /* @__PURE__ */ new Map(),
    commitCutoffByRoot: /* @__PURE__ */ new Map(),
    mutationSubs: /* @__PURE__ */ new Set(),
    committedProbes: /* @__PURE__ */ new Map(),
    errors: []
  };
  seam.runtime = {
    onPassStart(container, lanes) {
      const prev = h.worldByRoot.get(container);
      if (prev !== void 0) prev.release();
      if (lanes === 0) {
        h.worldByRoot.delete(container);
        return;
      }
      const ids = [];
      for (const [lane, b] of h.batchByLane) {
        if ((lane & lanes) !== 0) ids.push(b.id);
      }
      h.worldByRoot.set(container, makeWorld(ids));
      if (tracing) emit("pass-start", void 0, { batches: ids });
    },
    onRootUpdated(container, lanes) {
      for (const [lane, b] of h.batchByLane) {
        if ((lane & lanes) !== 0) {
          let roots = h.batchRoots.get(b);
          if (roots === void 0) {
            roots = /* @__PURE__ */ new Set();
            h.batchRoots.set(b, roots);
          }
          roots.add(container);
        }
      }
    },
    onCommit(container, committedLanes, remainingLanes) {
      const commitEv = tracing ? emit("root-commit") : 0;
      const prevCause = commitEv !== 0 ? setCause(commitEv) : -1;
      try {
        for (const [lane, b] of [...h.batchByLane]) {
          if ((lane & committedLanes) !== 0) {
            h.batchByLane.delete(lane);
            b.retire();
          } else if ((lane & remainingLanes) === 0) {
            const roots = h.batchRoots.get(b);
            if (roots !== void 0 && roots.has(container)) {
              roots.delete(container);
              if (roots.size === 0) {
                h.batchByLane.delete(lane);
                b.discard();
              }
            }
          }
        }
      } finally {
        if (prevCause !== -1) setCause(prevCause);
      }
      h.commitCutoffByRoot.set(container, currentSeq());
      const world = h.worldByRoot.get(container);
      if (world !== void 0) {
        world.release();
        h.worldByRoot.delete(container);
        if (tracing) emit("pass-end", void 0, { disposition: "commit" });
      }
      const probes = h.committedProbes.get(container);
      if (probes !== void 0) {
        for (const probe of [...probes]) probe();
      }
    },
    onMutation(container, active) {
      for (const cb of [...h.mutationSubs]) {
        cb(active ? "start" : "stop", container);
      }
    }
  };
  installProviders(h);
  host = h;
  return h;
}
function installProviders(h) {
  setStampProvider(() => {
    const lane = h.seam.getWriteLane === null ? 0 : h.seam.getWriteLane();
    if (lane === 0) return null;
    let b = h.batchByLane.get(lane);
    if (b === void 0) {
      b = createBatch();
      b.meta = lane;
      h.batchByLane.set(lane, b);
      scheduleBatchProbe(h, b, lane);
    }
    return b;
  });
  setWriteGuard(() => {
    if (h.seam.getRenderContainer !== null && h.seam.getRenderContainer() !== null) {
      throw new Error(
        "react-signals-royale-fh1: writing a signal during render is not allowed. Move the write into an event handler or an effect."
      );
    }
  });
  setCommittedCutoffProvider((container) => {
    if (container !== void 0) {
      return h.commitCutoffByRoot.get(container) ?? currentSeq();
    }
    return currentSeq();
  });
}
function scheduleBatchProbe(h, b, lane) {
  queueMicrotask(() => {
    queueMicrotask(() => {
      if (b.state !== 0) return;
      const roots = h.batchRoots.get(b);
      if (roots === void 0 || roots.size === 0) {
        h.batchByLane.delete(lane);
        b.retire();
      }
    });
  });
}
function currentRenderWorld() {
  const h = host;
  if (h === null || h.seam.getRenderContainer === null) return null;
  const container = h.seam.getRenderContainer();
  if (container === null) return null;
  return h.worldByRoot.get(container) ?? null;
}
function runInBatch(b, fn) {
  const h = getHost();
  const lane = b.meta;
  if (b.state !== 0 || lane === null || lane === 0) {
    runUrgent(fn);
    return;
  }
  const prev = h.seam.pinnedTransitionLane;
  h.seam.pinnedTransitionLane = lane;
  try {
    React.startTransition(() => b.run(fn));
  } finally {
    h.seam.pinnedTransitionLane = prev;
  }
}
function runUrgent(fn) {
  const h = getHost();
  const prevT = h.internals.T;
  h.internals.T = null;
  try {
    fn();
  } finally {
    h.internals.T = prevT;
  }
}
function startTransitionWrite(scope) {
  React.startTransition(scope);
}

// src/hooks.ts
import * as React2 from "react";
var bump = (c) => c + 1;
var JOIN_PENDING = /* @__PURE__ */ Symbol("join-pending");
function useValue(x) {
  const [, force] = React2.useReducer(bump, 0);
  const world = currentRenderWorld();
  let value;
  try {
    value = world !== null ? readInWorld(x, world) : untracked(() => read(x));
  } catch (e) {
    if (e instanceof PendingValue) {
      if (world !== null && world.batches.length > 0) throw e.thenable;
      if (hasSettled(x)) value = lastSettled(x);
      else throw e.thenable;
    } else {
      throw e;
    }
  }
  const box = React2.useRef(null);
  if (box.current === null) box.current = { value, committedValue: value, deliveryEv: 0 };
  box.current.value = value;
  React2.useLayoutEffect(() => {
    box.current.committedValue = box.current.value;
  });
  if (tracing && box.current.deliveryEv !== 0) {
    const ev = box.current.deliveryEv;
    box.current.deliveryEv = 0;
    withCause(ev, () => emit("component-render"));
  }
  React2.useEffect(() => {
    const state = box.current;
    const poke = (stamp, ev) => {
      state.deliveryEv = ev;
      if (stamp !== 0) {
        if (liveBatches.get(stamp)?.state === 0) force();
        return;
      }
      let canonical2;
      try {
        canonical2 = untracked(() => read(x));
      } catch (e) {
        canonical2 = e instanceof PendingValue && hasSettled(x) ? lastSettled(x) : state.committedValue;
      }
      if (!Object.is(canonical2, state.committedValue)) force();
    };
    const unsub = subscribeHook(x, poke);
    let canonical;
    try {
      canonical = untracked(() => read(x));
    } catch (e) {
      canonical = e instanceof PendingValue && hasSettled(x) ? lastSettled(x) : state.value;
    }
    if (!Object.is(canonical, state.value)) force();
    for (const b of liveBatches.values()) {
      const w = makeWorld([b.id]);
      let inBatch;
      try {
        inBatch = readInWorld(x, w);
      } catch {
        inBatch = JOIN_PENDING;
      } finally {
        w.release();
      }
      if (!Object.is(inBatch, canonical)) {
        runInBatch(b, () => force());
      }
    }
    return unsub;
  }, [x]);
  return value;
}

// bench/child.ts
var dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
var g = globalThis;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
g.Element = dom.window.Element;
g.HTMLElement = dom.window.HTMLElement;
g.MutationObserver = dom.window.MutationObserver;
var [, , scenario, contender] = process.argv;
if (process.env.BENCH_PROBE) {
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    if (now - last > 20) process.stderr.write(`# block ${(now - last).toFixed(0)}ms at ${now.toFixed(0)}
`);
    last = now;
  }, 4).unref();
}
function royaleStore(n) {
  const host2 = register();
  if (process.env.BENCH_PROBE) {
    const rt = host2.seam.runtime;
    for (const k of ["onPassStart", "onCommit"]) {
      const orig = rt[k].bind(rt);
      rt[k] = (...args) => {
        process.stderr.write(`# ${k} lanes=${String(args[1])} rem=${String(args[2] ?? "")} at ${performance.now().toFixed(0)}
`);
        orig(...args);
      };
    }
  }
  const cells = [];
  for (let i = 0; i < n; i++) cells.push(atom(0));
  return {
    useCell: (i) => useValue(cells[i]),
    write: (i, v) => cells[i].set(v),
    writeManyInTransition(updates) {
      startTransitionWrite(() => {
        batch(() => {
          for (const [i, v] of updates) cells[i].set(v);
        });
      });
    }
  };
}
function baselineStore(n) {
  const values = new Array(n).fill(0);
  const subs = /* @__PURE__ */ new Set();
  const notify = () => {
    for (const cb of [...subs]) cb();
  };
  return {
    useCell(i) {
      return useSyncExternalStore(
        (cb) => {
          subs.add(cb);
          return () => subs.delete(cb);
        },
        () => values[i]
      );
    },
    write(i, v) {
      values[i] = v;
      notify();
    },
    writeManyInTransition(updates) {
      startTransition2(() => {
        for (const [i, v] of updates) values[i] = v;
        notify();
      });
    }
  };
}
var makeStore = contender === "royale-fh1" ? royaleStore : baselineStore;
var tick = () => new Promise((r) => setImmediate(r));
async function until(pred, ms = 3e4) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timeout waiting for commit");
    await tick();
  }
}
function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return {
    median: s[Math.floor(s.length / 2)],
    p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]
  };
}
function row(stat, ms) {
  process.stdout.write(`${scenario},${contender},${stat},${ms.toFixed(3)}
`);
}
function mountTree(store, n) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  function Cell({ i }) {
    return React3.createElement("i", null, store.useCell(i));
  }
  const kids = [];
  for (let i = 0; i < n; i++) kids.push(React3.createElement(Cell, { i, key: i }));
  root.render(React3.createElement("div", null, kids));
  return {
    container,
    unmount() {
      root.unmount();
      container.remove();
    }
  };
}
async function fanout() {
  const N = 5e3;
  const store = makeStore(N);
  const { container, unmount } = mountTree(store, N);
  await until(() => container.querySelectorAll("i").length === N);
  const cells = container.querySelectorAll("i");
  const lat = [];
  for (let w = 0; w < 200; w++) {
    const i = w * 37 % N;
    const v = w + 1;
    const t0 = performance.now();
    store.write(i, v);
    await until(() => cells[i].textContent === String(v));
    lat.push(performance.now() - t0);
  }
  row("median-write-to-commit", stats(lat).median);
  unmount();
}
async function transition() {
  const N = 2e3;
  const store = makeStore(N);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let setUrgent;
  function Input() {
    const [u, setU] = useState2(0);
    setUrgent = setU;
    React3.useLayoutEffect(() => {
      if (process.env.BENCH_PROBE) process.stderr.write(`# urgent ${u} committed at ${performance.now().toFixed(0)}
`);
    }, [u]);
    return React3.createElement("b", { id: "urgent" }, u);
  }
  function Cell({ i }) {
    const v = store.useCell(i);
    const end = performance.now() + 0.2;
    while (performance.now() < end) {
    }
    return React3.createElement("i", null, v);
  }
  const kids = [React3.createElement(Input, { key: "u" })];
  for (let i = 0; i < N; i++) kids.push(React3.createElement(Cell, { i, key: i }));
  root.render(React3.createElement("div", null, kids));
  await until(() => container.querySelectorAll("i").length === N);
  const urgentEl = () => container.querySelector("#urgent");
  const updates = [];
  for (let i = 0; i < N; i++) updates.push([i, 7]);
  setTimeout(() => {
    store.writeManyInTransition(updates);
    if (process.env.BENCH_PROBE) {
      const internals = React3.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      process.stderr.write(`# after transition scope: T=${String(internals.T)} pin=${internals.signalSeam?.pinnedTransitionLane} at ${performance.now().toFixed(0)}
`);
    }
  }, 40);
  const lat = [];
  const tStart = performance.now();
  const done = [];
  for (let k = 1; k <= 30; k++) {
    const intended = tStart + 16 * k;
    done.push(
      new Promise((resolve) => {
        setTimeout(
          () => {
            flushSync(() => setUrgent(k));
            void until(() => Number(urgentEl().textContent) >= k).then(() => {
              lat.push(performance.now() - intended);
              resolve();
            });
          },
          Math.max(0, intended - performance.now())
        );
      })
    );
  }
  await Promise.all(done);
  await until(() => container.querySelectorAll("i")[N - 1].textContent === "7", 12e4);
  process.stderr.write(`# transition completed in ${(performance.now() - tStart).toFixed(0)}ms
`);
  row("p95-urgent-during-transition", stats(lat).p95);
  root.unmount();
}
async function mountBench() {
  const N = 5e3;
  const times = [];
  for (let r = 0; r < 5; r++) {
    const store = makeStore(N);
    const t0 = performance.now();
    const { container, unmount } = mountTree(store, N);
    await until(() => container.querySelectorAll("i").length === N);
    times.push(performance.now() - t0);
    unmount();
    await tick();
  }
  row("median-mount", stats(times).median);
}
var scenarios = {
  fanout,
  transition,
  mount: mountBench
};
scenarios[scenario]().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
