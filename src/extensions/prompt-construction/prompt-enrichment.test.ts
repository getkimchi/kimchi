import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { arch, version as osVersion, platform, release, tmpdir } from "node:os"
import { join } from "node:path"
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as config from "../../config.js"
import type { ModelMetadata } from "../../models.js"
import { setResourceOverride } from "../../resources/store.js"
import * as startupContext from "../../startup-context.js"
import * as agentWorkerContext from "../agent-worker-context.js"
import { CLAUDE_CODE_SKILLS_RESOURCE_ID } from "../claude-code-skills/definition.js"
import type { OrchestratorMessages } from "../orchestration/continuation-nudge.js"
import promptEnrichmentExtension, {
	stripEmptyToolCalls,
	_resetDeprecatedNotificationTracking,
} from "./prompt-enrichment.js"
import { createToolVisibility } from "./tool-visibility.js"

function makeUser(text: string): OrchestratorMessages[number] {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }
}

function makeAssistant(content: AssistantMessage["content"] = [{ type: "text", text: "Done." }]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "kimchi-dev",
		model: "kimi-k2.6",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	}
}

function makeToolResult(toolCallId: string, text = "Tool  not found", isError = true): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "",
		content: [{ type: "text", text }],
		details: undefined,
		isError,
		timestamp: Date.now(),
	}
}

describe("stripEmptyToolCalls", () => {
	it("returns the same array reference when there are no empty tool calls", () => {
		const messages: OrchestratorMessages = [
			makeUser("hi"),
			makeAssistant([
				{ type: "text", text: "writing file" },
				{ type: "toolCall", id: "call_1", name: "write", arguments: { path: "a.ts", content: "x" } },
			]),
		]
		expect(stripEmptyToolCalls(messages)).toBe(messages)
	})

	it("returns the same array reference for an empty messages list", () => {
		const messages: OrchestratorMessages = []
		expect(stripEmptyToolCalls(messages)).toBe(messages)
	})

	it("strips an empty-name tool call from an assistant message", () => {
		const messages: OrchestratorMessages = [
			makeAssistant([
				{ type: "toolCall", id: "call_1", name: "write", arguments: { path: "a.ts", content: "x" } },
				{ type: "text", text: "Valid" },
				{ type: "toolCall", id: "", name: "", arguments: {} },
				{ type: "text", text: " " },
			]),
		]
		const result = stripEmptyToolCalls(messages)
		expect(result).not.toBe(messages)
		expect(result).toHaveLength(1)
		const content = (result[0] as AssistantMessage).content
		expect(content).toHaveLength(3)
		for (const block of content) {
			if (typeof block === "object" && block !== null && "type" in block && block.type === "toolCall") {
				expect((block as { name: string }).name).toBe("write")
			}
		}
	})

	it("removes the paired toolResult by toolCallId", () => {
		const messages: OrchestratorMessages = [
			makeAssistant([{ type: "toolCall", id: "empty-1", name: "", arguments: {} }]),
			makeToolResult("empty-1"),
			makeUser("next"),
		]
		const result = stripEmptyToolCalls(messages)
		expect(result).not.toBe(messages)
		expect(result).toHaveLength(1)
		expect(result[0]).toBe(messages[2])
	})

	it("keeps the assistant message when only some blocks are stripped", () => {
		const messages: OrchestratorMessages = [
			makeAssistant([
				{ type: "text", text: "keep me" },
				{ type: "toolCall", id: "", name: "", arguments: {} },
			]),
		]
		const result = stripEmptyToolCalls(messages)
		expect(result).toHaveLength(1)
		const content = (result[0] as AssistantMessage).content
		expect(content).toHaveLength(1)
		expect(content[0]).toEqual({ type: "text", text: "keep me" })
	})

	it("drops an assistant message that becomes empty after stripping", () => {
		const messages: OrchestratorMessages = [
			makeUser("q"),
			makeAssistant([{ type: "toolCall", id: "", name: "", arguments: {} }]),
			makeUser("q2"),
		]
		const result = stripEmptyToolCalls(messages)
		expect(result).toHaveLength(2)
		expect(result[0]).toBe(messages[0])
		expect(result[1]).toBe(messages[2])
	})

	it("treats whitespace-only names as empty", () => {
		const messages: OrchestratorMessages = [
			makeAssistant([{ type: "toolCall", id: "ws-1", name: "   ", arguments: {} }]),
		]
		const result = stripEmptyToolCalls(messages)
		expect(result).toHaveLength(0)
	})

	it("does not strip toolResults that pair with valid (non-empty) tool calls", () => {
		const messages: OrchestratorMessages = [
			makeAssistant([
				{ type: "toolCall", id: "good-1", name: "bash", arguments: { command: "ls" } },
				{ type: "toolCall", id: "empty-1", name: "", arguments: {} },
			]),
			makeToolResult("good-1", "output", false),
			makeToolResult("empty-1"),
		]
		const result = stripEmptyToolCalls(messages)
		expect(result).toHaveLength(2)
		const assistantContent = (result[0] as AssistantMessage).content
		expect(assistantContent).toHaveLength(1)
		expect((assistantContent[0] as { name: string }).name).toBe("bash")
		expect((result[1] as ToolResultMessage).toolCallId).toBe("good-1")
	})

	it("handles multiple empty tool calls across multiple assistant turns", () => {
		const messages: OrchestratorMessages = [
			makeAssistant([
				{ type: "text", text: "t1" },
				{ type: "toolCall", id: "e1", name: "", arguments: {} },
			]),
			makeToolResult("e1"),
			makeAssistant([
				{ type: "text", text: "t2" },
				{ type: "toolCall", id: "e2", name: "", arguments: {} },
			]),
			makeToolResult("e2"),
		]
		const result = stripEmptyToolCalls(messages)
		expect(result).toHaveLength(2)
		for (const msg of result) {
			expect((msg as AssistantMessage).role).toBe("assistant")
			expect((msg as AssistantMessage).content).toHaveLength(1)
		}
	})
})

