import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { McpAdapterOptions } from "pi-mcp-adapter/types"
import { Type } from "typebox"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const upstream = vi.hoisted(() => ({
	options: undefined as McpAdapterOptions | undefined,
	gatewayExecute: vi.fn<ToolDefinition["execute"]>(),
	logout: vi.fn(),
	mcpAuth: vi.fn<(args: string, ctx: unknown) => Promise<void>>(),
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
		api.registerCommand("mcp-auth", {
			description: "Authenticate with an MCP server (OAuth)",
			handler: async (args, ctx) => upstream.mcpAuth(args, ctx),
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
	upstream.mcpAuth.mockReset()
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

	// The declared-OAuth URL server case is deliberately absent here: with
	// authenticate=true its first connect races the interactive consent budget
	// instead of the 60s deadline (see the connect-time auth tests below).
	it.each([
		{ definition: { command: "node" }, timeoutMs: 15_000 },
		{ definition: { url: "https://example.test/mcp" }, timeoutMs: 60_000 },
		{ definition: { url: "https://example.test/mcp", auth: false as const }, timeoutMs: 60_000 },
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
			error: `Probe timed out after ${timeoutMs / 1000} seconds`,
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

	it("keeps explicit auth oauth declared when custom headers are configured", async () => {
		mcpClient.state.tools = [{ name: "search" }]

		const result = await new UpstreamMcpProbe().probeTools(
			"explicit-oauth-with-headers",
			{ url: "https://example.test/mcp", auth: "oauth", headers: { Authorization: "Basic dXNlcjpwYXNz" } },
			{ authenticate: false },
		)

		// Upstream supportsOAuth returns true for explicit auth:"oauth" BEFORE its
		// headers check; headers only suppress implicit auto-detection.
		expect(result).toEqual({ tools: [{ name: "search" }], needsAuth: true, error: null })
		expect(upstream.mcpAuth).not.toHaveBeenCalled()
	})

	it("lets custom headers veto only implicit oauth auto-detection", async () => {
		mcpClient.state.tools = [{ name: "search" }]

		const result = await new UpstreamMcpProbe().probeTools(
			"implicit-oauth-with-headers",
			{
				url: "https://example.test/mcp",
				oauth: { clientName: "kimchi" },
				headers: { Authorization: "Basic dXNlcjpwYXNz" },
			},
			{ authenticate: false },
		)

		// An oauth block without auth:"oauth" is implicit: headers suppress it and
		// the server stays on the connected path.
		expect(result).toEqual({ tools: [{ name: "search" }], needsAuth: false, error: null })
		expect(upstream.mcpAuth).not.toHaveBeenCalled()
	})

	it("survives a slow autoAuth consent inside the first connect that outlasts the probe deadline", async () => {
		vi.useFakeTimers()
		mcpClient.state.tools = [{ name: "search" }]
		const name = "slow-auto-auth"
		const url = "https://drivemcp.example.test/mcp"
		upstream.gatewayExecute.mockImplementation(async (_toolCallId, params) => {
			if (typeof params === "object" && params !== null && "connect" in params) {
				// Simulate upstream's attemptAutoAuth: the consent completes at 90s,
				// past the 60s probe deadline but within the 300s consent budget.
				await new Promise((resolve) => setTimeout(resolve, 90_000))
				updateMcpOAuthTokensForUrl(name, url, { accessToken: "auto-stored-token" })
				return gatewayResult({ tools: ["search"] })
			}
			throw new Error(`Unexpected gateway request: ${JSON.stringify(params)}`)
		})

		const probe = new UpstreamMcpProbe().probeTools(name, { url, auth: "oauth" }, { authenticate: true })

		await vi.advanceTimersByTimeAsync(60_000)
		// The suspended 60s deadline must not have fired mid-consent.
		expect(upstream.sessionShutdown).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(30_000)

		await expect(probe).resolves.toEqual({ tools: [{ name: "search" }], needsAuth: false, error: null })
		expect(upstream.mcpAuth).not.toHaveBeenCalled()
	})

	it("skips mcp-auth when autoAuth during the first connect stores credentials", async () => {
		mcpClient.state.tools = [{ name: "search" }]
		const name = "auto-auth-during-connect"
		const url = "https://drivemcp.example.test/mcp"
		upstream.gatewayExecute.mockImplementation(async (_toolCallId, params) => {
			if (typeof params === "object" && params !== null && "connect" in params) {
				// 401-at-connect server: attemptAutoAuth stores tokens inside connect.
				updateMcpOAuthTokensForUrl(name, url, { accessToken: "auto-stored-token" })
				return gatewayResult({ tools: ["search"] })
			}
			throw new Error(`Unexpected gateway request: ${JSON.stringify(params)}`)
		})

		const result = await new UpstreamMcpProbe().probeTools(name, { url, auth: "oauth" }, { authenticate: true })

		// Credentials exist post-connect: the redundant mcp-auth run is skipped.
		expect(upstream.mcpAuth).not.toHaveBeenCalled()
		expect(inspectMcpOAuthTokensForUrl(name, url).status).toBe("present")
		expect(result).toEqual({ tools: [{ name: "search" }], needsAuth: false, error: null })
	})

	it("reports needs-auth and unwinds the flow when the connect-time consent budget expires", async () => {
		vi.useFakeTimers()
		type PromptUi = Record<"input" | "select" | "confirm", (...args: unknown[]) => Promise<unknown>>
		let capturedUi: PromptUi | undefined
		upstream.gatewayExecute.mockImplementation((_toolCallId, params, _signal, _runContext, ctx: unknown) => {
			if (typeof params === "object" && params !== null && "connect" in params) {
				capturedUi = (ctx as { ui: PromptUi }).ui
				// Park on the consent wait; it unwinds only when the auth signal
				// aborts (real callback never arrives in this test).
				return new Promise(() => {})
			}
			throw new Error(`Unexpected gateway request: ${JSON.stringify(params)}`)
		})
		const name = "connect-auth-timeout"
		const url = "https://drivemcp.example.test/mcp"

		const probe = new UpstreamMcpProbe().probeTools(name, { url, auth: "oauth" }, { authenticate: true })

		await vi.advanceTimersByTimeAsync(60_000)
		// The suspended 60s deadline must not have fired mid-consent.
		expect(upstream.sessionShutdown).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(240_000)

		await expect(probe).resolves.toEqual({
			tools: [],
			needsAuth: true,
			error: "OAuth authentication timed out after 300 seconds",
		})
		// The aborted auth signal rejected the hook, unwinding the parked flow.
		await expect(capturedUi?.input("consent")).rejects.toThrow(/OAuth authentication timed out after 300 seconds/)
	})

	it("reports needs-auth for a declared OAuth server without credentials even when anonymous listing succeeds", async () => {
		mcpClient.state.tools = [{ name: "search" }]

		const result = await new UpstreamMcpProbe().probeTools(
			"google-drive-fresh",
			{ url: "https://drivemcp.example.test/mcp", auth: "oauth" },
			{ authenticate: false },
		)

		expect(result).toEqual({ tools: [{ name: "search" }], needsAuth: true, error: null })
		expect(upstream.mcpAuth).not.toHaveBeenCalled()
		expect(upstream.sessionShutdown).toHaveBeenCalledOnce()
	})

	it("drives the OAuth flow when authenticate=true and captured credentials succeed", async () => {
		mcpClient.state.tools = [{ name: "search" }]
		const name = "google-drive-auth"
		const url = "https://drivemcp.example.test/mcp"
		upstream.mcpAuth.mockImplementation(async (args: string) => {
			updateMcpOAuthTokensForUrl(args.trim(), url, { accessToken: "fresh-token" })
		})

		const result = await new UpstreamMcpProbe().probeTools(name, { url, auth: "oauth" }, { authenticate: true })

		expect(upstream.mcpAuth).toHaveBeenCalledWith(name, expect.anything())
		expect(inspectMcpOAuthTokensForUrl(name, url).status).toBe("present")
		expect(result).toEqual({ tools: [{ name: "search" }], needsAuth: false, error: null })
	})

	it("reports needs-auth without tools when the OAuth flow is cancelled or fails", async () => {
		const name = "google-drive-cancel"
		const url = "https://drivemcp.example.test/mcp"
		upstream.mcpAuth.mockResolvedValue(undefined)

		const result = await new UpstreamMcpProbe().probeTools(name, { url, auth: "oauth" }, { authenticate: true })

		expect(upstream.mcpAuth).toHaveBeenCalledOnce()
		expect(inspectMcpOAuthTokensForUrl(name, url).status).toBe("absent")
		expect(result).toEqual({ tools: [], needsAuth: true, error: null })
	})

	it("treats a credentialed OAuth server as connected without invoking auth", async () => {
		mcpClient.state.tools = [{ name: "search" }]
		const name = "google-drive-credentialed"
		const url = "https://drivemcp.example.test/mcp"
		updateMcpOAuthTokensForUrl(name, url, { accessToken: "existing-token" })

		const result = await new UpstreamMcpProbe().probeTools(name, { url, auth: "oauth" }, { authenticate: true })

		expect(upstream.mcpAuth).not.toHaveBeenCalled()
		expect(result).toEqual({ tools: [{ name: "search" }], needsAuth: false, error: null })
	})

	it("leaves servers without declared OAuth on the connected path", async () => {
		mcpClient.state.tools = [{ name: "search" }]

		const result = await new UpstreamMcpProbe().probeTools(
			"plain",
			{ url: "https://example.test/mcp" },
			{ authenticate: false },
		)

		expect(result).toEqual({ tools: [{ name: "search" }], needsAuth: false, error: null })
		expect(upstream.mcpAuth).not.toHaveBeenCalled()
	})

	it("does not run the OAuth flow under a throwaway probe name", async () => {
		mcpClient.state.tools = [{ name: "search" }]
		const name = "different-url-auth"
		const storedUrl = "https://old.example.test/mcp"
		const probedUrl = "https://new.example.test/mcp"
		credentialAccount.value = { status: "present", serverUrl: storedUrl }
		updateMcpOAuthTokensForUrl(name, storedUrl, { accessToken: "preserve-me" })

		const result = await new UpstreamMcpProbe().probeTools(
			name,
			{ url: probedUrl, auth: "oauth" },
			{ authenticate: true },
		)

		// Never drive a browser consent the finally-block logout would discard.
		expect(upstream.mcpAuth).not.toHaveBeenCalled()
		expect(result).toEqual({ tools: [{ name: "search" }], needsAuth: true, error: null })
		const [probeName] = configuredServerNames()
		expect(probeName).toMatch(/^__probe_[0-9a-f-]{36}$/)
		expect(upstream.logout).toHaveBeenCalledWith(`logout ${probeName}`, expect.anything())
		expect(inspectMcpOAuthTokensForUrl(name, storedUrl).status).toBe("present")
	})

	it("keeps a stdio server with auth oauth on the connected path", async () => {
		mcpClient.state.tools = [{ name: "search" }]

		const result = await new UpstreamMcpProbe().probeTools(
			"stdio-oauth",
			{ command: "node", args: ["server.js"], auth: "oauth" },
			{ authenticate: true },
		)

		// stdio cannot run the browser flow: the URL gate keeps it connected.
		expect(result).toEqual({ tools: [{ name: "search" }], needsAuth: false, error: null })
		expect(upstream.mcpAuth).not.toHaveBeenCalled()
	})

	it("treats an explicit oauth false sentinel as a non-OAuth server", async () => {
		mcpClient.state.tools = [{ name: "search" }]
		const url = "https://example.test/mcp"

		const result = await new UpstreamMcpProbe().probeTools(
			"oauth-disabled",
			{ url, auth: "oauth", oauth: false },
			{ authenticate: false },
		)

		// Mirrors upstream supportsOAuth: the explicit sentinel wins over `auth: "oauth"`.
		expect(result).toEqual({ tools: [{ name: "search" }], needsAuth: false, error: null })
		expect(upstream.mcpAuth).not.toHaveBeenCalled()
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

	it("rejects the interactive ui hooks when the probe aborts so the OAuth flow unwinds", async () => {
		type PromptUi = Record<"input" | "select" | "confirm", (...args: unknown[]) => Promise<unknown>>
		let capturedUi: PromptUi | undefined
		upstream.mcpAuth.mockImplementation(async (_args: string, ctx: unknown) => {
			capturedUi = (ctx as { ui: PromptUi }).ui
			// Simulate the upstream flow parked on the consent wait.
			return new Promise<void>(() => {})
		})
		const controller = new AbortController()
		const probe = new UpstreamMcpProbe().probeTools(
			"ui-hooks",
			{ url: "https://drivemcp.example.test/mcp", auth: "oauth" },
			{ authenticate: true, signal: controller.signal },
		)

		// Upstream's authenticateServer races the localhost callback against a manual-paste
		// prompt via ui.input; a resolving fake would win that race and tear the flow down.
		await vi.waitFor(() => expect(upstream.mcpAuth).toHaveBeenCalledOnce())
		const ui = capturedUi
		expect(ui).toBeDefined()

		// While the flow is active the hooks stay pending — only the real callback
		// (or an abort) may settle them.
		for (const hook of ["input", "select", "confirm"] as const) {
			const outcome = await Promise.race([
				ui?.[hook]("prompt").then(
					() => "settled" as const,
					() => "settled" as const,
				),
				new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
			])
			expect(outcome).toBe("pending")
		}

		controller.abort(new Error("aborted during consent"))
		await expect(probe).rejects.toThrow("aborted during consent")

		// On abort the hooks reject, so upstream's manual-paste race loses and the
		// flow unwinds (closing its localhost callback listener) instead of lingering.
		for (const hook of ["input", "select", "confirm"] as const) {
			await expect(ui?.[hook]("prompt")).rejects.toThrow("aborted during consent")
		}
	})

	it("aborts the interactive ui hooks when the interactive auth timeout fires", async () => {
		vi.useFakeTimers()
		type PromptUi = Record<"input" | "select" | "confirm", (...args: unknown[]) => Promise<unknown>>
		let capturedUi: PromptUi | undefined
		upstream.mcpAuth.mockImplementation(async (_args: string, ctx: unknown) => {
			capturedUi = (ctx as { ui: PromptUi }).ui
			// Park the flow on the manual-paste prompt; it unwinds only when the
			// hook rejects (real callback never arrives in this test).
			await new Promise<void>((_, reject) => {
				capturedUi?.input("paste the code").then(
					() => {},
					(error) => reject(error),
				)
			})
		})
		const name = "ui-hooks-timeout"
		const url = "https://drivemcp.example.test/mcp"
		const probe = new UpstreamMcpProbe().probeTools(name, { url, auth: "oauth" }, { authenticate: true })

		await vi.advanceTimersByTimeAsync(1_000)
		expect(upstream.mcpAuth).toHaveBeenCalledOnce()
		expect(capturedUi).toBeDefined()

		await vi.advanceTimersByTimeAsync(300_000)

		// The timeout is swallowed into credential re-inspection → needs-auth.
		await expect(probe).resolves.toEqual({
			tools: [],
			needsAuth: true,
			error: "OAuth authentication timed out after 300 seconds",
		})
		// The aborted auth signal rejected the hook, unwinding the parked flow.
		await expect(capturedUi?.input("paste the code")).rejects.toThrow(
			/OAuth authentication timed out after 300 seconds/,
		)
	})

	it("surfaces the interactive auth failure when the post-auth reconnect reports auth_required", async () => {
		const name = "google-drive-reconnect-denied"
		const url = "https://drivemcp.example.test/mcp"
		upstream.mcpAuth.mockImplementation(async (args: string) => {
			// Tokens got stored, but the interactive attempt was denied downstream;
			// the handler still reports its failure reason.
			updateMcpOAuthTokensForUrl(args.trim(), url, { accessToken: "rejected-token" })
			throw new Error("consent denied: insufficient scope")
		})
		upstream.gatewayExecute.mockImplementation(async (_toolCallId, params) => {
			if (typeof params === "object" && params !== null && "connect" in params) {
				// First connect succeeds anonymously; only the post-auth reconnect
				// reports auth_required.
				if (upstream.gatewayExecute.mock.calls.length === 1) {
					return gatewayResult({ tools: [] })
				}
				return gatewayResult({ error: "auth_required", message: "Authorization required" })
			}
			throw new Error(`Unexpected gateway request: ${JSON.stringify(params)}`)
		})
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		try {
			const result = await new UpstreamMcpProbe().probeTools(name, { url, auth: "oauth" }, { authenticate: true })

			expect(result).toEqual({ tools: [], needsAuth: true, error: "consent denied: insufficient scope" })
		} finally {
			warn.mockRestore()
		}
	})

	it("surfaces an interactive OAuth failure in the result error instead of swallowing it", async () => {
		const name = "google-drive-auth-failure"
		const url = "https://drivemcp.example.test/mcp"
		upstream.mcpAuth.mockRejectedValue(new Error("OAuth authentication cancelled"))
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		try {
			const result = await new UpstreamMcpProbe().probeTools(name, { url, auth: "oauth" }, { authenticate: true })

			expect(result).toEqual({ tools: [], needsAuth: true, error: "OAuth authentication cancelled" })
			expect(warn).toHaveBeenCalledWith(
				`MCP probe: interactive OAuth for "${name}" failed: OAuth authentication cancelled`,
			)
		} finally {
			warn.mockRestore()
		}
	})
})
