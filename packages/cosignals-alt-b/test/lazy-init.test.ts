// §lazy-init — lazy state initializers (React useState convention):
// `new Atom({ state: () => T })` evaluates ONCE, untracked, at first
// materialization. See SPEC-RESOLUTIONS §lazy-init.
import { beforeEach, describe, expect, it } from 'vitest';
import {
	Atom,
	Computed,
	ForkDouble,
	ReducerAtom,
	__debug,
	__resetEngineForTests,
	attachFork,
	committed,
	configure,
	createWatcher,
	disposeSignal,
	installState,
	latest,
} from '../src/index';

let fork: ForkDouble;

beforeEach(() => {
	__resetEngineForTests();
	fork = new ForkDouble();
	attachFork(fork);
});

describe('once-only + laziness', () => {
	it('the initializer does not run at construction; first read runs it exactly once', () => {
		let runs = 0;
		const a = new Atom({
			state: () => {
				++runs;
				return 10;
			},
		});
		expect(runs).toBe(0); // lazy: construction never evaluates
		expect(a.state).toBe(10);
		expect(runs).toBe(1);
		expect(a.state).toBe(10);
		expect(a.peek()).toBe(10);
		expect(runs).toBe(1); // once-only
		__debug.verify();
	});

	it('function state needs the () => fn wrap (React convention, documented)', () => {
		const fn = () => 42;
		const a = new Atom<() => number>({ state: () => fn });
		expect(a.state).toBe(fn);
		expect(a.state()).toBe(42);
		__debug.verify();
	});

	it('a throwing initializer re-runs on the next read (retry semantics)', () => {
		let runs = 0;
		const a = new Atom({
			state: () => {
				++runs;
				if (runs === 1) {
					throw new Error('flaky');
				}
				return 5;
			},
		});
		expect(() => a.state).toThrow('flaky');
		expect(a.state).toBe(5);
		expect(runs).toBe(2);
		__debug.verify();
	});
});

describe('untracked + graph-pure', () => {
	it('initializer reads link NOTHING: a computed materializing the atom does not depend on the initializer reads', () => {
		const b = new Atom({ state: 1 });
		const a = new Atom({ state: () => b.state * 100 }); // reads b, untracked
		const c = new Computed({ fn: () => a.state + 1 });
		const fires: number[] = [];
		createWatcher(c, (t) => fires.push(t));
		expect(c.state).toBe(101); // c's eval materialized a (init read b=1)
		b.set(2); // must NOT reach c: the init read was untracked
		expect(fires).toEqual([]);
		expect(c.state).toBe(101);
		expect(a.state).toBe(100); // frozen at materialization; b's change is irrelevant
		__debug.verify();
	});

	it('writes inside an initializer are rejected (debug: graph-pure)', () => {
		const b = new Atom({ state: 0 });
		const a = new Atom({
			state: () => {
				b.set(9); // illegal
				return 1;
			},
		});
		expect(() => a.state).toThrow(/lazy state initializer/);
		expect(b.state).toBe(0);
		__debug.verify();
	});

	it('a cyclic initializer (reads its own atom) throws a clear error', () => {
		const a: Atom<number> = new Atom<number>({ state: () => a.state + 1 });
		expect(() => a.state).toThrow(/cyclic lazy initializer/);
		__debug.verify();
	});
});

describe('render-context safety', () => {
	it('first read during a render pass materializes (pure slot fill, not a write)', () => {
		let runs = 0;
		const a = new Atom({
			state: () => {
				++runs;
				return 3;
			},
		});
		fork.startRenderPass('root', []);
		expect(a.state).toBe(3); // no §10.8 write-during-render violation
		expect(runs).toBe(1);
		fork.endRenderPass();
		__debug.verify();
	});
});

