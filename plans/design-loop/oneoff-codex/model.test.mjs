import assert from "node:assert/strict";
import test from "node:test";

const NO_LANE = Symbol("committed");

function applyUpdate(state, update) {
	return update.kind === "set" ? update.value : update.value(state);
}

function processQueue(cell, pass) {
	const updates = [];
	for (const update of cell.current.baseQueue) {
		updates.push(update);
	}
	for (const update of cell.pending) {
		if (update.seq <= pass.pin) {
			updates.push(update);
		}
	}

	let state = cell.current.baseState;
	let baseState = state;
	let skipped = false;
	const baseQueue = [];

	for (const update of updates) {
		const included = update.lane === NO_LANE || pass.lanes.has(update.lane);
		if (!included) {
			if (!skipped) {
				skipped = true;
				baseState = state;
			}
			baseQueue.push(update);
			continue;
		}

		if (skipped) {
			baseQueue.push({ ...update, lane: NO_LANE });
		}
		state = applyUpdate(state, update);
	}

	if (!skipped) {
		baseState = state;
	}

	return { baseQueue, baseState, value: state };
}

class Cell {
	constructor(value) {
		this.current = { baseQueue: [], baseState: value, value };
		this.newest = value;
		this.pending = [];
		this.consumers = new Set();
	}
}

class Component {
	constructor(name) {
		this.name = name;
		this.committedDeps = new Set();
		this.scheduled = new Set();
	}
}

class Root {
	seq = 0;
	activePass = undefined;
	dirty = new Set();
	rootLanes = new Set();

	write(cell, lane, kind, value) {
		if (this.activePass?.rendering) {
			throw new Error("signal writes during render are forbidden");
		}

		const update = { kind, lane, seq: ++this.seq, value };
		cell.newest = applyUpdate(cell.newest, update);
		cell.pending.push(update);
		this.dirty.add(cell);
		this.rootLanes.add(lane);

		for (const component of cell.consumers) {
			component.scheduled.add(lane);
		}
		const passConsumers = this.activePass?.consumers.get(cell);
		if (passConsumers !== undefined) {
			for (const component of passConsumers) {
				component.scheduled.add(lane);
			}
		}
		return update;
	}

	startPass(lanes) {
		assert.equal(this.activePass, undefined);
		const pass = new Pass(this, lanes, this.seq);
		this.activePass = pass;
		return pass;
	}

	commit(pass) {
		assert.equal(pass, this.activePass);
		for (const cell of this.dirty) {
			if (!pass.cells.has(cell)) {
				pass.cells.set(cell, processQueue(cell, pass));
			}
		}

		for (const [cell, state] of pass.cells) {
			cell.current = state;
			let write = 0;
			for (const update of cell.pending) {
				if (update.seq > pass.pin) {
					cell.pending[write++] = update;
				}
			}
			cell.pending.length = write;
		}

		for (const [component, nextDeps] of pass.deps) {
			for (const cell of component.committedDeps) {
				cell.consumers.delete(component);
			}
			component.committedDeps = nextDeps;
			for (const cell of nextDeps) {
				cell.consumers.add(component);
			}
		}

		this.dirty.clear();
		for (const [cell, state] of pass.cells) {
			if (cell.pending.length !== 0 || state.baseQueue.length !== 0) {
				this.dirty.add(cell);
			}
		}
		this.activePass = undefined;
	}

	discard(pass) {
		assert.equal(pass, this.activePass);
		this.activePass = undefined;
	}
}

class Pass {
	constructor(root, lanes, pin) {
		this.root = root;
		this.lanes = new Set(lanes);
		this.pin = pin;
		this.cells = new Map();
		this.computed = new Map();
		this.consumers = new Map();
		this.deps = new Map();
		this.component = undefined;
		this.collectors = [];
		this.rendering = false;
	}

	read(cell) {
		let state = this.cells.get(cell);
		if (state === undefined) {
			state = processQueue(cell, this);
			this.cells.set(cell, state);
		}
		this.record(cell);
		return state.value;
	}

	record(cell) {
		const component = this.component;
		if (component === undefined) {
			return;
		}

		let deps = this.deps.get(component);
		if (deps === undefined) {
			deps = new Set();
			this.deps.set(component, deps);
		}
		deps.add(cell);

