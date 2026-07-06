/**
 * §17.5 — the frozen-kernel contract suite: drive the shipping kernel (with
 * its overlay additions, overlay empty — DIRECT mode) and the frozen donor
 * artifact (@lab/arena) through IDENTICAL operation sequences and assert
 * behavioral identity: identical values at every read point, identical
 * recompute call sequences (order and count — the exact-pull-count
 * property), and identical effect run orders.
 *
 * "The proven kernel is untouched" must be verifiable by construction, not
 * by claim.
 */
import { describe, expect, it } from 'vitest';
import * as arena from '@lab/arena';
import { createCosignalEngine } from '../src/engine';
import { mulberry32 } from './helpers/oracle';

type Frame = {
	signal(initial: number): { read(): number; write(v: number): void };
	computed(fn: () => number, tag: string): { read(): number };
	effect(fn: () => void): () => void;
	batch(fn: () => void): void;
	log: string[];
};

function arenaFrame(): Frame {
	const log: string[] = [];
	return {
		log,
		signal(initial) {
			const s = arena.signal(initial);
			return { read: () => s(), write: (v) => (s as (v: number) => void)(v) };
		},
		computed(fn, tag) {
			const c = arena.computed(() => {
				log.push(`eval:${tag}`);
				return fn();
			});
			return { read: () => c() };
		},
		effect: (fn) => arena.effect(fn),
		batch(fn) {
			arena.startBatch();
			try {
				fn();
			} finally {
				arena.endBatch();
			}
		},
	};
}

function shippingFrame(): Frame {
	const e = createCosignalEngine();
	const log: string[] = [];
	return {
		log,
		signal(initial) {
			const a = e.atom(initial);
			return { read: () => a.state as number, write: (v) => a.set(v) };
		},
		computed(fn, tag) {
			const c = e.computed(() => {
				log.push(`eval:${tag}`);
				return fn();
			});
			return { read: () => c.state as number };
		},
		effect: (fn) => e.effect(fn),
		batch: (fn) => {
			e.batch(fn);
		},
	};
}

/** Run one scenario on a frame; return the observation log. */
type Scenario = (f: Frame) => void;

function observe(scenario: Scenario, f: Frame): string[] {
	scenario(f);
	return f.log;
}

function contract(name: string, scenario: Scenario): void {
	it(name, () => {
		const frozen = observe(scenario, arenaFrame());
		const shipping = observe(scenario, shippingFrame());
		expect(shipping).toEqual(frozen);
	});
}

describe('§17.5 frozen-kernel contract (scripted scenarios)', () => {
	contract('diamond with cutoff: identical values, eval order, and counts', (f) => {
		const a = f.signal(1);
		const parity = f.computed(() => a.read() % 2, 'parity');
		const scaled = f.computed(() => parity.read() * 100, 'scaled');
		const sum = f.computed(() => parity.read() + scaled.read(), 'sum');
		f.log.push(`v:${sum.read()}`);
		a.write(3); // parity unchanged: cutoff
		f.log.push(`v:${sum.read()}`);
		a.write(4);
		f.log.push(`v:${sum.read()}`);
	});

	contract('effects: synchronous flush, cleanup order, outer-before-inner', (f) => {
		const a = f.signal(0);
		const dispose = f.effect(() => {
			const v = a.read();
			f.log.push(`outer:${v}`);
			f.effect(() => {
				a.read();
				f.log.push(`inner:${v}`);
			});
		});
		a.write(1);
		a.write(2);
		dispose();
		a.write(3);
	});

	contract('batch: fresh mid-batch reads, one flush, dep reverts prune', (f) => {
		const a = f.signal(0);
		const b = f.signal(10);
		const c = f.computed(() => a.read() + b.read(), 'c');
		f.effect(() => {
			f.log.push(`e:${c.read()}`);
		});
		f.batch(() => {
			a.write(1);
			f.log.push(`mid:${c.read()}`);
			b.write(20);
			a.write(0); // revert
		});
		f.log.push(`end:${c.read()}`);
	});

	contract('dynamic dependency trimming', (f) => {
		const flag = f.signal(1);
		const x = f.signal(10);
		const y = f.signal(20);
		const c = f.computed(() => (flag.read() % 2 !== 0 ? x.read() : y.read()), 'branch');
		f.log.push(`v:${c.read()}`);
		flag.write(2);
		f.log.push(`v:${c.read()}`);
		x.write(11); // trimmed dep
		f.log.push(`v:${c.read()}`);
		y.write(21);
		f.log.push(`v:${c.read()}`);
	});

	contract('writes inside effects cascade identically', (f) => {
		const a = f.signal(0);
		const b = f.signal(0);
		f.effect(() => {
			const v = a.read();
			if (v > 0) {
				b.write(v * 10);
			}
		});
		f.effect(() => {
			f.log.push(`b:${b.read()}`);
		});
		a.write(1);
		a.write(2);
	});
});

describe('§17.5 frozen-kernel contract (seeded random sequences)', () => {
	const SEEDS = Number(process.env.CONTRACT_SEEDS ?? 40);

	it(`agrees with the frozen artifact across ${SEEDS} random op sequences`, () => {
		for (let seed = 1; seed <= SEEDS; ++seed) {
			const scenario: Scenario = (f) => {
				const rng = mulberry32(Math.imul(seed, 0x85ebca6b) ^ 0x1b873593);
				const signals: Array<{ read(): number; write(v: number): void }> = [];
				const computeds: Array<{ read(): number }> = [];
				const disposers: Array<() => void> = [];
				for (let i = 0; i < 3; ++i) {
					signals.push(f.signal(Math.floor(rng() * 5)));
				}
				const readable = (): (() => number) => {
					const pool = [...signals.map((s) => () => s.read()), ...computeds.map((c) => () => c.read())];
					return pool[Math.floor(rng() * pool.length)];
				};
				for (let op = 0; op < 60; ++op) {
					const roll = rng();
					if (roll < 0.15 && computeds.length < 6) {
						const r1 = readable();
						const r2 = readable();
						const kind = rng() < 0.5;
						const tag = `c${computeds.length}`;
						computeds.push(
							f.computed(() => (kind ? r1() + r2() : (r1() % 2 !== 0 ? r2() : r1())), tag),
						);
					} else if (roll < 0.2 && disposers.length < 4) {
						const r = readable();
						const tag = `e${disposers.length}`;
						disposers.push(
						f.effect(() => {
							f.log.push(`${tag}:${r()}`);
						}),
					);
					} else if (roll < 0.55) {
						signals[Math.floor(rng() * signals.length)].write(Math.floor(rng() * 5));
					} else if (roll < 0.7) {
						f.batch(() => {
							signals[Math.floor(rng() * signals.length)].write(Math.floor(rng() * 5));
							signals[Math.floor(rng() * signals.length)].write(Math.floor(rng() * 5));
						});
					} else if (roll < 0.78 && disposers.length > 0) {
						const i = Math.floor(rng() * disposers.length);
						disposers[i]();
					} else {
						const r = readable();
						f.log.push(`r:${r()}`);
					}
				}
				for (const d of disposers) {
					d();
				}
			};
			const frozen = observe(scenario, arenaFrame());
			const shipping = observe(scenario, shippingFrame());
			if (shipping.join(';') !== frozen.join(';')) {
				expect.fail(
					`contract divergence at seed ${seed}:\nfrozen:   ${frozen.join(' ')}\nshipping: ${shipping.join(' ')}`,
				);
			}
		}
	});
});
