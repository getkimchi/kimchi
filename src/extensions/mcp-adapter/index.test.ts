import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type EnvironmentInfo, buildSystemPrompt } from "../prompt-construction/system-prompt.js"
import mcpAdapter from "./index.js"

const testEnv: EnvironmentInfo = {
	os: "Linux",
	username: "testuser",
	homeDir: "/home/testuser",
	cwd: "/home/testuser/project",
	documentsDir: "/home/testuser/project/.kimchi/docs",
	currentTime: "2026-01-01T00:00:00.000Z",
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
