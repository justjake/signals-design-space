// The battery compiles JSX against the adapter's React binding (an `any`),
// so it needs a permissive intrinsic-elements table instead of @types/react
// — pulling React types here would tie the battery to one React's typings.
declare namespace JSX {
	interface IntrinsicElements {
		[elemName: string]: any;
	}
	type Element = any;
	interface ElementChildrenAttribute {
		children: {};
	}
}

declare var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
