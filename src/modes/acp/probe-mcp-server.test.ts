import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk"
import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { McpServerManager } from "../../extensions/mcp-adapter/server-manager.js"
import type { ProbeResult, ServerEntry } from "../../extensions/mcp-adapter/types.js"
import { AVAILABLE_EXT_METHODS } from "./capabilities.js"
import { type AcpSessionFactory, KimchiAcpAgent } from "./server.js"

// Mock the auth flow and auth store so tests don't touch real disk state.
vi.mock("../../extensions/mcp-adapter/mcp-auth-flow.js", () => ({
	supportsOAuth: vi.fn().mockReturnValue(false),
	authenticate: vi.fn(),
	getAuthStatus: vi.fn().mockResolvedValue("not_authenticated"),
}))
vi.mock("../../extensions/mcp-adapter/mcp-auth.js", () => ({
	getAuthEntry: vi.fn().mockReturnValue(null),
	removeAuthEntry: vi.fn(),
}))

import { getAuthEntry } from "../../extensions/mcp-adapter/mcp-auth.js"
import { authenticate, getAuthStatus, supportsOAuth } from "../../extensions/mcp-adapter/mcp-auth-flow.js"

// Minimal fake — we only need sessionId/subscribe/dispose/prompt/abort for the
// ACP agent to accept a session. The probe_mcp_server extMethod doesn't touch
// the session at all.
class FakeAgentSession {
	sessionId: string
	disposed = false
	model = { provider: "test", id: "test-model" }
	modelRegistry = { getAvailable: () => [{ provider: "test", id: "test-model", name: "Test" }] }
	sessionManager = { getBranch: () => [] }
	bindExtensionsImpl: ((opts: unknown) => Promise<void>) | null = null

	constructor(id: string) {
		this.sessionId = id
	}

	subscribe = () => () => {}
	async bindExtensions(opts: unknown): Promise<void> {
		if (this.bindExtensionsImpl) await this.bindExtensionsImpl(opts)
	}
	async prompt(): Promise<void> {}
	async abort(): Promise<void> {}
	dispose(): void {
		this.disposed = true
	}
	extensionRunner = { emit: async () => {} }
}

function asSession(fake: FakeAgentSession): AgentSession {
	return fake as unknown as AgentSession
}

function makeConn(): AgentSideConnection {
	const stub = {
		sessionUpdate: async (_p: SessionNotification) => {},
	}
	return stub as unknown as AgentSideConnection
}

function makeFakeMcpServerManager(probeResult: ProbeResult): McpServerManager {
	return {
		probeTools: vi.fn().mockResolvedValue(probeResult),
	} as unknown as McpServerManager
}

function makeAgent(mcpServerManager?: McpServerManager): KimchiAcpAgent {
	const fake = new FakeAgentSession("probe-test-session")
	const sessionFactory: AcpSessionFactory = async () => asSession(fake)
	return new KimchiAcpAgent(makeConn(), {
		extensionFactories: [],
		agentDir: "/tmp/fake-agent-dir",
		sessionFactory,
		mcpServerManager,
	})
}

