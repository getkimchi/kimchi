import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Shared mock functions — these persist across tests. The Client mock factory
// references them, so vi.clearAllMocks() won't strip the implementation.
const mockConnect = vi.fn()
const mockListTools = vi.fn()
const mockClose = vi.fn()
const mockSetNotificationHandler = vi.fn()

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: vi.fn().mockImplementation(() => ({
		connect: mockConnect,
		listTools: mockListTools,
		close: mockClose,
		setNotificationHandler: mockSetNotificationHandler,
	})),
}))

// Mock StdioClientTransport and SSEClientTransport so they don't spawn processes
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: vi.fn().mockImplementation(() => ({
		close: vi.fn().mockResolvedValue(undefined),
	})),
}))

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
	SSEClientTransport: vi.fn().mockImplementation(() => ({
		close: vi.fn().mockResolvedValue(undefined),
	})),
}))

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({
		close: vi.fn().mockResolvedValue(undefined),
	})),
}))

// Mock supportsOAuth
vi.mock("./mcp-auth-flow.js", () => ({
	supportsOAuth: vi.fn(),
}))

// Mock McpOAuthProvider
vi.mock("./mcp-oauth-provider.js", () => ({
	McpOAuthProvider: vi.fn(),
}))

// Mock resolveNpxBinary
vi.mock("./npx-resolver.js", () => ({
	resolveNpxBinary: vi.fn().mockResolvedValue(null),
}))

