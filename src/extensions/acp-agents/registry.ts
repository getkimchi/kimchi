/**
 * registry.ts — ACP agent type registry refresh.
 *
 * Discovers configured ACP agent servers (project `.kimchi/acp-agents.json`
 * overriding global `getAgentDir()/acp-agents.json`) and refreshes the
 * `acp:<name>` entries in the unified agent registry.
 *
 * Kept free of imports from the agents extension so the Agent tool's
 * per-execute reload can call it without a module cycle. Refresh parity with
 * `.kimchi/agents/*.md`: custom agents reload from disk on every Agent-tool
 * execute, so ACP servers must too — otherwise a server configured after
 * session start is unreachable until restart (found in live validation).
 *
 * No-ops when the experimental-features flag is off: with the flag off no
 * `acp:` types may exist, so there is nothing to refresh.
 */

import { isResourceEnabled } from "../../resources/store.js"
import { setAcpAgents } from "../agents/personas/agent-types.js"
import type { AgentConfig } from "../agents/personas/types.js"
import { isExperimentalFeaturesEnabled } from "../experimental.js"
import { ACP_TYPE_PREFIX, acpServerFromType, acpTypeName, loadAcpAgentServers } from "./config.js"

export const ACP_AGENTS_RESOURCE_ID = "extensions.acp-agents" as const

/** True when the ACP feature is enabled via either gate: the
 *  --enable-experimental-features CLI flag or the /resources
 *  experimental tab toggle (persisted, restart required). */
export function isAcpAgentsEnabled(): boolean {
	return isExperimentalFeaturesEnabled() || isResourceEnabled(ACP_AGENTS_RESOURCE_ID)
}

/** Build the registry AgentConfig for an ACP agent server. */
function toAgentConfig(name: string, displayName: string | undefined, transport: string): AgentConfig {
	return {
		name: acpTypeName(name),
		displayName: displayName ?? name,
		description:
			`External ACP agent "${name}" (${transport}). Runs out-of-process with its own model and ` +
			"tools; spawn it like any subagent. When spawned with communication enabled it joins the " +
			"host-mediated coordination board and agent messaging.",
		// The external agent brings its own tools — none of ours are injected.
		builtinToolNames: [],
		extensions: false,
		skills: false,
		// The external agent has its own system prompt; this field is unused on
		// the ACP spawn path (the record never reaches runAgent).
		systemPrompt: "",
		promptMode: "replace",
		enabled: true,
		source: "acp",
	}
}

/**
 * (Re)discover ACP config and refresh the registry's ACP entries. Callers
 * must re-run `registerAgents(...)` afterwards for the merged registry to see
 * the new entries (setAcpAgents only updates the module-level ACP map).
 * No-ops when neither gate is enabled (CLI flag or resource toggle).
 */
export function refreshAcpAgents(cwd: string): Map<string, AgentConfig> {
	if (!isAcpAgentsEnabled()) return new Map()
	const servers = loadAcpAgentServers(cwd)
	const map = new Map<string, AgentConfig>()
	for (const server of servers.values()) {
		map.set(acpTypeName(server.name), toAgentConfig(server.name, server.displayName, server.transport))
	}
	setAcpAgents(map)
	return map
}

export type AcpSpawnPlan = { server: string } | { error: string }

/** Resolve the ACP spawn plan for an Agent-tool call: which external server to
 *  use, a user-facing error, or undefined when the call is not an ACP spawn.
 *  Keeps all ACP spawn decisions inside the acp-agents module — the agents
 *  extension only consumes this plan. */
export function planAcpSpawn(input: {
	rawType: string
	resolvedType?: string
	configSource?: string
	inheritContext?: boolean
	taskRef?: boolean
	isolated?: boolean
}): AcpSpawnPlan | undefined {
	const server = input.configSource === "acp" ? acpServerFromType(input.resolvedType ?? "") : undefined
	if (input.rawType.startsWith(ACP_TYPE_PREFIX) && input.resolvedType === undefined) {
		return {
			error: `No ACP agent server "${input.rawType.slice(ACP_TYPE_PREFIX.length)}" is configured. Check .kimchi/acp-agents.json or run /acp.`,
		}
	}
	if (server) {
		const unsupported: string[] = []
		if (input.inheritContext) unsupported.push("inherit_context")
		if (input.taskRef) unsupported.push("task_ref")
		if (input.isolated) unsupported.push("isolated")
		if (unsupported.length > 0) {
			return { error: `ACP agents do not support: ${unsupported.join(", ")}.` }
		}
	}
	return server ? { server } : undefined
}
