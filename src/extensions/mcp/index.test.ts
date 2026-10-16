import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { MCP_RUNTIME_REGISTER_EVENT, type McpRuntimeRegistrationRequest } from "pi-mcp-adapter"
import type { McpAdapterOptions, McpConfig, ServerEntry } from "pi-mcp-adapter/types"
import { Type } from "typebox"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type * as CliArgs from "../../cli-args.js"
import type * as ToolProfileManager from "../../shared/planning/tool-profile-manager.js"
import { createCommandContext, createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"

const upstream = vi.hoisted(() => ({
	api: undefined as ExtensionAPI | undefined,
	options: undefined as McpAdapterOptions | undefined,
	input: vi.fn(),
	sessionStart: vi.fn(),
}))
const configState = vi.hoisted(() => ({
	config: { mcpServers: {} } as McpConfig,
	userConfig: { mcpServers: {} } as McpConfig,
	configPath: undefined as string | undefined,
	useProgrammaticConfig: false,
	warnings: [] as string[],
	legacyKeys: [] as string[],
}))
const cliState = vi.hoisted(() => ({
	mcpConfig: undefined as string | undefined,
	approve: undefined as boolean | undefined,
	noApprove: undefined as boolean | undefined,
	plan: false,
}))
const planning = vi.hoisted(() => ({
	applyCooperativeTweak: vi.fn(() => true),
	currentProfile: undefined as "planning-adhoc" | "planning-ferment" | "idle" | undefined,
	reapplyCurrentProfile: vi.fn<typeof ToolProfileManager.reapplyCurrentProfile>(() => false),
	registerReadOnlyToolProvider: vi.fn<typeof ToolProfileManager.registerReadOnlyToolProvider>(() => () => {}),
}))
const permissionState = vi.hoisted(() => ({
	mode: undefined as "ask" | "auto" | "plan" | "yolo" | undefined,
}))
const oauthMigration = vi.hoisted(() => ({ warnings: [] as string[] }))
const oauthBranding = vi.hoisted(() => ({ install: vi.fn() }))
const projectTrust = vi.hoisted(() => ({ trusted: true }))
const readOnlyState = vi.hoisted(() => ({ wireNames: new Set<string>() }))
const gatewayState = vi.hoisted(() => ({
	server: undefined as { name: string; entry: ServerEntry } | undefined,
	addresses: ["https://api.cast.ai/mcp"],
}))

vi.mock("pi-mcp-adapter", () => ({
	MCP_STATUS_EVENT: "pi-mcp-adapter/status/v1",
	MCP_RUNTIME_REGISTER_EVENT: "pi-mcp-adapter:runtime-register:v1",
	MCP_RUNTIME_REGISTER_VERSION: 1,
	createMcpAdapter: vi.fn((options: McpAdapterOptions) => (api: ExtensionAPI) => {
		upstream.options = options
		upstream.api = api
		api.on("session_start", upstream.sessionStart)
		api.on("input", upstream.input)
	}),
}))

// Other CLI helpers stay real, so only the parsed arguments are replaced.
vi.mock("../../cli-args.js", async (importOriginal) => ({
	...(await importOriginal<typeof CliArgs>()),
	getParsedCliArgs: () => ({
		options: {
			"mcp-config": cliState.mcpConfig,
			approve: cliState.approve,
			"no-approve": cliState.noApprove,
			plan: cliState.plan,
		},
		positionals: [],
	}),
}))

vi.mock("./config.js", () => ({
	loadKimchiMcpConfig: (options: { includeProjectSources?: boolean }) =>
		options.includeProjectSources === false
			? { config: configState.userConfig, useProgrammaticConfig: true, warnings: [] }
			: {
					config: configState.config,
					configPath: configState.configPath,
					...(configState.useProgrammaticConfig ? { useProgrammaticConfig: true } : {}),
					warnings: configState.warnings,
				},
}))

// The real gateway address matcher runs; only the environment-derived inputs are stubbed.
vi.mock("./gateway.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./gateway.js")>()),
	buildBuiltinGatewayServer: () => gatewayState.server,
	getGatewayAddresses: () => gatewayState.addresses,
}))

vi.mock("../../config.js", () => ({
	getConfiguredLegacyMcpKeys: () => configState.legacyKeys,
}))

