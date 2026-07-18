/**
 * The bare-root page's only script: forward to the default engine, keeping
 * query and hash (?devtools, ?test=1). Dev and preview redirect before
 * this page ever loads (see vite.config.ts); this stub covers static
 * hosts, which can't issue server redirects. Importing the table keeps the
 * default in exactly one place; the engine loaders are dynamic imports, so
 * none of them load here.
 */
import { defaultImplementation, implementationHref } from "./engine/implementations"

location.replace(implementationHref(defaultImplementation) + location.search + location.hash)
