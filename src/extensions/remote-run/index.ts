/**
 * Remote-run extension — registers the `/remote-run` command.
 *
 * Only registered when `KIMCHI_REMOTE_RUN` env var is set, preventing
 * accidental invocation. Spawns a foreground remote agent via the agents
 * extension's `spawnRemoteAgent()`, which creates an activity tracker +
 * output file + widget registration — same rendering as local agents
 * (tool count, streaming text, turn count, usage).
 *
 * The agent runs in foreground mode (isBackground: false), so the command
 * blocks until the agent settles and returns its result text. A Ctrl+X
 * handler is registered for the duration of the run to kill the remote
 * agent (the existing Ctrl+X handler in agents/index.ts only covers
 * background agents).
 *
 * The agent id is passed via `onSpawn` as soon as the agent is created
 * (before the promise resolves), so the Ctrl+X handler can cancel the
 * remote agent even during the startup phase (auth, sandbox readiness,
 * session creation).
 *
 * If the user detaches the foreground agent to background via Ctrl+B,
 * the promise resolves and this handler cleans up. The existing background
 * Ctrl+X handler in agents/index.ts then takes over. Each invocation owns
 * its own agent id and kill handler in the closure — no module-level mutable
 * state — so overlapping invocations (e.g. after a Ctrl+B detach) cannot
 * clobber each other.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui"
import { getActiveManager, spawnRemoteAgent } from "../agents/index.js"
import { getDisplayName } from "../agents/ui/agent-widget.js"
import { isRawInputCaptureActive } from "../shared-input.js"

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

			// Per-invocation agent id — set via onSpawn before the promise resolves.
			// Kept in the closure so concurrent invocations (e.g. after a Ctrl+B
			// detach) cannot overwrite each other's state.
			let agentId: string | undefined

			const killUnsub = ctx.ui.onTerminalInput((data) => {
				if (isRawInputCaptureActive()) return undefined
				if (!matchesKey(data, Key.ctrl("x")) || isKeyRelease(data)) return undefined
				if (!agentId) return undefined

				const manager = getActiveManager()
				const target = manager?.getRecord(agentId)
				if (!target || !manager) return undefined
				if (target.status !== "running" && target.status !== "error") return undefined

				manager.abort(agentId)
				ctx.ui.notify(`Stopped ${getDisplayName(target.type)} agent`, "info")
				return { consume: true }
			})

			const description = `remote: ${prompt.slice(0, 60)}${prompt.length > 60 ? "..." : ""}`
			try {
				const { result } = await spawnRemoteAgent(pi, ctx, prompt, description, {
					onSpawn: (id) => {
						agentId = id
					},
				})

				const preview = result.length > 500 ? `${result.slice(0, 500)}...` : result
				ctx.ui.notify(preview || "Remote agent completed with no output.", "info")
			} catch (err) {
				ctx.ui.notify(`Remote run failed: ${err instanceof Error ? err.message : String(err)}`, "error")
			} finally {
				killUnsub()
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
