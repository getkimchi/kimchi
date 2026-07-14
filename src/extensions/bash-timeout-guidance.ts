/**
 * Bash timeout guidance
 *
 * When a bash command times out, the upstream error message is just:
 *
 *     Command timed out after N seconds
 *
 * This gives the LLM no guidance on what to do differently. The natural
 * response is to retry with a larger timeout — which wastes time and
 * budget without changing the outcome (the benchmark data shows agents
 * burning 2+ hours on repeated timeouts with increasingly large timeouts).
 *
 * This extension intercepts bash tool results that contain a timeout error
 * and appends actionable guidance: run a single iteration to estimate
 * timing, break batched work into smaller calls, or change approach.
 *
 * The guidance is generic — it doesn't know about ML training, compilation,
 * or any specific workload. It applies to any command that batches multiple
 * operations (loops, `&&` chains, scripts that iterate) and times out.
 *
 * Implementation: hooks `tool_result`, checks if the result is a bash
 * timeout error, and returns modified content with appended guidance.
 * Uses `pi.sendMessage` with `deliverAs: "steer"` so the guidance lands
 * as a separate steering message rather than mutating the tool result
 * itself (which could confuse the model about what the command produced).
 */

import type { TextContent } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent"

const TIMEOUT_PATTERN = /Command timed out after (\d+) seconds/

const STEER_MESSAGE =
	"A bash command timed out. Before retrying: " +
	"(1) If the command runs multiple operations in sequence (loops, &&, batch scripts), " +
	"run a single iteration first to measure how long each one takes, then set a realistic timeout. " +
	"(2) Break batched work into smaller bash calls so partial results are not lost on timeout. " +
	"(3) If a single operation genuinely needs more time, increase the timeout — but do not " +
	"repeatedly increase it without changing approach."

export function extractTimeoutSeconds(text: string): number | undefined {
	const match = text.match(TIMEOUT_PATTERN)
	if (!match) return undefined
	const seconds = Number.parseInt(match[1], 10)
	return Number.isNaN(seconds) ? undefined : seconds
}

export function isBashTimeoutResult(event: ToolResultEvent): boolean {
	if (event.toolName !== "bash") return false
	if (!event.isError) return false
	for (const block of event.content) {
		if (block.type === "text" && TIMEOUT_PATTERN.test(block.text)) {
			return true
		}
	}
	return false
}

export default function bashTimeoutGuidanceExtension(pi: ExtensionAPI): void {
	pi.on("tool_result", (event) => {
		if (!isBashTimeoutResult(event)) return

		const timeoutSecs = extractTimeoutSeconds(
			event.content
				.filter((b): b is TextContent => b.type === "text")
				.map((b) => b.text)
				.join("\n"),
		)

		const message = timeoutSecs
			? `${STEER_MESSAGE} (The command was killed after ${timeoutSecs}s — the partial output above was captured before the timeout.)`
			: STEER_MESSAGE

		pi.sendMessage(
			{
				customType: "bash-timeout-guidance",
				content: [{ type: "text", text: message }],
				display: false,
			},
			{ deliverAs: "steer" },
		)
	})
}
