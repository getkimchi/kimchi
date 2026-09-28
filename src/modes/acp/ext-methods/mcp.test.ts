import type { ServerEntry } from "pi-mcp-adapter/types"
import { describe, expect, it, vi } from "vitest"
import type { McpProbe, ProbeResult } from "../../../extensions/mcp/probe.js"
import { handleProbeMcpServer, validateServerEntry } from "./mcp.js"

function createProbe(result: ProbeResult): McpProbe {
	return { probeTools: vi.fn().mockResolvedValue(result) }
}

describe("validateServerEntry", () => {
	it("accepts validated stdio and HTTP definitions", () => {
		expect(validateServerEntry({ command: "node", args: ["server.js"], env: { TOKEN: "value" } })).toEqual({
			command: "node",
			args: ["server.js"],
			env: { TOKEN: "value" },
		})
		expect(
			validateServerEntry({ url: "https://example.test/mcp", headers: { Authorization: "Bearer value" } }),
		).toEqual({
			url: "https://example.test/mcp",
			headers: { Authorization: "Bearer value" },
		})
	})

	it.each([null, undefined, "string", 123, []])("rejects non-object definition %j", (server) => {
		expect(() => validateServerEntry(server)).toThrow(expect.objectContaining({ code: -32602 }))
	})

	it("rejects missing transports and malformed optional fields", () => {
		expect(() => validateServerEntry({})).toThrow("must have a 'command' or 'url' field")
		expect(() => validateServerEntry({ command: "node", args: [123] })).toThrow("array of strings")
		expect(() => validateServerEntry({ command: "node", env: { TOKEN: 123 } })).toThrow("must be a string")
		expect(() => validateServerEntry({ url: "https://example.test", headers: "bad" })).toThrow(
			"'server.headers' must be an object",
		)
		expect(() => validateServerEntry({ url: "https://example.test", auth: "basic" })).toThrow(
			"must be 'oauth', 'bearer', or false",
		)
	})
})

describe("handleProbeMcpServer", () => {
	const server: ServerEntry = { command: "node", args: ["server.js"] }
	const result: ProbeResult = {
		tools: [{ name: "read_file", description: "Read a file" }],
		needsAuth: false,
		error: null,
	}

	it("delegates to the isolated probe with authentication enabled", async () => {
		const probe = createProbe(result)
		expect(await handleProbeMcpServer(probe, { server, serverName: "fixture" })).toEqual(result)
		expect(probe.probeTools).toHaveBeenCalledWith("fixture", server, { authenticate: true })
	})

	it("supports auth-free discovery and the default probe name", async () => {
		const probe = createProbe(result)
		await handleProbeMcpServer(probe, { server, skipAuth: true })
		expect(probe.probeTools).toHaveBeenCalledWith("probe", server, { authenticate: false })
	})

	it("rejects unavailable probes and missing server parameters", async () => {
		await expect(handleProbeMcpServer(undefined, { server })).rejects.toThrow("MCP probe is not available")
		await expect(handleProbeMcpServer(createProbe(result), {})).rejects.toMatchObject({ code: -32602 })
	})
})