describe("prompt enrichment tool visibility", () => {
	it("omits hidden tools from the rendered available tools section", async () => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>()
		const tools = [
			{ name: "read", description: "Read file contents" },
			{ name: "bash", description: "Execute shell commands" },
		] as ToolInfo[]
		let activeTools = tools.map((tool) => tool.name)
		const pi = {
			registerFlag: () => {},
			registerCommand: () => {},
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown) => {
				handlers.set(event, handler)
			},
			getAllTools: () => tools,
			getActiveTools: () => activeTools,
			setActiveTools: (toolNames: string[]) => {
				activeTools = toolNames
			},
			getFlag: () => false,
		} as unknown as ExtensionAPI

		promptEnrichmentExtension([])(pi)
		const visibility = createToolVisibility(pi)
		visibility.disable(["bash"])

		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		try {
			const result = (await beforeAgentStart(
				{},
				{
					cwd: "/tmp",
					model: undefined,
					hasUI: false,
				},
			)) as { systemPrompt: string }

			expect(result.systemPrompt).toContain('<tool name="read">')
			expect(result.systemPrompt).not.toContain('<tool name="bash">')
		} finally {
			visibility.enable(["bash"])
		}
	})

	it("omits inactive tools from the rendered available tools section", async () => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>()
		const tools = [
			{ name: "read", description: "Read file contents" },
			{ name: "bash", description: "Execute shell commands" },
		] as ToolInfo[]
		const pi = {
			registerFlag: () => {},
			registerCommand: () => {},
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown) => {
				handlers.set(event, handler)
			},
			getAllTools: () => tools,
			getActiveTools: () => ["read"],
			getFlag: () => false,
		} as unknown as ExtensionAPI

		promptEnrichmentExtension([])(pi)

		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const result = (await beforeAgentStart(
			{},
			{
				cwd: "/tmp",
				model: undefined,
				hasUI: false,
			},
		)) as { systemPrompt: string }

		expect(result.systemPrompt).toContain('<tool name="read">')
		expect(result.systemPrompt).not.toContain('<tool name="bash">')
	})
})

describe("prompt enrichment environment context", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
		vi.spyOn(config, "loadConfig").mockReturnValue({ apiKey: "" } as ReturnType<typeof config.loadConfig>)
		vi.spyOn(startupContext, "getAvailableModels").mockReturnValue([])
	})

	it("injects cheap platform and shell context into the system prompt", async () => {
		const oldShell = process.env.SHELL
		process.env.SHELL = "/bin/test-shell"
		try {
			const { beforeAgentStart } = buildPromptExtensionWithHandlers()
			if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

			const result = (await beforeAgentStart(
				{},
				{ cwd: "/tmp", model: undefined, hasUI: false, sessionManager: { getSessionId: () => "session-1" } },
			)) as { systemPrompt: string }

			expect(result.systemPrompt).toContain(`- OS release: ${release()}`)
			expect(result.systemPrompt).toContain(`- OS version: ${osVersion()}`)
			expect(result.systemPrompt).toContain(`- Raw platform: ${platform()}`)
			expect(result.systemPrompt).toContain(`- CPU architecture: ${arch()}`)
			expect(result.systemPrompt).toContain("- Shell: /bin/test-shell")
		} finally {
			if (oldShell === undefined) {
				// biome-ignore lint/performance/noDelete: process.env requires delete to truly unset.
				delete process.env.SHELL
			} else {
				process.env.SHELL = oldShell
			}
		}
	})
})

