import type { McpServer } from "@agentclientprotocol/sdk"
import { describe, expect, it } from "vitest"
import { convertAcpMcpServer, convertAcpMcpServers } from "./acp-mcp-convert.js"

describe("convertAcpMcpServer", () => {
	describe("stdio transport", () => {
		it("converts a stdio server with command, args, and env", () => {
			const server: McpServer = {
				name: "filesystem",
				command: "/path/to/mcp-server",
				args: ["--stdio"],
				env: [{ name: "API_KEY", value: "secret123" }],
			}
			const entry = convertAcpMcpServer(server)
			expect(entry).toEqual({
				command: "/path/to/mcp-server",
				args: ["--stdio"],
				env: { API_KEY: "secret123" },
				lifecycle: "eager",
				directTools: true,
			})
		})

		it("converts a stdio server with empty env array (omits env key)", () => {
			const server: McpServer = {
				name: "simple",
				command: "node",
				args: ["server.js"],
				env: [],
			}
			const entry = convertAcpMcpServer(server)
			expect(entry).toEqual({
				command: "node",
				args: ["server.js"],
				lifecycle: "eager",
				directTools: true,
			})
			expect(entry.env).toBeUndefined()
		})

		it("converts a stdio server with multiple env vars", () => {
			const server: McpServer = {
				name: "multi-env",
				command: "run",
				args: [],
				env: [
					{ name: "FOO", value: "bar" },
					{ name: "BAZ", value: "qux" },
				],
			}
			const entry = convertAcpMcpServer(server)
			expect(entry.env).toEqual({ FOO: "bar", BAZ: "qux" })
		})
	})

	describe("http transport", () => {
		it("converts an http server with url and headers", () => {
			const server: McpServer = {
				name: "api-server",
				type: "http",
				url: "https://api.example.com/mcp",
				headers: [
					{ name: "Authorization", value: "Bearer token123" },
					{ name: "Content-Type", value: "application/json" },
				],
			}
			const entry = convertAcpMcpServer(server)
			expect(entry).toEqual({
				url: "https://api.example.com/mcp",
				headers: {
					Authorization: "Bearer token123",
					"Content-Type": "application/json",
				},
				lifecycle: "eager",
				directTools: true,
			})
		})

		it("converts an http server without headers (omits headers key)", () => {
			const server: McpServer = {
				name: "no-headers",
				type: "http",
				url: "https://api.example.com/mcp",
				headers: [],
			}
			const entry = convertAcpMcpServer(server)
			expect(entry).toEqual({
				url: "https://api.example.com/mcp",
				lifecycle: "eager",
				directTools: true,
			})
			expect(entry.headers).toBeUndefined()
		})
	})

	describe("sse transport", () => {
		it("rejects SSE servers since sse is not advertised in mcpCapabilities", () => {
			const server: McpServer = {
				name: "event-stream",
				type: "sse",
				url: "https://events.example.com/mcp",
				headers: [{ name: "X-API-Key", value: "apikey456" }],
			}
			expect(() => convertAcpMcpServer(server)).toThrow(/SSE transport is not supported/)
		})
	})

	it("throws on unrecognized server shape", () => {
		const malformed = { name: "bad" } as unknown as McpServer
		expect(() => convertAcpMcpServer(malformed)).toThrow(/Unrecognized ACP McpServer shape for server "bad"/)
	})
})

describe("convertAcpMcpServers", () => {
	it("returns empty record for empty array", () => {
		expect(convertAcpMcpServers([])).toEqual({})
	})

	it("converts a single stdio server", () => {
		const servers: McpServer[] = [{ name: "fs", command: "/path", args: ["--stdio"], env: [] }]
		const result = convertAcpMcpServers(servers)
		expect(result).toEqual({
			fs: { command: "/path", args: ["--stdio"], lifecycle: "eager", directTools: true },
		})
	})

	it("converts mixed stdio and http servers", () => {
		const servers: McpServer[] = [
			{ name: "fs", command: "/path", args: [], env: [] },
			{ name: "api", type: "http", url: "https://api.example.com", headers: [] },
		]
		const result = convertAcpMcpServers(servers)
		expect(Object.keys(result).sort()).toEqual(["api", "fs"])
		expect(result.fs).toEqual({ command: "/path", args: [], lifecycle: "eager", directTools: true })
		expect(result.api).toEqual({ url: "https://api.example.com", lifecycle: "eager", directTools: true })
	})
})
