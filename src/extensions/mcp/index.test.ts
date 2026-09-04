import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { McpAdapterOptions, McpConfig } from "pi-mcp-adapter/types"
import { Type } from "typebox"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"

const upstream = vi.hoisted(() => ({
	api: undefined as ExtensionAPI | undefined,
	options: undefined as McpAdapterOptions | undefined,
}))
const configState = vi.hoisted(() => ({
	config: { mcpServers: {} } as McpConfig,
	configPath: undefined as string | undefined,
	warnings: [] as string[],
}))
const cliState = vi.hoisted(() => ({ mcpConfig: undefined as string | undefined }))
const planning = vi.hoisted(() => ({
	provider: undefined as (() => string[]) | undefined,
	applyCooperativeTweak: vi.fn(() => true),
	currentProfile: undefined as "planning-adhoc" | "planning-ferment" | "idle" | undefined,
	reapplyCurrentProfile: vi.fn(() => false),
}))
const oauthMigration = vi.hoisted(() => ({ warnings: [] as string[] }))
const annotations = vi.hoisted(() => ({
	readOnly: new Set<string>(),
}))

vi.mock("pi-mcp-adapter", () => ({
	MCP_STATUS_EVENT: "pi-mcp-adapter/status/v1",
	createMcpAdapter: vi.fn((options: McpAdapterOptions) => (api: ExtensionAPI) => {
		upstream.options = options
		upstream.api = api
	}),
}))

vi.mock("../../cli-args.js", () => ({
	getParsedCliArgs: () => ({ options: { "mcp-config": cliState.mcpConfig }, positionals: [] }),
}))

vi.mock("./config.js", () => ({
	loadKimchiMcpConfig: () => ({
		config: configState.config,
		configPath: configState.configPath,
		warnings: configState.warnings,
	}),
}))

vi.mock("../../shared/planning/read-only-tool-registry.js", () => ({
	registerReadOnlyToolProvider: (_pi: ExtensionAPI, provider: () => string[]) => {
		planning.provider = provider
	},
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

vi.mock("./annotation-catalog.js", () => ({
	installMcpAnnotationCapture: vi.fn(),
	mcpAnnotationSourceHash: vi.fn(() => "test-source"),
	runWithMcpAnnotationCatalog: (_catalog: unknown, callback: () => unknown) => callback(),
	McpAnnotationCatalog: class {
		isReadOnly(originalName: string): boolean {
			return annotations.readOnly.has(originalName)
		}
		isReadOnlyByName(originalName: string): boolean {
			return annotations.readOnly.has(originalName)
		}
	},
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

describe("upstream MCP adapter facade", () => {
	beforeEach(() => {
		upstream.api = undefined
		upstream.options = undefined
		configState.config = { mcpServers: {} }
		configState.configPath = undefined
		configState.warnings = []
		oauthMigration.warnings = []
		annotations.readOnly.clear()
		cliState.mcpConfig = undefined
		planning.provider = undefined
		planning.currentProfile = undefined
		planning.applyCooperativeTweak.mockClear()
		planning.reapplyCurrentProfile.mockClear()
	})

	it("keeps the upstream adapter in file-backed mode", () => {
		configState.config = {
			mcpServers: { docs: { url: "https://example.test/mcp" } },
			settings: { scriptMode: false },
		}
		cliState.mcpConfig = "/tmp/mcp.json"
		configState.configPath = "/tmp/mcp.json"
		const { api } = createExtensionApi()

		mcpAdapterExtension(api)

		expect(upstream.options).toEqual({ configPath: "/tmp/mcp.json" })
		expect(upstream.api).toBeDefined()
	})

	it("suppresses all model-facing MCP tools for an empty configuration", () => {
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)

		upstream.api?.registerTool(tool("mcp", "MCP"))
		upstream.api?.registerTool(tool("mcpScript", "MCP Script"))
		upstream.api?.setActiveTools(["read", "mcp", "mcpScript"])

		expect(harness.getRegisteredTools()).toEqual([])
		expect(planning.applyCooperativeTweak).toHaveBeenCalledWith(harness.api, ["read"])
	})

	it("registers direct tools and exposes only read-only names to planning", () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		annotations.readOnly.add("get_issue")
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)

		upstream.api?.registerTool(tool("docs_get_issue", "MCP: get_issue"))
		upstream.api?.registerTool(tool("docs_delete_issue", "MCP: delete_issue"))

		expect(harness.getRegisteredTools().map(({ name }) => name)).toEqual(["docs_get_issue", "docs_delete_issue"])
		expect(planning.provider?.()).toEqual(["docs_get_issue"])
		expect(planning.reapplyCurrentProfile).toHaveBeenCalledTimes(2)
	})

	it("keeps the current profile authoritative over upstream active-tool synchronization", () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		planning.reapplyCurrentProfile.mockReturnValue(true)
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)

		upstream.api?.setActiveTools(["read", "docs_delete_issue"])

		expect(planning.reapplyCurrentProfile).toHaveBeenCalledWith(harness.api)
		expect(planning.applyCooperativeTweak).not.toHaveBeenCalled()
	})

	it("blocks direct and gateway writes in planning profiles", async () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		planning.currentProfile = "planning-adhoc"
		annotations.readOnly.add("get_issue")
		const directExecute = vi.fn(tool("docs_delete_issue", "MCP: delete_issue").execute)
		const gatewayExecute = vi.fn(tool("mcp", "MCP").execute)
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		upstream.api?.registerTool({ ...tool("docs_delete_issue", "MCP: delete_issue"), execute: directExecute })
		upstream.api?.registerTool({ ...tool("mcp", "MCP"), execute: gatewayExecute })

		const direct = harness.getRegisteredTools().find(({ name }) => name === "docs_delete_issue")
		const gateway = harness.getRegisteredTools().find(({ name }) => name === "mcp")
		const directResult = await direct?.execute("direct", {}, undefined, undefined, createContext())
		const gatewayResult = await gateway?.execute(
			"gateway",
			{ tool: "delete_issue", args: {} },
			undefined,
			undefined,
			createContext(),
		)

		expect(directExecute).not.toHaveBeenCalled()
		expect(gatewayExecute).not.toHaveBeenCalled()
		expect(directResult).toMatchObject({ isError: true, details: { error: "plan_mode_write_blocked" } })
		expect(gatewayResult).toMatchObject({ isError: true, details: { error: "plan_mode_write_blocked" } })
	})

	it("creates an isolated caller-wins configuration for ACP sessions", () => {
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

	it("reapplies the active profile after an upstream status update", () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)

		harness.emitEvent("pi-mcp-adapter/status/v1", { servers: [] })

		expect(planning.reapplyCurrentProfile).toHaveBeenCalledWith(harness.api)
	})

	it("surfaces compatibility warnings when the session starts", async () => {
		configState.warnings = ["legacy config is malformed"]
		oauthMigration.warnings = ["legacy OAuth entry conflicts with the upstream layout"]
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		const ctx = createContext()

		await harness.getHandler("session_start")({ type: "session_start", reason: "startup" }, ctx)

		expect(ctx.ui.notify).toHaveBeenCalledWith("legacy config is malformed", "warning")
		expect(ctx.ui.notify).toHaveBeenCalledWith("legacy OAuth entry conflicts with the upstream layout", "warning")
	})
})
