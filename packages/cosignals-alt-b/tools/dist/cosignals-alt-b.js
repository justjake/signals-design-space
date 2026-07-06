// src/engine.ts
var WORLD_NEWEST = { kind: 0 /* NEWEST */, key: 0, pin: 0, mask: 0, slot: -1, token: 0 };
var WORLD_COMMITTED = { kind: 3 /* COMMITTED */, key: -1, pin: 0, mask: 0, slot: -1, token: 0 };
var WORLD_W0 = { kind: 4 /* W0 */, key: -1, pin: 0, mask: 0, slot: -1, token: 0 };
function isErrorBox(v) {
  return typeof v === "object" && v !== null && v.kind === "error" && "error" in v;
}
function isSuspendedBox(v) {
  return typeof v === "object" && v !== null && v.kind === "suspended" && "thenable" in v;
}
var SUSPEND_MARKER = { marker: true };
var recNext = 8;
var nodeFreeHead = 0;
var linkFreeHead = 0;
var gNext = 4;
var gFreeHead = 0;
var wNext = 8;
var certNext = 0;
var cycle = 0;
var runDepth = 0;
var batchDepth = 0;
var notifyIndex = 0;
var queuedLength = 0;
var activeSub = 0;
var queued = [];
var pendingFree = [];
var values = [void 0, void 0];
var fns = [void 0];
var metaCol = [void 0];
var memoHeads = [0];
var logVals = [void 0];
var memoVals = [];
var memoStamp = [];
var tapeStamp = 1;
var worldStamp = 1;
var newestStamp = [0];
var unappliedCount = [0];
var unappliedStamp = [0];
var propStack = new Int32Array(4096);
var propSp = 0;
var checkStack = new Int32Array(4096);
var checkSp = 0;
var certStack = new Int32Array(4096);
var certSp = 0;
var batchTokenTab = new Int32Array(32);
var batchEntryCount = new Int32Array(32);
var slotRetired = new Int32Array(32);
var slotMemoHead = new Int32Array(32);
var liveSlotMask = 0;
var liveDeferredMask = 0;
var unappliedEntries = 0;
var loggedAtomCount = 0;
var seqCounter = 1;
var walkCounter = 0;
var eraFloor = 0;
var overlayEpoch = 1;
var lastToken = 0;
var lastSlot = -1;
var pseudoFallbacks = 0;
var writeMode = 0 /* DIRECT */;
var passOpen = 0;
var passSerial = 0;
var passPin = 0;
var passIncludeMask = 0;
var passContainer = void 0;
var passLineage = 0;
var currentCtx = 0 /* NEWEST */;
var loggedAtoms = [];
var nodeIds = [];
var broadcastQueue = [];
var broadcastLen = 0;
var bcScratch = [];
var pendingWalks = [];
var drainUrgent = false;
var drainDirtySlots = 0;
var drainDepth = 0;
var ovWorld;
var ovDepth = 0;
var tracer;
var currentCause = 0;
var rootCommittedActive = false;
var rootCommittedPin = 0;
var rootCommittedMask = 0;
var captureList;
var traceLog;
function trace(msg) {
  if (traceLog !== void 0) {
    traceLog.push(msg);
  }
}
var fork;
var unsubscribeFork;
var strictLanes = false;
var forbidWritesInComputeds = false;
var replayDepth = 0;
var debugChecks = true;
var finalizationEnabled = true;
var finalizationRegistry;
var finalizeSkipped = /* @__PURE__ */ new Map();
var finalizeRetry = [];
var liveWatcherIds = /* @__PURE__ */ new Set();
var thenableCacheNodes = /* @__PURE__ */ new Set();
var cfgInitialRecords = 8192;
var cfgInitialLogRecords = 1024;
var cfgInitialMemoRecords = 1024;
var thenableStates = /* @__PURE__ */ new WeakMap();
var growPending = false;
var enterDepth = 0;
function createEngineCore(M, G, W, CERT) {
  const WM_M = Math.min(M.length >> 1, M.length - 1280 /* REC_SLACK */ * 8);
  const WM_G = Math.min(G.length >> 1, G.length - 256 * 4);
  const WM_W = Math.min(W.length >> 1, W.length - 256 * 8);
  const WM_CERT = Math.min(CERT.length >> 1, CERT.length - 4096);
  if (recNext > WM_M || gNext > WM_G || wNext > WM_W || certNext > WM_CERT) {
    growPending = true;
  }
  function allocNode(flags) {
    let id;
    if (nodeFreeHead !== 0) {
      id = nodeFreeHead;
      nodeFreeHead = M[id + 1 /* DEPS */];
      M[id + 1 /* DEPS */] = 0;
    } else {
      if (recNext >= M.length) {
        throw new Error(
          "cosignals-alt-b: main plane exhausted mid-operation; raise initialRecords"
        );
      }
      id = recNext;
      recNext = id + 8;
      nodeIds.push(id);
      if (recNext > WM_M) {
        growPending = true;
      }
    }
    M[id + 0 /* FLAGS */] = flags;
    const v = id >> 2;
    while (values.length <= v + 1) {
      values.push(void 0);
    }
    const r = id >> 3;
    while (fns.length <= r) {
      fns.push(void 0);
    }
    while (metaCol.length <= r) {
      metaCol.push(void 0);
    }
    while (memoHeads.length <= r) {
      memoHeads.push(0);
    }
    while (newestStamp.length <= r) {
      newestStamp.push(0);
    }
    while (unappliedCount.length <= r) {
      unappliedCount.push(0);
    }
    while (unappliedStamp.length <= r) {
      unappliedStamp.push(0);
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
    metaCol[id >> 3] = void 0;
    let mrec = memoHeads[id >> 3];
    while (mrec !== 0 && mrec < wNext && W[mrec + 2 /* W_NODE */] === id) {
      W[mrec + 1 /* W_EPOCH */] = 0;
      memoVals[W[mrec + 3 /* W_VAL */]] = void 0;
      mrec = W[mrec + 4 /* W_NEXT_MEMO */];
    }
    memoHeads[id >> 3] = 0;
    newestStamp[id >> 3] = 0;
    unappliedCount[id >> 3] = 0;
    unappliedStamp[id >> 3] = 0;
    if (finalizeSkipped.size !== 0) {
      finalizeSkipped.delete(id);
    }
    thenableCacheNodes.delete(id);
    M[id + 1 /* DEPS */] = nodeFreeHead;
    nodeFreeHead = id;
  }
  function sweepPendingFree() {
    if (queuedLength !== 0 || notifyIndex !== 0) {
      return;
    }
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
      if (recNext >= M.length) {
        throw new Error(
          "cosignals-alt-b: main plane exhausted mid-operation; raise initialRecords"
        );
      }
      id = recNext;
      recNext = id + 8;
      if (recNext > WM_M) {
        growPending = true;
      }
    }
    return id;
  }
  function freeLink(id) {
    M[id + 6 /* NEXT_DEP */] = linkFreeHead;
    linkFreeHead = id;
  }
  function allocLog() {
    let id;
    if (gFreeHead !== 0) {
      id = gFreeHead;
      gFreeHead = G[id + 0 /* L_NEXT */];
    } else {
      if (gNext >= G.length) {
        throw new Error(
          "cosignals-alt-b: log plane exhausted mid-operation; raise initialLogRecords"
        );
      }
      id = gNext;
      gNext = id + 4;
      if (gNext > WM_G) {
        growPending = true;
      }
    }
    G[id + 0 /* L_NEXT */] = 0;
    const r = id >> 2;
    while (logVals.length <= r) {
      logVals.push(void 0);
    }
    return id;
  }
  function freeLogRec(id) {
    logVals[id >> 2] = void 0;
    G[id + 1 /* L_META */] = 0;
    G[id + 2 /* L_SEQ */] = 0;
    G[id + 3 /* L_RETIRED_SEQ */] = 0;
    G[id + 0 /* L_NEXT */] = gFreeHead;
    gFreeHead = id;
  }
  function allocMemo() {
    if (wNext >= W.length) {
      throw new Error(
        "cosignals-alt-b: memo plane exhausted mid-operation; raise initialMemoRecords"
      );
    }
    const id = wNext;
    wNext = id + 8;
    if (wNext > WM_W) {
      growPending = true;
    }
    return id;
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
      setLiveDown(dep);
    }
    if (loggedAtomCount !== 0) {
      const depFlags = M[dep + 0 /* FLAGS */];
      const isAtom = (depFlags & 1024 /* K_ATOM */) !== 0;
      const depMarked = (depFlags & 128 /* LOGGED */) !== 0 || !isAtom && M[dep + 6 /* OVERLAY_STAMP */] > eraFloor;
      const depUnapplied = isAtom ? unappliedCount[dep >> 3] > 0 : unappliedStamp[dep >> 3] > eraFloor;
      if (depMarked && M[sub + 6 /* OVERLAY_STAMP */] <= eraFloor || depUnapplied && unappliedStamp[sub >> 3] <= eraFloor) {
        markCone(
          sub,
          walkCounter === eraFloor ? ++walkCounter : walkCounter,
          depUnapplied
        );
      }
    }
  }
  function setLiveDown(start) {
    const stackBase = propSp;
    let n = start;
    do {
      if ((M[n + 0 /* FLAGS */] & (512 /* LIVE */ | 31744 /* KIND_MASK */)) !== 0 && (M[n + 0 /* FLAGS */] & 512 /* LIVE */) === 0) {
        M[n + 0 /* FLAGS */] |= 512 /* LIVE */;
        onLiveChanged(n);
        let l = M[n + 1 /* DEPS */];
        while (l !== 0) {
          const dep = M[l + 1 /* DEP */];
          if ((M[dep + 0 /* FLAGS */] & 512 /* LIVE */) === 0) {
            if (propSp === propStack.length) {
              const bigger = new Int32Array(propStack.length * 2);
              bigger.set(propStack);
              propStack = bigger;
            }
            propStack[propSp++] = dep;
          }
          l = M[l + 6 /* NEXT_DEP */];
        }
      }
      n = propSp > stackBase ? propStack[--propSp] : 0;
    } while (n !== 0);
    propSp = stackBase;
  }
  function maybeClearLive(start) {
    const stackBase = propSp;
    let n = start;
    do {
      const flags = M[n + 0 /* FLAGS */];
      if ((flags & 512 /* LIVE */) !== 0 && (flags & 31744 /* KIND_MASK */) !== 0 && (flags & (4096 /* K_EFFECT */ | 8192 /* K_SCOPE */ | 16384 /* K_WATCHER */)) === 0) {
        let l = M[n + 3 /* SUBS */];
        let anyLive = false;
        while (l !== 0) {
          if ((M[M[l + 2 /* SUB */] + 0 /* FLAGS */] & 512 /* LIVE */) !== 0) {
            anyLive = true;
            break;
          }
          l = M[l + 4 /* NEXT_SUB */];
        }
        if (!anyLive) {
          M[n + 0 /* FLAGS */] = flags & ~512 /* LIVE */;
          onLiveChanged(n);
          let d = M[n + 1 /* DEPS */];
          while (d !== 0) {
            if (propSp === propStack.length) {
              const bigger = new Int32Array(propStack.length * 2);
              bigger.set(propStack);
              propStack = bigger;
            }
            propStack[propSp++] = M[d + 1 /* DEP */];
            d = M[d + 6 /* NEXT_DEP */];
          }
        }
      }
      n = propSp > stackBase ? propStack[--propSp] : 0;
    } while (n !== 0);
    propSp = stackBase;
  }
  function onLiveChanged(node) {
    const m = metaCol[node >> 3];
    if (m !== void 0 && m.observeEffect !== void 0) {
      scheduleObserveReconcile(node, m);
    }
  }
  function markCone(node, ticket2, unapplied = false) {
    const stackBase = propSp;
    let cur = node;
    do {
      if ((M[cur + 6 /* OVERLAY_STAMP */] !== ticket2 || unapplied && unappliedStamp[cur >> 3] !== ticket2) && (M[cur + 0 /* FLAGS */] & 1024 /* K_ATOM */) === 0) {
        M[cur + 6 /* OVERLAY_STAMP */] = ticket2;
        if (unapplied) {
          unappliedStamp[cur >> 3] = ticket2;
        }
        let l = M[cur + 3 /* SUBS */];
        while (l !== 0) {
          if (propSp === propStack.length) {
            const bigger = new Int32Array(propStack.length * 2);
            bigger.set(propStack);
            propStack = bigger;
          }
          propStack[propSp++] = M[l + 2 /* SUB */];
          l = M[l + 4 /* NEXT_SUB */];
        }
      }
      cur = propSp > stackBase ? propStack[--propSp] : 0;
    } while (cur !== 0);
    propSp = stackBase;
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
      maybeClearLive(dep);
    }
    return nextDep;
  }
  function pushBroadcast(watcher, token) {
    if (broadcastLen + 2 > broadcastQueue.length) {
      broadcastQueue.length = broadcastLen + 2;
    }
    broadcastQueue[broadcastLen] = watcher;
    broadcastQueue[broadcastLen + 1] = token;
    broadcastLen += 2;
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
        if (flags & 256 /* IMMEDIATE */) {
          pushBroadcast(sub, 0);
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
            pushBroadcast(sub, 0);
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
  function notifyWalk(atom, ticket2, token, collect) {
    if (tracer !== void 0) {
      tracer.emit(8 /* NOTIFY_WALK */, currentCause, atom, token, ticket2, collect ? 1 : 0, 0);
    }
    const unapplied = (token & 1) === 1;
    const stackBase = propSp;
    let l = M[atom + 3 /* SUBS */];
    while (l !== 0) {
      if (propSp === propStack.length) {
        const bigger = new Int32Array(propStack.length * 2);
        bigger.set(propStack);
        propStack = bigger;
      }
      propStack[propSp++] = M[l + 2 /* SUB */];
      l = M[l + 4 /* NEXT_SUB */];
    }
    while (propSp > stackBase) {
      const node = propStack[--propSp];
      if (M[node + 6 /* OVERLAY_STAMP */] === ticket2 && (!unapplied || unappliedStamp[node >> 3] === ticket2)) {
        continue;
      }
      M[node + 6 /* OVERLAY_STAMP */] = ticket2;
      if (unapplied) {
        unappliedStamp[node >> 3] = ticket2;
      }
      const flags = M[node + 0 /* FLAGS */];
      if (collect && flags & 256 /* IMMEDIATE */) {
        pushBroadcast(node, token);
      }
      let sl = M[node + 3 /* SUBS */];
      while (sl !== 0) {
        if (propSp === propStack.length) {
          const bigger = new Int32Array(propStack.length * 2);
          bigger.set(propStack);
          propStack = bigger;
        }
        propStack[propSp++] = M[sl + 2 /* SUB */];
        sl = M[sl + 4 /* NEXT_SUB */];
      }
    }
    propSp = stackBase;
  }
  function update(node) {
    const flags = M[node + 0 /* FLAGS */];
    if (flags & 2048 /* K_COMPUTED */) {
      return updateComputed(node);
    }
    if (flags & 1024 /* K_ATOM */) {
      return updateAtom(node);
    }
    M[node + 0 /* FLAGS */] = flags & 31744 /* KIND_MASK */ | 1 /* MUTABLE */;
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
        M[node + 0 /* FLAGS */] = 2048 /* K_COMPUTED */ | 1 /* MUTABLE */ | 16 /* DIRTY */;
        disposeAllDepsInReverse(node);
      }
      noteReclaimRetry(node);
    } else if (flags & 1024 /* K_ATOM */) {
      noteReclaimRetry(node);
    } else if (flags & (4096 /* K_EFFECT */ | 8192 /* K_SCOPE */)) {
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
    M[c + 2 /* DEPS_TAIL */] = 0;
    const stamp = M[c + 6 /* OVERLAY_STAMP */];
    M[c + 0 /* FLAGS */] = 2048 /* K_COMPUTED */ | 1 /* MUTABLE */ | 4 /* RECURSED_CHECK */ | M[c + 0 /* FLAGS */] & 512 /* LIVE */;
    M[c + 6 /* OVERLAY_STAMP */] = stamp;
    const prevSub = activeSub;
    activeSub = c;
    ++enterDepth;
    try {
      ++cycle;
      const v = c >> 2;
      const oldValue = values[v];
      return oldValue !== (values[v] = fns[c >> 3](oldValue));
    } finally {
      --enterDepth;
      activeSub = prevSub;
      M[c + 0 /* FLAGS */] &= ~4 /* RECURSED_CHECK */;
      purgeDeps(c);
    }
  }
  function updateAtom(s) {
    const flags = M[s + 0 /* FLAGS */];
    M[s + 0 /* FLAGS */] = flags & ~(16 /* DIRTY */ | 32 /* PENDING */);
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
      const stamp = M[e + 6 /* OVERLAY_STAMP */];
      M[e + 0 /* FLAGS */] = 4096 /* K_EFFECT */ | 2 /* WATCHING */ | 4 /* RECURSED_CHECK */ | M[e + 0 /* FLAGS */] & 512 /* LIVE */;
      M[e + 6 /* OVERLAY_STAMP */] = stamp;
      const prevSub = activeSub;
      activeSub = e;
      ++enterDepth;
      try {
        ++cycle;
        ++runDepth;
        values[cv] = fns[e >> 3]();
      } finally {
        --enterDepth;
        --runDepth;
        activeSub = prevSub;
        M[e + 0 /* FLAGS */] &= ~4 /* RECURSED_CHECK */;
        purgeDeps(e);
      }
    } else if (M[e + 1 /* DEPS */] !== 0) {
      M[e + 0 /* FLAGS */] = 4096 /* K_EFFECT */ | 2 /* WATCHING */ | flags & (64 /* HAS_CHILD_EFFECT */ | 512 /* LIVE */);
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
    if (flags & 16384 /* K_WATCHER */) {
      liveWatcherIds.delete(e);
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
  function flush() {
    sweepPendingFree();
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
  function invalidate(id) {
    M[id + 0 /* FLAGS */] |= 16 /* DIRTY */;
    const subs = M[id + 3 /* SUBS */];
    if (subs !== 0) {
      propagate(subs, runDepth !== 0);
    }
  }
  function ticket() {
    return ++seqCounter;
  }
  function internSlot(token) {
    if (token === lastToken && lastSlot >= 0 && batchTokenTab[lastSlot] === token) {
      return lastSlot;
    }
    for (let s = 0; s < 32; ++s) {
      if (batchTokenTab[s] === token) {
        lastToken = token;
        lastSlot = s;
        return s;
      }
    }
    for (let s = 0; s < 32; ++s) {
      if (batchTokenTab[s] === 0) {
        batchTokenTab[s] = token;
        batchEntryCount[s] = 0;
        slotRetired[s] = 0;
        slotMemoHead[s] = 0;
        liveSlotMask |= 1 << s;
        if (token & 1) {
          liveDeferredMask |= 1 << s;
        }
        lastToken = token;
        lastSlot = s;
        return s;
      }
    }
    ++pseudoFallbacks;
    return -1;
  }
  function slotOfToken(token) {
    for (let s = 0; s < 32; ++s) {
      if (batchTokenTab[s] === token) {
        return s;
      }
    }
    return -1;
  }
  function releaseSlot(s) {
    let rec = slotMemoHead[s];
    while (rec > 0) {
      const next = W[rec + 5 /* W_SLOT_NEXT */];
      W[rec + 1 /* W_EPOCH */] = 0;
      memoVals[W[rec + 3 /* W_VAL */]] = void 0;
      W[rec + 5 /* W_SLOT_NEXT */] = -1;
      rec = next;
    }
    slotMemoHead[s] = 0;
    batchTokenTab[s] = 0;
    batchEntryCount[s] = 0;
    slotRetired[s] = 0;
    liveSlotMask &= ~(1 << s);
    liveDeferredMask &= ~(1 << s);
    if (lastSlot === s) {
      lastToken = 0;
      lastSlot = -1;
    }
  }
  function createTape(a, unapplied) {
    const base = allocLog();
    const t = ticket();
    G[base + 1 /* L_META */] = 0 /* OP_BASE */ | 8 /* F_RETIRED */;
    G[base + 2 /* L_SEQ */] = t;
    G[base + 3 /* L_RETIRED_SEQ */] = t;
    logVals[base >> 2] = pendingAtomValue(a);
    M[a + 6 /* LOG_HEAD */] = base;
    M[a + 7 /* LOG_TAIL */] = base;
    M[a + 0 /* FLAGS */] |= 128 /* LOGGED */;
    ++tapeStamp;
    ++worldStamp;
    loggedAtoms.push(a);
    ++loggedAtomCount;
    notifyWalk(a, ++walkCounter, unapplied ? 1 : 0, false);
  }
  function appendLogRec(a, op, slot, payload, applied) {
    const rec = allocLog();
    let meta = op | (applied ? 4 /* F_APPLIED */ : 0);
    if (slot >= 0) {
      meta |= slot << 4 /* SLOT_SHIFT */;
    } else {
      meta |= 512 /* F_PSEUDO */ | 4 /* F_APPLIED */ | 8 /* F_RETIRED */;
    }
    G[rec + 1 /* L_META */] = meta;
    const t = ticket();
    G[rec + 2 /* L_SEQ */] = t;
    G[rec + 3 /* L_RETIRED_SEQ */] = slot >= 0 ? 0 : t;
    logVals[rec >> 2] = payload;
    const tail = M[a + 7 /* LOG_TAIL */];
    G[tail + 0 /* L_NEXT */] = rec;
    M[a + 7 /* LOG_TAIL */] = rec;
    ++tapeStamp;
    ++worldStamp;
    if (slot >= 0) {
      ++batchEntryCount[slot];
      if (!applied) {
        ++unappliedEntries;
        ++unappliedCount[a >> 3];
      }
    }
    if (tracer !== void 0) {
      tracer.emit(2 /* LOG_APPEND */, currentCause, a, slot, rec, t, 0);
    }
    return rec;
  }
  function applyOp(a, op, payload, acc) {
    if (op === 1 /* OP_SET */) {
      return payload;
    }
    ++replayDepth;
    ++enterDepth;
    try {
      if (op === 2 /* OP_UPDATE */) {
        return payload(acc);
      }
      const reducer = metaCol[a >> 3]?.reducer;
      if (reducer === void 0) {
        throw new Error("cosignals-alt-b: DISPATCH on an atom with no reducer");
      }
      return reducer(acc, payload);
    } finally {
      --replayDepth;
      --enterDepth;
    }
  }
  function applyLogRec(a, rec, acc) {
    return applyOp(a, G[rec + 1 /* L_META */] & 3 /* OP_MASK */, logVals[rec >> 2], acc);
  }
  function isEqualPolicy(node, x, y) {
    if (Object.is(x, y)) {
      return true;
    }
    const eq = metaCol[node >> 3]?.isEqual;
    return eq !== void 0 && eq(x, y);
  }
  function pendingAtomValue(a) {
    return values[(a >> 2) + 1];
  }
  function kernelAtomValue(a) {
    if (M[a + 0 /* FLAGS */] & 16 /* DIRTY */) {
      if (updateAtom(a)) {
        const subs = M[a + 3 /* SUBS */];
        if (subs !== 0) {
          shallowPropagate(subs);
        }
      }
    }
    return values[a >> 2];
  }
  function kernelWrite(a, value) {
    const p = (a >> 2) + 1;
    if (values[p] !== (values[p] = value)) {
      M[a + 0 /* FLAGS */] |= 16 /* DIRTY */;
      const subs = M[a + 3 /* SUBS */];
      if (subs !== 0) {
        propagate(subs, runDepth !== 0);
        return true;
      }
    }
    return false;
  }
  function kernelComputedRead(c, track) {
    const flags = M[c + 0 /* FLAGS */];
    if (flags & 16 /* DIRTY */ || flags & 32 /* PENDING */ && (checkDirty(M[c + 1 /* DEPS */], c) || (M[c + 0 /* FLAGS */] = flags & ~32 /* PENDING */, false))) {
      if (updateComputed(c)) {
        const subs = M[c + 3 /* SUBS */];
        if (subs !== 0) {
          shallowPropagate(subs);
        }
      }
    } else if (flags === 2048 /* K_COMPUTED */) {
      firstEvalComputed(c);
    }
    if (track && activeSub !== 0) {
      link(c, activeSub, cycle);
    }
    return values[c >> 2];
  }
  function firstEvalComputed(c) {
    const stamp = M[c + 6 /* OVERLAY_STAMP */];
    M[c + 0 /* FLAGS */] = 2048 /* K_COMPUTED */ | 1 /* MUTABLE */ | 4 /* RECURSED_CHECK */ | M[c + 0 /* FLAGS */] & 512 /* LIVE */;
    M[c + 6 /* OVERLAY_STAMP */] = stamp;
    const prevSub = activeSub;
    activeSub = c;
    ++enterDepth;
    try {
      ++cycle;
      values[c >> 2] = fns[c >> 3](void 0);
    } finally {
      --enterDepth;
      activeSub = prevSub;
      M[c + 0 /* FLAGS */] &= ~4 /* RECURSED_CHECK */;
    }
  }
  function visibleIn(rec, world) {
    const meta = G[rec + 1 /* L_META */];
    switch (world.kind) {
      case 0 /* NEWEST */:
        return true;
      case 3 /* COMMITTED */:
        return (meta & 8 /* F_RETIRED */) !== 0;
      case 4 /* W0 */:
        return (meta & (8 /* F_RETIRED */ | 4 /* F_APPLIED */)) !== 0;
      case 1 /* PASS */: {
        if (meta & 8 /* F_RETIRED */ && G[rec + 3 /* L_RETIRED_SEQ */] <= world.pin) {
          return true;
        }
        if (meta & 512 /* F_PSEUDO */) {
          return false;
        }
        const slot = (meta & 496 /* SLOT_MASK */) >> 4 /* SLOT_SHIFT */;
        return (world.mask >>> slot & 1) !== 0 && G[rec + 2 /* L_SEQ */] <= world.pin;
      }
      case 2 /* WRITER */: {
        if (meta & (8 /* F_RETIRED */ | 4 /* F_APPLIED */)) {
          return true;
        }
        if (meta & 512 /* F_PSEUDO */) {
          return false;
        }
        return (meta & 496 /* SLOT_MASK */) >> 4 /* SLOT_SHIFT */ === world.slot;
      }
      case 5 /* CROOT */: {
        if (meta & 8 /* F_RETIRED */ && G[rec + 3 /* L_RETIRED_SEQ */] <= world.pin) {
          return true;
        }
        if (meta & 512 /* F_PSEUDO */) {
          return false;
        }
        return (world.mask >>> ((meta & 496 /* SLOT_MASK */) >> 4 /* SLOT_SHIFT */) & 1) !== 0;
      }
      case 6 /* FIXUP */: {
        if (meta & 8 /* F_RETIRED */) {
          return true;
        }
        if (meta & 512 /* F_PSEUDO */) {
          return false;
        }
        return (world.mask >>> ((meta & 496 /* SLOT_MASK */) >> 4 /* SLOT_SHIFT */) & 1) !== 0 && G[rec + 2 /* L_SEQ */] <= world.pin;
      }
    }
  }
  function foldTape(a, world) {
    const head = M[a + 6 /* LOG_HEAD */];
    let acc = logVals[head >> 2];
    let rec = G[head + 0 /* L_NEXT */];
    while (rec !== 0) {
      if (visibleIn(rec, world)) {
        const next = applyLogRec(a, rec, acc);
        acc = isEqualPolicy(a, acc, next) ? acc : next;
      }
      rec = G[rec + 0 /* L_NEXT */];
    }
    return acc;
  }
  function atomValueInWorld(a, world) {
    if ((M[a + 0 /* FLAGS */] & 128 /* LOGGED */) === 0) {
      return kernelAtomValue(a);
    }
    if (world.kind === 4 /* W0 */) {
      return kernelAtomValue(a);
    }
    return foldTape(a, world);
  }
  function passWorld() {
    return {
      kind: 1 /* PASS */,
      key: passSerial << 2 | 1,
      pin: passPin,
      mask: passIncludeMask,
      slot: -1,
      token: 0
    };
  }
  function writerWorld(token) {
    return {
      kind: 2 /* WRITER */,
      key: token << 2 | 2,
      pin: 0,
      mask: 0,
      slot: slotOfToken(token),
      token
    };
  }
  function worldOfCtx(ctx) {
    if (ctx === 1 /* RENDER */) {
      return passWorld();
    }
    if (ctx === 2 /* COMMITTED */) {
      if (rootCommittedActive) {
        return {
          kind: 5 /* CROOT */,
          key: -1,
          pin: rootCommittedPin,
          mask: rootCommittedMask,
          slot: -1,
          token: 0
        };
      }
      return WORLD_COMMITTED;
    }
    return WORLD_NEWEST;
  }
  function certPush(atomId, seqOrZero) {
    if (certSp + 2 > certStack.length) {
      const bigger = new Int32Array(certStack.length * 2);
      bigger.set(certStack);
      certStack = bigger;
    }
    certStack[certSp] = atomId;
    certStack[certSp + 1] = seqOrZero;
    certSp += 2;
  }
  function atomTailSeqOrZero(a) {
    return M[a + 0 /* FLAGS */] & 128 /* LOGGED */ ? G[M[a + 7 /* LOG_TAIL */] + 2 /* L_SEQ */] : 0;
  }
  function overlayReadAtom(a) {
    certPush(a, atomTailSeqOrZero(a));
    return atomValueInWorld(a, ovWorld);
  }
  function memoLookup(c, key) {
    let rec = memoHeads[c >> 3];
    if (rec !== 0 && (rec >= wNext || W[rec + 2 /* W_NODE */] !== c)) {
      memoHeads[c >> 3] = 0;
      M[c + 7 /* MEMO_KEY */] = 0;
      return 0;
    }
    while (rec !== 0 && rec < wNext && W[rec + 2 /* W_NODE */] === c) {
      if (W[rec + 1 /* W_EPOCH */] !== 0 && W[rec + 0 /* W_KEY */] === key) {
        return rec;
      }
      rec = W[rec + 4 /* W_NEXT_MEMO */];
    }
    return 0;
  }
  function certValid(rec) {
    const vi = W[rec + 3 /* W_VAL */];
    if (memoStamp[vi] === tapeStamp) {
      return true;
    }
    const n = W[rec + 6 /* W_NDEPS */];
    const end = W[rec + 7 /* W_CERT */] + n * 2;
    for (let p = W[rec + 7 /* W_CERT */]; p < end; p += 2) {
      const aid = CERT[p];
      const seq = M[aid + 0 /* FLAGS */] & 128 /* LOGGED */ ? G[M[aid + 7 /* LOG_TAIL */] + 2 /* L_SEQ */] : 0;
      if (seq !== CERT[p + 1]) {
        return false;
      }
    }
    memoStamp[vi] = tapeStamp;
    return true;
  }
  function copyCertRun(rec) {
    const n = W[rec + 6 /* W_NDEPS */];
    const base = W[rec + 7 /* W_CERT */];
    for (let i = 0; i < n; ++i) {
      certPush(CERT[base + i * 2], CERT[base + i * 2 + 1]);
    }
  }
  function writeMemoRecord(c, world, val, certBase) {
    const nPairs = certSp - certBase >> 1;
    if (certNext + nPairs * 2 > CERT.length) {
      throw new Error(
        "cosignals-alt-b: certificate region exhausted mid-operation; raise initialMemoRecords"
      );
    }
    const old = memoLookup(c, world.key);
    if (old !== 0) {
      if (nPairs <= W[old + 6 /* W_NDEPS */]) {
        CERT.set(certStack.subarray(certBase, certSp), W[old + 7 /* W_CERT */]);
      } else {
        CERT.set(certStack.subarray(certBase, certSp), certNext);
        W[old + 7 /* W_CERT */] = certNext;
        certNext += nPairs * 2;
        if (certNext > WM_CERT) {
          growPending = true;
        }
      }
      W[old + 1 /* W_EPOCH */] = overlayEpoch;
      memoVals[W[old + 3 /* W_VAL */]] = val;
      W[old + 6 /* W_NDEPS */] = nPairs;
      memoStamp[W[old + 3 /* W_VAL */]] = tapeStamp;
      M[c + 7 /* MEMO_KEY */] = world.key;
      if (world.kind === 2 /* WRITER */ && world.slot >= 0 && W[old + 5 /* W_SLOT_NEXT */] === -1) {
        W[old + 5 /* W_SLOT_NEXT */] = slotMemoHead[world.slot];
        slotMemoHead[world.slot] = old;
      }
      return old;
    }
    const rec = allocMemo();
    CERT.set(certStack.subarray(certBase, certSp), certNext);
    W[rec + 0 /* W_KEY */] = world.key;
    W[rec + 1 /* W_EPOCH */] = overlayEpoch;
    W[rec + 2 /* W_NODE */] = c;
    const vi = memoVals.length;
    memoVals.push(val);
    memoStamp.push(tapeStamp);
    W[rec + 3 /* W_VAL */] = vi;
    W[rec + 6 /* W_NDEPS */] = nPairs;
    W[rec + 7 /* W_CERT */] = certNext;
    certNext += nPairs * 2;
    if (certNext > WM_CERT) {
      growPending = true;
    }
    const head = memoHeads[c >> 3];
    W[rec + 4 /* W_NEXT_MEMO */] = head !== 0 && rec !== head && W[head + 2 /* W_NODE */] === c ? head : 0;
    memoHeads[c >> 3] = rec;
    M[c + 7 /* MEMO_KEY */] = world.key;
    if (world.kind === 2 /* WRITER */ && world.slot >= 0) {
      W[rec + 5 /* W_SLOT_NEXT */] = slotMemoHead[world.slot];
      slotMemoHead[world.slot] = rec;
    } else {
      W[rec + 5 /* W_SLOT_NEXT */] = -1;
    }
    return rec;
  }
  function overlayEvaluate(c, world) {
    if (world.key !== -1) {
      const head = memoHeads[c >> 3];
      if (head !== 0 && head < wNext && W[head + 2 /* W_NODE */] === c && W[head + 0 /* W_KEY */] === world.key && W[head + 1 /* W_EPOCH */] === overlayEpoch) {
        const vi = W[head + 3 /* W_VAL */];
        if (world.kind === 1 /* PASS */ || memoStamp[vi] === tapeStamp || certValid(head)) {
          if (ovDepth !== 0) {
            copyCertRun(head);
          }
          if (tracer !== void 0) {
            tracer.emit(7 /* COMPUTED_EVAL */, currentCause, c, world.key, 1, 0, 0);
          }
          const hv = memoVals[vi];
          if (world.key === 0) {
            newestStamp[c >> 3] = worldStamp;
            values[(c >> 2) + 1] = hv;
          }
          return hv;
        }
      } else {
        const rec = memoLookup(c, world.key);
        if (rec !== 0 && W[rec + 1 /* W_EPOCH */] === overlayEpoch && (world.kind === 1 /* PASS */ || certValid(rec))) {
          if (ovDepth !== 0) {
            copyCertRun(rec);
          }
          if (tracer !== void 0) {
            tracer.emit(7 /* COMPUTED_EVAL */, currentCause, c, world.key, 1, 0, 0);
          }
          const rv = memoVals[W[rec + 3 /* W_VAL */]];
          if (world.key === 0) {
            newestStamp[c >> 3] = worldStamp;
            values[(c >> 2) + 1] = rv;
          }
          return rv;
        }
      }
    }
    const certBase = certSp;
    const prevWorld = ovWorld;
    ovWorld = world;
    ++ovDepth;
    const prevSub = activeSub;
    activeSub = 0;
    let prevVal;
    if (world.key !== -1) {
      const oldRec = memoLookup(c, world.key);
      prevVal = oldRec !== 0 ? memoVals[W[oldRec + 3 /* W_VAL */]] : void 0;
    }
    let val;
    try {
      val = runComputedFn(c, prevVal, world.kind === 1 /* PASS */ ? passLineage : 0);
    } finally {
      --ovDepth;
      ovWorld = prevWorld;
      activeSub = prevSub;
    }
    if (prevVal !== void 0 && isEqualPolicy(c, prevVal, val)) {
      val = prevVal;
    }
    if (tracer !== void 0) {
      tracer.emit(7 /* COMPUTED_EVAL */, currentCause, c, world.key, 0, certSp - certBase >> 1, 0);
    }
    if (world.key !== -1) {
      writeMemoRecord(c, world, val, certBase);
      if (world.key === 0) {
        newestStamp[c >> 3] = worldStamp;
        values[(c >> 2) + 1] = val;
      }
    }
    if (ovDepth === 0) {
      certSp = 0;
    }
    return val;
  }
  function resolveComputed(c, world, track) {
    if (world.kind === 4 /* W0 */) {
      return kernelComputedRead(c, track);
    }
    if (loggedAtomCount === 0 || M[c + 6 /* OVERLAY_STAMP */] <= eraFloor) {
      const v = kernelComputedRead(c, track);
      const worldSensitive = world.kind !== 0 /* NEWEST */ || unappliedEntries !== 0;
      if (worldSensitive && M[c + 6 /* OVERLAY_STAMP */] > eraFloor) {
        if (world.kind === 0 /* NEWEST */ && unappliedStamp[c >> 3] <= eraFloor) {
          return v;
        }
        return overlayEvaluate(c, world);
      }
      return v;
    }
    if (world.kind === 0 /* NEWEST */) {
      if (unappliedEntries === 0) {
        return kernelComputedRead(c, track);
      }
      if (newestStamp[c >> 3] === worldStamp) {
        return values[(c >> 2) + 1];
      }
      if (unappliedStamp[c >> 3] <= eraFloor) {
        const v = kernelComputedRead(c, track);
        if (unappliedStamp[c >> 3] > eraFloor) {
          return overlayEvaluate(c, world);
        }
        return v;
      }
    }
    return overlayEvaluate(c, world);
  }
  function resolveNode(node, world) {
    if (M[node + 0 /* FLAGS */] & 1024 /* K_ATOM */) {
      return atomValueInWorld(node, world);
    }
    return resolveComputed(node, world, false);
  }
  function stampThenable(t, waiter) {
    let st = thenableStates.get(t);
    if (st === void 0) {
      const state = { status: "pending", waiters: /* @__PURE__ */ new Set() };
      thenableStates.set(t, state);
      st = state;
      t.then(
        (v) => {
          state.status = "fulfilled";
          state.value = v;
          settleTrampoline(t, state);
        },
        (r) => {
          state.status = "rejected";
          state.reason = r;
          settleTrampoline(t, state);
        }
      );
    }
    st.waiters.add(waiter);
    return st;
  }
  function onThenableSettled(t, st) {
    if (loggedAtomCount !== 0) {
      ++overlayEpoch;
      ++worldStamp;
    }
    for (const c of st.waiters) {
      const cached = values[c >> 2];
      if (isSuspendedBox(cached) && cached.thenable === t) {
        invalidate(c);
      }
    }
    st.waiters.clear();
    flush();
    drainAll();
  }
  function runComputedFn(c, prev, cacheKey) {
    const m = metaCol[c >> 3];
    const rawFn = m?.rawFn;
    if (rawFn === void 0) {
      throw new Error("cosignals-alt-b: computed has no fn");
    }
    if (m.wantsCtx !== true) {
      let next2;
      ++enterDepth;
      try {
        next2 = rawFn();
      } catch (e) {
        if (isErrorBox(prev) && Object.is(prev.error, e)) {
          return prev;
        }
        return { kind: "error", error: e };
      } finally {
        --enterDepth;
      }
      if (prev !== void 0 && !isErrorBox(prev) && !isSuspendedBox(prev) && !isErrorBox(next2) && !isSuspendedBox(next2) && isEqualPolicy(c, prev, next2)) {
        return prev;
      }
      return next2;
    }
    let useIndex = 0;
    let suspended;
    const ctx = {
      previous: isErrorBox(prev) || isSuspendedBox(prev) ? void 0 : prev,
      use(thenable) {
        let cache = m.thenableCache;
        if (cache === void 0) {
          cache = m.thenableCache = /* @__PURE__ */ new Map();
          thenableCacheNodes.add(c);
        }
        let arr = cache.get(cacheKey);
        if (arr === void 0) {
          arr = [];
          cache.set(cacheKey, arr);
        }
        const idx = useIndex++;
        const t = arr[idx] ?? (arr[idx] = thenable);
        const st = stampThenable(t, c);
        if (st.status === "fulfilled") {
          return st.value;
        }
        if (st.status === "rejected") {
          throw st.reason;
        }
        suspended = t;
        throw SUSPEND_MARKER;
      }
    };
    let next;
    ++enterDepth;
    try {
      next = rawFn(ctx);
    } catch (e) {
      if (e === SUSPEND_MARKER) {
        if (isSuspendedBox(prev) && prev.thenable === suspended) {
          return prev;
        }
        return { kind: "suspended", thenable: suspended };
      }
      if (isErrorBox(prev) && Object.is(prev.error, e)) {
        return prev;
      }
      return { kind: "error", error: e };
    } finally {
      --enterDepth;
    }
    if (prev !== void 0 && !isErrorBox(prev) && !isSuspendedBox(prev) && !isErrorBox(next) && !isSuspendedBox(next) && isEqualPolicy(c, prev, next)) {
      return prev;
    }
    return next;
  }
  function broadcastEqual(node, a, b) {
    if (Object.is(a, b)) {
      return true;
    }
    if (isErrorBox(a) || isErrorBox(b) || isSuspendedBox(a) || isSuspendedBox(b)) {
      return false;
    }
    return isEqualPolicy(node, a, b);
  }
  function atomWrite(a, op, payload) {
    if (currentCtx === 1 /* RENDER */) {
      throw new Error("cosignals-alt-b: writes during render are forbidden (\xA710.8)");
    }
    if (forbidWritesInComputeds && activeSub !== 0 && (M[activeSub + 0 /* FLAGS */] & 2048 /* K_COMPUTED */) !== 0) {
      throw new Error("cosignals-alt-b: writes inside computeds are forbidden (configure)");
    }
    if (writeMode === 0 /* DIRECT */) {
      const cur = pendingAtomValue(a);
      const next = applyOp(a, op, payload, cur);
      if (isEqualPolicy(a, cur, next)) {
        return;
      }
      if (kernelWrite(a, next) && batchDepth === 0) {
        flush();
        drainAll();
      }
      return;
    }
    const f = fork;
    if (f === void 0) {
      throw new Error("cosignals-alt-b: LOGGED mode without a fork attached");
    }
    const deferred = f.isCurrentWriteDeferred();
    const token = f.getCurrentWriteBatch();
    const slot = internSlot(token);
    const applied = !deferred || slot < 0;
    if (tracer !== void 0) {
      currentCause = tracer.emit(1 /* ATOM_WRITE */, 0, a, token, op, applied ? 1 : 0, 0);
    }
    let coalesced = false;
    if (M[a + 6 /* LOG_HEAD */] === 0) {
      const cur = pendingAtomValue(a);
      const next = applyOp(a, op, payload, cur);
      if (isEqualPolicy(a, cur, next)) {
        return;
      }
      createTape(a, !applied);
    } else if (passOpen === 0 && slot >= 0 && metaCol[a >> 3]?.isEqual === void 0) {
      const tail = M[a + 7 /* LOG_TAIL */];
      const tmeta = G[tail + 1 /* L_META */];
      const tailOp = tmeta & 3 /* OP_MASK */;
      if (tailOp !== 0 /* OP_BASE */ && (tmeta & (8 /* F_RETIRED */ | 512 /* F_PSEUDO */)) === 0 && (tmeta & 496 /* SLOT_MASK */) >> 4 /* SLOT_SHIFT */ === slot && (tmeta & 4 /* F_APPLIED */) !== 0 === applied) {
        if (op === 1 /* OP_SET */) {
          logVals[tail >> 2] = payload;
          G[tail + 2 /* L_SEQ */] = ticket();
          G[tail + 1 /* L_META */] = tmeta & ~3 /* OP_MASK */ | 1 /* OP_SET */;
          ++tapeStamp;
          ++worldStamp;
          coalesced = true;
          if (tracer !== void 0) {
            tracer.emit(3 /* LOG_COALESCE */, currentCause, a, slot, tail, 0, 0);
          }
        } else if (tailOp !== 1 /* OP_SET */) {
          let run2 = 0;
          let rec = G[M[a + 6 /* LOG_HEAD */] + 0 /* L_NEXT */];
          while (rec !== 0) {
            const m = G[rec + 1 /* L_META */];
            if ((m & 512 /* F_PSEUDO */) === 0 && (m & 496 /* SLOT_MASK */) >> 4 /* SLOT_SHIFT */ === slot) {
              ++run2;
            }
            rec = G[rec + 0 /* L_NEXT */];
          }
          if (run2 >= 8) {
            const oldOp = tailOp;
            const oldPayload = logVals[tail >> 2];
            const newOp = op;
            const newPayload = payload;
            const reducer = metaCol[a >> 3]?.reducer;
            logVals[tail >> 2] = (acc) => {
              const mid = oldOp === 2 /* OP_UPDATE */ ? oldPayload(acc) : reducer(acc, oldPayload);
              return newOp === 2 /* OP_UPDATE */ ? newPayload(mid) : reducer(mid, newPayload);
            };
            G[tail + 2 /* L_SEQ */] = ticket();
            G[tail + 1 /* L_META */] = tmeta & ~3 /* OP_MASK */ | 2 /* OP_UPDATE */;
            ++tapeStamp;
            ++worldStamp;
            coalesced = true;
            if (tracer !== void 0) {
              tracer.emit(3 /* LOG_COALESCE */, currentCause, a, slot, tail, 1, 0);
            }
          }
        }
      }
    }
    if (!coalesced) {
      appendLogRec(a, op, slot, payload, applied);
    }
    if (applied) {
      const cur = pendingAtomValue(a);
      const next = applyOp(a, op, payload, cur);
      if (!isEqualPolicy(a, cur, next)) {
        kernelWrite(a, next);
      }
      drainUrgent = true;
      pendingWalks.push(a, 0);
    } else {
      pendingWalks.push(a, token);
      if (slot >= 0) {
        drainDirtySlots |= 1 << slot;
      }
      if (batchDepth !== 0 || drainDepth !== 0) {
        notifyWalk(a, ++walkCounter, 1, false);
      }
    }
    if (batchDepth === 0) {
      drainAll();
    }
  }
  function unretiredDeferredMask() {
    let mask = 0;
    for (let s = 0; s < 32; ++s) {
      if (batchTokenTab[s] !== 0 && slotRetired[s] === 0 && (batchTokenTab[s] & 1) === 1) {
        mask |= 1 << s;
      }
    }
    return mask;
  }
  function drainAll() {
    if (drainDepth !== 0) {
      return;
    }
    drainDepth = 1;
    try {
      let guard = 0;
      while (pendingWalks.length !== 0 || notifyIndex < queuedLength || broadcastLen !== 0 || drainUrgent || drainDirtySlots !== 0) {
        if (++guard > 1e5) {
          throw new Error("cosignals-alt-b: drain did not settle (write storm?)");
        }
        if (pendingWalks.length !== 0) {
          const walks = pendingWalks;
          pendingWalks = [];
          let uniform = true;
          const t0 = walks[1];
          for (let i = 3; i < walks.length; i += 2) {
            if (walks[i] !== t0) {
              uniform = false;
              break;
            }
          }
          if (uniform) {
            const t = ++walkCounter;
            for (let i = 0; i < walks.length; i += 2) {
              notifyWalk(walks[i], t, t0, true);
            }
          } else {
            const byToken = /* @__PURE__ */ new Map();
            for (let i = 0; i < walks.length; i += 2) {
              let atoms = byToken.get(walks[i + 1]);
              if (atoms === void 0) {
                atoms = [];
                byToken.set(walks[i + 1], atoms);
              }
              atoms.push(walks[i]);
            }
            for (const [token, atoms] of byToken) {
              const t = ++walkCounter;
              for (const a of atoms) {
                notifyWalk(a, t, token, true);
              }
            }
          }
        }
        flush();
        const urgent = drainUrgent;
        drainUrgent = false;
        let slots = drainDirtySlots;
        drainDirtySlots = 0;
        if (urgent) {
          slots = unretiredDeferredMask();
        }
        trace(`drain-iter urgent=${urgent} slots=${slots.toString(2)} bq=${broadcastLen}`);
        if (slots !== 0) {
          processRevalidations(slots);
        }
        processBroadcasts();
      }
    } finally {
      drainDepth = 0;
      currentCause = 0;
    }
  }
  function processBroadcasts() {
    if (broadcastLen === 0) {
      return;
    }
    const n = broadcastLen;
    if (bcScratch.length < n) {
      bcScratch.length = n;
    }
    for (let i = 0; i < n; ++i) {
      bcScratch[i] = broadcastQueue[i];
    }
    broadcastLen = 0;
    const groups = /* @__PURE__ */ new Map();
    for (let i = 0; i < n; i += 2) {
      const w = bcScratch[i];
      const t = bcScratch[i + 1];
      let g = groups.get(t);
      if (g === void 0) {
        g = [];
        groups.set(t, g);
      }
      if (!g.includes(w)) {
        g.push(w);
      }
    }
    for (const [token, ws] of groups) {
      if (token !== 0 && (token & 1) === 1 && fork !== void 0) {
        const ok = fork.runInBatch(token, () => {
          for (const w of ws) {
            broadcastDecide(w, token);
          }
        });
        if (!ok) {
          for (const w of ws) {
            broadcastDecide(w, 0);
          }
        }
      } else {
        for (const w of ws) {
          broadcastDecide(w, 0);
        }
        if (fork !== void 0) {
          for (const token2 of fork.liveTokens()) {
            if ((token2 & 1) === 1) {
              fork.runInBatch(token2, () => {
                for (const w of ws) {
                  broadcastDecide(w, token2);
                }
              });
            }
          }
        }
      }
    }
  }
  function broadcastDecide(w, token) {
    if ((M[w + 0 /* FLAGS */] & 16384 /* K_WATCHER */) === 0) {
      return;
    }
    M[w + 0 /* FLAGS */] &= ~(32 /* PENDING */ | 16 /* DIRTY */ | 8 /* RECURSED */);
    const m = metaCol[w >> 3];
    if (m === void 0 || m.watched === void 0) {
      return;
    }
    const node = m.watched;
    let world = token === 0 ? WORLD_W0 : writerWorld(token);
    if (world.kind === 2 /* WRITER */ && world.slot < 0) {
      world = WORLD_W0;
    }
    const key = token === 0 ? 0 : token << 2 | 2;
    const v = resolveNode(node, world);
    const last = m.lastBroadcast.has(key) ? m.lastBroadcast.get(key) : token === 0 ? void 0 : resolveNode(node, WORLD_W0);
    trace(`decide w=${w} node=${node} token=${token} v=${String(v)} last=${String(last)}`);
    const changed = !broadcastEqual(node, last, v);
    if (tracer !== void 0) {
      tracer.emit(9 /* BROADCAST */, currentCause, w, token, changed ? 0 : 1, node, 0);
    }
    if (changed) {
      m.lastBroadcast.set(key, v);
      ++enterDepth;
      try {
        m.cb(token);
      } finally {
        --enterDepth;
      }
    }
  }
  function processRevalidations(slotsMask) {
    for (let s = 0; s < 32; ++s) {
      if ((slotsMask >>> s & 1) === 0) {
        continue;
      }
      const token = batchTokenTab[s];
      if (token === 0 || slotRetired[s] !== 0) {
        continue;
      }
      const world = writerWorld(token);
      const staleNodes = [];
      const staleOldVals = [];
      let rec = slotMemoHead[s];
      let prevRec = 0;
      while (rec > 0) {
        const next = W[rec + 5 /* W_SLOT_NEXT */];
        if (W[rec + 1 /* W_EPOCH */] !== 0) {
          const node = W[rec + 2 /* W_NODE */];
          if (W[rec + 1 /* W_EPOCH */] !== overlayEpoch || !certValid(rec)) {
            staleNodes.push(node);
            staleOldVals.push(memoVals[W[rec + 3 /* W_VAL */]]);
          }
          prevRec = rec;
        } else {
          const spliced = next <= 0 ? 0 : next;
          if (prevRec === 0) {
            slotMemoHead[s] = spliced;
          } else {
            W[prevRec + 5 /* W_SLOT_NEXT */] = spliced;
          }
          W[rec + 5 /* W_SLOT_NEXT */] = -1;
        }
        rec = next;
      }
      const toNotify = [];
      for (let i = 0; i < staleNodes.length; ++i) {
        const node = staleNodes[i];
        const newVal = overlayEvaluate(node, world);
        trace(
          `revalidate slot=${s} token=${token} node=${node} old=${String(staleOldVals[i])} new=${String(newVal)}`
        );
        if (!broadcastEqual(node, staleOldVals[i], newVal)) {
          toNotify.push(node);
        }
      }
      for (const node of toNotify) {
        let l = M[node + 3 /* SUBS */];
        while (l !== 0) {
          const sub = M[l + 2 /* SUB */];
          if (M[sub + 0 /* FLAGS */] & 256 /* IMMEDIATE */) {
            pushBroadcast(sub, token);
          }
          l = M[l + 4 /* NEXT_SUB */];
        }
      }
    }
  }
  function onRetired(token) {
    const slot = slotOfToken(token);
    if (tracer !== void 0) {
      currentCause = tracer.emit(5 /* BATCH_RETIRED */, 0, 0, token, slot, 0, 0);
    }
    ++overlayEpoch;
    ++worldStamp;
    if (slot >= 0) {
      slotRetired[slot] = 1;
      const rseq = ticket();
      ++batchDepth;
      try {
        const atoms = loggedAtoms.slice();
        for (const a of atoms) {
          const head = M[a + 6 /* LOG_HEAD */];
          if (head === 0) {
            continue;
          }
          let touched = false;
          let rec = G[head + 0 /* L_NEXT */];
          while (rec !== 0) {
            const meta = G[rec + 1 /* L_META */];
            if ((meta & (512 /* F_PSEUDO */ | 8 /* F_RETIRED */)) === 0 && (meta & 496 /* SLOT_MASK */) >> 4 /* SLOT_SHIFT */ === slot) {
              G[rec + 1 /* L_META */] = meta | 8 /* F_RETIRED */;
              G[rec + 3 /* L_RETIRED_SEQ */] = rseq;
              if ((meta & 4 /* F_APPLIED */) === 0) {
                --unappliedEntries;
                --unappliedCount[a >> 3];
              }
              touched = true;
            }
            rec = G[rec + 0 /* L_NEXT */];
          }
          if (touched) {
            const fold = foldTape(a, WORLD_W0);
            const cur = pendingAtomValue(a);
            const changed = !isEqualPolicy(a, cur, fold);
            if (changed) {
              kernelWrite(a, fold);
            }
            if (tracer !== void 0) {
              tracer.emit(6 /* ABSORB */, currentCause, a, token, changed ? 1 : 0, 0, 0);
            }
            pendingWalks.push(a, 0);
          }
        }
      } finally {
        --batchDepth;
      }
      drainUrgent = true;
      drainAll();
    }
    sweepTapes();
    pruneWatcherBaselines();
    maybeQuiesce();
    processFinalizeRetries();
  }
  function anyUnretiredSlot() {
    for (let s = 0; s < 32; ++s) {
      if (batchTokenTab[s] !== 0 && slotRetired[s] === 0) {
        return true;
      }
    }
    return false;
  }
  function sweepTapes() {
    ++tapeStamp;
    ++worldStamp;
    const minPin = passOpen !== 0 ? passPin : 2147483647;
    const pendingBatches = anyUnretiredSlot();
    for (let i = loggedAtoms.length - 1; i >= 0; --i) {
      const a = loggedAtoms[i];
      const base = M[a + 6 /* LOG_HEAD */];
      let cur = G[base + 0 /* L_NEXT */];
      while (cur !== 0) {
        const meta = G[cur + 1 /* L_META */];
        if ((meta & 8 /* F_RETIRED */) === 0 || G[cur + 3 /* L_RETIRED_SEQ */] > minPin) {
          break;
        }
        const folded = applyLogRec(a, cur, logVals[base >> 2]);
        if (!isEqualPolicy(a, logVals[base >> 2], folded)) {
          logVals[base >> 2] = folded;
        }
        G[base + 2 /* L_SEQ */] = G[cur + 3 /* L_RETIRED_SEQ */];
        G[base + 3 /* L_RETIRED_SEQ */] = G[cur + 3 /* L_RETIRED_SEQ */];
        const next = G[cur + 0 /* L_NEXT */];
        if ((meta & 512 /* F_PSEUDO */) === 0) {
          --batchEntryCount[(meta & 496 /* SLOT_MASK */) >> 4 /* SLOT_SHIFT */];
        }
        freeLogRec(cur);
        cur = next;
      }
      G[base + 0 /* L_NEXT */] = cur;
      if (cur === 0) {
        M[a + 7 /* LOG_TAIL */] = base;
        if (!pendingBatches) {
          freeLogRec(base);
          M[a + 6 /* LOG_HEAD */] = 0;
          M[a + 7 /* LOG_TAIL */] = 0;
          M[a + 0 /* FLAGS */] &= ~128 /* LOGGED */;
          --loggedAtomCount;
          loggedAtoms.splice(i, 1);
          noteReclaimRetry(a);
        }
      }
    }
    for (let s = 0; s < 32; ++s) {
      if (batchTokenTab[s] !== 0 && slotRetired[s] !== 0 && batchEntryCount[s] === 0) {
        releaseSlot(s);
      }
    }
  }
  function truncateBatchBySlot(s) {
    ++overlayEpoch;
    ++worldStamp;
    ++tapeStamp;
    ++worldStamp;
    const token = batchTokenTab[s];
    if (tracer !== void 0) {
      currentCause = tracer.emit(4 /* TRUNCATE */, 0, 0, token, s, 0, 0);
    }
    const touchedApplied = [];
    for (const a of loggedAtoms) {
      let prev = M[a + 6 /* LOG_HEAD */];
      let cur = G[prev + 0 /* L_NEXT */];
      let touched = false;
      while (cur !== 0) {
        const meta = G[cur + 1 /* L_META */];
        const next = G[cur + 0 /* L_NEXT */];
        if ((meta & (512 /* F_PSEUDO */ | 8 /* F_RETIRED */)) === 0 && (meta & 496 /* SLOT_MASK */) >> 4 /* SLOT_SHIFT */ === s) {
          G[prev + 0 /* L_NEXT */] = next;
          if (M[a + 7 /* LOG_TAIL */] === cur) {
            M[a + 7 /* LOG_TAIL */] = prev;
          }
          if ((meta & 4 /* F_APPLIED */) === 0) {
            --unappliedEntries;
            --unappliedCount[a >> 3];
          } else {
            touched = true;
          }
          --batchEntryCount[s];
          freeLogRec(cur);
          if (token !== 0 && slotRetired[s] === 0) {
            pendingWalks.push(a, token);
            drainDirtySlots |= 1 << s;
          }
        } else {
          prev = cur;
        }
        cur = next;
      }
      if (touched) {
        touchedApplied.push(a);
      }
    }
    for (const a of touchedApplied) {
      const fold = foldTape(a, WORLD_W0);
      const cur = pendingAtomValue(a);
      if (!isEqualPolicy(a, cur, fold)) {
        kernelWrite(a, fold);
      }
      drainUrgent = true;
    }
    flush();
    drainAll();
  }
  function maybeQuiesce() {
    if (loggedAtomCount !== 0 || passOpen !== 0 || liveSlotMask !== 0 || pendingWalks.length !== 0 || broadcastLen !== 0) {
      return;
    }
    gNext = 4;
    gFreeHead = 0;
    logVals = [void 0];
    W.fill(0, 0, wNext);
    wNext = 8;
    certNext = 0;
    memoVals = [];
    memoStamp = [];
    slotMemoHead.fill(0);
    eraFloor = walkCounter;
    ++overlayEpoch;
    ++worldStamp;
    seqCounter = 1;
    pruneWatcherBaselines();
    if (thenableCacheNodes.size !== 0) {
      for (const id of thenableCacheNodes) {
        const cache = metaCol[id >> 3]?.thenableCache;
        if (cache === void 0) {
          thenableCacheNodes.delete(id);
          continue;
        }
        for (const key of cache.keys()) {
          if (key !== 0) {
            cache.delete(key);
          }
        }
      }
    }
    if (walkCounter > 1 << 30) {
      for (let i = 0; i < nodeIds.length; ++i) {
        const id = nodeIds[i];
        const flags = M[id + 0 /* FLAGS */];
        if (flags & 31744 /* KIND_MASK */ && (flags & 1024 /* K_ATOM */) === 0) {
          M[id + 6 /* OVERLAY_STAMP */] = 0;
        }
      }
      walkCounter = 0;
      eraFloor = 0;
    }
    if (tracer !== void 0) {
      tracer.emit(12 /* QUIESCENCE */, 0, 0, 0, overlayEpoch, walkCounter, 0);
    }
    if (!strictLanes && (fork === void 0 || fork.isQuiescent())) {
      writeMode = 0 /* DIRECT */;
    }
  }
  function readAtomPublic(a) {
    if ((replayDepth | ovDepth) !== 0 || captureList !== void 0) {
      return readAtomCold(a);
    }
    if (activeSub !== 0 && (M[activeSub + 0 /* FLAGS */] & 2048 /* K_COMPUTED */) !== 0) {
      const v = kernelAtomValue(a);
      link(a, activeSub, cycle);
      return v;
    }
    const flags = M[a + 0 /* FLAGS */];
    if ((flags & 128 /* LOGGED */) === 0) {
      const v = kernelAtomValue(a);
      if (activeSub !== 0 && currentCtx !== 1 /* RENDER */) {
        link(a, activeSub, cycle);
      }
      return v;
    }
    if (activeSub !== 0 && currentCtx !== 1 /* RENDER */) {
      link(a, activeSub, cycle);
    }
    return foldTape(a, worldOfCtx(currentCtx));
  }
  function readAtomCold(a) {
    if (replayDepth !== 0 && debugChecks) {
      throw new Error(
        "cosignals-alt-b: signal read inside an updater/reducer replay \u2014 updaters must be pure functions of their arguments (\xA712.2; capture values before the write instead)"
      );
    }
    if (captureList !== void 0) {
      captureList.push(a);
    }
    if (ovDepth !== 0) {
      return overlayReadAtom(a);
    }
    if (activeSub !== 0 && (M[activeSub + 0 /* FLAGS */] & 2048 /* K_COMPUTED */) !== 0) {
      const v = kernelAtomValue(a);
      link(a, activeSub, cycle);
      return v;
    }
    const flags = M[a + 0 /* FLAGS */];
    if ((flags & 128 /* LOGGED */) === 0) {
      const v = kernelAtomValue(a);
      if (activeSub !== 0 && currentCtx !== 1 /* RENDER */) {
        link(a, activeSub, cycle);
      }
      return v;
    }
    if (activeSub !== 0 && currentCtx !== 1 /* RENDER */) {
      link(a, activeSub, cycle);
    }
    return foldTape(a, worldOfCtx(currentCtx));
  }
  function readComputedPublic(c) {
    if ((replayDepth | ovDepth) !== 0 || captureList !== void 0) {
      return readComputedCold(c);
    }
    if (activeSub !== 0 && (M[activeSub + 0 /* FLAGS */] & 2048 /* K_COMPUTED */) !== 0) {
      return kernelComputedRead(c, true);
    }
    if (loggedAtomCount === 0 && currentCtx === 0 /* NEWEST */) {
      return kernelComputedRead(c, true);
    }
    const track = currentCtx !== 1 /* RENDER */;
    return resolveComputed(c, worldOfCtx(currentCtx), track);
  }
  function readComputedCold(c) {
    if (replayDepth !== 0 && debugChecks) {
      throw new Error(
        "cosignals-alt-b: signal read inside an updater/reducer replay \u2014 updaters must be pure functions of their arguments (\xA712.2; capture values before the write instead)"
      );
    }
    if (captureList !== void 0) {
      captureList.push(c);
    }
    if (ovDepth !== 0) {
      return overlayEvaluate(c, ovWorld);
    }
    if (activeSub !== 0 && (M[activeSub + 0 /* FLAGS */] & 2048 /* K_COMPUTED */) !== 0) {
      return kernelComputedRead(c, true);
    }
    if (loggedAtomCount === 0 && currentCtx === 0 /* NEWEST */) {
      return kernelComputedRead(c, true);
    }
    const track = currentCtx !== 1 /* RENDER */;
    return resolveComputed(c, worldOfCtx(currentCtx), track);
  }
  function worldFromSpec(spec) {
    switch (spec.kind) {
      case "newest":
        return WORLD_NEWEST;
      case "committed":
        return WORLD_COMMITTED;
      case "w0":
        return WORLD_W0;
      case "writer":
        return writerWorld(spec.token);
      case "pass": {
        return { kind: 1 /* PASS */, key: -1, pin: spec.pin, mask: tokensToMask(spec.tokens), slot: -1, token: 0 };
      }
      case "committedRoot": {
        return {
          kind: 5 /* CROOT */,
          key: -1,
          pin: spec.pin,
          mask: tokensToMask(spec.tokens),
          slot: -1,
          token: 0
        };
      }
      case "fixup": {
        return {
          kind: 6 /* FIXUP */,
          key: -1,
          pin: spec.pin,
          mask: tokensToMask(spec.tokens),
          slot: -1,
          token: 0
        };
      }
    }
  }
  function tokensToMask(tokens) {
    let mask = 0;
    for (const t of tokens) {
      const s = slotOfToken(t);
      if (s >= 0) {
        mask |= 1 << s;
      }
    }
    return mask;
  }
  function verifyIntegrity() {
    if (eraFloor > walkCounter) {
      throw new Error(`verify: eraFloor ${eraFloor} > walkCounter ${walkCounter}`);
    }
    if (propSp !== 0 || checkSp !== 0) {
      throw new Error("verify: traversal scratch stacks not at base at boundary");
    }
    if (ovDepth === 0 && certSp !== 0) {
      throw new Error("verify: certificate collector not at base at boundary");
    }
    for (const id of nodeIds) {
      const flags = M[id + 0 /* FLAGS */];
      if ((flags & 31744 /* KIND_MASK */) === 0) {
        continue;
      }
      if ((flags & 1024 /* K_ATOM */) === 0 && M[id + 6 /* OVERLAY_STAMP */] > walkCounter) {
        throw new Error(`verify: node ${id} stamp exceeds walkCounter`);
      }
      let l = M[id + 1 /* DEPS */];
      let prev = 0;
      let steps = 0;
      while (l !== 0) {
        if (++steps > 1e6) {
          throw new Error(`verify: dep list of ${id} does not terminate`);
        }
        if (M[l + 2 /* SUB */] !== id) {
          throw new Error(`verify: link ${l} in dep list of ${id} has SUB ${M[l + 2 /* SUB */]}`);
        }
        if (M[l + 5 /* PREV_DEP */] !== prev) {
          throw new Error(`verify: link ${l} PREV_DEP incoherent`);
        }
        prev = l;
        l = M[l + 6 /* NEXT_DEP */];
      }
      l = M[id + 3 /* SUBS */];
      prev = 0;
      steps = 0;
      while (l !== 0) {
        if (++steps > 1e6) {
          throw new Error(`verify: sub list of ${id} does not terminate`);
        }
        if (M[l + 1 /* DEP */] !== id) {
          throw new Error(`verify: link ${l} in sub list of ${id} has DEP ${M[l + 1 /* DEP */]}`);
        }
        if (M[l + 3 /* PREV_SUB */] !== prev) {
          throw new Error(`verify: link ${l} PREV_SUB incoherent`);
        }
        prev = l;
        l = M[l + 4 /* NEXT_SUB */];
      }
      if (M[id + 4 /* SUBS_TAIL */] !== prev) {
        throw new Error(`verify: SUBS_TAIL of ${id} incoherent`);
      }
    }
    const perSlot = new Int32Array(32);
    let logged = 0;
    for (const a of loggedAtoms) {
      if ((M[a + 0 /* FLAGS */] & 128 /* LOGGED */) === 0 || M[a + 6 /* LOG_HEAD */] === 0) {
        throw new Error(`verify: loggedAtoms entry ${a} has no tape`);
      }
      ++logged;
      let rec = M[a + 6 /* LOG_HEAD */];
      let lastSeq = 0;
      let steps = 0;
      let sawTail = false;
      let isBase = true;
      while (rec !== 0) {
        if (++steps > 1e6) {
          throw new Error(`verify: tape of ${a} does not terminate`);
        }
        const seq = G[rec + 2 /* L_SEQ */];
        if (!isBase && seq < lastSeq) {
          throw new Error(`verify: tape of ${a} seq not monotone`);
        }
        if (!isBase) {
          lastSeq = seq;
        }
        isBase = false;
        const meta = G[rec + 1 /* L_META */];
        if ((meta & 3 /* OP_MASK */) !== 0 /* OP_BASE */ && (meta & 512 /* F_PSEUDO */) === 0) {
          ++perSlot[(meta & 496 /* SLOT_MASK */) >> 4 /* SLOT_SHIFT */];
        }
        if (rec === M[a + 7 /* LOG_TAIL */]) {
          sawTail = true;
        }
        rec = G[rec + 0 /* L_NEXT */];
      }
      if (!sawTail) {
        throw new Error(`verify: LOG_TAIL of ${a} not on its chain`);
      }
    }
    if (logged !== loggedAtomCount) {
      throw new Error(`verify: loggedAtomCount ${loggedAtomCount} != ${logged}`);
    }
    for (let s = 0; s < 32; ++s) {
      if (batchTokenTab[s] !== 0 && perSlot[s] !== batchEntryCount[s]) {
        throw new Error(
          `verify: slot ${s} entry count ${batchEntryCount[s]} != counted ${perSlot[s]}`
        );
      }
      if (batchTokenTab[s] === 0 && perSlot[s] !== 0) {
        throw new Error(`verify: entries name a free slot ${s}`);
      }
      if (batchTokenTab[s] === 0 && slotMemoHead[s] !== 0) {
        throw new Error(`verify: free slot ${s} has a memo chain`);
      }
    }
    for (let rec = 8; rec < wNext; rec += 8) {
      if (W[rec + 1 /* W_EPOCH */] === 0) {
        continue;
      }
      const nd = W[rec + 6 /* W_NDEPS */];
      const cb = W[rec + 7 /* W_CERT */];
      if (cb < 0 || cb + nd * 2 > certNext) {
        throw new Error(`verify: memo ${rec} certificate run out of bounds`);
      }
      if (W[rec + 5 /* W_SLOT_NEXT */] > 0 && (W[rec + 0 /* W_KEY */] & 3) !== 2) {
        throw new Error(`verify: memo ${rec} slot-chained but not a writer's-world key`);
      }
    }
    if (loggedAtomCount === 0 && passOpen === 0 && liveSlotMask === 0) {
      if (gNext !== 4 || wNext !== 8 || certNext !== 0) {
        throw new Error("verify: quiescent overlay has plane residue");
      }
      if (seqCounter !== 1) {
        throw new Error(`verify: quiescent seqCounter ${seqCounter} != 1`);
      }
    }
  }
  function makeEffect(fn) {
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
      --enterDepth;
      --runDepth;
      activeSub = prevSub;
      M[e + 0 /* FLAGS */] &= ~4 /* RECURSED_CHECK */;
    }
    return { id: e, gen: M[e + 5 /* GEN */] };
  }
  function makeScope(fn) {
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
    return { id: e, gen: M[e + 5 /* GEN */] };
  }
  function makeWatcher(watched, cb) {
    const w = allocNode(16384 /* K_WATCHER */ | 2 /* WATCHING */ | 256 /* IMMEDIATE */ | 512 /* LIVE */);
    const lastBroadcast = /* @__PURE__ */ new Map();
    lastBroadcast.set(0, resolveNode(watched, WORLD_W0));
    if (fork !== void 0) {
      for (const token of fork.liveTokens()) {
        if ((token & 1) === 1) {
          lastBroadcast.set(token << 2 | 2, resolveNode(watched, writerWorld(token)));
        }
      }
    }
    metaCol[w >> 3] = { cb, watched, lastBroadcast };
    liveWatcherIds.add(w);
    link(watched, w, 0);
    return { id: w, gen: M[w + 5 /* GEN */] };
  }
  function pruneWatcherBaselines() {
    if (liveWatcherIds.size === 0) {
      return;
    }
    for (const w of liveWatcherIds) {
      const lb = metaCol[w >> 3]?.lastBroadcast;
      if (lb === void 0 || lb.size <= 1) {
        continue;
      }
      for (const key of lb.keys()) {
        if (key === 0) {
          continue;
        }
        const token = key >> 2;
        if (slotOfToken(token) < 0 && (fork === void 0 || !fork.isBatchLive(token))) {
          lb.delete(key);
        }
      }
    }
  }
  function registerHandle(handle, id) {
    if (!finalizationEnabled) {
      return;
    }
    if (finalizationRegistry === void 0) {
      finalizationRegistry = new FinalizationRegistry(finalizeTrampoline);
    }
    const gen = M[id + 5 /* GEN */];
    finalizationRegistry.register(
      handle,
      gen === 0 ? id : gen < 2097152 ? gen * 4294967296 + id : { id, gen }
    );
  }
  function finalizeRecord(held, retryIfBusy = false) {
    const { id, gen } = held;
    if (M[id + 5 /* GEN */] !== gen) {
      finalizeSkipped.delete(id);
      return;
    }
    const flags = M[id + 0 /* FLAGS */];
    if ((flags & (1024 /* K_ATOM */ | 2048 /* K_COMPUTED */)) === 0) {
      finalizeSkipped.delete(id);
      return;
    }
    if (M[id + 3 /* SUBS */] !== 0 || (flags & 128 /* LOGGED */) !== 0) {
      if (retryIfBusy) {
        finalizeSkipped.set(id, gen);
      }
      return;
    }
    finalizeSkipped.delete(id);
    disposeAllDepsInReverse(id);
    pendingFree.push(id);
    sweepPendingFree();
  }
  function noteReclaimRetry(id) {
    if (finalizeSkipped.size !== 0 && finalizeSkipped.has(id)) {
      finalizeRetry.push(id);
    }
  }
  function processFinalizeRetries() {
    while (finalizeRetry.length !== 0) {
      const batch2 = finalizeRetry.splice(0, finalizeRetry.length);
      for (const id of batch2) {
        const gen = finalizeSkipped.get(id);
        if (gen !== void 0) {
          finalizeRecord({ id, gen }, true);
        }
      }
    }
  }
  return {
    buffers: () => ({ m: M, g: G, w: W, cert: CERT }),
    allocNode,
    gen: (id) => M[id + 5 /* GEN */],
    dispose,
    sweepPendingFree,
    processFinalizeRetries,
    atomWrite,
    readAtomPublic,
    readComputedPublic,
    runComputedFn,
    resolveNode,
    readInWorld: (id, spec) => resolveNode(id, worldFromSpec(spec)),
    makeEffect,
    makeScope,
    makeWatcher,
    registerHandle,
    finalizeRecord,
    flush,
    drainAll,
    sweepTapes,
    maybeQuiesce,
    onRetired,
    truncateToken: (token) => {
      const s = slotOfToken(token);
      if (s >= 0) {
        truncateBatchBySlot(s);
      }
    },
    internSlot,
    tokensToMask,
    kernelAtomValue,
    kernelSet: (id, value) => {
      const cur = pendingAtomValue(id);
      if (!isEqualPolicy(id, cur, value)) {
        if (loggedAtomCount !== 0) {
          ++overlayEpoch;
          ++worldStamp;
        }
        kernelWrite(id, value);
        flush();
        drainAll();
      }
    },
    onThenableSettled,
    observeWanted: (node) => (M[node + 0 /* FLAGS */] & 31744 /* KIND_MASK */) !== 0 && (M[node + 0 /* FLAGS */] & 512 /* LIVE */) !== 0,
    isLive: (id) => (M[id + 0 /* FLAGS */] & 512 /* LIVE */) !== 0,
    liveMemos: () => {
      let n = 0;
      for (let rec = 8; rec < wNext; rec += 8) {
        if (W[rec + 1 /* W_EPOCH */] !== 0) {
          ++n;
        }
      }
      return n;
    },
    verify: verifyIntegrity
  };
}
var E = createEngineCore(...createBuffers());
var hotReadAtom = E.readAtomPublic;
var hotReadComputed = E.readComputedPublic;
var hotAtomWrite = E.atomWrite;
function rebindHotPaths() {
  hotReadAtom = E.readAtomPublic;
  hotReadComputed = E.readComputedPublic;
  hotAtomWrite = E.atomWrite;
}
function createBuffers() {
  return [
    new Int32Array(cfgInitialRecords * 8),
    new Int32Array(cfgInitialLogRecords * 4),
    new Int32Array(cfgInitialMemoRecords * 8),
    new Int32Array(cfgInitialMemoRecords * 8)
  ];
}
function growBuf(buf, bump, slackUnits) {
  let len = buf.length;
  while (bump > Math.min(len >> 1, len - slackUnits)) {
    len *= 2;
  }
  if (len === buf.length) {
    return buf;
  }
  const bigger = new Int32Array(len);
  bigger.set(buf);
  return bigger;
}
function boundaryWork() {
  growPending = false;
  const b = E.buffers();
  const m = growBuf(b.m, recNext, 1280 /* REC_SLACK */ * 8);
  const g = growBuf(b.g, gNext, 256 * 4);
  const w = growBuf(b.w, wNext, 256 * 8);
  const cert = growBuf(b.cert, certNext, 4096);
  if (m !== b.m || g !== b.g || w !== b.w || cert !== b.cert) {
    E = createEngineCore(m, g, w, cert);
    rebindHotPaths();
  }
}
function boundary() {
  if (enterDepth === 0) {
    if (finalizeRetry.length !== 0 && drainDepth === 0) {
      E.processFinalizeRetries();
    }
    if (growPending) {
      boundaryWork();
    }
  }
}
function reclaimBoundary() {
  if (enterDepth === 0 && drainDepth === 0) {
    E.sweepPendingFree();
  }
}
function enter(fn) {
  ++enterDepth;
  try {
    return fn();
  } finally {
    --enterDepth;
  }
}
function atomWriteEntry(node, op, payload) {
  boundary();
  hotAtomWrite(node, op, payload);
  boundary();
}
function readEntryAtom(node) {
  return hotReadAtom(node);
}
function readEntryComputed(node) {
  return hotReadComputed(node);
}
function peekEntry(node) {
  const prevSub = activeSub;
  activeSub = 0;
  try {
    return hotReadAtom(node);
  } finally {
    activeSub = prevSub;
  }
}
function settleTrampoline(t, st) {
  ++enterDepth;
  try {
    E.onThenableSettled(t, st);
  } finally {
    --enterDepth;
  }
  boundary();
}
function finalizeTrampoline(held) {
  ++enterDepth;
  try {
    if (typeof held === "number") {
      E.finalizeRecord(
        { id: held % 4294967296, gen: Math.floor(held / 4294967296) },
        true
        // GC-driven: retry a guarded skip later
      );
    } else {
      E.finalizeRecord(held, true);
    }
  } finally {
    --enterDepth;
  }
  boundary();
}
function scheduleObserveReconcile(node, m) {
  if (m.observeScheduled === true || m.observeEffect === void 0) {
    return;
  }
  const observeEffect = m.observeEffect;
  m.observeScheduled = true;
  void Promise.resolve().then(() => {
    m.observeScheduled = false;
    const want = E.observeWanted(node);
    if (want && m.observeMounted !== true) {
      m.observeMounted = true;
      const ctx = {
        peek: () => peekEntry(node),
        set: (v) => atomWriteEntry(node, 1 /* OP_SET */, v),
        update: (fn) => atomWriteEntry(node, 2 /* OP_UPDATE */, fn)
      };
      const cleanup = observeEffect(ctx);
      m.observeCleanup = typeof cleanup === "function" ? cleanup : void 0;
    } else if (!want && m.observeMounted === true) {
      m.observeMounted = false;
      const cleanup = m.observeCleanup;
      m.observeCleanup = void 0;
      if (cleanup !== void 0) {
        cleanup();
      }
    }
  });
}
function __resetEngineForTests(options) {
  if (unsubscribeFork !== void 0) {
    unsubscribeFork();
    unsubscribeFork = void 0;
  }
  fork = void 0;
  strictLanes = false;
  forbidWritesInComputeds = false;
  replayDepth = 0;
  debugChecks = true;
  finalizationEnabled = true;
  finalizationRegistry = void 0;
  finalizeSkipped.clear();
  finalizeRetry.length = 0;
  liveWatcherIds.clear();
  thenableCacheNodes.clear();
  cfgInitialRecords = options?.initialRecords ?? 8192;
  cfgInitialLogRecords = options?.initialLogRecords ?? 1024;
  cfgInitialMemoRecords = options?.initialMemoRecords ?? 1024;
  recNext = 8;
  nodeFreeHead = 0;
  linkFreeHead = 0;
  gNext = 4;
  gFreeHead = 0;
  wNext = 8;
  certNext = 0;
  growPending = false;
  enterDepth = 0;
  cycle = 0;
  runDepth = 0;
  batchDepth = 0;
  notifyIndex = 0;
  queuedLength = 0;
  activeSub = 0;
  queued = [];
  pendingFree = [];
  values = [void 0, void 0];
  fns = [void 0];
  metaCol = [void 0];
  memoHeads = [0];
  logVals = [void 0];
  memoVals = [];
  memoStamp = [];
  tapeStamp = 1;
  worldStamp = 1;
  newestStamp = [0];
  unappliedCount = [0];
  unappliedStamp = [0];
  propStack = new Int32Array(4096);
  propSp = 0;
  checkStack = new Int32Array(4096);
  checkSp = 0;
  certStack = new Int32Array(4096);
  certSp = 0;
  batchTokenTab = new Int32Array(32);
  batchEntryCount = new Int32Array(32);
  slotRetired = new Int32Array(32);
  slotMemoHead = new Int32Array(32);
  liveSlotMask = 0;
  liveDeferredMask = 0;
  unappliedEntries = 0;
  loggedAtomCount = 0;
  seqCounter = 1;
  walkCounter = 0;
  eraFloor = 0;
  overlayEpoch = 1;
  lastToken = 0;
  lastSlot = -1;
  pseudoFallbacks = 0;
  writeMode = 0 /* DIRECT */;
  nodeIds = [];
  passOpen = 0;
  passSerial = 0;
  passPin = 0;
  passIncludeMask = 0;
  passContainer = void 0;
  passLineage = 0;
  currentCtx = 0 /* NEWEST */;
  loggedAtoms = [];
  broadcastQueue = [];
  broadcastLen = 0;
  bcScratch = [];
  pendingWalks = [];
  drainUrgent = false;
  drainDirtySlots = 0;
  drainDepth = 0;
  ovWorld = void 0;
  ovDepth = 0;
  rootCommittedActive = false;
  rootCommittedPin = 0;
  rootCommittedMask = 0;
  captureList = void 0;
  E = createEngineCore(...createBuffers());
  rebindHotPaths();
}
function attachFork(f) {
  if (fork !== void 0) {
    throw new Error("cosignals-alt-b: a fork is already attached");
  }
  fork = f;
  if (strictLanes) {
    writeMode = 1 /* LOGGED */;
  }
  unsubscribeFork = f.subscribeToExternalRuntime({
    onBatchOpened() {
      writeMode = 1 /* LOGGED */;
    },
    onRenderPassStart(container, tokens, lineage) {
      writeMode = 1 /* LOGGED */;
      passOpen = 1;
      ++passSerial;
      passPin = seqCounter;
      let mask = 0;
      ++enterDepth;
      try {
        for (const t of tokens) {
          const s = E.internSlot(t);
          if (s >= 0) {
            mask |= 1 << s;
          }
        }
      } finally {
        --enterDepth;
      }
      passIncludeMask = mask;
      passContainer = container;
      passLineage = lineage;
      currentCtx = 1 /* RENDER */;
      if (tracer !== void 0) {
        tracer.emit(10 /* PASS_START */, 0, 0, mask, passPin, lineage, 0);
      }
    },
    onRenderPassYield() {
      currentCtx = 0 /* NEWEST */;
    },
    onRenderPassResume() {
      currentCtx = 1 /* RENDER */;
    },
    onRenderPassEnd() {
      if (tracer !== void 0) {
        tracer.emit(11 /* PASS_END */, 0, 0, passIncludeMask, passPin, passLineage, 0);
      }
      passOpen = 0;
      passContainer = void 0;
      currentCtx = 0 /* NEWEST */;
      ++enterDepth;
      try {
        E.sweepTapes();
        E.maybeQuiesce();
      } finally {
        --enterDepth;
      }
      boundary();
    },
    onBatchCommitted() {
    },
    onBatchRetired(token) {
      ++enterDepth;
      try {
        E.onRetired(token);
      } finally {
        --enterDepth;
      }
      boundary();
    }
  });
}
function detachFork() {
  if (unsubscribeFork !== void 0) {
    unsubscribeFork();
    unsubscribeFork = void 0;
  }
  fork = void 0;
}
function configure(options) {
  if (options.forbidWritesInComputeds !== void 0) {
    forbidWritesInComputeds = options.forbidWritesInComputeds;
  }
  if (options.debugChecks !== void 0) {
    debugChecks = options.debugChecks;
  }
  if (options.finalization !== void 0) {
    finalizationEnabled = options.finalization;
  }
  if (options.strictLanes !== void 0) {
    strictLanes = options.strictLanes;
    if (strictLanes && fork !== void 0) {
      writeMode = 1 /* LOGGED */;
    }
  }
  if (options.initialRecords !== void 0) {
    cfgInitialRecords = options.initialRecords;
  }
  if (options.initialLogRecords !== void 0) {
    cfgInitialLogRecords = options.initialLogRecords;
  }
  if (options.initialMemoRecords !== void 0) {
    cfgInitialMemoRecords = options.initialMemoRecords;
  }
}
var Atom = class {
  id;
  constructor(options) {
    boundary();
    const id = E.allocNode(1024 /* K_ATOM */ | 1 /* MUTABLE */);
    this.id = id;
    values[id >> 2] = options.state;
    values[(id >> 2) + 1] = options.state;
    if (options.isEqual !== void 0 || options.label !== void 0 || options.effect !== void 0) {
      metaCol[id >> 3] = {
        isEqual: options.isEqual,
        label: options.label,
        observeEffect: options.effect
      };
    }
    E.registerHandle(this, id);
  }
  get state() {
    return readEntryAtom(this.id);
  }
  peek() {
    return peekEntry(this.id);
  }
  set(next) {
    atomWriteEntry(this.id, 1 /* OP_SET */, next);
  }
  update(fn) {
    atomWriteEntry(this.id, 2 /* OP_UPDATE */, fn);
  }
};
var ReducerAtom = class {
  id;
  constructor(options) {
    boundary();
    const id = E.allocNode(1024 /* K_ATOM */ | 1 /* MUTABLE */);
    this.id = id;
    values[id >> 2] = options.state;
    values[(id >> 2) + 1] = options.state;
    metaCol[id >> 3] = {
      isEqual: options.isEqual,
      reducer: options.reducer,
      label: options.label
    };
    E.registerHandle(this, id);
  }
  get state() {
    return readEntryAtom(this.id);
  }
  peek() {
    return peekEntry(this.id);
  }
  dispatch(action) {
    atomWriteEntry(this.id, 3 /* OP_DISPATCH */, action);
  }
};
var Computed = class {
  id;
  constructor(options) {
    boundary();
    const id = E.allocNode(2048 /* K_COMPUTED */);
    this.id = id;
    metaCol[id >> 3] = {
      rawFn: options.fn,
      // Arity-gated ctx: fns that do not declare a ctx parameter (the
      // overwhelmingly common case) evaluate with zero per-run
      // allocation — no ctx object, no `use` closure.
      wantsCtx: options.fn.length > 0,
      isEqual: options.isEqual,
      label: options.label
    };
    if (options.fn.length === 0 && options.isEqual === void 0) {
      const raw = options.fn;
      fns[id >> 3] = (prev) => {
        ++enterDepth;
        try {
          const next = raw();
          return prev !== void 0 && Object.is(prev, next) ? prev : next;
        } catch (e) {
          if (isErrorBox(prev) && Object.is(prev.error, e)) {
            return prev;
          }
          return { kind: "error", error: e };
        } finally {
          --enterDepth;
        }
      };
    } else {
      fns[id >> 3] = (prev) => E.runComputedFn(id, prev, 0);
    }
    E.registerHandle(this, id);
  }
  /** Rethrows cached errors; throws the thenable while suspended (§11.3). */
  get state() {
    const v = readEntryComputed(this.id);
    if (isErrorBox(v)) {
      throw v.error;
    }
    if (isSuspendedBox(v)) {
      throw v.thenable;
    }
    return v;
  }
};
function effect(fn) {
  boundary();
  const h = E.makeEffect(fn);
  return () => {
    if (E.gen(h.id) !== h.gen) {
      return;
    }
    E.dispose(h.id);
    reclaimBoundary();
    boundary();
  };
}
function effectScope(fn) {
  boundary();
  const h = E.makeScope(fn);
  return () => {
    if (E.gen(h.id) !== h.gen) {
      return;
    }
    E.dispose(h.id);
    reclaimBoundary();
    boundary();
  };
}
function batch(fn) {
  ++batchDepth;
  try {
    return fn();
  } finally {
    if (--batchDepth === 0) {
      E.flush();
      E.drainAll();
      boundary();
    }
  }
}
function startBatch() {
  ++batchDepth;
}
function endBatch() {
  if (--batchDepth === 0) {
    E.flush();
    E.drainAll();
    boundary();
  }
}
function untracked(fn) {
  const prevSub = activeSub;
  activeSub = 0;
  try {
    return fn();
  } finally {
    activeSub = prevSub;
  }
}
function startSignalTransition(scope) {
  const f = fork;
  if (f === void 0) {
    throw new Error("cosignals-alt-b: startSignalTransition requires an attached fork");
  }
  let token = 0;
  batch(() => {
    token = f.startTransition(scope);
  });
  return token;
}
function createWatcher(signal, cb) {
  boundary();
  const h = E.makeWatcher(signal.id, cb);
  return {
    id: h.id,
    dispose() {
      if (E.gen(h.id) !== h.gen) {
        return;
      }
      E.dispose(h.id);
      reclaimBoundary();
      boundary();
    }
  };
}
var __debug = {
  /** Run fn with reads resolving in COMMITTED context (per §10.1;
   * useSignalEffect's context — the global retired-only form). */
  committed(fn) {
    const prev = currentCtx;
    currentCtx = 2 /* COMMITTED */;
    try {
      return fn();
    } finally {
      currentCtx = prev;
    }
  },
  /** Resolve a node's value in an explicit world (oracle comparisons). */
  readInWorld(signal, spec) {
    return enter(() => E.readInWorld(signal.id, spec));
  },
  /** Current seq counter (pass pins for explicit pass-world reads). */
  seqCounter() {
    return seqCounter;
  },
  /** The atom's canonical (W0) kernel value. */
  kernelValue(signal) {
    return enter(() => E.kernelAtomValue(signal.id));
  },
  isDirect() {
    return writeMode === 0 /* DIRECT */;
  },
  truncateToken(token) {
    enter(() => E.truncateToken(token));
    boundary();
  },
  sweep() {
    enter(() => {
      E.sweepTapes();
      E.maybeQuiesce();
    });
    boundary();
  },
  stats() {
    return {
      gNext,
      wNext,
      certNext,
      liveSlotMask,
      loggedAtomCount,
      seqCounter,
      walkCounter,
      eraFloor,
      overlayEpoch,
      unappliedEntries,
      writeMode: writeMode === 0 /* DIRECT */ ? "DIRECT" : "LOGGED",
      pseudoFallbacks,
      liveMemos: enter(() => E.liveMemos()),
      recNext,
      pendingFreeLen: pendingFree.length,
      finalizePending: finalizeSkipped.size,
      liveWatcherCount: liveWatcherIds.size,
      memoValsLen: memoVals.length,
      planeBytes: (() => {
        const b = E.buffers();
        return (b.m.length + b.g.length + b.w.length + b.cert.length) * 4;
      })()
    };
  },
  /** Run the finalization path for a handle's record as the GC would
   * (FinalizationRegistry timing is untestable without --expose-gc).
   * Like the GC path, a guarded skip registers the reclaim retry. */
  simulateFinalize(signal, gen) {
    enter(() => E.finalizeRecord({ id: signal.id, gen: gen ?? E.gen(signal.id) }, true));
    boundary();
  },
  /** Number of per-world baseline entries a watcher holds (leak tests:
   * must not grow with retired batches). */
  watcherBaselineCount(watcher) {
    return metaCol[watcher.id >> 3]?.lastBroadcast?.size ?? 0;
  },
  /** Lineage keys held by a computed's thenable cache (leak tests: retired
   * lineages must be pruned at quiescence; key 0 is the canonical slot). */
  thenableLineageKeys(signal) {
    return [...metaCol[signal.id >> 3]?.thenableCache?.keys() ?? []];
  },
  /** Is the node currently LIVE (transitively watched)? */
  isLive(signal) {
    return E.isLive(signal.id);
  },
  /** Capture drain-internal decisions for debugging. */
  startTrace() {
    traceLog = [];
  },
  takeTrace() {
    const t = traceLog ?? [];
    traceLog = void 0;
    return t;
  },
  /** Force counter values (wrap-around unit tests, §17.2 pinned list). */
  forceCounters(opts) {
    if (opts.walkCounter !== void 0) {
      walkCounter = opts.walkCounter;
      if (eraFloor > walkCounter) {
        eraFloor = walkCounter;
      }
    }
    if (opts.seqCounter !== void 0) {
      seqCounter = opts.seqCounter;
    }
  },
  /** Invariant sweeper (verifyArena-lite): throws on the first violation
   * with a description; run by the oracle after every step. */
  verify() {
    enter(() => E.verify());
  }
};

// src/fork.ts
var ForkDouble = class {
  listeners = /* @__PURE__ */ new Set();
  serial = 0;
  lineageSerial = 0;
  batches = /* @__PURE__ */ new Map();
  /** Live (unretired) tokens — O(1) liveness bookkeeping so long sessions
   * do not degrade quadratically scanning every batch ever created. */
  live = /* @__PURE__ */ new Set();
  /** Batch context stack for write attribution (innermost wins, §6.5). */
  contextStack = [];
  /** Lazily-minted urgent token for writes outside any scripted batch. */
  ambientToken = 0;
  pass;
  /** Record of every runInBatch call, for test assertions. */
  entangleLog = [];
  /** Cap on live tokens; §6.2 invariant is 31. Tests may raise it to force
   * the engine's slot-exhaustion fallback. */
  maxLiveTokens = 31;
  // ---- §6.1 isomorphic API -------------------------------------------------
  subscribeToExternalRuntime(l) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
  /** §6.4 — pure classification of a write issued right now. */
  isCurrentWriteDeferred() {
    const token = this.currentContextToken();
    if (token !== 0) {
      return (token & 1) === 1;
    }
    return false;
  }
  /** §6.1 — token of the batch a write issued right now belongs to, minting
   * lazily. The double mints an ambient urgent token when no scripted batch
   * context is live (the real fork's per-event batch). */
  getCurrentWriteBatch() {
    const token = this.currentContextToken();
    if (token !== 0) {
      return token;
    }
    if (this.ambientToken === 0 || this.batches.get(this.ambientToken)?.retired) {
      this.ambientToken = this.openBatch(false);
    }
    return this.ambientToken;
  }
  /** §6.1 — defined only while React is *executing* render code. The double
   * mirrors that: undefined inside yield gaps. */
  getRenderContext() {
    if (this.pass !== void 0 && !this.pass.yielded) {
      return { container: this.pass.container };
    }
    return void 0;
  }
  /** §6.5 — batch entanglement. Token live: run fn in that batch's context
   * (write classification included) and return true. Retired: return false
   * without running fn. Nesting uses the innermost override. */
  runInBatch(token, fn) {
    const b = this.batches.get(token);
    if (b === void 0 || b.retired) {
      this.entangleLog.push({ token, ran: false });
      return false;
    }
    this.entangleLog.push({ token, ran: true });
    this.contextStack.push(token);
    try {
      fn();
    } finally {
      this.contextStack.pop();
    }
    return true;
  }
  // ---- scripting surface -----------------------------------------------------
  /** Claim + mint a batch token (§6.2). Emits the onBatchOpened gate edge. */
  openBatch(deferred) {
    if (this.live.size >= this.maxLiveTokens) {
      throw new Error(
        `ForkDouble: ${this.live.size} live tokens; \xA76.2 caps at ${this.maxLiveTokens}`
      );
    }
    const token = ++this.serial << 1 | (deferred ? 1 : 0);
    this.batches.set(token, {
      token,
      deferred,
      retired: false,
      committedRoots: /* @__PURE__ */ new Set()
    });
    this.live.add(token);
    this.emit((l) => l.onBatchOpened?.(token));
    return token;
  }
  /** Run fn with writes attributed to `token` (like code inside a
   * startTransition scope, or an event handler for an urgent batch). */
  inBatch(token, fn) {
    const b = this.batches.get(token);
    if (b === void 0) {
      throw new Error(`ForkDouble.inBatch: unknown token ${token}`);
    }
    if (b.retired) {
      throw new Error(`ForkDouble.inBatch: token ${token} already retired`);
    }
    this.contextStack.push(token);
    try {
      fn();
    } finally {
      this.contextStack.pop();
    }
  }
  /** Convenience: open a deferred batch, run scope inside it (a
   * startTransition analogue). Returns the token; caller retires it. */
  startTransition(scope) {
    const token = this.openBatch(true);
    this.inBatch(token, scope);
    return token;
  }
  mintLineage() {
    return ++this.lineageSerial;
  }
  /** §6.3 — begin a render pass. One pass at a time. */
  startRenderPass(container, includedBatches, lineage = this.mintLineage()) {
    if (this.pass !== void 0) {
      throw new Error("ForkDouble: a render pass is already open (one pass at a time, \xA76.3)");
    }
    for (const t of includedBatches) {
      const b = this.batches.get(t);
      if (b === void 0 || b.retired && !b.committedRoots.has(container)) {
        throw new Error(`ForkDouble: includedBatches names dead token ${t}`);
      }
    }
    this.pass = { container, includedBatches, lineage, yielded: false };
    this.emit((l) => l.onRenderPassStart?.(container, includedBatches, lineage));
  }
  yieldPass() {
    const p = this.requirePass("yieldPass");
    if (p.yielded) {
      throw new Error("ForkDouble: yield without intervening resume (\xA76.3 strict alternation)");
    }
    p.yielded = true;
    this.emit((l) => l.onRenderPassYield?.(p.container));
  }
  resumePass() {
    const p = this.requirePass("resumePass");
    if (!p.yielded) {
      throw new Error("ForkDouble: resume without a yield (\xA76.3 strict alternation)");
    }
    p.yielded = false;
    this.emit((l) => l.onRenderPassResume?.(p.container));
  }
  /** §6.3 — exactly one end per start, even across restarts. */
  endRenderPass() {
    const p = this.requirePass("endRenderPass");
    this.pass = void 0;
    this.emit((l) => l.onRenderPassEnd?.(p.container));
  }
  /** Restart: end the old pass, start a new one with the SAME lineage,
   * re-delivering (possibly newer) includedBatches. */
  restartRenderPass(includedBatches) {
    const p = this.requirePass("restartRenderPass");
    const { container, lineage } = p;
    this.endRenderPass();
    this.startRenderPass(container, includedBatches, lineage);
  }
  /** §6.1/§6.2 finish edge — a batch's work committed on one root. */
  commitBatchOnRoot(container, token) {
    const b = this.batches.get(token);
    if (b === void 0) {
      throw new Error(`ForkDouble.commitBatchOnRoot: unknown token ${token}`);
    }
    if (b.retired) {
      throw new Error(`ForkDouble.commitBatchOnRoot: token ${token} already retired`);
    }
    if (b.committedRoots.has(container)) {
      throw new Error(
        `ForkDouble.commitBatchOnRoot: duplicate commit of ${token} on the same root (exactly once per (token, root), \xA76.1)`
      );
    }
    b.committedRoots.add(container);
    this.emit((l) => l.onBatchCommitted?.(container, token));
  }
  /**
   * Retire a token — exactly once, ever (§6.1). `committed` defaults to
   * whether any root committed it. Commit-then-retire convenience: pass a
   * container to emit the final root's onBatchCommitted first, as the real
   * fork does ("fires before onBatchRetired when this is the token's last
   * pending root").
   */
  retireBatch(token, committed, finalRoot) {
    const b = this.batches.get(token);
    if (b === void 0) {
      throw new Error(`ForkDouble.retireBatch: unknown token ${token}`);
    }
    if (b.retired) {
      throw new Error(`ForkDouble.retireBatch: token ${token} retired twice (\xA76.1 exactly-once)`);
    }
    if (finalRoot !== void 0) {
      this.commitBatchOnRoot(finalRoot, token);
    }
    b.retired = true;
    this.live.delete(token);
    const wasCommitted = committed ?? b.committedRoots.size > 0;
    this.emit((l) => l.onBatchRetired?.(token, wasCommitted));
  }
  /** DOM mutation window (§6.6) — scripted brackets. */
  mutationWindow(container, fn) {
    this.emit((l) => l.onBeforeMutation?.(container));
    try {
      fn();
    } finally {
      this.emit((l) => l.onAfterMutation?.(container));
    }
  }
  // ---- queries ---------------------------------------------------------------
  /** Full React quiescence per §9.1: no live (unretired) batches, no open pass. */
  isQuiescent() {
    return this.pass === void 0 && this.live.size === 0;
  }
  isBatchLive(token) {
    const b = this.batches.get(token);
    return b !== void 0 && !b.retired;
  }
  liveTokens() {
    return [...this.live];
  }
  // ---- internals ---------------------------------------------------------------
  currentContextToken() {
    return this.contextStack.length !== 0 ? this.contextStack[this.contextStack.length - 1] : 0;
  }
  requirePass(op) {
    if (this.pass === void 0) {
      throw new Error(`ForkDouble.${op}: no open render pass`);
    }
    return this.pass;
  }
  emit(fn) {
    for (const l of this.listeners) {
      fn(l);
    }
  }
};
export {
  Atom,
  Computed,
  ForkDouble,
  ReducerAtom,
  __debug,
  __resetEngineForTests,
  attachFork,
  batch,
  configure,
  createWatcher,
  detachFork,
  effect,
  effectScope,
  endBatch,
  isErrorBox,
  isSuspendedBox,
  startBatch,
  startSignalTransition,
  untracked
};
