/**
 * §17.2 — the naive replay oracle.
 *
 * Deliberately dumb: per-atom plain arrays of every write ever (no sweeping,
 * no coalescing, no slots, no marks, no memos, no tapes, no walks); reads
 * filter + replay the visibility rule (§10.2) literally; computeds re-derive
 * recursively from world reads every time.
 *
 * Watcher decisions are derived from world values — never from any walk
 * (§17.2): at each drain, for each watcher and each affected world, fully
 * replay the watched node's value in that world and compare it — by the
 * node's equality — with the last value recorded as broadcast (or rendered,
 * i.e. seeded at subscription) for that world. The default for a world never
 * decided in is the node's CURRENT W0 value ("what the committed/urgent path
 * shows"): a batch that never diverged from W0 near the node needs no
 * lane-tagged correction.
 */

export type NodeDef =
	| { type: 'atom'; initial: number }
	| { type: 'reducer'; initial: number } // reducer: (s, a) => s + a
	| { type: 'sum'; deps: number[] } // sum of node values
	| { type: 'branch'; cond: number; ifTrue: number; ifFalse: number } // cond odd?
	| { type: 'chain'; dep: number } // dep + 1
	| { type: 'async'; dep: number } // dep + ctx.use(t); t settles ONCE, globally

/** Indexed pure update functions (shared with alt-a's pinned cases). */
export const UPDATE_FNS: ReadonlyArray<(x: number) => number> = [
	(x) => x + 1,
	(x) => (x * 2) % 1000,
	(x) => x,
	(x) => x - 3,
]

/**
 * Status sentinels (§12.3, Solid-async model): pending/error are VALUES
 * derived per world, not control flow. A pending value is encoded as
 * PENDING_BASE + (origin thenable SERIAL) — the origin is the FIRST
 * unsettled thenable an evaluation observes, which is exactly the engine's
 * node-held box identity key: pending→pending transitions that swap origin
 * (including refresh() minting a fresh request for the same node) are
 * broadcast-visible (new box), same-origin re-derivations are not (box
 * reuse). Real fuzz values are tiny; the sentinel bands cannot collide.
 */
export const PENDING_BASE = 2 ** 40
export const ERRORED = -(2 ** 40)

export type OracleWorld =
	| { kind: 'newest' }
	| { kind: 'committed' }
	| { kind: 'w0' }
	| { kind: 'writer'; token: number }
	| { kind: 'pass'; pin: number; tokens: ReadonlySet<number> }

type Entry = {
	seq: number
	op: 'set' | 'update' | 'dispatch'
	payload: number
	/** when set, UPDATE applies UPDATE_FNS[uf] instead of (+payload) */
	uf?: number
	token: number
	applied: boolean
	retiredSeq: number // 0 = pending
}

type OracleWatcher = {
	watched: number
	lastSeen: Map<number, number> // world token (0 = W0 world) → last value
}

export class Oracle {
	private tickCounter = 1
	readonly defs: NodeDef[] = []
	private entries = new Map<number, Entry[]>() // atom index → all writes ever
	readonly watchers: OracleWatcher[] = []

	tick(): number {
		return ++this.tickCounter
	}

	currentTick(): number {
		return this.tickCounter
	}

	private asyncStates = new Map<
		number,
		{ status: 'pending' | 'resolved' | 'rejected'; value: number; serial: number }
	>()
	private originSerialCounter = 0

	addNode(def: NodeDef): number {
		this.defs.push(def)
		const idx = this.defs.length - 1
		if (def.type === 'atom' || def.type === 'reducer') {
			this.entries.set(idx, [])
		}
		if (def.type === 'async') {
			this.asyncStates.set(idx, {
				status: 'pending',
				value: 0,
				serial: ++this.originSerialCounter,
			})
		}
		return idx
	}

	/** The origin serial of an async node's CURRENT request (the driver keys
	 * thenable identity on this — refresh mints a new one). */
	asyncSerial(idx: number): number {
		return this.asyncStates.get(idx)!.serial
	}

	/** §7 refresh on an async node: a NEW request begins (fresh serial —
	 * fresh thenable identity), status returns to pending. GLOBAL-instant
	 * like settlement (the engine's refresh drain re-derives every world). */
	refreshAsync(idx: number): void {
		const st = this.asyncStates.get(idx)!
		st.status = 'pending'
		st.serial = ++this.originSerialCounter
	}

	/** Settlement is GLOBAL-instant (a thenable resolves once for every
	 * world); the engine invalidates + re-derives, so even pass-pinned worlds
	 * see the settled value on their next read. */
	settleAsync(idx: number, value: number): void {
		const st = this.asyncStates.get(idx)!
		st.status = 'resolved'
		st.value = value
	}

	rejectAsync(idx: number): void {
		this.asyncStates.get(idx)!.status = 'rejected'
	}

	addWatcher(watched: number, liveDeferredTokens: Iterable<number>): number {
		const lastSeen = new Map<number, number>()
		lastSeen.set(0, this.value(watched, { kind: 'w0' }))
		for (const t of liveDeferredTokens) {
			lastSeen.set(t, this.value(watched, { kind: 'writer', token: t }))
		}
		this.watchers.push({ watched, lastSeen })
		return this.watchers.length - 1
	}