describe("KimchiAcpAgent extMethod probe_mcp_server", () => {
	it("routes _kimchi.dev/probe_mcp_server to mcpServerManager.probeTools", async () => {
		const serverEntry: ServerEntry = { command: "echo", args: ["test"] }
		const probeResult: ProbeResult = {
			tools: [
				{ name: "tool_a", description: "Does A" },
				{ name: "tool_b", description: "Does B" },
			],
			needsAuth: false,
			error: null,
		}
		const manager = makeFakeMcpServerManager(probeResult)
		const agent = makeAgent(manager)

		const result = await agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, {
			server: serverEntry,
			serverName: "test-server",
		})

		expect(result).toEqual(probeResult)
		expect(manager.probeTools).toHaveBeenCalledWith("test-server", serverEntry)
	})

	it("returns tools array, needsAuth flag, and error string", async () => {
		const serverEntry: ServerEntry = { command: "echo", args: [] }
		const probeResult: ProbeResult = {
			tools: [{ name: "tool_x" }],
			needsAuth: true,
			error: null,
		}
		const manager = makeFakeMcpServerManager(probeResult)
		const agent = makeAgent(manager)

		const result = (await agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, {
			server: serverEntry,
		})) as unknown as ProbeResult

		expect(result.tools).toHaveLength(1)
		expect(result.tools[0].name).toBe("tool_x")
		expect(result.needsAuth).toBe(true)
		expect(result.error).toBeNull()
	})

	it("passes through error from probeTools", async () => {
		const serverEntry: ServerEntry = { command: "nonexistent-binary" }
		const probeResult: ProbeResult = {
			tools: [],
			needsAuth: false,
			error: "spawn nonexistent-binary ENOENT",
		}
		const manager = makeFakeMcpServerManager(probeResult)
		const agent = makeAgent(manager)

		const result = (await agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, {
			server: serverEntry,
		})) as unknown as ProbeResult

		expect(result.tools).toEqual([])
		expect(result.needsAuth).toBe(false)
		expect(result.error).toBe("spawn nonexistent-binary ENOENT")
	})

	it("throws methodNotFound for unknown extMethod", async () => {
		const agent = makeAgent(makeFakeMcpServerManager({ tools: [], needsAuth: false, error: null }))
		await expect(agent.extMethod("_kimchi.dev/unknown", {})).rejects.toMatchObject({ code: -32601 })
	})

	it("throws invalidParams when server parameter is missing", async () => {
		const agent = makeAgent(makeFakeMcpServerManager({ tools: [], needsAuth: false, error: null }))
		await expect(agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, {})).rejects.toMatchObject({ code: -32602 })
	})

	it("throws invalidParams when mcpServerManager is not configured", async () => {
		// No mcpServerManager injected — simulates a misconfigured agent
		const fake = new FakeAgentSession("no-mgr-session")
		const sessionFactory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory,
		})
		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, { server: { command: "echo" } }),
		).rejects.toMatchObject({ code: -32602 })
	})

	it("defaults serverName to 'probe' when not provided", async () => {
		const serverEntry: ServerEntry = { command: "echo", args: [] }
		const probeResult: ProbeResult = { tools: [], needsAuth: false, error: null }
		const manager = makeFakeMcpServerManager(probeResult)
		const agent = makeAgent(manager)

		await agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, {
			server: serverEntry,
		})

		expect(manager.probeTools).toHaveBeenCalledWith("probe", serverEntry)
	})
})

describe("KimchiAcpAgent extMethod probe_mcp_server OAuth", () => {
	beforeEach(() => {
		vi.mocked(supportsOAuth).mockReturnValue(false)
		vi.mocked(authenticate).mockReset()
		vi.mocked(getAuthEntry).mockReturnValue(undefined)
		vi.mocked(getAuthStatus).mockResolvedValue("not_authenticated")
	})

	it("authenticates before probing for an OAuth-capable URL server", async () => {
		const serverEntry: ServerEntry = { url: "https://example.com/mcp" }
		const successResult: ProbeResult = { tools: [{ name: "tool1" }], needsAuth: false, error: null }
		const manager = makeFakeMcpServerManager(successResult)
		vi.mocked(supportsOAuth).mockReturnValue(true)
		vi.mocked(getAuthStatus).mockResolvedValue("not_authenticated")
		vi.mocked(authenticate).mockResolvedValue("authenticated" as never)

		const agent = makeAgent(manager)
		const result = await agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, {
			server: serverEntry,
			serverName: "my-server",
		})

		expect(result.tools).toHaveLength(1)
		expect(result.needsAuth).toBe(false)
		expect(vi.mocked(authenticate)).toHaveBeenCalledWith("my-server", "https://example.com/mcp", serverEntry)
		expect(manager.probeTools).toHaveBeenCalledTimes(1)
	})

	it("skips authentication and probes directly when already authenticated", async () => {
		const serverEntry: ServerEntry = { url: "https://example.com/mcp" }
		const successResult: ProbeResult = { tools: [{ name: "tool1" }], needsAuth: false, error: null }
		const manager = makeFakeMcpServerManager(successResult)
		vi.mocked(supportsOAuth).mockReturnValue(true)
		vi.mocked(getAuthStatus).mockResolvedValue("authenticated")

		const agent = makeAgent(manager)
		const result = await agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, {
			server: serverEntry,
			serverName: "my-server",
		})

		expect(result.tools).toHaveLength(1)
		expect(vi.mocked(authenticate)).not.toHaveBeenCalled()
		expect(manager.probeTools).toHaveBeenCalledTimes(1)
	})

	it("returns needsAuth with error message when authenticate fails", async () => {
		const serverEntry: ServerEntry = { url: "https://example.com/mcp" }
		const manager = makeFakeMcpServerManager({ tools: [], needsAuth: false, error: null })
		vi.mocked(supportsOAuth).mockReturnValue(true)
		vi.mocked(getAuthStatus).mockResolvedValue("not_authenticated")
		vi.mocked(authenticate).mockRejectedValue(new Error("Browser failed to open"))

		const agent = makeAgent(manager)
		const result = await agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, {
			server: serverEntry,
			serverName: "my-server",
		})

		expect(result.needsAuth).toBe(true)
		expect(result.error).toBe("Browser failed to open")
		expect(manager.probeTools).not.toHaveBeenCalled()
	})

	it("does not attempt OAuth for a stdio server (no url)", async () => {
		const serverEntry: ServerEntry = { command: "echo", args: [] }
		const needsAuthResult: ProbeResult = { tools: [], needsAuth: true, error: null }
		const manager = makeFakeMcpServerManager(needsAuthResult)
		vi.mocked(supportsOAuth).mockReturnValue(true)

		const agent = makeAgent(manager)
		const result = await agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, {
			server: serverEntry,
		})

		expect(result.needsAuth).toBe(true)
		expect(vi.mocked(authenticate)).not.toHaveBeenCalled()
		expect(manager.probeTools).toHaveBeenCalledTimes(1)
	})
})

