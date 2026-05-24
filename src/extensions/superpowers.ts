import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "./agent-worker-context.js"
import { buildSuperpowersBootstrap } from "./superpowers/bootstrap.js"

export default function superpowersExtension(pi: ExtensionAPI) {
	// Bootstrap injection: prepend using-superpowers + tool mapping to system prompt.
	// Skipped for subagents (they inherit skills from the parent session).
	pi.on("before_agent_start", async (event, _ctx: ExtensionContext) => {
		if (isAgentWorker()) return

		const bootstrap = buildSuperpowersBootstrap()
		if (!bootstrap) return

		return { systemPrompt: `${bootstrap}\n\n${event.systemPrompt}` }
	})
}
