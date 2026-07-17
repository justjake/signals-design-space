import fanout from "./fanout.js"
import mount from "./mount.js"
import transition from "./transition.js"
import type { Scenario } from "./scenario.js"

/** Run order within a child process; scenario names are the CSV test keys. */
export const scenarios: Scenario[] = [fanout, transition, mount]
