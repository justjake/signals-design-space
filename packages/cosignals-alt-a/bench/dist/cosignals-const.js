// src/tracing.ts
var TraceKind = /* @__PURE__ */ ((TraceKind2) => {
  TraceKind2[TraceKind2["ATOM_WRITE"] = 1] = "ATOM_WRITE";
  TraceKind2[TraceKind2["LOG_APPEND"] = 2] = "LOG_APPEND";
  TraceKind2[TraceKind2["LOG_COALESCE"] = 3] = "LOG_COALESCE";
  TraceKind2[TraceKind2["TRUNCATE"] = 4] = "TRUNCATE";
  TraceKind2[TraceKind2["BATCH_RETIRED"] = 5] = "BATCH_RETIRED";
  TraceKind2[TraceKind2["ABSORB"] = 6] = "ABSORB";
  TraceKind2[TraceKind2["COMPUTED_EVAL"] = 7] = "COMPUTED_EVAL";
  TraceKind2[TraceKind2["NOTIFY_WALK"] = 8] = "NOTIFY_WALK";
  TraceKind2[TraceKind2["BROADCAST"] = 9] = "BROADCAST";
  TraceKind2[TraceKind2["RENDER_PASS_START"] = 10] = "RENDER_PASS_START";
  TraceKind2[TraceKind2["RENDER_PASS_END"] = 11] = "RENDER_PASS_END";
  TraceKind2[TraceKind2["SWEEP"] = 12] = "SWEEP";
  TraceKind2[TraceKind2["QUIESCENCE"] = 13] = "QUIESCENCE";
  TraceKind2[TraceKind2["CLOCK_SYNC"] = 14] = "CLOCK_SYNC";
  TraceKind2[TraceKind2["TRUNCATION_MARKER"] = 15] = "TRUNCATION_MARKER";
  return TraceKind2;
})(TraceKind || {});
var TRACE_KIND_NAMES = {
  1: "atom-write",
  2: "log-append",
  3: "log-coalesce",
  4: "truncate",
  5: "batch-retired",
  6: "absorb",
  7: "computed-eval",
  8: "notify-walk",
  9: "broadcast",
  10: "render-pass-start",
  11: "render-pass-end",
  12: "sweep",
  13: "quiescence",
  14: "clock-sync",
  15: "truncation-marker"
};
function createTracer(opts) {
  const isSession = opts.mode === "session";
  const capacity = !isSession ? opts.capacity ?? 1 << 16 : 0;
  const chunkSize = isSession ? opts.chunkSize ?? 1 << 12 : 0;
  const maxBytes = isSession ? opts.maxBytes ?? 64 << 20 : 0;
  if (!isSession && (capacity & capacity - 1) !== 0) {
    throw new Error("tracing: ring capacity must be a power of two");
  }
  if (isSession && (chunkSize & chunkSize - 1) !== 0) {
    throw new Error("tracing: session chunkSize must be a power of two");
  }
  const chunks = [new Int32Array((isSession ? chunkSize : capacity) * 8 /* STRIDE */)];
  const chunkShift = isSession ? Math.log2(chunkSize) : 0;
  let nextId = 0;
  let lastTime = 0;
  let truncatedAtId = -1;
  let currentCause = 0;
  let allocations = 1;
  function emit(kind, node, world, a0 = 0, a1 = 0, a2 = 0) {
    const id = nextId++;
    let buf;
    let pos;
    if (!isSession) {
      buf = chunks[0];
      pos = (id & capacity - 1) * 8 /* STRIDE */;
    } else if (truncatedAtId >= 0) {
      buf = chunks[chunks.length - 1];
      pos = (id & chunkSize - 1) * 8 /* STRIDE */;
    } else {
      const chunkIndex = id >> chunkShift;
      if (chunkIndex >= chunks.length) {
        const nextBytes = (chunks.length + 1) * chunkSize * 8 /* STRIDE */ * 4;
        if (nextBytes > maxBytes) {
          truncatedAtId = id;
          buf = chunks[chunks.length - 1];
          pos = (id & chunkSize - 1) * 8 /* STRIDE */;
          buf[pos + 0 /* F_KIND */] = 15 /* TRUNCATION_MARKER */;
          buf[pos + 1 /* F_CAUSE */] = currentCause;
          buf[pos + 2 /* F_NODE */] = 0;
          buf[pos + 3 /* F_WORLD */] = 0;
          buf[pos + 4 /* F_TIME */] = 0;
          buf[pos + 5 /* F_ARG0 */] = id;
          buf[pos + 6 /* F_ARG1 */] = 0;
          buf[pos + 7 /* F_ARG2 */] = 0;
          return emit(kind, node, world, a0, a1, a2);
        }
        chunks.push(new Int32Array(chunkSize * 8 /* STRIDE */));
        ++allocations;
      }
      buf = chunks[chunkIndex];
      pos = (id & chunkSize - 1) * 8 /* STRIDE */;
    }
    const now = Math.floor(performance.now() * 1e3);
    const delta = lastTime === 0 ? 0 : Math.min(now - lastTime, 2147483646);
    lastTime = now;
    buf[pos + 0 /* F_KIND */] = kind;
    buf[pos + 1 /* F_CAUSE */] = currentCause;
    buf[pos + 2 /* F_NODE */] = node;
    buf[pos + 3 /* F_WORLD */] = world;
    buf[pos + 4 /* F_TIME */] = delta;
    buf[pos + 5 /* F_ARG0 */] = a0;
    buf[pos + 6 /* F_ARG1 */] = a1;
    buf[pos + 7 /* F_ARG2 */] = a2;
    return id;
  }
  function locate(id) {
    if (id < 0 || id >= nextId) {
      return void 0;
    }
    if (!isSession) {
      if (nextId - id > capacity) {
        return void 0;
      }
      return { buf: chunks[0], pos: (id & capacity - 1) * 8 /* STRIDE */ };
    }
    if (truncatedAtId >= 0 && id >= truncatedAtId) {
      const tail = chunks[chunks.length - 1];
      if (nextId - id > chunkSize) {
        return void 0;
      }
      return { buf: tail, pos: (id & chunkSize - 1) * 8 /* STRIDE */ };
    }
    const chunkIndex = id >> chunkShift;
    if (chunkIndex >= chunks.length) {
      return void 0;
    }
    return { buf: chunks[chunkIndex], pos: (id & chunkSize - 1) * 8 /* STRIDE */ };
  }
  function decode(id) {
    const loc = locate(id);
    if (loc === void 0) {
      return void 0;
    }
    const { buf, pos } = loc;
    return {
      id,
      kindCode: buf[pos + 0 /* F_KIND */],
      kind: TRACE_KIND_NAMES[buf[pos + 0 /* F_KIND */]] ?? `kind:${buf[pos + 0 /* F_KIND */]}`,
      cause: buf[pos + 1 /* F_CAUSE */],
      node: buf[pos + 2 /* F_NODE */],
      world: buf[pos + 3 /* F_WORLD */],
      timeDeltaUs: buf[pos + 4 /* F_TIME */],
      args: [buf[pos + 5 /* F_ARG0 */], buf[pos + 6 /* F_ARG1 */], buf[pos + 7 /* F_ARG2 */]]
    };
  }
  return {
    emit,
    decode,
    setCause(id) {
      const prev = currentCause;
      currentCause = id;
      return prev;
    },
    get eventCount() {
      return nextId;
    },
    get dropCount() {
      if (!isSession) {
        return Math.max(0, nextId - capacity);
      }
      return truncatedAtId >= 0 ? Math.max(0, nextId - chunkSize - truncatedAtId) : 0;
    },
    /**
     * SESSION: sealed (immutable, streamable) chunks — all but the one
     * being written, while lossless.
     */
    sealedChunks() {
      if (!isSession || truncatedAtId >= 0) {
        return [];
      }
      const writing = nextId >> chunkShift;
      return chunks.slice(0, Math.min(writing, chunks.length));
    },
    /**
     * §16.2/G-21: losslessness is provable — one gap-free id range with
     * no truncation-marker inside it.
     */
    verifyLossless() {
      if (!isSession) {
        const from = Math.max(0, nextId - capacity);
        return { lossless: from === 0, from, to: nextId - 1, truncatedAtId: -1 };
      }
      if (truncatedAtId >= 0) {
        return { lossless: false, from: 0, to: truncatedAtId - 1, truncatedAtId };
      }
      for (let id = 0; id < nextId; ++id) {
        if (locate(id) === void 0) {
          return { lossless: false, from: 0, to: id - 1, truncatedAtId: -1 };
        }
      }
      return { lossless: true, from: 0, to: nextId - 1, truncatedAtId: -1 };
    },
    stats() {
      return {
        events: nextId,
        chunks: chunks.length,
        allocations,
        truncated: truncatedAtId >= 0
      };
    }
  };
}

