import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BeforeProviderHeadersEvent, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { MCP_RUNTIME_REGISTER_EVENT, type McpRuntimeRegistrationRequest } from "pi-mcp-adapter"
import { computeServerHash } from "pi-mcp-adapter/metadata-cache"
import type { McpAdapterOptions, McpConfig, MetadataCache, ServerCacheEntry, ServerEntry } from "pi-mcp-adapter/types"
import { Type } from "typebox"
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import type * as CliArgs from "../../cli-args.js"
import type * as ToolProfileManager from "../../shared/planning/tool-profile-manager.js"
import { createCommandContext, createContext, createToolContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { observeToolFiles } from "../work-attribution/file-observations.js"
import { flushWorkSummaries, readWorkRecords } from "../work-attribution/summary.js"
import { createWorkAttributionExtension, getWorkId } from "../work-attribution.js"
import type { CacheFileStamp } from "./cache-file-stamp.js"

// Spies keep the real observer, so an attributed MCP write reaches Git snapshots and the work ledger.
vi.mock("../work-attribution/file-observations.js", { spy: true })

const upstream = vi.hoisted(() => ({
	api: undefined as ExtensionAPI | undefined,
	options: undefined as McpAdapterOptions | undefined,
	sessionMetadataObserver: undefined as McpAdapterOptions["onSessionMetadata"],
	sessionObserverFactory: undefined as McpAdapterOptions["createSessionMetadataObserver"],
	input: vi.fn(),
	sessionStart: vi.fn(),
}))
const callResolution = vi.hoisted(() => ({
	describeMcpCall: vi.fn(),
}))
const metadataCache = vi.hoisted(() => ({
	loadMetadataCache: vi.fn<() => MetadataCache | null>(),
}))
const configState = vi.hoisted(() => ({
	config: { mcpServers: {} } as McpConfig,
	userConfig: { mcpServers: {} } as McpConfig,
	configPath: undefined as string | undefined,
	sharedConfigPath: "/tmp/kimchi-harness/mcp.json",
	useProgrammaticConfig: false,
	warnings: [] as string[],
	legacyKeys: [] as string[],
	loadError: undefined as Error | undefined,
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
	sessionIds: [] as string[],
}))
const oauthMigration = vi.hoisted(() => ({ warnings: [] as string[] }))
const oauthBranding = vi.hoisted(() => ({
	install: vi.fn(),
	// Mirrors the real factory signature; identity so existing tests keep their
	// ctx identity assertions, spyable so the event-path tests can verify every
	// adapter handler ctx is routed through the branding layer.
	brandedContext: vi.fn(<T>(ctx: T): T => ctx),
}))
const projectTrust = vi.hoisted(() => ({ trusted: true }))
const readOnlyState = vi.hoisted(() => ({
	wireNames: new Set<string>(),
	authorizationConfigs: [] as McpConfig[],
	// Catalogs and candidates as the read-only callbacks received them, so assertions attribute to that path.
	gatewayCatalogs: [] as McpCallCatalog[],
	wireNameCandidates: [] as Array<readonly McpToolCandidate[]>,
}))
const baseCacheStamp: CacheFileStamp = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n, ctimeNs: 5n }
const cacheStampState = vi.hoisted(() => ({ stamp: null as CacheFileStamp | null }))
const gatewayState = vi.hoisted(() => ({
	server: undefined as { name: string; entry: ServerEntry } | undefined,
	addresses: ["https://api.cast.ai/mcp"],
}))

vi.mock("./call-facts.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./call-facts.js")>()),
	describeMcpCall: callResolution.describeMcpCall,
}))

vi.mock("pi-mcp-adapter/metadata-cache", async (importOriginal) => ({
	...(await importOriginal<typeof import("pi-mcp-adapter/metadata-cache")>()),
	loadMetadataCache: metadataCache.loadMetadataCache,
}))

// The stamp is explicit test state rather than a function of the isolated HOME's cache file.
vi.mock("./cache-file-stamp.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./cache-file-stamp.js")>()),
	statMetadataCacheFile: () => cacheStampState.stamp,
}))

vi.mock("pi-mcp-adapter", () => ({
	MCP_STATUS_EVENT: "pi-mcp-adapter/status/v1",
	MCP_RUNTIME_REGISTER_EVENT: "pi-mcp-adapter:runtime-register:v1",
	MCP_RUNTIME_REGISTER_VERSION: 1,
	createMcpAdapter: vi.fn((options: McpAdapterOptions) => (api: ExtensionAPI) => {
		const { onSessionMetadata, createSessionMetadataObserver, ...adapterOptions } = options
		upstream.options = adapterOptions
		upstream.sessionMetadataObserver = createSessionMetadataObserver?.() ?? onSessionMetadata
		upstream.sessionObserverFactory = createSessionMetadataObserver
		upstream.api = api
		api.on("session_start", upstream.sessionStart)
		api.on("input", upstream.input)
	}),
}))

// The real work-attribution chain reads other CLI helpers, so only the parsed arguments are replaced.
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

vi.mock("./config.js", async (importOriginal) => ({
	// The default-era policy value must survive the mock: the facade reads it.
	DEFAULT_MCP_PROTOCOL_VERSION: (await importOriginal<typeof import("./config.js")>()).DEFAULT_MCP_PROTOCOL_VERSION,
	getSharedMcpConfigPath: () => configState.sharedConfigPath,
	loadKimchiMcpConfig: (options: { includeProjectSources?: boolean }) => {
		if (configState.loadError) throw configState.loadError
		return options.includeProjectSources === false
			? { config: configState.userConfig, useProgrammaticConfig: true, warnings: [] }
			: {
					config: configState.config,
					configPath: configState.configPath,
					...(configState.useProgrammaticConfig ? { useProgrammaticConfig: true } : {}),
					warnings: configState.warnings,
				}
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
vi.mock("./read-only.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./read-only.js")>()),
	collectReadOnlyMcpWireNames: (candidates: readonly McpToolCandidate[], server?: string) => {
		readOnlyState.wireNameCandidates.push(candidates)
		return [...readOnlyState.wireNames].filter((name) => server === undefined || name.startsWith(`${server}_`))
	},
}))

vi.mock("./call-catalog.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./call-catalog.js")>()
	return {
		...original,
		isReadOnlyQualifiedMcpGatewayTool: (catalog: McpCallCatalog, toolName: string, server?: string) => {
			readOnlyState.authorizationConfigs.push(catalog.config)
			readOnlyState.gatewayCatalogs.push(catalog)
			const names = [...readOnlyState.wireNames].filter((name) => server === undefined || name.startsWith(`${server}_`))
			return names.includes(toolName) || (server !== undefined && names.includes(`${server}_${toolName}`))
		},
	}
})

vi.mock("../permissions/mode-controller.js", () => ({
	getPermissionMode: vi.fn((sessionId: string) => {
		permissionState.sessionIds.push(sessionId)
		return permissionState.mode === undefined ? undefined : { mode: permissionState.mode }
	}),
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
	createBrandedMcpContext: oauthBranding.brandedContext,
	installMcpOAuthCallbackBranding: oauthBranding.install,
}))

vi.mock("./project-trust.js", () => ({
	MCP_PROJECT_TRUST_WARNING: "project MCP config is not trusted",
	resolveMcpProjectTrust: vi.fn(async () => projectTrust.trusted),
}))

import { lookupMcpCall } from "../../shared/mcp-call-lookup.js"
import { debugToolSurface } from "../../shared/planning/tool-profile-manager.js"
import { describeMcpCall, type McpCallCatalog } from "./call-facts.js"
import mcpAdapterExtension, { createKimchiMcpAdapterExtension } from "./index.js"
import { migrateLegacyOAuthCredentials } from "./oauth-migration.js"
import { resolveMcpProjectTrust } from "./project-trust.js"
import type { McpToolCandidate } from "./read-only.js"

function tool(name: string, label: string): ToolDefinition {
	return {
		name,
		label,
		description: `${name} description`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	}
}

function lastLookupCatalog(): McpCallCatalog {
	const catalog = vi.mocked(describeMcpCall).mock.calls.at(-1)?.[2]
	if (!catalog) throw new Error("MCP call resolver was not invoked")
	return catalog
}

