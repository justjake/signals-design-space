import { expect, test } from 'vitest'
import { type Atom, type Branch, Runtime, type RuntimeHost } from '../src/index.js'

type Update = 0 | 1 | 2 | 3
type Op =
	| { kind: 'set'; slot: number; deferred: boolean; atom: number; value: number; mask: number }
	| { kind: 'update'; slot: number; deferred: boolean; atom: number; update: Update; mask: number }
	| { kind: 'commit'; slot: number; mask: number }
	| { kind: 'finish'; slot: number; committed: boolean; mask: number }

interface ModelBranch {
	readonly id: number
	readonly lane: number
	readonly deferred: boolean
	engine?: Branch
	status: 0 | 1 | 2
	lastSeq: number
}

interface ModelOperation {
	readonly seq: number
	readonly branch: ModelBranch
	readonly kind: 0 | 1
	readonly value: number
	readonly update: Update
}

interface ModelAtom {
	base: number
	operations: ModelOperation[]
}

const updateFns = [
	(value: number) => value + 1,
	(value: number) => value * 2,
	(value: number) => value - 3,
	(value: number) => (value % 5) - 2,
] as const

function apply(operation: ModelOperation, value: number): number {
	return operation.kind === 0 ? operation.value : updateFns[operation.update](value)
}

function fold(atom: ModelAtom, include: (operation: ModelOperation) => boolean): number {
	let value = atom.base
	for (let i = 0; i < atom.operations.length; i++) {
		const operation = atom.operations[i]!
		if (include(operation)) {
			value = apply(operation, value)
		}
	}
	return value
}

function canonical(atom: ModelAtom): number {
	return fold(atom, (operation) => !operation.branch.deferred || operation.branch.status === 1)
}

function newest(atom: ModelAtom): number {
	return fold(atom, (operation) => operation.branch.status !== 2)
}

function writer(atom: ModelAtom, branch: ModelBranch): number {
	return fold(
		atom,
		(operation) =>
			operation.branch === branch || !operation.branch.deferred || operation.branch.status === 1,
	)
}

function worldValue(
	atom: ModelAtom,
	mask: number,
	pin: number,
	cutoffs: Map<ModelBranch, number>,
): number {
	return fold(
		atom,
		(operation) =>
			operation.seq <= (cutoffs.get(operation.branch) ?? 0) ||
			(operation.seq <= pin && (operation.branch.lane & mask) !== 0),
	)
}

function generated(seed: number, steps: number): Op[] {
	let state = seed >>> 0
	const next = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0
		return state
	}
	const result: Op[] = []
	for (let i = 0; i < steps; i++) {
		const choice = next() % 10
		const slot = next() % 4
		const mask = next() & 15
		if (choice < 4) {
			result.push({
				kind: 'update',
				slot,
				deferred: (next() & 1) === 1,
				atom: next() % 5,
				update: (next() & 3) as Update,
				mask,
			})
		} else if (choice < 7) {
			result.push({
				kind: 'set',
				slot,
				deferred: (next() & 1) === 1,
				atom: next() % 5,
				value: (next() % 17) - 8,
				mask,
			})
		} else if (choice < 8) {
			result.push({ kind: 'commit', slot, mask })
		} else {
			result.push({ kind: 'finish', slot, committed: (next() & 1) === 1, mask })
		}
	}
	return result
}

