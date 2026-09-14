/**
 * Remote-run extension — everything is gated on `isRemoteRunEnabled()`
 * (KIMCHI_REMOTE_RUN opt-out). All remote-agent spawns go through the
 * shared `runCloudAgent()` helper, which handles the full lifecycle:
 * Ctrl+X kill handler, spawn, notification, and cleanup.
 *
 * Registers three surfaces:
 * - `/remote-run <prompt>` — run a raw prompt on a remote sandbox worker.
 * - `dispatch_to_cloud_agent` tool — model-callable dispatch of a
 *   self-contained task briefing to a background remote agent.
 * - remote-session trigger phrases (`remote-session-trigger.ts`) — prompts
 *   starting with a trigger phrase are confirmed, then transformed into
 *   rewrite instructions so the local model compacts conversation context
 *   and dispatches via the tool.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { getActiveManager } from "../agents/index.js"
import { DISPATCH_TO_CLOUD_AGENT_TOOL, registerDispatchToCloudAgentTool } from "./dispatch-tool.js"
import { buildRemoteSessionDispatchInstruction, parseRemoteSessionTrigger } from "./remote-session-trigger.js"
import { isRemoteRunEnabled, runCloudAgent } from "./runner.js"

export default function remoteRunExtension(pi: ExtensionAPI): void {
	if (!isRemoteRunEnabled()) return

	registerDispatchToCloudAgentTool(pi)

	// Prompt-based dispatch: trigger phrases (REMOTE_SESSION_TRIGGERS) with
	// an optional focus. After a confirm dialog, the prompt is transformed
	// into rewrite instructions — the local model compacts the conversation
	// context into a self-contained briefing and dispatches it via the tool
	// above.
	pi.on("input", async (event, ctx) => {
		// Only hijack fresh interactive submissions — mid-turn steers/follow-ups
		// and RPC/extension input pass through untouched.
		if (event.source !== "interactive" || event.streamingBehavior) return
		const trigger = parseRemoteSessionTrigger(event.text)
		if (!trigger) return
		// No UI → can't confirm; plan/ferment profiles swap the dispatch tool
		// out of the active set (plan mode already offers its own cloud option).
		if (!ctx.hasUI) return
		if (!pi.getActiveTools().includes(DISPATCH_TO_CLOUD_AGENT_TOOL)) return

		const focusLine = trigger.focus ? `\n\nFocus: ${trigger.focus}` : ""
		const confirmed = await ctx.ui.confirm(
			"Continue in remote session?",
			`Your task will be rewritten into a self-contained briefing from this conversation and executed by a cloud agent on a remote sandbox. Your local changes are synced to the sandbox, but the remote agent won't see this conversation's history.${focusLine}`,
		)
		if (!confirmed) {
			ctx.ui.notify("Staying in this session.", "info")
			return { action: "handled" as const }
		}
		return {
			action: "transform" as const,
			text: buildRemoteSessionDispatchInstruction(event.text, trigger.focus),
		}
	})

	pi.registerCommand("remote-run", {
		description: "Run a prompt on a remote sandbox worker via ACP: /remote-run <prompt>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const prompt = args.trim()
			if (!prompt) {
				ctx.ui.notify("Usage: /remote-run <prompt>", "warning")
				return
			}

			const description = `remote: ${prompt.slice(0, 60)}${prompt.length > 60 ? "..." : ""}`
			try {
				await runCloudAgent(pi, ctx, prompt, description, { background: true })
			} catch {
				// Error notification already handled inside runCloudAgent.
			}
		},
	})

	pi.on("session_shutdown", () => {
		// Abort any running remote agents (foreground or detached-to-background)
		// so the process can exit cleanly. Discovers agents via the manager
		// instead of module-level state, which would be unreliable if multiple
		// runs have overlapped.
		const manager = getActiveManager()
		if (manager) {
			for (const agent of manager.listAgents()) {
				if (agent.remote && (agent.status === "running" || agent.status === "error")) {
					manager.abort(agent.id)
				}
			}
		}
	})
}