describe('write-before-first-read (decision: run the initializer — equality contract holds)', () => {
	function writeBeforeRead(strict: boolean) {
		configure({ strictLanes: strict });
		try {
			let runs = 0;
			const a = new Atom({
				state: () => {
					++runs;
					return 5;
				},
			});
			const fires: number[] = [];
			createWatcher(a, (t) => fires.push(t));
			expect(runs).toBe(1); // watcher seeding reads → materializes
			// Equal write: init produced 5; set(5) must be DROPPED by the
			// equality contract — possible only because the initializer ran.
			a.set(5);
			expect(fires).toEqual([]);
			// Distinct write moves it.
			a.set(6);
			expect(a.state).toBe(6);
			expect(runs).toBe(1);
		} finally {
			configure({ strictLanes: false });
		}
	}

	it('loose gate mode', () => {
		writeBeforeRead(false);
	});

	it('strictLanes gate mode', () => {
		writeBeforeRead(true);
	});

	function pureWriteFirst(strict: boolean) {
		configure({ strictLanes: strict });
		try {
			let runs = 0;
			const a = new Atom({
				state: () => {
					++runs;
					return 5;
				},
			});
			a.set(7); // very first touch is a write: initializer runs for the compare
			expect(runs).toBe(1);
			expect(a.state).toBe(7);
			expect(runs).toBe(1);
		} finally {
			configure({ strictLanes: false });
		}
	}

	it('set() as the very first touch runs the initializer once (loose)', () => {
		pureWriteFirst(false);
	});

	it('set() as the very first touch runs the initializer once (strictLanes)', () => {
		pureWriteFirst(true);
	});

	it('update(fn) materializes: fn receives the initializer result', () => {
		let runs = 0;
		const a = new Atom({
			state: () => {
				++runs;
				return 10;
			},
		});
		a.update((x) => x + 1);
		expect(runs).toBe(1);
		expect(a.state).toBe(11);
		__debug.verify();
	});

	it('ReducerAtom: lazy state + dispatch materializes through the reducer', () => {
		let runs = 0;
		const r = new ReducerAtom<number, number>({
			state: () => {
				++runs;
				return 100;
			},
			reducer: (s, act) => s + act,
		});
		expect(runs).toBe(0);
		r.dispatch(5);
		expect(runs).toBe(1);
		expect(r.state).toBe(105);
		__debug.verify();
	});
});

describe('draft-world first materialization (§lazy-init × tapes)', () => {
	it('a deferred write-before-read bases the tape on the initializer result — canonical, not draft-scoped', () => {
		let runs = 0;
		const a = new Atom({
			state: () => {
				++runs;
				return 10;
			},
		});
		const k = fork.openBatch(true);
		fork.inBatch(k, () => a.set(1)); // first touch EVER, from a draft context
		expect(runs).toBe(1); // the tape's base snapshot materialized it
		// The initializer result is the CANONICAL base state:
		expect(a.state).toBe(10); // ambient W0: draft hidden, base = init
		expect(committed(a)).toBe(10);
		expect(__debug.readInWorld(a, { kind: 'writer', token: k })).toBe(1); // the draft
		expect(latest(a)).toBe(1); // Wn
		fork.retireBatch(k, true);
		expect(a.state).toBe(1); // fold: init base → set(1)
		expect(runs).toBe(1);
		__debug.verify();
	});

	it('first READ from inside a draft scope also materializes the canonical base', () => {
		let runs = 0;
		const a = new Atom({
			state: () => {
				++runs;
				return 10;
			},
		});
		const k = fork.openBatch(true);
		fork.inBatch(k, () => {
			expect(a.state).toBe(10); // read-your-own-draft world; no draft yet → base
		});
		expect(runs).toBe(1);
		expect(a.state).toBe(10);
		fork.retireBatch(k, true);
		__debug.verify();
	});
});

describe('SSR install + lifecycle', () => {
	it('installState IS the materialization: the initializer is skipped', () => {
		let runs = 0;
		const a = new Atom({
			state: () => {
				++runs;
				return 10;
			},
		});
		installState(a, 99);
		expect(a.state).toBe(99);
		expect(runs).toBe(0); // never ran
		__debug.verify();
	});

	it('finalization unchanged: a never-materialized atom disposes cleanly', () => {
		const a = new Atom({ state: () => 1 });
		disposeSignal(a);
		__debug.verify();
	});

	it('observed-lifecycle ordering: initializer runs before the first observe-effect fire', async () => {
		const order: string[] = [];
		const a = new Atom({
			state: () => {
				order.push('init');
				return 1;
			},
			effect: () => {
				order.push('observe');
				return () => order.push('unobserve');
			},
		});
		const w = createWatcher(a, () => {});
		await new Promise((r) => setTimeout(r, 1)); // observe delivery is debounced
		expect(order).toEqual(['init', 'observe']);
		w.dispose();
		await new Promise((r) => setTimeout(r, 1));
		expect(order).toEqual(['init', 'observe', 'unobserve']);
		__debug.verify();
	});
});
