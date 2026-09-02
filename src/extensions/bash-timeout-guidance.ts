/**
 * Bash safety-limit / timeout guidance
 *
 * Background bash processes are bounded by a harness-owned absolute
 * safety limit (`--bash-process-limit`, default one hour) that the model
 * cannot set or extend. When a process is killed by that limit, the raw
 * outcome
 *
 *     Process killed by the harness safety limit (Ns)
 *
 * gives the agent no guidance on what to do differently. There is no
 * knob to "retry with a bigger number" — the correct responses are to
 * break the work into smaller commands, run a bounded subset first to
 * estimate cost, or move genuinely unbounded work (servers, watchers)
 * to the daemon mechanism.
 *
 * Legacy "Command timed out after N seconds" results can still surface
 * from paths outside the background cohort (e.g. subagent bash clamps);
 * those get the generic de-batching guidance too.
 *
 * Implementation: hooks `tool_result`, checks whether the result is a
 * bash/bash_control limit or timeout error, and steers with actionable
 * guidance via `pi.sendMessage` (`deliverAs: "steer"`) so it lands as a
 * separate message rather than mutating the tool result itself.
 */

import type { TextContent } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent"
import { SAFETY_LIMIT_MESSAGE_PATTERN } from "./bash-background/terminal-status.js"
import { markHarnessSteer } from "./steer-marker.js"

const LEGACY_TIMEOUT_PATTERN = /Command timed out after (\d+) seconds/

const SAFETY_LIMIT_STEER =
	"A bash process was killed by the harness safety limit. This limit is harness-owned and cannot be raised or extended from the session. " +
	"Before retrying: (1) if the command runs multiple operations in sequence (loops, &&, batch scripts), run a single bounded iteration first to measure cost, " +
	"then chunk the work across several bounded bash calls so partial results survive; (2) narrow the workload (fewer inputs/expressions per run). " +
	"(3) If the command is an intentional server or watcher that must keep running indefinitely, it belongs in daemon management, not background bash."

const LEGACY_TIMEOUT_STEER =
	"A bash command timed out. Before retrying: " +
	"(1) If the command runs multiple operations in sequence (loops, &&, batch scripts), " +
	"run a single iteration first to measure how long each one takes. " +
	"(2) Break batched work into smaller bash calls so partial results are not lost on timeout. " +
	"(3) Change approach rather than repeatedly enlarging a deadline."

/** Tools whose limit/timeout error messages this extension recognises. */
const LIMIT_BEARING_TOOLS = new Set(["bash", "bash_control"])

export function isBashLimitResult(event: ToolResultEvent): boolean {
	if (!LIMIT_BEARING_TOOLS.has(event.toolName)) return false
	if (!event.isError) return false
	for (const block of event.content) {
		if (block.type !== "text") continue
		if (SAFETY_LIMIT_MESSAGE_PATTERN.test(block.text)) return true
		if (LEGACY_TIMEOUT_PATTERN.test(block.text)) return true
	}
	return false
}

export default function bashTimeoutGuidanceExtension(pi: ExtensionAPI): void {
	pi.on("tool_result", (event) => {
		if (!isBashLimitResult(event)) return

		const text = event.content
			.filter((b): b is TextContent => b.type === "text")
			.map((b) => b.text)
			.join("\n")

		const safety = text.match(SAFETY_LIMIT_MESSAGE_PATTERN)
		const legacy = text.match(LEGACY_TIMEOUT_PATTERN)
		let message: string
		if (safety) {
			message = `${SAFETY_LIMIT_STEER} (The process was killed at ${safety[1]}s — the partial output above was captured before the kill.)`
		} else if (legacy) {
			message = `${LEGACY_TIMEOUT_STEER} (The command was killed after ${legacy[1]}s — the partial output above was captured before the timeout.)`
		} else {
			return
		}

		pi.sendMessage(
			{
				customType: "bash-timeout-guidance",
				content: [{ type: "text", text: markHarnessSteer(message) }],
				display: false,
			},
			{ deliverAs: "steer" },
		)
	})
}
