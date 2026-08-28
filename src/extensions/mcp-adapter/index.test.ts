import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildSystemPrompt, type EnvironmentInfo } from "../prompt-construction/system-prompt.js"
import mcpAdapter from "./index.js"
import { executeCall, executeDescribe, executeSearch } from "./proxy-modes.js"
import type { McpExtensionState } from "./state.js"
import type { DirectToolSpec, ToolMetadata } from "./types.js"

// Token-optimization Chunk 5 gate tests need control over the REGISTERED
// proxy surface, which is derived from loadMcpConfig() at factory time.
// Mock it so the gate is deterministic and does not read (or purge) the
// developer machine's ambient mcp.json / mcp-cache.json.
const mcpConfigState = vi.hoisted(() => ({
	config: {
		mcpServers: {} as Record<string, unknown>,
		settings: undefined as { disableProxyTool?: boolean } | undefined,
	},
}))
vi.mock("./config.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./config.js")>()
	return {
		...original,
		loadMcpConfig: () => ({ config: mcpConfigState.config, warnings: [] }),
	}
})
vi.mock("./metadata-cache.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./metadata-cache.js")>()
	return {
		...original,
		// No ambient cache: prevents purgeStaleEntries from deleting and
		// overwriteMetadataCache from rewriting the real user cache file.
		loadMetadataCache: () => undefined,
		overwriteMetadataCache: () => {},
		flushMetadataCache: () => {},
	}
})

const testEnv: EnvironmentInfo = {
	os: "Linux",
	rawPlatform: "linux",
	cpuArchitecture: "x64",
	shell: "/bin/bash",
	osRelease: "6.1.0-test",
	osVersion: "#1 SMP PREEMPT_DYNAMIC Test",
	username: "testuser",
	homeDir: "/home/testuser",
	cwd: "/home/testuser/project",
	documentsDir: "/home/testuser/project/.kimchi/docs",
	localDate: "2026-01-01",
	isGitRepo: false,
}

type Handler = (event: unknown, ctx: unknown) => unknown

const TEST_SESSION_ID = "test-session"

function makePi(): ExtensionAPI & { fireShutdown: () => Promise<void> } {
	const handlers = new Map<string, Handler[]>()
	const tools: ToolInfo[] = []
	let activeTools: string[] = []
	const sessionStartCtx = { sessionManager: { getSessionId: () => TEST_SESSION_ID } }
	const pi = {
		registerFlag: () => {},
		registerCommand: () => {},
		registerTool: (tool: ToolInfo) => {
			tools.push(tool)
			activeTools.push(tool.name)
		},
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
			// Fire session_start synchronously on registration so sessionIdByPi
			// is populated before any render call (mirrors pi-mono behavior).
			if (event === "session_start") handler({}, sessionStartCtx)
		},
		getAllTools: () => tools,
		getActiveTools: () => activeTools,
		setActiveTools: (toolNames: string[]) => {
			activeTools = toolNames
		},
		getFlag: () => undefined,
		fireShutdown: async () => {
			for (const handler of handlers.get("session_shutdown") ?? []) {
				await handler({}, {})
			}
		},
	}
	return pi as unknown as ExtensionAPI & { fireShutdown: () => Promise<void> }
}

beforeEach(() => {
	// Default to one fake server: the Chunk 5 registration gate requires at
	// least one configured MCP server to register the proxy tool. Gate-off
	// tests explicitly empty this map.
	mcpConfigState.config.mcpServers = { "test-server": { command: "definitely-not-a-real-kimchi-test-binary" } }
})

afterEach(() => {
	vi.unstubAllEnvs()
	mcpConfigState.config.mcpServers = {}
})

// ---------------------------------------------------------------------------
// Helpers for inject-path tests
// ---------------------------------------------------------------------------

function makeMetadata(rawName: string, serverName: string, prefix: "server" | "none" | "short"): ToolMetadata {
	// Mirrors what buildToolMetadata in tool-metadata.ts produces
	const p =
		prefix === "none"
			? ""
			: prefix === "short"
				? serverName.replace(/-?mcp$/i, "").replace(/-/g, "_") || "mcp"
				: serverName.replace(/-/g, "_")
	const prefixedName = p ? `${p}_${rawName}` : rawName
	return {
		name: prefixedName,
		originalName: rawName,
		description: "test tool",
		inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
	}
}