describe("prompt enrichment Claude Code skills", () => {
	let dir: string
	let oldAgentDir: string | undefined
	let oldHome: string | undefined
	let oldXdgCacheHome: string | undefined

	beforeEach(() => {
		vi.restoreAllMocks()
		dir = mkdtempSync(join(tmpdir(), "kimchi-prompt-claude-skills-"))
		oldAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
		oldHome = process.env.HOME
		oldXdgCacheHome = process.env.XDG_CACHE_HOME
		process.env.KIMCHI_CODING_AGENT_DIR = join(dir, "agent")
		process.env.HOME = join(dir, "home")
		process.env.XDG_CACHE_HOME = join(dir, "cache")
		vi.spyOn(config, "loadConfig").mockReturnValue({ apiKey: "" } as ReturnType<typeof config.loadConfig>)
		vi.spyOn(startupContext, "getAvailableModels").mockReturnValue([])
	})

	afterEach(() => {
		if (oldAgentDir === undefined) {
			// biome-ignore lint/performance/noDelete: process.env requires delete to truly unset.
			delete process.env.KIMCHI_CODING_AGENT_DIR
		} else {
			process.env.KIMCHI_CODING_AGENT_DIR = oldAgentDir
		}
		if (oldHome === undefined) {
			// biome-ignore lint/performance/noDelete: process.env requires delete to truly unset.
			delete process.env.HOME
		} else {
			process.env.HOME = oldHome
		}
		if (oldXdgCacheHome === undefined) {
			// biome-ignore lint/performance/noDelete: process.env requires delete to truly unset.
			delete process.env.XDG_CACHE_HOME
		} else {
			process.env.XDG_CACHE_HOME = oldXdgCacheHome
		}
		rmSync(dir, { recursive: true, force: true })
	})

	it("injects current-project Claude Code skills when the extension is enabled", async () => {
		const cwd = join(dir, "project")
		writeSkill(join(dir, "project", ".claude", "skills", "typescript-safety", "SKILL.md"), {
			description: "Use safe TypeScript patterns before editing TypeScript files.",
		})
		setResourceOverride(CLAUDE_CODE_SKILLS_RESOURCE_ID, true)
		const { beforeAgentStart } = buildPromptExtensionWithHandlers()
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const result = (await beforeAgentStart(
			{},
			{ cwd, model: undefined, hasUI: false, sessionManager: { getSessionId: () => "session-1" } },
		)) as { systemPrompt: string }

		expect(result.systemPrompt).toContain("<available_skills>")
		expect(result.systemPrompt).toContain("<name>typescript-safety</name>")
		expect(result.systemPrompt).toContain("Use safe TypeScript patterns")
	})

	it("contributes Kimchi project skills through resources_discover", async () => {
		const cwd = join(dir, "project", "src")
		const projectSkillPath = join(dir, "project", ".kimchi", "skills")
		writeSkill(join(projectSkillPath, "typescript-safety", "SKILL.md"), {
			description: "Use Kimchi project TypeScript patterns.",
		})
		const { resourcesDiscover } = buildPromptExtensionWithHandlers()
		if (!resourcesDiscover) throw new Error("resources_discover handler was not registered")

		const result = resourcesDiscover({ type: "resources_discover", cwd, reason: "startup" }, undefined)

		expect(result).toEqual({ skillPaths: [projectSkillPath] })
	})

	it("injects Kimchi project skills without configured paths", async () => {
		const cwd = join(dir, "project", "src")
		writeSkill(join(dir, "project", ".kimchi", "skills", "typescript-safety", "SKILL.md"), {
			description: "Use Kimchi project TypeScript patterns.",
		})
		const { beforeAgentStart } = buildPromptExtensionWithHandlers([])
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const result = (await beforeAgentStart(
			{},
			{ cwd, model: undefined, hasUI: false, sessionManager: { getSessionId: () => "session-1" } },
		)) as { systemPrompt: string }

		expect(result.systemPrompt).toContain("<available_skills>")
		expect(result.systemPrompt).toContain("<name>typescript-safety</name>")
		expect(result.systemPrompt).toContain("Use Kimchi project TypeScript patterns")
	})

	it("keeps configured skill paths in the prompt", async () => {
		const cwd = join(dir, "project")
		const configuredSkills = join(dir, "configured", "skills")
		writeSkill(join(configuredSkills, "typescript-safety", "SKILL.md"), {
			description: "Use configured TypeScript patterns.",
		})
		const { beforeAgentStart } = buildPromptExtensionWithHandlers([configuredSkills])
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const result = (await beforeAgentStart(
			{},
			{ cwd, model: undefined, hasUI: false, sessionManager: { getSessionId: () => "session-1" } },
		)) as { systemPrompt: string }

		expect(result.systemPrompt).toContain("<available_skills>")
		expect(result.systemPrompt).toContain("<name>typescript-safety</name>")
		expect(result.systemPrompt).toContain("Use configured TypeScript patterns")
	})

	it("keeps home-relative configured skill paths in the prompt", async () => {
		const cwd = join(dir, "project")
		const configuredSkills = ".config/kimchi/harness/skills"
		writeSkill(join(dir, "home", configuredSkills, "typescript-safety", "SKILL.md"), {
			description: "Use home configured TypeScript patterns.",
		})
		const { beforeAgentStart } = buildPromptExtensionWithHandlers([configuredSkills])
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const result = (await beforeAgentStart(
			{},
			{ cwd, model: undefined, hasUI: false, sessionManager: { getSessionId: () => "session-1" } },
		)) as { systemPrompt: string }

		expect(result.systemPrompt).toContain("<available_skills>")
		expect(result.systemPrompt).toContain("<name>typescript-safety</name>")
		expect(result.systemPrompt).toContain("Use home configured TypeScript patterns")
	})

	it("sanitizes configured Claude Code skill paths before injecting them", async () => {
		const cwd = join(dir, "project")
		writeRawSkill(join(cwd, ".claude", "skills", "typescript-safety", "SKILL.md"), "Use generated types.\n")
		const { beforeAgentStart } = buildPromptExtensionWithHandlers([".claude/skills"])
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const result = (await beforeAgentStart(
			{},
			{ cwd, model: undefined, hasUI: false, sessionManager: { getSessionId: () => "session-1" } },
		)) as { systemPrompt: string }

		expect(result.systemPrompt).toContain("<available_skills>")
		expect(result.systemPrompt).toContain("<name>typescript-safety</name>")
		expect(result.systemPrompt).toContain("<description>Claude Code skill: typescript-safety.</description>")
	})

	it("does not inject ancestor Claude Code skills without cwd .claude", async () => {
		const project = join(dir, "project")
		const cwd = join(project, "src")
		writeSkill(join(project, ".claude", "skills", "typescript-safety", "SKILL.md"), {
			description: "Use safe TypeScript patterns before editing TypeScript files.",
		})
		setResourceOverride(CLAUDE_CODE_SKILLS_RESOURCE_ID, true)
		const { beforeAgentStart } = buildPromptExtensionWithHandlers()
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const result = (await beforeAgentStart(
			{},
			{ cwd, model: undefined, hasUI: false, sessionManager: { getSessionId: () => "session-1" } },
		)) as { systemPrompt: string }

		expect(result.systemPrompt).not.toContain("<available_skills>")
		expect(result.systemPrompt).not.toContain("typescript-safety")
	})

	it("injects sanitized Claude Code skills when the extension is enabled", async () => {
		const cwd = join(dir, "project")
		writeSkill(join(cwd, ".claude", "skills", "typescript-safety", "SKILL.md"), {
			description: "Use: generated API types",
		})
		setResourceOverride(CLAUDE_CODE_SKILLS_RESOURCE_ID, true)
		const { beforeAgentStart } = buildPromptExtensionWithHandlers()
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const result = (await beforeAgentStart(
			{},
			{ cwd, model: undefined, hasUI: false, sessionManager: { getSessionId: () => "session-1" } },
		)) as { systemPrompt: string }

		expect(result.systemPrompt).toContain("<available_skills>")
		expect(result.systemPrompt).toContain("<name>typescript-safety</name>")
		expect(result.systemPrompt).toContain("Use: generated API types")
	})

	it("injects Claude Code skills without descriptions through the sanitized cache", async () => {
		const cwd = join(dir, "project")
		writeRawSkill(join(cwd, ".claude", "skills", "typescript-safety", "SKILL.md"), "Use generated types.\n")
		setResourceOverride(CLAUDE_CODE_SKILLS_RESOURCE_ID, true)
		const { beforeAgentStart } = buildPromptExtensionWithHandlers()
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const result = (await beforeAgentStart(
			{},
			{ cwd, model: undefined, hasUI: false, sessionManager: { getSessionId: () => "session-1" } },
		)) as { systemPrompt: string }

		expect(result.systemPrompt).toContain("<available_skills>")
		expect(result.systemPrompt).toContain("<name>typescript-safety</name>")
		expect(result.systemPrompt).toContain("<description>Claude Code skill: typescript-safety.</description>")
	})

	it("does not inject Claude Code skills when the extension is disabled", async () => {
		const cwd = join(dir, "project")
		writeSkill(join(cwd, ".claude", "skills", "typescript-safety", "SKILL.md"), {
			description: "Use safe TypeScript patterns before editing TypeScript files.",
		})
		const { beforeAgentStart } = buildPromptExtensionWithHandlers()
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const result = (await beforeAgentStart(
			{},
			{ cwd, model: undefined, hasUI: false, sessionManager: { getSessionId: () => "session-1" } },
		)) as { systemPrompt: string }

		expect(result.systemPrompt).not.toContain("<name>typescript-safety</name>")
	})
})

