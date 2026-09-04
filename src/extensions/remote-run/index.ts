/**
 * Remote-run extension — registers the `/remote-run` command.
 *
 * Only registered when `KIMCHI_REMOTE_RUN` env var is set, preventing
 * accidental invocation. Spawns a foreground remote agent via the shared
 * `runCloudAgent()` helper, which handles the full lifecycle:
 * Ctrl+X kill handler, spawn, notification, and cleanup.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { getActiveManager } from "../agents/index.js"
import { runCloudAgent } from "./runner.js"

export default function remoteRunExtension(pi: ExtensionAPI): void {
	if (!process.env.KIMCHI_REMOTE_RUN) return

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