// src/engine.ts
function createCosignalEngine(options) {
  const M = new Int32Array((options?.initialRecords ?? 8192) * 8);
  const G = new Int32Array((options?.initialLogRecords ?? 1024) * 4);
  const W = new Int32Array((options?.initialMemoRecords ?? 1024) * 8);
  const WC = new Int32Array((options?.initialMemoRecords ?? 1024) * 8);
  let recNext = 8;
  let nodeFreeHead = 0;
  let linkFreeHead = 0;
  let gNext = 4;
  let logFreeHead = 0;
  let wNext = 8;
  let certNext = 2;
  const values = [void 0, void 0];
  const fns = [void 0];
  const memos = [0];
  const unappliedStamp = [0];
  const atomUnapplied = /* @__PURE__ */ new Map();
  const metas = [void 0];
  const logVals = [void 0];
  const memoVals = [];
  const memoCheckedAt = [0];
  const newestValidAt = [0];
  let cycle = 0;
  let runDepth = 0;
  let batchDepth = 0;
  let notifyIndex = 0;
  let queuedLength = 0;
  let activeSub = 0;
  let enterDepth = 0;
  const queued = [];
  const pendingFree = [];
  let writeMode = 0 /* MODE_DIRECT */;
  let seqCounter = 1;
  let walkCounter = 0;
  let eraFloor = 0;
  let overlayEpoch = 1;
  let certGen = 1;
  let loggedAtomCount = 0;
  let unappliedEntries = 0;
  let quiescenceCount = 0;
  const loggedAtoms = [];
  const allNodes = [];
  const batchToken = new Int32Array(32);
  const batchEntryCount = new Int32Array(32);
  const slotMemoHead = new Int32Array(32);
  let liveSlotMask = 0;
  let liveDeferredMask = 0;
  let retiredSlotMask = 0;
  let slotChainMask = 0;
  let slotOccupiedMask = 0;
  let lastToken = 0;
  let lastSlot = -1;
  let passOpen = 0;
  let passExecuting = 0;
  let passSerial = 0;
  let passPin = 0;
  let passIncludeMask = 0;
  let passIncludePseudo = 0;
  let passContainer = void 0;
  let passLineage = 0;
  let readCtx = 1 /* CTX_NEWEST */;
  let canonicalEvalDepth = 0;
  let untrackedDepth = 0;
  const frameWorlds = [];
  let certStack = new Int32Array(4096);
  let certSp = 0;
  const pendingWalks = [];
  const fastCollect = [];
  let sweepNeeded = false;
  const kernelBroadcasts = [];
  let drainDepth = 0;
  const broadcastLog = [];
  let forbidWritesInComputeds = false;
  const lifecyclePending = /* @__PURE__ */ new Map();
  const lifecycleDelivered = /* @__PURE__ */ new Map();
  let lifecycleScheduled = false;
  const rootViews = /* @__PURE__ */ new Map();
  const commitListeners = /* @__PURE__ */ new Set();
  let tracer;
  function reclaimNode(id, gen) {
    if (M[id + 5 /* GEN */] !== gen || (M[id + 0 /* FLAGS */] & (1024 /* K_ATOM */ | 2048 /* K_COMPUTED */)) === 0) {
      return;
    }
    if (M[id + 3 /* SUBS */] !== 0 || (M[id + 0 /* FLAGS */] & 128 /* LOGGED */) !== 0) {
      return;
    }
    disposeAllDepsInReverse(id);
    M[id + 0 /* FLAGS */] = 0;
    pendingFree.push(id);
    maybeBoundary();
  }
  const finalizationEnabled = options?.finalization === true;
  const finalizer = finalizationEnabled && typeof FinalizationRegistry !== "undefined" ? new FinalizationRegistry((held) => {
    reclaimNode(held.id, held.gen);
  }) : void 0;
  function registerHandle(handle, id) {
    finalizer?.register(handle, { id, gen: M[id + 5 /* GEN */] });
  }
  let fork;
  let unsubscribeFork;
  let propStack = new Int32Array(4096);
  let propSp = 0;
  let checkStack = new Int32Array(4096);
  let checkSp = 0;
  function growM() {
    const bigger = new Int32Array(M.length * 2);
    bigger.set(M);
    throw new Error('const-variant: M cannot grow');
  }
  function growG() {
    const bigger = new Int32Array(G.length * 2);
    bigger.set(G);
    throw new Error('const-variant: G cannot grow');
  }
  function growW() {
    const bigger = new Int32Array(W.length * 2);
    bigger.set(W);
    throw new Error('const-variant: W cannot grow');
  }
  function growWC() {
    const bigger = new Int32Array(WC.length * 2);
    bigger.set(WC);
    throw new Error('const-variant: WC cannot grow');
  }
  function growCertStack() {
    const bigger = new Int32Array(certStack.length * 2);
    bigger.set(certStack);
    certStack = bigger;
  }
  function allocNode(flags) {
    let id;
    if (nodeFreeHead !== 0) {
      id = nodeFreeHead;
      nodeFreeHead = M[id + 1 /* DEPS */];
      M[id + 1 /* DEPS */] = 0;
    } else {
      id = recNext;
      if (id >= M.length) {
        growM();
      }
      recNext = id + 8;
      allNodes.push(id);
    }
    M[id + 0 /* FLAGS */] = flags;
    const v = id >> 2;
    while (values.length <= v + 1) {
      values.push(void 0);
    }
    while (fns.length <= id >> 3) {
      fns.push(void 0);
      memos.push(0);
      metas.push(void 0);
      unappliedStamp.push(0);
      newestValidAt.push(0);
    }
    return id;
  }
  function freeNode(id) {
    M[id + 0 /* FLAGS */] = 0;
    M[id + 2 /* DEPS_TAIL */] = 0;
    M[id + 3 /* SUBS */] = 0;
    M[id + 4 /* SUBS_TAIL */] = 0;
    M[id + 6 /* LOG_HEAD */] = 0;
    M[id + 7 /* LOG_TAIL */] = 0;
    ++M[id + 5 /* GEN */];
    const v = id >> 2;
    values[v] = void 0;
    values[v + 1] = void 0;
    fns[id >> 3] = void 0;
    memos[id >> 3] = 0;
    metas[id >> 3] = void 0;
    M[id + 1 /* DEPS */] = nodeFreeHead;
    nodeFreeHead = id;
  }
  function sweepPendingFree() {
    for (let i = 0; i < pendingFree.length; ++i) {
      freeNode(pendingFree[i]);
    }
    pendingFree.length = 0;
  }
  function allocLink() {
    let id;
    if (linkFreeHead !== 0) {
      id = linkFreeHead;
      linkFreeHead = M[id + 6 /* NEXT_DEP */];
    } else {
      id = recNext;
      if (id >= M.length) {
        growM();
      }
      recNext = id + 8;
    }
    return id;
  }
  function freeLink(id) {
    M[id + 6 /* NEXT_DEP */] = linkFreeHead;
    linkFreeHead = id;
  }
  function allocLog() {
    let gid;
    if (logFreeHead !== 0) {
      gid = logFreeHead;
      logFreeHead = G[gid + 0 /* L_NEXT */];
    } else {
      gid = gNext;
      if (gid >= G.length) {
        growG();
      }
      gNext = gid + 4;
    }
    G[gid + 0 /* L_NEXT */] = 0;
    while (logVals.length <= gid >> 2) {
      logVals.push(void 0);
    }
    return gid;
  }
  function freeLog(gid) {
    logVals[gid >> 2] = void 0;
    G[gid + 0 /* L_NEXT */] = logFreeHead;
    logFreeHead = gid;
  }
  function allocMemo() {
    const wid = wNext;
    if (wid >= W.length) {
      growW();
    }
    wNext = wid + 8;
    while (memoCheckedAt.length <= wid >> 3) {
      memoCheckedAt.push(0);
    }
    return wid;
  }
  function link(dep, sub, version) {
    const prevDep = M[sub + 2 /* DEPS_TAIL */];
    if (prevDep !== 0 && M[prevDep + 1 /* DEP */] === dep) {
      return;
    }
    const nextDep = prevDep !== 0 ? M[prevDep + 6 /* NEXT_DEP */] : M[sub + 1 /* DEPS */];
    if (nextDep !== 0 && M[nextDep + 1 /* DEP */] === dep) {
      M[nextDep + 0 /* VERSION */] = version;
      M[sub + 2 /* DEPS_TAIL */] = nextDep;
      return;
    }
    linkInsert(dep, sub, version, prevDep, nextDep);
  }
  function linkInsert(dep, sub, version, prevDep, nextDep) {
    const prevSub = M[dep + 4 /* SUBS_TAIL */];
    if (prevSub !== 0 && M[prevSub + 0 /* VERSION */] === version && M[prevSub + 2 /* SUB */] === sub) {
      return;
    }
    const newLink = allocLink();
    M[sub + 2 /* DEPS_TAIL */] = newLink;
    M[dep + 4 /* SUBS_TAIL */] = newLink;
    M[newLink + 0 /* VERSION */] = version;
    M[newLink + 1 /* DEP */] = dep;
    M[newLink + 2 /* SUB */] = sub;
    M[newLink + 5 /* PREV_DEP */] = prevDep;
    M[newLink + 6 /* NEXT_DEP */] = nextDep;
    M[newLink + 3 /* PREV_SUB */] = prevSub;
    M[newLink + 4 /* NEXT_SUB */] = 0;
    if (nextDep !== 0) {
      M[nextDep + 5 /* PREV_DEP */] = newLink;
    }
    if (prevDep !== 0) {
      M[prevDep + 6 /* NEXT_DEP */] = newLink;
    } else {
      M[sub + 1 /* DEPS */] = newLink;
    }
    if (prevSub !== 0) {
      M[prevSub + 4 /* NEXT_SUB */] = newLink;
    } else {
      M[dep + 3 /* SUBS */] = newLink;
    }
    if ((M[sub + 0 /* FLAGS */] & 512 /* LIVE */) !== 0 && (M[dep + 0 /* FLAGS */] & 512 /* LIVE */) === 0) {
      flowLiveDown(dep);
    }
    if (loggedAtomCount !== 0) {
      const df = M[dep + 0 /* FLAGS */];
      const producerMarked = (df & 128 /* LOGGED */) !== 0 || (df & 1024 /* K_ATOM */) === 0 && M[dep + 6 /* OVERLAY_STAMP */] > eraFloor;
      if (producerMarked) {
        const producerUnapplied = (df & 1024 /* K_ATOM */) !== 0 ? (atomUnapplied.get(dep) ?? 0) > 0 : unappliedStamp[dep >> 3] > eraFloor;
        stampCone(sub, ++walkCounter, false, producerUnapplied);
      }
    }
  }
  function onAtomLiveChange(a, live) {
    if (metas[a >> 3]?.observeEffect !== void 0) {
      lifecyclePending.set(a, live);
      if (!lifecycleScheduled) {
        lifecycleScheduled = true;
        queueMicrotask(drainLifecycle);
      }
    }
  }
  function drainLifecycle() {
    lifecycleScheduled = false;
    const work = [...lifecyclePending];
    lifecyclePending.clear();
    for (const [a, live] of work) {
      const meta = metas[a >> 3];
      const delivered = lifecycleDelivered.get(a);
      if (live && delivered === void 0) {
        const observe = meta?.observeEffect;
        if (observe === void 0) {
          continue;
        }
        const ctx = {
          peek: () => pendingValueOf(a),
          set: (v) => writeOp(a, 1 /* OP_SET */, v),
          update: (f) => writeOp(a, 2 /* OP_UPDATE */, f)
        };
        const cleanup = observe(ctx);
        lifecycleDelivered.set(a, { cleanup: cleanup ?? void 0 });
      } else if (!live && delivered !== void 0) {
        lifecycleDelivered.delete(a);
        delivered.cleanup?.();
      }
    }
  }
  function flowLiveDown(dep) {
    if ((M[dep + 0 /* FLAGS */] & 512 /* LIVE */) !== 0) {
      return;
    }
    M[dep + 0 /* FLAGS */] |= 512 /* LIVE */;
    if ((M[dep + 0 /* FLAGS */] & 1024 /* K_ATOM */) !== 0) {
      onAtomLiveChange(dep, true);
      return;
    }
    let lnk = M[dep + 1 /* DEPS */];
    while (lnk !== 0) {
      flowLiveDown(M[lnk + 1 /* DEP */]);
      lnk = M[lnk + 6 /* NEXT_DEP */];
    }
  }
  function recheckLive(dep) {
    const flags = M[dep + 0 /* FLAGS */];
    if ((flags & 512 /* LIVE */) === 0 || (flags & (4096 /* K_EFFECT */ | 16384 /* K_WATCHER */ | 8192 /* K_SCOPE */)) !== 0) {
      return;
    }
    let lnk = M[dep + 3 /* SUBS */];
    while (lnk !== 0) {
      if ((M[M[lnk + 2 /* SUB */] + 0 /* FLAGS */] & 512 /* LIVE */) !== 0) {
        return;
      }
      lnk = M[lnk + 4 /* NEXT_SUB */];
    }
    M[dep + 0 /* FLAGS */] &= ~512 /* LIVE */;
    if ((flags & 1024 /* K_ATOM */) !== 0) {
      onAtomLiveChange(dep, false);
      return;
    }
    let d = M[dep + 1 /* DEPS */];
    while (d !== 0) {
      recheckLive(M[d + 1 /* DEP */]);
      d = M[d + 6 /* NEXT_DEP */];
    }
  }
  function unlink(id, sub = M[id + 2 /* SUB */]) {
    const dep = M[id + 1 /* DEP */];
    const prevDep = M[id + 5 /* PREV_DEP */];
    const nextDep = M[id + 6 /* NEXT_DEP */];
    const nextSub = M[id + 4 /* NEXT_SUB */];
    const prevSub = M[id + 3 /* PREV_SUB */];
    if (nextDep !== 0) {
      M[nextDep + 5 /* PREV_DEP */] = prevDep;
    } else {
      M[sub + 2 /* DEPS_TAIL */] = prevDep;
    }
    if (prevDep !== 0) {
      M[prevDep + 6 /* NEXT_DEP */] = nextDep;
    } else {
      M[sub + 1 /* DEPS */] = nextDep;
    }
    if (nextSub !== 0) {
      M[nextSub + 3 /* PREV_SUB */] = prevSub;
    } else {
      M[dep + 4 /* SUBS_TAIL */] = prevSub;
    }
    freeLink(id);
    if (prevSub !== 0) {
      M[prevSub + 4 /* NEXT_SUB */] = nextSub;
    } else if ((M[dep + 3 /* SUBS */] = nextSub) === 0) {
      unwatched(dep);
    }
    if ((M[dep + 0 /* FLAGS */] & 512 /* LIVE */) !== 0) {
      recheckLive(dep);
    }
    return nextDep;
  }
  function propagate(startLink, innerWrite) {
    let cur = startLink;
    let next = M[cur + 4 /* NEXT_SUB */];
    const stackBase = propSp;
    top: do {
      const sub = M[cur + 2 /* SUB */];
      let flags = M[sub + 0 /* FLAGS */];
      if (!(flags & (4 /* RECURSED_CHECK */ | 8 /* RECURSED */ | 16 /* DIRTY */ | 32 /* PENDING */))) {
        M[sub + 0 /* FLAGS */] = flags | 32 /* PENDING */;
        if (innerWrite) {
          M[sub + 0 /* FLAGS */] |= 8 /* RECURSED */;
        }
      } else if (!(flags & (4 /* RECURSED_CHECK */ | 8 /* RECURSED */))) {
        flags = 0;
      } else if (!(flags & 4 /* RECURSED_CHECK */)) {
        M[sub + 0 /* FLAGS */] = flags & ~8 /* RECURSED */ | 32 /* PENDING */;
      } else if (!(flags & (16 /* DIRTY */ | 32 /* PENDING */)) && isValidLink(cur, sub)) {
        M[sub + 0 /* FLAGS */] = flags | (8 /* RECURSED */ | 32 /* PENDING */);
        flags &= 1 /* MUTABLE */;
      } else {
        flags = 0;
      }
      if (flags & 2 /* WATCHING */) {
        if (M[sub + 0 /* FLAGS */] & 256 /* IMMEDIATE */) {
          kernelBroadcasts.push(sub);
        } else {
          notify(sub);
        }
      }
      if (flags & 1 /* MUTABLE */) {
        const subSubs = M[sub + 3 /* SUBS */];
        if (subSubs !== 0) {
          cur = subSubs;
          const nextSub = M[cur + 4 /* NEXT_SUB */];
          if (nextSub !== 0) {
            if (propSp === propStack.length) {
              const bigger = new Int32Array(propStack.length * 2);
              bigger.set(propStack);
              propStack = bigger;
            }
            propStack[propSp++] = next;
            next = nextSub;
          }
          continue;
        }
      }
      if ((cur = next) !== 0) {
        next = M[cur + 4 /* NEXT_SUB */];
        continue;
      }
      while (propSp > stackBase) {
        cur = propStack[--propSp];
        if (cur !== 0) {
          next = M[cur + 4 /* NEXT_SUB */];
          continue top;
        }
      }
      break;
    } while (true);
  }
  function checkDirty(startLink, startSub) {
    let cur = startLink;
    let sub = startSub;
    const stackBase = checkSp;
    let checkDepth = 0;
    let dirty = false;
    try {
      top: do {
        const dep = M[cur + 1 /* DEP */];
        const depFlags = M[dep + 0 /* FLAGS */];
        if (M[sub + 0 /* FLAGS */] & 16 /* DIRTY */) {
          dirty = true;
        } else if ((depFlags & (1 /* MUTABLE */ | 16 /* DIRTY */)) === (1 /* MUTABLE */ | 16 /* DIRTY */)) {
          const depSubs = M[dep + 3 /* SUBS */];
          if (update(dep)) {
            if (M[depSubs + 4 /* NEXT_SUB */] !== 0) {
              shallowPropagate(depSubs);
            }
            dirty = true;
          }
        } else if ((depFlags & (1 /* MUTABLE */ | 32 /* PENDING */)) === (1 /* MUTABLE */ | 32 /* PENDING */)) {
          if (checkSp === checkStack.length) {
            const bigger = new Int32Array(checkStack.length * 2);
            bigger.set(checkStack);
            checkStack = bigger;
          }
          checkStack[checkSp++] = cur;
          cur = M[dep + 1 /* DEPS */];
          sub = dep;
          ++checkDepth;
          continue;
        }
        if (!dirty) {
          const nextDep = M[cur + 6 /* NEXT_DEP */];
          if (nextDep !== 0) {
            cur = nextDep;
            continue;
          }
        }
        while (checkDepth--) {
          cur = checkStack[--checkSp];
          if (dirty) {
            const subSubs = M[sub + 3 /* SUBS */];
            if (update(sub)) {
              if (M[subSubs + 4 /* NEXT_SUB */] !== 0) {
                shallowPropagate(subSubs);
              }
              sub = M[cur + 2 /* SUB */];
              continue;
            }
            dirty = false;
          } else {
            M[sub + 0 /* FLAGS */] &= ~32 /* PENDING */;
          }
          sub = M[cur + 2 /* SUB */];
          const nextDep = M[cur + 6 /* NEXT_DEP */];
          if (nextDep !== 0) {
            cur = nextDep;
            continue top;
          }
        }
        return dirty && M[sub + 0 /* FLAGS */] !== 0;
      } while (true);
    } finally {
      checkSp = stackBase;
    }
  }
  function shallowPropagate(startLink) {
    let cur = startLink;
    do {
      const sub = M[cur + 2 /* SUB */];
      const flags = M[sub + 0 /* FLAGS */];
      if ((flags & (32 /* PENDING */ | 16 /* DIRTY */)) === 32 /* PENDING */) {
        M[sub + 0 /* FLAGS */] = flags | 16 /* DIRTY */;
        if ((flags & (2 /* WATCHING */ | 4 /* RECURSED_CHECK */)) === 2 /* WATCHING */) {
          if (flags & 256 /* IMMEDIATE */) {
            kernelBroadcasts.push(sub);
          } else {
            notify(sub);
          }
        }
      }
    } while ((cur = M[cur + 4 /* NEXT_SUB */]) !== 0);
  }
  function isValidLink(checkLink, sub) {
    let cur = M[sub + 2 /* DEPS_TAIL */];
    while (cur !== 0) {
      if (cur === checkLink) {
        return true;
      }
      cur = M[cur + 5 /* PREV_DEP */];
    }
    return false;
  }
  function update(node) {
    const flags = M[node + 0 /* FLAGS */];
    if (flags & 2048 /* K_COMPUTED */) {
      return updateComputed(node);
    }
    if (flags & 1024 /* K_ATOM */) {
      return updateAtom(node);
    }
    M[node + 0 /* FLAGS */] = flags & (31744 /* KIND_MASK */ | 256 /* IMMEDIATE */ | 512 /* LIVE */) | 1 /* MUTABLE */;
    return true;
  }
  function notify(e) {
    let insertIndex = queuedLength;
    const firstInsertedIndex = insertIndex;
    do {
      queued[insertIndex++] = e;
      M[e + 0 /* FLAGS */] &= ~2 /* WATCHING */;
      const subs = M[e + 3 /* SUBS */];
      e = subs !== 0 ? M[subs + 2 /* SUB */] : 0;
      if (e === 0 || !(M[e + 0 /* FLAGS */] & 2 /* WATCHING */) || M[e + 0 /* FLAGS */] & 256 /* IMMEDIATE */) {
        break;
      }
    } while (true);
    queuedLength = insertIndex;
    let left = firstInsertedIndex;
    while (left < --insertIndex) {
      const tmp = queued[left];
      queued[left++] = queued[insertIndex];
      queued[insertIndex] = tmp;
    }
  }
  function unwatched(node) {
    const flags = M[node + 0 /* FLAGS */];
    if (flags & 2048 /* K_COMPUTED */) {
      if (M[node + 2 /* DEPS_TAIL */] !== 0) {
        M[node + 0 /* FLAGS */] = 2048 /* K_COMPUTED */ | 1 /* MUTABLE */ | 16 /* DIRTY */ | flags & (512 /* LIVE */ | 128 /* LOGGED */);
        disposeAllDepsInReverse(node);
      }
    } else if (flags & 1024 /* K_ATOM */) {
    } else if (flags & (4096 /* K_EFFECT */ | 8192 /* K_SCOPE */ | 16384 /* K_WATCHER */)) {
      dispose(node);
    }
  }
  function unlinkChildEffects(sub) {
    let cur = M[sub + 2 /* DEPS_TAIL */];
    while (cur !== 0) {
      const prev = M[cur + 5 /* PREV_DEP */];
      const dep = M[cur + 1 /* DEP */];
      if (!(M[dep + 0 /* FLAGS */] & (2048 /* K_COMPUTED */ | 1024 /* K_ATOM */))) {
        unlink(cur, sub);
      }
      cur = prev;
    }
  }
  function updateComputed(c) {
    if (M[c + 0 /* FLAGS */] & 64 /* HAS_CHILD_EFFECT */) {
      unlinkChildEffects(c);
    }
    const keep = M[c + 0 /* FLAGS */] & 512 /* LIVE */;
    M[c + 2 /* DEPS_TAIL */] = 0;
    M[c + 0 /* FLAGS */] = 2048 /* K_COMPUTED */ | 1 /* MUTABLE */ | 4 /* RECURSED_CHECK */ | keep;
    const prevSub = activeSub;
    activeSub = c;
    ++enterDepth;
    ++canonicalEvalDepth;
    try {
      ++cycle;
      const v = c >> 2;
      const oldValue = values[v];
      return oldValue !== (values[v] = fns[c >> 3](oldValue));
    } finally {
      --canonicalEvalDepth;
      --enterDepth;
      activeSub = prevSub;
      M[c + 0 /* FLAGS */] &= ~4 /* RECURSED_CHECK */;
      purgeDeps(c);
    }
  }
  function updateAtom(s) {
    M[s + 0 /* FLAGS */] = M[s + 0 /* FLAGS */] & (128 /* LOGGED */ | 512 /* LIVE */) | 1024 /* K_ATOM */ | 1 /* MUTABLE */;
    const v = s >> 2;
    return values[v] !== (values[v] = values[v + 1]);
  }
  function run(e) {
    const flags = M[e + 0 /* FLAGS */];
    if (flags & 16 /* DIRTY */ || flags & 32 /* PENDING */ && checkDirty(M[e + 1 /* DEPS */], e)) {
      if (flags & 64 /* HAS_CHILD_EFFECT */) {
        unlinkChildEffects(e);
      }
      const cv = (e >> 2) + 1;
      if (values[cv]) {
        runCleanup(e);
        if (M[e + 0 /* FLAGS */] === 0) {
          return;
        }
      }
      M[e + 2 /* DEPS_TAIL */] = 0;
      M[e + 0 /* FLAGS */] = 4096 /* K_EFFECT */ | 2 /* WATCHING */ | 4 /* RECURSED_CHECK */ | 512 /* LIVE */;
      const prevSub = activeSub;
      activeSub = e;
      ++enterDepth;
      try {
        ++cycle;
        ++runDepth;
        values[cv] = fns[e >> 3]();
      } finally {
        --runDepth;
        --enterDepth;
        activeSub = prevSub;
        M[e + 0 /* FLAGS */] &= ~4 /* RECURSED_CHECK */;
        purgeDeps(e);
      }
    } else if (M[e + 1 /* DEPS */] !== 0) {
      M[e + 0 /* FLAGS */] = 4096 /* K_EFFECT */ | 2 /* WATCHING */ | 512 /* LIVE */ | flags & 64 /* HAS_CHILD_EFFECT */;
    }
  }
  function requeueAbort(e) {
    if (M[e + 0 /* FLAGS */] & 31744 /* KIND_MASK */) {
      M[e + 0 /* FLAGS */] |= 2 /* WATCHING */ | 8 /* RECURSED */;
    }
  }
  function runCleanup(e) {
    const cv = (e >> 2) + 1;
    const cleanup = values[cv];
    values[cv] = void 0;
    const prevSub = activeSub;
    activeSub = 0;
    ++enterDepth;
    try {
      cleanup();
    } finally {
      --enterDepth;
      activeSub = prevSub;
    }
  }
  function dispose(e) {
    const flags = M[e + 0 /* FLAGS */];
    if (!(flags & 31744 /* KIND_MASK */)) {
      return;
    }
    M[e + 0 /* FLAGS */] = 0;
    disposeAllDepsInReverse(e);
    const sub = M[e + 3 /* SUBS */];
    if (sub !== 0) {
      unlink(sub);
    }
    if (flags & 4096 /* K_EFFECT */ && values[(e >> 2) + 1]) {
      runCleanup(e);
    }
    pendingFree.push(e);
  }
  function disposeAllDepsInReverse(sub) {
    let cur = M[sub + 2 /* DEPS_TAIL */];
    while (cur !== 0) {
      const prev = M[cur + 5 /* PREV_DEP */];
      unlink(cur, sub);
      cur = prev;
    }
  }
  function purgeDeps(sub) {
    const depsTail = M[sub + 2 /* DEPS_TAIL */];
    let dep = depsTail !== 0 ? M[depsTail + 6 /* NEXT_DEP */] : M[sub + 1 /* DEPS */];
    while (dep !== 0) {
      dep = unlink(dep, sub);
    }
  }
  function maybeBoundary() {
    if (enterDepth === 0 && pendingFree.length !== 0 && queuedLength === 0) {
      sweepPendingFree();
    }
  }
  function flush() {
    maybeBoundary();
    try {
      while (notifyIndex < queuedLength) {
        const e = queued[notifyIndex];
        queued[notifyIndex++] = 0;
        run(e);
      }
    } finally {
      while (notifyIndex < queuedLength) {
        const e = queued[notifyIndex];
        queued[notifyIndex++] = 0;
        requeueAbort(e);
      }
      notifyIndex = 0;
      queuedLength = 0;
    }
  }
  function pendingValueOf(s) {
    return values[(s >> 2) + 1];
  }
  function kernelPeekAtom(s) {
    if (M[s + 0 /* FLAGS */] & 16 /* DIRTY */) {
      if (updateAtom(s)) {
        const subs = M[s + 3 /* SUBS */];
        if (subs !== 0) {
          shallowPropagate(subs);
        }
      }
    }
    return values[s >> 2];
  }
  function kernelReadAtom(s) {
    const v = kernelPeekAtom(s);
    if (activeSub !== 0) {
      link(s, activeSub, cycle);
    }
    return v;
  }
  function kernelWriteAtom(s, value) {
    const p = (s >> 2) + 1;
    if (values[p] !== (values[p] = value)) {
      M[s + 0 /* FLAGS */] |= 16 /* DIRTY */;
      const subs = M[s + 3 /* SUBS */];
      if (subs !== 0) {
        propagate(subs, runDepth !== 0);
        return true;
      }
    }
    return false;
  }
  function kernelComputedRead(c) {
    const flags = M[c + 0 /* FLAGS */];
    if (flags & 16 /* DIRTY */ || flags & 32 /* PENDING */ && (checkDirty(M[c + 1 /* DEPS */], c) || (M[c + 0 /* FLAGS */] = flags & ~32 /* PENDING */, false))) {
      if (updateComputed(c)) {
        const subs = M[c + 3 /* SUBS */];
        if (subs !== 0) {
          shallowPropagate(subs);
        }
      }
    } else if (!(flags & 1 /* MUTABLE */) && !(flags & 16 /* DIRTY */)) {
      M[c + 0 /* FLAGS */] |= 1 /* MUTABLE */ | 4 /* RECURSED_CHECK */;
      const prevSub = activeSub;
      activeSub = c;
      ++enterDepth;
      ++canonicalEvalDepth;
      try {
        values[c >> 2] = fns[c >> 3](void 0);
      } finally {
        --canonicalEvalDepth;
        --enterDepth;
        activeSub = prevSub;
        M[c + 0 /* FLAGS */] &= ~4 /* RECURSED_CHECK */;
      }
    }
    const sub = activeSub;
    if (sub !== 0) {
      link(c, sub, cycle);
    }
    return values[c >> 2];
  }
  function kernelComputedReadUntracked(c) {
    const prevSub = activeSub;
    activeSub = 0;
    try {
      return kernelComputedRead(c);
    } finally {
      activeSub = prevSub;
    }
  }
  function invalidate(id) {
    M[id + 0 /* FLAGS */] |= 16 /* DIRTY */;
    const subs = M[id + 3 /* SUBS */];
    if (subs !== 0) {
      propagate(subs, runDepth !== 0);
    }
  }
  function stampCone(startNode, ticket2, collect, unapplied, collectInto) {
    const stackBase = propSp;
    let node = startNode;
    let nextLink = 0;
    do {
      const flags = M[node + 0 /* FLAGS */];
      if (!(flags & 1024 /* K_ATOM */) && M[node + 6 /* OVERLAY_STAMP */] !== ticket2) {
        M[node + 6 /* OVERLAY_STAMP */] = ticket2;
        if (unapplied) {
          unappliedStamp[node >> 3] = ticket2;
        }
        if (collect && flags & 256 /* IMMEDIATE */ && flags & 16384 /* K_WATCHER */ && collectInto !== void 0) {
          collectInto.push(node);
        }
        const subs = M[node + 3 /* SUBS */];
        if (subs !== 0) {
          if (nextLink !== 0) {
            if (propSp === propStack.length) {
              const bigger = new Int32Array(propStack.length * 2);
              bigger.set(propStack);
              propStack = bigger;
            }
            propStack[propSp++] = nextLink;
          }
          nextLink = subs;
        }
      }
      if (nextLink !== 0) {
        node = M[nextLink + 2 /* SUB */];
        nextLink = M[nextLink + 4 /* NEXT_SUB */];
        continue;
      }
      if (propSp > stackBase) {
        nextLink = propStack[--propSp];
        node = M[nextLink + 2 /* SUB */];
        nextLink = M[nextLink + 4 /* NEXT_SUB */];
        continue;
      }
      break;
    } while (true);
  }
  function notifyWalkFromAtom(atom2, ticket2, collect, collectInto, unapplied = false) {
    let lnk = M[atom2 + 3 /* SUBS */];
    while (lnk !== 0) {
      stampCone(M[lnk + 2 /* SUB */], ticket2, collect, unapplied, collectInto);
      lnk = M[lnk + 4 /* NEXT_SUB */];
    }
  }
  function ticket() {
    return ++seqCounter;
  }
  function valEq(eq, a, b) {
    return eq !== void 0 ? eq(a, b) : Object.is(a, b);
  }
  function equalityOf(id) {
    return metas[id >> 3]?.isEqual;
  }
  function findLiveSlot(token) {
    if (token === 0) {
      return -1;
    }
    if (token === lastToken && lastSlot >= 0 && batchToken[lastSlot] === token) {
      return lastSlot;
    }
    let m = slotOccupiedMask;
    while (m !== 0) {
      const bit = m & -m;
      const s = 31 - Math.clz32(bit);
      if (batchToken[s] === token) {
        lastToken = token;
        lastSlot = s;
        return s;
      }
      m &= m - 1;
    }
    return -1;
  }
  function internSlot(token) {
    if (token === lastToken && lastSlot >= 0 && batchToken[lastSlot] === token) {
      return lastSlot;
    }
    const found = findLiveSlot(token);
    if (found >= 0) {
      return found;
    }
    const free = ~slotOccupiedMask;
    if (free !== 0) {
      const bit = free & -free;
      const s = 31 - Math.clz32(bit);
      if (s < 32 && s >= 0) {
        batchToken[s] = token;
        batchEntryCount[s] = 0;
        slotMemoHead[s] = 0;
        slotOccupiedMask |= 1 << s;
        liveSlotMask |= 1 << s;
        retiredSlotMask &= ~(1 << s);
        if (token & 1) {
          liveDeferredMask |= 1 << s;
        }
        lastToken = token;
        lastSlot = s;
        return s;
      }
    }
    return -1;
  }
  function releaseSlotIfDone(slot) {
    if ((retiredSlotMask >> slot & 1) !== 0 && batchEntryCount[slot] === 0) {
      batchToken[slot] = 0;
      slotOccupiedMask &= ~(1 << slot);
      liveSlotMask &= ~(1 << slot);
      liveDeferredMask &= ~(1 << slot);
      retiredSlotMask &= ~(1 << slot);
      slotMemoHead[slot] = 0;
      slotChainMask &= ~(1 << slot);
      if (lastSlot === slot) {
        lastToken = 0;
        lastSlot = -1;
      }
    }
  }
  function liveDeferredTokens() {
    const out = [];
    for (let s = 0; s < 32; ++s) {
      if ((liveDeferredMask >> s & 1) !== 0 && (retiredSlotMask >> s & 1) === 0) {
        out.push(batchToken[s]);
      }
    }
    return out;
  }
  const W0_WORLD = { k: 0 /* WK_W0 */, key: -1, token: 0, slot: -1, pin: 0, mask: 0 };
  const NEWEST_WORLD = { k: 1 /* WK_NEWEST */, key: 0, token: 0, slot: -1, pin: 0, mask: 0 };
  const COMMITTED_WORLD = { k: 4 /* WK_COMMITTED */, key: -1, token: 0, slot: -1, pin: 2147483647 /* MAX_SEQ */, mask: 0 };
  let passWorld = { k: 2 /* WK_PASS */, key: 1, token: 0, slot: -1, pin: 0, mask: 0 };
  function writerWorld(token) {
    return {
      k: 3 /* WK_WRITER */,
      key: token << 2 | 2 | 0,
      token,
      slot: findLiveSlot(token),
      pin: 0,
      mask: 0
    };
  }
  function ambientWorld() {
    if (readCtx === 2 /* CTX_RENDER */) {
      return passWorld;
    }
    if (readCtx === 3 /* CTX_COMMITTED */) {
      return COMMITTED_WORLD;
    }
    return NEWEST_WORLD;
  }
  function worldSensitive(world) {
    return world.k === 2 /* WK_PASS */ || world.k === 3 /* WK_WRITER */ || world.k === 4 /* WK_COMMITTED */ || world.k === 1 /* WK_NEWEST */ && unappliedEntries > 0;
  }
  function appendLog(a, op, payload, applied, slot, pseudo) {
    ++certGen;
    let head = M[a + 6 /* LOG_HEAD */];
    if (head === 0) {
      const base = allocLog();
      G[base + 1 /* L_META */] = 0 /* OP_BASE */ | 8 /* M_RETIRED */;
      const t2 = ticket();
      G[base + 2 /* L_SEQ */] = t2;
      G[base + 3 /* L_RETIRED_SEQ */] = t2;
      logVals[base >> 2] = pendingValueOf(a);
      M[a + 6 /* LOG_HEAD */] = base;
      M[a + 7 /* LOG_TAIL */] = base;
      M[a + 0 /* FLAGS */] |= 128 /* LOGGED */;
      loggedAtoms.push(a);
      ++loggedAtomCount;
      notifyWalkFromAtom(a, ++walkCounter, false);
      head = base;
    } else if (passOpen === 0 && !pseudo) {
      const tail = M[a + 7 /* LOG_TAIL */];
      const tm = G[tail + 1 /* L_META */];
      const tailOp = tm & 3 /* OP_MASK */;
      const tailSlot = tm >> 4 /* SLOT_SHIFT */ & 31 /* SLOT_MASK */;
      const tailApplied = (tm & 4 /* M_APPLIED */) !== 0;
      if (tailOp !== 0 /* OP_BASE */ && (tm & (8 /* M_RETIRED */ | 512 /* M_PSEUDO */)) === 0 && tailSlot === slot && tailApplied === applied) {
        if (op === 1 /* OP_SET */) {
          logVals[tail >> 2] = payload;
          G[tail + 2 /* L_SEQ */] = ++seqCounter;
          if (tailOp !== 1 /* OP_SET */) {
            G[tail + 1 /* L_META */] = tm & ~3 /* OP_MASK */ | 1 /* OP_SET */;
          }
          if (tracer !== void 0) {
            tracer.emit(3 /* LOG_COALESCE */, a, slot, tail);
          }
          return;
        }
        if ((op === 2 /* OP_UPDATE */ || op === 3 /* OP_DISPATCH */) && tailOp !== 1 /* OP_SET */) {
          let run2 = 0;
          let rec2 = G[head + 0 /* L_NEXT */];
          while (rec2 !== 0) {
            const m = G[rec2 + 1 /* L_META */];
            if ((m >> 4 /* SLOT_SHIFT */ & 31 /* SLOT_MASK */) === slot && (m & 512 /* M_PSEUDO */) === 0) {
              ++run2;
            }
            rec2 = G[rec2 + 0 /* L_NEXT */];
          }
          if (run2 >= 8) {
            const oldOp = tailOp;
            const oldPayload = logVals[tail >> 2];
            const reducer = metas[a >> 3]?.reducer;
            const newOp = op;
            const newPayload = payload;
            logVals[tail >> 2] = (acc) => {
              const mid = oldOp === 2 /* OP_UPDATE */ ? oldPayload(acc) : reducer(acc, oldPayload);
              return newOp === 2 /* OP_UPDATE */ ? newPayload(mid) : reducer(mid, newPayload);
            };
            G[tail + 2 /* L_SEQ */] = ticket();
            G[tail + 1 /* L_META */] = tm & ~3 /* OP_MASK */ | 2 /* OP_UPDATE */;
            return;
          }
        }
      }
    }
    const rec = allocLog();
    let meta = op | slot << 4 /* SLOT_SHIFT */ | (applied ? 4 /* M_APPLIED */ : 0);
    const t = ticket();
    G[rec + 2 /* L_SEQ */] = t;
    if (pseudo) {
      meta |= 512 /* M_PSEUDO */ | 4 /* M_APPLIED */ | 8 /* M_RETIRED */;
      G[rec + 3 /* L_RETIRED_SEQ */] = t;
    } else {
      G[rec + 3 /* L_RETIRED_SEQ */] = 0;
      ++batchEntryCount[slot];
      if (!applied) {
        ++unappliedEntries;
        atomUnapplied.set(a, (atomUnapplied.get(a) ?? 0) + 1);
      }
    }
    G[rec + 1 /* L_META */] = meta;
    logVals[rec >> 2] = payload;
    G[M[a + 7 /* LOG_TAIL */] + 0 /* L_NEXT */] = rec;
    M[a + 7 /* LOG_TAIL */] = rec;
    if (tracer !== void 0) {
      tracer.emit(2 /* LOG_APPEND */, a, slot, rec, t, meta);
    }
  }
  function visibleEntry(rec, world) {
    const meta = G[rec + 1 /* L_META */];
    switch (world.k) {
      case 1 /* WK_NEWEST */:
        return true;
      case 4 /* WK_COMMITTED */: {
        if ((meta & 8 /* M_RETIRED */) !== 0 && G[rec + 3 /* L_RETIRED_SEQ */] <= world.pin) {
          return true;
        }
        const slot = meta >> 4 /* SLOT_SHIFT */ & 31 /* SLOT_MASK */;
        return (meta & 512 /* M_PSEUDO */) === 0 && (world.mask >> slot & 1) !== 0;
      }
      case 0 /* WK_W0 */:
        return (meta & (8 /* M_RETIRED */ | 4 /* M_APPLIED */)) !== 0;
      case 2 /* WK_PASS */: {
        if ((meta & 8 /* M_RETIRED */) !== 0 && G[rec + 3 /* L_RETIRED_SEQ */] <= world.pin) {
          return true;
        }
        if ((meta & 512 /* M_PSEUDO */) !== 0) {
          return false;
        }
        const slot = meta >> 4 /* SLOT_SHIFT */ & 31 /* SLOT_MASK */;
        return (world.mask >> slot & 1) !== 0 && G[rec + 2 /* L_SEQ */] <= world.pin;
      }
      case 3 /* WK_WRITER */: {
        if ((meta & (8 /* M_RETIRED */ | 4 /* M_APPLIED */)) !== 0) {
          return true;
        }
        const slot = meta >> 4 /* SLOT_SHIFT */ & 31 /* SLOT_MASK */;
        return (meta & 512 /* M_PSEUDO */) === 0 && (slot === world.slot || (world.mask >> slot & 1) !== 0);
      }
    }
    return false;
  }
  function applyLogOp(a, rec, acc) {
    const op = G[rec + 1 /* L_META */] & 3 /* OP_MASK */;
    if (op === 1 /* OP_SET */) {
      return logVals[rec >> 2];
    }
    if (op === 2 /* OP_UPDATE */) {
      return logVals[rec >> 2](acc);
    }
    return metas[a >> 3].reducer(acc, logVals[rec >> 2]);
  }
  function foldTape(a, world) {
    const head = M[a + 6 /* LOG_HEAD */];
    const eq = equalityOf(a);
    let acc = logVals[head >> 2];
    let rec = G[head + 0 /* L_NEXT */];
    while (rec !== 0) {
      if (visibleEntry(rec, world)) {
        const next = applyLogOp(a, rec, acc);
        acc = valEq(eq, acc, next) ? acc : next;
      }
      rec = G[rec + 0 /* L_NEXT */];
    }
    return acc;
  }
  function allVisibleAndApplied(a, world) {
    const head = M[a + 6 /* LOG_HEAD */];
    let rec = G[head + 0 /* L_NEXT */];
    while (rec !== 0) {
      const meta = G[rec + 1 /* L_META */];
      if ((meta & (4 /* M_APPLIED */ | 8 /* M_RETIRED */)) === 0 || !visibleEntry(rec, world)) {
        return false;
      }
      rec = G[rec + 0 /* L_NEXT */];
    }
    return true;
  }
  function resolveAtomInWorld(a, world) {
    if ((M[a + 0 /* FLAGS */] & 128 /* LOGGED */) === 0 || world.k === 0 /* WK_W0 */) {
      return kernelPeekAtom(a);
    }
    if (world.k === 1 /* WK_NEWEST */ && (unappliedEntries === 0 || (atomUnapplied.get(a) ?? 0) === 0)) {
      return kernelPeekAtom(a);
    }
    if (allVisibleAndApplied(a, world)) {
      return kernelPeekAtom(a);
    }
    return foldTape(a, world);
  }
  function memoHeadOf(c) {
    let head = memos[c >> 3];
    if (head !== 0 && (head >= wNext || W[head + 2 /* W_NODE */] !== c)) {
      memos[c >> 3] = 0;
      head = 0;
    }
    return head;
  }
  function certValid(rec) {
    const n = W[rec + 6 /* W_NDEPS */];
    let off = W[rec + 7 /* W_CERT */];
    for (let i = 0; i < n; ++i, off += 2) {
      const aid = WC[off];
      const expected = WC[off + 1];
      const cur = (M[aid + 0 /* FLAGS */] & 128 /* LOGGED */) !== 0 ? G[M[aid + 7 /* LOG_TAIL */] + 2 /* L_SEQ */] : 0;
      if (cur !== expected) {
        return false;
      }
    }
    return true;
  }
  function memoLookup(c, world) {
    if (world.key < 0) {
      return 0;
    }
    let rec = memoHeadOf(c);
    while (rec !== 0) {
      if (W[rec + 0 /* W_KEY */] === world.key && W[rec + 1 /* W_EPOCH */] === overlayEpoch) {
        if (world.k === 2 /* WK_PASS */) {
          return rec;
        }
        if (memoCheckedAt[rec >> 3] === certGen) {
          return rec;
        }
        if (certValid(rec)) {
          memoCheckedAt[rec >> 3] = certGen;
          return rec;
        }
      }
      rec = W[rec + 4 /* W_NEXT_MEMO */];
    }
    return 0;
  }
  function certPush(aid, seq) {
    if (certSp + 2 > certStack.length) {
      growCertStack();
    }
    certStack[certSp++] = aid;
    certStack[certSp++] = seq;
  }
  function overlayReadAtom(a) {
    const world = frameWorlds[frameWorlds.length - 1];
    const flags = M[a + 0 /* FLAGS */];
    let tailSeq = 0;
    let v;
    if ((flags & 128 /* LOGGED */) !== 0) {
      tailSeq = G[M[a + 7 /* LOG_TAIL */] + 2 /* L_SEQ */];
      v = world.k === 0 /* WK_W0 */ ? kernelPeekAtom(a) : resolveAtomInWorld(a, world);
    } else {
      v = kernelPeekAtom(a);
    }
    certPush(a, tailSeq);
    return v;
  }
  function overlayEvaluate(c, world) {
    const hit = memoLookup(c, world);
    if (hit !== 0) {
      if (tracer !== void 0) {
        tracer.emit(7 /* COMPUTED_EVAL */, c, world.key, 0, 0, 1);
      }
      if (frameWorlds.length > 0) {
        const n = W[hit + 6 /* W_NDEPS */];
        let off = W[hit + 7 /* W_CERT */];
        for (let i = 0; i < n; ++i, off += 2) {
          certPush(WC[off], WC[off + 1]);
        }
      }
      return memoVals[W[hit + 3 /* W_VAL */]];
    }
    let prev;
    let hasPrev = false;
    if (world.key >= 0) {
      let rec = memoHeadOf(c);
      while (rec !== 0) {
        if (W[rec + 0 /* W_KEY */] === world.key && W[rec + 1 /* W_EPOCH */] !== 0) {
          prev = memoVals[W[rec + 3 /* W_VAL */]];
          hasPrev = true;
          break;
        }
        rec = W[rec + 4 /* W_NEXT_MEMO */];
      }
    }
    const frameBase = certSp;
    frameWorlds.push(world);
    const prevSub = activeSub;
    activeSub = 0;
    let v;
    try {
      v = metas[c >> 3].rawFn();
    } finally {
      activeSub = prevSub;
      frameWorlds.pop();
    }
    if (hasPrev && valEq(equalityOf(c), prev, v)) {
      v = prev;
    }
    if (world.key >= 0) {
      const pairs = certSp - frameBase >> 1;
      while (certNext + pairs * 2 > WC.length) {
        growWC();
      }
      const off = certNext;
      for (let i = 0; i < pairs * 2; ++i) {
        WC[off + i] = certStack[frameBase + i];
      }
      certNext = off + pairs * 2;
      let rec = 0;
      for (let old = memoHeadOf(c); old !== 0; old = W[old + 4 /* W_NEXT_MEMO */]) {
        if (W[old + 0 /* W_KEY */] === world.key) {
          rec = old;
          break;
        }
      }
      if (rec !== 0) {
        W[rec + 1 /* W_EPOCH */] = overlayEpoch;
        memoVals[W[rec + 3 /* W_VAL */]] = v;
        W[rec + 6 /* W_NDEPS */] = pairs;
        W[rec + 7 /* W_CERT */] = off;
        memoCheckedAt[rec >> 3] = certGen;
        if (world.k === 3 /* WK_WRITER */ && world.slot >= 0 && W[rec + 5 /* W_SLOT_NEXT */] === -1) {
          W[rec + 5 /* W_SLOT_NEXT */] = slotMemoHead[world.slot];
          slotMemoHead[world.slot] = rec;
          slotChainMask |= 1 << world.slot;
        }
      } else {
        rec = allocMemo();
        W[rec + 0 /* W_KEY */] = world.key;
        W[rec + 1 /* W_EPOCH */] = overlayEpoch;
        W[rec + 2 /* W_NODE */] = c;
        memoVals.push(v);
        W[rec + 3 /* W_VAL */] = memoVals.length - 1;
        W[rec + 4 /* W_NEXT_MEMO */] = memoHeadOf(c);
        W[rec + 6 /* W_NDEPS */] = pairs;
        W[rec + 7 /* W_CERT */] = off;
        memoCheckedAt[rec >> 3] = certGen;
        memos[c >> 3] = rec;
        M[c + 7 /* MEMO_KEY */] = world.key;
        if (world.k === 3 /* WK_WRITER */ && world.slot >= 0) {
          W[rec + 5 /* W_SLOT_NEXT */] = slotMemoHead[world.slot];
          slotMemoHead[world.slot] = rec;
          slotChainMask |= 1 << world.slot;
        } else {
          W[rec + 5 /* W_SLOT_NEXT */] = world.k === 3 /* WK_WRITER */ ? -1 : 0;
        }
      }
    }
    if (frameWorlds.length === 0) {
      certSp = 0;
    }
    if (tracer !== void 0) {
      tracer.emit(7 /* COMPUTED_EVAL */, c, world.key, 0, 0, 0);
    }
    return v;
  }
  function resolveComputedInWorld(c, world) {
    if (world.k === 1 /* WK_NEWEST */ && writeMode === 1 /* MODE_LOGGED */) {
      if (newestValidAt[c >> 3] === certGen) {
        return values[(c >> 2) + 1];
      }
      const genBefore = certGen;
      const v = resolveComputedInWorldInner(c, world);
      values[(c >> 2) + 1] = v;
      newestValidAt[c >> 3] = genBefore;
      return v;
    }
    return resolveComputedInWorldInner(c, world);
  }
  function resolveComputedInWorldInner(c, world) {
    if (world.k === 0 /* WK_W0 */) {
      return kernelComputedReadUntracked(c);
    }
    if (loggedAtomCount === 0 || M[c + 6 /* OVERLAY_STAMP */] <= eraFloor) {
      const v = kernelComputedReadUntracked(c);
      if (worldSensitive(world) && M[c + 6 /* OVERLAY_STAMP */] > eraFloor) {
        if (world.k !== 1 /* WK_NEWEST */ || unappliedStamp[c >> 3] > eraFloor) {
          return overlayEvaluate(c, world);
        }
      }
      return v;
    }
    if (world.k === 1 /* WK_NEWEST */ && (unappliedEntries === 0 || unappliedStamp[c >> 3] <= eraFloor)) {
      const v = kernelComputedReadUntracked(c);
      if (unappliedEntries !== 0 && unappliedStamp[c >> 3] > eraFloor) {
        return overlayEvaluate(c, world);
      }
      return v;
    }
    {
      const head = memos[c >> 3];
      if (head !== 0 && head < wNext && W[head + 2 /* W_NODE */] === c && W[head + 0 /* W_KEY */] === world.key && W[head + 1 /* W_EPOCH */] === overlayEpoch && (world.k === 2 /* WK_PASS */ || memoCheckedAt[head >> 3] === certGen) && frameWorlds.length === 0) {
        return memoVals[W[head + 3 /* W_VAL */]];
      }
    }
    return overlayEvaluate(c, world);
  }
  function worldValueOf(id, world) {
    return (M[id + 0 /* FLAGS */] & 1024 /* K_ATOM */) !== 0 ? resolveAtomInWorld(id, world) : resolveComputedInWorld(id, world);
  }
  function requestWalk(atom2, token) {
    pendingWalks.push(atom2, token);
  }
  function decide(w, token, entangled) {
    const meta = metas[w >> 3];
    if (meta === void 0 || meta.watchedId === void 0 || (M[w + 0 /* FLAGS */] & 16384 /* K_WATCHER */) === 0) {
      return;
    }
    const nodeId = meta.watchedId;
    const world = token === 0 ? W0_WORLD : writerWorld(token);
    const v = worldValueOf(nodeId, world);
    const lb = meta.lastBroadcast;
    const baseline = lb.has(token) ? lb.get(token) : worldValueOf(nodeId, W0_WORLD);
    if (!valEq(equalityOf(nodeId), baseline, v)) {
      lb.set(token, v);
      const ev = {
        watcherId: w,
        token,
        value: v,
        forkBatchDuringCallback: entangled && fork !== void 0 ? fork.getCurrentWriteBatch() : 0
      };
      if (tracer !== void 0) {
        tracer.emit(9 /* BROADCAST */, w, token);
      }
      broadcastLog.push(ev);
      meta.onBroadcast?.(ev);
    }
  }
  function decideEntangled(w, token) {
    if (fork !== void 0 && (token & 1) === 1) {
      if (!fork.runInBatch(token, () => decide(w, token, true))) {
        decide(w, token, false);
      }
    } else {
      decide(w, token, false);
    }
  }
  function clearWatcherStale(w) {
    if ((M[w + 0 /* FLAGS */] & 16384 /* K_WATCHER */) !== 0) {
      M[w + 0 /* FLAGS */] &= ~(16 /* DIRTY */ | 32 /* PENDING */ | 8 /* RECURSED */);
    }
  }
  function revalidateSlotChain(slot) {
    const token = batchToken[slot];
    if (token === 0 || slotMemoHead[slot] === 0) {
      return;
    }
    const world = writerWorld(token);
    const entries = [];
    for (let rec = slotMemoHead[slot]; rec !== 0; rec = W[rec + 5 /* W_SLOT_NEXT */]) {
      const node = W[rec + 2 /* W_NODE */];
      if (node === 0 || (M[node + 0 /* FLAGS */] & 2048 /* K_COMPUTED */) === 0 || W[rec + 1 /* W_EPOCH */] === 0) {
        continue;
      }
      entries.push({
        node,
        wasValid: W[rec + 1 /* W_EPOCH */] === overlayEpoch && (memoCheckedAt[rec >> 3] === certGen || certValid(rec)),
        snapshot: memoVals[W[rec + 3 /* W_VAL */]]
      });
    }
    const seen = /* @__PURE__ */ new Set();
    for (const { node, wasValid, snapshot } of entries) {
      if (seen.has(node)) {
        continue;
      }
      seen.add(node);
      if (wasValid) {
        continue;
      }
      const fresh = resolveComputedInWorld(node, world);
      if (!valEq(equalityOf(node), snapshot, fresh)) {
        let lnk = M[node + 3 /* SUBS */];
        while (lnk !== 0) {
          const sub = M[lnk + 2 /* SUB */];
          if ((M[sub + 0 /* FLAGS */] & (256 /* IMMEDIATE */ | 16384 /* K_WATCHER */)) === (256 /* IMMEDIATE */ | 16384 /* K_WATCHER */)) {
            decideEntangled(sub, token);
          }
          lnk = M[lnk + 4 /* NEXT_SUB */];
        }
      }
    }
  }
  function revalidateLiveDeferredChains() {
    let m = liveDeferredMask & ~retiredSlotMask & slotChainMask;
    while (m !== 0) {
      const bit = m & -m;
      revalidateSlotChain(31 - Math.clz32(bit));
      m &= m - 1;
    }
  }
  function drainAll(fullRevalidation) {
    if (drainDepth > 0) {
      return;
    }
    if (fullRevalidation && kernelBroadcasts.length === 0 && pendingWalks.length === 0) {
      ++drainDepth;
      try {
        revalidateLiveDeferredChains();
      } finally {
        --drainDepth;
      }
      if (pendingWalks.length === 0 && kernelBroadcasts.length === 0) {
        return;
      }
      fullRevalidation = false;
    }
    if (!fullRevalidation && kernelBroadcasts.length === 0 && pendingWalks.length === 2) {
      const atom2 = pendingWalks[0];
      const token = pendingWalks[1];
      pendingWalks.length = 0;
      ++drainDepth;
      try {
        fastCollect.length = 0;
        notifyWalkFromAtom(atom2, ++walkCounter, true, fastCollect);
        if (tracer !== void 0) {
          tracer.emit(8 /* NOTIFY_WALK */, atom2, token, walkCounter, 1, fastCollect.length);
        }
        if (token === 0) {
          revalidateLiveDeferredChains();
        } else if ((token & 1) === 1) {
          const s2 = findLiveSlot(token);
          if (s2 >= 0) {
            revalidateSlotChain(s2);
          }
        }
        if (fastCollect.length !== 0) {
          if (token === 0) {
            const expansion = liveDeferredTokens();
            for (let i = 0; i < fastCollect.length; ++i) {
              const w = fastCollect[i];
              decide(w, 0, false);
              for (const t of expansion) {
                decideEntangled(w, t);
              }
              clearWatcherStale(w);
            }
          } else if ((token & 1) === 1 && fork !== void 0) {
            const ws = fastCollect.slice();
            const group = () => {
              for (const w of ws) {
                decide(w, token, true);
                clearWatcherStale(w);
              }
            };
            if (!fork.runInBatch(token, group)) {
              for (const w of ws) {
                decide(w, token, false);
                clearWatcherStale(w);
              }
            }
          } else {
            for (let i = 0; i < fastCollect.length; ++i) {
              decide(fastCollect[i], token, false);
              clearWatcherStale(fastCollect[i]);
            }
          }
        }
      } finally {
        --drainDepth;
      }
      if (pendingWalks.length === 0 && kernelBroadcasts.length === 0) {
        return;
      }
    }
    ++drainDepth;
    try {
      let force = fullRevalidation;
      do {
        const collected = /* @__PURE__ */ new Map();
        let any = false;
        if (kernelBroadcasts.length !== 0) {
          any = true;
          const zero = [];
          for (const w of kernelBroadcasts) {
            if (!zero.includes(w)) {
              zero.push(w);
            }
          }
          kernelBroadcasts.length = 0;
          collected.set(0, zero);
        }
        if (pendingWalks.length !== 0) {
          any = true;
          const walks = pendingWalks.splice(0, pendingWalks.length);
          const groups = /* @__PURE__ */ new Map();
          for (let i = 0; i < walks.length; i += 2) {
            let g = groups.get(walks[i + 1]);
            if (g === void 0) {
              groups.set(walks[i + 1], g = []);
            }
            g.push(walks[i]);
          }
          for (const [token, atoms] of groups) {
            const t = ++walkCounter;
            let into = collected.get(token);
            if (into === void 0) {
              collected.set(token, into = []);
            }
            for (const a of atoms) {
              notifyWalkFromAtom(a, t, true, into);
            }
            if (tracer !== void 0) {
              tracer.emit(8 /* NOTIFY_WALK */, atoms[0] ?? 0, token, t, atoms.length, into.length);
            }
          }
        }
        if (!any && !force) {
          break;
        }
        const urgentPresent = collected.has(0) || force;
        force = false;
        const revalidated = /* @__PURE__ */ new Set();
        if (urgentPresent) {
          for (let s = 0; s < 32; ++s) {
            if ((liveDeferredMask >> s & 1) !== 0 && (retiredSlotMask >> s & 1) === 0) {
              revalidateSlotChain(s);
              revalidated.add(s);
            }
          }
        }
        for (const token of collected.keys()) {
          if (token !== 0 && (token & 1) === 1) {
            const s = findLiveSlot(token);
            if (s >= 0 && !revalidated.has(s)) {
              revalidateSlotChain(s);
              revalidated.add(s);
            }
          }
        }
        const expansion = urgentPresent ? liveDeferredTokens() : [];
        for (const [token, watchers] of collected) {
          if (token === 0) {
            for (const w of watchers) {
              decide(w, 0, false);
              for (const t of expansion) {
                decideEntangled(w, t);
              }
              clearWatcherStale(w);
            }
          } else if ((token & 1) === 1 && fork !== void 0) {
            const group = () => {
              for (const w of watchers) {
                decide(w, token, true);
                clearWatcherStale(w);
              }
            };
            if (!fork.runInBatch(token, group)) {
              for (const w of watchers) {
                decide(w, token, false);
                clearWatcherStale(w);
              }
            }
          } else {
            for (const w of watchers) {
              decide(w, token, false);
              clearWatcherStale(w);
            }
          }
        }
      } while (pendingWalks.length !== 0 || kernelBroadcasts.length !== 0);
    } finally {
      --drainDepth;
    }
  }
  function evalOp(a, op, payload, cur) {
    if (op === 1 /* OP_SET */) {
      return payload;
    }
    if (op === 2 /* OP_UPDATE */) {
      return payload(cur);
    }
    return metas[a >> 3].reducer(cur, payload);
  }
  function writeOp(a, op, payload) {
    if (readCtx === 2 /* CTX_RENDER */ && passExecuting !== 0) {
      throw new Error("cosignal: writes during render are not allowed (\xA710.8)");
    }
    if (frameWorlds.length > 0 && frameWorlds[frameWorlds.length - 1].k === 2 /* WK_PASS */) {
      throw new Error("cosignal: writes during render-world evaluation are not allowed (\xA710.8)");
    }
    if (forbidWritesInComputeds && canonicalEvalDepth > 0) {
      throw new Error("cosignal: writes inside computeds are forbidden (configure.forbidWritesInComputeds, \xA712.5)");
    }
    if (writeMode === 0 /* MODE_DIRECT */) {
      const cur = pendingValueOf(a);
      const next = evalOp(a, op, payload, cur);
      if (valEq(equalityOf(a), cur, next)) {
        return;
      }
      if (kernelWriteAtom(a, next) && batchDepth === 0) {
        flush();
      }
      topLevelSettle();
      return;
    }
    const f = fork;
    if (f === void 0) {
      throw new Error("cosignal: LOGGED mode without an attached fork");
    }
    const token = f.getCurrentWriteBatch();
    const deferred = (token & 1) === 1;
    if (M[a + 6 /* LOG_HEAD */] === 0) {
      const cur = pendingValueOf(a);
      const next = op === 1 /* OP_SET */ ? payload : evalOp(a, op, payload, cur);
      if (valEq(equalityOf(a), cur, next)) {
        return;
      }
    }
    let slot = internSlot(token);
    let pseudo = false;
    let applied = !deferred;
    if (slot < 0) {
      pseudo = true;
      applied = true;
      slot = 0;
    }
    appendLog(a, op, payload, applied, slot, pseudo);
    if (tracer !== void 0) {
      tracer.emit(1 /* ATOM_WRITE */, a, token, op, applied ? 1 : 0, seqCounter);
    }
    if (applied) {
      const cur = pendingValueOf(a);
      const next = op === 1 /* OP_SET */ ? payload : evalOp(a, op, payload, cur);
      if (!valEq(equalityOf(a), cur, next)) {
        if (kernelWriteAtom(a, next) && batchDepth === 0) {
          flush();
        }
      }
      if (M[a + 3 /* SUBS */] !== 0 || (liveDeferredMask & ~retiredSlotMask & slotChainMask) !== 0) {
        requestWalk(a, 0);
      }
    } else {
      notifyWalkFromAtom(a, ++walkCounter, false, void 0, true);
      if (M[a + 3 /* SUBS */] !== 0 || slotMemoHead[slot] !== 0) {
        requestWalk(a, token);
      }
    }
    topLevelSettle();
  }
  function topLevelSettle() {
    if (batchDepth !== 0 || canonicalEvalDepth !== 0 || runDepth !== 0 || drainDepth !== 0) {
      return;
    }
    if (queuedLength > notifyIndex) {
      flush();
    }
    if (pendingWalks.length !== 0 || kernelBroadcasts.length !== 0) {
      drainAll(false);
    }
    if (enterDepth === 0) {
      if (sweepNeeded) {
        sweepNeeded = false;
        sweepLogs();
        tryQuiescence();
      }
      maybeBoundary();
    }
  }
  function onBatchRetiredEdge(token, _committed) {
    const slot = findLiveSlot(token);
    if (slot < 0) {
      return;
    }
    ++overlayEpoch;
    ++certGen;
    const rt = ticket();
    if (tracer !== void 0) {
      tracer.emit(5 /* BATCH_RETIRED */, 0, token, rt, _committed ? 1 : 0);
    }
    ++batchDepth;
    try {
      for (let i = 0; i < loggedAtoms.length; ++i) {
        const a = loggedAtoms[i];
        let touched = false;
        let rec = G[M[a + 6 /* LOG_HEAD */] + 0 /* L_NEXT */];
        while (rec !== 0) {
          const m = G[rec + 1 /* L_META */];
          if ((m >> 4 /* SLOT_SHIFT */ & 31 /* SLOT_MASK */) === slot && (m & (512 /* M_PSEUDO */ | 8 /* M_RETIRED */)) === 0) {
            G[rec + 1 /* L_META */] = m | 8 /* M_RETIRED */;
            G[rec + 3 /* L_RETIRED_SEQ */] = rt;
            if ((m & 4 /* M_APPLIED */) === 0) {
              --unappliedEntries;
              const n = (atomUnapplied.get(a) ?? 0) - 1;
              if (n <= 0) {
                atomUnapplied.delete(a);
              } else {
                atomUnapplied.set(a, n);
              }
            }
            touched = true;
          }
          rec = G[rec + 0 /* L_NEXT */];
        }
        if (touched) {
          const fold = foldTape(a, W0_WORLD);
          if (!valEq(equalityOf(a), pendingValueOf(a), fold)) {
            kernelWriteAtom(a, fold);
            if (tracer !== void 0) {
              tracer.emit(6 /* ABSORB */, a, token, 1);
            }
          } else if (tracer !== void 0) {
            tracer.emit(6 /* ABSORB */, a, token, 0);
          }
          if (M[a + 3 /* SUBS */] !== 0 || (liveDeferredMask & ~retiredSlotMask & slotChainMask) !== 0) {
            requestWalk(a, 0);
          }
        }
      }
    } finally {
      --batchDepth;
    }
    if (batchDepth === 0) {
      flush();
    }
    retiredSlotMask |= 1 << slot;
    liveDeferredMask &= ~(1 << slot);
    if (rootViews.size !== 0)
      for (const view of rootViews.values()) {
        if ((view.mask >> slot & 1) !== 0) {
          view.mask &= ~(1 << slot);
          if (view.pin < rt) {
            view.pin = rt;
          }
        }
      }
    releaseSlotIfDone(slot);
    sweepNeeded = true;
    drainAll(true);
    sweepLogs();
    tryQuiescence();
  }
  function truncateBatch(token) {
    const slot = findLiveSlot(token);
    if (slot < 0) {
      return;
    }
    ++overlayEpoch;
    ++certGen;
    if (tracer !== void 0) {
      tracer.emit(4 /* TRUNCATE */, 0, token);
    }
    for (let i = 0; i < loggedAtoms.length; ++i) {
      const a = loggedAtoms[i];
      const head = M[a + 6 /* LOG_HEAD */];
      let prev = head;
      let rec = G[head + 0 /* L_NEXT */];
      let touched = false;
      while (rec !== 0) {
        const m = G[rec + 1 /* L_META */];
        const next = G[rec + 0 /* L_NEXT */];
        if ((m >> 4 /* SLOT_SHIFT */ & 31 /* SLOT_MASK */) === slot && (m & (512 /* M_PSEUDO */ | 8 /* M_RETIRED */ | 4 /* M_APPLIED */)) === 0) {
          G[prev + 0 /* L_NEXT */] = next;
          if (M[a + 7 /* LOG_TAIL */] === rec) {
            M[a + 7 /* LOG_TAIL */] = prev;
          }
          --unappliedEntries;
          {
            const n = (atomUnapplied.get(a) ?? 0) - 1;
            if (n <= 0) {
              atomUnapplied.delete(a);
            } else {
              atomUnapplied.set(a, n);
            }
          }
          --batchEntryCount[slot];
          freeLog(rec);
          touched = true;
        } else {
          prev = rec;
        }
        rec = next;
      }
      if (touched) {
        requestWalk(a, token);
      }
    }
    releaseSlotIfDone(slot);
    sweepNeeded = true;
    if (batchToken[slot] === token) {
      revalidateSlotChain(slot);
    }
    drainAll(false);
    if (enterDepth === 0 && drainDepth === 0) {
      sweepLogs();
      tryQuiescence();
    }
  }
  function sweepLogs() {
    let moved = false;
    const minPin = passOpen !== 0 ? passPin : 2147483647 /* MAX_SEQ */;
    for (let i = loggedAtoms.length - 1; i >= 0; --i) {
      const a = loggedAtoms[i];
      const head = M[a + 6 /* LOG_HEAD */];
      const eq = equalityOf(a);
      let rec = G[head + 0 /* L_NEXT */];
      while (rec !== 0) {
        const m = G[rec + 1 /* L_META */];
        if ((m & 8 /* M_RETIRED */) === 0 || G[rec + 3 /* L_RETIRED_SEQ */] > minPin) {
          break;
        }
        const folded = applyLogOp(a, rec, logVals[head >> 2]);
        if (!valEq(eq, logVals[head >> 2], folded)) {
          logVals[head >> 2] = folded;
        }
        G[head + 2 /* L_SEQ */] = G[rec + 3 /* L_RETIRED_SEQ */];
        G[head + 3 /* L_RETIRED_SEQ */] = G[rec + 3 /* L_RETIRED_SEQ */];
        if ((m & 512 /* M_PSEUDO */) === 0) {
          const slot = m >> 4 /* SLOT_SHIFT */ & 31 /* SLOT_MASK */;
          --batchEntryCount[slot];
          releaseSlotIfDone(slot);
        }
        const next = G[rec + 0 /* L_NEXT */];
        freeLog(rec);
        G[head + 0 /* L_NEXT */] = next;
        if (next === 0) {
          M[a + 7 /* LOG_TAIL */] = head;
        }
        moved = true;
        rec = next;
      }
      if (G[head + 0 /* L_NEXT */] === 0 && (liveSlotMask & ~retiredSlotMask) === 0 && passOpen === 0) {
        freeLog(head);
        M[a + 6 /* LOG_HEAD */] = 0;
        M[a + 7 /* LOG_TAIL */] = 0;
        M[a + 0 /* FLAGS */] &= ~128 /* LOGGED */;
        loggedAtoms[i] = loggedAtoms[loggedAtoms.length - 1];
        loggedAtoms.pop();
        --loggedAtomCount;
        moved = true;
      }
    }
    if (moved) {
      ++certGen;
    }
  }
  function tryQuiescence() {
    if (loggedAtomCount !== 0 || passOpen !== 0 || liveSlotMask !== 0 || pendingWalks.length !== 0 || kernelBroadcasts.length !== 0 || drainDepth !== 0 || enterDepth !== 0) {
      return;
    }
    gNext = 4;
    logFreeHead = 0;
    if (wNext !== 8) {
      wNext = 8;
      certNext = 2;
      memoVals.length = 0;
      slotMemoHead.fill(0);
    }
    slotChainMask = 0;
    eraFloor = walkCounter;
    if (atomUnapplied.size !== 0) {
      atomUnapplied.clear();
    }
    if (rootViews.size !== 0) {
      for (const view of rootViews.values()) {
        view.pin = 0;
        view.mask = 0;
      }
    }
    ++overlayEpoch;
    seqCounter = 1;
    ++certGen;
    ++quiescenceCount;
    if (tracer !== void 0) {
      tracer.emit(13 /* QUIESCENCE */, 0, 0, quiescenceCount);
    }
    if (walkCounter > 1 << 30) {
      for (let i = 0; i < allNodes.length; ++i) {
        const id = allNodes[i];
        if ((M[id + 0 /* FLAGS */] & (2048 /* K_COMPUTED */ | 4096 /* K_EFFECT */ | 8192 /* K_SCOPE */ | 16384 /* K_WATCHER */)) !== 0) {
          M[id + 6 /* OVERLAY_STAMP */] = 0;
          unappliedStamp[id >> 3] = 0;
        }
      }
      walkCounter = 0;
      eraFloor = 0;
    }
  }
  function onPassStartEdge(container, tokens, lineage) {
    passOpen = 1;
    passExecuting = 1;
    ++passSerial;
    passPin = seqCounter;
    let mask = 0;
    for (const t of tokens) {
      const s = findLiveSlot(t);
      if (s >= 0) {
        mask |= 1 << s;
      }
    }
    passIncludeMask = mask;
    passContainer = container;
    passLineage = lineage;
    passWorld = {
      k: 2 /* WK_PASS */,
      key: passSerial << 2 | 1 | 0,
      token: 0,
      slot: -1,
      pin: passPin,
      mask
    };
    readCtx = 2 /* CTX_RENDER */;
    if (tracer !== void 0) {
      tracer.emit(10 /* RENDER_PASS_START */, 0, mask, passPin, lineage);
    }
  }
  function onPassEndEdge() {
    if (tracer !== void 0) {
      tracer.emit(11 /* RENDER_PASS_END */, 0, passIncludeMask);
    }
    passOpen = 0;
    passExecuting = 0;
    passContainer = void 0;
    readCtx = 1 /* CTX_NEWEST */;
    sweepNeeded = true;
    sweepLogs();
    tryQuiescence();
  }
  function attachFork(f) {
    if (fork !== void 0) {
      throw new Error("cosignal: fork already attached");
    }
    fork = f;
    const listener = {
      onRootRegistered: () => {
        writeMode = 1 /* MODE_LOGGED */;
      },
      onRenderPassStart: (c, tokens, lineage) => onPassStartEdge(c, tokens, lineage),
      onRenderPassYield: () => {
        passExecuting = 0;
        readCtx = 1 /* CTX_NEWEST */;
      },
      onRenderPassResume: () => {
        passExecuting = 1;
        readCtx = 2 /* CTX_RENDER */;
      },
      onRenderPassEnd: () => onPassEndEdge(),
      onBatchCommitted: (container, token) => {
        let view = rootViews.get(container);
        if (view === void 0) {
          rootViews.set(container, view = { pin: 0, mask: 0 });
        }
        view.pin = ticket();
        const slot = findLiveSlot(token);
        if (slot >= 0) {
          view.mask |= 1 << slot;
        }
        for (const cb of commitListeners) {
          cb(container);
        }
      },
      onBatchRetired: (token, committed) => onBatchRetiredEdge(token, committed)
      // onBatchOpened (coordinator resolution 6): variant A's monotonic
      // gate does not consume it.
    };
    unsubscribeFork = f.subscribeToExternalRuntime(listener);
    return () => {
      unsubscribeFork?.();
      unsubscribeFork = void 0;
      fork = void 0;
    };
  }
  function readAtomPublic(a) {
    if (canonicalEvalDepth > 0) {
      return kernelReadAtom(a);
    }
    if (frameWorlds.length > 0) {
      return overlayReadAtom(a);
    }
    if ((M[a + 0 /* FLAGS */] & 128 /* LOGGED */) === 0 && readCtx !== 2 /* CTX_RENDER */) {
      return kernelReadAtom(a);
    }
    const v = resolveAtomInWorld(a, ambientWorld());
    if (activeSub !== 0 && readCtx !== 2 /* CTX_RENDER */) {
      link(a, activeSub, cycle);
    }
    return v;
  }
  function readComputedPublic(c) {
    if (canonicalEvalDepth > 0) {
      return kernelComputedRead(c);
    }
    if (frameWorlds.length > 0) {
      return overlayEvaluate(c, frameWorlds[frameWorlds.length - 1]);
    }
    if (loggedAtomCount === 0 && readCtx !== 2 /* CTX_RENDER */) {
      return kernelComputedRead(c);
    }
    const v = resolveComputedInWorld(c, ambientWorld());
    if (activeSub !== 0 && readCtx !== 2 /* CTX_RENDER */) {
      link(c, activeSub, cycle);
    }
    return v;
  }
  function newEffectNode(fn) {
    const e = allocNode(4096 /* K_EFFECT */ | 2 /* WATCHING */ | 4 /* RECURSED_CHECK */ | 512 /* LIVE */);
    fns[e >> 3] = fn;
    const prevSub = activeSub;
    activeSub = e;
    if (prevSub !== 0) {
      link(e, prevSub, 0);
      M[prevSub + 0 /* FLAGS */] |= 64 /* HAS_CHILD_EFFECT */;
    }
    ++enterDepth;
    try {
      ++runDepth;
      values[(e >> 2) + 1] = fn();
    } finally {
      --runDepth;
      --enterDepth;
      activeSub = prevSub;
      M[e + 0 /* FLAGS */] &= ~4 /* RECURSED_CHECK */;
    }
    return e;
  }
  function newScopeNode(fn) {
    const e = allocNode(8192 /* K_SCOPE */ | 1 /* MUTABLE */ | 512 /* LIVE */);
    const prevSub = activeSub;
    activeSub = e;
    if (prevSub !== 0) {
      link(e, prevSub, 0);
      M[prevSub + 0 /* FLAGS */] |= 64 /* HAS_CHILD_EFFECT */;
    }
    ++enterDepth;
    try {
      fn();
    } finally {
      --enterDepth;
      activeSub = prevSub;
    }
    return e;
  }
  function atom(initial, opts) {
    maybeBoundary();
    const id = allocNode(1024 /* K_ATOM */ | 1 /* MUTABLE */);
    const v = id >> 2;
    values[v] = initial;
    values[v + 1] = initial;
    if (opts?.isEqual !== void 0 || opts?.label !== void 0 || opts?.observeEffect !== void 0) {
      metas[id >> 3] = {
        isEqual: opts?.isEqual,
        label: opts?.label,
        observeEffect: opts?.observeEffect
      };
    }
    const handle = {
      kind: "atom",
      id,
      get state() {
        return readAtomPublic(id);
      },
      peek() {
        const s = activeSub;
        activeSub = 0;
        try {
          return resolveAtomInWorld(id, ambientWorld());
        } finally {
          activeSub = s;
        }
      },
      set(next) {
        writeOp(id, 1 /* OP_SET */, next);
      },
      update(fn) {
        writeOp(id, 2 /* OP_UPDATE */, fn);
      }
    };
    registerHandle(handle, id);
    return handle;
  }
  function reducerAtom(initial, reducer, opts) {
    maybeBoundary();
    const id = allocNode(1024 /* K_ATOM */ | 1 /* MUTABLE */);
    const v = id >> 2;
    values[v] = initial;
    values[v + 1] = initial;
    metas[id >> 3] = {
      isEqual: opts?.isEqual,
      label: opts?.label,
      reducer
    };
    const handle = {
      kind: "reducerAtom",
      id,
      get state() {
        return readAtomPublic(id);
      },
      peek() {
        const s = activeSub;
        activeSub = 0;
        try {
          return resolveAtomInWorld(id, ambientWorld());
        } finally {
          activeSub = s;
        }
      },
      dispatch(action) {
        writeOp(id, 3 /* OP_DISPATCH */, action);
      }
    };
    registerHandle(handle, id);
    return handle;
  }
  function computed(fn, opts) {
    maybeBoundary();
    const id = allocNode(2048 /* K_COMPUTED */);
    const isEqual = opts?.isEqual;
    metas[id >> 3] = { isEqual, label: opts?.label, rawFn: fn };
    fns[id >> 3] = opts?.kernelFn !== void 0 ? opts.kernelFn : isEqual === void 0 ? fn : (prev) => {
      const next = fn();
      return prev !== void 0 && isEqual(prev, next) ? prev : next;
    };
    const handle = {
      kind: "computed",
      id,
      get state() {
        return readComputedPublic(id);
      }
    };
    registerHandle(handle, id);
    return handle;
  }
  function watch(target, onBroadcast) {
    maybeBoundary();
    const targetId = target.id;
    const w = allocNode(16384 /* K_WATCHER */ | 2 /* WATCHING */ | 256 /* IMMEDIATE */ | 512 /* LIVE */);
    const meta = { watchedId: targetId, lastBroadcast: /* @__PURE__ */ new Map(), onBroadcast };
    metas[w >> 3] = meta;
    link(targetId, w, 0);
    meta.lastBroadcast.set(0, worldValueOf(targetId, W0_WORLD));
    for (const t of liveDeferredTokens()) {
      meta.lastBroadcast.set(t, worldValueOf(targetId, writerWorld(t)));
    }
    const gen = M[w + 5 /* GEN */];
    return {
      id: w,
      dispose() {
        if (M[w + 5 /* GEN */] === gen) {
          dispose(w);
          maybeBoundary();
        }
      }
    };
  }
  function effect2(fn) {
    maybeBoundary();
    const id = newEffectNode(fn);
    const gen = M[id + 5 /* GEN */];
    topLevelSettle();
    return () => {
      if (M[id + 5 /* GEN */] !== gen) {
        return;
      }
      dispose(id);
      maybeBoundary();
    };
  }
  function effectScope2(fn) {
    maybeBoundary();
    const id = newScopeNode(fn);
    const gen = M[id + 5 /* GEN */];
    topLevelSettle();
    return () => {
      if (M[id + 5 /* GEN */] !== gen) {
        return;
      }
      dispose(id);
      maybeBoundary();
    };
  }
  function batch2(fn) {
    ++batchDepth;
    try {
      return fn();
    } finally {
      if (--batchDepth === 0) {
        topLevelSettle();
      }
    }
  }
  function startBatch2() {
    ++batchDepth;
  }
  function endBatch2() {
    if (--batchDepth === 0) {
      topLevelSettle();
    }
  }
  function untracked2(fn) {
    const prevSub = activeSub;
    activeSub = 0;
    ++untrackedDepth;
    const certBase = certSp;
    try {
      return fn();
    } finally {
      activeSub = prevSub;
      --untrackedDepth;
      certSp = certBase;
    }
  }
  function committedWorldFor(container) {
    if (container === void 0) {
      return COMMITTED_WORLD;
    }
    const view = rootViews.get(container);
    if (view === void 0) {
      return { k: 4 /* WK_COMMITTED */, key: -1, token: 0, slot: -1, pin: 0, mask: 0 };
    }
    return { k: 4 /* WK_COMMITTED */, key: -1, token: 0, slot: -1, pin: view.pin, mask: view.mask };
  }
  function readCommitted(target, container) {
    const prevCtx = readCtx;
    readCtx = 3 /* CTX_COMMITTED */;
    try {
      const id = target.id;
      const world = committedWorldFor(container);
      return (M[id + 0 /* FLAGS */] & 1024 /* K_ATOM */) !== 0 ? resolveAtomInWorld(id, world) : resolveComputedInWorld(id, world);
    } finally {
      readCtx = prevCtx;
    }
  }
  function worldFromSelector(sel) {
    switch (sel.kind) {
      case "w0":
        return W0_WORLD;
      case "newest":
        return NEWEST_WORLD;
      case "committed":
        return COMMITTED_WORLD;
      case "committedOn":
        return committedWorldFor(sel.container);
      case "writer":
        return writerWorld(sel.token);
      case "pass":
        return passWorld;
      case "rendered": {
        let mask = 0;
        for (const t of sel.tokens) {
          const slot = findLiveSlot(t);
          if (slot >= 0) {
            mask |= 1 << slot;
          }
        }
        return { k: 3 /* WK_WRITER */, key: -1, token: 0, slot: -1, pin: sel.pin, mask };
      }
    }
  }
  function verify() {
    const problems = [];
    if (propSp !== 0) problems.push(`propSp=${propSp} (expected 0 at boundary)`);
    if (checkSp !== 0) problems.push(`checkSp=${checkSp}`);
    if (frameWorlds.length !== 0) problems.push(`frameWorlds=${frameWorlds.length}`);
    if (certSp !== 0) problems.push(`certSp=${certSp}`);
    if (eraFloor > walkCounter) problems.push(`eraFloor ${eraFloor} > walkCounter ${walkCounter}`);
    for (let i = 0; i < 8; ++i) {
      if (M[i] !== 0) problems.push(`main-plane record 0 corrupted at +${i}`);
      if (i < 4 && G[i] !== 0) problems.push(`log-plane record 0 corrupted at +${i}`);
      if (W[i] !== 0) problems.push(`memo-plane record 0 corrupted at +${i}`);
    }
    let counted = 0;
    for (const a of loggedAtoms) {
      if ((M[a + 0 /* FLAGS */] & 128 /* LOGGED */) === 0) problems.push(`loggedAtoms holds unlogged ${a}`);
      if (M[a + 6 /* LOG_HEAD */] === 0) problems.push(`logged atom ${a} has no tape`);
      let rec = M[a + 6 /* LOG_HEAD */];
      let steps = 0;
      let last = rec;
      while (rec !== 0 && steps < 1e6) {
        last = rec;
        rec = G[rec + 0 /* L_NEXT */];
        ++steps;
      }
      if (rec !== 0) problems.push(`tape of ${a} appears cyclic`);
      if (M[a + 7 /* LOG_TAIL */] !== last) problems.push(`LOG_TAIL of ${a} incoherent`);
      ++counted;
    }
    if (counted !== loggedAtomCount) problems.push(`loggedAtomCount ${loggedAtomCount} != list ${counted}`);
    for (let s = 0; s < 32; ++s) {
      if (batchEntryCount[s] < 0) problems.push(`batchEntryCount[${s}] negative`);
      if (batchToken[s] === 0 && (liveSlotMask >> s & 1) !== 0) problems.push(`liveSlotMask bit ${s} without token`);
      if (batchToken[s] !== 0 && (liveSlotMask >> s & 1) === 0) problems.push(`token in slot ${s} without mask bit`);
      let rec = slotMemoHead[s];
      let steps = 0;
      while (rec !== 0 && steps < 1e6) {
        if ((W[rec + 0 /* W_KEY */] & 3) !== 2) problems.push(`slot ${s} chain holds non-writer key`);
        rec = W[rec + 5 /* W_SLOT_NEXT */];
        ++steps;
      }
      if (rec !== 0) problems.push(`slot ${s} memo chain cyclic`);
    }
    if (loggedAtomCount === 0 && passOpen === 0 && liveSlotMask === 0 && pendingWalks.length === 0) {
      if (gNext !== 4) problems.push(`quiescent but gNext=${gNext}`);
      if (wNext !== 8) problems.push(`quiescent but wNext=${wNext}`);
      if (certNext !== 2) problems.push(`quiescent but certNext=${certNext}`);
      if (memoVals.length !== 0) problems.push(`quiescent but memoVals=${memoVals.length}`);
      if (seqCounter !== 1) problems.push(`quiescent but seqCounter=${seqCounter}`);
      for (let s = 0; s < 32; ++s) {
        if (slotMemoHead[s] !== 0) problems.push(`quiescent but slotMemoHead[${s}]!=0`);
      }
      for (const id of allNodes) {
        const f = M[id + 0 /* FLAGS */];
        if ((f & (2048 /* K_COMPUTED */ | 4096 /* K_EFFECT */ | 8192 /* K_SCOPE */ | 16384 /* K_WATCHER */)) !== 0 && M[id + 6 /* OVERLAY_STAMP */] > eraFloor) {
          problems.push(`quiescent but node ${id} still marked`);
        }
      }
    }
    if (problems.length > 0) {
      throw new Error("verifyArena: " + problems.join("; "));
    }
  }
  function trackCommitted(container, fn) {
    const world = committedWorldFor(container);
    const prevCtx = readCtx;
    readCtx = 3 /* CTX_COMMITTED */;
    const base = certSp;
    frameWorlds.push(world);
    const prevSub = activeSub;
    activeSub = 0;
    try {
      const value = fn();
      const reads = [];
      for (let i = base; i < certSp; i += 2) {
        if (!reads.includes(certStack[i])) {
          reads.push(certStack[i]);
        }
      }
      return { value, reads };
    } finally {
      activeSub = prevSub;
      frameWorlds.pop();
      certSp = base;
      readCtx = prevCtx;
    }
  }
  function committedValueById(id, container) {
    return worldValueOf(id, committedWorldFor(container));
  }
  function committedEffect(container, fn) {
    let disposed = false;
    let cleanup;
    let deps = /* @__PURE__ */ new Map();
    const runOnce = () => {
      cleanup?.();
      cleanup = void 0;
      const { value, reads } = trackCommitted(container, fn);
      cleanup = value ?? void 0;
      deps = new Map(reads.map((id) => [id, committedValueById(id, container)]));
    };
    const recheck = () => {
      if (disposed) {
        return;
      }
      for (const [id, last] of deps) {
        const cur = committedValueById(id, container);
        if (!valEq(equalityOf(id), last, cur)) {
          runOnce();
          return;
        }
      }
    };
    const onCommit = (c) => {
      if (container === void 0 || c === container) {
        queueMicrotask(recheck);
      }
    };
    commitListeners.add(onCommit);
    runOnce();
    return () => {
      disposed = true;
      commitListeners.delete(onCommit);
      cleanup?.();
      cleanup = void 0;
    };
  }
  function subscribeWithFixup(target, rendered, onSetState) {
    const handle = watch(target, (ev) => onSetState(ev.token, ev.value));
    const meta = metas[handle.id >> 3];
    const lb = meta.lastBroadcast;
    const eq = equalityOf(target.id);
    lb.set(0, rendered.value);
    const nowValue = worldValueOf(
      target.id,
      worldFromSelector({ kind: "rendered", pin: rendered.pin, tokens: rendered.tokens })
    );
    if (!valEq(eq, nowValue, rendered.value)) {
      lb.set(0, nowValue);
      onSetState(0, nowValue);
    }
    for (const t of liveDeferredTokens()) {
      const v = worldValueOf(target.id, writerWorld(t));
      if (!valEq(eq, v, rendered.value)) {
        lb.set(t, v);
        if (fork === void 0 || !fork.runInBatch(t, () => onSetState(t, v))) {
          const fallback = readCommitted(target, rendered.container);
          if (!valEq(eq, fallback, rendered.value)) {
            lb.set(0, fallback);
            onSetState(0, fallback);
          }
        }
      } else {
        lb.set(t, v);
      }
    }
    return handle;
  }
  function configure2(opts) {
    if (opts.forbidWritesInComputeds !== void 0) {
      forbidWritesInComputeds = opts.forbidWritesInComputeds;
    }
  }
  return {
    atom,
    reducerAtom,
    computed,
    watch,
    effect: effect2,
    effectScope: effectScope2,
    batch: batch2,
    startBatch: startBatch2,
    endBatch: endBatch2,
    untracked: untracked2,
    readCommitted,
    truncateBatch,
    attachFork,
    configure: configure2,
    // Flat by-id reads for the policy classes: the class getter → handle
    // getter chain was ~28% of the effect-heavy kairo tick.
    readAtomById: readAtomPublic,
    readComputedById: readComputedPublic,
    trackCommitted,
    committedEffect,
    subscribeWithFixup,
    /**
     * §14.2 deterministic disposal of an atom/computed record (the same
     * path the FinalizationRegistry takes for collected handles).
     */
    reclaim(h) {
      reclaimNode(h.id, M[h.id + 5 /* GEN */]);
    },
    setTracer(t) {
      tracer = t;
    },
    onCommit(cb) {
      commitListeners.add(cb);
      return () => {
        commitListeners.delete(cb);
      };
    },
    // Policy hooks (§12.3 suspense wiring; consumed by src/api.ts only).
    policy: {
      invalidate(h) {
        invalidate(h.id);
        if (batchDepth === 0 && canonicalEvalDepth === 0 && runDepth === 0 && drainDepth === 0) {
          flush();
          drainAll(false);
        }
      },
      bumpOverlayEpoch() {
        ++overlayEpoch;
        ++certGen;
      },
      canonicalValue(h) {
        return values[h.id >> 2];
      },
      evalWorldKind() {
        if (frameWorlds.length > 0) {
          return frameWorlds[frameWorlds.length - 1].k === 2 /* WK_PASS */ ? "pass" : "other";
        }
        return "canonical";
      },
      passLineage() {
        return passLineage;
      },
      isLive(h) {
        return (M[h.id + 0 /* FLAGS */] & 512 /* LIVE */) !== 0;
      }
    },
    debug: {
      verify,
      mode: () => writeMode === 1 /* MODE_LOGGED */ ? "LOGGED" : "DIRECT",
      seqCounter: () => seqCounter,
      epoch: () => overlayEpoch,
      era: () => quiescenceCount,
      loggedAtomCount: () => loggedAtomCount,
      unappliedEntries: () => unappliedEntries,
      liveSlotMask: () => liveSlotMask,
      walkCounter: () => walkCounter,
      eraFloor: () => eraFloor,
      isLogged: (h) => (M[h.id + 0 /* FLAGS */] & 128 /* LOGGED */) !== 0,
      isMarked: (h) => (M[h.id + 0 /* FLAGS */] & 1024 /* K_ATOM */) === 0 && M[h.id + 6 /* OVERLAY_STAMP */] > eraFloor,
      readWorld: (h, sel) => worldValueOf(h.id, worldFromSelector(sel)),
      takeBroadcasts: () => broadcastLog.splice(0, broadcastLog.length),
      quiescent: () => loggedAtomCount === 0 && passOpen === 0 && liveSlotMask === 0,
      planeResidue: () => ({
        g: gNext === 4 && logFreeHead === 0,
        w: wNext === 8 && certNext === 2 && memoVals.length === 0
      }),
      forceWalkCounter: (n) => {
        walkCounter = n;
        if (eraFloor > n) {
          eraFloor = n;
        }
      },
      forceSeqCounter: (n) => {
        seqCounter = n;
      },
      stats: () => ({
        recNext,
        gNext,
        wNext,
        certNext,
        loggedAtomCount,
        liveSlotMask,
        liveDeferredMask,
        retiredSlotMask,
        walkCounter,
        eraFloor,
        overlayEpoch,
        seqCounter,
        passOpen,
        unappliedEntries
      })
    }
  };
}