describe("append system prompt", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
		vi.spyOn(config, "loadConfig").mockReturnValue({ apiKey: "" } as ReturnType<typeof config.loadConfig>)
		vi.spyOn(startupContext, "getAvailableModels").mockReturnValue([])
	})

	it("appends systemPromptOptions.appendSystemPrompt to the built system prompt", async () => {
		const { beforeAgentStart } = buildPromptExtensionWithHandlers()
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const result = (await beforeAgentStart(
			{ systemPromptOptions: { appendSystemPrompt: "Custom appended instructions" } },
			{
				cwd: "/tmp",
				model: undefined,
				hasUI: false,
				sessionManager: { getSessionId: () => "session-1" },
			},
		)) as { systemPrompt: string }

		expect(result.systemPrompt).toContain("Custom appended instructions")
		// It should be at the end of the prompt
		expect(result.systemPrompt.endsWith("Custom appended instructions")).toBe(true)
	})

	it("does not append when appendSystemPrompt is undefined", async () => {
		const { beforeAgentStart } = buildPromptExtensionWithHandlers()
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const resultWithout = (await beforeAgentStart(
			{ systemPromptOptions: {} },
			{
				cwd: "/tmp",
				model: undefined,
				hasUI: false,
				sessionManager: { getSessionId: () => "session-1" },
			},
		)) as { systemPrompt: string }

		const resultWithEmpty = (await beforeAgentStart(
			{ systemPromptOptions: { appendSystemPrompt: undefined } },
			{
				cwd: "/tmp",
				model: undefined,
				hasUI: false,
				sessionManager: { getSessionId: () => "session-2" },
			},
		)) as { systemPrompt: string }

		// Both should produce the same prompt (no trailing append)
		expect(resultWithout.systemPrompt).toBe(resultWithEmpty.systemPrompt)
	})

	it("does not append when appendSystemPrompt is whitespace-only", async () => {
		const { beforeAgentStart } = buildPromptExtensionWithHandlers()
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const resultBaseline = (await beforeAgentStart(
			{ systemPromptOptions: {} },
			{
				cwd: "/tmp",
				model: undefined,
				hasUI: false,
				sessionManager: { getSessionId: () => "session-1" },
			},
		)) as { systemPrompt: string }

		const resultWhitespace = (await beforeAgentStart(
			{ systemPromptOptions: { appendSystemPrompt: "   \n  " } },
			{
				cwd: "/tmp",
				model: undefined,
				hasUI: false,
				sessionManager: { getSessionId: () => "session-2" },
			},
		)) as { systemPrompt: string }

		// Whitespace-only should be skipped — prompt unchanged
		expect(resultBaseline.systemPrompt).toBe(resultWhitespace.systemPrompt)
	})
})

