import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { McpAdapterOptions, McpConfig } from "pi-mcp-adapter/types"
import { Type } from "typebox"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
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
}))
const planning = vi.hoisted(() => ({
	applyCooperativeTweak: vi.fn(() => true),
	currentProfile: undefined as "planning-adhoc" | "planning-ferment" | "idle" | undefined,
	reapplyCurrentProfile: vi.fn(() => false),
}))
const oauthMigration = vi.hoisted(() => ({ warnings: [] as string[] }))
const oauthBranding = vi.hoisted(() => ({ install: vi.fn() }))
const projectTrust = vi.hoisted(() => ({ trusted: true }))

vi.mock("pi-mcp-adapter", () => ({
	MCP_STATUS_EVENT: "pi-mcp-adapter/status/v1",
	createMcpAdapter: vi.fn((options: McpAdapterOptions) => (api: ExtensionAPI) => {
		upstream.options = options
		upstream.api = api
		api.on("session_start", upstream.sessionStart)
		api.on("input", upstream.input)
	}),
}))

vi.mock("../../cli-args.js", () => ({
	getParsedCliArgs: () => ({
		options: {
			"mcp-config": cliState.mcpConfig,
			approve: cliState.approve,
			"no-approve": cliState.noApprove,
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

vi.mock("../../config.js", () => ({
	getConfiguredLegacyMcpKeys: () => configState.legacyKeys,
}))

vi.mock("../../shared/planning/tool-profile-manager.js", () => ({
	applyCooperativeTweak: planning.applyCooperativeTweak,
	getCurrentProfile: () => planning.currentProfile,
	reapplyCurrentProfile: planning.reapplyCurrentProfile,
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
		projectTrust.trusted = true
		planning.currentProfile = undefined
		planning.applyCooperativeTweak.mockClear()
		planning.reapplyCurrentProfile.mockClear()
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

	it("blocks all direct and gateway MCP calls in planning profiles", async () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		planning.currentProfile = "planning-adhoc"
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

	it("reapplies the active profile after an upstream status update", () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)

		harness.emitEvent("pi-mcp-adapter/status/v1", { servers: [] })

		expect(planning.reapplyCurrentProfile).toHaveBeenCalledWith(harness.api)
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