vi.mock("../../shared/planning/tool-profile-manager.js", () => ({
	applyCooperativeTweak: planning.applyCooperativeTweak,
	debugToolSurface: vi.fn(),
	getCurrentProfile: () => planning.currentProfile,
	reapplyCurrentProfile: planning.reapplyCurrentProfile,
	registerReadOnlyToolProvider: planning.registerReadOnlyToolProvider,
}))

// Wire names carry their server's prefix, as with the adapter's default "server" prefix mode.
vi.mock("./read-only.js", () => ({
	collectReadOnlyMcpWireNames: (_config: McpConfig, server?: string) =>
		[...readOnlyState.wireNames].filter((name) => server === undefined || name.startsWith(`${server}_`)),
}))

vi.mock("../permissions/mode-controller.js", () => ({
	getPermissionMode: () => (permissionState.mode === undefined ? undefined : { mode: permissionState.mode }),
}))

vi.mock("./oauth-migration.js", () => ({
	migrateLegacyOAuthCredentials: vi.fn(() => ({
		migratedServerNames: [],
		warnings: oauthMigration.warnings,
	})),
}))

vi.mock("./oauth-callback-branding.js", () => ({
	brandMcpAdapterOwnedToolResult: (result: unknown) => result,
	brandMcpAdapterText: (text: string) => text.replaceAll("Pi", "Kimchi"),
	createBrandedMcpContext: (ctx: unknown) => ctx,
	installMcpOAuthCallbackBranding: oauthBranding.install,
}))

vi.mock("./project-trust.js", () => ({
	MCP_PROJECT_TRUST_WARNING: "project MCP config is not trusted",
	resolveMcpProjectTrust: vi.fn(async () => projectTrust.trusted),
}))

import mcpAdapterExtension, { createKimchiMcpAdapterExtension } from "./index.js"

function tool(name: string, label: string): ToolDefinition {
	return {
		name,
		label,
		description: `${name} description`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	}
}

async function start(
	harness: ReturnType<typeof createExtensionApi>,
	ctx = createContext({ isProjectTrusted: () => true }),
) {
	await harness.getHandler("session_start")({ type: "session_start", reason: "startup" }, ctx)
	return ctx
}