describe("model role startup warnings", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	function modelMetadata(slug: string): ModelMetadata {
		return {
			slug,
			display_name: slug,
			provider: "kimchi-dev",
			reasoning: false,
			input_modalities: ["text"],
			is_serverless: true,
			limits: { context_window: 128000, max_output_tokens: 8192 },
		}
	}

	it("does not print unavailable role warnings when no models are available yet", () => {
		vi.spyOn(startupContext, "getAvailableModels").mockReturnValue([])
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const pi = {
			registerFlag: () => {},
			registerCommand: () => {},
			on: () => {},
			getAllTools: () => [],
			getActiveTools: () => [],
			getFlag: () => false,
		} as unknown as ExtensionAPI

		promptEnrichmentExtension([])(pi)

		expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("[model-roles] Warning:"))
	})

	it("does not print unavailable role warnings from cached metadata before auth is configured", () => {
		vi.spyOn(config, "loadConfig").mockReturnValue({ apiKey: "" } as ReturnType<typeof config.loadConfig>)
		vi.spyOn(startupContext, "getAvailableModels").mockReturnValue([modelMetadata("cached-model")])
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const pi = {
			registerFlag: () => {},
			registerCommand: () => {},
			on: () => {},
			getAllTools: () => [],
			getActiveTools: () => [],
			getFlag: () => false,
		} as unknown as ExtensionAPI

		promptEnrichmentExtension([])(pi)

		expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("[model-roles] Warning:"))
	})

	it("keeps unavailable role warnings when Kimchi auth is already configured", () => {
		vi.spyOn(config, "loadConfig").mockReturnValue({ apiKey: "test-key" } as ReturnType<typeof config.loadConfig>)
		vi.spyOn(startupContext, "getAvailableModels").mockReturnValue([modelMetadata("different-model")])
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const pi = {
			registerFlag: () => {},
			registerCommand: () => {},
			on: () => {},
			getAllTools: () => [],
			getActiveTools: () => [],
			getFlag: () => false,
		} as unknown as ExtensionAPI

		promptEnrichmentExtension([])(pi)

		expect(warn).toHaveBeenCalledWith(expect.stringContaining("[model-roles] Warning: orchestrator"))
	})
})

