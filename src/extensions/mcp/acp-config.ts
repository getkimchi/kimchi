import type { McpServer } from "@agentclientprotocol/sdk"
import type { ServerEntry } from "pi-mcp-adapter/types"

function entriesToRecord(
	entries: ReadonlyArray<{ name: string; value: string }> | undefined,
): Record<string, string> | undefined {
	if (!entries || entries.length === 0) return undefined
	return Object.fromEntries(entries.map(({ name, value }) => [name, value]))
}

export function convertAcpMcpServer(server: McpServer): ServerEntry {
	const name = server.name
	if ("command" in server) {
		const env = entriesToRecord(server.env)
		return {
			command: server.command,
			args: server.args,
			...(env ? { env } : {}),
		}
	}

	if ("type" in server && server.type === "sse") {
		throw new Error(`SSE transport is not supported for server "${name}"`)
	}

	if ("url" in server) {
		const headers = entriesToRecord(server.headers)
		return {
			url: server.url,
			...(headers ? { headers } : {}),
		}
	}

	throw new Error(`Unrecognized ACP McpServer shape for server "${name}"`)
}

export function convertAcpMcpServers(servers: ReadonlyArray<McpServer>): Record<string, ServerEntry> {
	return Object.fromEntries(servers.map((server) => [server.name, convertAcpMcpServer(server)]))
}