async function start(
	harness: ReturnType<typeof createExtensionApi>,
	ctx = createContext({ isProjectTrusted: () => true }),
) {
	await harness.getHandler("session_start")({ type: "session_start", reason: "startup" }, ctx)
	return ctx
}

/** A later session start, as Pi dispatches it after /new, /resume or /fork. */
async function restart(
	harness: ReturnType<typeof createExtensionApi>,
	ctx = createContext({ isProjectTrusted: () => true }),
) {
	await harness.getHandler("session_shutdown")({ type: "session_shutdown" }, ctx)
	await harness.getHandler("session_start")({ type: "session_start", reason: "new" }, ctx)
	return ctx
}

describe("upstream MCP adapter facade", () => {
	beforeEach(() => {
		upstream.api = undefined
		upstream.options = undefined
		upstream.input.mockReset()
		upstream.sessionStart.mockReset()
		upstream.sessionMetadataObserver = undefined
		upstream.sessionObserverFactory = undefined
		callResolution.describeMcpCall.mockReset().mockReturnValue({ kind: "metadata", op: "status" })
		metadataCache.loadMetadataCache.mockReset().mockReturnValue(null)
		configState.config = { mcpServers: {} }
		configState.userConfig = { mcpServers: {} }
		configState.configPath = undefined
		configState.sharedConfigPath = "/tmp/kimchi-harness/mcp.json"
		configState.useProgrammaticConfig = false
		configState.warnings = []
		configState.legacyKeys = []
		configState.loadError = undefined
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
		permissionState.sessionIds = []
		readOnlyState.wireNames.clear()
		readOnlyState.authorizationConfigs.length = 0
		readOnlyState.gatewayCatalogs.length = 0
		readOnlyState.wireNameCandidates.length = 0
		cacheStampState.stamp = baseCacheStamp
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

		expect(upstream.options).toEqual({ configPath: "/tmp/mcp.json", defaultProtocolVersion: "auto" })
		expect(upstream.api).toBeDefined()
	})

	it("defaults the adapter config to the Studio-shared mcp.json", async () => {
		const harness = createExtensionApi()

		mcpAdapterExtension(harness.api)
		await start(harness)

		expect(upstream.options).toEqual({ configPath: configState.sharedConfigPath, defaultProtocolVersion: "auto" })
	})

	it("lets an explicit selected config win over the Studio-shared default", async () => {
		cliState.mcpConfig = "/tmp/mcp.json"
		configState.configPath = "/tmp/mcp.json"
		const harness = createExtensionApi()

		mcpAdapterExtension(harness.api)
		await start(harness)

		expect(upstream.options).toEqual({ configPath: "/tmp/mcp.json", defaultProtocolVersion: "auto" })
	})

	it("uses the resolved config when selected-file precedence requires an overlay", async () => {
		configState.config = { mcpServers: { docs: { command: "selected-server" } } }
		configState.configPath = "/tmp/mcp.json"
		configState.useProgrammaticConfig = true
		const harness = createExtensionApi()

		mcpAdapterExtension(harness.api)
		await start(harness)

		expect(upstream.options).toEqual({ config: configState.config, defaultProtocolVersion: "auto" })
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

			expect(upstream.options).toEqual({ configPath: "/tmp/mcp.json", defaultProtocolVersion: "auto" })
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

			expect(upstream.options).toEqual({ configPath: "/tmp/mcp.json", defaultProtocolVersion: "auto" })
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

			expect(upstream.options).toEqual({ configPath: "/tmp/mcp.json", defaultProtocolVersion: "auto" })
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

			expect(upstream.options).toEqual({ configPath: "/tmp/mcp.json", defaultProtocolVersion: "auto" })
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
			expect(upstream.options).toEqual({ config: { mcpServers: {} }, defaultProtocolVersion: "auto" })
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
				defaultProtocolVersion: "auto",
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

	it("keeps the gateway visible and executable when planning reconciliation omits it", async () => {
		const profiles = await vi.importActual<typeof ToolProfileManager>("../../shared/planning/tool-profile-manager.js")
		profiles.resetAll()
		planning.reapplyCurrentProfile.mockImplementation(profiles.reapplyCurrentProfile)
		planning.registerReadOnlyToolProvider.mockImplementation(profiles.registerReadOnlyToolProvider)
		planning.currentProfile = "planning-adhoc"
		cliState.plan = true
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		readOnlyState.wireNames.add("docs_get_issue")
		const harness = createExtensionApi()
		harness.api.registerTool(tool("read", "Read"))
		mcpAdapterExtension(harness.api)
		await start(harness)
		const api = upstream.api
		if (!api) throw new Error("Adapter was not installed")
		const gatewayExecute = vi.fn(tool("mcp", "MCP").execute)
		api.registerTool({ ...tool("mcp", "MCP"), execute: gatewayExecute })

		profiles.apply("planning-adhoc", "adhoc", harness.api)
		api.setActiveTools(api.getActiveTools().filter((name) => name !== "mcp"))
		profiles.reapplyCurrentProfile(harness.api)
		expect(harness.getActiveToolNames()).toContain("mcp")
		const result = await harness
			.getRegisteredTool("mcp")
			.execute(
				"gateway",
				{ tool: "docs_get_issue", server: "docs", args: {} },
				undefined,
				undefined,
				createToolContext(),
			)
		expect(gatewayExecute).toHaveBeenCalledOnce()
		expect(result).toMatchObject({ content: [{ type: "text", text: "ok" }] })

		planning.currentProfile = undefined
		cliState.plan = false
		profiles.apply("idle", "adhoc", harness.api)
		api.setActiveTools(api.getActiveTools().filter((name) => name !== "mcp"))
		profiles.reapplyCurrentProfile(harness.api)
		expect(harness.getActiveToolNames()).not.toContain("mcp")
		profiles.resetAll()
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
		await harness.getHandler("session_shutdown")({ type: "session_shutdown" }, createContext())
		profiles.resetAll()
	})

	it("observes local file changes for write-capable MCP tools but skips qualified read-only tools", async () => {
		vi.mocked(observeToolFiles).mockClear()
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		await start(harness)
		readOnlyState.wireNames.add("docs_get_issue")
		upstream.api?.registerTool(tool("docs_get_issue", "Read"))
		upstream.api?.registerTool(tool("docs_write", "Write"))
		const ctx = createToolContext()
		for (const registered of harness.getRegisteredTools())
			await registered.execute(registered.name, {}, undefined, undefined, ctx)
		expect(observeToolFiles).toHaveBeenCalledExactlyOnceWith(ctx, "docs_write", "mcp", expect.any(Function))
	})

	it("observes gateway calls only when an action or a tool not qualified read-only can write", async () => {
		vi.mocked(observeToolFiles).mockClear()
		configState.config = { mcpServers: { docs: { command: "docs" }, other: { command: "other" } } }
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		await start(harness)
		readOnlyState.wireNames.add("docs_get_issue")
		upstream.api?.registerTool(tool("mcp", "MCP"))
		const calls = {
			search: { search: "issue" },
			describe: { describe: "docs_write" },
			instructions: { instructions: "docs" },
			list: { server: "docs" },
			status: {},
			read: { tool: "docs_get_issue", args: {} },
			"read-on-server": { tool: "docs_get_issue", server: "docs" },
			"another-server": { tool: "docs_get_issue", server: "other" },
			write: { tool: "docs_write", args: {} },
			install: { action: "install", url: "https://example.test/mcp" },
		}
		const ctx = createToolContext()
		for (const [id, params] of Object.entries(calls))
			await harness.getRegisteredTool("mcp").execute(id, params, undefined, undefined, ctx)
		expect(vi.mocked(observeToolFiles).mock.calls.map((call) => call[1])).toEqual([
			"another-server",
			"write",
			"install",
		])
	})

	it("records a proxied MCP tool's real file write under its model request and work", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-mcp-write-")))
		onTestFinished(async () => {
			await flushWorkSummaries()
			vi.unstubAllEnvs()
			rmSync(root, { recursive: true, force: true })
		})
		const cwd = join(root, "repo")
		const agentDir = join(root, "agent")
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir)
		const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()
		mkdirSync(cwd)
		git("init", "-q")
		git("config", "user.name", "MCP Test")
		git("config", "user.email", "mcp@example.invalid")
		git("config", "commit.gpgSign", "false")
		git("commit", "-q", "--allow-empty", "-m", "base")
		const ctx = createToolContext({ cwd, sessionManager: { getSessionId: () => "mcp-write" } })
		// Pi reports the assistant response before running its tool calls; that pins each call to its request.
		const work = createExtensionApi()
		createWorkAttributionExtension()(work.api)
		const request: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		await work.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(request, ctx)
		const workId = getWorkId(ctx)
		await work.getHandler("message_end")(
			{
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "write-notes", name: "docs_write" }],
				},
			},
			ctx,
		)
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		await start(harness)
		const api = upstream.api
		if (!api) throw new Error("Adapter was not installed")
		api.registerTool({
			...tool("docs_write", "Write"),
			execute: async () => {
				mkdirSync(join(cwd, "docs"))
				writeFileSync(join(cwd, "docs", "notes.md"), "# Notes\n")
				return { content: [{ type: "text", text: "written" }], details: {} }
			},
		})

		await harness.getRegisteredTool("docs_write").execute("write-notes", {}, undefined, undefined, ctx)

		expect(readWorkRecords(agentDir).filter((row) => row.type === "file_observation")).toEqual([
			expect.objectContaining({
				source: "mcp",
				toolCallId: "write-notes",
				requestId: request.headers["X-Request-Id"],
				workId,
				complete: true,
				files: [
					{
						path: "docs/notes.md",
						before: null,
						after: { blob: git("hash-object", "docs/notes.md"), mode: "100644" },
					},
				],
			}),
		])
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
		const directResult = await direct?.execute("direct", {}, undefined, undefined, createToolContext())
		const gatewayResult = await gateway?.execute(
			"gateway",
			{ tool: "get_issue", args: {} },
			undefined,
			undefined,
			createToolContext(),
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

	it("blocks namespace proxies even when their nested tool is read-only-qualified", async () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		planning.currentProfile = "planning-adhoc"
		permissionState.mode = "plan"
		readOnlyState.wireNames.add("docs_get_issue")
		const namespaceExecute = vi.fn(tool("mcp__docs", "MCP namespace").execute)
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		await start(harness)
		upstream.api?.registerTool({ ...tool("mcp__docs", "MCP namespace"), execute: namespaceExecute })

		const result = await harness
			.getRegisteredTool("mcp__docs")
			.execute("namespace", { tool: "docs_get_issue", args: {} }, undefined, undefined, createToolContext())

		expect(namespaceExecute).not.toHaveBeenCalled()
		expect(result).toMatchObject({
			isError: true,
			details: { error: "plan_mode_mcp_blocked", tool: "mcp__docs" },
		})
	})

	it("admits read-only-qualified direct tools and the gateway in the planning surface", async () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		planning.currentProfile = "planning-adhoc"
		permissionState.mode = "plan"
		readOnlyState.wireNames.add("docs_get_issue")
		readOnlyState.wireNames.add("docs_unregistered")
		const readOnlyExecute = vi.fn(tool("docs_get_issue", "MCP: get_issue").execute)
		const gatewayExecute = vi.fn(tool("mcp", "MCP").execute)
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		await start(harness)
		upstream.api?.registerTool({ ...tool("docs_get_issue", "MCP: get_issue"), execute: readOnlyExecute })
		upstream.api?.registerTool({ ...tool("mcp", "MCP"), execute: gatewayExecute })

		expect(planning.registerReadOnlyToolProvider).toHaveBeenCalledWith(harness.api, expect.any(Function))
		const provider = planning.registerReadOnlyToolProvider.mock.calls.at(-1)?.[1]
		expect(provider?.()).toEqual(["docs_get_issue", "mcp"])

		const direct = harness.getRegisteredTools().find(({ name }) => name === "docs_get_issue")
		await direct?.execute("direct", {}, undefined, undefined, createToolContext())
		expect(readOnlyExecute).toHaveBeenCalledOnce()
		expect(gatewayExecute).not.toHaveBeenCalled()
	})

	it("permits read-only gateway operations and blocks mutating calls while planning", async () => {
		configState.config = { mcpServers: { docs: { command: "docs" }, other: { command: "other" } } }
		planning.currentProfile = "planning-adhoc"
		permissionState.mode = "plan"
		readOnlyState.wireNames.add("docs_get_issue")
		const gatewayExecute = vi.fn(tool("mcp", "MCP").execute)
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		await start(harness)
		upstream.api?.registerTool({ ...tool("mcp", "MCP"), execute: gatewayExecute })
		const gateway = harness.getRegisteredTool("mcp")

		const readOnlyCalls = [
			["status", {}],
			["search", { search: "issue" }],
			[
				"search-with-options",
				{
					search: "issue",
					searchMode: "lexical",
					regex: true,
					includeSchemas: true,
					limit: 5,
					offset: 0,
					server: "docs",
				},
			],
			["describe", { describe: "docs_get_issue" }],
			["instructions", { instructions: "docs" }],
			["list", { server: "docs" }],
			["read", { tool: "docs_get_issue", args: {} }],
			["read-on-server", { tool: "docs_get_issue", server: "docs", args: {} }],
			["read-original-on-server", { tool: "get_issue", server: "docs", args: {} }],
		] as const
		for (const [id, params] of readOnlyCalls) {
			const result = await gateway.execute(id, params, undefined, undefined, createToolContext())
			expect(result).toMatchObject({ content: [{ type: "text", text: "ok" }] })
		}
		expect(gatewayExecute).toHaveBeenCalledTimes(readOnlyCalls.length)

		const blockedCalls = [
			["another-server", { tool: "docs_get_issue", server: "other", args: {} }],
			["write", { tool: "docs_write", args: {} }],
			["install", { action: "install", url: "https://example.test/mcp" }],
			["auth-start", { action: "auth-start", server: "docs" }],
			["auth-complete", { action: "auth-complete", server: "docs" }],
			["connect", { connect: "docs" }],
			["action-connect", { action: "connect", server: "docs" }],
			["ui-messages", { action: "ui-messages" }],
			["unknown-action", { action: "future-state-change" }],
			["unknown-parameter", { mode: "status" }],
			["search-mode-wrong-type", { search: "issue", searchMode: 1 }],
			["search-regex-wrong-type", { search: "issue", regex: "false" }],
			["search-schemas-wrong-type", { search: "issue", includeSchemas: 1 }],
			["search-negative-limit", { search: "issue", limit: -1 }],
			["search-fractional-limit", { search: "issue", limit: 1.5 }],
			["search-negative-offset", { search: "issue", offset: -1 }],
			["describe-empty-server", { describe: "docs_get_issue", server: "" }],
			["mixed-read-and-connect", { search: "issue", connect: "docs" }],
			["mixed-read-operations", { search: "issue", describe: "docs_get_issue" }],
			["undefined-action", { action: undefined }],
			["install-without-action", { url: "https://example.test/mcp" }],
		] as const
		for (const [id, params] of blockedCalls) {
			const result = await gateway.execute(id, params, undefined, undefined, createToolContext())
			expect(result).toMatchObject({
				isError: true,
				details: { error: "plan_mode_mcp_blocked", tool: "mcp" },
			})
		}
		expect(gatewayExecute).toHaveBeenCalledTimes(readOnlyCalls.length)
	})

	it("uses the parent's live mode for a subagent's mutating gateway calls", async () => {
		configState.config = { mcpServers: { docs: { command: "docs" } } }
		planning.currentProfile = undefined
		permissionState.mode = "plan"
		readOnlyState.wireNames.add("docs_get_issue")
		const gatewayExecute = vi.fn(tool("mcp", "MCP").execute)
		const harness = createExtensionApi()
		createKimchiMcpAdapterExtension({ parentSessionId: "parent-session" })(harness.api)
		await start(harness)
		upstream.api?.registerTool({ ...tool("mcp", "MCP"), execute: gatewayExecute })
		const gateway = harness.getRegisteredTool("mcp")

		expect(
			await gateway.execute(
				"mutating",
				{ tool: "docs_write_issue", args: {} },
				undefined,
				undefined,
				createToolContext(),
			),
		).toMatchObject({
			isError: true,
			details: { error: "plan_mode_mcp_blocked", tool: "mcp" },
		})
		expect(
			await gateway.execute("read", { tool: "docs_get_issue", args: {} }, undefined, undefined, createToolContext()),
		).toMatchObject({
			content: [{ type: "text", text: "ok" }],
		})
		expect(gatewayExecute).toHaveBeenCalledTimes(1)
		expect(permissionState.sessionIds.at(-1)).toBe("parent-session")
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
		const result = await gateway?.execute("gateway", { action: "list" }, undefined, undefined, createToolContext())

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
		const result = await gateway?.execute("gateway", { action: "list" }, undefined, undefined, createToolContext())

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
			createToolContext(),
		)

		expect(gatewayExecute).toHaveBeenCalledOnce()
		expect(result).toMatchObject({ content: [{ type: "text", text: "ok" }] })
	})

	describe("session-scoped call lookups", () => {
		function privateEntry(toolName: string, cachedAt = 1): ServerCacheEntry {
			return {
				configHash: computeServerHash({ command: "jira" }),
				cachedAt,
				resources: [],
				tools: [{ name: toolName, annotations: { readOnlyHint: true } }],
				cacheScope: "private",
			}
		}

		it("registers a lookup with the effective config including the Studio gateway", async () => {
			const docs = { command: "docs" }
			const gateway = {
				name: "kimchi-mcp-gateway",
				entry: { url: "https://api.cast.ai/mcp", lifecycle: "keep-alive" as const },
			}
			configState.config = { mcpServers: { docs } }
			gatewayState.server = gateway
			const harness = createExtensionApi()
			harness.api.events.on(MCP_RUNTIME_REGISTER_EVENT, (raw: unknown) => {
				;(raw as McpRuntimeRegistrationRequest).result = { ok: true, registration: { dispose: async () => {} } }
			})
			mcpAdapterExtension(harness.api)

			expect(lookupMcpCall(harness.api, "mcp", {})).toEqual({ kind: "not_mcp" })
			expect(describeMcpCall).not.toHaveBeenCalled()
			await start(harness)
			upstream.api?.registerTool(tool("mcp", "MCP"))
			expect(lookupMcpCall(harness.api, "mcp", { search: "issue" })).toEqual({ kind: "metadata", op: "status" })
			expect([...lastLookupCatalog().registeredToolNames]).toEqual(["mcp"])

			upstream.api?.registerTool(tool("docs_get_issue", "MCP: get_issue"))
			expect(lookupMcpCall(harness.api, "docs_get_issue", {})).toEqual({ kind: "metadata", op: "status" })
			const catalog = lastLookupCatalog()
			expect(catalog.config).toEqual({ mcpServers: { docs, [gateway.name]: gateway.entry } })
			expect([...catalog.registeredToolNames].sort()).toEqual(["docs_get_issue", "mcp"])
		})

		it("returns not_mcp for unregistered names without loading metadata or resolving", async () => {
			configState.config = { mcpServers: { docs: { command: "docs" } } }
			const harness = createExtensionApi()
			mcpAdapterExtension(harness.api)
			await start(harness)
			upstream.api?.registerTool(tool("mcp", "MCP"))
			metadataCache.loadMetadataCache.mockClear()
			callResolution.describeMcpCall.mockClear()

			expect(lookupMcpCall(harness.api, "bash", { command: "pwd" })).toEqual({ kind: "not_mcp" })
			expect(metadataCache.loadMetadataCache).not.toHaveBeenCalled()
			expect(describeMcpCall).not.toHaveBeenCalled()
		})

		it("returns not_mcp when another extension owns the live definition of an MCP name", async () => {
			configState.config = { mcpServers: { debug: { command: "debug" } } }
			const harness = createExtensionApi()
			mcpAdapterExtension(harness.api)
			await start(harness)
			upstream.api?.registerTool(tool("mcp", "MCP"))
			upstream.api?.registerTool(tool("debug_eval", "MCP: eval"))
			// Pi keeps the first registration per name; DAP's tool wins the live slot.
			harness.api.registerTool(tool("debug_eval", "DAP eval"))
			callResolution.describeMcpCall.mockClear()

			expect(lookupMcpCall(harness.api, "debug_eval", { expression: "1" })).toEqual({ kind: "not_mcp" })
			expect(describeMcpCall).not.toHaveBeenCalled()
		})

		it("returns not_mcp when an MCP name is missing from pi's live tool registry", async () => {
			configState.config = { mcpServers: { docs: { command: "docs" } } }
			const harness = createExtensionApi()
			mcpAdapterExtension(harness.api)
			await start(harness)
			upstream.api?.registerTool(tool("docs_get_issue", "MCP: get_issue"))
			const { unregisterTool } = harness.api as ExtensionAPI & { unregisterTool(name: string): boolean }
			unregisterTool("docs_get_issue")
			callResolution.describeMcpCall.mockClear()

			expect(lookupMcpCall(harness.api, "docs_get_issue", {})).toEqual({ kind: "not_mcp" })
			expect(describeMcpCall).not.toHaveBeenCalled()
		})

		it("keeps resolving a name the adapter registers again with a new definition", async () => {
			configState.config = { mcpServers: { docs: { command: "docs" } } }
			const harness = createExtensionApi()
			mcpAdapterExtension(harness.api)
			await start(harness)
			upstream.api?.registerTool(tool("docs_get_issue", "MCP: get_issue"))
			upstream.api?.registerTool(tool("docs_get_issue", "MCP: get_issue v2"))

			expect(lookupMcpCall(harness.api, "docs_get_issue", {})).toEqual({ kind: "metadata", op: "status" })
			expect(describeMcpCall).toHaveBeenCalled()
		})

		it("resolves caller-supplied ACP servers through their own lookup without sharing them", async () => {
			const first = createExtensionApi()
			createKimchiMcpAdapterExtension({ callerServers: { ide: { command: "first-ide" } } })(first.api)
			await start(first)
			const firstUpstream = upstream.api
			firstUpstream?.registerTool(tool("mcp", "MCP"))
			const second = createExtensionApi()
			createKimchiMcpAdapterExtension({ callerServers: { ide: { command: "second-ide" } } })(second.api)
			await start(second)
			upstream.api?.registerTool(tool("mcp", "MCP"))

			lookupMcpCall(first.api, "mcp", { server: "ide" })
			const firstCatalog = lastLookupCatalog()
			lookupMcpCall(second.api, "mcp", { server: "ide" })
			const secondCatalog = lastLookupCatalog()

			expect(firstCatalog.config).toEqual({ mcpServers: { ide: { command: "first-ide" } } })
			expect(secondCatalog.config).toEqual({ mcpServers: { ide: { command: "second-ide" } } })
			expect(firstCatalog.registeredToolNames).not.toBe(secondCatalog.registeredToolNames)
		})

		it("uses replaced private catalogs only in their owning session", async () => {
			configState.config = { mcpServers: { jira: { command: "jira" } } }
			const first = createExtensionApi()
			mcpAdapterExtension(first.api)
			await start(first)
			const firstObserver = upstream.sessionObserverFactory?.()
			const firstUpstream = upstream.api
			firstUpstream?.registerTool(tool("mcp", "MCP"))
			const second = createExtensionApi()
			mcpAdapterExtension(second.api)
			await start(second)
			const secondObserver = upstream.sessionObserverFactory?.()
			upstream.api?.registerTool(tool("mcp", "MCP"))
			const firstEntry = privateEntry("get_first")
			const secondEntry = privateEntry("get_second")
			firstObserver?.("jira", firstEntry)
			secondObserver?.("jira", secondEntry)

			lookupMcpCall(first.api, "mcp", {})
			expect(lastLookupCatalog().candidates.map(({ tool }) => tool.originalName)).toEqual(["get_first"])
			lookupMcpCall(second.api, "mcp", {})
			expect(lastLookupCatalog().candidates.map(({ tool }) => tool.originalName)).toEqual(["get_second"])

			const replacement = privateEntry("get_replacement", 2)
			firstObserver?.("jira", replacement)
			lookupMcpCall(first.api, "mcp", {})
			expect(lastLookupCatalog().candidates.map(({ tool }) => tool.originalName)).toEqual(["get_replacement"])
			lookupMcpCall(second.api, "mcp", {})
			expect(lastLookupCatalog().candidates.map(({ tool }) => tool.originalName)).toEqual(["get_second"])
			firstObserver?.("jira", { ...replacement, cacheScope: undefined })
			lookupMcpCall(first.api, "mcp", {})
			expect(lastLookupCatalog().candidates).toEqual([])
			lookupMcpCall(second.api, "mcp", {})
			expect(lastLookupCatalog().candidates.map(({ tool }) => tool.originalName)).toEqual(["get_second"])
		})

		it("refreshes the lookup on session replacement and clears it on shutdown", async () => {
			configState.config = { mcpServers: { jira: { command: "jira" } } }
			const harness = createExtensionApi()
			mcpAdapterExtension(harness.api)
			await start(harness)
			upstream.api?.registerTool(tool("mcp", "MCP"))
			upstream.sessionObserverFactory?.()?.("jira", privateEntry("get_old"))
			lookupMcpCall(harness.api, "mcp", {})
			expect(lastLookupCatalog().candidates.map(({ tool }) => tool.originalName)).toEqual(["get_old"])

			await start(harness)
			const replacementObserver = upstream.sessionObserverFactory?.()
			lookupMcpCall(harness.api, "mcp", {})
			expect(lastLookupCatalog().candidates).toEqual([])
			const currentEntry = privateEntry("get_current", 2)
			replacementObserver?.("jira", currentEntry)
			lookupMcpCall(harness.api, "mcp", {})
			expect(lastLookupCatalog().candidates.map(({ tool }) => tool.originalName)).toEqual(["get_current"])

			await harness.getHandler("session_shutdown")({ type: "session_shutdown" }, createContext())
			const callsBeforeClearedLookup = vi.mocked(describeMcpCall).mock.calls.length
			expect(lookupMcpCall(harness.api, "mcp", {})).toEqual({ kind: "not_mcp" })
			expect(describeMcpCall).toHaveBeenCalledTimes(callsBeforeClearedLookup)
		})

		describe("lookup config refresh on later session starts", () => {
			const docs = { command: "docs" }
			const jira = { command: "jira" }

			beforeEach(() => {
				vi.mocked(debugToolSurface).mockClear()
				vi.mocked(resolveMcpProjectTrust).mockClear()
				vi.mocked(migrateLegacyOAuthCredentials).mockClear()
			})

			function failClosedReasons(): string[] {
				return vi
					.mocked(debugToolSurface)
					.mock.calls.map(([line]) => line())
					.filter((line) => line.includes("call lookup failed closed"))
			}

			it("refreshes the lookup config on a later session start", async () => {
				configState.config = { mcpServers: { docs } }
				const harness = createExtensionApi()
				mcpAdapterExtension(harness.api)
				await start(harness)
				upstream.api?.registerTool(tool("mcp", "MCP"))
				lookupMcpCall(harness.api, "mcp", {})
				expect(lastLookupCatalog().config.mcpServers).toEqual({ docs })

				configState.config = { mcpServers: { docs, jira } }
				await restart(harness)
				lookupMcpCall(harness.api, "mcp", {})

				expect(lastLookupCatalog().config.mcpServers).toEqual({ docs, jira })
				expect(failClosedReasons()).toEqual([])
			})

			it("refreshes on every later start, including removed servers", async () => {
				configState.config = { mcpServers: { docs, jira } }
				const harness = createExtensionApi()
				mcpAdapterExtension(harness.api)
				await start(harness)
				upstream.api?.registerTool(tool("mcp", "MCP"))

				configState.config = { mcpServers: { docs } }
				await restart(harness)
				lookupMcpCall(harness.api, "mcp", {})
				expect(lastLookupCatalog().config.mcpServers).toEqual({ docs })

				configState.config = { mcpServers: { jira } }
				await restart(harness)
				lookupMcpCall(harness.api, "mcp", {})
				expect(lastLookupCatalog().config.mcpServers).toEqual({ jira })
			})

			it("does not prompt for project trust, migrate credentials, or recreate the adapter on refresh", async () => {
				const { createMcpAdapter } = await import("pi-mcp-adapter")
				vi.mocked(createMcpAdapter).mockClear()
				configState.config = { mcpServers: { docs } }
				configState.warnings = ["selected warning"]
				const harness = createExtensionApi()
				mcpAdapterExtension(harness.api)
				const first = await start(harness)
				expect(first.ui.notify).toHaveBeenCalledWith("selected warning", "warning")

				const later = await restart(harness)

				expect(resolveMcpProjectTrust).toHaveBeenCalledTimes(1)
				expect(migrateLegacyOAuthCredentials).toHaveBeenCalledTimes(1)
				expect(createMcpAdapter).toHaveBeenCalledTimes(1)
				// The saved warnings replay as before; the refresh adds none of its own.
				expect(later.ui.notify).toHaveBeenCalledTimes(1)
				expect(later.ui.notify).toHaveBeenCalledWith("selected warning", "warning")
			})

			it("reuses the first trust decision for the refreshed selection", async () => {
				projectTrust.trusted = true
				configState.config = { mcpServers: { docs } }
				configState.userConfig = { mcpServers: { jira } }
				const harness = createExtensionApi()
				mcpAdapterExtension(harness.api)
				await start(harness)
				upstream.api?.registerTool(tool("mcp", "MCP"))
				projectTrust.trusted = false
				configState.config = { mcpServers: { docs, jira } }

				await restart(harness)
				lookupMcpCall(harness.api, "mcp", {})

				expect(lastLookupCatalog().config.mcpServers).toEqual({ docs, jira })
			})

			it("keeps the first config in programmatic mode", async () => {
				configState.useProgrammaticConfig = true
				configState.config = { mcpServers: { docs } }
				const harness = createExtensionApi()
				mcpAdapterExtension(harness.api)
				await start(harness)
				upstream.api?.registerTool(tool("mcp", "MCP"))

				configState.config = { mcpServers: { docs, jira } }
				await restart(harness)
				lookupMcpCall(harness.api, "mcp", {})

				expect(lastLookupCatalog().config.mcpServers).toEqual({ docs })
				expect(failClosedReasons()).toEqual([])
			})

			it("keeps the first user-only config when the project is untrusted", async () => {
				projectTrust.trusted = false
				configState.userConfig = { mcpServers: { docs } }
				configState.config = { mcpServers: { jira } }
				const harness = createExtensionApi()
				mcpAdapterExtension(harness.api)
				await start(harness)
				upstream.api?.registerTool(tool("mcp", "MCP"))

				configState.userConfig = { mcpServers: { docs, jira } }
				await restart(harness)
				lookupMcpCall(harness.api, "mcp", {})

				expect(lastLookupCatalog().config.mcpServers).toEqual({ docs })
			})

			it("keeps caller servers fixed without refreshing", async () => {
				configState.config = { mcpServers: { docs } }
				const harness = createExtensionApi()
				createKimchiMcpAdapterExtension({ callerServers: { jira } })(harness.api)
				await start(harness)
				upstream.api?.registerTool(tool("mcp", "MCP"))

				configState.config = { mcpServers: { docs, other: { command: "other" } } }
				await restart(harness)
				lookupMcpCall(harness.api, "mcp", {})

				expect(lastLookupCatalog().config.mcpServers).toEqual({ docs, jira })
			})

			it("fails closed when the config source changes from file to programmatic", async () => {
				configState.config = { mcpServers: { docs } }
				const harness = createExtensionApi()
				mcpAdapterExtension(harness.api)
				await start(harness)
				upstream.api?.registerTool(tool("mcp", "MCP"))

				configState.useProgrammaticConfig = true
				await restart(harness)
				lookupMcpCall(harness.api, "mcp", {})

				expect(lastLookupCatalog().config).toEqual({ mcpServers: {} })
				expect(failClosedReasons()).toHaveLength(1)
				expect(failClosedReasons()[0]).toContain("config source changed")
			})

			// Mock-only guard: the first start and the refresh both pass the same overridePath, so a real configPath
			// cannot change between them today. The test pins the source comparison in case that invariant ever breaks.
			it("fails closed when the config file path changes", async () => {
				configState.config = { mcpServers: { docs } }
				configState.configPath = "/tmp/a.json"
				const harness = createExtensionApi()
				mcpAdapterExtension(harness.api)
				await start(harness)
				upstream.api?.registerTool(tool("mcp", "MCP"))

				configState.configPath = "/tmp/b.json"
				await restart(harness)
				lookupMcpCall(harness.api, "mcp", {})

				expect(lastLookupCatalog().config).toEqual({ mcpServers: {} })
				expect(failClosedReasons()).toHaveLength(1)
			})

			it("fails closed when the shared default config path changes", async () => {
				configState.config = { mcpServers: { docs } }
				const harness = createExtensionApi()
				mcpAdapterExtension(harness.api)
				await start(harness)
				upstream.api?.registerTool(tool("mcp", "MCP"))

				configState.sharedConfigPath = "/tmp/elsewhere/mcp.json"
				await restart(harness)
				lookupMcpCall(harness.api, "mcp", {})

				expect(lastLookupCatalog().config).toEqual({ mcpServers: {} })
				expect(failClosedReasons()).toHaveLength(1)
				expect(failClosedReasons()[0]).toContain("config source changed")
			})

			it("fails closed when a later session starts in another cwd", async () => {
				configState.config = { mcpServers: { docs } }
				const harness = createExtensionApi()
				mcpAdapterExtension(harness.api)
				await start(harness, createContext({ cwd: "/a", isProjectTrusted: () => true }))
				upstream.api?.registerTool(tool("mcp", "MCP"))
				lookupMcpCall(harness.api, "mcp", {})
				expect(lastLookupCatalog().config.mcpServers).toEqual({ docs })

				configState.config = { mcpServers: { docs, jira } }
				await restart(harness, createContext({ cwd: "/b", isProjectTrusted: () => true }))
				lookupMcpCall(harness.api, "mcp", {})

				expect(lastLookupCatalog().config).toEqual({ mcpServers: {} })
				expect(failClosedReasons()).toHaveLength(1)
				expect(failClosedReasons()[0]).toContain("session cwd changed")
			})

			it("uses options.cwd, not the session cwd, to detect a cwd change", async () => {
				configState.config = { mcpServers: { docs } }
				const harness = createExtensionApi()
				createKimchiMcpAdapterExtension({ cwd: "/fixed" })(harness.api)
				await start(harness, createContext({ cwd: "/a", isProjectTrusted: () => true }))
				upstream.api?.registerTool(tool("mcp", "MCP"))

				configState.config = { mcpServers: { docs, jira } }
				await restart(harness, createContext({ cwd: "/a", isProjectTrusted: () => true }))
				lookupMcpCall(harness.api, "mcp", {})

				expect(lastLookupCatalog().config.mcpServers).toEqual({ docs, jira })
				expect(failClosedReasons()).toEqual([])
			})

			// The adapter re-reads its config with ctx.cwd, so a fixed options.cwd cannot vouch for that read.
			it("fails closed when the adapter session cwd changes under a fixed options.cwd", async () => {
				configState.config = { mcpServers: { docs } }
				const harness = createExtensionApi()
				createKimchiMcpAdapterExtension({ cwd: "/fixed" })(harness.api)
				await start(harness, createContext({ cwd: "/a", isProjectTrusted: () => true }))
				upstream.api?.registerTool(tool("mcp", "MCP"))

				configState.config = { mcpServers: { docs, jira } }
				await restart(harness, createContext({ cwd: "/b", isProjectTrusted: () => true }))
				lookupMcpCall(harness.api, "mcp", {})

				expect(lastLookupCatalog().config).toEqual({ mcpServers: {} })
				expect(failClosedReasons()).toHaveLength(1)
				expect(failClosedReasons()[0]).toContain("adapter session cwd changed")
			})

			it("logs refreshed config warnings as debug diagnostics only", async () => {
				configState.config = { mcpServers: { docs } }
				const harness = createExtensionApi()
				mcpAdapterExtension(harness.api)
				await start(harness)
				upstream.api?.registerTool(tool("mcp", "MCP"))

				configState.warnings = ["Failed to load selected MCP config from /tmp/x.json: bad json"]
				const later = await restart(harness)
				lookupMcpCall(harness.api, "mcp", {})

				const lines = vi.mocked(debugToolSurface).mock.calls.map(([line]) => line())
				expect(lines).toContain(
					"[mcp] call lookup refresh warning: Failed to load selected MCP config from /tmp/x.json: bad json",
				)
				expect(later.ui.notify).not.toHaveBeenCalled()
				expect(failClosedReasons()).toEqual([])
			})

			it("recovers from a fail-closed start when a later start matches the first again", async () => {
				configState.config = { mcpServers: { docs } }
				const harness = createExtensionApi()
				mcpAdapterExtension(harness.api)
				await start(harness, createContext({ cwd: "/a", isProjectTrusted: () => true }))
				upstream.api?.registerTool(tool("mcp", "MCP"))
				await restart(harness, createContext({ cwd: "/b", isProjectTrusted: () => true }))

				await restart(harness, createContext({ cwd: "/a", isProjectTrusted: () => true }))
				lookupMcpCall(harness.api, "mcp", {})

				expect(lastLookupCatalog().config.mcpServers).toEqual({ docs })
			})

			it("fails closed and logs when the refreshed config cannot be loaded", async () => {
				configState.config = { mcpServers: { docs } }
				const harness = createExtensionApi()
				mcpAdapterExtension(harness.api)
				await start(harness)
				upstream.api?.registerTool(tool("mcp", "MCP"))
				configState.loadError = new Error("unreadable config")

				await restart(harness)
				lookupMcpCall(harness.api, "mcp", {})

				expect(lastLookupCatalog().config).toEqual({ mcpServers: {} })
				expect(failClosedReasons()).toHaveLength(1)
				expect(failClosedReasons()[0]).toContain("unreadable config")
			})

			it("keeps the Studio gateway in a refreshed config", async () => {
				const gateway = {
					name: "kimchi-mcp-gateway",
					entry: { url: "https://api.cast.ai/mcp", lifecycle: "keep-alive" as const },
				}
				configState.config = { mcpServers: { docs } }
				gatewayState.server = gateway
				const harness = createExtensionApi()
				harness.api.events.on(MCP_RUNTIME_REGISTER_EVENT, (raw: unknown) => {
					;(raw as McpRuntimeRegistrationRequest).result = { ok: true, registration: { dispose: async () => {} } }
				})
				mcpAdapterExtension(harness.api)
				await start(harness)
				upstream.api?.registerTool(tool("mcp", "MCP"))

				configState.config = { mcpServers: { docs, jira } }
				await restart(harness)
				lookupMcpCall(harness.api, "mcp", {})

				expect(lastLookupCatalog().config).toEqual({ mcpServers: { docs, jira, [gateway.name]: gateway.entry } })
			})

			it("drops the Studio gateway when a refreshed server takes its name", async () => {
				const gateway = {
					name: "kimchi-mcp-gateway",
					entry: { url: "https://api.cast.ai/mcp", lifecycle: "keep-alive" as const },
				}
				configState.config = { mcpServers: { docs } }
				gatewayState.server = gateway
				const harness = createExtensionApi()
				harness.api.events.on(MCP_RUNTIME_REGISTER_EVENT, (raw: unknown) => {
					;(raw as McpRuntimeRegistrationRequest).result = { ok: true, registration: { dispose: async () => {} } }
				})
				mcpAdapterExtension(harness.api)
				await start(harness)
				upstream.api?.registerTool(tool("mcp", "MCP"))

				const own = { url: "https://proxy.corp.example/mcp" }
				configState.config = { mcpServers: { docs, [gateway.name]: own } }
				await restart(harness)
				lookupMcpCall(harness.api, "mcp", {})

				expect(lastLookupCatalog().config.mcpServers).toEqual({ docs, [gateway.name]: own })
			})

			it("keeps the lazy gateway entry in a refreshed config", async () => {
				const gateway = {
					name: "kimchi-mcp-gateway",
					entry: { url: "https://api.cast.ai/mcp", lifecycle: "keep-alive" as const },
				}
				configState.config = { mcpServers: { docs } }
				const harness = createExtensionApi()
				harness.api.events.on(MCP_RUNTIME_REGISTER_EVENT, (raw: unknown) => {
					;(raw as McpRuntimeRegistrationRequest).result = { ok: true, registration: { dispose: async () => {} } }
				})
				createKimchiMcpAdapterExtension({ builtinGateway: gateway, lazyGatewayConnect: true })(harness.api)
				await start(harness)
				upstream.api?.registerTool(tool("mcp", "MCP"))

				await restart(harness)
				lookupMcpCall(harness.api, "mcp", {})

				const refreshed = lastLookupCatalog().config.mcpServers[gateway.name]
				expect(refreshed).toMatchObject({ url: gateway.entry.url, directTools: false })
				expect(refreshed.lifecycle).toBeUndefined()
			})

			it("resolves a direct tool after shutdown and a replacement start re-register it", async () => {
				const actual = await vi.importActual<typeof import("./call-facts.js")>("./call-facts.js")
				callResolution.describeMcpCall.mockImplementation(actual.describeMcpCall)
				configState.config = { mcpServers: { docs } }
				metadataCache.loadMetadataCache.mockReturnValue({
					version: 1,
					servers: {
						docs: {
							configHash: computeServerHash(docs),
							cachedAt: Date.now(),
							resources: [],
							tools: [{ name: "get_issue", annotations: { readOnlyHint: true } }],
						},
					},
				})
				const harness = createExtensionApi()
				mcpAdapterExtension(harness.api)
				await start(harness)
				const firstDefinition = tool("docs_get_issue", "MCP: get_issue")
				upstream.api?.registerTool(firstDefinition)
				const expected = { kind: "tool", via: "direct", server: "docs", tool: "get_issue" }
				expect(lookupMcpCall(harness.api, "docs_get_issue", {})).toMatchObject(expected)

				await restart(harness)
				const replacementDefinition = tool("docs_get_issue", "MCP: get_issue")
				expect(replacementDefinition.parameters).not.toBe(firstDefinition.parameters)
				upstream.api?.registerTool(replacementDefinition)

				expect(lookupMcpCall(harness.api, "docs_get_issue", {})).toMatchObject(expected)
			})

			it("keeps registered tool names live across a refresh", async () => {
				configState.config = { mcpServers: { docs } }
				const harness = createExtensionApi()
				mcpAdapterExtension(harness.api)
				await start(harness)
				upstream.api?.registerTool(tool("mcp", "MCP"))
				await restart(harness)
				upstream.api?.registerTool(tool("docs_get_issue", "MCP: get_issue"))
				lookupMcpCall(harness.api, "docs_get_issue", {})

				expect([...lastLookupCatalog().registeredToolNames].sort()).toEqual(["docs_get_issue", "mcp"])
			})

			it("does not carry private catalogs into a refreshed config", async () => {
				configState.config = { mcpServers: { jira } }
				const harness = createExtensionApi()
				mcpAdapterExtension(harness.api)
				await start(harness)
				upstream.api?.registerTool(tool("mcp", "MCP"))
				upstream.sessionObserverFactory?.()?.("jira", privateEntry("get_old"))

				configState.config = { mcpServers: { jira, docs } }
				await restart(harness)
				lookupMcpCall(harness.api, "mcp", {})

				expect(lastLookupCatalog().config.mcpServers).toEqual({ jira, docs })
				expect(lastLookupCatalog().candidates).toEqual([])
			})
		})

		it("ignores late private-catalog updates from a replaced session", async () => {
			configState.config = { mcpServers: { jira: { command: "jira" } } }
			const harness = createExtensionApi()
			mcpAdapterExtension(harness.api)
			await start(harness)
			const staleObserver = upstream.sessionObserverFactory?.()
			upstream.api?.registerTool(tool("mcp", "MCP"))
			await start(harness)
			const currentObserver = upstream.sessionObserverFactory?.()
			const currentEntry = privateEntry("get_current", 2)
			currentObserver?.("jira", currentEntry)

			expect(staleObserver).toBeDefined()
			staleObserver?.("jira", privateEntry("get_stale"))
			lookupMcpCall(harness.api, "mcp", {})

			expect(lastLookupCatalog().candidates.map(({ tool }) => tool.originalName)).toEqual(["get_current"])
		})

		it("loads metadata once across repeated lookups while nothing changes", async () => {
			configState.config = { mcpServers: { docs: { command: "docs" } } }
			const harness = createExtensionApi()
			mcpAdapterExtension(harness.api)
			await start(harness)
			upstream.api?.registerTool(tool("mcp", "MCP"))
			metadataCache.loadMetadataCache.mockClear()

			for (let call = 0; call < 3; call++) lookupMcpCall(harness.api, "mcp", { search: "issue" })

			expect(metadataCache.loadMetadataCache).toHaveBeenCalledTimes(1)
			expect(vi.mocked(describeMcpCall)).toHaveBeenCalledTimes(3)
		})

		it("rebuilds the lookup catalog when the cache file stamp changes", async () => {
			const docs = { command: "docs" }
			configState.config = { mcpServers: { docs } }
			const cacheWith = (toolName: string): MetadataCache => ({
				version: 1,
				servers: {
					docs: {
						configHash: computeServerHash(docs),
						cachedAt: Date.now(),
						resources: [],
						tools: [{ name: toolName, annotations: { readOnlyHint: true } }],
					},
				},
			})
			metadataCache.loadMetadataCache.mockReturnValue(cacheWith("get_old"))
			const harness = createExtensionApi()
			mcpAdapterExtension(harness.api)
			await start(harness)
			upstream.api?.registerTool(tool("mcp", "MCP"))

			lookupMcpCall(harness.api, "mcp", {})
			expect(lastLookupCatalog().candidates.map(({ tool }) => tool.originalName)).toEqual(["get_old"])

			metadataCache.loadMetadataCache.mockReturnValue(cacheWith("get_new"))
			cacheStampState.stamp = { ...baseCacheStamp, mtimeNs: baseCacheStamp.mtimeNs + 1n }
			lookupMcpCall(harness.api, "mcp", {})

			expect(lastLookupCatalog().candidates.map(({ tool }) => tool.originalName)).toEqual(["get_new"])
			expect(metadataCache.loadMetadataCache).toHaveBeenCalledTimes(2)
		})

		it("rebuilds the lookup catalog when the cache file stamp is unknown", async () => {
			configState.config = { mcpServers: { docs: { command: "docs" } } }
			const harness = createExtensionApi()
			mcpAdapterExtension(harness.api)
			await start(harness)
			upstream.api?.registerTool(tool("mcp", "MCP"))
			cacheStampState.stamp = null
			metadataCache.loadMetadataCache.mockClear()

			lookupMcpCall(harness.api, "mcp", {})
			lookupMcpCall(harness.api, "mcp", {})

			expect(metadataCache.loadMetadataCache).toHaveBeenCalledTimes(2)
		})

		it("rebuilds the lookup catalog after a private catalog update", async () => {
			configState.config = { mcpServers: { jira: { command: "jira" } } }
			const harness = createExtensionApi()
			mcpAdapterExtension(harness.api)
			await start(harness)
			upstream.api?.registerTool(tool("mcp", "MCP"))
			metadataCache.loadMetadataCache.mockClear()

			lookupMcpCall(harness.api, "mcp", {})
			const before = lastLookupCatalog()
			expect(metadataCache.loadMetadataCache).toHaveBeenCalledTimes(1)

			upstream.sessionMetadataObserver?.("jira", privateEntry("get_issue"))
			lookupMcpCall(harness.api, "mcp", {})

			const after = lastLookupCatalog()
			expect(after).not.toBe(before)
			expect(after.candidates.map(({ tool }) => tool.originalName)).toEqual(["get_issue"])
			expect(metadataCache.loadMetadataCache).toHaveBeenCalledTimes(2)
		})

		it("shares one catalog between the call lookup and the read-only callbacks", async () => {
			configState.config = { mcpServers: { docs: { command: "docs" } } }
			planning.currentProfile = "planning-adhoc"
			readOnlyState.wireNames.add("docs_get_issue")
			const harness = createExtensionApi()
			mcpAdapterExtension(harness.api)
			await start(harness)
			upstream.api?.registerTool(tool("mcp", "MCP"))
			metadataCache.loadMetadataCache.mockClear()

			lookupMcpCall(harness.api, "mcp", {})
			const lookupCatalog = lastLookupCatalog()
			const gatewayExecute = vi.fn(tool("mcp", "MCP").execute)
			upstream.api?.registerTool({ ...tool("mcp", "MCP"), execute: gatewayExecute })
			await harness
				.getRegisteredTool("mcp")
				.execute(
					"gateway",
					{ tool: "docs_get_issue", server: "docs", args: {} },
					undefined,
					undefined,
					createToolContext(),
				)
			// The provider is the adapter-facing path that asks for the read-only wire names.
			const provider = planning.registerReadOnlyToolProvider.mock.calls.at(-1)?.[1]
			expect(provider?.()).toEqual(["mcp"])

			expect(gatewayExecute).toHaveBeenCalledOnce()
			expect(readOnlyState.gatewayCatalogs.at(-1)).toBe(lookupCatalog)
			expect(readOnlyState.wireNameCandidates.at(-1)).toBe(lookupCatalog.candidates)
			expect(metadataCache.loadMetadataCache).toHaveBeenCalledTimes(1)
		})

		it("does not carry private catalogs into a replacement session", async () => {
			configState.config = { mcpServers: { jira: { command: "jira" } } }
			const harness = createExtensionApi()
			mcpAdapterExtension(harness.api)
			await start(harness)
			upstream.api?.registerTool(tool("mcp", "MCP"))
			upstream.sessionObserverFactory?.()?.("jira", privateEntry("get_old"))
			lookupMcpCall(harness.api, "mcp", {})
			expect(lastLookupCatalog().candidates.map(({ tool }) => tool.originalName)).toEqual(["get_old"])

			await harness.getHandler("session_shutdown")({ type: "session_shutdown" }, createContext())
			await start(harness)
			upstream.api?.registerTool(tool("mcp", "MCP"))
			lookupMcpCall(harness.api, "mcp", {})

			expect(lastLookupCatalog().candidates).toEqual([])
		})
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
			defaultProtocolVersion: "auto",
		})

		planning.currentProfile = "planning-adhoc"
		readOnlyState.wireNames.add("callerOnly_get_issue")
		const gatewayExecute = vi.fn(tool("mcp", "MCP").execute)
		upstream.api?.registerTool({ ...tool("mcp", "MCP"), execute: gatewayExecute })
		await harness
			.getRegisteredTool("mcp")
			.execute(
				"gateway",
				{ tool: "callerOnly_get_issue", server: "callerOnly", args: {} },
				undefined,
				undefined,
				createToolContext(),
			)
		expect(gatewayExecute).toHaveBeenCalledOnce()
		expect(readOnlyState.authorizationConfigs.at(-1)?.mcpServers).toMatchObject({
			shared: { command: "from-acp" },
			callerOnly: { command: "caller-only" },
		})
	})

	it("isolates observed private catalogs to the adapter session that discovered them", async () => {
		configState.config = { mcpServers: { jira: { command: "jira" } } }
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		planning.currentProfile = "planning-adhoc"
		readOnlyState.wireNames.add("jira_get_issue")
		await start(harness)

		const entry: ServerCacheEntry = {
			// Must match the configured server's hash: a mismatched private entry is filtered out before the candidates assertion.
			configHash: computeServerHash({ command: "jira" }),
			cachedAt: 1,
			resources: [],
			tools: [{ name: "get_issue", annotations: { readOnlyHint: true } }],
			cacheScope: "private",
		}
		const gatewayCandidateNames = () =>
			readOnlyState.gatewayCatalogs.at(-1)?.candidates.map(({ tool }) => tool.originalName)
		upstream.sessionObserverFactory?.()?.("jira", entry)
		const gatewayExecute = vi.fn(tool("mcp", "MCP").execute)
		upstream.api?.registerTool({ ...tool("mcp", "MCP"), execute: gatewayExecute })
		const gateway = harness.getRegisteredTool("mcp")
		await gateway.execute(
			"first",
			{ tool: "jira_get_issue", server: "jira", args: {} },
			undefined,
			undefined,
			createToolContext(),
		)
		expect(gatewayCandidateNames()).toEqual(["get_issue"])

		await start(harness)
		const replacementObserver = upstream.sessionObserverFactory?.()
		replacementObserver?.("jira", entry)
		await gateway.execute(
			"second",
			{ tool: "jira_get_issue", server: "jira", args: {} },
			undefined,
			undefined,
			createToolContext(),
		)
		expect(gatewayCandidateNames()).toEqual(["get_issue"])
		expect(gatewayExecute).toHaveBeenCalledTimes(2)
		await harness.getHandler("session_shutdown")({ type: "session_shutdown" }, createContext())
		replacementObserver?.("jira", entry)
		const catalogsBeforeThird = readOnlyState.gatewayCatalogs.length
		await gateway.execute(
			"third",
			{ tool: "jira_get_issue", server: "jira", args: {} },
			undefined,
			undefined,
			createToolContext(),
		)
		// Not an exact count: gateway execution consults the read-only callback twice per execute.
		expect(readOnlyState.gatewayCatalogs.length).toBeGreaterThan(catalogsBeforeThird)
		expect(gatewayCandidateNames()).toEqual([])
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
			defaultProtocolVersion: "auto",
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

	it.each([
		"mcp_servers_change",
		"session_start",
	])("routes adapter %s handler contexts through the branding layer", async (event) => {
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		const ctx = await start(harness)
		const handler = vi.fn()
		oauthBranding.brandedContext.mockClear()

		// ExtensionAPI.on has per-event overloads; emit dispatches by name.
		const looseApi = upstream.api as unknown as {
			on(event: string, handler: (value: unknown, ctx: unknown) => unknown): void
		}
		looseApi.on(event, handler)
		await harness.emit(event, {}, ctx)

		expect(handler).toHaveBeenCalledOnce()
		expect(oauthBranding.brandedContext).toHaveBeenCalledWith(ctx)
	})

	it("does not expose the upstream /pi-mcp or /mcp-adapter aliases", async () => {
		const harness = createExtensionApi()
		mcpAdapterExtension(harness.api)
		await start(harness)

		upstream.api?.registerCommand("mcp", { async handler() {} })
		upstream.api?.registerCommand("pi-mcp", { async handler() {} })
		upstream.api?.registerCommand("mcp-adapter", { async handler() {} })

		expect(harness.api.registerCommand).toHaveBeenCalledTimes(1)
		expect(harness.api.registerCommand).toHaveBeenCalledWith("mcp", expect.anything())
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
			// Scope to the log production code emits for this path instead of a
			// global call count: console.error is shared, and stray error logs
			// from unrelated async work made the unscoped assertion flake in CI.
			expect(
				errorSpy.mock.calls.some(
					([first]) => typeof first === "string" && first.includes("[tool-surface] mcp status resnapshot failed"),
				),
			).toBe(false)
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
			// Match the resnapshot-failure log instead of asserting a global call
			// count: console.error is shared, and stray error logs from unrelated
			// async work made the exact count flake in CI (spy called 1 times,
			// but got 2).
			const resnapshotFailures = errorSpy.mock.calls.filter(
				([first]) => typeof first === "string" && first.includes("[tool-surface] mcp status resnapshot failed"),
			)
			expect(resnapshotFailures.length).toBeGreaterThanOrEqual(1)
			expect(resnapshotFailures.some(([, detail]) => String(detail).includes("registry exploded"))).toBe(true)
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
		const ctx = createToolContext()

		await harness.getHandler("session_start")({ type: "session_start", reason: "startup" }, ctx)

		expect(ctx.ui.notify).toHaveBeenCalledWith("legacy config is malformed", "warning")
		expect(ctx.ui.notify).toHaveBeenCalledWith("legacy OAuth entry conflicts with the upstream layout", "warning")
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("mcpSearch no longer controls"), "warning")
	})
})