function run(schedule: Op[]): string | undefined {
	const runtime = new Runtime()
	const actual: Atom<number>[] = []
	const model: ModelAtom[] = []
	for (let i = 0; i < 5; i++) {
		actual.push(runtime.atom(i - 2))
		model.push({ base: i - 2, operations: [] })
	}
	const sum = runtime.computed(() => actual[0]!.state * 3 + actual[1]!.state)
	const dynamic = runtime.computed(() =>
		(actual[2]!.state & 1) === 0 ? actual[3]!.state : actual[4]!.state,
	)
	const total = runtime.computed(() => sum.state + dynamic.state)
	const slots: Array<ModelBranch | undefined> = []
	const cutoffs = new Map<ModelBranch, number>()
	let sequence = 0
	let nextBranch = 1
	let activeSlot = 0
	let activeDeferred = false
	const host: RuntimeHost = {
		write(fn) {
			return fn(1 << activeSlot, activeDeferred)
		},
		run(_lane, fn) {
			return fn()
		},
	}
	runtime.attachHost(host)

	for (let step = 0; step < schedule.length; step++) {
		const operation = schedule[step]!
		let branch = slots[operation.slot]
		if (operation.kind === 'set' || operation.kind === 'update') {
			if (branch === undefined) {
				branch = {
					id: nextBranch++,
					lane: 1 << operation.slot,
					deferred: operation.deferred,
					status: 0,
					lastSeq: 0,
				}
				slots[operation.slot] = branch
			}
			activeSlot = operation.slot
			activeDeferred = branch.deferred
			const atom = model[operation.atom]!
			const previous = writer(atom, branch)
			const next =
				operation.kind === 'set' ? operation.value : updateFns[operation.update](previous)
			if (operation.kind === 'set') {
				actual[operation.atom]!.set(operation.value)
			} else {
				actual[operation.atom]!.update(updateFns[operation.update])
			}
			if (branch.engine === undefined) {
				for (const candidate of runtime.activeBranches()) {
					if (candidate.lane === branch.lane) {
						branch.engine = candidate
					}
				}
			}
			if (!Object.is(previous, next)) {
				const modeled: ModelOperation =
					operation.kind === 'set'
						? { seq: ++sequence, branch, kind: 0, value: operation.value, update: 0 }
						: { seq: ++sequence, branch, kind: 1, value: 0, update: operation.update }
				atom.operations.push(modeled)
				branch.lastSeq = modeled.seq
			}
		} else if (operation.kind === 'commit') {
			if (branch !== undefined) {
				cutoffs.set(branch, branch.lastSeq)
			}
		} else if (branch !== undefined) {
			branch.status = operation.committed ? 1 : 2
			if (operation.committed) {
				cutoffs.set(branch, branch.lastSeq)
			} else {
				cutoffs.delete(branch)
			}
			runtime.finishBranch(branch.engine!, operation.committed)
			slots[operation.slot] = undefined
			let anyActive = false
			for (let i = 0; i < slots.length; i++) {
				if (slots[i] !== undefined) {
					anyActive = true
				}
			}
			if (!anyActive) {
				for (let i = 0; i < model.length; i++) {
					model[i]!.base = canonical(model[i]!)
					model[i]!.operations.length = 0
				}
				cutoffs.clear()
			}
		}

		for (let i = 0; i < actual.length; i++) {
			const got = actual[i]!.state
			const want = canonical(model[i]!)
			if (!Object.is(got, want)) {
				return `step ${step} atom ${i} canonical: ${got} != ${want}`
			}
			const gotLatest = runtime.latest(actual[i]!)
			const wantLatest = newest(model[i]!)
			if (!Object.is(gotLatest, wantLatest)) {
				return `step ${step} atom ${i} latest: ${gotLatest} != ${wantLatest}`
			}
		}
		const wantSum = canonical(model[0]!) * 3 + canonical(model[1]!)
		const wantDynamic =
			(canonical(model[2]!) & 1) === 0 ? canonical(model[3]!) : canonical(model[4]!)
		if (sum.state !== wantSum) {
			return `step ${step} sum: ${sum.state} != ${wantSum}`
		}
		if (dynamic.state !== wantDynamic) {
			return `step ${step} dynamic: ${dynamic.state} != ${wantDynamic}`
		}
		if (total.state !== wantSum + wantDynamic) {
			return `step ${step} total: ${total.state} != ${wantSum + wantDynamic}`
		}
		const latestSum = newest(model[0]!) * 3 + newest(model[1]!)
		const latestDynamic = (newest(model[2]!) & 1) === 0 ? newest(model[3]!) : newest(model[4]!)
		const gotLatestTotal = runtime.latest(total)
		if (!Object.is(gotLatestTotal, latestSum + latestDynamic)) {
			return `step ${step} computed latest: ${gotLatestTotal} != ${latestSum + latestDynamic}`
		}

		const engineCutoffs = new Map<Branch, number>()
		for (const [modelBranch, cutoff] of cutoffs) {
			if (modelBranch.engine !== undefined) {
				engineCutoffs.set(modelBranch.engine, cutoff)
			}
		}
		const root = {}
		const world = runtime.createWorld(root, operation.mask, engineCutoffs, false, true)
		const leaves: Atom<any>[] = []
		try {
			const expected: number[] = []
			for (let i = 0; i < model.length; i++) {
				expected.push(worldValue(model[i]!, operation.mask, sequence, cutoffs))
				const got = runtime.withWorld(world, leaves, () => actual[i]!.state)
				if (!Object.is(got, expected[i])) {
					return `step ${step} atom ${i} world(${operation.mask}): ${got} != ${expected[i]}`
				}
			}
			const got = runtime.withWorld(world, leaves, () => total.state)
			const expectedDynamic = (expected[2]! & 1) === 0 ? expected[3]! : expected[4]!
			const want = expected[0]! * 3 + expected[1]! + expectedDynamic
			if (!Object.is(got, want)) {
				return `step ${step} computed world: ${got} != ${want}`
			}
		} finally {
			runtime.releaseWorld(world)
		}
	}
	return undefined
}

