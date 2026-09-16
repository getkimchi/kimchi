/**
 * Remote-run extension — registers the `/remote-run` command.
 *
 * Registered by default; disabled only when `KIMCHI_REMOTE_RUN` is set to an
 * explicit falsy value ("0" or "false"). Spawns a background remote agent via the shared
 * `runCloudAgent()` helper, which handles the full lifecycle:
 * Ctrl+X kill handler, spawn, notification, and cleanup.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { getActiveManager } from "../agents/index.js"
import { REMOTE_DIFF_ENTRY_TYPE, renderRemoteRunDiff } from "./diff-entry.js"
import { handleRemoteCompletion } from "./post-completion.js"
import { isRemoteRunEnabled, runCloudAgent } from "./runner.js"

/**
 * TUI-E2E seam (KIMCHI_E2E_FAKE_REMOTE_COMPLETION=1): fires a deterministic
 * PR-intent completion shortly after session start so the TUI E2E drives the
 * REAL completion machinery — diff stats, dropdown, consent gates, push
 * orchestration — without depending on session-resume discovery (unreliable
 * across hosts) or a fake remote worker (unimplementable in scope). Pairs
 * with KIMCHI_E2E_FAKE_SANDBOX_GIT for canned git responses. Test-only env
 * vars; never set in production.
 */
function maybeFireFakeCompletion(pi: ExtensionAPI): void {
	if (process.env.KIMCHI_E2E_FAKE_REMOTE_COMPLETION !== "1") return
	pi.on("session_start", (_event, ctx) => {
		setTimeout(() => {
			if (!ctx.hasUI) return
			void handleRemoteCompletion(pi, ctx, "E2E fake remote result line one", "plan", {
				transcriptPath: undefined,
				agentId: "e2e-remote-agent",
				remoteSession: {
					workspaceId: "ws-e2e",
					sessionName: "acp-e2e",
					wsUrl: "ws://e2e.fake",
					host: "e2e.fake",
					cwd: "/home/sandbox/acp-e2e",
				},
				acpSessionId: "acp-e2e",
				gitWorkflow: {
					branch: "kimchi/e2e-fix-login",
					baseBranch: "main",
					baseSha: "a".repeat(40),
				},
			}).catch(() => {})
		}, 1_500)
	})
}

export default function remoteRunExtension(pi: ExtensionAPI): void {
	if (!isRemoteRunEnabled()) return

	maybeFireFakeCompletion(pi)

	// Persisted diff review: appended at Show-diff time, survives the overlay
	// closing (and transcript reloads — the renderer is pure).
	pi.registerEntryRenderer(REMOTE_DIFF_ENTRY_TYPE, renderRemoteRunDiff)

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
