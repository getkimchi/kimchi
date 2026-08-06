import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { arch, version as osVersion, platform, release, tmpdir } from "node:os"
import { join } from "node:path"
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest"
import * as config from "../../config.js"
import type { ModelMetadata } from "../../models.js"
import { setResourceOverride } from "../../resources/store.js"
import * as startupContext from "../../startup-context.js"
import { createKimchiConfig } from "../__mocks__/config.js"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import * as agentWorkerContext from "../agent-worker-context.js"
import { CLAUDE_CODE_SKILLS_RESOURCE_ID } from "../claude-code-skills/definition.js"
import { setMultiModelEnabled } from "../multi-model.js"
import type { OrchestratorMessages } from "../orchestration/continuation-nudge.js"
import promptEnrichmentExtension, {
	_resetDeprecatedNotificationTracking,
	environmentSnapshotFinalizerExtension,
	stripEmptyToolCalls,
} from "./prompt-enrichment.js"
import { createToolVisibility } from "./tool-visibility.js"

// Mock the environment snapshot service so tests don't hit the real filesystem.
// vi.hoisted ensures the mock fns exist when the hoisted vi.mock factory runs.
const { mockGet, mockPrime, mockRestore, mockClearContext } = vi.hoisted(() => ({
	mockGet: vi.fn(),
	mockPrime: vi.fn(),
	mockRestore: vi.fn(),
	mockClearContext: vi.fn(),
}))
vi.mock("./environment-snapshot.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./environment-snapshot.js")>()
	const { environmentSnapshotModuleMock } = await import("../__mocks__/environment-snapshot.js")
	return environmentSnapshotModuleMock(
		{ get: mockGet, prime: mockPrime, restore: mockRestore, clearContext: mockClearContext },
		actual,
	)
})

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

// Reset all environment-snapshot mocks between tests so state doesn't leak.
beforeEach(() => {
	mockGet.mockReset()
	mockPrime.mockReset()
	mockRestore.mockReset()
	mockClearContext.mockReset()
	// By default the snapshot is absent (opt-out / collection returned undefined).
	mockGet.mockResolvedValue(undefined)
})

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
			appendEntry: vi.fn(),
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
			const result = (await beforeAgentStart({}, createContext({ hasUI: false }))) as { systemPrompt: string }

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
			appendEntry: vi.fn(),
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

		const result = (await beforeAgentStart({}, createContext({ hasUI: false }))) as { systemPrompt: string }

		expect(result.systemPrompt).toContain('<tool name="read">')
		expect(result.systemPrompt).not.toContain('<tool name="bash">')
	})
})