describe("KimchiAcpAgent extMethod probe_mcp_server validation", () => {
	it("rejects non-object server param", async () => {
		const agent = makeAgent(makeFakeMcpServerManager({ tools: [], needsAuth: false, error: null }))
		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, { server: "not-an-object" }),
		).rejects.toMatchObject({
			code: -32602,
		})
		await expect(agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, { server: null })).rejects.toMatchObject({
			code: -32602,
		})
		await expect(agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, { server: [] })).rejects.toMatchObject({
			code: -32602,
		})
	})

	it("rejects server without command or url", async () => {
		const agent = makeAgent(makeFakeMcpServerManager({ tools: [], needsAuth: false, error: null }))
		await expect(agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, { server: {} })).rejects.toMatchObject({
			code: -32602,
		})
	})

	it("rejects non-string command", async () => {
		const agent = makeAgent(makeFakeMcpServerManager({ tools: [], needsAuth: false, error: null }))
		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, { server: { command: 123 } }),
		).rejects.toMatchObject({ code: -32602 })
	})

	it("rejects non-array args", async () => {
		const agent = makeAgent(makeFakeMcpServerManager({ tools: [], needsAuth: false, error: null }))
		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, { server: { command: "echo", args: "not-array" } }),
		).rejects.toMatchObject({ code: -32602 })
	})

	it("rejects non-string elements in args", async () => {
		const agent = makeAgent(makeFakeMcpServerManager({ tools: [], needsAuth: false, error: null }))
		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, { server: { command: "echo", args: ["ok", 42] } }),
		).rejects.toMatchObject({ code: -32602 })
	})

	it("rejects env with non-string values", async () => {
		const agent = makeAgent(makeFakeMcpServerManager({ tools: [], needsAuth: false, error: null }))
		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, { server: { command: "echo", env: { KEY: 123 } } }),
		).rejects.toMatchObject({ code: -32602 })
	})

	it("accepts a valid stdio server entry", async () => {
		const probeResult: ProbeResult = { tools: [{ name: "tool1" }], needsAuth: false, error: null }
		const manager = makeFakeMcpServerManager(probeResult)
		const agent = makeAgent(manager)
		const result = await agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, {
			server: { command: "echo", args: ["hello"], env: { FOO: "bar" } },
		})
		expect(result).toEqual(probeResult)
	})

	it("accepts a valid URL server entry", async () => {
		const probeResult: ProbeResult = { tools: [{ name: "tool1" }], needsAuth: false, error: null }
		const manager = makeFakeMcpServerManager(probeResult)
		const agent = makeAgent(manager)
		const result = await agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, {
			server: { url: "https://mcp.example.com/sse" },
		})
		expect(result).toEqual(probeResult)
	})
})

describe("probe_mcp_server capability advertisement", () => {
	it("advertises probe_mcp_server in initialize response", async () => {
		const agent = makeAgent(makeFakeMcpServerManager({ tools: [], needsAuth: false, error: null }))
		const response = await agent.initialize({ protocolVersion: 1 })
		const meta = response.agentCapabilities?._meta?.["kimchi.dev"] as Record<string, boolean> | undefined
		expect(meta?.probe_mcp_server).toBe(true)
	})
})
