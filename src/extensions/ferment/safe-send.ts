/**
 * Guarded wrapper around `pi.sendMessage` that swallows stale-ctx errors.
 *
 * The ferment extension captures `pi` references in event handlers and deferred
 * callbacks (setTimeout, turn_end → nudge → scheduler). After an upstream
 * session replacement (`ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`,
 * `ctx.reload()`), the captured `pi` is stale and `sendMessage` throws an
 * `assertActive()` error synchronously. When this happens inside a `void`-
 * discarded expression or a setTimeout callback, the throw is uncaught and
 * crashes the process.
 *
 * This helper mirrors the established guard pattern from `prompt-summary.ts`:
 * wrap `sendMessage` in try/catch and silently bail when `isStaleCtxError`
 * fires. Non-stale errors are re-thrown so genuine failures still surface.
 *
 * Note: `ExtensionAPI.sendMessage` returns `void`, not a `Promise` — the
 * stale-ctx `assertActive()` throw is synchronous. This guard only covers
 * synchronous throws; if a future upstream change makes `sendMessage` async,
 * callers that await it should handle async rejections separately.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { isStaleCtxError } from "../stale-ctx.js"

export function safeSendMessage(
	pi: ExtensionAPI,
	message: Parameters<ExtensionAPI["sendMessage"]>[0],
	options?: Parameters<ExtensionAPI["sendMessage"]>[1],
): void {
	try {
		pi.sendMessage(message, options)
	} catch (err) {
		if (isStaleCtxError(err)) return
		throw err
	}
}
