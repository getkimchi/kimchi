/**
 * acp-agents — EXPERIMENTAL: ACP external agents as subagent-plane nodes.
 *
 * Registers configured ACP agent servers (`.kimchi/acp-agents.json` project /
 * `getAgentDir()/acp-agents.json` global) as `acp:<name>` subagent types in
 * the unified agent registry, so the Agent tool can spawn them like any
 * subagent. The external agent runs out-of-process over ACP (stdio or ws)
 * with its own model and tools, appears in the TUI subagent tree, and joins
 * host-mediated communication (coordination board + messaging) through
 * host-authorized MCP tools.
 *
 * Gated behind --enable-experimental-features or the /resources experimental
 * tab toggle (extensions.acp-agents, restart required). cli.ts only
 * includes this factory when either gate is on, so with both off there are
 * no `acp:` types, no /acp command, and no runner.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getActiveManager } from "../agents/index.js"
import { runAcpAgent } from "./acp-runner.js"
import { getAgentCommsIpc } from "./comms-ipc.js"
import { acpTypeName, globalConfigPath, loadAcpAgentServers } from "./config.js"
import { isAcpAgentsEnabled, refreshAcpAgents } from "./registry.js"

export { refreshAcpAgents } from "./registry.js"

export default function acpAgentsExtension(pi: ExtensionAPI): void {
	if (!isAcpAgentsEnabled()) return

	// Initial discovery from the launch cwd — must happen before the agents
	// extension registers the Agent tool, whose subagent_type description is
	// built once at registerTool time from getAvailableTypes().
	refreshAcpAgents(process.cwd())

	// Re-discover on every session start (a session may start in a different
	// cwd). Registered before the agents extension's own session_start
	// handler, so the merged registry is fresh when reloadCustomAgents runs.
	pi.on("session_start", (_event, ctx) => {
		refreshAcpAgents(ctx.cwd)
	})

	// Wire the ACP runner into the subagent manager. The agents extension
	// creates its AgentManager during factory init and then emits
	// "subagents:ready"; this listener is registered first (factory order in
	// cli.ts), so it is in place before the event fires.
	pi.events.on("subagents:ready", () => {
		const manager = getActiveManager()
		if (!manager) return
		manager.setAcpRunner(runAcpAgent)
		// Comms token revocation is manager-owned: synchronous with the terminal
		// status transition so a terminal external agent cannot post during the
		// race window.
		manager.setCommsTokenRevoker((agentId) => getAgentCommsIpc().revokeAgent(agentId))
	})

	// The singleton comms IPC socket dies with the host session.
	pi.on("session_shutdown", () => {
		getAgentCommsIpc().stop()
	})

	pi.registerCommand("acp", {
		description: "List configured ACP agent servers (experimental)",
		handler: async (_args, ctx) => {
			const servers = [...loadAcpAgentServers(ctx.cwd).values()]
			if (servers.length === 0) {
				ctx.ui.notify(
					"No ACP agent servers configured. Add agent_servers to .kimchi/acp-agents.json (project) or " +
						`${globalConfigPath()} (global).`,
					"info",
				)
				return
			}
			const lines = servers.map((s) => {
				const detail = s.transport === "stdio" ? [s.command, ...(s.args ?? [])].join(" ") : s.url
				return `${acpTypeName(s.name)} — ${s.displayName ?? s.name} [${s.transport}] ${detail ?? ""}`.trimEnd()
			})
			ctx.ui.notify(lines.join("\n"), "info")
		},
	})
}
