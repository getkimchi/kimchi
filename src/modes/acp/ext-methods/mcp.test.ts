import { beforeEach, describe, expect, it, vi } from "vitest"
import type { McpServerManager } from "../../../extensions/mcp-adapter/server-manager.js"
import type { ProbeResult, ServerEntry } from "../../../extensions/mcp-adapter/types.js"
import { handleProbeMcpServer, validateServerEntry } from "./mcp.js"

const mockGetAuthEntry = vi.fn()
const mockRemoveAuthEntry = vi.fn()
const mockAuthenticate = vi.fn()
const mockGetAuthStatus = vi.fn()
const mockSupportsOAuth = vi.fn()
const mockProbeTools = vi.fn()

vi.mock("../../../extensions/mcp-adapter/mcp-auth.js", () => ({
	getAuthEntry: (...args: unknown[]) => mockGetAuthEntry(...args),
	removeAuthEntry: (...args: unknown[]) => mockRemoveAuthEntry(...args),
}))

vi.mock("../../../extensions/mcp-adapter/mcp-auth-flow.js", () => ({
	authenticate: (...args: unknown[]) => mockAuthenticate(...args),
	getAuthStatus: (...args: unknown[]) => mockGetAuthStatus(...args),
	supportsOAuth: (...args: unknown[]) => mockSupportsOAuth(...args),
}))

function makeManager(overrides: Partial<McpServerManager> = {}): McpServerManager {
	return {
		probeTools: mockProbeTools,
		...overrides,
	} as unknown as McpServerManager
}

beforeEach(() => {
	vi.clearAllMocks()
	mockSupportsOAuth.mockReturnValue(false)
})

describe("validateServerEntry", () => {
	it("accepts a minimal stdio server entry", () => {
		const entry = validateServerEntry({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] })
		expect(entry).toEqual({
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-filesystem"],
		})
	})

	it("accepts a minimal URL server entry", () => {
		const entry = validateServerEntry({ url: "https://mcp.example.com/sse" })
		expect(entry).toEqual({ url: "https://mcp.example.com/sse" })
	})

	it("accepts all optional stdio fields", () => {
		const raw = {
			command: "node",
			args: ["server.js"],
			env: { FOO: "bar" },
			cwd: "/project",
			auth: false,
			debug: true,
		} as const
		expect(validateServerEntry(raw)).toEqual(raw)
	})

	it("accepts all optional URL fields", () => {
		const raw = {
			url: "https://mcp.example.com",
			headers: { Authorization: "Bearer token" },
			auth: "bearer" as const,
			debug: false,
		}
		expect(validateServerEntry(raw)).toEqual(raw)
	})

	it("throws invalidParams when server is not an object", () => {
		for (const server of [null, undefined, "string", 123, []]) {
			expect(() => validateServerEntry(server)).toThrow(
				expect.objectContaining({ code: -32602, message: expect.stringContaining("'server' must be an object") }),
			)
		}
	})

	it("throws invalidParams when server has neither command nor url", () => {
		expect(() => validateServerEntry({})).toThrow(
			expect.objectContaining({
				code: -32602,
				message: expect.stringContaining("must have a 'command' or 'url' field"),
			}),
		)
	})

	it("throws invalidParams when command is empty", () => {
		expect(() => validateServerEntry({ command: "" })).toThrow(expect.objectContaining({ code: -32602 }))
	})

	it("throws invalidParams when url is empty", () => {
		expect(() => validateServerEntry({ url: "" })).toThrow(expect.objectContaining({ code: -32602 }))
	})

	it("throws invalidParams when args is not an array", () => {
		expect(() => validateServerEntry({ command: "node", args: "server.js" })).toThrow(
			expect.objectContaining({ message: expect.stringContaining("'server.args' must be an array") }),
		)
	})

	it("throws invalidParams when args contains a non-string", () => {
		expect(() => validateServerEntry({ command: "node", args: ["server.js", 123] })).toThrow(
			expect.objectContaining({ message: expect.stringContaining("'server.args' must be an array of strings") }),
		)
	})

	it("throws invalidParams when env is not an object", () => {
		expect(() => validateServerEntry({ command: "node", env: "FOO=bar" })).toThrow(
			expect.objectContaining({ message: expect.stringContaining("'server.env' must be an object") }),
		)
	})

	it("throws invalidParams when env value is not a string", () => {
		expect(() => validateServerEntry({ command: "node", env: { FOO: 123 } })).toThrow(
			expect.objectContaining({ message: expect.stringContaining("server.env['FOO'] must be a string") }),
		)
	})

	it("throws invalidParams when cwd is not a string", () => {
		expect(() => validateServerEntry({ command: "node", cwd: 123 })).toThrow(
			expect.objectContaining({ message: expect.stringContaining("'server.cwd' must be a string") }),
		)
	})

	it("throws invalidParams when headers is not an object", () => {
		expect(() => validateServerEntry({ url: "https://example.com", headers: "Auth" })).toThrow(
			expect.objectContaining({ message: expect.stringContaining("'server.headers' must be an object") }),
		)
	})

	it("throws invalidParams when auth is not a recognized value", () => {
		expect(() => validateServerEntry({ url: "https://example.com", auth: "basic" })).toThrow(
			expect.objectContaining({
				message: expect.stringContaining("'server.auth' must be 'oauth', 'bearer', or false"),
			}),
		)
	})

	it("throws invalidParams when debug is not a boolean", () => {
		expect(() => validateServerEntry({ command: "node", debug: "yes" })).toThrow(
			expect.objectContaining({ message: expect.stringContaining("'server.debug' must be a boolean") }),
		)
	})
})