	directWrite(idx: number, op: Entry['op'], payload: number, uf?: number): void {
		const t = this.tick()
		this.entries.get(idx)!.push({ seq: t, op, payload, uf, token: 0, applied: true, retiredSeq: t })
	}

	loggedWrite(idx: number, op: Entry['op'], payload: number, token: number, uf?: number): void {
		const t = this.tick()
		this.entries.get(idx)!.push({
			seq: t,
			op,
			payload,
			uf,
			token,
			applied: (token & 1) === 0, // urgent writes are applied (§9.4)
			retiredSeq: 0,
		})
	}

	retire(token: number): void {
		const t = this.tick()
		for (const list of this.entries.values()) {
			for (const e of list) {
				if (e.token === token && e.retiredSeq === 0) {
					e.retiredSeq = t
				}
			}
		}
	}

	truncate(token: number): void {
		for (const [idx, list] of this.entries) {
			this.entries.set(
				idx,
				list.filter((e) => !(e.token === token && e.retiredSeq === 0)),
			)
		}
	}

	private visible(e: Entry, world: OracleWorld): boolean {
		switch (world.kind) {
			case 'newest':
				return true
			case 'committed':
				return e.retiredSeq !== 0
			case 'w0':
				return e.retiredSeq !== 0 || e.applied
			case 'writer':
				return e.retiredSeq !== 0 || e.applied || e.token === world.token
			case 'pass':
				return (
					(e.retiredSeq !== 0 && e.retiredSeq <= world.pin) ||
					(world.tokens.has(e.token) && e.seq <= world.pin)
				)
		}
	}

	/** Fully replay a node's value in a world. */
	value(idx: number, world: OracleWorld): number {
		const def = this.defs[idx]
		switch (def.type) {
			case 'atom':
			case 'reducer': {
				let acc = def.initial
				for (const e of this.entries.get(idx)!) {
					if (!this.visible(e, world)) {
						continue
					}
					if (e.op === 'set') {
						acc = e.payload
					} else if (e.op === 'update') {
						acc = e.uf !== undefined ? UPDATE_FNS[e.uf](acc) : acc + e.payload
					} else {
						acc = acc + e.payload // reducer: (s, a) => s + a
					}
				}
				return acc
			}
			case 'sum': {
				// Engine eval order: an ERROR dep read THROWS and aborts (later
				// deps unread, but any error yields ERRORED anyway); a PENDING
				// dep forwards — evaluation continues, first origin wins.
				let s = 0
				let firstPending = 0
				for (const d of def.deps) {
					const v = this.value(d, world)
					if (v === ERRORED) {
						return ERRORED
					}
					if (v >= PENDING_BASE) {
						if (firstPending === 0) {
							firstPending = v
						}
						continue
					}
					s += v
				}
				return firstPending !== 0 ? firstPending : s
			}
			case 'branch': {
				const cond = this.value(def.cond, world)
				if (cond === ERRORED) {
					return ERRORED
				}
				if (cond >= PENDING_BASE) {
					// A pending cond would select an arm via box.latest — a
					// history the replay oracle deliberately does not model.
					// The generator never taints branch conds.
					throw new Error('oracle: branch cond must not be async-tainted')
				}
				return this.value(cond % 2 === 1 ? def.ifTrue : def.ifFalse, world)
			}
			case 'chain': {
				const v = this.value(def.dep, world)
				if (v === ERRORED || v >= PENDING_BASE) {
					return v // status propagates; pending keeps its origin
				}
				return v + 1
			}
			case 'async': {
				// fn = depRead + ctx.use(t): the dep read comes first (error
				// there aborts before ctx.use); a rejected t THROWS at ctx.use
				// even when the dep is pending; a pending dep's origin wins
				// over own-pending (evalPending is first-write).
				const dep = this.value(def.dep, world)
				if (dep === ERRORED) {
					return ERRORED
				}
				const st = this.asyncStates.get(idx)!
				if (st.status === 'rejected') {
					return ERRORED
				}
				if (dep >= PENDING_BASE) {
					return dep
				}
				if (st.status === 'pending') {
					return PENDING_BASE + st.serial
				}
				return dep + st.value
			}
		}
	}

	/**
	 * The expected (watcherIndex, token) setState set for one drain over the
	 * given affected worlds (token 0 = the W0 world). Updates lastSeen for
	 * fired pairs, exactly like the engine's lastBroadcast.
	 */
	expectedBroadcasts(affectedTokens: readonly number[]): Array<[number, number]> {
		const fired: Array<[number, number]> = []
		for (let wi = 0; wi < this.watchers.length; ++wi) {
			const w = this.watchers[wi]
			for (const tok of affectedTokens) {
				const world: OracleWorld = tok === 0 ? { kind: 'w0' } : { kind: 'writer', token: tok }
				const v = this.value(w.watched, world)
				const last = w.lastSeen.has(tok)
					? w.lastSeen.get(tok)!
					: this.value(w.watched, { kind: 'w0' })
				if (!Object.is(v, last)) {
					w.lastSeen.set(tok, v)
					fired.push([wi, tok])
				}
			}
		}
		return fired
	}
}
