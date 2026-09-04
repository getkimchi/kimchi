import type { McpServer } from "@agentclientprotocol/sdk"
import type { ServerEntry } from "./types.js"

/**
 * Convert an ACP `McpServer` `EnvVariable[]` (array of `{name, value}`) to the
 * `Record<string, string>` shape that `ServerEntry.env` expects.
 */
function envArrayToRecord(
	env: ReadonlyArray<{ name: string; value: string }> | undefined,
): Record<string, string> | undefined {
	if (!env || env.length === 0) return undefined
	const result: Record<string, string> = {}
	for (const { name, value } of env) {
		result[name] = value
	}
	return result
}

/**
 * Convert an ACP `HttpHeader[]` (array of `{name, value}`) to the
 * `Record<string, string>` shape that `ServerEntry.headers` expects.
 */
function headersArrayToRecord(
	headers: ReadonlyArray<{ name: string; value: string }> | undefined,
): Record<string, string> | undefined {
	if (!headers || headers.length === 0) return undefined
	const result: Record<string, string> = {}
	for (const { name, value } of headers) {
		result[name] = value
	}
	return result
}

/**
 * Convert a single ACP `McpServer` (stdio / http / sse variant) to the
 * Kimchi-internal `ServerEntry` shape.
 *
 * The ACP SDK uses a tagged union with an optional `type` discriminator
 * (absent = stdio, "http" = http, "sse" = sse). `ServerEntry` uses the presence
 * of `command` (stdio) vs `url` (http/sse) to distinguish transports.
 */
export function convertAcpMcpServer(server: McpServer): ServerEntry {
	// Capture the name early for error messages — don't use JSON.stringify
	// on the server object as env/headers may contain secrets.
	const name = server.name

	// Stdio: no `type` field, has `command`
	if ("command" in server) {
		const entry: ServerEntry = {
			command: server.command,
			args: server.args,
		}
		const env = envArrayToRecord(server.env)
		if (env) entry.env = env
		return entry
	}

	// SSE: we don't advertise sse support in mcpCapabilities, so reject.
	if ("type" in server && server.type === "sse") {
		throw new Error(`SSE transport is not supported for server "${name}"`)
	}

	// HTTP: `type === "http"`
	if ("url" in server) {
		const entry: ServerEntry = {
			url: server.url,
		}
		const headers = headersArrayToRecord(server.headers)
		if (headers) entry.headers = headers
		return entry
	}

	// Should not happen with a well-formed ACP McpServer, but guard anyway.
	throw new Error(`Unrecognized ACP McpServer shape for server "${name}"`)
}

/**
 * Convert an array of ACP `McpServer` entries to a `Record<string, ServerEntry>`
 * keyed by server `name`. Caller-supplied servers are merged into the MCP
 * adapter's server set alongside config-sourced servers.
 *
 * Duplicate names: last-wins (matches `Object.fromEntries` semantics).
 */
export function convertAcpMcpServers(servers: ReadonlyArray<McpServer>): Record<string, ServerEntry> {
	const result: Record<string, ServerEntry> = {}
	for (const server of servers) {
		result[server.name] = convertAcpMcpServer(server)
	}
	return result
}
