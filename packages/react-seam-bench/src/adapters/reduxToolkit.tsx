/**
 * Redux Toolkit consumed through react-redux — the idiomatic modern Redux
 * setup: one store holding every cell in a single array slice, actions
 * dispatched from outside React, cells subscribed with useSelector so each
 * one re-renders only when its own slot changes (react-redux's strict
 * equality bailout).
 *
 * Fairness notes:
 * - createSlice writes go through Immer, because that is what Redux
 *   Toolkit users actually ship; the immutable-copy cost per dispatch is
 *   part of the store's honest price. The cosignals-reducer contender pays
 *   the equivalent price with a plain copying reducer.
 * - The immutability and serializability dev middleware are disabled, as
 *   in reduxjs' own benchmark harness: they deep-walk the whole state on
 *   every dispatch, are stripped from production builds, and would swamp
 *   the measurement.
 * - react-redux reads through useSyncExternalStore, so a dispatch inside
 *   React.startTransition is documented to fall back to a synchronous,
 *   blocking re-render (https://react.dev/reference/react/useSyncExternalStore#caveats).
 *   The transition scenario exists to surface exactly that difference; the
 *   sync flush it measures is the library's real behavior, not a harness
 *   artifact.
 */
import { configureStore, createSlice, type PayloadAction } from "@reduxjs/toolkit"
import { startTransition, type ReactNode } from "react"
import { Provider, useSelector } from "react-redux"
import type { Contender } from "./types.js"

const reduxToolkit: Contender = {
  name: "redux-toolkit",
  createCells(n) {
    const slice = createSlice({
      name: "cells",
      initialState: () => new Array<number>(n).fill(0),
      reducers: {
        write: (state, action: PayloadAction<{ i: number; v: number }>) => {
          state[action.payload.i] = action.payload.v
        },
        // One action for the whole batch: a single reducer pass and a
        // single notification sweep, the best a single-store design can do.
        many: (state, action: PayloadAction<Array<[number, number]>>) => {
          for (const [i, v] of action.payload) {
            state[i] = v
          }
        },
      },
    })
    const store = configureStore({
      reducer: slice.reducer,
      middleware: (getDefault) =>
        getDefault({ immutableCheck: false, serializableCheck: false }),
      devTools: false,
    })
    const { write, many } = slice.actions

    return {
      Provider: ({ children }: { children: ReactNode }) => (
        <Provider store={store}>{children}</Provider>
      ),
      useCell: (i) => useSelector((state: number[]) => state[i]),
      writeCell: (i, v) => {
        store.dispatch(write({ i, v }))
      },
      writeMany: (updates) => {
        store.dispatch(many(updates))
      },
      writeManyInTransition: (updates) => {
        startTransition(() => {
          store.dispatch(many(updates))
        })
      },
      dispose() {},
    }
  },
}

export default reduxToolkit
