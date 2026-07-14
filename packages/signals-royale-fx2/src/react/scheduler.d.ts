/** Minimal typings for the `scheduler` package (react-dom's cooperative
 * scheduler; ships untyped). Only the surface the host uses. */
declare module 'scheduler' {
	export const unstable_ImmediatePriority: number
	export const unstable_NormalPriority: number
	export function unstable_scheduleCallback(priority: number, callback: () => void): unknown
}
