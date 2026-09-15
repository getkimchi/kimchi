import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { McpAdapterOptions } from "pi-mcp-adapter/types"
import { Type } from "typebox"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const upstream = vi.hoisted(() => ({
	options: undefined as McpAdapterOptions | undefined,
	gatewayExecute: vi.fn<ToolDefinition["execute"]>(),
	logout: vi.fn(),
	sessionStart: vi.fn(),
	sessionShutdown: vi.fn(),
}))

const mcpClient = vi.hoisted(() => {
	const state = {
		tools: [] as Array<Record<string, unknown>>,
	}
	class Client {
		async listTools() {
			return { tools: state.tools }
		}
	}
	return { Client, state }
})

vi.mock("@modelcontextprotocol/client", () => ({ Client: mcpClient.Client }))

vi.mock("pi-mcp-adapter", () => ({
	createMcpAdapter: vi.fn((options: McpAdapterOptions) => (api: ExtensionAPI) => {
		upstream.options = options
		api.on("session_start", async () => {
			await new mcpClient.Client().listTools()
			await upstream.sessionStart()
		})
		api.on("session_shutdown", async () => {
			await upstream.sessionShutdown()
		})
		api.registerCommand("mcp", {
			description: "MCP",
			handler: async (args, ctx) => upstream.logout(args, ctx),
		})
		api.registerTool({
			name: "mcp",
			label: "MCP",
			description: "MCP gateway",
			parameters: Type.Record(Type.String(), Type.Unknown()),
			execute: upstream.gatewayExecute,
		})
	}),
}))

const installKeyringRequireBridge = vi.hoisted(() => vi.fn())
const credentialAccount = vi.hoisted(() => ({
	value: { status: "absent" } as
		| { status: "present"; serverUrl?: string }
		| { status: "absent" }
		| { status: "unavailable" },
}))
vi.mock("./keyring-require-bridge.js", () => ({
	installKeyringRequireBridge,
	inspectMcpCredentialAccount: () => credentialAccount.value,
}))

vi.mock("./oauth-migration.js", () => ({
	migrateLegacyOAuthCredentials: vi.fn(() => ({ migratedServerNames: [], warnings: [] })),
}))

import { inspectMcpOAuthTokensForUrl, updateMcpOAuthTokensForUrl } from "pi-mcp-adapter/oauth"
import { UpstreamMcpProbe } from "./probe.js"

const authStoreEnv = "PI_MCP_ADAPTER_TEST_AUTH_STORE"
let originalAuthStore: string | undefined

function gatewayResult(details: Record<string, unknown>, text = "") {
	return {
		content: text ? [{ type: "text" as const, text }] : [],
		details,
	}
}

function configuredServerNames(): string[] {
	return Object.keys(upstream.options?.config?.mcpServers ?? {})
}

beforeAll(() => {
	originalAuthStore = process.env[authStoreEnv]
	process.env[authStoreEnv] = "memory"
})

afterAll(() => {
	if (originalAuthStore === undefined) delete process.env[authStoreEnv]
	else process.env[authStoreEnv] = originalAuthStore
})

beforeEach(() => {
	vi.clearAllMocks()
	upstream.sessionStart.mockReset()
	mcpClient.state.tools = []
	credentialAccount.value = { status: "absent" }
	upstream.options = undefined
	upstream.gatewayExecute.mockImplementation(async (_toolCallId, params) => {
		if (typeof params === "object" && params !== null && "connect" in params) {
			return gatewayResult({ tools: [] })
		}
		throw new Error(`Unexpected gateway request: ${JSON.stringify(params)}`)
	})
})

afterEach(() => {
	vi.useRealTimers()
})

