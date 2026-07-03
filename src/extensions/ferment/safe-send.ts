/**
 * Guarded wrappers around `pi` action methods that swallow stale-ctx errors.
 *
 * The ferment extension captures `pi` references in event handlers and deferred
 * callbacks (setTimeout, turn_end → nudge → scheduler). After an upstream
 * session replacement (`ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`,
 * `ctx.reload()`), the captured `pi` is stale and any `pi` method that calls
 * `assertActive()` throws synchronously. When this happens inside a `void`-
 * discarded expression or a setTimeout callback, the throw is uncaught and
 * crashes the process.
 *
 * `tryPiAction` wraps an arbitrary `pi` action group in try/catch, silently
 * bailing when `isStaleCtxError` fires. Non-stale errors are re-thrown so
 * genuine failures still surface. `safeSendMessage` is a convenience wrapper
 * for the most common single-action case.
 *
 * Note: `ExtensionAPI.sendMessage` returns `void`, not a `Promise` — the
 * stale-ctx `assertActive()` throw is synchronous. This guard only covers
 * synchronous throws; if a future upstream change makes `sendMessage` async,
 * callers that await it should handle async rejections separately.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { isStaleCtxError } from "../stale-ctx.js"

/**
 * Run a `pi` action (or group of actions) guarded against stale-ctx errors.
 * Returns `true` if the action ran, `false` if it was skipped due to a stale
 * context. Non-stale errors are re-thrown.
 */
export function tryPiAction(action: () => void): boolean {
	try {
		action()
		return true
	} catch (err) {
		if (isStaleCtxError(err)) return false
		throw err
	}
}

export function safeSendMessage(
	pi: ExtensionAPI,
	message: Parameters<ExtensionAPI["sendMessage"]>[0],
	options?: Parameters<ExtensionAPI["sendMessage"]>[1],
): void {
	tryPiAction(() => {
		pi.sendMessage(message, options)
	})
}