describe("upstream MCP adapter facade", () => {
	beforeEach(() => {
		upstream.api = undefined
		upstream.options = undefined
		upstream.input.mockReset()
		upstream.sessionStart.mockReset()
		configState.config = { mcpServers: {} }
		configState.userConfig = { mcpServers: {} }
		configState.configPath = undefined
		configState.useProgrammaticConfig = false
		configState.warnings = []
		configState.legacyKeys = []
		oauthMigration.warnings = []
		oauthBranding.install.mockClear()
		cliState.mcpConfig = undefined
		cliState.approve = undefined
		cliState.noApprove = undefined
		cliState.plan = false
		projectTrust.trusted = true
		gatewayState.server = undefined
		gatewayState.addresses = ["https://api.cast.ai/mcp"]
		planning.currentProfile = undefined
		permissionState.mode = undefined
		readOnlyState.wireNames.clear()
		planning.applyCooperativeTweak.mockClear()
		planning.reapplyCurrentProfile.mockReset().mockReturnValue(false)
	})

	it.each([
		"",
		"status",
		"setup",
		"unknown",
	])("shows manual configuration guidance for /mcp %s with no servers", async (args) => {
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		await start(harness)
		const handler = vi.fn()
		upstream.api?.registerCommand("mcp", { handler })
		const command = vi.mocked(harness.api.registerCommand).mock.calls[0][1]
		const ctx = createCommandContext()

		await command.handler(args, ctx)

		expect(handler).not.toHaveBeenCalled()
		expect(ctx.ui.custom).not.toHaveBeenCalled()
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(".mcp.json"), "info")
	})

	it("disables preset setup while preserving the configured-server panel and command completions", async () => {
		configState.config = { mcpServers: { github: { url: "https://example.test/mcp" } } }
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		await start(harness)
		const handler = vi.fn()
		upstream.api?.registerCommand("mcp", {
			handler,
			getArgumentCompletions: (prefix) =>
				["setup", "status"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		})
		const command = vi.mocked(harness.api.registerCommand).mock.calls[0][1]
		const ctx = createCommandContext()

		await command.handler(" setup ", ctx)
		expect(handler).not.toHaveBeenCalled()
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(".mcp.json"), "info")
		expect(await command.getArgumentCompletions?.("")).toEqual([{ value: "status", label: "status" }])
		expect(await command.getArgumentCompletions?.("setup")).toBeNull()

		await command.handler("", ctx)
		expect(handler).toHaveBeenCalledWith("", ctx)
		await command.handler("reconnect github", ctx)
		expect(handler).toHaveBeenCalledWith("reconnect github", ctx)
	})

	it("installs the Kimchi OAuth callback-page decorator", () => {
		const { api } = createExtensionApi()

		mcpAdapterExtension(api)

		expect(oauthBranding.install).toHaveBeenCalledOnce()
	})

	it("defers adapter installation until project trust is resolved", async () => {
		const harness = createExtensionApi()

		mcpAdapterExtension(harness.api)
		expect(upstream.api).toBeUndefined()
		expect(harness.getHandlers("input")).toHaveLength(1)

		await start(harness)
		await harness.getHandler("input")({ type: "input", text: "hello" }, createContext())

		expect(upstream.api).toBeDefined()
		expect(upstream.sessionStart).toHaveBeenCalledOnce()
		expect(upstream.input).toHaveBeenCalledOnce()
		expect(harness.getHandlers("input")).toHaveLength(1)
	})

	it("keeps the upstream adapter in file-backed mode", async () => {
		configState.config = {
			mcpServers: { docs: { url: "https://example.test/mcp" } },
			settings: { scriptMode: false },
		}
		cliState.mcpConfig = "/tmp/mcp.json"
		configState.configPath = "/tmp/mcp.json"
		const harness = createExtensionApi()

		mcpAdapterExtension(harness.api)
		await start(harness)

		expect(upstream.options).toEqual({ configPath: "/tmp/mcp.json" })
		expect(upstream.api).toBeDefined()
	})

	it("uses the resolved config when selected-file precedence requires an overlay", async () => {
		configState.config = { mcpServers: { docs: { command: "selected-server" } } }
		configState.configPath = "/tmp/mcp.json"
		configState.useProgrammaticConfig = true
		const harness = createExtensionApi()

		mcpAdapterExtension(harness.api)
		await start(harness)

		expect(upstream.options).toEqual({ config: configState.config })
	})

	describe("built-in gateway runtime registration", () => {
		const gatewayServer = {
			name: "kimchi-mcp-gateway",
			entry: {
				url: "https://api.cast.ai/mcp",
				headers: { Authorization: "Bearer test" },
				lifecycle: "keep-alive" as const,
			},
		}

		/** Simulates the real adapter's synchronous answer on the event bus. */
		function captureRuntimeRegistrations(
			harness: ReturnType<typeof createExtensionApi>,
		): McpRuntimeRegistrationRequest[] {
			const requests: McpRuntimeRegistrationRequest[] = []
			harness.api.events.on(MCP_RUNTIME_REGISTER_EVENT, (raw: unknown) => {
				const request = raw as McpRuntimeRegistrationRequest
				request.result = { ok: true, registration: { dispose: async () => {} } }
				requests.push(request)
			})
			return requests
		}

		it("registers the enabled gateway as a runtime server, keeping file-backed mode", async () => {
			configState.config = { mcpServers: { docs: { url: "https://example.test/mcp" } } }
			configState.configPath = "/tmp/mcp.json"
			gatewayState.server = gatewayServer
			const harness = createExtensionApi()
			const registrations = captureRuntimeRegistrations(harness)

			mcpAdapterExtension(harness.api)
			await start(harness)

			expect(upstream.options).toEqual({ configPath: "/tmp/mcp.json" })
			expect(registrations).toHaveLength(1)
			expect(registrations[0]?.name).toBe("kimchi-mcp-gateway")
			expect(registrations[0]?.definition).toEqual(gatewayServer.entry)
		})

		it("does not register the gateway when the resource is disabled", async () => {
			configState.config = { mcpServers: { docs: { url: "https://example.test/mcp" } } }
			configState.configPath = "/tmp/mcp.json"
			const harness = createExtensionApi()
			const registrations = captureRuntimeRegistrations(harness)

			mcpAdapterExtension(harness.api)
			await start(harness)

			expect(upstream.options).toEqual({ configPath: "/tmp/mcp.json" })
			expect(registrations).toEqual([])
		})

		it("skips runtime registration when a configured server already uses a gateway address", async () => {
			configState.config = { mcpServers: { manual: { url: "https://api.eu.cast.ai/mcp" } } }
			configState.configPath = "/tmp/mcp.json"
			gatewayState.server = gatewayServer
			// Production derives every region's gateway URL — see gateway.test.ts.
			gatewayState.addresses = ["https://api.cast.ai/mcp", "https://api.eu.cast.ai/mcp"]
			const harness = createExtensionApi()
			const registrations = captureRuntimeRegistrations(harness)

			mcpAdapterExtension(harness.api)
			await start(harness)

			expect(upstream.options).toEqual({ configPath: "/tmp/mcp.json" })
			expect(registrations).toEqual([])
		})

		it("skips runtime registration when a user server holds the gateway name at another address", async () => {
			configState.config = { mcpServers: { "kimchi-mcp-gateway": { url: "https://proxy.corp.example/mcp" } } }
			configState.configPath = "/tmp/mcp.json"
			gatewayState.server = gatewayServer
			const harness = createExtensionApi()
			const registrations = captureRuntimeRegistrations(harness)

			mcpAdapterExtension(harness.api)
			await start(harness)

			expect(upstream.options).toEqual({ configPath: "/tmp/mcp.json" })
			expect(registrations).toEqual([])
		})

		it("keeps the proxy tool reachable when the gateway is the only configured server", async () => {
			configState.config = { mcpServers: {} }
			configState.configPath = "/tmp/mcp.json"
			gatewayState.server = gatewayServer
			const harness = createExtensionApi()
			const registrations = captureRuntimeRegistrations(harness)

			mcpAdapterExtension(harness.api)
			await start(harness)

			expect(registrations).toHaveLength(1)
			// The gateway registers after adapter install; the policy must count it,
			// or an otherwise-empty config drops the proxy tool and strands the
			// gateway's tools (regression: https://github.com/getkimchi/kimchi/pull/1436).
			upstream.api?.registerTool(tool("mcp", "MCP"))
			expect(harness.getRegisteredTools().map(({ name }) => name)).toEqual(["mcp"])
		})

		it("registers the gateway in untrusted projects as a user-level server", async () => {
			projectTrust.trusted = false
			gatewayState.server = gatewayServer
			const harness = createExtensionApi()
			const registrations = captureRuntimeRegistrations(harness)

			mcpAdapterExtension(harness.api)
			await start(harness)

			// Untrusted projects load user config programmatically (pre-existing
			// behavior); the gateway still registers through the runtime API.
			expect(upstream.options).toEqual({ config: { mcpServers: {} } })
			expect(registrations).toHaveLength(1)
			expect(registrations[0]?.definition).toEqual(gatewayServer.entry)
		})

		it("skips runtime registration when a caller server holds the gateway name", async () => {
			gatewayState.server = gatewayServer
			const harness = createExtensionApi()
			const registrations = captureRuntimeRegistrations(harness)

			createKimchiMcpAdapterExtension({
				cwd: "/tmp",
				callerServers: { "kimchi-mcp-gateway": { url: "https://ide.local/mcp" } },
			})(harness.api)
			await start(harness)

			expect(upstream.options).toEqual({
				config: { mcpServers: { "kimchi-mcp-gateway": { url: "https://ide.local/mcp" } } },
			})
			expect(registrations).toEqual([])
		})
	})

	it("suppresses all model-facing MCP tools for an empty configuration", async () => {
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		await start(harness)

		upstream.api?.registerTool(tool("mcp", "MCP"))
		upstream.api?.registerTool(tool("mcpScript", "MCP Script"))
		upstream.api?.setActiveTools(["read", "mcp", "mcpScript"])

		expect(harness.getRegisteredTools()).toEqual([])
		expect(planning.applyCooperativeTweak).toHaveBeenCalledWith(harness.api, ["read"])
	})

	it("registers direct tools and reapplies the active profile", async () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		await start(harness)

		upstream.api?.registerTool(tool("docs_get_issue", "MCP: get_issue"))
		upstream.api?.registerTool(tool("docs_delete_issue", "MCP: delete_issue"))

		expect(harness.getRegisteredTools().map(({ name }) => name)).toEqual(["docs_get_issue", "docs_delete_issue"])
		expect(planning.reapplyCurrentProfile).toHaveBeenCalledTimes(2)
	})

	it("keeps the current profile authoritative over upstream active-tool synchronization", async () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		planning.reapplyCurrentProfile.mockReturnValue(true)
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		await start(harness)

		upstream.api?.setActiveTools(["read", "docs_delete_issue"])

		expect(planning.reapplyCurrentProfile).toHaveBeenCalledWith(harness.api)
		expect(planning.applyCooperativeTweak).not.toHaveBeenCalled()
	})

	it.each([
		"idle",
		"planning-adhoc",
	] as const)("keeps adapter removals excluded from later profiles when removed during %s", async (profile) => {
		const profiles = await vi.importActual<typeof ToolProfileManager>("../../shared/planning/tool-profile-manager.js")
		profiles.resetAll()
		planning.reapplyCurrentProfile.mockImplementation(profiles.reapplyCurrentProfile)
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		const harness = createExtensionApi()
		harness.api.registerTool(tool("read", "Read"))
		mcpAdapterExtension(harness.api)
		await start(harness)
		profiles.apply("idle", "adhoc", harness.api)
		const api = upstream.api
		if (!api) throw new Error("Adapter was not installed")
		api.registerTool(tool("docs_get_issue", "MCP: get_issue"))
		api.registerTool(tool("docs_delete_issue", "MCP: delete_issue"))
		profiles.apply(profile, "adhoc", harness.api)

		// This is upstream's fallback when the host has no unregisterTool.
		const active = api.getActiveTools()
		expect(active).toContain("docs_delete_issue")
		api.setActiveTools(active.filter((name) => name !== "docs_delete_issue"))
		profiles.apply("idle", "adhoc", harness.api)
		harness.emitEvent("pi-mcp-adapter/status/v1", { servers: [] })

		expect(harness.getActiveToolNames()).toContain("docs_get_issue")
		expect(harness.getActiveToolNames()).not.toContain("docs_delete_issue")
		expect(harness.getRegisteredTools().map((entry) => entry.name)).toContain("docs_delete_issue")

		api.registerTool(tool("docs_delete_issue", "MCP: delete_issue"))
		expect(harness.getActiveToolNames()).toContain("docs_delete_issue")
		profiles.resetAll()
	})

	it("blocks all direct and gateway MCP calls while the live permission mode is plan", async () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		planning.currentProfile = "planning-adhoc"
		permissionState.mode = "plan"
		const directExecute = vi.fn(tool("docs_get_issue", "MCP: get_issue").execute)
		const gatewayExecute = vi.fn(tool("mcp", "MCP").execute)
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		await start(harness)
		upstream.api?.registerTool({ ...tool("docs_get_issue", "MCP: get_issue"), execute: directExecute })
		upstream.api?.registerTool({ ...tool("mcp", "MCP"), execute: gatewayExecute })

		const direct = harness.getRegisteredTools().find(({ name }) => name === "docs_get_issue")
		const gateway = harness.getRegisteredTools().find(({ name }) => name === "mcp")
		const directResult = await direct?.execute("direct", {}, undefined, undefined, createContext())
		const gatewayResult = await gateway?.execute(
			"gateway",
			{ tool: "get_issue", args: {} },
			undefined,
			undefined,
			createContext(),
		)

		expect(directExecute).not.toHaveBeenCalled()
		expect(gatewayExecute).not.toHaveBeenCalled()
		expect(directResult).toMatchObject({
			isError: true,
			details: { error: "plan_mode_mcp_blocked", tool: "docs_get_issue" },
		})
		expect(gatewayResult).toMatchObject({
			isError: true,
			details: { error: "plan_mode_mcp_blocked", tool: "mcp" },
		})
	})

	it("admits read-only-qualified direct tools while planning, keeping the gateway blocked", async () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		planning.currentProfile = "planning-adhoc"
		permissionState.mode = "plan"
		readOnlyState.wireNames.add("docs_get_issue")
		readOnlyState.wireNames.add("docs_unregistered")
		readOnlyState.wireNames.add("mcp")
		const readOnlyExecute = vi.fn(tool("docs_get_issue", "MCP: get_issue").execute)
		const gatewayExecute = vi.fn(tool("mcp", "MCP").execute)
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		await start(harness)
		upstream.api?.registerTool({ ...tool("docs_get_issue", "MCP: get_issue"), execute: readOnlyExecute })
		upstream.api?.registerTool({ ...tool("mcp", "MCP"), execute: gatewayExecute })

		expect(planning.registerReadOnlyToolProvider).toHaveBeenCalledWith(harness.api, expect.any(Function))
		const provider = planning.registerReadOnlyToolProvider.mock.calls.at(-1)?.[1]
		expect(provider?.()).toEqual(["docs_get_issue"])

		const direct = harness.getRegisteredTools().find(({ name }) => name === "docs_get_issue")
		const gateway = harness.getRegisteredTools().find(({ name }) => name === "mcp")
		await direct?.execute("direct", {}, undefined, undefined, createContext())
		const gatewayResult = await gateway?.execute(
			"gateway",
			{ tool: "get_issue", args: {} },
			undefined,
			undefined,
			createContext(),
		)

		expect(readOnlyExecute).toHaveBeenCalledOnce()
		expect(gatewayExecute).not.toHaveBeenCalled()
		expect(gatewayResult).toMatchObject({
			isError: true,
			details: { error: "plan_mode_mcp_blocked", tool: "mcp" },
		})
	})

	it("allows MCP after leaving plan mode even when startup and profile signals are stale", async () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		cliState.plan = true
		planning.currentProfile = "planning-adhoc"
		permissionState.mode = "auto"
		const gatewayExecute = vi.fn(tool("mcp", "MCP").execute)
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		await start(harness)
		upstream.api?.registerTool({ ...tool("mcp", "MCP"), execute: gatewayExecute })

		const gateway = harness.getRegisteredTools().find(({ name }) => name === "mcp")
		const result = await gateway?.execute("gateway", { action: "list" }, undefined, undefined, createContext())

		expect(gatewayExecute).toHaveBeenCalledOnce()
		expect(result).toMatchObject({ content: [{ type: "text", text: "ok" }] })
	})

	it("keeps MCP blocked for the ferment planning profile", async () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		planning.currentProfile = "planning-ferment"
		permissionState.mode = "auto"
		const gatewayExecute = vi.fn(tool("mcp", "MCP").execute)
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		await start(harness)
		upstream.api?.registerTool({ ...tool("mcp", "MCP"), execute: gatewayExecute })

		const gateway = harness.getRegisteredTools().find(({ name }) => name === "mcp")
		const result = await gateway?.execute("gateway", { action: "list" }, undefined, undefined, createContext())

		expect(gatewayExecute).not.toHaveBeenCalled()
		expect(result).toMatchObject({ isError: true })
	})

	it("allows MCP calls outside planning profiles", async () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		planning.currentProfile = "idle"
		const gatewayExecute = vi.fn(tool("mcp", "MCP").execute)
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		await start(harness)
		upstream.api?.registerTool({ ...tool("mcp", "MCP"), execute: gatewayExecute })

		const gateway = harness.getRegisteredTools().find(({ name }) => name === "mcp")
		const result = await gateway?.execute(
			"gateway",
			{ tool: "docs_get_issue", server: "docs", args: {} },
			undefined,
			undefined,
			createContext(),
		)

		expect(gatewayExecute).toHaveBeenCalledOnce()
		expect(result).toMatchObject({ content: [{ type: "text", text: "ok" }] })
	})

	it("creates an isolated caller-wins configuration for ACP sessions", async () => {
		configState.config = {
			mcpServers: {
				shared: { command: "from-file" },
				fileOnly: { command: "file-only" },
			},
			settings: { scriptMode: false },
		}
		const harness = createExtensionApi()

		createKimchiMcpAdapterExtension({
			cwd: "/workspace",
			callerServers: {
				shared: { command: "from-acp" },
				callerOnly: { command: "caller-only" },
			},
		})(harness.api)
		await start(harness, createContext({ cwd: "/workspace", isProjectTrusted: () => true }))

		expect(upstream.options).toEqual({
			config: {
				mcpServers: {
					shared: { command: "from-acp" },
					fileOnly: { command: "file-only" },
					callerOnly: { command: "caller-only" },
				},
				settings: { scriptMode: false },
			},
		})
	})

	it("keeps ACP caller servers while excluding an untrusted project's servers", async () => {
		projectTrust.trusted = false
		configState.config = { mcpServers: { project: { command: "project-server" } } }
		configState.userConfig = { mcpServers: { personal: { command: "personal-server" } } }
		const harness = createExtensionApi()

		createKimchiMcpAdapterExtension({
			cwd: "/workspace",
			callerServers: { ide: { command: "ide-server" } },
		})(harness.api)
		const ctx = await start(harness, createContext({ cwd: "/workspace", isProjectTrusted: () => false }))

		expect(upstream.options).toEqual({
			config: {
				mcpServers: {
					personal: { command: "personal-server" },
					ide: { command: "ide-server" },
				},
			},
		})
		expect(ctx.ui.notify).toHaveBeenCalledWith("project MCP config is not trusted", "warning")
	})

	it("removes impossible mcpScript guidance and Pi product wording from the gateway", async () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		await start(harness)

		upstream.api?.registerTool({
			...tool("mcp", "MCP"),
			description:
				"When one request needs several MCP calls with logic between them, use mcpScript. Non-MCP Pi tools should be called directly.",
		})

		const description = harness.getRegisteredTools().find(({ name }) => name === "mcp")?.description
		expect(description).not.toContain("mcpScript")
		expect(description).toContain("Non-MCP Kimchi tools")
	})

	it("does not rewrite MCP server-owned direct-tool descriptions", async () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		await start(harness)

		upstream.api?.registerTool({
			...tool("docs_reference", "MCP: reference"),
			description: "A server-owned guide for migrating from Pi",
		})

		expect(harness.getRegisteredTools().find(({ name }) => name === "docs_reference")?.description).toBe(
			"A server-owned guide for migrating from Pi",
		)
	})

	it("does not expose the upstream /pi-mcp alias", async () => {
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		await start(harness)

		upstream.api?.registerCommand("mcp", { async handler() {} })
		upstream.api?.registerCommand("pi-mcp", { async handler() {} })

		expect(harness.api.registerCommand).toHaveBeenCalledTimes(1)
		expect(harness.api.registerCommand).toHaveBeenCalledWith("mcp", expect.anything())
	})

	it("reapplies the active profile once after a status-update burst settles", async () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)

		vi.useFakeTimers()
		try {
			// 5-event burst.
			for (let i = 0; i < 5; i++) {
				harness.emitEvent("pi-mcp-adapter/status/v1", { servers: [] })
			}
			expect(planning.reapplyCurrentProfile).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(250)
			expect(planning.reapplyCurrentProfile).toHaveBeenCalledTimes(1)
			expect(planning.reapplyCurrentProfile).toHaveBeenCalledWith(harness.api)

			// A later burst collapses the same way.
			planning.reapplyCurrentProfile.mockClear()
			harness.emitEvent("pi-mcp-adapter/status/v1", { servers: [] })
			await vi.advanceTimersByTimeAsync(250)
			expect(planning.reapplyCurrentProfile).toHaveBeenCalledTimes(1)
		} finally {
			vi.useRealTimers()
		}
	})

	it("still resyncs synchronously when the adapter registers a tool", async () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		await start(harness)
		planning.reapplyCurrentProfile.mockClear()

		// registerTool must not wait out the status debounce.
		upstream.api?.registerTool(tool("docs_get_issue", "MCP: get_issue"))

		expect(planning.reapplyCurrentProfile).toHaveBeenCalledWith(harness.api)
	})

	it("drops a pending resnapshot when the session shuts down", async () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)

		vi.useFakeTimers()
		try {
			// A status event schedules the resnapshot; the session is then
			// replaced/reloaded before it fires. The stale pi's event bus throws
			// on any later emit, so the callback must never run.
			harness.emitEvent("pi-mcp-adapter/status/v1", { servers: [] })
			await harness.getHandler("session_shutdown")({ type: "session_shutdown", reason: "reload" }, createContext())
			await vi.advanceTimersByTimeAsync(250)
			expect(planning.reapplyCurrentProfile).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})

	it("drops a pending resnapshot when a replacement session starts", async () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)

		vi.useFakeTimers()
		try {
			// new/fork/switch/resume replacements surface as a fresh session_start
			// (no session_shutdown) — the obsolete resnapshot must be dropped.
			harness.emitEvent("pi-mcp-adapter/status/v1", { servers: [] })
			await harness.getHandler("session_start")({ type: "session_start", reason: "resume" }, createContext())
			await vi.advanceTimersByTimeAsync(250)
			expect(planning.reapplyCurrentProfile).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})

	it("drops a deferred resnapshot that hits an action-blocked pi instead of crashing", async () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)

		vi.useFakeTimers()
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			planning.reapplyCurrentProfile.mockImplementation(() => {
				throw new Error("This extension ctx is stale after session replacement or reload")
			})
			harness.emitEvent("pi-mcp-adapter/status/v1", { servers: [] })
			// The old code rethrew inside the timer callback: this would reject.
			await expect(vi.advanceTimersByTimeAsync(250)).resolves.toBeDefined()
			expect(errorSpy).not.toHaveBeenCalled()
		} finally {
			errorSpy.mockRestore()
			vi.useRealTimers()
		}
	})

	it("logs and drops an unknown deferred-resnapshot error instead of crashing", async () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)

		vi.useFakeTimers()
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			planning.reapplyCurrentProfile.mockImplementation(() => {
				throw new Error("registry exploded")
			})
			harness.emitEvent("pi-mcp-adapter/status/v1", { servers: [] })
			await expect(vi.advanceTimersByTimeAsync(250)).resolves.toBeDefined()
			expect(errorSpy).toHaveBeenCalledTimes(1)
			expect(errorSpy.mock.calls[0]?.[0]).toContain("[tool-surface]")
		} finally {
			errorSpy.mockRestore()
			vi.useRealTimers()
		}
	})

	it("keeps the registerTool self-correction additive like the resnapshot path", async () => {
		const profiles = await vi.importActual<typeof ToolProfileManager>("../../shared/planning/tool-profile-manager.js")
		profiles.resetAll()
		planning.reapplyCurrentProfile.mockImplementation(profiles.reapplyCurrentProfile)
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		const harness = createExtensionApi()
		harness.api.registerTool(tool("read", "Read"))
		harness.api.registerTool(tool("write", "Write"))
		mcpAdapterExtension(harness.api)
		await start(harness)
		profiles.apply("idle", "adhoc", harness.api)
		expect(harness.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "write"]))

		const api = upstream.api
		if (!api) throw new Error("Adapter was not installed")
		// Mid-rebuild: the registry briefly exposes only the newly registering tool.
		const getAllTools = harness.api.getAllTools as ReturnType<typeof vi.fn>
		const fullImplementation = getAllTools.getMockImplementation()
		getAllTools.mockImplementation(() => [{ name: "docs_get_issue" }])
		api.registerTool(tool("docs_get_issue", "MCP: get_issue"))
		getAllTools.mockImplementation(fullImplementation ?? (() => []))

		// registerTool rides the resnapshot path, so the partial registry sample
		// must union into the previous active set rather than narrow it.
		expect(harness.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "write", "docs_get_issue"]))
		profiles.resetAll()
	})

	it("surfaces compatibility warnings when the session starts", async () => {
		configState.warnings = ["legacy config is malformed"]
		configState.legacyKeys = ["mcpSearch"]
		oauthMigration.warnings = ["legacy OAuth entry conflicts with the upstream layout"]
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		const ctx = createContext()

		await harness.getHandler("session_start")({ type: "session_start", reason: "startup" }, ctx)

		expect(ctx.ui.notify).toHaveBeenCalledWith("legacy config is malformed", "warning")
		expect(ctx.ui.notify).toHaveBeenCalledWith("legacy OAuth entry conflicts with the upstream layout", "warning")
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("mcpSearch no longer controls"), "warning")
	})
})
