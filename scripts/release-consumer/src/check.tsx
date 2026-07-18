import { createElement, type ReactElement } from "react"
import {
  CosignalsProvider,
  createAtom,
  type Atom,
  useSignal,
} from "cosignals"
import { createComputed } from "cosignals/core"
import {
  createAtom as createArenaAtom,
  type Atom as ArenaAtom,
} from "cosignals-arena"
import {
  CosignalsProvider as ArenaProvider,
  useSignal as useArenaSignal,
} from "cosignals-arena/react"
import { attachCosignalsDevtools } from "cosignals-devtools/cosignals"
import { attachCosignalsArenaDevtools } from "cosignals-devtools/cosignals-arena"

const objectAtom: Atom<number> = createAtom(1)
const arenaAtom: ArenaAtom<number> = createArenaAtom(1)
const doubled = createComputed(() => objectAtom.get() * 2)

function ObjectReader(): ReactElement {
  return createElement("span", null, useSignal(objectAtom))
}

function ArenaReader(): ReactElement {
  return createElement("span", null, useArenaSignal(arenaAtom))
}

const objectTree = createElement(CosignalsProvider, null, createElement(ObjectReader))
const arenaTree = createElement(ArenaProvider, null, createElement(ArenaReader))

void [
  doubled,
  objectTree,
  arenaTree,
  attachCosignalsDevtools,
  attachCosignalsArenaDevtools,
]
