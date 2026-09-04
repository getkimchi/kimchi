// ACP extension method handlers for MCP-related operations.
//
// Extracted from server.ts so the agent class stays focused on session
// management. Each handler is a standalone async function that receives
// the dependencies it needs (manager, params) and returns a plain record
// suitable for the ACP wire.

import { RequestError } from "@agentclientprotocol/sdk"
import type { ServerEntry } from "pi-mcp-adapter/types"
import type { McpProbe, ProbeResult } from "../../../extensions/mcp/probe.js"

/**
 * Runtime validation for ServerEntry received over the ACP wire.
 *
 * The `_kimchi.dev/probe_mcp_server` extMethod can be invoked by any ACP
 * client. Since ServerEntry can describe an arbitrary stdio command (command,
 * args, env, cwd) or HTTP endpoint, we must validate the shape before passing
 * it to McpServerManager.probeTools — otherwise a malicious client could
 * spawn processes with attacker-controlled arguments.
 *
 * This is a structural type guard, not a security policy: the ACP
 * connection is already a trusted channel (the client is the IDE that
 * launched the agent). The guard prevents accidental misuse and malformed
 * payloads, not adversarial code execution.
 */
export function validateServerEntry(raw: unknown): ServerEntry {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw RequestError.invalidParams(undefined, "'server' must be an object")
	}
	const obj = raw as Record<string, unknown>

	// Must have exactly one of command or url
	const hasCommand = typeof obj.command === "string" && obj.command.length > 0
	const hasUrl = typeof obj.url === "string" && obj.url.length > 0
	if (!hasCommand && !hasUrl) {
		throw RequestError.invalidParams(undefined, "'server' must have a 'command' or 'url' field")
	}

	// Validate types of optional fields that probeTools/createTransport reads
	if (obj.args !== undefined && !Array.isArray(obj.args)) {
		throw RequestError.invalidParams(undefined, "'server.args' must be an array")
	}
	if (Array.isArray(obj.args)) {
		for (const a of obj.args) {
			if (typeof a !== "string") {
				throw RequestError.invalidParams(undefined, "'server.args' must be an array of strings")
			}
		}
	}
	if (obj.env !== undefined && (typeof obj.env !== "object" || obj.env === null)) {
		throw RequestError.invalidParams(undefined, "'server.env' must be an object")
	}
	if (obj.env !== undefined) {
		for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
			if (typeof v !== "string") {
				throw RequestError.invalidParams(undefined, `server.env['${k}'] must be a string`)
			}
		}
	}
	if (obj.cwd !== undefined && typeof obj.cwd !== "string") {
		throw RequestError.invalidParams(undefined, "'server.cwd' must be a string")
	}
	if (obj.headers !== undefined && (typeof obj.headers !== "object" || obj.headers === null)) {
		throw RequestError.invalidParams(undefined, "'server.headers' must be an object")
	}
	if (obj.auth !== undefined && obj.auth !== "oauth" && obj.auth !== "bearer" && obj.auth !== false) {
		throw RequestError.invalidParams(undefined, "'server.auth' must be 'oauth', 'bearer', or false")
	}
	if (obj.debug !== undefined && typeof obj.debug !== "boolean") {
		throw RequestError.invalidParams(undefined, "'server.debug' must be a boolean")
	}

	return obj as ServerEntry
}

/**
 * Handler for the `_kimchi.dev/probe_mcp_server` ACP extension method.
 *
 * Validates the incoming ServerEntry, delegates to McpServerManager.probeTools()
 * (which creates a transient connection, calls tools/list, handles OAuth, and
 * cleans up), and returns the probe result.
 *
 * This extMethod executes external binaries (stdio servers) or makes network
 * requests (HTTP servers) based on the ServerEntry provided by the client.
 */
export async function handleProbeMcpServer(
	mcpProbe: McpProbe | undefined,
	params: Record<string, unknown>,
): Promise<ProbeResult> {
	if (!mcpProbe) {
		throw RequestError.invalidParams(undefined, "MCP probe is not available")
	}
	const server = validateServerEntry(params.server)
	const serverName = (params.serverName as string | undefined) ?? "probe"
	return mcpProbe.probeTools(serverName, server, { authenticate: params.skipAuth !== true })
}