function makeState(meta: ToolMetadata, serverName: string): McpExtensionState {
	return {
		manager: {} as McpExtensionState["manager"],
		lifecycle: {} as McpExtensionState["lifecycle"],
		toolMetadata: new Map([[serverName, [meta]]]),
		config: { mcpServers: { [serverName]: {} as McpExtensionState["config"]["mcpServers"][string] } },
		failureTracker: new Map(),
		uiResourceHandler: {} as McpExtensionState["uiResourceHandler"],
		consentManager: {} as McpExtensionState["consentManager"],
		uiServer: null,
		completedUiSessions: [],
		openBrowser: async () => {},
		dynamicToolNames: new Set(),
	} as unknown as McpExtensionState
}

describe("mcp proxy registration gate (token-optimization Phase 1 Chunk 5)", () => {
	it("registers the proxy tool when at least one MCP server is configured", async () => {
		vi.stubEnv("MCP_DIRECT_TOOLS", "__none__")
		const pi = makePi()
		mcpAdapter(pi)
		try {
			expect(pi.getAllTools().map((t) => t.name)).toContain("mcp")
		} finally {
			await pi.fireShutdown()
		}
	})

	it("skips registering the proxy tool when zero MCP servers are configured", async () => {
		vi.stubEnv("MCP_DIRECT_TOOLS", "__none__")
		mcpConfigState.config.mcpServers = {}
		const pi = makePi()
		mcpAdapter(pi)
		try {
			expect(pi.getAllTools().map((t) => t.name)).not.toContain("mcp")
		} finally {
			await pi.fireShutdown()
		}
	})

	it("still skips the proxy when disableProxyTool is false but no servers exist", async () => {
		vi.stubEnv("MCP_DIRECT_TOOLS", "__none__")
		mcpConfigState.config.mcpServers = {}
		mcpConfigState.config.settings = { disableProxyTool: false }
		try {
			const pi = makePi()
			mcpAdapter(pi)
			try {
				expect(pi.getAllTools().map((t) => t.name)).not.toContain("mcp")
			} finally {
				await pi.fireShutdown()
			}
		} finally {
			delete mcpConfigState.config.settings
		}
	})
})

describe("mcp adapter system prompt block", () => {
	it("does not inject a dedicated MCP discovery block (consolidated into core ## Tool Selection)", async () => {
		vi.stubEnv("MCP_DIRECT_TOOLS", "__none__")
		const pi = makePi()
		mcpAdapter(pi)

		try {
			const result = buildSystemPrompt({
				tools: pi.getAllTools(),
				env: testEnv,
				mode: "orchestrator",
				sessionId: TEST_SESSION_ID,
			})

			// The MCP discovery guidance is now part of the consolidated
			// `## Tool Selection` core section, not injected by the
			// adapter. The adapter must not duplicate it.
			expect(result).not.toContain("## Tool and MCP Discovery")
			// Consolidated core section must still cover the MCP guidance.
			expect(result).toContain("## Tool Selection")
			expect(result).toContain("mcp({ search")
			expect(result).toContain('<tool name="mcp">')
		} finally {
			await pi.fireShutdown()
		}
	})
})

describe("proxy native tool boundaries", () => {
	it("labels active native tools as direct-only search results and does not inject them as MCP tools", () => {
		const state = makeState(makeMetadata("pal_chat", "pal", "server"), "pal")
		const onInject = vi.fn()

		const result = executeSearch(
			state,
			"propose_ferment_scoping",
			undefined,
			undefined,
			true,
			() =>
				[
					{
						name: "propose_ferment_scoping",
						description: "draft ferment scope",
						parameters: {},
					},
				] as ToolInfo[],
			5,
			undefined,
			onInject,
		)

		const block = result.content[0]
		const text = block.type === "text" ? block.text : ""
		expect(text).toContain("[native tool] propose_ferment_scoping")
		expect(text).toContain("do not call it through mcp")
		expect(onInject).not.toHaveBeenCalled()
		expect(result.details).toMatchObject({
			matches: [{ server: "native", tool: "propose_ferment_scoping", dispatch: "direct" }],
		})
	})

	it("explains that native tools are not callable through mcp({ tool })", async () => {
		const state = makeState(makeMetadata("pal_chat", "pal", "server"), "pal")

		const result = await executeCall(
			state,
			"propose_ferment_scoping",
			undefined,
			undefined,
			undefined,
			undefined,
			() => ({
				tool: { name: "propose_ferment_scoping", description: "draft ferment scope", parameters: {} } as ToolInfo,
				active: false,
			}),
		)

		const block = result.content[0]
		const text = block.type === "text" ? block.text : ""
		expect(text).toContain('Tool "propose_ferment_scoping" is a native agent tool')
		expect(text).toContain("not active in the current context")
		expect(result.details).toMatchObject({ error: "native_tool_not_mcp", active: false })
	})

	it("explains that native tools are described by the native tool surface, not MCP describe", () => {
		const state = makeState(makeMetadata("pal_chat", "pal", "server"), "pal")

		const result = executeDescribe(state, "propose_ferment_scoping", undefined, () => ({
			tool: { name: "propose_ferment_scoping", description: "draft ferment scope", parameters: {} } as ToolInfo,
			active: true,
		}))

		const block = result.content[0]
		const text = block.type === "text" ? block.text : ""
		expect(text).toContain('Tool "propose_ferment_scoping" is a native agent tool')
		expect(text).toContain("Call it directly as propose_ferment_scoping")
		expect(result.details).toMatchObject({ error: "native_tool_not_mcp", active: true })
	})
})