// Mock logger
vi.mock("./logger.js", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Mock metadata-cache — capture calls to saveMetadataCache and computeServerHash
const { mockSaveMetadataCache, mockComputeServerHash } = vi.hoisted(() => ({
	mockSaveMetadataCache: vi.fn(),
	mockComputeServerHash: vi.fn(),
}))
vi.mock("./metadata-cache.js", () => ({
	saveMetadataCache: mockSaveMetadataCache,
	computeServerHash: mockComputeServerHash,
}))

// Import after mocks
import { supportsOAuth } from "./mcp-auth-flow.js"
import { McpServerManager } from "./server-manager.js"

describe("McpServerManager.probeTools", () => {
	let manager: McpServerManager

	beforeEach(() => {
		// Reset call history but keep implementations intact
		mockConnect.mockReset()
		mockListTools.mockReset()
		mockClose.mockReset()
		mockSetNotificationHandler.mockReset()
		vi.mocked(supportsOAuth).mockReset()

		// Set defaults — most tests expect these
		vi.mocked(supportsOAuth).mockReturnValue(false)
		mockClose.mockResolvedValue(undefined)

		manager = new McpServerManager()
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it("returns tools from a successful probe (stdio server)", async () => {
		mockConnect.mockResolvedValue(undefined)
		mockListTools.mockResolvedValue({
			tools: [
				{ name: "tool_a", description: "Does A", inputSchema: { type: "object" } },
				{ name: "tool_b", title: "B Tool", description: "Does B" },
			],
			nextCursor: undefined,
		})

		const result = await manager.probeTools("test-server", { command: "echo", args: ["hello"] })

		expect(result.tools).toHaveLength(2)
		expect(result.tools[0].name).toBe("tool_a")
		expect(result.tools[0].description).toBe("Does A")
		expect(result.tools[0].inputSchema).toEqual({ type: "object" })
		expect(result.tools[1].name).toBe("tool_b")
		expect(result.tools[1].title).toBe("B Tool")
		expect(result.needsAuth).toBe(false)
		expect(result.error).toBeNull()

		expect(mockClose).toHaveBeenCalled()
	})

	it("returns needsAuth when UnauthorizedError occurs during connect (OAuth server)", async () => {
		vi.mocked(supportsOAuth).mockReturnValue(true)
		mockConnect.mockRejectedValue(new UnauthorizedError("Unauthorized"))

		const result = await manager.probeTools("oauth-server", {
			url: "https://mcp.example.com",
			auth: "oauth",
		})

		expect(result.tools).toEqual([])
		expect(result.needsAuth).toBe(true)
		expect(result.error).toBeNull()
		// UnauthorizedError skips the SSE fallback and returns needsAuth directly.
		// The finally block closes the client and transport.
	})

	it("returns error string when connect throws a non-OAuth error", async () => {
		mockConnect.mockRejectedValue(new Error("Connection refused"))

		const result = await manager.probeTools("bad-server", { command: "nonexistent-cmd" })

		expect(result.tools).toEqual([])
		expect(result.needsAuth).toBe(false)
		expect(result.error).toBe("Connection refused")
		expect(mockClose).toHaveBeenCalled()
	})

	it("returns error string for non-Error exceptions", async () => {
		mockConnect.mockRejectedValue("string error")

		const result = await manager.probeTools("bad-server", { command: "nonexistent-cmd" })

		expect(result.tools).toEqual([])
		expect(result.needsAuth).toBe(false)
		expect(result.error).toBe("string error")
	})

	it("returns error when server has no command or url", async () => {
		const result = await manager.probeTools("empty-server", {})

		expect(result.tools).toEqual([])
		expect(result.needsAuth).toBe(false)
		expect(result.error).toContain("no command or url")
	})

	it("cleans up client and transport in finally block on success", async () => {
		mockConnect.mockResolvedValue(undefined)
		mockListTools.mockResolvedValue({ tools: [], nextCursor: undefined })

		await manager.probeTools("cleanup-test", { command: "echo" })

		expect(mockClose).toHaveBeenCalled()
	})

	it("cleans up client and transport in finally block on error", async () => {
		mockConnect.mockRejectedValue(new Error("boom"))

		await manager.probeTools("cleanup-error-test", { command: "echo" })

		expect(mockClose).toHaveBeenCalled()
	})

	it("maps tool fields correctly from McpTool to ProbeMcpTool", async () => {
		mockConnect.mockResolvedValue(undefined)
		mockListTools.mockResolvedValue({
			tools: [
				{
					name: "complex_tool",
					title: "Complex",
					description: "A complex tool",
					inputSchema: { type: "object", properties: {} },
					annotations: { readOnlyHint: true },
					_meta: { custom: "data" },
				},
			],
			nextCursor: undefined,
		})

		const result = await manager.probeTools("mapping-test", { command: "echo" })

		expect(result.tools).toHaveLength(1)
		expect(result.tools[0]).toEqual({
			name: "complex_tool",
			title: "Complex",
			description: "A complex tool",
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: true },
		})
		// _meta should NOT be forwarded to ProbeMcpTool
		expect("_meta" in result.tools[0]).toBe(false)
	})

	it("handles pagination in fetchAllTools (nextCursor)", async () => {
		mockConnect.mockResolvedValue(undefined)
		let callCount = 0
		mockListTools.mockImplementation(() => {
			callCount++
			if (callCount === 1) {
				return Promise.resolve({
					tools: [{ name: "page1_tool" }],
					nextCursor: "cursor-1",
				})
			}
			return Promise.resolve({
				tools: [{ name: "page2_tool" }],
				nextCursor: undefined,
			})
		})

		const result = await manager.probeTools("paginated-server", { command: "echo" })

		expect(result.tools).toHaveLength(2)
		expect(result.tools[0].name).toBe("page1_tool")
		expect(result.tools[1].name).toBe("page2_tool")
		expect(mockListTools).toHaveBeenCalledTimes(2)
	})
})

describe("McpServerManager.createTransport (via probeTools)", () => {
	beforeEach(() => {
		mockConnect.mockReset()
		mockListTools.mockReset()
		mockClose.mockReset()
		vi.mocked(supportsOAuth).mockReset()
		vi.mocked(supportsOAuth).mockReturnValue(false)
		mockClose.mockResolvedValue(undefined)
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it("throws when server has no command or url", async () => {
		const manager = new McpServerManager()
		const result = await manager.probeTools("bad", {})

		expect(result.tools).toEqual([])
		expect(result.error).toContain("no command or url")
	})

	it("creates stdio transport for command-based servers", async () => {
		mockConnect.mockResolvedValue(undefined)
		mockListTools.mockResolvedValue({ tools: [], nextCursor: undefined })

		const manager = new McpServerManager()
		const result = await manager.probeTools("stdio-test", {
			command: "echo",
			args: ["test"],
			env: { FOO: "bar" },
		})

		expect(result.error).toBeNull()
		expect(mockConnect).toHaveBeenCalled()
	})
})

describe("withTimeout (indirectly via probeTools)", () => {
	beforeEach(() => {
		mockConnect.mockReset()
		mockListTools.mockReset()
		mockClose.mockReset()
		vi.mocked(supportsOAuth).mockReset()
		vi.mocked(supportsOAuth).mockReturnValue(false)
		mockClose.mockResolvedValue(undefined)
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
	})

	it("resolves normally when the operation completes before the deadline", async () => {
		mockConnect.mockResolvedValue(undefined)
		mockListTools.mockResolvedValue({ tools: [{ name: "fast_tool" }], nextCursor: undefined })

		const manager = new McpServerManager()
		const result = await manager.probeTools("fast-server", { command: "echo" })

		expect(result.tools).toHaveLength(1)
		expect(result.error).toBeNull()
	})

	it("times out when connect takes longer than the budget", async () => {
		// Simulate a connect that never resolves — should time out after 15s
		mockConnect.mockReturnValue(new Promise(() => {}))

		vi.useFakeTimers()
		const manager = new McpServerManager()
		const probePromise = manager.probeTools("slow-server", { command: "echo" })

		// Advance past the 15s non-OAuth timeout
		await vi.advanceTimersByTimeAsync(16_000)

		const result = await probePromise

		expect(result.tools).toEqual([])
		expect(result.needsAuth).toBe(false)
		expect(result.error).toContain("timed out")
		expect(mockClose).toHaveBeenCalled()
	})

	it("uses a single deadline for both connect and tools/list", async () => {
		// Verifies Finding 3: budget is per-probe, not per-operation.
		// If connect consumes most of the 15s budget, tools/list gets the remainder.
		vi.useFakeTimers()

		// Connect takes 14s (leaving 1s out of 15s budget)
		let connectResolve!: () => void
		const connectPromise = new Promise<void>((resolve) => {
			connectResolve = resolve
		})
		mockConnect.mockReturnValue(connectPromise)
		// tools/list returns a never-resolving promise so it can't win the race
		mockListTools.mockReturnValue(new Promise(() => {}))

		const manager = new McpServerManager()
		const probePromise = manager.probeTools("deadline-test", { command: "echo" })

		// Advance 14s — connect resolves
		await vi.advanceTimersByTimeAsync(14_000)
		connectResolve()
		await vi.waitFor(() => expect(mockListTools).toHaveBeenCalled())

		// Only 1s left — advance 2s to trigger timeout on tools/list
		await vi.advanceTimersByTimeAsync(2_000)
		const result = await probePromise

		expect(result.error).toContain("timed out")
		expect(mockClose).toHaveBeenCalled()
	})
})

describe("McpServerManager.probeTools SSE fallback", () => {
	beforeEach(() => {
		mockConnect.mockReset()
		mockListTools.mockReset()
		mockClose.mockReset()
		mockSetNotificationHandler.mockReset()
		vi.mocked(supportsOAuth).mockReset()
		vi.mocked(supportsOAuth).mockReturnValue(false)
		mockClose.mockResolvedValue(undefined)
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it("falls back to SSE when StreamableHTTP connect fails with non-auth error", async () => {
		// First connect (StreamableHTTP) fails, second (SSE) succeeds
		mockConnect.mockRejectedValueOnce(new Error("Invalid content type")).mockResolvedValueOnce(undefined)
		mockListTools.mockResolvedValue({ tools: [{ name: "sse_tool" }], nextCursor: undefined })

		const manager = new McpServerManager()
		const result = await manager.probeTools("sse-server", {
			url: "https://mcp.example.com/sse",
		})

		expect(result.tools).toHaveLength(1)
		expect(result.tools[0].name).toBe("sse_tool")
		expect(result.needsAuth).toBe(false)
		expect(mockConnect).toHaveBeenCalledTimes(2)
	})

	it("returns error when both StreamableHTTP and SSE fail", async () => {
		mockConnect.mockRejectedValue(new Error("Connection refused"))

		const manager = new McpServerManager()
		const result = await manager.probeTools("dual-fail", {
			url: "https://mcp.example.com/sse",
		})

		expect(result.tools).toEqual([])
		expect(result.needsAuth).toBe(false)
		expect(result.error).toBe("Connection refused")
		expect(mockConnect).toHaveBeenCalledTimes(2)
	})

	it("returns needsAuth when SSE fallback throws UnauthorizedError", async () => {
		vi.mocked(supportsOAuth).mockReturnValue(true)
		mockConnect
			.mockRejectedValueOnce(new Error("Invalid content type"))
			.mockRejectedValueOnce(new UnauthorizedError("Unauthorized"))

		const manager = new McpServerManager()
		const result = await manager.probeTools("oauth-sse", {
			url: "https://mcp.example.com/sse",
			auth: "oauth",
		})

		expect(result.needsAuth).toBe(true)
		expect(result.error).toBeNull()
		expect(mockConnect).toHaveBeenCalledTimes(2)
	})

	it("does not fall back to SSE for stdio servers", async () => {
		mockConnect.mockRejectedValue(new Error("spawn failed"))

		const manager = new McpServerManager()
		const result = await manager.probeTools("stdio-fail", {
			command: "nonexistent-binary",
		})

		expect(result.tools).toEqual([])
		expect(result.error).toBe("spawn failed")
		expect(mockConnect).toHaveBeenCalledTimes(1)
	})
})

describe("McpServerManager.probeTools cache writing", () => {
	beforeEach(() => {
		mockConnect.mockReset()
		mockListTools.mockReset()
		mockClose.mockReset()
		mockSetNotificationHandler.mockReset()
		mockSaveMetadataCache.mockReset()
		mockComputeServerHash.mockReset()
		vi.mocked(supportsOAuth).mockReset()
		vi.mocked(supportsOAuth).mockReturnValue(false)
		mockClose.mockResolvedValue(undefined)
		mockComputeServerHash.mockReturnValue("test-hash")
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it("writes probe results to metadata cache on successful probe", async () => {
		mockConnect.mockResolvedValue(undefined)
		mockListTools.mockResolvedValue({
			tools: [
				{ name: "tool_a", description: "Does A", inputSchema: { type: "object" } },
				{ name: "tool_b", description: "Does B", annotations: { readOnlyHint: true } },
			],
			nextCursor: undefined,
		})

		const manager = new McpServerManager()
		await manager.probeTools("cache-test", { command: "echo" })

		expect(mockSaveMetadataCache).toHaveBeenCalledTimes(1)
		const cacheArg = mockSaveMetadataCache.mock.calls[0][0]
		expect(cacheArg.version).toBe(1)
		expect(cacheArg.servers["cache-test"]).toBeDefined()
		expect(cacheArg.servers["cache-test"].configHash).toBe("test-hash")
		expect(cacheArg.servers["cache-test"].tools).toHaveLength(2)
		expect(cacheArg.servers["cache-test"].tools[0]).toEqual({
			name: "tool_a",
			description: "Does A",
			inputSchema: { type: "object" },
			annotations: undefined,
		})
		expect(cacheArg.servers["cache-test"].resources).toEqual([])
		expect(cacheArg.servers["cache-test"].cachedAt).toBeGreaterThan(0)
	})

	it("writes cache after SSE fallback succeeds", async () => {
		mockConnect.mockRejectedValueOnce(new Error("Invalid content type")).mockResolvedValueOnce(undefined)
		mockListTools.mockResolvedValue({ tools: [{ name: "sse_tool" }], nextCursor: undefined })

		const manager = new McpServerManager()
		await manager.probeTools("sse-cache-test", { url: "https://mcp.example.com/sse" })

		expect(mockSaveMetadataCache).toHaveBeenCalledTimes(1)
		expect(mockSaveMetadataCache.mock.calls[0][0].servers["sse-cache-test"]).toBeDefined()
	})

	it("does not write cache when probe returns needsAuth", async () => {
		vi.mocked(supportsOAuth).mockReturnValue(true)
		mockConnect.mockRejectedValue(new UnauthorizedError("Unauthorized"))

		const manager = new McpServerManager()
		await manager.probeTools("auth-test", { url: "https://mcp.example.com", auth: "oauth" })

		expect(mockSaveMetadataCache).not.toHaveBeenCalled()
	})

	it("does not write cache when probe returns an error", async () => {
		mockConnect.mockRejectedValue(new Error("Connection refused"))

		const manager = new McpServerManager()
		await manager.probeTools("err-test", { command: "echo" })

		expect(mockSaveMetadataCache).not.toHaveBeenCalled()
	})

	it("saveMetadataCache merges with existing entries (does not overwrite)", async () => {
		mockConnect.mockResolvedValue(undefined)
		mockListTools.mockResolvedValue({ tools: [{ name: "tool_a" }], nextCursor: undefined })

		const manager = new McpServerManager()
		await manager.probeTools("new-server", { command: "echo" })

		// saveMetadataCache already does a read-merge-write internally — verify
		// it was called with only the new server, not a full cache overwrite.
		expect(mockSaveMetadataCache).toHaveBeenCalledTimes(1)
		const cacheArg = mockSaveMetadataCache.mock.calls[0][0]
		expect(Object.keys(cacheArg.servers)).toEqual(["new-server"])
		expect(cacheArg.servers["new-server"]).toBeDefined()
	})
})
