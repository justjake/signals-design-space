/**
 * cosignals-alt-a engine — variant A (monotonic write-gate activation) of the
 * react-concurrent-signals-arena-alt-a spec, milestones M1–M3.
 *
 * M1: the canonical kernel is a port of the proven arena engine at
 * libs/arena/src/index.ts (alien-signals v3.2.1 semantics on interleaved
 * Int32Array records), extended with the spec's five overlay-support
 * mechanisms (§8.7): broadcast list, notify walk, mark repair on new edges,
 * invalidate, and log-plane allocation.
 * M2: tape mechanics — monotonic activation (§9.1), batch-slot interning
 * (§9.2), appendLog with mark-on-creation and the equality/receipt rule
 * (§9.3), applied/unapplied writes (§9.4), notify walk + token-grouped
 * drain (§9.8).
 * M3: worlds — visibility (§10.2–10.3), plane W world memos + certificates
 * + slot chains (§10.5), drain re-validation (§9.8), post-eval re-check
 * (§10.4), retirement/absorption (§9.5), sweep/truncation (§9.6),
 * coalescing (§9.3), quiescence + epoch bump (§9.7).
 *
 * Coordinator-adopted resolutions (see SPEC-RESOLUTIONS.md): urgent drains
 * decide in W0 PLUS every live deferred world (1,3); applied logged writes
 * always queue a token-0 walk (2); truncation re-notifies its batch's lane
 * (4); overlay frames always recurse via overlayEvaluate (5); one
 * retire-time ticket per retirement (7a); missing-world broadcast baseline
 * is the current W0 value, with subscription-time seeding of live deferred
 * worlds (7b). Grouped drains use one walk ticket PER TOKEN GROUP;
 * re-validation runs BEFORE broadcast decisions; re-validation snapshots
 * the old memo value before re-evaluating.
 *
 * Deviations this pass (perf work deferred; documented in the final report):
 * planes are `let` bindings grown in place by doubling (the spec's
 * const-closure rebuild is a measured perf design, not a semantic one);
 * the W certificate region is a separate Int32Array rather than the tail
 * half of plane W; constants are a hand-written same-file const enum
 * structured for the §15 codegen to take over later.
 */

// ---- layout constants (hand-written; future codegen target, §15) -----------
const enum C {
	// Node fields (plane M, stride 8; ids pre-multiplied: id = record * 8).
	FLAGS = 0,
	DEPS = 1, // doubles as free-list next for freed node records
	DEPS_TAIL = 2,
	SUBS = 3,
	SUBS_TAIL = 4,
	GEN = 5,
	// +6: atoms LOG_HEAD; computeds/effects/watchers OVERLAY_STAMP.
	LOG_HEAD = 6,
	OVERLAY_STAMP = 6,
	// +7: atoms LOG_TAIL; computeds MEMO_KEY (first memo record's world key).
	LOG_TAIL = 7,
	MEMO_KEY = 7,

	// Link fields (plane M, stride 8, interleaved with nodes).
	VERSION = 0,
	DEP = 1,
	SUB = 2,
	PREV_SUB = 3,
	NEXT_SUB = 4,
	PREV_DEP = 5,
	NEXT_DEP = 6, // doubles as free-list next for freed link records

	// Log entry fields (plane G, stride 4).
	L_NEXT = 0, // doubles as free-list next
	L_META = 1,
	L_SEQ = 2,
	L_RETIRED_SEQ = 3,

	// World-memo fields (plane W, stride 8).
	W_KEY = 0,
	W_EPOCH = 1, // 0 = tombstone (overlayEpoch starts at 1)
	W_NODE = 2,
	W_VAL = 3,
	W_NEXT_MEMO = 4,
	W_SLOT_NEXT = 5,
	W_NDEPS = 6,
	W_CERT = 7,

	// Flags (spec §7.2).
	MUTABLE = 1,
	WATCHING = 2,
	RECURSED_CHECK = 4,
	RECURSED = 8,
	DIRTY = 16,
	PENDING = 32,
	HAS_CHILD_EFFECT = 64,
	LOGGED = 128,
	IMMEDIATE = 256,
	LIVE = 512,
	K_ATOM = 1024,
	K_COMPUTED = 2048,
	K_EFFECT = 4096,
	K_SCOPE = 8192,
	K_WATCHER = 16384,
	KIND_MASK = K_ATOM | K_COMPUTED | K_EFFECT | K_SCOPE | K_WATCHER,

	// Log META packing (§7.3): bits 0–1 OP, bit 2 APPLIED, bit 3 RETIRED,
	// bits 4–8 BATCH_SLOT, bit 9 PSEUDO (slot-exhaustion fallback, §9.2).
	OP_BASE = 0,
	OP_SET = 1,
	OP_UPDATE = 2,
	OP_DISPATCH = 3,
	OP_MASK = 3,
	M_APPLIED = 4,
	M_RETIRED = 8,
	SLOT_SHIFT = 4,
	SLOT_MASK = 31,
	M_PSEUDO = 512,

	// Read contexts (§10.1).
	CTX_NEWEST = 1,
	CTX_RENDER = 2,
	CTX_COMMITTED = 3,

	// World kinds (internal world descriptors).
	WK_W0 = 0,
	WK_NEWEST = 1,
	WK_PASS = 2,
	WK_WRITER = 3,
	WK_COMMITTED = 4,

	// Write modes (§9.1).
	MODE_DIRECT = 0,
	MODE_LOGGED = 1,

	MAX_SEQ = 0x7fffffff,
}

import type { Container, ExternalRuntimeListener, ForkAdapter } from './fork-double';

// ---- public types -----------------------------------------------------------

export type Equality<T> = (a: T, b: T) => boolean;

export type AtomHandle<T> = {
	readonly kind: 'atom';
	readonly id: number;
	readonly state: T;
	peek(): T;
	set(next: T): void;
	update(fn: (current: T) => T): void;
};

export type ReducerAtomHandle<S, A> = {
	readonly kind: 'reducerAtom';
	readonly id: number;
	readonly state: S;
	peek(): S;
	dispatch(action: A): void;
};

export type ComputedHandle<T> = {
	readonly kind: 'computed';
	readonly id: number;
	readonly state: T;
};

export type SignalHandle = { readonly id: number };

export type WatcherHandle = {
	readonly id: number;
	dispose(): void;
};

export type BroadcastEvent = {
	watcherId: number;
	/** Batch token whose lane the setState was scheduled into; 0 = urgent. */
	token: number;
	/** The value the watched node had in the decision world. */
	value: unknown;
	/** Token the fork reported as current write batch inside the callback —
	 * lane-parity evidence for tests (equals `token` when entangled). */
	forkBatchDuringCallback: number;
};

export type WorldSelector =
	| { kind: 'w0' }
	| { kind: 'newest' }
	| { kind: 'committed' }
	| { kind: 'writer'; token: number }
	| { kind: 'pass' };

export type EngineOptions = {
	initialRecords?: number; // main-plane records (default 8192)
	initialLogRecords?: number; // log-plane records (default 1024)
	initialMemoRecords?: number; // memo-plane records (default 1024)
};

type WorldDesc = {
	k: number; // C.WK_*
	key: number; // memo key (§10.5); -1 = not memoized
	token: number; // writer worlds
	slot: number; // writer worlds
	pin: number; // pass worlds
	mask: number; // pass worlds
};

type NodeMeta = {
	label?: string;
	isEqual?: Equality<unknown>;
	reducer?: (state: unknown, action: unknown) => unknown;
	rawFn?: () => unknown;
	lastBroadcast?: Map<number, unknown>;
	watchedId?: number;
	onBroadcast?: (ev: BroadcastEvent) => void;
};

