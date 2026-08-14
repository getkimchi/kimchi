// ACP extension method handlers for MCP-related operations.
//
// Extracted from server.ts so the agent class stays focused on session
// management. Each handler is a standalone async function that receives
// the dependencies it needs (manager, params) and returns a plain record
// suitable for the ACP wire.

import { randomUUID } from "node:crypto"
import { RequestError } from "@agentclientprotocol/sdk"
import { getAuthEntry, removeAuthEntry } from "../../../extensions/mcp-adapter/mcp-auth.js"
import { authenticate, getAuthStatus, supportsOAuth } from "../../../extensions/mcp-adapter/mcp-auth-flow.js"
import type { McpServerManager } from "../../../extensions/mcp-adapter/server-manager.js"
import type { ProbeResult, ServerEntry } from "../../../extensions/mcp-adapter/types.js"

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
	mcpServerManager: McpServerManager | undefined,
	params: Record<string, unknown>,
): Promise<ProbeResult> {
	if (!mcpServerManager) {
		throw RequestError.invalidParams(undefined, "MCP server manager is not available")
	}
	const server = validateServerEntry(params.server)
	// serverName is passed separately from the ServerEntry because ServerEntry
	// itself has no name field — the name is the config key under
	// `mcpServers` in the user's config. Desktop knows the key it's probing;
	// we default to "probe" for ad-hoc calls.
	const serverName = (params.serverName as string | undefined) ?? "probe"

	// Resolve the OAuth token-store key. If an auth entry already exists
	// under `serverName` for a *different* URL (e.g. the user edited the
	// URL but kept the name), use a throwaway name so the real server's
	// stored tokens are never overwritten. See `resolveProbeName` below.
	const probeName = resolveProbeName(serverName, server)
	const usedThrowaway = probeName !== serverName

	try {
		// For OAuth-capable URL servers, authenticate FIRST before probing.
		// probeTools creates its own transport internally, which triggers the
		// SDK's auth flow — if it runs before authenticate(), the state gets
		// overwritten and the callback fails. By authenticating first, the
		// stored tokens are available when probeTools connects, so it skips
		// auth entirely.
		if (supportsOAuth(server) && server.url) {
			const authStatus = await getAuthStatus(probeName, server.url)
			if (authStatus !== "authenticated") {
				try {
					await authenticate(probeName, server.url, server)
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err)
					return { tools: [], needsAuth: true, error: message }
				}
			}
		}

		return await mcpServerManager.probeTools(probeName, server)
	} finally {
		// Clean up throwaway probe credentials so the token store never
		// accumulates `__probe_*` entries.
		if (usedThrowaway) {
			removeAuthEntry(probeName)
		}
	}
}

/**
 * Decide which name to use as the OAuth token-store key during a probe.
 *
 * If an auth entry already exists under `name` for a *different* URL —
 * e.g. the user edited the server's URL but kept the name — fall back to
 * a throwaway `__probe_*` name so the real server's tokens are never
 * overwritten. When no entry exists (new server) or the URL matches
 * (repeat probe), the real name is used so stored tokens are found.
 */
function resolveProbeName(name: string, definition: ServerEntry): string {
	const existing = getAuthEntry(name)
	if (!existing) return name
	if (existing.serverUrl === definition.url) return name
	return `__probe_${randomUUID()}`
}
