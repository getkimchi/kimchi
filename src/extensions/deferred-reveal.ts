import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "./agent-worker-context.js"
import type { ToolVisibilityAPI } from "./prompt-construction/tool-visibility.js"

/**
 * Shared defer + one-way-reveal pattern for tool visibility.
 *
 * A deferred tool group starts hidden (disable vote, unless the session is an
 * agent worker — workers are profile-managed and keep full visibility) and is
 * revealed exactly once when its anchor fires. The caller invokes
 * `resetForSession()` from its own `session_start` handler — a reveal from a
 * previous session in the same process must not leak forward — keeping the
 * re-hide ordered with the rest of that handler's work (e.g. re-registering
 * tools before casting the disable votes).
 * - with `anchorToolName`, a `tool_result` handler reveals on the first
 *   successful (non-error) result from the anchor tool.
 * - callers with custom anchors (e.g. DAP's skill-read `tool_call`) call
 *   `revealOnce()` directly from their own handler and pass the triggering
 *   tool call's id so its result carries the in-band load marker.
 *
 * In-band reveal cache stability (`addedToolNames`):
 *
 * Besides enabling the tools (the top-level `params.tools` array changes —
 * fine for providers without native deferred-tool support), every reveal
 * stamps the triggering toolResult message with `addedToolNames`. Providers
 * with native deferred-tool loading (upstream `deferredToolsMode === "kimi"`)
 * use it as the load point: they keep the revealed tools OUT of the wire
 * `tools` array and instead deliver their schemas in-band right after the
 * stamped tool result, so the cacheable prefix never changes mid-session.
 * Providers without native support read no such field and behave exactly as
 * before. Stamps key on the tool call id of the call whose toolResult should
 * carry the marker — matched at `message_end`, which fires after execution
 * and before the next LLM request.
 */
export interface DeferredReveal {
	/**
	 * Reveal the tool group once; no-op after the first call or in workers.
	 *
	 * `stampToolCallId`: id of the tool call whose toolResult should carry the
	 * in-band `addedToolNames` marker. Omit only when no tool result is
	 * associated with the reveal — the group still becomes active, but the
	 * cache-stable in-band load point is lost for providers with native
	 * support.
	 */
	revealOnce(stampToolCallId?: string): void
	/** Re-hide the group for a fresh session (call from session_start). */
	resetForSession(): void
}

export interface DeferredRevealOptions {
	/** Anchor tool: reveal on its first successful (non-error) tool_result. */
	anchorToolName?: string
	/**
	 * When false, resetForSession() only resets the flag — the caller casts its
	 * own (possibly combined) disable vote. Defaults to true.
	 */
	hideOnReset?: boolean
}

/**
 * Tool name → reveal function of the deferred group that hides it. Lets the
 * not-found backstop (hidden-tool-guidance) reveal ONLY tools hidden by a
 * deferral — never tools inactive for another reason (platform gate, plan
 * mode, print gate) — and release the group's visibility vote so later
 * profile/visibility recomputes do not hide the tool again.
 */
const deferredGroups = new Map<string, () => readonly string[] | undefined>()

/**
 * Reveal the deferred group that contains `toolName`, if that group is still
 * hidden. Returns the revealed tool names, or undefined when the tool belongs
 * to no deferred group or its group was already revealed (so something else
 * is hiding it).
 */
export function revealDeferredTool(toolName: string): readonly string[] | undefined {
	return deferredGroups.get(toolName)?.()
}

export function createDeferredReveal(
	pi: ExtensionAPI,
	visibility: ToolVisibilityAPI,
	toolNames: readonly string[],
	opts: DeferredRevealOptions = {},
): DeferredReveal {
	let revealed = isAgentWorker()
	// toolCallId of a tool call whose toolResult must carry the in-band
	// reveal marker → names to stamp. Consumed at message_end.
	const pendingStamps = new Map<string, string[]>()

	if (opts.anchorToolName) {
		pi.on("tool_result", (event) => {
			if (event.isError || event.toolName !== opts.anchorToolName || revealed) return
			revealOnce(event.toolCallId)
		})
	}

	// Stamp the triggering tool result with the in-band reveal marker
	// (upstream `addedToolNames`; same replacement mechanism
	// hidden-tool-guidance uses). Consumed exactly once — later toolResults
	// with the same id (retries) carry nothing.
	pi.on("message_end", (event) => {
		const message = event.message
		if (message.role !== "toolResult") return
		const names = pendingStamps.get(message.toolCallId)
		if (!names) return
		pendingStamps.delete(message.toolCallId)
		return {
			message: {
				...message,
				addedToolNames: [...(message.addedToolNames ?? []), ...names],
			},
		}
	})

	for (const name of toolNames) {
		deferredGroups.set(name, () => {
			if (revealed || isAgentWorker()) return undefined
			revealOnce()
			return toolNames
		})
	}

	function revealOnce(stampToolCallId?: string): void {
		if (revealed || isAgentWorker()) return
		revealed = true
		visibility.enable(toolNames)
		if (stampToolCallId !== undefined) {
			const existing = pendingStamps.get(stampToolCallId) ?? []
			pendingStamps.set(stampToolCallId, [...new Set([...existing, ...toolNames])])
		}
	}

	return {
		revealOnce,
		resetForSession() {
			revealed = isAgentWorker()
			pendingStamps.clear()
			if (!revealed && opts.hideOnReset !== false) visibility.disable(toolNames)
		},
	}
}