describe("prompt enrichment environment context", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
		vi.spyOn(config, "loadConfig").mockReturnValue(createKimchiConfig())
		vi.spyOn(startupContext, "getAvailableModels").mockReturnValue([])
	})

	it("injects cheap platform and shell context into the system prompt", async () => {
		const oldShell = process.env.SHELL
		process.env.SHELL = "/bin/test-shell"
		try {
			const { beforeAgentStart } = buildPromptExtensionWithHandlers()
			if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

			const result = (await beforeAgentStart({}, createContext({ hasUI: false }))) as { systemPrompt: string }

			expect(result.systemPrompt).toContain(`- OS release: ${release()}`)
			expect(result.systemPrompt).toContain(`- OS version: ${osVersion()}`)
			expect(result.systemPrompt).toContain(`- Raw platform: ${platform()}`)
			expect(result.systemPrompt).toContain(`- CPU architecture: ${arch()}`)
			expect(result.systemPrompt).toContain("- Shell: /bin/test-shell")
		} finally {
			if (oldShell === undefined) {
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
		vi.spyOn(config, "loadConfig").mockReturnValue(createKimchiConfig())
		vi.spyOn(startupContext, "getAvailableModels").mockReturnValue([])
	})

	afterEach(() => {
		if (oldAgentDir === undefined) {
			delete process.env.KIMCHI_CODING_AGENT_DIR
		} else {
			process.env.KIMCHI_CODING_AGENT_DIR = oldAgentDir
		}
		if (oldHome === undefined) {
			delete process.env.HOME
		} else {
			process.env.HOME = oldHome
		}
		if (oldXdgCacheHome === undefined) {
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

		const result = (await beforeAgentStart({}, createContext({ cwd, hasUI: false }))) as { systemPrompt: string }

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

		const result = (await beforeAgentStart({}, createContext({ cwd, hasUI: false }))) as { systemPrompt: string }

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

		const result = (await beforeAgentStart({}, createContext({ cwd, hasUI: false }))) as { systemPrompt: string }

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

		const result = (await beforeAgentStart({}, createContext({ cwd, hasUI: false }))) as { systemPrompt: string }

		expect(result.systemPrompt).toContain("<available_skills>")
		expect(result.systemPrompt).toContain("<name>typescript-safety</name>")
		expect(result.systemPrompt).toContain("Use home configured TypeScript patterns")
	})

	it("sanitizes configured Claude Code skill paths before injecting them", async () => {
		const cwd = join(dir, "project")
		writeRawSkill(join(cwd, ".claude", "skills", "typescript-safety", "SKILL.md"), "Use generated types.\n")
		const { beforeAgentStart } = buildPromptExtensionWithHandlers([".claude/skills"])
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const result = (await beforeAgentStart({}, createContext({ cwd, hasUI: false }))) as { systemPrompt: string }

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

		const result = (await beforeAgentStart({}, createContext({ cwd, hasUI: false }))) as { systemPrompt: string }

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

		const result = (await beforeAgentStart({}, createContext({ cwd, hasUI: false }))) as { systemPrompt: string }

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

		const result = (await beforeAgentStart({}, createContext({ cwd, hasUI: false }))) as { systemPrompt: string }

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

		const result = (await beforeAgentStart({}, createContext({ cwd, hasUI: false }))) as { systemPrompt: string }

		expect(result.systemPrompt).not.toContain("<name>typescript-safety</name>")
	})
})

describe("append system prompt", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
		vi.spyOn(config, "loadConfig").mockReturnValue(createKimchiConfig())
		vi.spyOn(startupContext, "getAvailableModels").mockReturnValue([])
	})

	it("appends systemPromptOptions.appendSystemPrompt to the built system prompt", async () => {
		const { beforeAgentStart } = buildPromptExtensionWithHandlers()
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const result = (await beforeAgentStart(
			{ systemPromptOptions: { appendSystemPrompt: "Custom appended instructions" } },
			createContext({ hasUI: false }),
		)) as { systemPrompt: string }

		expect(result.systemPrompt).toContain("Custom appended instructions")
		// The append-system-prompt content appears before the environment
		// snapshot block (which is the final section).
		const snapshotIdx = result.systemPrompt.indexOf("kimchi:environment-snapshot")
		if (snapshotIdx !== -1) {
			expect(result.systemPrompt.indexOf("Custom appended instructions")).toBeLessThan(snapshotIdx)
		}
	})

	it("does not append when appendSystemPrompt is undefined", async () => {
		const { beforeAgentStart } = buildPromptExtensionWithHandlers()
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const resultWithout = (await beforeAgentStart(
			{ systemPromptOptions: {} },
			createContext({ hasUI: false, sessionManager: { getSessionId: () => "session-1" } }),
		)) as { systemPrompt: string }

		const resultWithEmpty = (await beforeAgentStart(
			{ systemPromptOptions: { appendSystemPrompt: undefined } },
			createContext({ hasUI: false, sessionManager: { getSessionId: () => "session-2" } }),
		)) as { systemPrompt: string }

		// Both should produce the same prompt (no trailing append)
		expect(resultWithout.systemPrompt).toBe(resultWithEmpty.systemPrompt)
	})

	it("does not append when appendSystemPrompt is whitespace-only", async () => {
		const { beforeAgentStart } = buildPromptExtensionWithHandlers()
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const resultBaseline = (await beforeAgentStart(
			{ systemPromptOptions: {} },
			createContext({ hasUI: false, sessionManager: { getSessionId: () => "session-1" } }),
		)) as { systemPrompt: string }

		const resultWhitespace = (await beforeAgentStart(
			{ systemPromptOptions: { appendSystemPrompt: "   \n  " } },
			createContext({ hasUI: false, sessionManager: { getSessionId: () => "session-2" } }),
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
		vi.spyOn(config, "loadConfig").mockReturnValue(createKimchiConfig())
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
		vi.spyOn(config, "loadConfig").mockReturnValue(createKimchiConfig({ apiKey: "test-key" }))
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
		appendEntry: vi.fn(),
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
		pi,
		handlers,
		resourcesDiscover: handlers.get("resources_discover"),
		beforeAgentStart: handlers.get("before_agent_start"),
		sessionStart: handlers.get("session_start"),
		sessionShutdown: handlers.get("session_shutdown"),
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

	function setupAvailableModels(models: readonly ModelMetadata[]) {
		vi.spyOn(startupContext, "getAvailableModels").mockReturnValue(models)
	}

	function buildExtensionWithHandlers() {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>()
		const pi = {
			appendEntry: () => {},
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

		const ctx = createContext({ model: { provider: "kimchi-dev", id: deprecatedModelId } })
		await sessionStart({}, ctx)

		const notifyMock = ctx.ui.notify as Mock
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

		const ctx = createContext({ model: { provider: "kimchi-dev", id: deprecatedModelId } })
		await sessionStart({}, ctx)

		const notifyMock = ctx.ui.notify as Mock
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

		const ctx = createContext({ model: { provider: "kimchi-dev", id: "active-model" } })
		await sessionStart({}, ctx)

		const notifyMock = ctx.ui.notify as Mock
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

		const ctx = createContext({ model: { provider: "kimchi-dev", id: deprecatedModelId } })
		await sessionStart({}, ctx)

		// Second session_start for same session should not fire again
		await sessionStart({}, ctx)

		const notifyMock = ctx.ui.notify as Mock
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

		const ctx = createContext({ model: { provider: "kimchi-dev", id: deprecatedModelId } })

		// Fire session_start
		await sessionStart({}, ctx)
		// Fire session_shutdown (cleans up the tracking for this session)
		await sessionShutdown({}, ctx)
		// Fire session_start again with same session ID — should notify again
		await sessionStart({}, ctx)

		const notifyMock = ctx.ui.notify as Mock
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

		const ctx = createContext({ model: { provider: "kimchi-dev", id: deprecatedModelId } })
		await sessionStart({}, ctx)

		const notifyMock = ctx.ui.notify as Mock
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
			const ctx = createContext({ model: { provider: "test", id: "test-model" } })
			for (const h of handlers) await h(payload, ctx)
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

		// Simulate a tool having been called earlier in the session so the
		// fresh-session suppression does not apply. Then a new user-input cycle.
		await fire("tool_execution_start", {})
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

		// Tool called earlier in the session so the fresh-session guard is past.
		await fire("tool_execution_start", {})
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

		await fire("tool_execution_start", {})
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

describe("prompt enrichment environment snapshot", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
		vi.spyOn(config, "loadConfig").mockReturnValue(createKimchiConfig())
		vi.spyOn(startupContext, "getAvailableModels").mockReturnValue([])
		mockGet.mockReset()
		mockPrime.mockReset()
		mockRestore.mockReset()
		mockClearContext.mockReset()
		mockGet.mockResolvedValue(undefined)
	})

	const SNAPSHOT_BLOCK =
		"<!-- kimchi:environment-snapshot:start -->\n## Startup Environment Snapshot\nTest snapshot\n<!-- kimchi:environment-snapshot:end -->"

	it("keeps a Ferment planner supplement before the final snapshot", async () => {
		mockGet.mockResolvedValue(SNAPSHOT_BLOCK)
		const pi = createExtensionApi({
			appendEntry: vi.fn(),
			getFlag: () => false,
		})
		environmentSnapshotFinalizerExtension(pi.api)

		const promptAfterLateExtension = `${SNAPSHOT_BLOCK}\n\n## Ferment Planner Context`
		const result = await pi.getHandler<{ systemPrompt: string }, { systemPrompt: string }>("before_agent_start")(
			{ systemPrompt: promptAfterLateExtension },
			createContext({ hasUI: false, sessionManager: { getSessionId: () => "main-finalizer" } }),
		)
		if (!result) throw new Error("before_agent_start handler returned no prompt")

		expect(result.systemPrompt).toContain("## Ferment Planner Context")
		expect(result.systemPrompt.trimEnd().endsWith(SNAPSHOT_BLOCK)).toBe(true)
		expect(result.systemPrompt.match(/kimchi:environment-snapshot:start/g)).toHaveLength(1)
		expect(mockGet).not.toHaveBeenCalled()
	})

	it("leaves prompt-debug environment variables unset when debugging is disabled", async () => {
		delete process.env.KIMCHI_DEBUG_PROMPTS
		delete process.env.KIMCHI_DEBUG_SESSION
		const pi = createExtensionApi({
			getFlag: () => false,
		})
		environmentSnapshotFinalizerExtension(pi.api)

		await pi.getHandler("before_agent_start")(
			{ systemPrompt: SNAPSHOT_BLOCK },
			createContext({ hasUI: false, sessionManager: { getSessionId: () => "debug-disabled" } }),
		)

		expect(process.env.KIMCHI_DEBUG_PROMPTS).toBeUndefined()
		expect(process.env.KIMCHI_DEBUG_SESSION).toBeUndefined()
	})

	it("primes collection at session_start using sessionId as contextId", async () => {
		const { sessionStart } = buildPromptExtensionWithHandlers()
		if (!sessionStart) throw new Error("session_start handler not registered")

		const ctx = createContext({ hasUI: false, sessionManager: { getSessionId: () => "main-ctx-1" } })
		await sessionStart({}, ctx)

		expect(mockPrime).toHaveBeenCalledWith(
			expect.objectContaining({
				contextId: "main-ctx-1",
				cwd: expect.any(String),
			}),
		)
	})

	it("restores a persisted snapshot at session_start without collecting", async () => {
		const persisted = "<!-- kimchi:environment-snapshot:start -->\nORIGINAL\n<!-- kimchi:environment-snapshot:end -->"
		const { sessionStart } = buildPromptExtensionWithHandlers()
		if (!sessionStart) throw new Error("session_start handler not registered")
		const ctx = createContext({
			hasUI: false,
			sessionManager: {
				getSessionId: () => "persisted-main",
				getEntries: () => [
					{
						type: "custom",
						id: "snapshot-entry",
						parentId: null,
						timestamp: "2026-08-05T00:00:00.000Z",
						customType: "kimchi:environment-snapshot",
						data: { cwd: "/tmp", snapshot: persisted },
					},
				],
			},
		})

		await sessionStart({}, ctx)

		expect(mockRestore).toHaveBeenCalledWith(
			expect.objectContaining({ contextId: "persisted-main", cwd: expect.any(String) }),
			persisted,
		)
		expect(mockPrime).not.toHaveBeenCalled()
	})

	it("awaits and appends the snapshot as the final section in before_agent_start", async () => {
		mockGet.mockResolvedValue(SNAPSHOT_BLOCK)
		const { beforeAgentStart } = buildPromptExtensionWithHandlers()
		if (!beforeAgentStart) throw new Error("before_agent_start handler not registered")

		const result = (await beforeAgentStart(
			{},
			createContext({ hasUI: false, sessionManager: { getSessionId: () => "main-ctx-2" } }),
		)) as { systemPrompt: string }

		expect(mockGet).toHaveBeenCalledWith(
			expect.objectContaining({
				contextId: "main-ctx-2",
				cwd: expect.any(String),
			}),
		)
		expect(result.systemPrompt).toContain(SNAPSHOT_BLOCK)
		// The snapshot is the LAST section of the prompt.
		expect(result.systemPrompt.trimEnd().endsWith(SNAPSHOT_BLOCK)).toBe(true)
	})

	it.each([
		{ enabled: true, modeHeading: "## Orchestration", sessionId: "snapshot-orchestrator" },
		{ enabled: false, modeHeading: "## Single-Model Mode", sessionId: "snapshot-single" },
	])("appends a final snapshot in $modeHeading mode", async ({ enabled, modeHeading, sessionId }) => {
		mockGet.mockResolvedValue(SNAPSHOT_BLOCK)
		setMultiModelEnabled(sessionId, enabled)
		const { beforeAgentStart } = buildPromptExtensionWithHandlers()
		if (!beforeAgentStart) throw new Error("before_agent_start handler not registered")
		const ctx = createContext({
			hasUI: false,
			sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
		})

		const result = (await beforeAgentStart({}, ctx)) as { systemPrompt: string }

		expect(result.systemPrompt).toContain(modeHeading)
		expect(result.systemPrompt.match(/kimchi:environment-snapshot:start/g)).toHaveLength(1)
		expect(result.systemPrompt.trimEnd().endsWith(SNAPSHOT_BLOCK)).toBe(true)
	})

	it("appends snapshot AFTER append-system-prompt content", async () => {
		mockGet.mockResolvedValue(SNAPSHOT_BLOCK)
		const { beforeAgentStart } = buildPromptExtensionWithHandlers()
		if (!beforeAgentStart) throw new Error("before_agent_start handler not registered")

		const result = (await beforeAgentStart(
			{ systemPromptOptions: { appendSystemPrompt: "EXTRA_APPEND_CONTENT" } },
			createContext({ hasUI: false, sessionManager: { getSessionId: () => "main-ctx-3" } }),
		)) as { systemPrompt: string }

		const appendIdx = result.systemPrompt.indexOf("EXTRA_APPEND_CONTENT")
		const snapshotIdx = result.systemPrompt.indexOf("kimchi:environment-snapshot")
		expect(appendIdx).toBeLessThan(snapshotIdx)
		expect(result.systemPrompt.trimEnd().endsWith(SNAPSHOT_BLOCK)).toBe(true)
	})

	it("strips inherited snapshot block before appending the new one", async () => {
		mockGet.mockResolvedValue(SNAPSHOT_BLOCK)
		const { beforeAgentStart } = buildPromptExtensionWithHandlers()
		if (!beforeAgentStart) throw new Error("before_agent_start handler not registered")

		const inheritedSnapshot =
			"<!-- kimchi:environment-snapshot:start -->\n## Startup Environment Snapshot\nOLD INHERITED\n<!-- kimchi:environment-snapshot:end -->"

		const result = (await beforeAgentStart(
			{ systemPromptOptions: { appendSystemPrompt: inheritedSnapshot } },
			createContext({ hasUI: false, sessionManager: { getSessionId: () => "main-ctx-4" } }),
		)) as { systemPrompt: string }

		// The OLD inherited block must NOT appear — only the new one.
		expect(result.systemPrompt).not.toContain("OLD INHERITED")
		// The new snapshot appears exactly once.
		const matches = result.systemPrompt.match(/kimchi:environment-snapshot:start/g)
		expect(matches).toHaveLength(1)
	})

	it("omits the snapshot block when collection returns undefined (silent fallback)", async () => {
		mockGet.mockResolvedValue(undefined)
		const { beforeAgentStart } = buildPromptExtensionWithHandlers()
		if (!beforeAgentStart) throw new Error("before_agent_start handler not registered")

		const result = (await beforeAgentStart(
			{},
			createContext({ hasUI: false, sessionManager: { getSessionId: () => "main-ctx-5" } }),
		)) as { systemPrompt: string }

		expect(result.systemPrompt).not.toContain("kimchi:environment-snapshot")
	})

	it("clears context cache on session_shutdown", async () => {
		const { sessionShutdown } = buildPromptExtensionWithHandlers()
		if (!sessionShutdown) throw new Error("session_shutdown handler not registered")

		const ctx = createContext({ hasUI: false, sessionManager: { getSessionId: () => "main-ctx-6" } })
		await sessionShutdown({}, ctx)

		expect(mockClearContext).toHaveBeenCalledWith("main-ctx-6")
	})

	it("produces exactly one snapshot block across repeated before_agent_start calls (byte-for-byte reuse)", async () => {
		mockGet.mockResolvedValue(SNAPSHOT_BLOCK)
		const { beforeAgentStart } = buildPromptExtensionWithHandlers()
		if (!beforeAgentStart) throw new Error("before_agent_start handler not registered")

		const ctx = createContext({ hasUI: false, sessionManager: { getSessionId: () => "main-ctx-7" } })

		const result1 = (await beforeAgentStart({}, ctx)) as { systemPrompt: string }
		const result2 = (await beforeAgentStart({}, ctx)) as { systemPrompt: string }

		// Both prompts contain exactly one snapshot block.
		const matches1 = result1.systemPrompt.match(/kimchi:environment-snapshot:start/g)
		const matches2 = result2.systemPrompt.match(/kimchi:environment-snapshot:start/g)
		expect(matches1).toHaveLength(1)
		expect(matches2).toHaveLength(1)

		// The snapshot portion is byte-for-byte identical across turns.
		const block1 = result1.systemPrompt.match(
			/<!-- kimchi:environment-snapshot:start -->[\s\S]*?<!-- kimchi:environment-snapshot:end -->/,
		)?.[0]
		const block2 = result2.systemPrompt.match(
			/<!-- kimchi:environment-snapshot:start -->[\s\S]*?<!-- kimchi:environment-snapshot:end -->/,
		)?.[0]
		expect(block1).toBe(block2)

		// get was called twice (once per before_agent_start) but the underlying
		// cache promise was reused (the mock returns the same resolved value).
		expect(mockGet).toHaveBeenCalledTimes(2)
	})

	it("KIMCHI_ENV_SNAPSHOT=0 removes the snapshot block (opt-out produces undefined)", async () => {
		// When KIMCHI_ENV_SNAPSHOT=0, the real service returns undefined.
		// The mock simulates this by returning undefined (the default).
		mockGet.mockResolvedValue(undefined)
		const { beforeAgentStart } = buildPromptExtensionWithHandlers()
		if (!beforeAgentStart) throw new Error("before_agent_start handler not registered")

		const result = (await beforeAgentStart(
			{ systemPromptOptions: { appendSystemPrompt: "APPEND_CONTENT" } },
			createContext({ hasUI: false, sessionManager: { getSessionId: () => "opt-out-ctx" } }),
		)) as { systemPrompt: string }

		// No snapshot markers in the prompt — opt-out removed the block.
		expect(result.systemPrompt).not.toContain("kimchi:environment-snapshot")
		// The append-system-prompt content is still present.
		expect(result.systemPrompt).toContain("APPEND_CONTENT")
	})

	it("does not crash when snapshot collection rejects (best-effort fallback)", async () => {
		mockGet.mockRejectedValue(new Error("collection failed"))
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const { beforeAgentStart } = buildPromptExtensionWithHandlers()
		if (!beforeAgentStart) throw new Error("before_agent_start handler not registered")

		const result = (await beforeAgentStart(
			{ systemPromptOptions: { appendSystemPrompt: "APPEND_CONTENT" } },
			createContext({ hasUI: false, sessionManager: { getSessionId: () => "fail-ctx" } }),
		)) as { systemPrompt: string }

		// The prompt build did not crash — it fell back to no snapshot block.
		expect(result.systemPrompt).not.toContain("kimchi:environment-snapshot")
		// The append-system-prompt content is still present.
		expect(result.systemPrompt).toContain("APPEND_CONTENT")
		expect(warn).not.toHaveBeenCalled()
		warn.mockRestore()
	})
})