describe("UpstreamMcpProbe", () => {
	it("returns the original tool catalog and metadata before shutting the adapter down", async () => {
		mcpClient.state.tools = [
			{
				name: "lookup",
				title: "Record lookup",
				description: "Look up a record",
				inputSchema: {
					type: "object",
					properties: { id: { type: "string" } },
					required: ["id"],
				},
				annotations: { readOnlyHint: true, destructiveHint: false },
			},
			{ name: "files.list" },
		]
		upstream.gatewayExecute.mockImplementation(async (_toolCallId, params) => {
			if (typeof params !== "object" || params === null) throw new Error("Expected gateway parameters")
			if ("connect" in params) return gatewayResult({ tools: ["lookup", "read_fixture_note"] })
			throw new Error(`Unexpected gateway request: ${JSON.stringify(params)}`)
		})

		const result = await new UpstreamMcpProbe().probeTools(
			"fixture",
			{ command: "node", args: ["server.js"], includeTools: ["lookup"] },
			{ authenticate: true, cwd: "/work" },
		)

		expect(result).toEqual({
			tools: [
				{
					name: "lookup",
					title: "Record lookup",
					description: "Look up a record",
					inputSchema: {
						type: "object",
						properties: { id: { type: "string" } },
						required: ["id"],
					},
					annotations: { readOnlyHint: true, destructiveHint: false },
				},
				{ name: "files.list" },
			],
			needsAuth: false,
			error: null,
		})
		expect(upstream.options?.config).toMatchObject({
			mcpServers: {
				fixture: { command: "node", args: ["server.js"], directTools: false, lifecycle: "lazy" },
			},
			settings: { autoAuth: true, directTools: false, scriptMode: false },
		})
		expect(installKeyringRequireBridge).toHaveBeenCalledOnce()
		expect(upstream.sessionStart).toHaveBeenCalledOnce()
		expect(upstream.sessionShutdown).toHaveBeenCalledOnce()
	})

	it.each([
		{ definition: { command: "node" }, timeoutMs: 15_000 },
		{ definition: { url: "https://example.test/mcp" }, timeoutMs: 60_000 },
	])("aborts a stalled connection after $timeoutMs ms and cleans up", async ({ definition, timeoutMs }) => {
		vi.useFakeTimers()
		upstream.gatewayExecute.mockImplementation(() => new Promise(() => {}))
		const result = new UpstreamMcpProbe().probeTools("deadline", definition, { authenticate: true })
		await vi.advanceTimersByTimeAsync(timeoutMs - 1)
		const signal = upstream.gatewayExecute.mock.calls[0][2]
		expect(signal?.aborted).toBe(false)
		expect(upstream.sessionShutdown).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(1)

		expect(await result).toMatchObject({
			tools: [],
			needsAuth: false,
			error: expect.stringContaining(`Probe timed out after ${timeoutMs / 1000} seconds`),
		})
		expect(signal?.aborted).toBe(true)
		expect(upstream.sessionShutdown).toHaveBeenCalledOnce()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("includes adapter startup in the total deadline", async () => {
		vi.useFakeTimers()
		upstream.sessionStart.mockImplementation(() => new Promise(() => {}))
		const result = new UpstreamMcpProbe().probeTools("slow-startup", { command: "node" })

		await vi.advanceTimersByTimeAsync(15_000)

		expect(await result).toEqual({ tools: [], needsAuth: false, error: "Probe timed out after 15 seconds" })
		expect(upstream.gatewayExecute).not.toHaveBeenCalled()
		expect(upstream.sessionShutdown).toHaveBeenCalledOnce()
	})

	it("does not initialize an already cancelled probe", async () => {
		const controller = new AbortController()
		controller.abort(new Error("cancelled before startup"))

		await expect(
			new UpstreamMcpProbe().probeTools("cancelled", { command: "node" }, { signal: controller.signal }),
		).rejects.toThrow("cancelled before startup")
		expect(upstream.sessionStart).not.toHaveBeenCalled()
	})

	it.each([
		{ authenticate: false, expectedError: null },
		{ authenticate: true, expectedError: "Authorization required" },
	])("maps auth-required results when authenticate=$authenticate", async ({ authenticate, expectedError }) => {
		upstream.gatewayExecute.mockResolvedValue(
			gatewayResult({ error: "auth_required", message: "Authorization required" }),
		)

		await expect(
			new UpstreamMcpProbe().probeTools(`auth-${authenticate}`, { url: "https://example.test/mcp" }, { authenticate }),
		).resolves.toEqual({ tools: [], needsAuth: true, error: expectedError })
		expect(upstream.sessionShutdown).toHaveBeenCalledOnce()
	})

	it("uses the real server name when credentials match the configured URL", async () => {
		const name = "matching-url"
		const url = "https://example.test/mcp"
		updateMcpOAuthTokensForUrl(name, url, { accessToken: "existing-token" })

		await new UpstreamMcpProbe().probeTools(name, { url })

		expect(inspectMcpOAuthTokensForUrl(name, url).status).toBe("present")
		expect(configuredServerNames()).toEqual([name])
		expect(upstream.logout).not.toHaveBeenCalled()
	})

	it("uses the real server name when no credential account exists", async () => {
		const name = "no-credentials"

		await new UpstreamMcpProbe().probeTools(name, { url: "https://example.test/mcp" })

		expect(configuredServerNames()).toEqual([name])
		expect(upstream.logout).not.toHaveBeenCalled()
	})

	it("uses the real server name for a matching partial OAuth account", async () => {
		const name = "oauth-in-progress"
		const url = "https://example.test/mcp"
		credentialAccount.value = { status: "present", serverUrl: url }

		await new UpstreamMcpProbe().probeTools(name, { url }, { authenticate: true })

		expect(configuredServerNames()).toEqual([name])
		expect(upstream.logout).not.toHaveBeenCalled()
	})

	it("isolates a URL probe when the credential account cannot be inspected", async () => {
		const name = "unavailable-account"
		credentialAccount.value = { status: "unavailable" }

		await new UpstreamMcpProbe().probeTools(name, { url: "https://example.test/mcp" })

		const [probeName] = configuredServerNames()
		expect(probeName).toMatch(/^__probe_[0-9a-f-]{36}$/)
		expect(upstream.logout).toHaveBeenCalledWith(`logout ${probeName}`, expect.anything())
	})

	it("isolates orphaned credentials when their stored URL is not discoverable from config", async () => {
		const name = "different-url"
		const storedUrl = "https://old.example.test/mcp"
		const probedUrl = "https://new.example.test/mcp"
		credentialAccount.value = { status: "present", serverUrl: storedUrl }
		updateMcpOAuthTokensForUrl(name, storedUrl, { accessToken: "preserve-me" })

		await new UpstreamMcpProbe().probeTools(name, { url: probedUrl }, { authenticate: true })

		const [probeName] = configuredServerNames()
		expect(probeName).toMatch(/^__probe_[0-9a-f-]{36}$/)
		expect(upstream.logout).toHaveBeenCalledWith(`logout ${probeName}`, expect.anything())
		expect(inspectMcpOAuthTokensForUrl(name, storedUrl).status).toBe("present")
	})

	it("cleans up an isolated credential entry when probing throws", async () => {
		const name = "different-url-failure"
		const storedUrl = "https://old.example.test/mcp"
		credentialAccount.value = { status: "present", serverUrl: storedUrl }
		updateMcpOAuthTokensForUrl(name, storedUrl, { accessToken: "preserve-me" })
		upstream.gatewayExecute.mockRejectedValue(new Error("connect failed"))

		await expect(
			new UpstreamMcpProbe().probeTools(name, { url: "https://new.example.test/mcp" }, { authenticate: true }),
		).rejects.toThrow("connect failed")

		const [probeName] = configuredServerNames()
		expect(upstream.logout).toHaveBeenCalledWith(`logout ${probeName}`, expect.anything())
		expect(upstream.sessionShutdown).toHaveBeenCalledOnce()
		expect(inspectMcpOAuthTokensForUrl(name, storedUrl).status).toBe("present")
	})

	it("shuts the adapter down when probing throws", async () => {
		upstream.gatewayExecute.mockRejectedValue(new Error("connect failed"))

		await expect(new UpstreamMcpProbe().probeTools("failed", { command: "node", args: ["server.js"] })).rejects.toThrow(
			"connect failed",
		)
		expect(upstream.sessionShutdown).toHaveBeenCalledOnce()
	})

	it("shuts the adapter down when a probe is aborted", async () => {
		const controller = new AbortController()
		let markGatewayStarted: () => void = () => {}
		const gatewayStarted = new Promise<void>((resolve) => {
			markGatewayStarted = resolve
		})
		upstream.gatewayExecute.mockImplementation(
			(_toolCallId, _params, signal) =>
				new Promise((_resolve, reject) => {
					markGatewayStarted()
					if (signal?.aborted) {
						reject(signal.reason)
						return
					}
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
				}),
		)
		const result = new UpstreamMcpProbe().probeTools(
			"aborted",
			{ command: "node", args: ["server.js"] },
			{ signal: controller.signal },
		)

		await gatewayStarted
		controller.abort(new Error("probe aborted"))

		await expect(result).rejects.toThrow("probe aborted")
		expect(upstream.sessionShutdown).toHaveBeenCalledOnce()
	})
})
