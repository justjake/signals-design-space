// ../../libs/arena/src/index.ts
var recNext = 8;
var nodeFreeHead = 0;
var linkFreeHead = 0;
var growPending = false;
var cycle = 0;
var runDepth = 0;
var batchDepth = 0;
var notifyIndex = 0;
var queuedLength = 0;
var activeSub = 0;
var enterDepth = 0;
var queued = [];
var pendingFree = [];
var values = [void 0, void 0];
var fns = [void 0];
var propStack = new Int32Array(4096);
var propSp = 0;
var checkStack = new Int32Array(4096);
var checkSp = 0;
function createEngine(records, carry) {
  const M = new Int32Array(records * 8);
  const vals = values;
  const fnTab = fns;
  const queue = queued;
  if (carry !== void 0) {
    M.set(carry);
  }
  const WM = Math.min(M.length >> 1, M.length - 1280 /* REC_SLACK */ * 8);
  if (recNext > WM) {
    growPending = true;
  }
  return {
    records,
    buffer: () => M,
    newSignal,
    newComputed,
    newEffect,
    newScope,
    gen: (id) => M[id + 5 /* GEN */],
    read,
    write,
    computedRead,
    run,
    requeueAbort,
    dispose,
    sweepPendingFree
  };
  function allocNode(flags) {
    let id;
    if (nodeFreeHead !== 0) {
      id = nodeFreeHead;
      nodeFreeHead = M[id + 1 /* DEPS */];
      M[id + 1 /* DEPS */] = 0;
    } else {
      id = recNext;
      if (id >= M.length) {
        throw new Error("@lab/arena: arena exhausted mid-operation; raise ARENA_INITIAL_RECORDS");
      }
      recNext = id + 8;
      if (recNext > WM) {
        growPending = true;
      }
    }
    M[id + 0 /* FLAGS */] = flags;
    const v = id >> 2;
    while (vals.length <= v + 1) {
      vals.push(void 0);
    }
    while (fnTab.length <= id >> 3) {
      fnTab.push(void 0);
    }
    return id;
  }
  function freeNode(id) {
    M[id + 0 /* FLAGS */] = 0;
    M[id + 2 /* DEPS_TAIL */] = 0;
    M[id + 3 /* SUBS */] = 0;
    M[id + 4 /* SUBS_TAIL */] = 0;
    ++M[id + 5 /* GEN */];
    const v = id >> 2;
    vals[v] = void 0;
    vals[v + 1] = void 0;
    fnTab[id >> 3] = void 0;
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
        throw new Error("@lab/arena: arena exhausted mid-operation; raise ARENA_INITIAL_RECORDS");
      }
      recNext = id + 8;
      if (recNext > WM) {
        growPending = true;
      }
    }
    return id;
  }
  function freeLink(id) {
    M[id + 6 /* NEXT_DEP */] = linkFreeHead;
    linkFreeHead = id;
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
        notify(sub);
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
          notify(sub);
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
    if (flags & 256 /* K_COMPUTED */) {
      return updateComputed(node);
    }
    if (flags & 128 /* K_SIGNAL */) {
      return updateSignal(node);
    }
    M[node + 0 /* FLAGS */] = flags & 1920 /* KIND_MASK */ | 1 /* MUTABLE */;
    return true;
  }
  function notify(e) {
    let insertIndex = queuedLength;
    const firstInsertedIndex = insertIndex;
    do {
      queue[insertIndex++] = e;
      M[e + 0 /* FLAGS */] &= ~2 /* WATCHING */;
      const subs = M[e + 3 /* SUBS */];
      e = subs !== 0 ? M[subs + 2 /* SUB */] : 0;
      if (e === 0 || !(M[e + 0 /* FLAGS */] & 2 /* WATCHING */)) {
        break;
      }
    } while (true);
    queuedLength = insertIndex;
    let left = firstInsertedIndex;
    while (left < --insertIndex) {
      const tmp = queue[left];
      queue[left++] = queue[insertIndex];
      queue[insertIndex] = tmp;
    }
  }
  function unwatched(node) {
    const flags = M[node + 0 /* FLAGS */];
    if (flags & 256 /* K_COMPUTED */) {
      if (M[node + 2 /* DEPS_TAIL */] !== 0) {
        M[node + 0 /* FLAGS */] = 256 /* K_COMPUTED */ | 1 /* MUTABLE */ | 16 /* DIRTY */;
        disposeAllDepsInReverse(node);
      }
    } else if (flags & 128 /* K_SIGNAL */) {
    } else if (flags & (512 /* K_EFFECT */ | 1024 /* K_SCOPE */)) {
      dispose(node);
    }
  }
  function unlinkChildEffects(sub) {
    let cur = M[sub + 2 /* DEPS_TAIL */];
    while (cur !== 0) {
      const prev = M[cur + 5 /* PREV_DEP */];
      const dep = M[cur + 1 /* DEP */];
      if (!(M[dep + 0 /* FLAGS */] & (256 /* K_COMPUTED */ | 128 /* K_SIGNAL */))) {
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
    M[c + 0 /* FLAGS */] = 256 /* K_COMPUTED */ | 1 /* MUTABLE */ | 4 /* RECURSED_CHECK */;
    const prevSub = activeSub;
    activeSub = c;
    ++enterDepth;
    try {
      ++cycle;
      const v = c >> 2;
      const oldValue = vals[v];
      return oldValue !== (vals[v] = fnTab[c >> 3](oldValue));
    } finally {
      --enterDepth;
      activeSub = prevSub;
      M[c + 0 /* FLAGS */] &= ~4 /* RECURSED_CHECK */;
      purgeDeps(c);
    }
  }
  function updateSignal(s) {
    M[s + 0 /* FLAGS */] = 128 /* K_SIGNAL */ | 1 /* MUTABLE */;
    const v = s >> 2;
    return vals[v] !== (vals[v] = vals[v + 1]);
  }
  function run(e) {
    const flags = M[e + 0 /* FLAGS */];
    if (flags & 16 /* DIRTY */ || flags & 32 /* PENDING */ && checkDirty(M[e + 1 /* DEPS */], e)) {
      if (flags & 64 /* HAS_CHILD_EFFECT */) {
        unlinkChildEffects(e);
      }
      const cv = (e >> 2) + 1;
      if (vals[cv]) {
        runCleanup(e);
        if (M[e + 0 /* FLAGS */] === 0) {
          return;
        }
      }
      M[e + 2 /* DEPS_TAIL */] = 0;
      M[e + 0 /* FLAGS */] = 512 /* K_EFFECT */ | 2 /* WATCHING */ | 4 /* RECURSED_CHECK */;
      const prevSub = activeSub;
      activeSub = e;
      ++enterDepth;
      try {
        ++cycle;
        ++runDepth;
        vals[cv] = fnTab[e >> 3]();
      } finally {
        --runDepth;
        --enterDepth;
        activeSub = prevSub;
        M[e + 0 /* FLAGS */] &= ~4 /* RECURSED_CHECK */;
        purgeDeps(e);
      }
    } else if (M[e + 1 /* DEPS */] !== 0) {
      M[e + 0 /* FLAGS */] = 512 /* K_EFFECT */ | 2 /* WATCHING */ | flags & 64 /* HAS_CHILD_EFFECT */;
    }
  }
  function requeueAbort(e) {
    if (M[e + 0 /* FLAGS */] & 1920 /* KIND_MASK */) {
      M[e + 0 /* FLAGS */] |= 2 /* WATCHING */ | 8 /* RECURSED */;
    }
  }
  function runCleanup(e) {
    const cv = (e >> 2) + 1;
    const cleanup = vals[cv];
    vals[cv] = void 0;
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
    if (!(flags & 1920 /* KIND_MASK */)) {
      return;
    }
    M[e + 0 /* FLAGS */] = 0;
    disposeAllDepsInReverse(e);
    const sub = M[e + 3 /* SUBS */];
    if (sub !== 0) {
      unlink(sub);
    }
    if (flags & 512 /* K_EFFECT */ && vals[(e >> 2) + 1]) {
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
  function newSignal(value) {
    const id = allocNode(128 /* K_SIGNAL */ | 1 /* MUTABLE */);
    const v = id >> 2;
    vals[v] = value;
    vals[v + 1] = value;
    return id;
  }
  function newComputed(getter) {
    const id = allocNode(256 /* K_COMPUTED */);
    fnTab[id >> 3] = getter;
    return id;
  }
  function newEffect(fn) {
    const e = allocNode(512 /* K_EFFECT */ | 2 /* WATCHING */ | 4 /* RECURSED_CHECK */);
    fnTab[e >> 3] = fn;
    const prevSub = activeSub;
    activeSub = e;
    if (prevSub !== 0) {
      link(e, prevSub, 0);
      M[prevSub + 0 /* FLAGS */] |= 64 /* HAS_CHILD_EFFECT */;
    }
    ++enterDepth;
    try {
      ++runDepth;
      vals[(e >> 2) + 1] = fn();
    } finally {
      --runDepth;
      --enterDepth;
      activeSub = prevSub;
      M[e + 0 /* FLAGS */] &= ~4 /* RECURSED_CHECK */;
    }
    return e;
  }
  function newScope(fn) {
    const e = allocNode(1024 /* K_SCOPE */ | 1 /* MUTABLE */);
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
  function read(s) {
    if (M[s + 0 /* FLAGS */] & 16 /* DIRTY */) {
      if (updateSignal(s)) {
        const subs = M[s + 3 /* SUBS */];
        if (subs !== 0) {
          shallowPropagate(subs);
        }
      }
    }
    if (activeSub !== 0) {
      link(s, activeSub, cycle);
    }
    return vals[s >> 2];
  }
  function write(s, value) {
    const p = (s >> 2) + 1;
    if (vals[p] !== (vals[p] = value)) {
      M[s + 0 /* FLAGS */] = 128 /* K_SIGNAL */ | 1 /* MUTABLE */ | 16 /* DIRTY */;
      const subs = M[s + 3 /* SUBS */];
      if (subs !== 0) {
        propagate(subs, runDepth !== 0);
        return true;
      }
    }
    return false;
  }
  function computedRead(c) {
    const flags = M[c + 0 /* FLAGS */];
    if (flags & 16 /* DIRTY */ || flags & 32 /* PENDING */ && (checkDirty(M[c + 1 /* DEPS */], c) || (M[c + 0 /* FLAGS */] = flags & ~32 /* PENDING */, false))) {
      if (updateComputed(c)) {
        const subs = M[c + 3 /* SUBS */];
        if (subs !== 0) {
          shallowPropagate(subs);
        }
      }
    } else if (flags === 256 /* K_COMPUTED */) {
      M[c + 0 /* FLAGS */] = 256 /* K_COMPUTED */ | 1 /* MUTABLE */ | 4 /* RECURSED_CHECK */;
      const prevSub = activeSub;
      activeSub = c;
      ++enterDepth;
      try {
        vals[c >> 2] = fnTab[c >> 3]();
      } finally {
        --enterDepth;
        activeSub = prevSub;
        M[c + 0 /* FLAGS */] &= ~4 /* RECURSED_CHECK */;
      }
    }
    const sub = activeSub;
    if (sub !== 0) {
      link(c, sub, cycle);
    }
    return vals[c >> 2];
  }
}
var initialRecords = (() => {
  const env = globalThis.process?.env?.ARENA_INITIAL_RECORDS;
  const n = env !== void 0 ? Number(env) : NaN;
  return Number.isFinite(n) && n >= 2 ? Math.ceil(n) : 1 << 20;
})();
var E = createEngine(initialRecords * 3);
function maybeBoundary() {
  if (enterDepth === 0 && (growPending || pendingFree.length !== 0)) {
    boundaryWork();
  }
}
function boundaryWork() {
  if (pendingFree.length !== 0 && queuedLength === 0) {
    E.sweepPendingFree();
  }
  if (growPending) {
    growPending = false;
    let records = E.records;
    while (recNext > Math.min(records * 8 >> 1, (records - 1280 /* REC_SLACK */) * 8)) {
      records *= 2;
    }
    if (records !== E.records) {
      E = createEngine(records, E.buffer());
    }
  }
}
function flush() {
  maybeBoundary();
  const engine = E;
  const queue = queued;
  try {
    while (notifyIndex < queuedLength) {
      const e = queue[notifyIndex];
      queue[notifyIndex++] = 0;
      engine.run(e);
    }
  } finally {
    while (notifyIndex < queuedLength) {
      const e = queue[notifyIndex];
      queue[notifyIndex++] = 0;
      E.requeueAbort(e);
    }
    notifyIndex = 0;
    queuedLength = 0;
  }
}
function signal(initialValue) {
  maybeBoundary();
  const id = E.newSignal(initialValue);
  return function(...value) {
    if (value.length) {
      maybeBoundary();
      if (E.write(id, value[0]) && !batchDepth) {
        flush();
      }
    } else {
      return E.read(id);
    }
  };
}
function computed(getter) {
  maybeBoundary();
  const id = E.newComputed(getter);
  return () => E.computedRead(id);
}
function effect(fn) {
  maybeBoundary();
  const id = E.newEffect(fn);
  const gen = E.gen(id);
  return () => {
    if (E.gen(id) !== gen) {
      return;
    }
    E.dispose(id);
    maybeBoundary();
  };
}
function effectScope(fn) {
  maybeBoundary();
  const id = E.newScope(fn);
  const gen = E.gen(id);
  return () => {
    if (E.gen(id) !== gen) {
      return;
    }
    E.dispose(id);
    maybeBoundary();
  };
}
function startBatch() {
  ++batchDepth;
}
function endBatch() {
  if (!--batchDepth && notifyIndex < queuedLength) {
    flush();
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
function getActiveSub() {
  return activeSub;
}
function setActiveSub(sub = 0) {
  const prevSub = activeSub;
  activeSub = sub;
  return prevSub;
}
export {
  computed,
  effect,
  effectScope,
  endBatch,
  getActiveSub,
  setActiveSub,
  signal,
  startBatch,
  untracked
};