describe("handleProbeMcpServer", () => {
	const stdioServer: ServerEntry = { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] }
	const urlServer: ServerEntry = { url: "https://mcp.example.com", auth: "oauth" }

	it("throws invalidParams when mcpServerManager is undefined", async () => {
		await expect(handleProbeMcpServer(undefined, { server: stdioServer })).rejects.toThrow(
			expect.objectContaining({
				code: -32602,
				message: expect.stringContaining("MCP server manager is not available"),
			}),
		)
	})

	it("throws invalidParams when server is missing", async () => {
		const manager = makeManager()
		await expect(handleProbeMcpServer(manager, {})).rejects.toThrow(expect.objectContaining({ code: -32602 }))
	})

	it("probes a stdio server and returns the result", async () => {
		const manager = makeManager()
		const probeResult: ProbeResult = {
			tools: [{ name: "read_file", description: "Read a file" }],
			needsAuth: false,
			error: null,
		}
		mockSupportsOAuth.mockReturnValue(false)
		mockProbeTools.mockResolvedValue(probeResult)

		const result = await handleProbeMcpServer(manager, { server: stdioServer, serverName: "stdio-server" })

		expect(result).toEqual(probeResult)
		expect(mockProbeTools).toHaveBeenCalledWith("stdio-server", stdioServer)
		expect(mockAuthenticate).not.toHaveBeenCalled()
	})

	it("defaults serverName to 'probe' when omitted", async () => {
		const manager = makeManager()
		mockSupportsOAuth.mockReturnValue(false)
		mockProbeTools.mockResolvedValue({ tools: [], needsAuth: false, error: null })

		await handleProbeMcpServer(manager, { server: stdioServer })

		expect(mockProbeTools).toHaveBeenCalledWith("probe", stdioServer)
	})

	it("authenticates OAuth URL servers before probing when not authenticated", async () => {
		const manager = makeManager()
		mockSupportsOAuth.mockReturnValue(true)
		mockGetAuthStatus.mockResolvedValue("not_authenticated")
		mockAuthenticate.mockResolvedValue(undefined)
		mockProbeTools.mockResolvedValue({ tools: [], needsAuth: false, error: null })

		await handleProbeMcpServer(manager, { server: urlServer, serverName: "oauth-server" })

		expect(mockGetAuthStatus).toHaveBeenCalledWith("oauth-server", urlServer.url)
		expect(mockAuthenticate).toHaveBeenCalledWith("oauth-server", urlServer.url, urlServer)
		expect(mockProbeTools).toHaveBeenCalledWith("oauth-server", urlServer)
	})

	it("skips authenticate when OAuth server already has valid auth", async () => {
		const manager = makeManager()
		mockSupportsOAuth.mockReturnValue(true)
		mockGetAuthStatus.mockResolvedValue("authenticated")
		mockProbeTools.mockResolvedValue({ tools: [], needsAuth: false, error: null })

		await handleProbeMcpServer(manager, { server: urlServer, serverName: "oauth-server" })

		expect(mockGetAuthStatus).toHaveBeenCalledWith("oauth-server", urlServer.url)
		expect(mockAuthenticate).not.toHaveBeenCalled()
		expect(mockProbeTools).toHaveBeenCalledWith("oauth-server", urlServer)
	})

	it("returns needsAuth with error message when authenticate fails", async () => {
		const manager = makeManager()
		mockSupportsOAuth.mockReturnValue(true)
		mockGetAuthStatus.mockResolvedValue("not_authenticated")
		mockAuthenticate.mockRejectedValue(new Error("User denied authorization"))

		const result = await handleProbeMcpServer(manager, { server: urlServer, serverName: "oauth-server" })

		expect(result).toEqual({ tools: [], needsAuth: true, error: "User denied authorization" })
		expect(mockProbeTools).not.toHaveBeenCalled()
	})

	it("uses a throwaway probe name when an auth entry exists for a different URL", async () => {
		const manager = makeManager()
		mockSupportsOAuth.mockReturnValue(false)
		mockProbeTools.mockResolvedValue({ tools: [], needsAuth: false, error: null })
		mockGetAuthEntry.mockReturnValue({ serverUrl: "https://old.example.com" })

		await handleProbeMcpServer(manager, { server: { url: "https://new.example.com" }, serverName: "my-server" })

		const probeName = mockProbeTools.mock.calls[0][0] as string
		expect(probeName).toMatch(/^__probe_[\w-]+$/)
		expect(probeName).not.toBe("my-server")
		expect(mockRemoveAuthEntry).toHaveBeenCalledWith(probeName)
	})

	it("uses the real serverName when no auth entry exists", async () => {
		const manager = makeManager()
		mockSupportsOAuth.mockReturnValue(false)
		mockProbeTools.mockResolvedValue({ tools: [], needsAuth: false, error: null })
		mockGetAuthEntry.mockReturnValue(undefined)

		await handleProbeMcpServer(manager, { server: stdioServer, serverName: "my-server" })

		expect(mockProbeTools).toHaveBeenCalledWith("my-server", stdioServer)
		expect(mockRemoveAuthEntry).not.toHaveBeenCalled()
	})

	it("uses the real serverName when auth entry URL matches", async () => {
		const manager = makeManager()
		mockSupportsOAuth.mockReturnValue(false)
		mockProbeTools.mockResolvedValue({ tools: [], needsAuth: false, error: null })
		mockGetAuthEntry.mockReturnValue({ serverUrl: "https://same.example.com" })

		await handleProbeMcpServer(manager, {
			server: { url: "https://same.example.com" },
			serverName: "my-server",
		})

		expect(mockProbeTools).toHaveBeenCalledWith("my-server", { url: "https://same.example.com" })
		expect(mockRemoveAuthEntry).not.toHaveBeenCalled()
	})

	it("cleans up throwaway auth entries even when probeTools throws", async () => {
		const manager = makeManager()
		mockSupportsOAuth.mockReturnValue(false)
		mockProbeTools.mockRejectedValue(new Error("probe failed"))
		mockGetAuthEntry.mockReturnValue({ serverUrl: "https://old.example.com" })

		await expect(
			handleProbeMcpServer(manager, { server: { url: "https://new.example.com" }, serverName: "my-server" }),
		).rejects.toThrow("probe failed")

		expect(mockRemoveAuthEntry).toHaveBeenCalled()
	})
})
