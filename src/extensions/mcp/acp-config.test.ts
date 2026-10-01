import type { McpServer } from "@agentclientprotocol/sdk"
import { describe, expect, it } from "vitest"
import { convertAcpMcpServer, convertAcpMcpServers } from "./acp-config.js"

describe("ACP MCP configuration", () => {
	it("converts stdio environment entries", () => {
		const server: McpServer = {
			name: "filesystem",
			command: "/path/to/server",
			args: ["--stdio"],
			env: [{ name: "TOKEN", value: "secret" }],
		}
		expect(convertAcpMcpServer(server)).toEqual({
			command: "/path/to/server",
			args: ["--stdio"],
			env: { TOKEN: "secret" },
		})
	})

	it("converts HTTP headers", () => {
		const server: McpServer = {
			name: "remote",
			type: "http",
			url: "https://example.test/mcp",
			headers: [{ name: "Authorization", value: "Bearer secret" }],
		}
		expect(convertAcpMcpServer(server)).toEqual({
			url: "https://example.test/mcp",
			headers: { Authorization: "Bearer secret" },
		})
	})

	it("rejects the unadvertised SSE transport", () => {
		const server: McpServer = { name: "events", type: "sse", url: "https://example.test/sse", headers: [] }
		expect(() => convertAcpMcpServer(server)).toThrow("SSE transport is not supported")
	})

	it("uses the last duplicate name", () => {
		const servers: McpServer[] = [
			{ name: "duplicate", command: "first", args: [], env: [] },
			{ name: "duplicate", command: "second", args: [], env: [] },
		]
		expect(convertAcpMcpServers(servers)).toEqual({ duplicate: { command: "second", args: [] } })
	})
})
