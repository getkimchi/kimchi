/**
 * Remote-run extension — everything is gated on `isRemoteRunEnabled()`
 * (KIMCHI_REMOTE_RUN opt-out). The dispatch tool is additionally
 * suppressed in every `--print` run (ferment-oneshot included — no lift).
 * Two reasons: headless sessions have no human to answer the consent
 * dialog, making the tool dead — and adversarially inviting — prompt
 * surface; and remote dispatch is a quality-of-life feature for
 * supervised, user-led sessions — an unsupervised agent should never
 * spend remote compute on its own initiative. The
 * `/remote-run` command and shutdown handler register regardless; the
 * command is simply unreachable without a TUI. All remote-agent spawns go
 * through the shared `runCloudAgent()` helper, which handles the full
 * lifecycle: Ctrl+X kill handler, spawn, notification, and cleanup.
 *
 * Registers two surfaces:
 * - `/remote-run <prompt>` — run a raw prompt on a remote sandbox worker.
 * - `dispatch_to_cloud_agent` tool — model-callable dispatch of a
 *   self-contained task briefing to a background remote agent. Consent is
 *   enforced inside the tool: the user must confirm a dialog (showing the
 *   briefing) before anything is spawned, so model initiative — including
 *   indirect prompt injection — can never launch remote compute on its own.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { getActiveManager } from "../agents/index.js"
import { shouldSuppressInteractiveTools } from "../print-mode.js"
import { registerDispatchToCloudAgentTool } from "./dispatch-tool.js"
import { isRemoteRunEnabled, runCloudAgent } from "./runner.js"

export default function remoteRunExtension(pi: ExtensionAPI): void {
	if (!isRemoteRunEnabled()) return

	// Headless --print runs have no human for the consent dialog, and
	// dispatch is a supervised, user-led convenience an unsupervised agent
	// should never trigger — the tool could only ever fail with no_ui, so
	// don't register it at all. The execute-time hasUI check inside the tool stays as
	// defense-in-depth for UI-less sessions under interactive launches
	// (e.g. subagent workers).
	if (!shouldSuppressInteractiveTools()) {
		registerDispatchToCloudAgentTool(pi)
	}

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