// ---------------------------------------------------------------------------
// inject-path: spec correctness for executeSearch / executeDescribe
// ---------------------------------------------------------------------------

describe.each(["none", "server", "short"] as const)("inject-path (toolPrefix=%s)", (prefix) => {
	const SERVER = "pal"
	const RAW_NAME = "pal_chat"

	it("executeSearch: spec.originalName is raw, spec.prefixedName matches metadata.name", () => {
		const meta = makeMetadata(RAW_NAME, SERVER, prefix)
		const state = makeState(meta, SERVER)
		const capturedSpecs: DirectToolSpec[] = []

		executeSearch(state, "chat", undefined, undefined, undefined, undefined, 5, undefined, (specs) => {
			capturedSpecs.push(...specs)
			return specs.map((s) => s.prefixedName)
		})

		expect(capturedSpecs).toHaveLength(1)
		expect(capturedSpecs[0].originalName).toBe(RAW_NAME)
		expect(capturedSpecs[0].prefixedName).toBe(meta.name)
	})

	it("executeSearch: display name and injected name are the same string", () => {
		const meta = makeMetadata(RAW_NAME, SERVER, prefix)
		const state = makeState(meta, SERVER)
		let injectedNames: string[] = []

		const result = executeSearch(state, "chat", undefined, undefined, undefined, undefined, 5, undefined, (specs) => {
			injectedNames = specs.map((s) => s.prefixedName)
			return injectedNames
		})

		const block = result.content[0]
		const text = block.type === "text" ? block.text : ""
		expect(injectedNames).toHaveLength(1)
		// The displayed name (metadata.name) appears in the output body
		expect(text).toContain(meta.name)
		// The injected name suffix references the exact same name
		expect(text).toContain(injectedNames[0])
		expect(injectedNames[0]).toBe(meta.name)
	})

	it("executeDescribe: spec.originalName is raw, spec.prefixedName matches metadata.name", () => {
		const meta = makeMetadata(RAW_NAME, SERVER, prefix)
		const state = makeState(meta, SERVER)
		const capturedSpecs: DirectToolSpec[] = []

		// describe accepts either the prefixed or raw name via findToolByName
		executeDescribe(state, meta.name, (specs) => {
			capturedSpecs.push(...specs)
			return specs.map((s) => s.prefixedName)
		})

		expect(capturedSpecs).toHaveLength(1)
		expect(capturedSpecs[0].originalName).toBe(RAW_NAME)
		expect(capturedSpecs[0].prefixedName).toBe(meta.name)
	})

	it("executeDescribe: display name and injected name are the same string", () => {
		const meta = makeMetadata(RAW_NAME, SERVER, prefix)
		const state = makeState(meta, SERVER)
		let injectedNames: string[] = []

		const result = executeDescribe(state, meta.name, (specs) => {
			injectedNames = specs.map((s) => s.prefixedName)
			return injectedNames
		})

		const block = result.content[0]
		const text = block.type === "text" ? block.text : ""
		expect(injectedNames).toHaveLength(1)
		// Header shows metadata.name
		expect(text).toContain(meta.name)
		// Footer references the same name
		expect(text).toContain(injectedNames[0])
		expect(injectedNames[0]).toBe(meta.name)
	})
})
