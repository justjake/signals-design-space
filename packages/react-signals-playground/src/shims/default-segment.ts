/**
 * The URL segment the bare root forwards to. Its own module — with no
 * implementation loaders — because vite.config.ts needs it, and vite's
 * config bundler inlines relative imports including dynamic ones: importing
 * the implementations table there would pull every engine into the config's
 * module graph. implementations.ts derives its default row from this, so
 * the default still lives in exactly one place.
 */
export const DEFAULT_SEGMENT = 'cosignals'