function buildPromptExtensionWithHandlers(skillPaths: string[] = []) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>()
	const pi = {
		registerFlag: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown) => {
			handlers.set(event, handler)
		},
		getAllTools: () => [],
		getActiveTools: () => [],
		getFlag: () => false,
	} as unknown as ExtensionAPI
	promptEnrichmentExtension(skillPaths)(pi)
	return {
		handlers,
		resourcesDiscover: handlers.get("resources_discover"),
		beforeAgentStart: handlers.get("before_agent_start"),
	}
}

function writeSkill(path: string, frontmatter: { description: string }): void {
	mkdirSync(join(path, ".."), { recursive: true })
	writeFileSync(path, `---\ndescription: ${frontmatter.description}\n---\n# Skill\n`, "utf-8")
}

function writeRawSkill(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true })
	writeFileSync(path, content, "utf-8")
}

describe("deprecated model notification", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
		_resetDeprecatedNotificationTracking()
	})

	const deprecatedModelId = "kimi-k2.6-old"
	const replacementModelId = "kimi-k2.7"

	function makeMockContext(modelId: string | undefined, sessionId = "test-session-1") {
		return {
			cwd: "/tmp",
			model: modelId ? { id: modelId, provider: "kimchi-dev" } : undefined,
			hasUI: true,
			sessionManager: {
				getSessionId: () => sessionId,
			},
			ui: {
				notify: vi.fn(),
			},
		}
	}

	function setupAvailableModels(models: readonly ModelMetadata[]) {
		vi.spyOn(startupContext, "getAvailableModels").mockReturnValue(models)
	}

	function buildExtensionWithHandlers() {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>()
		const pi = {
			registerFlag: () => {},
			registerCommand: () => {},
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown) => {
				handlers.set(event, handler)
			},
			getAllTools: () => [],
			getActiveTools: () => [],
			getFlag: () => false,
		} as unknown as ExtensionAPI
		promptEnrichmentExtension([])(pi)
		return {
			handlers,
			sessionStart: handlers.get("session_start"),
			sessionShutdown: handlers.get("session_shutdown"),
			modelSelect: handlers.get("model_select"),
		}
	}

	it("notifies when session starts with a deprecated model that has a replacement", async () => {
		const modelProps: Omit<ModelMetadata, "slug" | "display_name" | "status" | "replacement"> = {
			provider: "kimchi-dev",
			reasoning: false,
			input_modalities: ["text"],
			is_serverless: true,
			limits: { context_window: 128000, max_output_tokens: 8192 },
		}
		const models: ModelMetadata[] = [
			{
				slug: deprecatedModelId,
				display_name: "Kimi K2.6 Old",
				status: "deprecated",
				replacement: replacementModelId,
				...modelProps,
			},
			{ slug: "active-model", display_name: "Active Model", status: "active", ...modelProps },
			{ slug: replacementModelId, display_name: "Kimi K2.7", status: "active", ...modelProps },
		]
		setupAvailableModels(models)

		const { sessionStart } = buildExtensionWithHandlers()
		if (!sessionStart) throw new Error("session_start handler not registered")

		const ctx = makeMockContext(deprecatedModelId)
		await sessionStart({}, ctx)

		const notifyMock = (ctx as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify
		expect(notifyMock.mock.calls.length).toBe(1)
		expect(notifyMock).toHaveBeenCalledWith(
			`Model "${deprecatedModelId}" is deprecated. Switch to "${replacementModelId}" for better performance.`,
			"warning",
		)
	})

	it("notifies with fallback message when deprecated model has no replacement", async () => {
		const modelProps: Omit<ModelMetadata, "slug" | "display_name" | "status" | "replacement"> = {
			provider: "kimchi-dev",
			reasoning: false,
			input_modalities: ["text"],
			is_serverless: true,
			limits: { context_window: 128000, max_output_tokens: 8192 },
		}
		const models: ModelMetadata[] = [
			{ slug: deprecatedModelId, display_name: "Kimi K2.6 Old", status: "deprecated", ...modelProps },
			{ slug: "active-model", display_name: "Active Model", status: "active", ...modelProps },
		]
		setupAvailableModels(models)

		const { sessionStart } = buildExtensionWithHandlers()
		if (!sessionStart) throw new Error("session_start handler not registered")

		const ctx = makeMockContext(deprecatedModelId)
		await sessionStart({}, ctx)

		const notifyMock = (ctx as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify
		expect(notifyMock.mock.calls.length).toBe(1)
		expect(notifyMock).toHaveBeenCalledWith(
			`Model "${deprecatedModelId}" is deprecated. It may be removed in a future update.`,
			"warning",
		)
	})

	it("does not notify when session starts with an active model", async () => {
		const modelProps: Omit<ModelMetadata, "slug" | "display_name" | "status" | "replacement"> = {
			provider: "kimchi-dev",
			reasoning: false,
			input_modalities: ["text"],
			is_serverless: true,
			limits: { context_window: 128000, max_output_tokens: 8192 },
		}
		const models: ModelMetadata[] = [
			{ slug: "active-model", display_name: "Active Model", status: "active", ...modelProps },
		]
		setupAvailableModels(models)

		const { sessionStart } = buildExtensionWithHandlers()
		if (!sessionStart) throw new Error("session_start handler not registered")

		const ctx = makeMockContext("active-model")
		await sessionStart({}, ctx)

		const notifyMock = (ctx as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify
		expect(notifyMock.mock.calls.length).toBe(0)
	})

	it("only fires notification once per session", async () => {
		const modelProps: Omit<ModelMetadata, "slug" | "display_name" | "status" | "replacement"> = {
			provider: "kimchi-dev",
			reasoning: false,
			input_modalities: ["text"],
			is_serverless: true,
			limits: { context_window: 128000, max_output_tokens: 8192 },
		}
		const models: ModelMetadata[] = [
			{
				slug: deprecatedModelId,
				display_name: "Kimi K2.6 Old",
				status: "deprecated",
				replacement: replacementModelId,
				...modelProps,
			},
			{ slug: "active-model", display_name: "Active Model", status: "active", ...modelProps },
		]
		setupAvailableModels(models)

		const { sessionStart } = buildExtensionWithHandlers()
		if (!sessionStart) throw new Error("session_start handler not registered")

		// First session
		const ctx1 = makeMockContext(deprecatedModelId, "session-1")
		await sessionStart({}, ctx1)

		// Second session_start for same session should not fire again
		await sessionStart({}, ctx1)

		const notifyMock = (ctx1 as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify
		expect(notifyMock.mock.calls.length).toBe(1)
	})

	it("cleans up notification tracking on session_shutdown", async () => {
		const modelProps: Omit<ModelMetadata, "slug" | "display_name" | "status" | "replacement"> = {
			provider: "kimchi-dev",
			reasoning: false,
			input_modalities: ["text"],
			is_serverless: true,
			limits: { context_window: 128000, max_output_tokens: 8192 },
		}
		const models: ModelMetadata[] = [
			{
				slug: deprecatedModelId,
				display_name: "Kimi K2.6 Old",
				status: "deprecated",
				replacement: replacementModelId,
				...modelProps,
			},
			{ slug: "active-model", display_name: "Active Model", status: "active", ...modelProps },
		]
		setupAvailableModels(models)

		const { sessionStart, sessionShutdown } = buildExtensionWithHandlers()
		if (!sessionStart) throw new Error("session_start handler not registered")
		if (!sessionShutdown) throw new Error("session_shutdown handler not registered")

		const ctx = makeMockContext(deprecatedModelId, "session-1")

		// Fire session_start
		await sessionStart({}, ctx)
		// Fire session_shutdown (cleans up the tracking for this session)
		await sessionShutdown({}, ctx)
		// Fire session_start again with same session ID — should notify again
		await sessionStart({}, ctx)

		const notifyMock = (ctx as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify
		// Should have fired twice — once at each session_start
		expect(notifyMock.mock.calls.length).toBe(2)
	})

	it("shows fallback message when replacement model is not available", async () => {
		const modelProps: Omit<ModelMetadata, "slug" | "display_name" | "status" | "replacement"> = {
			provider: "kimchi-dev",
			reasoning: false,
			input_modalities: ["text"],
			is_serverless: true,
			limits: { context_window: 128000, max_output_tokens: 8192 },
		}
		const models: ModelMetadata[] = [
			{
				slug: deprecatedModelId,
				display_name: "Kimi K2.6 Old",
				status: "deprecated",
				replacement: "nonexistent-model",
				...modelProps,
			},
			{ slug: "active-model", display_name: "Active Model", status: "active", ...modelProps },
		]
		setupAvailableModels(models)

		const { sessionStart } = buildExtensionWithHandlers()
		if (!sessionStart) throw new Error("session_start handler not registered")

		const ctx = makeMockContext(deprecatedModelId)
		await sessionStart({}, ctx)

		const notifyMock = (ctx as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify
		expect(notifyMock.mock.calls.length).toBe(1)
		expect(notifyMock).toHaveBeenCalledWith(
			`Model "${deprecatedModelId}" is deprecated. It may be removed in a future update.`,
			"warning",
		)
	})
})

describe("continuation nudge turn_end handler", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	function buildNudgeHandlers() {
		const handlerMap = new Map<string, Array<(event: unknown, ctx?: unknown) => Promise<unknown> | unknown>>()
		const sendMessageCalls: Array<{ message: unknown; options: unknown }> = []

		vi.spyOn(agentWorkerContext, "isAgentWorker").mockReturnValue(false)
		vi.spyOn(startupContext, "getAvailableModels").mockReturnValue([])
		vi.spyOn(config, "loadConfig").mockReturnValue({
			apiKey: "",
			agentConfigDir: "",
			llmEndpoint: "",
			customLlmEndpoint: undefined,
			maxToolResultChars: 0,
			mcpSearchLimit: 5,
			mcpSearch: {
				strategy: "bm25" as const,
				bm25K1: 1.2,
				bm25B: 0.75,
				fieldWeights: { name: 6, description: 2, schemaKey: 1 },
			},
			retry: { maxRetries: 10 },
			onboarding: {},
			deviceId: "test",
		})

		const pi = {
			registerFlag: () => {},
			registerCommand: () => {},
			on: (event: string, handler: (event: unknown, ctx?: unknown) => Promise<unknown> | unknown) => {
				const list = handlerMap.get(event) ?? []
				list.push(handler)
				handlerMap.set(event, list)
			},
			getAllTools: () => [],
			getActiveTools: () => [],
			getFlag: () => false,
			sendMessage: (message: unknown, options: unknown) => {
				sendMessageCalls.push({ message, options })
			},
			events: { on: () => {}, emit: () => {} },
		} as unknown as ExtensionAPI

		promptEnrichmentExtension([])(pi)

		const fire = async (event: string, payload: unknown) => {
			const handlers = handlerMap.get(event) ?? []
			for (const h of handlers) await h(payload)
		}

		return { fire, sendMessageCalls }
	}

	function makeAssistantWithStop(
		content: AssistantMessage["content"],
		stopReason: AssistantMessage["stopReason"] = "stop",
	): AssistantMessage {
		return { ...makeAssistant(content), stopReason }
	}

	it("sends a continuation nudge on a text-only turn with no tools called", async () => {
		const { fire, sendMessageCalls } = buildNudgeHandlers()

		// Simulate user input to reset the nudge state.
		await fire("input", { source: "user" })

		// Model responds with text-only, stopReason "stop".
		await fire("turn_end", {
			message: makeAssistantWithStop([{ type: "text", text: "I will delegate this." }]),
		})

		// A continuation nudge should have been sent.
		expect(sendMessageCalls.length).toBe(1)
		expect((sendMessageCalls[0].message as { customType?: string }).customType).toBe("nudge")
	})

	it("does not send a second nudge when model responds to nudge with stopReason 'stop'", async () => {
		const { fire, sendMessageCalls } = buildNudgeHandlers()

		// Simulate user input.
		await fire("input", { source: "user" })

		// First text-only turn triggers the continuation nudge.
		await fire("turn_end", {
			message: makeAssistantWithStop([{ type: "text", text: "I will delegate this." }]),
		})
		expect(sendMessageCalls.length).toBe(1)

		// Model responds to the nudge with text and stopReason "stop".
		// The handler should NOT send a second nudge.
		await fire("turn_end", {
			message: makeAssistantWithStop([{ type: "text", text: "OK, I am done." }]),
		})
		expect(sendMessageCalls.length).toBe(1) // no new nudge
	})

	it("falls through to second nudge when model responds with non-stop stopReason", async () => {
		const { fire, sendMessageCalls } = buildNudgeHandlers()

		await fire("input", { source: "user" })

		// First text-only turn triggers the continuation nudge.
		await fire("turn_end", {
			message: makeAssistantWithStop([{ type: "text", text: "I will delegate this." }]),
		})
		expect(sendMessageCalls.length).toBe(1)

		// Model responds with stopReason "length" (e.g. output truncated).
		// The handler should allow a second nudge since the model did not
		// intentionally stop.
		await fire("turn_end", {
			message: makeAssistantWithStop([{ type: "text", text: "I was going to say..." }], "length"),
		})
		expect(sendMessageCalls.length).toBe(2)
	})

	it("does not send an empty-turn nudge after tools were called this agent run", async () => {
		const { fire, sendMessageCalls } = buildNudgeHandlers()

		// Start a fresh agent run.
		await fire("agent_start", {})

		// Simulate user input.
		await fire("input", { source: "user" })

		// Model calls a tool — marks the run as having used tools.
		await fire("tool_execution_start", {})

		// Model then produces an empty response (thinking-only or truly empty).
		await fire("turn_end", {
			message: makeAssistantWithStop([{ type: "thinking", thinking: "I am done." }]),
		})

		// No nudge should fire — tools were called this run, so the empty
		// response is the model finishing, not a glitch.
		expect(sendMessageCalls.length).toBe(0)
	})

	it("sends an empty-turn nudge when no tools have been called this run", async () => {
		const { fire, sendMessageCalls } = buildNudgeHandlers()

		// Start a fresh agent run.
		await fire("agent_start", {})

		// Simulate user input.
		await fire("input", { source: "user" })

		// Model returns an empty response with no prior tool calls.
		await fire("turn_end", {
			message: makeAssistantWithStop([]),
		})

		// Empty-turn nudge should fire — no tools have been called, the model
		// might be stuck.
		expect(sendMessageCalls.length).toBe(1)
		expect((sendMessageCalls[0].message as { content?: string }).content).toContain("If you have finished")
	})
})