		let consumers = this.consumers.get(cell);
		if (consumers === undefined) {
			consumers = new Set();
			this.consumers.set(cell, consumers);
		}
		consumers.add(component);

		const collector = this.collectors[this.collectors.length - 1];
		if (collector !== undefined) {
			collector.add(cell);
		}

		for (const update of cell.current.baseQueue) {
			if (update.lane !== NO_LANE && !this.lanes.has(update.lane)) {
				component.scheduled.add(update.lane);
			}
		}
		for (const update of cell.pending) {
			if (update.seq > this.pin || !this.lanes.has(update.lane)) {
				component.scheduled.add(update.lane);
			}
		}
	}

	compute(key, fn) {
		const memo = this.computed.get(key);
		if (memo !== undefined) {
			for (const cell of memo.leaves) {
				this.record(cell);
			}
			return memo.value;
		}

		const leaves = new Set();
		this.collectors.push(leaves);
		let value;
		try {
			value = fn();
		} finally {
			this.collectors.pop();
		}
		this.computed.set(key, { leaves, value });
		return value;
	}

	render(component, fn) {
		this.component = component;
		this.deps.set(component, new Set());
		this.rendering = true;
		try {
			return fn();
		} finally {
			this.rendering = false;
			this.component = undefined;
		}
	}
}

function subscribe(component, ...cells) {
	for (const cell of cells) {
		component.committedDeps.add(cell);
		cell.consumers.add(component);
	}
}

test("queue replay matches React's 4-not-3 rebase arithmetic", () => {
	const root = new Root();
	const cell = new Cell(1);
	root.write(cell, "T", "update", value => value + 1);
	root.write(cell, "U", "update", value => value * 2);

	const urgent = root.startPass(["U"]);
	assert.equal(urgent.read(cell), 2);
	root.commit(urgent);

	const transition = root.startPass(["T"]);
	assert.equal(transition.read(cell), 4);
	root.commit(transition);
	assert.equal(cell.current.value, 4);
	assert.equal(cell.newest, 4);
});

test("a plain set overwrites a skipped updater during rebase", () => {
	const root = new Root();
	const cell = new Cell(1);
	root.write(cell, "T", "update", value => value + 1);
	root.write(cell, "U", "set", 5);

	const urgent = root.startPass(["U"]);
	assert.equal(urgent.read(cell), 5);
	root.commit(urgent);

	const transition = root.startPass(["T"]);
	assert.equal(transition.read(cell), 5);
	root.commit(transition);
});

test("flushSync can exclude an earlier default update for atom and computed", () => {
	const root = new Root();
	const atom = new Cell(0);
	root.write(atom, "D", "set", 1);

	const sync = root.startPass(["SYNC"]);
	assert.equal(sync.read(atom), 0);
	assert.equal(sync.compute("c", () => sync.read(atom) + 10), 10);
	root.discard(sync);
});

test("equal writes in overlapping lanes are retained", () => {
	const root = new Root();
	const cell = new Cell(0);
	root.write(cell, "T", "set", 1);
	root.write(cell, "U", "set", 1);
	assert.equal(cell.pending.length, 2);

	const urgent = root.startPass(["U"]);
	assert.equal(urgent.read(cell), 1);
	root.discard(urgent);
});

test("a yielded pass never sees post-pin writes on first or later reads", () => {
	const root = new Root();
	const x = new Cell(0);
	const y = new Cell(0);
	const pass = root.startPass(["T"]);
	assert.equal(pass.read(x), 0);

	root.write(x, "U", "set", 1);
	root.write(y, "U", "set", 1);
	assert.equal(pass.read(x), 0);
	assert.equal(pass.read(y), 0);
	root.discard(pass);
});

test("a world-only dependency schedules a same-lane follow-up write", () => {
	const root = new Root();
	const flag = new Cell(false);
	const a = new Cell(0);
	const b = new Cell(0);
	const watcher = new Component("watcher");
	subscribe(watcher, flag, b);

	root.write(flag, "T", "set", true);
	assert(watcher.scheduled.has("T"));
	watcher.scheduled.clear();

	const pass = root.startPass(["T"]);
	assert.equal(pass.render(watcher, () => pass.read(flag) ? pass.read(a) : pass.read(b)), 0);
	root.write(a, "T", "set", 1);
	assert(watcher.scheduled.has("T"));
	root.discard(pass);
});

