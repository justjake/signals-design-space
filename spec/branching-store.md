# branching-store

A state storage system that allows for branching and merging of all state in the world.

Branches work like Git: each branch is derived from some base state by applying a series of changes to arrive at its current tip state. You can also think of branches as _transactions_ over a branchable database of states: an aborted transaction is equivalent to a fork from a branch that is never merged.

This library provides a way to model this: a `Store<T>` holds one state in a branch's "checkout" (like a file in Git), a set of actions that commit changes to the branch's state, and APIs to fork, merge, and retire branches.

This is inspired by and seeks to model React's lane-based handling of state in concurrent rendering and transitions.

## Interface

This interface is semantic: we may need to implement a different form of it to meet performance goals or other constraints. Here it just serves a descriptive purpose to show the primitives and their relationships.

```ts
type Store<T> = { [unique symbol]: T };

type StoreAction<S, A> =
  | { type: "set"; state: S }
  | { type: "reduce"; reducer?: (state: S, action?: A) => S; action?: A };

// Consider a Transaction type instead?
 type Branch = {
  tip: Commit
  setTip(commit: Commit): void;
  fork(): Branch;
  merge(...others: Branch[]): Branch;
  retire(): void;
  commit<S, A>(store: Store<S>, action: StoreAction<S, A>): void;
  changesOf(store: Store<S>): Array<StoreAction<S, A>>;
  read<S>(store: Store<S>): S;
}

type Checkout = {
  read<S>(store: Store<S>): S;
  historyOf(store: Store<S>, since?: Commit): Array<ActionPatch<S, A>>;
}

type Transaction = Checkout & {
  apply(patch: Patch<S, A>): void
  commit(): void
  abort(): void
}

type Commit = Checkout & {
  parent?: Commit
  begin(): Transaction
  squash(): Commit
}

type Patch<S, A> =
  | { type: 'store', store: Store<S>, action: StoreAction<S, A> }

// Perhaps we will want to provide an implicit "current branch", and static
// functions that default to targetting it.
// For either perf or convineience.
// (If we just provide Branch and no module-global state, that would allow callers to treat this tool like a createSystem; if we have default state all installers are entangled.)
function fork(branch?: Branch): Branch;
function merge(commitTo: Branch, ...others: Branch[]): Branch;
function retire(branch: Branch): void;
function commit<S, A>(store: Store<S>, action: StoreAction<S, A>, branch?: Branch): void;
function checkout(branch: Branch): void;
function read<S>(store: Store<S>, branch?: Branch): S;
```

- but, we dont really want "commit", we want like "finalize({ merge: [...branches], retire: [...branches] })", because during react commit, some state changes are rolled back, and some are applied even if the branch isn't merged(?). Or, how should we model that? it's kind of like a statement in a txn `SET X = Y ON ABORT STILL COMMIT` vs `SET X = Y ON ABORT ROLLBACK`.