export function createCosignalEngine(options?: EngineOptions) {
	// ---- planes ---------------------------------------------------------------
	let M = new Int32Array((options?.initialRecords ?? 8192) * 8);
	let G = new Int32Array((options?.initialLogRecords ?? 1024) * 4);
	let W = new Int32Array((options?.initialMemoRecords ?? 1024) * 8);
	let WC = new Int32Array((options?.initialMemoRecords ?? 1024) * 8); // certificate region

	// Bump pointers (record 0 burned in every plane) and free lists.
	let recNext = 8;
	let nodeFreeHead = 0;
	let linkFreeHead = 0;
	let gNext = 4;
	let logFreeHead = 0;
	let wNext = 8;
	let certNext = 2; // offset 0 burned so CERT=0 can mean "none"

	// ---- side columns -----------------------------------------------------------
	const values: unknown[] = [undefined, undefined];
	const fns: (Function | undefined)[] = [undefined];
	const memos: number[] = [0]; // node memo-chain heads (guarded by W_NODE check)
	const metas: (NodeMeta | undefined)[] = [undefined];
	const logVals: unknown[] = [undefined];
	const memoVals: unknown[] = [];

	// ---- kernel scalars -----------------------------------------------------------
	let cycle = 0;
	let runDepth = 0;
	let batchDepth = 0;
	let notifyIndex = 0;
	let queuedLength = 0;
	let activeSub = 0;
	let enterDepth = 0;
	const queued: number[] = [];
	const pendingFree: number[] = [];

	// ---- overlay scalars -----------------------------------------------------------
	let writeMode: number = C.MODE_DIRECT;
	let seqCounter = 1; // ticket() pre-increments; resets to 1 at quiescence
	let walkCounter = 0;
	let eraFloor = 0;
	let overlayEpoch = 1;
	let loggedAtomCount = 0;
	let unappliedEntries = 0;
	let quiescenceCount = 0;
	const loggedAtoms: number[] = [];
	const allNodes: number[] = []; // for the walk-counter safety valve + verify

	const batchToken = new Int32Array(32);
	const batchEntryCount = new Int32Array(32);
	const slotMemoHead = new Int32Array(32);
	let liveSlotMask = 0;
	let liveDeferredMask = 0;
	let retiredSlotMask = 0; // token retired, entries not yet fully swept
	let lastToken = 0;
	let lastSlot = -1;

	// Pass set (§10.1). One pass at a time (§6.3).
	let passOpen = 0;
	let passExecuting = 0;
	let passSerial = 0;
	let passPin = 0;
	let passIncludeMask = 0;
	let passIncludePseudo = 0;
	let passContainer: Container = undefined;
	let passLineage = 0;
	let readCtx: number = C.CTX_NEWEST;

	// Evaluation-mode tracking.
	let canonicalEvalDepth = 0; // inside kernel updateComputed / first-eval
	// Overlay evaluation frames (world stack); certStack is the collector.
	const frameWorlds: WorldDesc[] = [];
	let certStack = new Int32Array(4096);
	let certSp = 0;

	// Pending notify-walk requests: flat (atomId, token) pairs awaiting drain.
	const pendingWalks: number[] = [];
	// Kernel broadcast queue (watcher ids; kernel propagate pushes token 0).
	const kernelBroadcasts: number[] = [];
	let drainDepth = 0;
	const broadcastLog: BroadcastEvent[] = []; // observable drain output

	// Fork wiring.
	let fork: ForkAdapter | undefined;
	let unsubscribeFork: (() => void) | undefined;

	// Persistent traversal scratch (saved-base discipline).
	let propStack = new Int32Array(4096);
	let propSp = 0;
	let checkStack = new Int32Array(4096);
	let checkSp = 0;

	// ---- plane growth (in-place doubling; see header deviation note) -----------
	function growM(): void {
		const bigger = new Int32Array(M.length * 2);
		bigger.set(M);
		M = bigger;
	}
	function growG(): void {
		const bigger = new Int32Array(G.length * 2);
		bigger.set(G);
		G = bigger;
	}
	function growW(): void {
		const bigger = new Int32Array(W.length * 2);
		bigger.set(W);
		W = bigger;
	}
	function growWC(): void {
		const bigger = new Int32Array(WC.length * 2);
		bigger.set(WC);
		WC = bigger;
	}
	function growCertStack(): void {
		const bigger = new Int32Array(certStack.length * 2);
		bigger.set(certStack);
		certStack = bigger;
	}

	// ---- allocation ---------------------------------------------------------------
	function allocNode(flags: number): number {
		let id: number;
		if (nodeFreeHead !== 0) {
			id = nodeFreeHead;
			nodeFreeHead = M[id + C.DEPS];
			M[id + C.DEPS] = 0;
		} else {
			id = recNext;
			if (id >= M.length) {
				growM();
			}
			recNext = id + 8;
			allNodes.push(id);
		}
		M[id + C.FLAGS] = flags;
		const v = id >> 2;
		while (values.length <= v + 1) {
			values.push(undefined);
		}
		while (fns.length <= id >> 3) {
			fns.push(undefined);
			memos.push(0);
			metas.push(undefined);
		}
		return id;
	}

	function freeNode(id: number): void {
		M[id + C.FLAGS] = 0;
		M[id + C.DEPS_TAIL] = 0;
		M[id + C.SUBS] = 0;
		M[id + C.SUBS_TAIL] = 0;
		M[id + C.LOG_HEAD] = 0;
		M[id + C.LOG_TAIL] = 0;
		++M[id + C.GEN];
		const v = id >> 2;
		values[v] = undefined;
		values[v + 1] = undefined;
		fns[id >> 3] = undefined;
		memos[id >> 3] = 0;
		metas[id >> 3] = undefined;
		M[id + C.DEPS] = nodeFreeHead;
		nodeFreeHead = id;
	}

	function sweepPendingFree(): void {
		for (let i = 0; i < pendingFree.length; ++i) {
			freeNode(pendingFree[i]);
		}
		pendingFree.length = 0;
	}

	function allocLink(): number {
		let id: number;
		if (linkFreeHead !== 0) {
			id = linkFreeHead;
			linkFreeHead = M[id + C.NEXT_DEP];
		} else {
			id = recNext;
			if (id >= M.length) {
				growM();
			}
			recNext = id + 8;
		}
		return id;
	}

	function freeLink(id: number): void {
		M[id + C.NEXT_DEP] = linkFreeHead;
		linkFreeHead = id;
	}

	function allocLog(): number {
		let gid: number;
		if (logFreeHead !== 0) {
			gid = logFreeHead;
			logFreeHead = G[gid + C.L_NEXT];
		} else {
			gid = gNext;
			if (gid >= G.length) {
				growG();
			}
			gNext = gid + 4;
		}
		G[gid + C.L_NEXT] = 0;
		while (logVals.length <= gid >> 2) {
			logVals.push(undefined);
		}
		return gid;
	}

	function freeLog(gid: number): void {
		logVals[gid >> 2] = undefined;
		G[gid + C.L_NEXT] = logFreeHead;
		logFreeHead = gid;
	}

	function allocMemo(): number {
		const wid = wNext;
		if (wid >= W.length) {
			growW();
		}
		wNext = wid + 8;
		return wid;
	}

	// ---- kernel: topology (arena transliteration) --------------------------------
	function link(dep: number, sub: number, version: number): void {
		const prevDep = M[sub + C.DEPS_TAIL];
		if (prevDep !== 0 && M[prevDep + C.DEP] === dep) {
			return;
		}
		const nextDep = prevDep !== 0 ? M[prevDep + C.NEXT_DEP] : M[sub + C.DEPS];
		if (nextDep !== 0 && M[nextDep + C.DEP] === dep) {
			M[nextDep + C.VERSION] = version;
			M[sub + C.DEPS_TAIL] = nextDep;
			return;
		}
		linkInsert(dep, sub, version, prevDep, nextDep);
	}

	// Out-of-line insertion tail (kept split per §8.2/§18.3). The overlay's
	// mark repair (§8.7.3) lives here — never in link().
	function linkInsert(dep: number, sub: number, version: number, prevDep: number, nextDep: number): void {
		const prevSub = M[dep + C.SUBS_TAIL];
		if (prevSub !== 0 && M[prevSub + C.VERSION] === version && M[prevSub + C.SUB] === sub) {
			return;
		}
		const newLink = allocLink();
		M[sub + C.DEPS_TAIL] = newLink;
		M[dep + C.SUBS_TAIL] = newLink;
		M[newLink + C.VERSION] = version;
		M[newLink + C.DEP] = dep;
		M[newLink + C.SUB] = sub;
		M[newLink + C.PREV_DEP] = prevDep;
		M[newLink + C.NEXT_DEP] = nextDep;
		M[newLink + C.PREV_SUB] = prevSub;
		M[newLink + C.NEXT_SUB] = 0;
		if (nextDep !== 0) {
			M[nextDep + C.PREV_DEP] = newLink;
		}
		if (prevDep !== 0) {
			M[prevDep + C.NEXT_DEP] = newLink;
		} else {
			M[sub + C.DEPS] = newLink;
		}
		if (prevSub !== 0) {
			M[prevSub + C.NEXT_SUB] = newLink;
		} else {
			M[dep + C.SUBS] = newLink;
		}
		// Overlay mark repair (§8.7.3): a canonical evaluation just picked up a
		// logged/marked producer mid-era — stamp the consumer's cone so
		// world-sensitive readers stop trusting kernel caches below it.
		if (loggedAtomCount !== 0) {
			const df = M[dep + C.FLAGS];
			const producerMarked =
				(df & C.LOGGED) !== 0
				|| ((df & C.K_ATOM) === 0 && M[dep + C.OVERLAY_STAMP] > eraFloor);
			if (producerMarked) {
				if (walkCounter <= eraFloor) {
					walkCounter = eraFloor + 1;
				}
				stampCone(sub, walkCounter, false, 0);
			}
		}
	}

	function unlink(id: number, sub = M[id + C.SUB]): number {
		const dep = M[id + C.DEP];
		const prevDep = M[id + C.PREV_DEP];
		const nextDep = M[id + C.NEXT_DEP];
		const nextSub = M[id + C.NEXT_SUB];
		const prevSub = M[id + C.PREV_SUB];
		if (nextDep !== 0) {
			M[nextDep + C.PREV_DEP] = prevDep;
		} else {
			M[sub + C.DEPS_TAIL] = prevDep;
		}
		if (prevDep !== 0) {
			M[prevDep + C.NEXT_DEP] = nextDep;
		} else {
			M[sub + C.DEPS] = nextDep;
		}
		if (nextSub !== 0) {
			M[nextSub + C.PREV_SUB] = prevSub;
		} else {
			M[dep + C.SUBS_TAIL] = prevSub;
		}
		freeLink(id);
		if (prevSub !== 0) {
			M[prevSub + C.NEXT_SUB] = nextSub;
		} else if ((M[dep + C.SUBS] = nextSub) === 0) {
			unwatched(dep);
		}
		return nextDep;
	}

	// ---- kernel: traversals ---------------------------------------------------
	function propagate(startLink: number, innerWrite: boolean): void {
		let cur = startLink;
		let next = M[cur + C.NEXT_SUB];
		const stackBase = propSp;

		top: do {
			const sub = M[cur + C.SUB];
			let flags = M[sub + C.FLAGS];

			if (!(flags & (C.RECURSED_CHECK | C.RECURSED | C.DIRTY | C.PENDING))) {
				M[sub + C.FLAGS] = flags | C.PENDING;
				if (innerWrite) {
					M[sub + C.FLAGS] |= C.RECURSED;
				}
			} else if (!(flags & (C.RECURSED_CHECK | C.RECURSED))) {
				flags = 0;
			} else if (!(flags & C.RECURSED_CHECK)) {
				M[sub + C.FLAGS] = (flags & ~C.RECURSED) | C.PENDING;
			} else if (!(flags & (C.DIRTY | C.PENDING)) && isValidLink(cur, sub)) {
				M[sub + C.FLAGS] = flags | (C.RECURSED | C.PENDING);
				flags &= C.MUTABLE;
			} else {
				flags = 0;
			}

			if (flags & C.WATCHING) {
				// Overlay-support #1 (§8.7.1): IMMEDIATE watchers route to the
				// broadcast list (token 0 — urgent) instead of the effect queue.
				if (M[sub + C.FLAGS] & C.IMMEDIATE) {
					kernelBroadcasts.push(sub);
				} else {
					notify(sub);
				}
			}

			if (flags & C.MUTABLE) {
				const subSubs = M[sub + C.SUBS];
				if (subSubs !== 0) {
					cur = subSubs;
					const nextSub = M[cur + C.NEXT_SUB];
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
				next = M[cur + C.NEXT_SUB];
				continue;
			}

			while (propSp > stackBase) {
				cur = propStack[--propSp];
				if (cur !== 0) {
					next = M[cur + C.NEXT_SUB];
					continue top;
				}
			}

			break;
		} while (true);
	}

	function checkDirty(startLink: number, startSub: number): boolean {
		let cur = startLink;
		let sub = startSub;
		const stackBase = checkSp;
		let checkDepth = 0;
		let dirty = false;

		try {
			top: do {
				const dep = M[cur + C.DEP];
				const depFlags = M[dep + C.FLAGS];

				if (M[sub + C.FLAGS] & C.DIRTY) {
					dirty = true;
				} else if ((depFlags & (C.MUTABLE | C.DIRTY)) === (C.MUTABLE | C.DIRTY)) {
					const depSubs = M[dep + C.SUBS];
					if (update(dep)) {
						if (M[depSubs + C.NEXT_SUB] !== 0) {
							shallowPropagate(depSubs);
						}
						dirty = true;
					}
				} else if ((depFlags & (C.MUTABLE | C.PENDING)) === (C.MUTABLE | C.PENDING)) {
					if (checkSp === checkStack.length) {
						const bigger = new Int32Array(checkStack.length * 2);
						bigger.set(checkStack);
						checkStack = bigger;
					}
					checkStack[checkSp++] = cur;
					cur = M[dep + C.DEPS];
					sub = dep;
					++checkDepth;
					continue;
				}

				if (!dirty) {
					const nextDep = M[cur + C.NEXT_DEP];
					if (nextDep !== 0) {
						cur = nextDep;
						continue;
					}
				}

				while (checkDepth--) {
					cur = checkStack[--checkSp];
					if (dirty) {
						const subSubs = M[sub + C.SUBS];
						if (update(sub)) {
							if (M[subSubs + C.NEXT_SUB] !== 0) {
								shallowPropagate(subSubs);
							}
							sub = M[cur + C.SUB];
							continue;
						}
						dirty = false;
					} else {
						M[sub + C.FLAGS] &= ~C.PENDING;
					}
					sub = M[cur + C.SUB];
					const nextDep = M[cur + C.NEXT_DEP];
					if (nextDep !== 0) {
						cur = nextDep;
						continue top;
					}
				}

				return dirty && M[sub + C.FLAGS] !== 0;
			} while (true);
		} finally {
			checkSp = stackBase;
		}
	}

	function shallowPropagate(startLink: number): void {
		let cur = startLink;
		do {
			const sub = M[cur + C.SUB];
			const flags = M[sub + C.FLAGS];
			if ((flags & (C.PENDING | C.DIRTY)) === C.PENDING) {
				M[sub + C.FLAGS] = flags | C.DIRTY;
				if ((flags & (C.WATCHING | C.RECURSED_CHECK)) === C.WATCHING) {
					if (flags & C.IMMEDIATE) {
						kernelBroadcasts.push(sub);
					} else {
						notify(sub);
					}
				}
			}
		} while ((cur = M[cur + C.NEXT_SUB]) !== 0);
	}

	function isValidLink(checkLink: number, sub: number): boolean {
		let cur = M[sub + C.DEPS_TAIL];
		while (cur !== 0) {
			if (cur === checkLink) {
				return true;
			}
			cur = M[cur + C.PREV_DEP];
		}
		return false;
	}

	// ---- kernel: kind dispatch and scheduling ----------------------------------
	function update(node: number): boolean {
		const flags = M[node + C.FLAGS];
		if (flags & C.K_COMPUTED) {
			return updateComputed(node);
		}
		if (flags & C.K_ATOM) {
			return updateAtom(node);
		}
		M[node + C.FLAGS] = (flags & (C.KIND_MASK | C.IMMEDIATE | C.LIVE)) | C.MUTABLE;
		return true;
	}

	function notify(e: number): void {
		let insertIndex = queuedLength;
		const firstInsertedIndex = insertIndex;

		do {
			queued[insertIndex++] = e;
			M[e + C.FLAGS] &= ~C.WATCHING;
			const subs = M[e + C.SUBS];
			e = subs !== 0 ? M[subs + C.SUB] : 0;
			if (e === 0 || !(M[e + C.FLAGS] & C.WATCHING) || M[e + C.FLAGS] & C.IMMEDIATE) {
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

	function unwatched(node: number): void {
		const flags = M[node + C.FLAGS];
		if (flags & C.K_COMPUTED) {
			if (M[node + C.DEPS_TAIL] !== 0) {
				M[node + C.FLAGS] = C.K_COMPUTED | C.MUTABLE | C.DIRTY | (flags & (C.LIVE | C.LOGGED));
				disposeAllDepsInReverse(node);
			}
		} else if (flags & C.K_ATOM) {
			// nothing to do
		} else if (flags & (C.K_EFFECT | C.K_SCOPE | C.K_WATCHER)) {
			dispose(node);
		}
	}

	function unlinkChildEffects(sub: number): void {
		let cur = M[sub + C.DEPS_TAIL];
		while (cur !== 0) {
			const prev = M[cur + C.PREV_DEP];
			const dep = M[cur + C.DEP];
			if (!(M[dep + C.FLAGS] & (C.K_COMPUTED | C.K_ATOM))) {
				unlink(cur, sub);
			}
			cur = prev;
		}
	}

	function updateComputed(c: number): boolean {
		if (M[c + C.FLAGS] & C.HAS_CHILD_EFFECT) {
			unlinkChildEffects(c);
		}
		const keep = M[c + C.FLAGS] & C.LIVE;
		M[c + C.DEPS_TAIL] = 0;
		M[c + C.FLAGS] = C.K_COMPUTED | C.MUTABLE | C.RECURSED_CHECK | keep;
		const prevSub = activeSub;
		activeSub = c;
		++enterDepth;
		++canonicalEvalDepth;
		try {
			++cycle;
			const v = c >> 2;
			const oldValue = values[v];
			return oldValue !== (values[v] = (fns[c >> 3] as (previousValue?: unknown) => unknown)(oldValue));
		} finally {
			--canonicalEvalDepth;
			--enterDepth;
			activeSub = prevSub;
			M[c + C.FLAGS] &= ~C.RECURSED_CHECK;
			purgeDeps(c);
		}
	}

	function updateAtom(s: number): boolean {
		M[s + C.FLAGS] = (M[s + C.FLAGS] & (C.LOGGED | C.LIVE)) | C.K_ATOM | C.MUTABLE;
		const v = s >> 2;
		return values[v] !== (values[v] = values[v + 1]);
	}

	function run(e: number): void {
		const flags = M[e + C.FLAGS];
		if (
			flags & C.DIRTY
			|| (flags & C.PENDING && checkDirty(M[e + C.DEPS], e))
		) {
			if (flags & C.HAS_CHILD_EFFECT) {
				unlinkChildEffects(e);
			}
			const cv = (e >> 2) + 1;
			if (values[cv]) {
				runCleanup(e);
				if (M[e + C.FLAGS] === 0) {
					return;
				}
			}
			M[e + C.DEPS_TAIL] = 0;
			M[e + C.FLAGS] = C.K_EFFECT | C.WATCHING | C.RECURSED_CHECK | C.LIVE;
			const prevSub = activeSub;
			activeSub = e;
			++enterDepth;
			try {
				++cycle;
				++runDepth;
				values[cv] = (fns[e >> 3] as () => (() => void) | void)();
			} finally {
				--runDepth;
				--enterDepth;
				activeSub = prevSub;
				M[e + C.FLAGS] &= ~C.RECURSED_CHECK;
				purgeDeps(e);
			}
		} else if (M[e + C.DEPS] !== 0) {
			M[e + C.FLAGS] = C.K_EFFECT | C.WATCHING | C.LIVE | (flags & C.HAS_CHILD_EFFECT);
		}
	}

	function requeueAbort(e: number): void {
		if (M[e + C.FLAGS] & C.KIND_MASK) {
			M[e + C.FLAGS] |= C.WATCHING | C.RECURSED;
		}
	}

	function runCleanup(e: number): void {
		const cv = (e >> 2) + 1;
		const cleanup = values[cv] as () => void;
		values[cv] = undefined;
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

	function dispose(e: number): void {
		const flags = M[e + C.FLAGS];
		if (!(flags & C.KIND_MASK)) {
			return;
		}
		M[e + C.FLAGS] = 0;
		disposeAllDepsInReverse(e);
		const sub = M[e + C.SUBS];
		if (sub !== 0) {
			unlink(sub);
		}
		if (flags & C.K_EFFECT && values[(e >> 2) + 1]) {
			runCleanup(e);
		}
		pendingFree.push(e);
	}

	function disposeAllDepsInReverse(sub: number): void {
		let cur = M[sub + C.DEPS_TAIL];
		while (cur !== 0) {
			const prev = M[cur + C.PREV_DEP];
			unlink(cur, sub);
			cur = prev;
		}
	}

	function purgeDeps(sub: number): void {
		const depsTail = M[sub + C.DEPS_TAIL];
		let dep = depsTail !== 0 ? M[depsTail + C.NEXT_DEP] : M[sub + C.DEPS];
		while (dep !== 0) {
			dep = unlink(dep, sub);
		}
	}

	function maybeBoundary(): void {
		if (enterDepth === 0 && pendingFree.length !== 0 && queuedLength === 0) {
			sweepPendingFree();
		}
	}

	function flush(): void {
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

	// ---- kernel: read/write ------------------------------------------------------
	// Resolve a possibly-pending atom value without linking (W0 peek).
	function kernelPeekAtom(s: number): unknown {
		if (M[s + C.FLAGS] & C.DIRTY) {
			if (updateAtom(s)) {
				const subs = M[s + C.SUBS];
				if (subs !== 0) {
					shallowPropagate(subs);
				}
			}
		}
		return values[s >> 2];
	}

	function kernelReadAtom(s: number): unknown {
		const v = kernelPeekAtom(s);
		if (activeSub !== 0) {
			link(s, activeSub, cycle);
		}
		return v;
	}

	// Kernel write: pending value + propagate. Returns true if effects queued.
	function kernelWriteAtom(s: number, value: unknown): boolean {
		const p = (s >> 2) + 1;
		if (values[p] !== (values[p] = value)) {
			M[s + C.FLAGS] |= C.DIRTY;
			const subs = M[s + C.SUBS];
			if (subs !== 0) {
				propagate(subs, runDepth !== 0);
				return true;
			}
		}
		return false;
	}

	function kernelComputedRead(c: number): unknown {
		const flags = M[c + C.FLAGS];
		if (
			flags & C.DIRTY
			|| (
				flags & C.PENDING
				&& (
					checkDirty(M[c + C.DEPS], c)
					|| (M[c + C.FLAGS] = flags & ~C.PENDING, false)
				)
			)
		) {
			if (updateComputed(c)) {
				const subs = M[c + C.SUBS];
				if (subs !== 0) {
					shallowPropagate(subs);
				}
			}
		} else if (!(flags & C.MUTABLE) && !(flags & C.DIRTY)) {
			// never evaluated (fresh computed): first canonical evaluation
			M[c + C.FLAGS] |= C.MUTABLE | C.RECURSED_CHECK;
			const prevSub = activeSub;
			activeSub = c;
			++enterDepth;
			++canonicalEvalDepth;
			try {
				values[c >> 2] = (fns[c >> 3] as (previousValue?: unknown) => unknown)(undefined);
			} finally {
				--canonicalEvalDepth;
				--enterDepth;
				activeSub = prevSub;
				M[c + C.FLAGS] &= ~C.RECURSED_CHECK;
			}
		}
		const sub = activeSub;
		if (sub !== 0) {
			link(c, sub, cycle);
		}
		return values[c >> 2];
	}

	function kernelComputedReadUntracked(c: number): unknown {
		const prevSub = activeSub;
		activeSub = 0;
		try {
			return kernelComputedRead(c);
		} finally {
			activeSub = prevSub;
		}
	}

	// Overlay-support #4 (§8.7.4): invalidate — DIRTY + propagate + queue.
	function invalidate(id: number): void {
		M[id + C.FLAGS] |= C.DIRTY;
		const subs = M[id + C.SUBS];
		if (subs !== 0) {
			propagate(subs, runDepth !== 0);
		}
	}

	// ---- overlay-support #2 (§8.7.2): the notify walk -----------------------------
	// Walk the subscriber cone of `node`'s subscribers, stamping OVERLAY_STAMP
	// with `ticket` (dedup per ticket). With `collect`, IMMEDIATE watchers are
	// pushed into `collectInto`. Pure integer traversal; runs no user code.
	function stampCone(startNode: number, ticket: number, collect: boolean, _token: number, collectInto?: number[]): void {
		const stackBase = propSp;
		let node = startNode;
		let nextLink = 0;
		do {
			const flags = M[node + C.FLAGS];
			if (!(flags & C.K_ATOM) && M[node + C.OVERLAY_STAMP] !== ticket) {
				M[node + C.OVERLAY_STAMP] = ticket;
				if (collect && (flags & C.IMMEDIATE) && (flags & C.K_WATCHER) && collectInto !== undefined) {
					collectInto.push(node);
				}
				const subs = M[node + C.SUBS];
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
			// advance
			if (nextLink !== 0) {
				node = M[nextLink + C.SUB];
				nextLink = M[nextLink + C.NEXT_SUB];
				continue;
			}
			if (propSp > stackBase) {
				nextLink = propStack[--propSp];
				node = M[nextLink + C.SUB];
				nextLink = M[nextLink + C.NEXT_SUB];
				continue;
			}
			break;
		} while (true);
	}

	function notifyWalkFromAtom(atom: number, ticket: number, collect: boolean, collectInto?: number[]): void {
		let lnk = M[atom + C.SUBS];
		while (lnk !== 0) {
			stampCone(M[lnk + C.SUB], ticket, collect, 0, collectInto);
			lnk = M[lnk + C.NEXT_SUB];
		}
	}

	// ---- overlay: tickets, equality, slots ---------------------------------------
	function ticket(): number {
		return ++seqCounter;
	}

	function valEq(eq: Equality<unknown> | undefined, a: unknown, b: unknown): boolean {
		return eq !== undefined ? eq(a, b) : Object.is(a, b);
	}

	function equalityOf(id: number): Equality<unknown> | undefined {
		return metas[id >> 3]?.isEqual;
	}

	function findLiveSlot(token: number): number {
		if (token !== 0 && token === lastToken && lastSlot >= 0 && batchToken[lastSlot] === token) {
			return lastSlot;
		}
		for (let s = 0; s < 32; ++s) {
			if (batchToken[s] === token && token !== 0) {
				lastToken = token;
				lastSlot = s;
				return s;
			}
		}
		return -1;
	}

	// §9.2: intern a token to a slot; -1 = exhausted (pseudo fallback).
	function internSlot(token: number): number {
		const found = findLiveSlot(token);
		if (found >= 0) {
			return found;
		}
		for (let s = 0; s < 32; ++s) {
			if (batchToken[s] === 0) {
				batchToken[s] = token;
				batchEntryCount[s] = 0;
				slotMemoHead[s] = 0;
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

	function releaseSlotIfDone(slot: number): void {
		if (((retiredSlotMask >> slot) & 1) !== 0 && batchEntryCount[slot] === 0) {
			batchToken[slot] = 0;
			liveSlotMask &= ~(1 << slot);
			liveDeferredMask &= ~(1 << slot);
			retiredSlotMask &= ~(1 << slot);
			slotMemoHead[slot] = 0;
			if (lastSlot === slot) {
				lastToken = 0;
				lastSlot = -1;
			}
		}
	}

	function liveDeferredTokens(): number[] {
		const out: number[] = [];
		for (let s = 0; s < 32; ++s) {
			if (((liveDeferredMask >> s) & 1) !== 0 && ((retiredSlotMask >> s) & 1) === 0) {
				out.push(batchToken[s]);
			}
		}
		return out;
	}

	// ---- world descriptors ---------------------------------------------------------
	const W0_WORLD: WorldDesc = { k: C.WK_W0, key: -1, token: 0, slot: -1, pin: 0, mask: 0 };
	const NEWEST_WORLD: WorldDesc = { k: C.WK_NEWEST, key: 0, token: 0, slot: -1, pin: 0, mask: 0 };
	const COMMITTED_WORLD: WorldDesc = { k: C.WK_COMMITTED, key: -1, token: 0, slot: -1, pin: 0, mask: 0 };
	let passWorld: WorldDesc = { k: C.WK_PASS, key: 1, token: 0, slot: -1, pin: 0, mask: 0 };

	function writerWorld(token: number): WorldDesc {
		return {
			k: C.WK_WRITER,
			key: ((token << 2) | 2) | 0,
			token,
			slot: findLiveSlot(token),
			pin: 0,
			mask: 0,
		};
	}

	function ambientWorld(): WorldDesc {
		if (readCtx === C.CTX_RENDER) {
			return passWorld;
		}
		if (readCtx === C.CTX_COMMITTED) {
			return COMMITTED_WORLD;
		}
		return NEWEST_WORLD;
	}

	function worldSensitive(world: WorldDesc): boolean {
		return (
			world.k === C.WK_PASS
			|| world.k === C.WK_WRITER
			|| world.k === C.WK_COMMITTED
			|| (world.k === C.WK_NEWEST && unappliedEntries > 0)
		);
	}

	// ---- tape append (§9.3) --------------------------------------------------------
	function appendLog(a: number, op: number, payload: unknown, applied: boolean, slot: number, pseudo: boolean): void {
		let head = M[a + C.LOG_HEAD];
		if (head === 0) {
			// First entry: create the tape. Base snapshots the canonical value
			// BEFORE this write applies; replays start here (§9.3).
			const base = allocLog();
			G[base + C.L_META] = C.OP_BASE | C.M_RETIRED;
			const t = ticket();
			G[base + C.L_SEQ] = t;
			G[base + C.L_RETIRED_SEQ] = t;
			logVals[base >> 2] = kernelPeekAtom(a);
			M[a + C.LOG_HEAD] = base;
			M[a + C.LOG_TAIL] = base;
			M[a + C.FLAGS] |= C.LOGGED;
			loggedAtoms.push(a);
			++loggedAtomCount;
			// Tape creation marks the cone, for every write classification (§9.3):
			// mark-only walk (collect off), once per atom per era.
			notifyWalkFromAtom(a, ++walkCounter, false);
			head = base;
		} else if (passOpen === 0 && !pseudo) {
			// Same-batch coalescing (§9.3): tail entry of the same batch,
			// unretired, and no render pass open (a pass may be pinned between
			// the two writes). SET replaces in place; UPDATE/DISPATCH composes
			// once the batch's tape run exceeds the threshold (default 8).
			const tail = M[a + C.LOG_TAIL];
			const tm = G[tail + C.L_META];
			const tailOp = tm & C.OP_MASK;
			const tailSlot = (tm >> C.SLOT_SHIFT) & C.SLOT_MASK;
			const tailApplied = (tm & C.M_APPLIED) !== 0;
			if (
				tailOp !== C.OP_BASE
				&& (tm & (C.M_RETIRED | C.M_PSEUDO)) === 0
				&& tailSlot === slot
				&& tailApplied === applied
			) {
				if (op === C.OP_SET) {
					logVals[tail >> 2] = payload;
					G[tail + C.L_SEQ] = ticket();
					G[tail + C.L_META] = (tm & ~C.OP_MASK) | C.OP_SET;
					return;
				}
				if ((op === C.OP_UPDATE || op === C.OP_DISPATCH) && tailOp !== C.OP_SET) {
					let run = 0;
					let rec = G[head + C.L_NEXT];
					while (rec !== 0) {
						const m = G[rec + C.L_META];
						if (((m >> C.SLOT_SHIFT) & C.SLOT_MASK) === slot && (m & C.M_PSEUDO) === 0) {
							++run;
						}
						rec = G[rec + C.L_NEXT];
					}
					if (run >= 8) {
						// Compose into an UPDATE closure applying old-then-new.
						const oldOp = tailOp;
						const oldPayload = logVals[tail >> 2];
						const reducer = metas[a >> 3]?.reducer;
						const newOp = op;
						const newPayload = payload;
						logVals[tail >> 2] = (acc: unknown): unknown => {
							const mid = oldOp === C.OP_UPDATE
								? (oldPayload as (x: unknown) => unknown)(acc)
								: reducer!(acc, oldPayload);
							return newOp === C.OP_UPDATE
								? (newPayload as (x: unknown) => unknown)(mid)
								: reducer!(mid, newPayload);
						};
						G[tail + C.L_SEQ] = ticket();
						G[tail + C.L_META] = (tm & ~C.OP_MASK) | C.OP_UPDATE;
						return;
					}
				}
			}
		}
		const rec = allocLog();
		let meta = op | (slot << C.SLOT_SHIFT) | (applied ? C.M_APPLIED : 0);
		const t = ticket();
		G[rec + C.L_SEQ] = t;
		if (pseudo) {
			// §9.2 slot-exhaustion fallback: an always-included pseudo-batch —
			// applied + retired at append, degraded toward "urgent".
			meta |= C.M_PSEUDO | C.M_APPLIED | C.M_RETIRED;
			G[rec + C.L_RETIRED_SEQ] = t;
		} else {
			G[rec + C.L_RETIRED_SEQ] = 0;
			++batchEntryCount[slot];
			if (!applied) {
				++unappliedEntries;
			}
		}
		G[rec + C.L_META] = meta;
		logVals[rec >> 2] = payload;
		G[M[a + C.LOG_TAIL] + C.L_NEXT] = rec;
		M[a + C.LOG_TAIL] = rec;
	}

	// ---- visibility (§10.2) ----------------------------------------------------------
	function visibleEntry(rec: number, world: WorldDesc): boolean {
		const meta = G[rec + C.L_META];
		switch (world.k) {
			case C.WK_NEWEST:
				return true;
			case C.WK_COMMITTED:
				return (meta & C.M_RETIRED) !== 0;
			case C.WK_W0:
				return (meta & (C.M_RETIRED | C.M_APPLIED)) !== 0;
			case C.WK_PASS: {
				if ((meta & C.M_RETIRED) !== 0 && G[rec + C.L_RETIRED_SEQ] <= world.pin) {
					return true;
				}
				if ((meta & C.M_PSEUDO) !== 0) {
					return false; // pseudo entries are retired-at-append; clause 1 governs
				}
				const slot = (meta >> C.SLOT_SHIFT) & C.SLOT_MASK;
				return ((world.mask >> slot) & 1) !== 0 && G[rec + C.L_SEQ] <= world.pin;
			}
			case C.WK_WRITER: {
				if ((meta & (C.M_RETIRED | C.M_APPLIED)) !== 0) {
					return true;
				}
				const slot = (meta >> C.SLOT_SHIFT) & C.SLOT_MASK;
				return (meta & C.M_PSEUDO) === 0 && slot === world.slot;
			}
		}
		return false;
	}

	function applyLogOp(a: number, rec: number, acc: unknown): unknown {
		const op = G[rec + C.L_META] & C.OP_MASK;
		if (op === C.OP_SET) {
			return logVals[rec >> 2];
		}
		if (op === C.OP_UPDATE) {
			return (logVals[rec >> 2] as (x: unknown) => unknown)(acc);
		}
		return metas[a >> 3]!.reducer!(acc, logVals[rec >> 2]);
	}

	function foldTape(a: number, world: WorldDesc): unknown {
		const head = M[a + C.LOG_HEAD];
		const eq = equalityOf(a);
		let acc = logVals[head >> 2];
		let rec = G[head + C.L_NEXT];
		while (rec !== 0) {
			if (visibleEntry(rec, world)) {
				const next = applyLogOp(a, rec, acc);
				acc = valEq(eq, acc, next) ? acc : next; // equality inside the fold (§9.3)
			}
			rec = G[rec + C.L_NEXT];
		}
		return acc;
	}

	function allVisibleAndApplied(a: number, world: WorldDesc): boolean {
		const head = M[a + C.LOG_HEAD];
		let rec = G[head + C.L_NEXT];
		while (rec !== 0) {
			const meta = G[rec + C.L_META];
			if ((meta & (C.M_APPLIED | C.M_RETIRED)) === 0 || !visibleEntry(rec, world)) {
				return false;
			}
			rec = G[rec + C.L_NEXT];
		}
		return true;
	}

	function resolveAtomInWorld(a: number, world: WorldDesc): unknown {
		if ((M[a + C.FLAGS] & C.LOGGED) === 0 || world.k === C.WK_W0) {
			return kernelPeekAtom(a);
		}
		if (world.k === C.WK_NEWEST && unappliedEntries === 0) {
			return kernelPeekAtom(a);
		}
		if (allVisibleAndApplied(a, world)) {
			return kernelPeekAtom(a); // §10.3 shortcut: the kernel value IS the answer
		}
		return foldTape(a, world);
	}

	// ---- world memos (§10.5) ---------------------------------------------------------
	function memoHeadOf(c: number): number {
		let head = memos[c >> 3];
		if (head !== 0 && (head >= wNext || W[head + C.W_NODE] !== c)) {
			// Stale head after a plane reset (§7.4 guard): lazily zero.
			memos[c >> 3] = 0;
			head = 0;
		}
		return head;
	}

	function certValid(rec: number): boolean {
		const n = W[rec + C.W_NDEPS];
		let off = W[rec + C.W_CERT];
		for (let i = 0; i < n; ++i, off += 2) {
			const aid = WC[off];
			const expected = WC[off + 1];
			const cur = (M[aid + C.FLAGS] & C.LOGGED) !== 0 ? G[M[aid + C.LOG_TAIL] + C.L_SEQ] : 0;
			if (cur !== expected) {
				return false;
			}
		}
		return true;
	}

	function memoLookup(c: number, world: WorldDesc): number {
		if (world.key < 0) {
			return 0;
		}
		let rec = memoHeadOf(c);
		while (rec !== 0) {
			if (W[rec + C.W_KEY] === world.key && W[rec + C.W_EPOCH] === overlayEpoch) {
				// Pass worlds: key + epoch suffice (pins freeze the world, §10.5).
				if (world.k === C.WK_PASS || certValid(rec)) {
					return rec;
				}
			}
			rec = W[rec + C.W_NEXT_MEMO];
		}
		return 0;
	}

	function certPush(aid: number, seq: number): void {
		if (certSp + 2 > certStack.length) {
			growCertStack();
		}
		certStack[certSp++] = aid;
		certStack[certSp++] = seq;
	}

	function overlayReadAtom(a: number): unknown {
		const world = frameWorlds[frameWorlds.length - 1];
		const flags = M[a + C.FLAGS];
		let tailSeq = 0;
		let v: unknown;
		if ((flags & C.LOGGED) !== 0) {
			tailSeq = G[M[a + C.LOG_TAIL] + C.L_SEQ];
			v = world.k === C.WK_W0 ? kernelPeekAtom(a) : resolveAtomInWorld(a, world);
		} else {
			v = kernelPeekAtom(a);
		}
		// Certificates record EVERY atom read — unlogged ones as zeros (§10.5).
		certPush(a, tailSeq);
		return v;
	}

	// §10.5 overlay evaluation. Untracked; nested computed reads ALWAYS recurse
	// here (coordinator resolution #5 — never the kernel path inside a frame,
	// else unlogged grandchild sources escape the parent's certificate).
	function overlayEvaluate(c: number, world: WorldDesc): unknown {
		const hit = memoLookup(c, world);
		if (hit !== 0) {
			if (frameWorlds.length > 0) {
				// Flattening on memo hits: copy the child's certificate run into
				// every open collector frame (§10.5).
				const n = W[hit + C.W_NDEPS];
				let off = W[hit + C.W_CERT];
				for (let i = 0; i < n; ++i, off += 2) {
					certPush(WC[off], WC[off + 1]);
				}
			}
			return memoVals[W[hit + C.W_VAL]];
		}
		// Previous same-world value, for reference-stable equality (§11.2).
		let prev: unknown;
		let hasPrev = false;
		if (world.key >= 0) {
			let rec = memoHeadOf(c);
			while (rec !== 0) {
				if (W[rec + C.W_KEY] === world.key && W[rec + C.W_EPOCH] !== 0) {
					prev = memoVals[W[rec + C.W_VAL]];
					hasPrev = true;
					break;
				}
				rec = W[rec + C.W_NEXT_MEMO];
			}
		}
		const frameBase = certSp;
		frameWorlds.push(world);
		const prevSub = activeSub;
		activeSub = 0; // render/overlay evaluation never mutates topology (§10.3)
		let v: unknown;
		try {
			v = (metas[c >> 3]!.rawFn as () => unknown)();
		} finally {
			activeSub = prevSub;
			frameWorlds.pop();
		}
		if (hasPrev && valEq(equalityOf(c), prev, v)) {
			v = prev;
		}
		if (world.key >= 0) {
			// Pack the certificate run: [frameBase, certSp) — includes every
			// nested frame's reads beneath this frame's base (flattening).
			const pairs = (certSp - frameBase) >> 1;
			while (certNext + pairs * 2 > WC.length) {
				growWC();
			}
			const off = certNext;
			for (let i = 0; i < pairs * 2; ++i) {
				WC[off + i] = certStack[frameBase + i];
			}
			certNext = off + pairs * 2;
			// Tombstone the superseded (node, key) record (§10.5 lifecycle).
			let old = memoHeadOf(c);
			while (old !== 0) {
				if (W[old + C.W_KEY] === world.key && W[old + C.W_EPOCH] !== 0) {
					W[old + C.W_EPOCH] = 0;
					memoVals[W[old + C.W_VAL]] = undefined;
					break;
				}
				old = W[old + C.W_NEXT_MEMO];
			}
			const rec = allocMemo();
			W[rec + C.W_KEY] = world.key;
			W[rec + C.W_EPOCH] = overlayEpoch;
			W[rec + C.W_NODE] = c;
			memoVals.push(v);
			W[rec + C.W_VAL] = memoVals.length - 1;
			W[rec + C.W_NEXT_MEMO] = memoHeadOf(c);
			W[rec + C.W_NDEPS] = pairs;
			W[rec + C.W_CERT] = off;
			memos[c >> 3] = rec;
			M[c + C.MEMO_KEY] = world.key;
			if (world.k === C.WK_WRITER && world.slot >= 0) {
				// Writer's-world records register on the slot memo chain — the
				// drain re-validation registry (§9.8, §10.5).
				W[rec + C.W_SLOT_NEXT] = slotMemoHead[world.slot];
				slotMemoHead[world.slot] = rec;
			} else {
				W[rec + C.W_SLOT_NEXT] = 0;
			}
		}
		if (frameWorlds.length === 0) {
			certSp = 0;
		}
		return v;
	}

	// §10.4: the computed read gate + post-eval re-check.
	function resolveComputedInWorld(c: number, world: WorldDesc): unknown {
		if (world.k === C.WK_W0) {
			return kernelComputedReadUntracked(c);
		}
		if (loggedAtomCount === 0 || M[c + C.OVERLAY_STAMP] <= eraFloor) {
			const v = kernelComputedReadUntracked(c);
			// Post-eval re-check: did this evaluation's own dependency linking
			// just mark c (§8.7.3)? Only possible if the kernel path recomputed.
			if (worldSensitive(world) && M[c + C.OVERLAY_STAMP] > eraFloor) {
				return overlayEvaluate(c, world);
			}
			return v;
		}
		if (world.k === C.WK_NEWEST && unappliedEntries === 0) {
			return kernelComputedReadUntracked(c); // Wn == W0 when nothing is unapplied
		}
		return overlayEvaluate(c, world);
	}

	function worldValueOf(id: number, world: WorldDesc): unknown {
		return (M[id + C.FLAGS] & C.K_ATOM) !== 0
			? resolveAtomInWorld(id, world)
			: resolveComputedInWorld(id, world);
	}

	// ---- broadcast decisions (§10.6 + coordinator resolutions 1/3/7b) -------------
	function requestWalk(atom: number, token: number): void {
		pendingWalks.push(atom, token);
	}

	function decide(w: number, token: number, entangled: boolean): void {
		const meta = metas[w >> 3];
		if (meta === undefined || meta.watchedId === undefined || (M[w + C.FLAGS] & C.K_WATCHER) === 0) {
			return; // disposed mid-drain
		}
		const nodeId = meta.watchedId;
		const world = token === 0 ? W0_WORLD : writerWorld(token);
		const v = worldValueOf(nodeId, world);
		const lb = meta.lastBroadcast!;
		// Missing-world baseline: the current W0 value (resolution 7b). A
		// suppressed decision records nothing — decisions stay purely
		// value-derived, so they are independent of how often a watcher is
		// collected (and match the oracle's derivation rule, §17.2).
		const baseline = lb.has(token) ? lb.get(token) : worldValueOf(nodeId, W0_WORLD);
		if (!valEq(equalityOf(nodeId), baseline, v)) {
			lb.set(token, v);
			const ev: BroadcastEvent = {
				watcherId: w,
				token,
				value: v,
				forkBatchDuringCallback: entangled && fork !== undefined ? fork.getCurrentWriteBatch() : 0,
			};
			broadcastLog.push(ev);
			meta.onBroadcast?.(ev);
		}
	}

	// Schedule a decision into a deferred batch's own lanes via the fork's
	// entanglement API (§9.8/§6.5); retired token → plain urgent fallback.
	function decideEntangled(w: number, token: number): void {
		if (fork !== undefined && (token & 1) === 1) {
			if (!fork.runInBatch(token, () => decide(w, token, true))) {
				decide(w, token, false);
			}
		} else {
			decide(w, token, false);
		}
	}

	function clearWatcherStale(w: number): void {
		if ((M[w + C.FLAGS] & C.K_WATCHER) !== 0) {
			M[w + C.FLAGS] &= ~(C.DIRTY | C.PENDING | C.RECURSED);
		}
	}

	// §9.8 drain re-validation: walk a slot's writer's-world memo chain; for
	// each invalidated record, snapshot-then-re-evaluate and run the §10.6
	// cutoff for the node's IMMEDIATE watchers, entangled into the batch.
	function revalidateSlotChain(slot: number): void {
		const token = batchToken[slot];
		if (token === 0) {
			return;
		}
		const world = writerWorld(token);
		const recs: number[] = [];
		for (let rec = slotMemoHead[slot]; rec !== 0; rec = W[rec + C.W_SLOT_NEXT]) {
			recs.push(rec);
		}
		const seen = new Set<number>();
		for (const rec of recs) {
			const node = W[rec + C.W_NODE];
			if (node === 0 || seen.has(node) || (M[node + C.FLAGS] & C.K_COMPUTED) === 0) {
				continue;
			}
			// A tombstoned record may be the ONLY snapshot of its node in this
			// walk: re-evaluating an earlier chain record can re-memoize (and
			// tombstone) this node mid-loop, and the fresh record is not in the
			// snapshot list. Process the node anyway, with no snapshot — the
			// per-watcher lastBroadcast cutoff (§10.6) suppresses spurious fires.
			const tombstone = W[rec + C.W_EPOCH] === 0;
			seen.add(node);
			if (!tombstone && W[rec + C.W_EPOCH] === overlayEpoch && certValid(rec)) {
				continue; // still valid → this world's value unchanged
			}
			// Snapshot BEFORE re-evaluating (coordinator pitfall).
			const hadSnapshot = !tombstone;
			const snapshot = hadSnapshot ? memoVals[W[rec + C.W_VAL]] : undefined;
			const fresh = resolveComputedInWorld(node, world);
			if (!hadSnapshot || !valEq(equalityOf(node), snapshot, fresh)) {
				let lnk = M[node + C.SUBS];
				while (lnk !== 0) {
					const sub = M[lnk + C.SUB];
					if ((M[sub + C.FLAGS] & (C.IMMEDIATE | C.K_WATCHER)) === (C.IMMEDIATE | C.K_WATCHER)) {
						decideEntangled(sub, token);
					}
					lnk = M[lnk + C.NEXT_SUB];
				}
			}
		}
	}

	// ---- the drain (§9.8 + resolutions 1/2/3; re-validation BEFORE decisions;
	// one walk ticket PER TOKEN GROUP) ------------------------------------------------
	function drainAll(fullRevalidation: boolean): void {
		if (drainDepth > 0) {
			return; // the outer drain loop picks up newly queued work
		}
		++drainDepth;
		try {
			let force = fullRevalidation;
			do {
				const collected = new Map<number, number[]>();
				let any = false;
				if (kernelBroadcasts.length !== 0) {
					any = true;
					const zero: number[] = [];
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
					const groups = new Map<number, number[]>();
					for (let i = 0; i < walks.length; i += 2) {
						let g = groups.get(walks[i + 1]);
						if (g === undefined) {
							groups.set(walks[i + 1], (g = []));
						}
						g.push(walks[i]);
					}
					for (const [token, atoms] of groups) {
						const t = ++walkCounter; // one ticket per token group
						let into = collected.get(token);
						if (into === undefined) {
							collected.set(token, (into = []));
						}
						for (const a of atoms) {
							notifyWalkFromAtom(a, t, true, into);
						}
					}
				}
				if (!any && !force) {
					break;
				}
				// --- re-validation, ordered BEFORE broadcast decisions ---
				const urgentPresent = collected.has(0) || force;
				force = false;
				const revalidated = new Set<number>();
				if (urgentPresent) {
					// Urgent drains re-validate EVERY live deferred world's chain:
					// applied entries are visible in every writer's world
					// (resolutions 1/3).
					for (let s = 0; s < 32; ++s) {
						if (((liveDeferredMask >> s) & 1) !== 0 && ((retiredSlotMask >> s) & 1) === 0) {
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
				// --- broadcast decisions, grouped per token (§9.8) ---
				const expansion = urgentPresent ? liveDeferredTokens() : [];
				for (const [token, watchers] of collected) {
					if (token === 0) {
						for (const w of watchers) {
							decide(w, 0, false);
							// W0 decisions PLUS per-live-deferred-world expansion
							// (resolutions 1/3).
							for (const t of expansion) {
								decideEntangled(w, t);
							}
							clearWatcherStale(w);
						}
					} else if ((token & 1) === 1 && fork !== undefined) {
						const group = (): void => {
							for (const w of watchers) {
								decide(w, token, true);
								clearWatcherStale(w);
							}
						};
						if (!fork.runInBatch(token, group)) {
							// Retired between write and drain: urgent fallback (§9.8).
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

	// ---- writes (§9.1 gate, §9.3 append, §9.4 apply, §10.8 render purity) ----------
	function evalOp(a: number, op: number, payload: unknown, cur: unknown): unknown {
		if (op === C.OP_SET) {
			return payload;
		}
		if (op === C.OP_UPDATE) {
			return (payload as (x: unknown) => unknown)(cur);
		}
		return metas[a >> 3]!.reducer!(cur, payload);
	}

	function writeOp(a: number, op: number, payload: unknown): void {
		if (readCtx === C.CTX_RENDER && passExecuting !== 0) {
			throw new Error('cosignal: writes during render are not allowed (§10.8)');
		}
		if (writeMode === C.MODE_DIRECT) {
			const cur = kernelPeekAtom(a);
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
		// LOGGED mode: every write is logged (§9.1).
		const f = fork;
		if (f === undefined) {
			throw new Error('cosignal: LOGGED mode without an attached fork');
		}
		const deferred = f.isCurrentWriteDeferred();
		const token = f.getCurrentWriteBatch();
		if (M[a + C.LOG_HEAD] === 0) {
			// Equality drop — provably safe only on tapeless atoms (§9.3).
			const cur = kernelPeekAtom(a);
			const next = evalOp(a, op, payload, cur);
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
		if (applied) {
			// Urgent: logged AND applied through the kernel (§9.4).
			const cur = kernelPeekAtom(a);
			const next = evalOp(a, op, payload, cur);
			if (!valEq(equalityOf(a), cur, next)) {
				if (kernelWriteAtom(a, next) && batchDepth === 0) {
					flush();
				}
			}
			// Resolution 2: applied logged writes ALWAYS queue a token-0 walk —
			// an equal-value urgent write never propagates via the kernel yet
			// shifts every pending world's fold.
			requestWalk(a, 0);
		} else {
			requestWalk(a, token);
		}
		topLevelSettle();
	}

	// Top-of-stack settlement: grouped drains happen at batch() close; plain
	// writes drain in their own call stack (§9.8 grouping rule).
	function topLevelSettle(): void {
		if (batchDepth !== 0 || canonicalEvalDepth !== 0 || runDepth !== 0 || drainDepth !== 0) {
			return;
		}
		if (queuedLength > notifyIndex) {
			flush();
		}
		drainAll(false);
		if (enterDepth === 0) {
			sweepLogs();
			tryQuiescence();
			maybeBoundary();
		}
	}

	// ---- retirement + absorption (§9.5; resolution 7a; W0-no-op pitfall) -----------
	function onBatchRetiredEdge(token: number, _committed: boolean): void {
		// `committed=false` folds identically — the writes are real (§9.5).
		const slot = findLiveSlot(token);
		if (slot < 0) {
			return; // batch carried no external writes — unknown, ignored
		}
		++overlayEpoch; // world values changed with no tape-tail movement (§10.5)
		const rt = ticket(); // ONE retire ticket per retirement (resolution 7a)
		++batchDepth;
		try {
			for (let i = 0; i < loggedAtoms.length; ++i) {
				const a = loggedAtoms[i];
				let touched = false;
				let rec = G[M[a + C.LOG_HEAD] + C.L_NEXT];
				while (rec !== 0) {
					const m = G[rec + C.L_META];
					if (
						((m >> C.SLOT_SHIFT) & C.SLOT_MASK) === slot
						&& (m & (C.M_PSEUDO | C.M_RETIRED)) === 0
					) {
						G[rec + C.L_META] = m | C.M_RETIRED;
						G[rec + C.L_RETIRED_SEQ] = rt;
						if ((m & C.M_APPLIED) === 0) {
							--unappliedEntries;
						}
						touched = true;
					}
					rec = G[rec + C.L_NEXT];
				}
				if (touched) {
					// Absorb: replay the W0 fold; write through the kernel iff the
					// committed value moved (policy equality, §11.2).
					const fold = foldTape(a, W0_WORLD);
					if (!valEq(equalityOf(a), kernelPeekAtom(a), fold)) {
						kernelWriteAtom(a, fold);
					}
					// Even a W0-no-op retirement makes this batch's entries visible
					// in every OTHER writer's world (coordinator pitfall): queue a
					// token-0 walk so the drain's expansion re-decides watchers in
					// each live deferred world — same shape as resolution 2.
					requestWalk(a, 0);
				}
			}
		} finally {
			--batchDepth;
		}
		if (batchDepth === 0) {
			flush(); // one effect flush for the whole absorption (§9.5)
		}
		retiredSlotMask |= 1 << slot;
		liveDeferredMask &= ~(1 << slot);
		releaseSlotIfDone(slot);
		// Post-retirement drain with full re-validation: a retirement that
		// leaves W0 unchanged still shifts every OTHER pending world (retired
		// entries become visible in their writer's worlds) — coordinator
		// pitfall "W0-no-op retirement".
		drainAll(true);
		sweepLogs();
		tryQuiescence();
	}

	// ---- truncation (§9.6 + resolution 4) ---------------------------------------------
	function truncateBatch(token: number): void {
		const slot = findLiveSlot(token);
		if (slot < 0) {
			return;
		}
		++overlayEpoch; // mid-tape unlinks move no tail seq — memos must re-check
		for (let i = 0; i < loggedAtoms.length; ++i) {
			const a = loggedAtoms[i];
			const head = M[a + C.LOG_HEAD];
			let prev = head;
			let rec = G[head + C.L_NEXT];
			let touched = false;
			while (rec !== 0) {
				const m = G[rec + C.L_META];
				const next = G[rec + C.L_NEXT];
				if (
					((m >> C.SLOT_SHIFT) & C.SLOT_MASK) === slot
					&& (m & (C.M_PSEUDO | C.M_RETIRED | C.M_APPLIED)) === 0
				) {
					G[prev + C.L_NEXT] = next;
					if (M[a + C.LOG_TAIL] === rec) {
						M[a + C.LOG_TAIL] = prev;
					}
					--unappliedEntries;
					--batchEntryCount[slot];
					freeLog(rec);
					touched = true;
				} else {
					prev = rec;
				}
				rec = next;
			}
			if (touched) {
				// Resolution 4: re-notify the rolled-back batch's lane — watchers
				// directly on this atom see the reverted world value.
				requestWalk(a, token);
			}
		}
		releaseSlotIfDone(slot);
		// Resolution 4: re-notify the rolled-back batch's lane, else its
		// components stay stale until an unrelated drain.
		if (batchToken[slot] === token) {
			revalidateSlotChain(slot);
		}
		drainAll(false);
		if (enterDepth === 0 && drainDepth === 0) {
			sweepLogs();
			tryQuiescence();
		}
	}

	// ---- sweep (§9.6) ---------------------------------------------------------------
	function sweepLogs(): void {
		const minPin = passOpen !== 0 ? passPin : C.MAX_SEQ;
		for (let i = loggedAtoms.length - 1; i >= 0; --i) {
			const a = loggedAtoms[i];
			const head = M[a + C.LOG_HEAD];
			const eq = equalityOf(a);
			let rec = G[head + C.L_NEXT];
			while (rec !== 0) {
				const m = G[rec + C.L_META];
				if ((m & C.M_RETIRED) === 0 || G[rec + C.L_RETIRED_SEQ] > minPin) {
					break; // only the leading dead run folds (§9.6)
				}
				const folded = applyLogOp(a, rec, logVals[head >> 2]);
				if (!valEq(eq, logVals[head >> 2], folded)) {
					logVals[head >> 2] = folded;
				}
				G[head + C.L_SEQ] = G[rec + C.L_RETIRED_SEQ];
				G[head + C.L_RETIRED_SEQ] = G[rec + C.L_RETIRED_SEQ];
				if ((m & C.M_PSEUDO) === 0) {
					const slot = (m >> C.SLOT_SHIFT) & C.SLOT_MASK;
					--batchEntryCount[slot];
					releaseSlotIfDone(slot);
				}
				const next = G[rec + C.L_NEXT];
				freeLog(rec);
				G[head + C.L_NEXT] = next;
				if (next === 0) {
					M[a + C.LOG_TAIL] = head;
				}
				rec = next;
			}
			// Free the tape: base-only, and no live unretired batch could still
			// write (conservative form — see final report).
			if (G[head + C.L_NEXT] === 0 && (liveSlotMask & ~retiredSlotMask) === 0 && passOpen === 0) {
				freeLog(head);
				M[a + C.LOG_HEAD] = 0;
				M[a + C.LOG_TAIL] = 0;
				M[a + C.FLAGS] &= ~C.LOGGED;
				loggedAtoms.splice(i, 1);
				--loggedAtomCount;
			}
		}
	}

	// ---- quiescence (§9.7) -------------------------------------------------------------
	function tryQuiescence(): void {
		if (
			loggedAtomCount !== 0
			|| passOpen !== 0
			|| liveSlotMask !== 0
			|| pendingWalks.length !== 0
			|| kernelBroadcasts.length !== 0
			|| drainDepth !== 0
			|| enterDepth !== 0
		) {
			return;
		}
		gNext = 4;
		logFreeHead = 0;
		wNext = 8;
		certNext = 2;
		memoVals.length = 0;
		slotMemoHead.fill(0);
		eraFloor = walkCounter; // every mark goes stale in O(1)
		++overlayEpoch; // the cross-era invalidator (§9.7): seqs repeat, epochs don't
		seqCounter = 1;
		++quiescenceCount;
		// Walk-counter safety valve (§9.7): only at quiescence, nothing pinned.
		if (walkCounter > 1 << 30) {
			for (let i = 0; i < allNodes.length; ++i) {
				const id = allNodes[i];
				if ((M[id + C.FLAGS] & (C.K_COMPUTED | C.K_EFFECT | C.K_SCOPE | C.K_WATCHER)) !== 0) {
					M[id + C.OVERLAY_STAMP] = 0;
				}
			}
			walkCounter = 0;
			eraFloor = 0;
		}
	}

	// ---- bridge (§13 subset: pass lifecycle, activation, retirement) ----------------
	function onPassStartEdge(container: Container, tokens: readonly number[], lineage: number): void {
		passOpen = 1;
		passExecuting = 1;
		++passSerial;
		passPin = seqCounter; // ticket() pre-increments: existing seqs <= pin
		let mask = 0;
		for (const t of tokens) {
			const s = findLiveSlot(t);
			if (s >= 0) {
				mask |= 1 << s;
			}
			// Tokens with no external writes are unknown and ignored (§6.3).
		}
		passIncludeMask = mask;
		passContainer = container;
		passLineage = lineage;
		passWorld = {
			k: C.WK_PASS,
			key: ((passSerial << 2) | 1) | 0,
			token: 0,
			slot: -1,
			pin: passPin,
			mask,
		};
		readCtx = C.CTX_RENDER;
	}

	function onPassEndEdge(): void {
		passOpen = 0;
		passExecuting = 0;
		passContainer = undefined;
		readCtx = C.CTX_NEWEST;
		sweepLogs(); // §9.6: sweep runs at pass end
		tryQuiescence();
	}

	function attachFork(f: ForkAdapter): () => void {
		if (fork !== undefined) {
			throw new Error('cosignal: fork already attached');
		}
		fork = f;
		const listener: ExternalRuntimeListener = {
			onRootRegistered: () => {
				// §9.1 monotonic activation: DIRECT → LOGGED, permanently.
				writeMode = C.MODE_LOGGED;
			},
			onRenderPassStart: (c, tokens, lineage) => onPassStartEdge(c, tokens, lineage),
			onRenderPassYield: () => {
				// §10.1: code in yield gaps is not render code.
				passExecuting = 0;
				readCtx = C.CTX_NEWEST;
			},
			onRenderPassResume: () => {
				passExecuting = 1;
				readCtx = C.CTX_RENDER;
			},
			onRenderPassEnd: () => onPassEndEdge(),
			onBatchCommitted: () => {
				// Per-root committed views are §13.4 (M5) — deferred this pass.
			},
			onBatchRetired: (token, committed) => onBatchRetiredEdge(token, committed),
			// onBatchOpened (coordinator resolution 6): variant A's monotonic
			// gate does not consume it.
		};
		unsubscribeFork = f.subscribeToExternalRuntime(listener);
		return () => {
			unsubscribeFork?.();
			unsubscribeFork = undefined;
			fork = undefined;
		};
	}

	// ---- public reads -----------------------------------------------------------------
	function readAtomPublic(a: number): unknown {
		if (canonicalEvalDepth > 0) {
			return kernelReadAtom(a); // kernel-internal context: W0 by construction
		}
		if (frameWorlds.length > 0) {
			return overlayReadAtom(a);
		}
		const v = resolveAtomInWorld(a, ambientWorld());
		if (activeSub !== 0 && readCtx !== C.CTX_RENDER) {
			link(a, activeSub, cycle); // §10.3: render never mutates topology
		}
		return v;
	}

	function readComputedPublic(c: number): unknown {
		if (canonicalEvalDepth > 0) {
			return kernelComputedRead(c);
		}
		if (frameWorlds.length > 0) {
			// Resolution 5: inside an overlay frame, ALWAYS recurse via
			// overlayEvaluate — never the kernel path.
			return overlayEvaluate(c, frameWorlds[frameWorlds.length - 1]);
		}
		const v = resolveComputedInWorld(c, ambientWorld());
		if (activeSub !== 0 && readCtx !== C.CTX_RENDER) {
			link(c, activeSub, cycle);
		}
		return v;
	}

	// ---- node constructors ---------------------------------------------------------
	function newEffectNode(fn: () => (() => void) | void): number {
		const e = allocNode(C.K_EFFECT | C.WATCHING | C.RECURSED_CHECK | C.LIVE);
		fns[e >> 3] = fn;
		const prevSub = activeSub;
		activeSub = e;
		if (prevSub !== 0) {
			link(e, prevSub, 0);
			M[prevSub + C.FLAGS] |= C.HAS_CHILD_EFFECT;
		}
		++enterDepth;
		try {
			++runDepth;
			values[(e >> 2) + 1] = fn();
		} finally {
			--runDepth;
			--enterDepth;
			activeSub = prevSub;
			M[e + C.FLAGS] &= ~C.RECURSED_CHECK;
		}
		return e;
	}

	function newScopeNode(fn: () => void): number {
		const e = allocNode(C.K_SCOPE | C.MUTABLE | C.LIVE);
		const prevSub = activeSub;
		activeSub = e;
		if (prevSub !== 0) {
			link(e, prevSub, 0);
			M[prevSub + C.FLAGS] |= C.HAS_CHILD_EFFECT;
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

	// ---- public API ---------------------------------------------------------------
	function atom<T>(initial: T, opts?: { isEqual?: Equality<T>; label?: string }): AtomHandle<T> {
		maybeBoundary();
		const id = allocNode(C.K_ATOM | C.MUTABLE);
		const v = id >> 2;
		values[v] = initial;
		values[v + 1] = initial;
		if (opts?.isEqual !== undefined || opts?.label !== undefined) {
			metas[id >> 3] = { isEqual: opts?.isEqual as Equality<unknown> | undefined, label: opts?.label };
		}
		return {
			kind: 'atom',
			id,
			get state(): T {
				return readAtomPublic(id) as T;
			},
			peek(): T {
				const s = activeSub;
				activeSub = 0;
				try {
					return resolveAtomInWorld(id, ambientWorld()) as T;
				} finally {
					activeSub = s;
				}
			},
			set(next: T): void {
				writeOp(id, C.OP_SET, next);
			},
			update(fn: (current: T) => T): void {
				writeOp(id, C.OP_UPDATE, fn);
			},
		};
	}

	function reducerAtom<S, A>(
		initial: S,
		reducer: (state: S, action: A) => S,
		opts?: { isEqual?: Equality<S>; label?: string },
	): ReducerAtomHandle<S, A> {
		maybeBoundary();
		const id = allocNode(C.K_ATOM | C.MUTABLE);
		const v = id >> 2;
		values[v] = initial;
		values[v + 1] = initial;
		metas[id >> 3] = {
			isEqual: opts?.isEqual as Equality<unknown> | undefined,
			label: opts?.label,
			reducer: reducer as (state: unknown, action: unknown) => unknown,
		};
		return {
			kind: 'reducerAtom',
			id,
			get state(): S {
				return readAtomPublic(id) as S;
			},
			peek(): S {
				const s = activeSub;
				activeSub = 0;
				try {
					return resolveAtomInWorld(id, ambientWorld()) as S;
				} finally {
					activeSub = s;
				}
			},
			dispatch(action: A): void {
				writeOp(id, C.OP_DISPATCH, action);
			},
		};
	}

	function computed<T>(fn: () => T, opts?: { isEqual?: Equality<T>; label?: string }): ComputedHandle<T> {
		maybeBoundary();
		const id = allocNode(C.K_COMPUTED);
		const isEqual = opts?.isEqual as Equality<unknown> | undefined;
		metas[id >> 3] = { isEqual, label: opts?.label, rawFn: fn as () => unknown };
		// Kernel wrapper (§11.2): custom equality returns the previous
		// reference so the kernel's identity compare reports "unchanged".
		fns[id >> 3] = isEqual === undefined
			? (fn as (prev?: unknown) => unknown)
			: (prev?: unknown): unknown => {
				const next = (fn as () => unknown)();
				return prev !== undefined && isEqual(prev, next) ? prev : next;
			};
		return {
			kind: 'computed',
			id,
			get state(): T {
				return readComputedPublic(id) as T;
			},
		};
	}

	function watch(target: SignalHandle, onBroadcast?: (ev: BroadcastEvent) => void): WatcherHandle {
		maybeBoundary();
		const targetId = target.id;
		const w = allocNode(C.K_WATCHER | C.WATCHING | C.IMMEDIATE | C.LIVE);
		const meta: NodeMeta = { watchedId: targetId, lastBroadcast: new Map(), onBroadcast };
		metas[w >> 3] = meta;
		link(targetId, w, 0);
		// Baseline: the watcher "rendered" the current canonical value.
		meta.lastBroadcast!.set(0, worldValueOf(targetId, W0_WORLD));
		// Subscription-time seeding of live deferred worlds (resolution 7b) —
		// evaluating here also creates the writer's-world memos that register
		// the node on the slot chains (first-divergence coverage).
		for (const t of liveDeferredTokens()) {
			meta.lastBroadcast!.set(t, worldValueOf(targetId, writerWorld(t)));
		}
		const gen = M[w + C.GEN];
		return {
			id: w,
			dispose(): void {
				if (M[w + C.GEN] === gen) {
					dispose(w);
					maybeBoundary();
				}
			},
		};
	}

	function effect(fn: () => void | (() => void)): () => void {
		maybeBoundary();
		const id = newEffectNode(fn);
		const gen = M[id + C.GEN];
		topLevelSettle();
		return () => {
			if (M[id + C.GEN] !== gen) {
				return;
			}
			dispose(id);
			maybeBoundary();
		};
	}

	function effectScope(fn: () => void): () => void {
		maybeBoundary();
		const id = newScopeNode(fn);
		const gen = M[id + C.GEN];
		topLevelSettle();
		return () => {
			if (M[id + C.GEN] !== gen) {
				return;
			}
			dispose(id);
			maybeBoundary();
		};
	}

	function batch<T>(fn: () => T): T {
		++batchDepth;
		try {
			return fn();
		} finally {
			if (--batchDepth === 0) {
				topLevelSettle(); // grouped drain at batch close (§9.8)
			}
		}
	}

	function untracked<T>(fn: () => T): T {
		const prevSub = activeSub;
		activeSub = 0;
		try {
			return fn();
		} finally {
			activeSub = prevSub;
		}
	}

	function readCommitted<T>(target: SignalHandle): T {
		const prevCtx = readCtx;
		readCtx = C.CTX_COMMITTED;
		try {
			const id = target.id;
			return ((M[id + C.FLAGS] & C.K_ATOM) !== 0
				? resolveAtomInWorld(id, COMMITTED_WORLD)
				: resolveComputedInWorld(id, COMMITTED_WORLD)) as T;
		} finally {
			readCtx = prevCtx;
		}
	}

	function worldFromSelector(sel: WorldSelector): WorldDesc {
		switch (sel.kind) {
			case 'w0':
				return W0_WORLD;
			case 'newest':
				return NEWEST_WORLD;
			case 'committed':
				return COMMITTED_WORLD;
			case 'writer':
				return writerWorld(sel.token);
			case 'pass':
				return passWorld;
		}
	}

	// ---- verifyArena-lite (§16.6 subset) ----------------------------------------------
	function verify(): void {
		const problems: string[] = [];
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
			if ((M[a + C.FLAGS] & C.LOGGED) === 0) problems.push(`loggedAtoms holds unlogged ${a}`);
			if (M[a + C.LOG_HEAD] === 0) problems.push(`logged atom ${a} has no tape`);
			// tape chain acyclic + tail coherent
			let rec = M[a + C.LOG_HEAD];
			let steps = 0;
			let last = rec;
			while (rec !== 0 && steps < 1_000_000) {
				last = rec;
				rec = G[rec + C.L_NEXT];
				++steps;
			}
			if (rec !== 0) problems.push(`tape of ${a} appears cyclic`);
			if (M[a + C.LOG_TAIL] !== last) problems.push(`LOG_TAIL of ${a} incoherent`);
			++counted;
		}
		if (counted !== loggedAtomCount) problems.push(`loggedAtomCount ${loggedAtomCount} != list ${counted}`);
		for (let s = 0; s < 32; ++s) {
			if (batchEntryCount[s] < 0) problems.push(`batchEntryCount[${s}] negative`);
			if (batchToken[s] === 0 && ((liveSlotMask >> s) & 1) !== 0) problems.push(`liveSlotMask bit ${s} without token`);
			if (batchToken[s] !== 0 && ((liveSlotMask >> s) & 1) === 0) problems.push(`token in slot ${s} without mask bit`);
			// slot memo chains acyclic + writer-key + slot-coherent
			let rec = slotMemoHead[s];
			let steps = 0;
			while (rec !== 0 && steps < 1_000_000) {
				if ((W[rec + C.W_KEY] & 3) !== 2) problems.push(`slot ${s} chain holds non-writer key`);
				rec = W[rec + C.W_SLOT_NEXT];
				++steps;
			}
			if (rec !== 0) problems.push(`slot ${s} memo chain cyclic`);
		}
		if (loggedAtomCount === 0 && passOpen === 0 && liveSlotMask === 0 && pendingWalks.length === 0) {
			// Quiescence postconditions (§8.8/§9.7/§14.3).
			if (gNext !== 4) problems.push(`quiescent but gNext=${gNext}`);
			if (wNext !== 8) problems.push(`quiescent but wNext=${wNext}`);
			if (certNext !== 2) problems.push(`quiescent but certNext=${certNext}`);
			if (memoVals.length !== 0) problems.push(`quiescent but memoVals=${memoVals.length}`);
			if (seqCounter !== 1) problems.push(`quiescent but seqCounter=${seqCounter}`);
			for (let s = 0; s < 32; ++s) {
				if (slotMemoHead[s] !== 0) problems.push(`quiescent but slotMemoHead[${s}]!=0`);
			}
			for (const id of allNodes) {
				const f = M[id + C.FLAGS];
				if ((f & (C.K_COMPUTED | C.K_EFFECT | C.K_SCOPE | C.K_WATCHER)) !== 0 && M[id + C.OVERLAY_STAMP] > eraFloor) {
					problems.push(`quiescent but node ${id} still marked`);
				}
			}
		}
		if (problems.length > 0) {
			throw new Error('verifyArena: ' + problems.join('; '));
		}
	}

	return {
		atom,
		reducerAtom,
		computed,
		watch,
		effect,
		effectScope,
		batch,
		untracked,
		readCommitted,
		truncateBatch,
		attachFork,
		debug: {
			verify,
			mode: (): 'DIRECT' | 'LOGGED' => (writeMode === C.MODE_LOGGED ? 'LOGGED' : 'DIRECT'),
			seqCounter: (): number => seqCounter,
			epoch: (): number => overlayEpoch,
			era: (): number => quiescenceCount,
			loggedAtomCount: (): number => loggedAtomCount,
			unappliedEntries: (): number => unappliedEntries,
			liveSlotMask: (): number => liveSlotMask,
			walkCounter: (): number => walkCounter,
			eraFloor: (): number => eraFloor,
			isLogged: (h: SignalHandle): boolean => (M[h.id + C.FLAGS] & C.LOGGED) !== 0,
			isMarked: (h: SignalHandle): boolean =>
				(M[h.id + C.FLAGS] & C.K_ATOM) === 0 && M[h.id + C.OVERLAY_STAMP] > eraFloor,
			readWorld: (h: SignalHandle, sel: WorldSelector): unknown =>
				worldValueOf(h.id, worldFromSelector(sel)),
			takeBroadcasts: (): BroadcastEvent[] => broadcastLog.splice(0, broadcastLog.length),
			quiescent: (): boolean =>
				loggedAtomCount === 0 && passOpen === 0 && liveSlotMask === 0,
			planeResidue: (): { g: boolean; w: boolean } => ({
				g: gNext === 4 && logFreeHead === 0,
				w: wNext === 8 && certNext === 2 && memoVals.length === 0,
			}),
			forceWalkCounter: (n: number): void => {
				walkCounter = n;
				if (eraFloor > n) {
					eraFloor = n;
				}
			},
			forceSeqCounter: (n: number): void => {
				seqCounter = n;
			},
			stats: (): Record<string, number> => ({
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
				unappliedEntries,
			}),
		},
	};
}

export type CosignalEngine = ReturnType<typeof createCosignalEngine>;