function shrink(schedule: Op[]): Op[] {
	let result = schedule
	let width = Math.floor(result.length / 2)
	while (width !== 0) {
		let reduced = false
		for (let start = 0; start + width <= result.length; start++) {
			const candidate = result.slice(0, start).concat(result.slice(start + width))
			if (run(candidate) !== undefined) {
				result = candidate
				reduced = true
				break
			}
		}
		if (!reduced) {
			width = Math.floor(width / 2)
		}
	}
	return result
}

test('operation journals match a memo-free world oracle', () => {
	const seeds = Number(process.env.STRATA_ORACLE_SEEDS ?? 300)
	const steps = Number(process.env.STRATA_ORACLE_STEPS ?? 90)
	for (let seed = 1; seed <= seeds; seed++) {
		const schedule = generated(seed, steps)
		const failure = run(schedule)
		if (failure !== undefined) {
			const minimal = shrink(schedule)
			throw new Error(
				`Strata oracle seed ${seed}: ${failure}\nshrunk schedule:\n${JSON.stringify(minimal, null, 2)}`,
			)
		}
	}
})

test('latest includes a committed branch while another branch remains active', () => {
	expect(
		run([
			{ kind: 'set', slot: 0, deferred: true, atom: 0, value: 8, mask: 1 },
			{ kind: 'set', slot: 1, deferred: true, atom: 1, value: 7, mask: 2 },
			{ kind: 'finish', slot: 0, committed: true, mask: 2 },
		]),
	).toBeUndefined()
})

test('latest excludes discarded operations when a lane is reused', () => {
	expect(
		run([
			{ kind: 'set', slot: 0, deferred: true, atom: 0, value: 8, mask: 1 },
			{ kind: 'set', slot: 1, deferred: true, atom: 1, value: 7, mask: 2 },
			{ kind: 'finish', slot: 0, committed: false, mask: 2 },
			{ kind: 'update', slot: 0, deferred: true, atom: 0, update: 0, mask: 1 },
		]),
	).toBeUndefined()
})

test('functional transition updates rebase over urgent updates', () => {
	const runtime = new Runtime()
	let lane = 2
	let deferred = true
	runtime.attachHost({
		write(fn) {
			return fn(lane, deferred)
		},
		run(_lane, fn) {
			return fn()
		},
	})
	const value = runtime.atom(1)
	value.update((current) => current + 1)
	const transition = runtime.activeBranches().next().value!
	lane = 1
	deferred = false
	value.update((current) => current * 2)
	const urgent =
		runtime.activeBranches().next().value === transition
			? [...runtime.activeBranches()][1]!
			: runtime.activeBranches().next().value!
	expect(value.state).toBe(2)
	runtime.finishBranch(urgent, true)
	runtime.finishBranch(transition, true)
	expect(value.state).toBe(4)
})
