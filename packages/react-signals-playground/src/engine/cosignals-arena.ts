/**
 * The cosignals-arena engine, as loaded by the selector (./index.ts) on
 * /cosignals-arena/ pages. Importing the package initializes the engine
 * and registers its React bindings (the package's react entry registers
 * on import), so evaluating this module is the page's engine setup.
 */
export * from "cosignals-arena"

/** Display name — rendered by the app so a page proves which engine drives it. */
export const name = "cosignals-arena"