test("installing a dependency retro-schedules an older excluded lane", () => {
	const root = new Root();
	const flag = new Cell(false);
	const a = new Cell(0);
	const b = new Cell(0);
	const watcher = new Component("watcher");
	subscribe(watcher, flag, b);

	root.write(flag, "T1", "set", true);
	root.write(a, "T2", "set", 1);
	watcher.scheduled.clear();

	const pass = root.startPass(["T1"]);
	assert.equal(pass.render(watcher, () => pass.read(flag) ? pass.read(a) : pass.read(b)), 0);
	assert(watcher.scheduled.has("T2"));
	root.discard(pass);
});

test("a subset pass records dependencies even when base and newest agree", () => {
	const root = new Root();
	const flag = new Cell(false);
	const a = new Cell(0);
	const b = new Cell(0);
	const watcher = new Component("watcher");
	subscribe(watcher, flag, b);

	root.write(flag, "T1", "set", true);
	root.write(flag, "T2", "set", false);
	assert.equal(flag.current.value, false);
	assert.equal(flag.newest, false);

	const pass = root.startPass(["T1"]);
	assert.equal(pass.render(watcher, () => pass.read(flag) ? pass.read(a) : pass.read(b)), 0);
	watcher.scheduled.clear();
	root.write(a, "U", "set", 1);
	assert(watcher.scheduled.has("U"));
	root.discard(pass);
});

test("a late mount retro-schedules the pending lane it excluded", () => {
	const root = new Root();
	const cell = new Cell(0);
	const mount = new Component("mount");
	root.write(cell, "T", "set", 1);

	const urgent = root.startPass(["U"]);
	assert.equal(urgent.render(mount, () => urgent.read(cell)), 0);
	assert(mount.scheduled.has("T"));
	root.discard(urgent);
});

test("a shared pass memo replays leaf subscriptions to every consumer", () => {
	const root = new Root();
	const cell = new Cell(1);
	const first = new Component("first");
	const second = new Component("second");
	const pass = root.startPass(["T"]);
	const readDouble = () => pass.compute("double", () => pass.read(cell) * 2);

	assert.equal(pass.render(first, readDouble), 2);
	assert.equal(pass.render(second, readDouble), 2);
	root.write(cell, "T", "set", 2);
	assert(first.scheduled.has("T"));
	assert(second.scheduled.has("T"));
	root.discard(pass);
});

test("store-only work commits without a consumer", () => {
	const root = new Root();
	const cell = new Cell(0);
	root.write(cell, "T", "set", 5);
	const pass = root.startPass(["T"]);
	root.commit(pass);
	assert.equal(cell.current.value, 5);
});

test("render writes reject before either representation changes", () => {
	const root = new Root();
	const cell = new Cell(0);
	const component = new Component("writer");
	const pass = root.startPass(["T"]);
	assert.throws(
		() => pass.render(component, () => root.write(cell, "T", "set", 1)),
		/writes during render/,
	);
	assert.equal(cell.newest, 0);
	assert.equal(cell.pending.length, 0);
	root.discard(pass);
});

test("small exhaustive queue schedules rebase to insertion-order final state", () => {
	const operations = [
		{ kind: "update", value: value => value + 1 },
		{ kind: "update", value: value => value * 2 },
		{ kind: "set", value: 5 },
	];
	const lanes = ["A", "B"];

	for (const first of operations) {
		for (const second of operations) {
			for (const firstLane of lanes) {
				for (const secondLane of lanes) {
					for (const firstRenderLane of lanes) {
						const root = new Root();
						const cell = new Cell(1);
						root.write(cell, firstLane, first.kind, first.value);
						root.write(cell, secondLane, second.kind, second.value);

						const partial = root.startPass([firstRenderLane]);
						partial.read(cell);
						root.commit(partial);

						const finalPass = root.startPass(lanes);
						const actual = finalPass.read(cell);
						let expected = 1;
						expected = applyUpdate(expected, first);
						expected = applyUpdate(expected, second);
						assert.equal(actual, expected);
						root.commit(finalPass);
					}
				}
			}
		}
	}
});
