import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { loadConfig } from "../../config.js"

/**
 * Compute the `timeout` (seconds) value to inject into a `bash` tool call.
 *
 * Behaviour:
 *   - Per-call `timeout` (seconds, positive number) wins.
 *   - Otherwise fall back to `defaultMs` from settings, rounded up to whole
 *     seconds, minimum 1.
 *   - Per-call overrides greater than `defaultMs * 10` are clamped so a
 *     misbehaving caller cannot disable the safety net.
 *
 * Exported for testing; the extension handler calls it on every bash call.
 */
export function bashMaxTimeoutSecondsFor(input: Record<string, unknown>, defaultMs: number): number {
	const raw = input.timeout
	const override = typeof raw === "number" && raw > 0 ? raw : undefined
	const cap = Math.ceil((defaultMs * 10) / 1000)

	if (override !== undefined) {
		return Math.max(1, Math.min(override, cap))
	}

	return Math.max(1, Math.ceil(defaultMs / 1000))
}

/**
 * Bash max timeout extension.
 *
 * For each `bash` tool call, fills in `event.input.timeout` (seconds) from
 * the configured maximum when the caller did not already provide one.
 * Upstream `createLocalBashOperations` enforces the timeout and races it
 * against the session AbortController — no other wiring is needed here.
 */
export default function bashMaxTimeoutExtension(pi: ExtensionAPI): void {
	const { bashMaxTimeoutMs } = loadConfig()

	pi.on("tool_call", (event) => {
		if (event.toolName.toLowerCase() !== "bash") return
		const input = event.input as Record<string, unknown>
		input.timeout = bashMaxTimeoutSecondsFor(input, bashMaxTimeoutMs)
	})
}
