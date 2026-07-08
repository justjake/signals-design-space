/**
 * RoyaleAdapter — the exact surface every entrant ships at royale/adapter.ts
 * in their react package (RULES.md, verbatim). The battery imports ONLY this
 * type plus the ./ADAPTER default export; nothing else about an entry is
 * assumed.
 */
export interface RoyaleHandle {
	errors: unknown[];
	dispose(): void;
}

export interface RoyaleTraceView {
	/** Formatted causal chain from the most recent component delivery caused by
	 * this signal/computed, back to its originating write or retirement. */
	whyLastDelivery(x: unknown): string[];
	events(): Array<{ id: number; kind: string; cause?: number }>;
	stop(): void;
}

export interface RoyaleAdapter {
	slug: string;
	// Modules from the entrant's react build — the battery never imports 'react' itself.
	React: any;
	ReactDOMClient: {
		createRoot(el: Element): { render(node: unknown): void; unmount(): void };
	};
	act<T>(fn: () => T | Promise<T>): Promise<undefined>;
	flushSync(fn: () => void): void;
	// Lifecycle
	register(): RoyaleHandle; // idempotent per process
	resetForTest(): void; // engine reset + host registry scrub
	// Engine
	atom<T>(
		initial: T | (() => T),
		opts?: {
			equals?(a: T, b: T): boolean;
			onObserved?(ctx: { get(): T; set(v: T): void }): void | (() => void);
			label?: string;
		},
	): unknown;
	set(a: unknown, v: unknown): void;
	update(a: unknown, fn: (prev: unknown) => unknown): void;
	computed<T>(
		fn: (use: <U>(t: PromiseLike<U>) => U) => T,
		opts?: { equals?(a: T, b: T): boolean; label?: string },
	): unknown;
	// RULES.md declares these value reads as `unknown`; the battery's mirror
	// uses `any` so the values can appear as JSX children when an entrant's
	// React typings are in scope. `any` and `unknown` accept the same
	// implementations — this relaxes only the consumer side.
	read(x: unknown): any;
	latest(x: unknown): any;
	committed(x: unknown, container?: unknown): any;
	isPending(x: unknown): boolean;
	refresh(x: unknown): void;
	effect(fn: () => void | (() => void)): () => void;
	batch(fn: () => void): void;
	untracked<T>(fn: () => T): T;
	serialize(atoms: unknown[]): string;
	initialize(json: string, atoms: unknown[]): void;
	// React surface (`any` for JSX-child reasons, as above)
	useValue(x: unknown): any;
	useComputed<T>(fn: () => T, deps: unknown[]): T;
	useSignalEffect(fn: () => void | (() => void)): void;
	useIsPending(x: unknown): boolean;
	useCommitted(x: unknown): any;
	startTransitionWrite(scope: () => void): void;
	// Royale features
	trace(): RoyaleTraceView; // starts tracing
	onDomMutation(cb: (phase: 'start' | 'stop', container: Element) => void): () => void;
}
