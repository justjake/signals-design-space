/**
 * jsdom publishes no bundled type declarations, and the DefinitelyTyped
 * package tracks its own release line; rather than pin a @types version
 * that can drift from the runtime major, declare the two members this
 * package touches.
 */
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: Record<string, unknown>)
    readonly window: Window & typeof globalThis
  }
}
