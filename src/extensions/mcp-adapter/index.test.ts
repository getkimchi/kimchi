import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type EnvironmentInfo, buildSystemPrompt } from "../prompt-construction/system-prompt.js"
import { executeDescribe, executeSearch } from "./proxy-modes.js"
import type { McpExtensionState } from "./state.js"
import type { DirectToolSpec, ToolMetadata } from "./types.js"
import mcpAdapter from "./index.js"

const testEnv: EnvironmentInfo = {
	os: "Linux",
	username: "testuser",
	homeDir: "/home/testuser",
	cwd: "/home/testuser/project",
	documentsDir: "/home/testuser/project/.kimchi/docs",
	localDate: "2026-01-01",
	isGitRepo: false,
}

type Handler = (event: unknown, ctx: unknown) => unknown

function makePi(): ExtensionAPI & { fireShutdown: () => Promise<void> } {
	const handlers = new Map<string, Handler[]>()
	const tools: ToolInfo[] = []
	let activeTools: string[] = []
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

afterEach(() => {
	vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------
// Helpers for inject-path tests
// ---------------------------------------------------------------------------

function makeMetadata(
	rawName: string,
	serverName: string,
	prefix: "server" | "none" | "short",
): ToolMetadata {
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

describe("mcp adapter system prompt block", () => {
	it("registers tool and MCP discovery instructions with the extension that owns mcp", async () => {
		vi.stubEnv("MCP_DIRECT_TOOLS", "__none__")
		const pi = makePi()
		mcpAdapter(pi)

		try {
			const result = buildSystemPrompt({
				pi,
				tools: pi.getAllTools(),
				env: testEnv,
				mode: "orchestrator",
			})

			expect(result).toContain("## Tool and MCP Discovery")
			expect(result).toContain('use mcp({ search: "query" })')
			expect(result.indexOf("## Tool and MCP Discovery")).toBeLessThan(result.indexOf("## Available Tools"))
			expect(result).toContain('<tool name="mcp">')
		} finally {
			await pi.fireShutdown()
		}
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

		executeSearch(
			state,
			"chat",
			undefined,
			undefined,
			undefined,
			undefined,
			5,
			undefined,
			(specs) => {
				capturedSpecs.push(...specs)
				return specs.map((s) => s.prefixedName)
			},
		)

		expect(capturedSpecs).toHaveLength(1)
		expect(capturedSpecs[0].originalName).toBe(RAW_NAME)
		expect(capturedSpecs[0].prefixedName).toBe(meta.name)
	})

	it("executeSearch: display name and injected name are the same string", () => {
		const meta = makeMetadata(RAW_NAME, SERVER, prefix)
		const state = makeState(meta, SERVER)
		let injectedNames: string[] = []

		const result = executeSearch(
			state,
			"chat",
			undefined,
			undefined,
			undefined,
			undefined,
			5,
			undefined,
			(specs) => {
				injectedNames = specs.map((s) => s.prefixedName)
				return injectedNames
			},
		)

		const block = result.content[0]
		const text = block.type === "text" ? block.text : ""
		expect(injectedNames).toHaveLength(1)
		// The displayed name (metadata.name) appears in the output body
		expect(text).toContain(meta.name)
		// The injected name footer references the exact same name
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
