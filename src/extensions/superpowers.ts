import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "./agent-worker-context.js"
import { buildSuperpowersBootstrap } from "./superpowers/bootstrap.js"
import { ensureSuperpowersInstalled } from "./superpowers/installer.js"

export default function superpowersExtension(pi: ExtensionAPI) {
	// Lazy install: runs once per session start. No-op if already installed.
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		try {
			const didInstall = await ensureSuperpowersInstalled()
			if (didInstall && ctx.hasUI) {
				ctx.ui.setStatus("superpowers", "✦ Superpowers skills installed")
			}
		} catch {
			// Best-effort — don't block harness launch if offline or GitHub unreachable
			if (ctx.hasUI) {
				ctx.ui.setStatus("superpowers", "Superpowers: could not download skills")
			}
		}
	})

	// Bootstrap injection: prepend using-superpowers + tool mapping to system prompt.
	// Skipped for subagents (they inherit skills from the parent session).
	pi.on("before_agent_start", async (event, _ctx: ExtensionContext) => {
		if (isAgentWorker()) return

		const bootstrap = buildSuperpowersBootstrap()
		if (!bootstrap) return

		return { systemPrompt: `${bootstrap}\n\n${event.systemPrompt}` }
	})
}
