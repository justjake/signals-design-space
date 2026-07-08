import { expect, test } from 'vitest';
import {
	atom,
	commitRoot,
	committed,
	latest,
	read,
	reset,
	retireBatch,
	type BatchToken,
} from '../src/index.js';

declare const process: { env: Record<string, string | undefined> };

type Step =
	| { kind: 'urgent-set'; atom: number; value: number }
	| { kind: 'urgent-add'; atom: number; value: number }
	| { kind: 'draft-set'; atom: number; token: number; value: number }
	| { kind: 'draft-add'; atom: number; token: number; value: number }
	| { kind: 'root-commit'; token: number }
	| { kind: 'retire'; token: number; commit: boolean };

type Draft = { atom: number; token: number; set?: number; add?: number };

function random(seed: number): () => number {
	let state = seed | 0;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return state >>> 0;
	};
}

function makeSchedule(seed: number, count: number): Step[] {
	const next = random(seed);
	const steps: Step[] = [];
	const live = new Set([0, 1, 2, 3]);
	for (let index = 0; index < count; index++) {
		const atom = next() % 4;
		const value = (next() % 11) - 5;
		const token = [...live][next() % live.size]!;
		switch (next() % 10) {
			case 0:
			case 1:
				steps.push({ kind: 'urgent-set', atom, value });
				break;
			case 2:
			case 3:
				steps.push({ kind: 'urgent-add', atom, value });
				break;
			case 4:
			case 5:
				steps.push({ kind: 'draft-set', atom, token, value });
				break;
			case 6:
			case 7:
				steps.push({ kind: 'draft-add', atom, token, value });
				break;
			case 8:
				steps.push({ kind: 'root-commit', token });
				break;
			default:
				if (live.size === 1) steps.push({ kind: 'urgent-add', atom, value });
				else {
					steps.push({ kind: 'retire', token, commit: (next() & 1) === 0 });
					live.delete(token);
				}
		}
	}
	return steps;
}

function replay(steps: readonly Step[]): string | undefined {
	reset();
	const cells = [0, 1, 2, 3].map(value => atom(value, { equals: () => false }));
	const tokens: BatchToken[] = [0, 1, 2, 3].map(id => ({ id: id + 1, deferred: true, live: true, committed: false }));
	const root = {};
	const base = [0, 1, 2, 3];
	const drafts: Draft[] = [];
	const rootTokens = new Set<number>();

	const fold = (atomIndex: number, included: (token: number) => boolean): number => {
		let value = base[atomIndex];
		for (const draft of drafts) {
			if (draft.atom !== atomIndex || !included(draft.token)) continue;
			value = draft.set ?? value + draft.add!;
		}
		return value;
	};

	for (let index = 0; index < steps.length; index++) {
		const step = steps[index];
		switch (step.kind) {
			case 'urgent-set':
				base[step.atom] = step.value;
				cells[step.atom].set(step.value);
				break;
			case 'urgent-add':
				base[step.atom] += step.value;
				cells[step.atom].update(value => value + step.value);
				break;
			case 'draft-set':
				drafts.push({ atom: step.atom, token: step.token, set: step.value });
				cells[step.atom].set(step.value, tokens[step.token]);
				break;
			case 'draft-add':
				drafts.push({ atom: step.atom, token: step.token, add: step.value });
				cells[step.atom].update(value => value + step.value, tokens[step.token]);
				break;
			case 'root-commit':
				rootTokens.add(step.token);
				commitRoot(root, [tokens[step.token]]);
				break;
			case 'retire': {
				if (step.commit) {
					for (let atomIndex = 0; atomIndex < base.length; atomIndex++) {
						base[atomIndex] = fold(atomIndex, token => token === step.token);
					}
				}
				for (let draft = drafts.length - 1; draft >= 0; draft--) {
					if (drafts[draft].token === step.token) drafts.splice(draft, 1);
				}
				rootTokens.delete(step.token);
				retireBatch(tokens[step.token], step.commit);
				break;
			}
		}

		for (let atomIndex = 0; atomIndex < cells.length; atomIndex++) {
			const actual = [read(cells[atomIndex]), latest(cells[atomIndex]), committed(cells[atomIndex], root)];
			const expected = [base[atomIndex], fold(atomIndex, () => true), fold(atomIndex, token => rootTokens.has(token))];
			if (!actual.every((value, slot) => value === expected[slot])) {
				return `step ${index}, atom ${atomIndex}: actual ${actual.join('/')} expected ${expected.join('/')}`;
			}
		}
	}
}

test('300 x 90 event-log folds match the naive oracle', () => {
	const seeds = Number(process.env.ORACLE_SEEDS ?? 300);
	const steps = Number(process.env.ORACLE_STEPS ?? 90);
	for (let seed = 1; seed <= seeds; seed++) {
		const schedule = makeSchedule(seed, steps);
		const failure = replay(schedule);
		if (failure !== undefined) {
			let end = 1;
			while (end < schedule.length && replay(schedule.slice(0, end)) === undefined) end++;
			throw new Error(`seed ${seed}: ${failure}\nshrunk schedule: ${JSON.stringify(schedule.slice(0, end))}`);
		}
	}
	expect(seeds).toBeGreaterThanOrEqual(300);
});
