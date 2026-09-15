import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk"
import type { AgentSession } from "@earendil-works/pi-coding-agent"
import type { ServerEntry } from "pi-mcp-adapter/types"
import { describe, expect, it, vi } from "vitest"
import type { McpProbe, ProbeResult } from "../../extensions/mcp/probe.js"
import { AVAILABLE_EXT_METHODS } from "./capabilities.js"
import { type AcpSessionFactory, KimchiAcpAgent } from "./server.js"

class FakeAgentSession {
	readonly sessionId = "probe-test-session"
	readonly model = { provider: "test", id: "test-model" }
	readonly modelRegistry = { getAvailable: () => [{ provider: "test", id: "test-model", name: "Test" }] }
	readonly sessionManager = {
		getBranch: () => [],
		getSessionDir: () => "/tmp",
		getCwd: () => "/tmp",
		getEntries: () => [],
		appendCustomEntry: () => "entry-id",
	}
	readonly extensionRunner = { emit: async () => {} }
	subscribe = () => () => {}
	async bindExtensions(): Promise<void> {}
	async prompt(): Promise<void> {}
	async abort(): Promise<void> {}
	dispose(): void {}
}

function createConnection(): AgentSideConnection {
	return { sessionUpdate: async (_params: SessionNotification) => {} } as unknown as AgentSideConnection
}

function createProbe(result: ProbeResult): McpProbe {
	return { probeTools: vi.fn().mockResolvedValue(result) }
}

function createAgent(mcpProbe?: McpProbe): KimchiAcpAgent {
	const sessionFactory: AcpSessionFactory = async () => new FakeAgentSession() as unknown as AgentSession
	return new KimchiAcpAgent(createConnection(), {
		extensionFactories: [],
		agentDir: "/tmp/fake-agent-dir",
		sessionFactory,
		mcpProbe,
	})
}

describe("KimchiAcpAgent MCP probe extension method", () => {
	it("routes probe requests through the configured upstream probe", async () => {
		const server: ServerEntry = { command: "node", args: ["server.js"] }
		const probeResult: ProbeResult = {
			tools: [{ name: "tool_a", description: "Does A" }],
			needsAuth: false,
			error: null,
		}
		const probe = createProbe(probeResult)
		const agent = createAgent(probe)

		expect(await agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, { server, serverName: "fixture" })).toEqual(
			probeResult,
		)
		expect(probe.probeTools).toHaveBeenCalledWith("fixture", server, { authenticate: true })
	})

	it("passes skipAuth through to the probe", async () => {
		const server: ServerEntry = { url: "https://example.test/mcp" }
		const probe = createProbe({ tools: [], needsAuth: true, error: null })
		const agent = createAgent(probe)

		await agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, { server, skipAuth: true })
		expect(probe.probeTools).toHaveBeenCalledWith("probe", server, { authenticate: false })
	})

	it("does not advertise or execute probing without the dependency", async () => {
		const agent = createAgent()
		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.probe_mcp_server, { server: { command: "node" } }),
		).rejects.toMatchObject({ code: -32602 })
	})

	it("rejects unknown extension methods", async () => {
		await expect(
			createAgent(createProbe({ tools: [], needsAuth: false, error: null })).extMethod("unknown", {}),
		).rejects.toMatchObject({
			code: -32601,
		})
	})
})