// src/fork-double.ts
function createForkDouble() {
  const listeners = /* @__PURE__ */ new Set();
  const roots = /* @__PURE__ */ new Set();
  const reportedErrors = [];
  const batches = [];
  const liveByToken = /* @__PURE__ */ new Map();
  let serial = 0;
  let lineageSerial = 0;
  const ctxStack = [];
  let eventBatch;
  let pass;
  function emit(k, a, b, c) {
    for (const l of listeners) {
      const fn = l[k];
      if (fn !== void 0) {
        try {
          fn(a, b, c);
        } catch (err) {
          reportedErrors.push(err);
        }
      }
    }
  }
  function mint(b) {
    if (b._token === 0) {
      if (liveByToken.size >= 31) {
        throw new Error("fork-double: >31 live tokens (violates \xA76.2 liveness invariant)");
      }
      b._token = ++serial << 1 | (b.deferred ? 1 : 0);
      liveByToken.set(b._token, b);
      emit("onBatchOpened", b._token, b.deferred);
    }
    return b._token;
  }
  class BatchState {
    constructor(deferred) {
      this.deferred = deferred;
    }
    deferred;
    _token = 0;
    retired = false;
    committedRootsLazy;
    get committedRoots() {
      return this.committedRootsLazy ??= /* @__PURE__ */ new Set();
    }
    get token() {
      return mint(this);
    }
    get minted() {
      return this._token !== 0;
    }
    run(fn) {
      if (this.retired) {
        throw new Error("fork-double: run() on a retired batch");
      }
      ctxStack.push(this);
      try {
        return fn();
      } finally {
        ctxStack.pop();
      }
    }
    commitOnRoot(container) {
      if (!roots.has(container)) {
        throw new Error("fork-double: commitOnRoot on unregistered root");
      }
      if (this.retired) {
        throw new Error("fork-double: commitOnRoot after retirement");
      }
      const token = mint(this);
      if (this.committedRoots.has(container)) {
        throw new Error("fork-double: duplicate onBatchCommitted for (token, root)");
      }
      this.committedRoots.add(container);
      emit("onBatchCommitted", container, token);
    }
    retire(committed) {
      if (this.retired) {
        throw new Error("fork-double: batch retired twice");
      }
      const token = mint(this);
      if (pass !== void 0 && !pass.ended && pass.included.includes(token)) {
        throw new Error("fork-double: retiring a batch included in the open pass (end the pass first)");
      }
      this.retired = true;
      liveByToken.delete(token);
      if (eventBatch === this) {
        eventBatch = void 0;
      }
      const c = committed ?? (this.committedRootsLazy !== void 0 && this.committedRootsLazy.size > 0);
      emit("onBatchRetired", token, c);
    }
  }
  function makeBatch(deferred) {
    const state = new BatchState(deferred);
    batches.push(state);
    return state;
  }
  const fork = {
    reportedErrors,
    // ---- §6.1 engine-facing surface ------------------------------------
    subscribeToExternalRuntime(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    isCurrentWriteDeferred() {
      const n = ctxStack.length;
      return n !== 0 && ctxStack[n - 1].deferred;
    },
    getCurrentWriteBatch() {
      const n = ctxStack.length;
      if (n !== 0) {
        const top = ctxStack[n - 1];
        return top._token !== 0 ? top._token : mint(top);
      }
      const eb = eventBatch;
      if (eb !== void 0 && !eb.retired && eb._token !== 0) {
        return eb._token;
      }
      if (eventBatch === void 0 || eventBatch.retired) {
        eventBatch = makeBatch(false);
      }
      return mint(eventBatch);
    },
    getRenderContext() {
      return pass !== void 0 && !pass.ended && pass.executing ? { container: pass.container } : void 0;
    },
    runInBatch(token, fn) {
      const b = liveByToken.get(token);
      if (b === void 0 || b.retired) {
        return false;
      }
      ctxStack.push(b);
      try {
        fn();
      } finally {
        ctxStack.pop();
      }
      return true;
    },
    // ---- script controls -------------------------------------------------
    registerRoot(container) {
      if (roots.has(container)) {
        throw new Error("fork-double: root registered twice");
      }
      roots.add(container);
      emit("onRootRegistered", container);
    },
    openBatch(kind) {
      return makeBatch(kind === "deferred");
    },
    mintLineage() {
      return ++lineageSerial;
    },
    currentEventBatch() {
      return eventBatch;
    },
    closeEvent(committed = false) {
      if (eventBatch !== void 0 && !eventBatch.retired) {
        eventBatch.retire(committed);
      }
      eventBatch = void 0;
    },
    startPass(container, opts) {
      if (!roots.has(container)) {
        throw new Error("fork-double: startPass on unregistered root");
      }
      if (pass !== void 0 && !pass.ended) {
        throw new Error("fork-double: a pass is already open (one pass at a time, \xA76.3)");
      }
      const included = [];
      for (const b of opts?.include ?? []) {
        const token = typeof b === "number" ? b : b.token;
        const st = liveByToken.get(token);
        if (st === void 0) {
          throw new Error("fork-double: startPass including unknown/retired token " + token);
        }
        included.push(token);
      }
      for (const st of liveByToken.values()) {
        if (st.committedRootsLazy?.has(container) === true && !included.includes(st.token)) {
          included.push(st.token);
        }
      }
      const lineage = opts?.lineage ?? ++lineageSerial;
      const p = { container, lineage, included, executing: true, ended: false };
      pass = p;
      emit("onRenderPassStart", container, included.slice(), lineage);
      const script = {
        container,
        lineage,
        get includedBatches() {
          return p.included.slice();
        },
        get open() {
          return !p.ended;
        },
        get executing() {
          return !p.ended && p.executing;
        },
        yield() {
          if (p.ended || !p.executing) {
            throw new Error("fork-double: yield on non-executing pass");
          }
          p.executing = false;
          emit("onRenderPassYield", container);
        },
        resume() {
          if (p.ended || p.executing) {
            throw new Error("fork-double: resume on non-yielded pass");
          }
          p.executing = true;
          emit("onRenderPassResume", container);
        },
        end() {
          if (p.ended) {
            throw new Error("fork-double: pass ended twice");
          }
          p.ended = true;
          if (pass === p) {
            pass = void 0;
          }
          emit("onRenderPassEnd", container);
        },
        restart(include) {
          script.end();
          return fork.startPass(container, {
            include: include ?? p.included,
            lineage
            // same work → same lineage (§6.3)
          });
        }
      };
      return script;
    },
    mutationWindow(container, fn) {
      emit("onBeforeMutation", container);
      try {
        fn?.();
      } finally {
        emit("onAfterMutation", container);
      }
    },
    liveTokens() {
      return [...liveByToken.keys()];
    }
  };
  return fork;
}

// src/api.ts
var BOX = /* @__PURE__ */ Symbol("cosignal.box");
function isBox(v) {
  return typeof v === "object" && v !== null && v[BOX] === true;
}
function isErrorBox(v) {
  return typeof v === "object" && v !== null && v[BOX] === true && v.kind === "error";
}
function isSuspendedBox(v) {
  return typeof v === "object" && v !== null && v[BOX] === true && v.kind === "suspended";
}
function errorBox(error) {
  return { [BOX]: true, kind: "error", error };
}
function suspendedBox(thenable) {
  return { [BOX]: true, kind: "suspended", thenable };
}
var SUSPEND = /* @__PURE__ */ Symbol("cosignal.suspend");
function createAPI(engine) {
  const readAtomById = engine.readAtomById;
  const readComputedById = engine.readComputedById;
  class Atom2 {
    handle;
    id;
    constructor(options) {
      this.handle = engine.atom(options.state, {
        isEqual: options.isEqual,
        label: options.label,
        observeEffect: options.effect !== void 0 ? (ctx) => options.effect({
          peek: () => ctx.peek(),
          set: (v) => ctx.set(v),
          update: (f) => ctx.update(f)
        }) : void 0
      });
      this.id = this.handle.id;
    }
    get state() {
      return readAtomById(this.id);
    }
    set(next) {
      this.handle.set(next);
    }
    update(fn) {
      this.handle.update(fn);
    }
  }
  class ReducerAtom2 {
    handle;
    id;
    constructor(options) {
      this.handle = engine.reducerAtom(options.state, options.reducer, {
        isEqual: options.isEqual,
        label: options.label
      });
      this.id = this.handle.id;
    }
    get state() {
      return readAtomById(this.id);
    }
    dispatch(action) {
      this.handle.dispatch(action);
    }
  }
  class Computed2 {
    handle;
    id;
    // §12.3: ONE reused ctx object per computed ("reused ctx object in
    // meta") — the previous per-evaluation ctx/closure allocations were
    // 58% of the kairo-deep tick and most of its GC. Per-eval state lives
    // in instance fields, reset at evaluation entry.
    thenableCache;
    useIndex = 0;
    suspended;
    ctx;
    constructor(options) {
      const userEq = options.isEqual;
      const eq = (a, b) => {
        const ab = isErrorBox(a) || isSuspendedBox(a);
        const bb = isErrorBox(b) || isSuspendedBox(b);
        if (ab || bb) {
          if (!ab || !bb) {
            return false;
          }
          if (isErrorBox(a) && isErrorBox(b)) {
            return Object.is(a.error, b.error);
          }
          if (isSuspendedBox(a) && isSuspendedBox(b)) {
            return Object.is(a.thenable, b.thenable);
          }
          return false;
        }
        return userEq !== void 0 ? userEq(a, b) : Object.is(a, b);
      };
      const self = this;
      this.ctx = {
        get previous() {
          const prev = engine.policy.canonicalValue(self.handle);
          return isErrorBox(prev) || isSuspendedBox(prev) ? void 0 : prev;
        },
        use(thenable) {
          return self.useThenable(thenable);
        }
      };
      const fn = options.fn;
      const evalFn = () => {
        self.useIndex = 0;
        self.suspended = void 0;
        try {
          return fn(self.ctx);
        } catch (e) {
          const prevBox = engine.policy.canonicalValue(self.handle);
          const susp = self.suspended;
          if (e === SUSPEND && susp !== void 0) {
            return isSuspendedBox(prevBox) && Object.is(prevBox.thenable, susp) ? prevBox : suspendedBox(susp);
          }
          return isErrorBox(prevBox) && Object.is(prevBox.error, e) ? prevBox : errorBox(e);
        }
      };
      const kernelFn = (prev) => {
        self.useIndex = 0;
        self.suspended = void 0;
        let next;
        try {
          next = fn(self.ctx);
        } catch (e) {
          const susp = self.suspended;
          if (e === SUSPEND && susp !== void 0) {
            return isSuspendedBox(prev) && Object.is(prev.thenable, susp) ? prev : suspendedBox(susp);
          }
          return isErrorBox(prev) && Object.is(prev.error, e) ? prev : errorBox(e);
        }
        return prev !== void 0 && eq(prev, next) ? prev : next;
      };
      this.handle = engine.computed(evalFn, { isEqual: eq, label: options.label, kernelFn });
      this.id = this.handle.id;
    }
    useThenable(thenable) {
      const kind = engine.policy.evalWorldKind();
      const key = kind === "pass" ? engine.policy.passLineage() : 0;
      const cache = this.thenableCache ??= /* @__PURE__ */ new Map();
      let slots = cache.get(key);
      if (slots === void 0) {
        cache.set(key, slots = []);
      }
      const i = this.useIndex++;
      if (slots[i] === void 0) {
        slots[i] = thenable;
      }
      const th = slots[i];
      if (th.status === void 0) {
        th.status = "pending";
        th.then(
          (v) => {
            th.status = "fulfilled";
            th.value = v;
            this.onSettle(th);
          },
          (r) => {
            th.status = "rejected";
            th.reason = r;
            this.onSettle(th);
          }
        );
      }
      if (th.status === "fulfilled") {
        return th.value;
      }
      if (th.status === "rejected") {
        throw th.reason;
      }
      this.suspended = th;
      throw SUSPEND;
    }
    onSettle(th) {
      queueMicrotask(() => {
        const cached = engine.policy.canonicalValue(this.handle);
        if (isSuspendedBox(cached) && Object.is(cached.thenable, th)) {
          engine.policy.invalidate(this.handle);
        }
        engine.policy.bumpOverlayEpoch();
      });
    }
    get state() {
      const v = readComputedById(this.id);
      if (isBox(v)) {
        if (v.kind === "error") {
          throw v.error;
        }
        throw v.thenable;
      }
      return v;
    }
    /** Non-throwing read: the value or its §11.3 box. */
    get boxed() {
      return readComputedById(this.id);
    }
    /** Drop a retired render lineage's thenable positions (§12.3). */
    dropLineage(lineage) {
      this.thenableCache?.delete(lineage);
    }
  }
  const handleOf = (x) => "handle" in x ? x.handle : x;
  function serializeAtomState(atoms, replacer) {
    const out = {};
    for (const [key, a] of Object.entries(atoms)) {
      const v = engine.readCommitted(handleOf(a));
      out[key] = replacer !== void 0 ? replacer(key, v) : v;
    }
    return JSON.stringify(out);
  }
  function initializeAtomState(json, atoms, reviver) {
    const data = JSON.parse(json);
    for (const [key, raw] of Object.entries(data)) {
      const target = atoms[key];
      if (target === void 0) {
        console.warn(`cosignal: initializeAtomState: unknown key "${key}"`);
        continue;
      }
      const v = reviver !== void 0 ? reviver(key, raw) : raw;
      const settable = "handle" in target ? target.handle : target;
      settable.set(v);
    }
  }
  return {
    Atom: Atom2,
    ReducerAtom: ReducerAtom2,
    Computed: Computed2,
    effect: engine.effect,
    effectScope: engine.effectScope,
    batch: engine.batch,
    untracked: engine.untracked,
    configure: engine.configure,
    serializeAtomState,
    initializeAtomState,
    engine
  };
}

// src/index.ts
var defaultEngine = createCosignalEngine();
var defaultAPI = createAPI(defaultEngine);
var Atom = defaultAPI.Atom;
var ReducerAtom = defaultAPI.ReducerAtom;
var Computed = defaultAPI.Computed;
var effect = defaultAPI.effect;
var effectScope = defaultAPI.effectScope;
var batch = defaultAPI.batch;
var startBatch = defaultEngine.startBatch;
var endBatch = defaultEngine.endBatch;
var untracked = defaultAPI.untracked;
var configure = defaultAPI.configure;
function createServerEngine(options) {
  return createAPI(createCosignalEngine(options));
}
export {
  Atom,
  Computed,
  ReducerAtom,
  TRACE_KIND_NAMES,
  TraceKind,
  batch,
  configure,
  createAPI,
  createCosignalEngine,
  createForkDouble,
  createServerEngine,
  createTracer,
  defaultEngine,
  effect,
  effectScope,
  endBatch,
  isErrorBox,
  isSuspendedBox,
  startBatch,
  untracked
};
