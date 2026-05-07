import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"

export const MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000

/**
 * Extension that arms a wall-clock kill switch after `timeoutMs` milliseconds.
 * The timer is started on `session_start` and cleared on `session_shutdown`.
 *
 * When the timer fires, the most recent session ctx's `shutdown()` is called
 * to allow extension cleanup hooks (telemetry flush, MCP teardown) to run,
 * then the user-supplied `onTimeout` callback fires (typically
 * `() => process.exit(124)` in production).
 */
export function timeoutGuardExtension(options: { timeoutMs: number; onTimeout: () => void }): (
	pi: ExtensionAPI,
) => void {
	const { onTimeout } = options

	if (options.timeoutMs <= 0) {
		throw new Error("timeoutMs must be a positive number")
	}

	const timeoutMs = Math.min(options.timeoutMs, MAX_TIMEOUT_MS)

	return (pi: ExtensionAPI) => {
		let timer: ReturnType<typeof setTimeout> | undefined
		let activeCtx: ExtensionContext | undefined

		pi.on("session_start", (_event, ctx) => {
			activeCtx = ctx
			if (timer !== undefined) {
				clearTimeout(timer)
			}
			timer = setTimeout(() => {
				timer = undefined
				try {
					activeCtx?.shutdown()
				} catch {
					// best-effort cleanup; do not block onTimeout
				}
				onTimeout()
			}, timeoutMs)
		})

		pi.on("session_shutdown", () => {
			if (timer !== undefined) {
				clearTimeout(timer)
				timer = undefined
			}
			activeCtx = undefined
		})
	}
}
