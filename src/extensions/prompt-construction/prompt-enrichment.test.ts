import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { arch, version as osVersion, platform, release, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Api, AssistantMessage, Model, ToolResultMessage } from "@earendil-works/pi-ai"
import { type ExtensionAPI, loadSkillsFromDir, type ToolInfo } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest"
import * as config from "../../config.js"
import type { ModelMetadata } from "../../models.js"
import { resetProjectScopeTrustForTests, setProjectScopeTrusted } from "../../project-scope-trust.js"
import { resolveBundledSkillsDir } from "../../shared/skill-discovery/resolve-skill-roots.js"
import * as startupContext from "../../startup-context.js"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import * as agentWorkerContext from "../agent-worker-context.js"
import explorationGuardExtension from "../exploration-guard.js"
import * as multiModelModule from "../multi-model.js"
import type { OrchestratorMessages } from "../orchestration/continuation-nudge.js"
import { ASSISTANT_OUTPUT_WITHHELD } from "../orchestration/continuation-nudge.js"
import * as modelRolesModule from "../orchestration/model-roles.js"
import { isHarnessSteer } from "../steer-marker.js"
import promptEnrichmentExtension, {
	_resetDeprecatedNotificationTracking,
	stripEmptyToolCalls,
} from "./prompt-enrichment.js"
import { toolNamesFromSection } from "./test-utils.js"
import { createToolVisibility } from "./tool-visibility.js"

function makeUser(text: string): OrchestratorMessages[number] {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }
}

/** Backend-routed virtual model before any request resolves the pick — its
 *  advertised window does not reflect the routed pool. */
function routedVirtualModel(): Partial<Model<Api>> {
	return { provider: "kimchi-dev", id: "auto", name: "Auto", contextWindow: 1_048_576 }
}

function concreteModel(id: string, contextWindow: number): Partial<Model<Api>> {
	return { provider: "kimchi-dev", id, name: id, contextWindow }
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

const withStop = (
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage => ({
	...makeAssistant(content),
	stopReason,
})

/** A message_update payload carrying a text_delta for content[0]. */
function textDeltaEvent(message: AssistantMessage, delta: string) {
	return {
		message,
		assistantMessageEvent: { type: "text_delta" as const, contentIndex: 0, delta, partial: message },
	}
}

/** Mirrors the SDK's agent-session `_replaceMessageInPlace`: a `message_end`
 *  replacement is applied in place to the stored message (same role), so
 *  `turn_end` and every later consumer see the replaced message — never the
 *  original. Test firers that exercise message_end MUST apply the result
 *  this way, or they diverge from production event flow. */
function applyMessageEndReplacement(payload: unknown, result: unknown): void {
	if (result == null || typeof result !== "object") return
	const replacement = (result as { message?: unknown }).message
	const target = (payload as { message?: unknown } | undefined)?.message
	if (
		replacement == null ||
		typeof replacement !== "object" ||
		target == null ||
		typeof target !== "object" ||
		(replacement as { role?: unknown }).role !== (target as { role?: unknown }).role
	) {
		return
	}
	const record = target as Record<string, unknown>
	for (const key of Object.keys(record)) delete record[key]
	Object.assign(record, replacement)
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

		promptEnrichmentExtension(() => [])(pi)
		const visibility = createToolVisibility(pi)
		visibility.disable(["bash"])

		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		try {
			const result = (await beforeAgentStart({}, createContext({ hasUI: false }))) as { systemPrompt: string }

			expect(toolNamesFromSection(result.systemPrompt)).toContain("read")
			expect(toolNamesFromSection(result.systemPrompt)).not.toContain("bash")
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

		promptEnrichmentExtension(() => [])(pi)

		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const result = (await beforeAgentStart({}, createContext({ hasUI: false }))) as { systemPrompt: string }

		expect(toolNamesFromSection(result.systemPrompt)).toContain("read")
		expect(toolNamesFromSection(result.systemPrompt)).not.toContain("bash")
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

			const result = (await beforeAgentStart({}, createContext({ hasUI: false }))) as { systemPrompt: string }

			expect(result.systemPrompt).not.toContain(`- OS release: ${release()}`)
			expect(result.systemPrompt).toContain(`- OS version: ${osVersion()}`)
			expect(result.systemPrompt).toContain(`- Platform: ${platform()}`)
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

describe("prompt enrichment skills", () => {
	let dir: string
	let oldAgentDir: string | undefined
	let oldHome: string | undefined
	let oldXdgCacheHome: string | undefined

	beforeEach(() => {
		vi.restoreAllMocks()
		dir = mkdtempSync(join(tmpdir(), "kimchi-prompt-skills-"))
		oldAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
		oldHome = process.env.HOME
		oldXdgCacheHome = process.env.XDG_CACHE_HOME
		process.env.KIMCHI_CODING_AGENT_DIR = join(dir, "agent")
		process.env.HOME = join(dir, "home")
		process.env.XDG_CACHE_HOME = join(dir, "cache")
		// Project skill fixtures live under <dir>/project — trusted for the
		// tests that exercise project .kimchi/skills and .claude/skills.
		resetProjectScopeTrustForTests()
		setProjectScopeTrusted(join(dir, "project"), true)
		vi.spyOn(config, "loadConfig").mockReturnValue({ apiKey: "" } as ReturnType<typeof config.loadConfig>)
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

	it("renders skills from pi's resolved inventory in the rebuilt prompt", async () => {
		const cwd = join(dir, "project")
		const { beforeAgentStart } = buildPromptExtensionWithHandlers([])
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const result = (await beforeAgentStart(
			{
				systemPromptOptions: {
					skills: [
						{
							name: "typescript-safety",
							description: "Use safe TypeScript patterns before editing TypeScript files.",
							filePath: join(cwd, "SKILL.md"),
						},
					],
				},
			},
			createContext({ cwd, hasUI: false }),
		)) as { systemPrompt: string }

		expect(result.systemPrompt).toContain("## Skills")
		expect(result.systemPrompt).toContain("- **typescript-safety**")
		expect(result.systemPrompt).toContain("Use safe TypeScript patterns before editing TypeScript files.")
	})

	it("uses the floor skills budget for unresolved auto-routed models", async () => {
		const cwd = join(dir, "project")
		const { beforeAgentStart } = buildPromptExtensionWithHandlers([])
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		// 30 entries with ~200-char descriptions overflow the 5k floor but would
		// easily fit a 1M-window model's scaled budget.
		const skills = Array.from({ length: 30 }, (_, i) => ({
			name: `skill-${i}`,
			description: `${i} ${"word ".repeat(40).trim()}`,
			filePath: join(cwd, `skill-${i}`, "SKILL.md"),
		}))
		const result = (await beforeAgentStart(
			{ systemPromptOptions: { skills } },
			createContext({ cwd, hasUI: false, model: routedVirtualModel() }),
		)) as { systemPrompt: string }

		// The unresolved virtual model's advertised window must not scale the
		// budget — the catalog stays at the floor with name-only degradation.
		expect(result.systemPrompt).toContain("skills are listed name-only to fit the catalog budget")
	})

	it("scales the skills budget with a concrete model's context window", async () => {
		const cwd = join(dir, "project")
		const { beforeAgentStart } = buildPromptExtensionWithHandlers([])
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const skills = Array.from({ length: 30 }, (_, i) => ({
			name: `skill-${i}`,
			description: `${i} ${"word ".repeat(40).trim()}`,
			filePath: join(cwd, `skill-${i}`, "SKILL.md"),
		}))
		const result = (await beforeAgentStart(
			{ systemPromptOptions: { skills } },
			createContext({ cwd, hasUI: false, model: concreteModel("big-context", 1_048_576) }),
		)) as { systemPrompt: string }

		expect(result.systemPrompt).not.toContain("name-only")
		expect(result.systemPrompt.match(/^- \*\*skill-\d+\*\* — /gm)?.length).toBe(30)
	})

	it("no longer discovers skills itself when systemPromptOptions.skills is absent", async () => {
		const cwd = join(dir, "project")
		writeSkill(join(cwd, ".claude", "skills", "typescript-safety", "SKILL.md"), {
			description: "Use safe TypeScript patterns before editing TypeScript files.",
		})
		const { beforeAgentStart } = buildPromptExtensionWithHandlers([])
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const result = (await beforeAgentStart({}, createContext({ cwd, hasUI: false }))) as { systemPrompt: string }

		expect(result.systemPrompt).not.toContain("- **typescript-safety**")
	})

	it("contributes ancestor .kimchi/skills through resources_discover", async () => {
		const cwd = join(dir, "project", "src")
		const projectSkillPath = join(dir, "project", ".kimchi", "skills")
		writeSkill(join(projectSkillPath, "typescript-safety", "SKILL.md"), {
			description: "Use Kimchi project TypeScript patterns.",
		})
		const { resourcesDiscover } = buildPromptExtensionWithHandlers([])
		if (!resourcesDiscover) throw new Error("resources_discover handler was not registered")

		const result = resourcesDiscover({ type: "resources_discover", cwd, reason: "startup" }, undefined)

		expect(result).toEqual(expect.objectContaining({ skillPaths: expect.arrayContaining([projectSkillPath]) }))
	})

	it("contributes no project or claude skills through resources_discover while untrusted", () => {
		const cwd = join(dir, "project", "src")
		writeSkill(join(dir, "project", ".kimchi", "skills", "evil-instructions", "SKILL.md"), {
			description: "Evil project skill instructions.",
		})
		writeSkill(join(dir, "project", ".claude", "skills", "evil-claude", "SKILL.md"), {
			description: "Evil claude skill instructions.",
		})
		const { resourcesDiscover } = buildPromptExtensionWithHandlers([])
		if (!resourcesDiscover) throw new Error("resources_discover handler was not registered")

		// Close the gate the describe's beforeEach opened: a cloned repo's
		// skills must stay out of pi's resource inventory (and so out of the
		// system prompt) until the folder is trusted.
		resetProjectScopeTrustForTests()
		const untrusted = resourcesDiscover({ type: "resources_discover", cwd, reason: "startup" }, undefined)
		const untrustedPaths = ((untrusted as { skillPaths?: string[] } | undefined)?.skillPaths ?? []).map((p) =>
			resolve(p),
		)
		expect(
			untrustedPaths.some((p) => p.includes(join(".kimchi", "skills")) || p.includes(join(".claude", "skills"))),
		).toBe(false)

		// Trusted: the same discovery now contributes the project skill root.
		setProjectScopeTrusted(join(dir, "project"), true)
		const trusted = resourcesDiscover({ type: "resources_discover", cwd, reason: "startup" }, undefined)
		const trustedPaths = ((trusted as { skillPaths?: string[] } | undefined)?.skillPaths ?? []).map((p) => resolve(p))
		expect(trustedPaths).toContain(resolve(join(dir, "project", ".kimchi", "skills")))
	})

	it("contributes new bundled skills through resources_discover", async () => {
		const cwd = join(dir, "project")
		mkdirSync(cwd, { recursive: true })
		const bundledDir = resolveBundledSkillsDir()
		if (!bundledDir) {
			throw new Error("expected bundled skills dir to be resolvable in this test environment")
		}
		const { resourcesDiscover } = buildPromptExtensionWithHandlers([])
		if (!resourcesDiscover) throw new Error("resources_discover handler was not registered")

		const result = resourcesDiscover({ type: "resources_discover", cwd, reason: "startup" }, undefined) as
			| { skillPaths?: string[] }
			| undefined

		// Bundled skills not already in the harness dir are contributed via a
		// filtered temp copy (e.g. dap-debugging). Skills already in the harness
		// dir (e.g. improve if previously deployed) are silently skipped.
		const paths = result?.skillPaths ?? []
		expect(paths.length).toBeGreaterThan(0)
		// At least one contributed path should contain a bundled skill dir.
		expect(paths.some((p) => existsSync(join(p, "dap-debugging")) || existsSync(join(p, "improve")))).toBe(true)
		const loaded = paths.map((path) => loadSkillsFromDir({ dir: path, source: "path" }))
		const creator = loaded.flatMap((result) => result.skills).find((skill) => skill.name === "create-skill")
		expect(creator).toBeDefined()
		expect(creator?.disableModelInvocation).toBe(false)
		expect(loaded.flatMap((result) => result.diagnostics).filter((item) => item.path === creator?.filePath)).toEqual([])
	})

	it("contributes configured native skill paths through resources_discover", async () => {
		const cwd = join(dir, "project")
		const configuredSkills = join(dir, "configured", "skills")
		mkdirSync(configuredSkills, { recursive: true })
		const { resourcesDiscover } = buildPromptExtensionWithHandlers([configuredSkills])
		if (!resourcesDiscover) throw new Error("resources_discover handler was not registered")

		const result = resourcesDiscover({ type: "resources_discover", cwd, reason: "startup" }, undefined)

		expect(result).toEqual(expect.objectContaining({ skillPaths: expect.arrayContaining([configuredSkills]) }))
	})

	it("does not contribute the harness dir (pi loads it via includeDefaults)", async () => {
		const cwd = join(dir, "project")
		const configuredSkills = ".config/kimchi/harness/skills"
		const expanded = join(dir, "home", configuredSkills)
		mkdirSync(expanded, { recursive: true })
		const { resourcesDiscover } = buildPromptExtensionWithHandlers([configuredSkills])
		if (!resourcesDiscover) throw new Error("resources_discover handler was not registered")

		const result = resourcesDiscover({ type: "resources_discover", cwd, reason: "startup" }, undefined) as
			| { skillPaths?: string[] }
			| undefined

		const paths = result?.skillPaths ?? []
		expect(paths).not.toContain(expanded)
	})

	it("sanitizes configured Claude Code skill paths through resources_discover", async () => {
		const cwd = join(dir, "project")
		writeRawSkill(join(cwd, ".claude", "skills", "typescript-safety", "SKILL.md"), "Use generated types.\n")
		const { resourcesDiscover } = buildPromptExtensionWithHandlers([".claude/skills"])
		if (!resourcesDiscover) throw new Error("resources_discover handler was not registered")

		const result = resourcesDiscover({ type: "resources_discover", cwd, reason: "startup" }, undefined) as
			| { skillPaths?: string[] }
			| undefined

		const paths = result?.skillPaths ?? []
		expect(paths.length).toBeGreaterThan(0)
		expect(paths.some((p) => p.includes(".claude"))).toBe(false)
		expect(paths.some((p) => existsSync(join(p, "SKILL.md")))).toBe(true)
	})

	it("does not contribute ancestor Claude Code skills through resources_discover", async () => {
		const project = join(dir, "project")
		const cwd = join(project, "src")
		writeSkill(join(project, ".claude", "skills", "typescript-safety", "SKILL.md"), {
			description: "Use safe TypeScript patterns before editing TypeScript files.",
		})
		const { resourcesDiscover } = buildPromptExtensionWithHandlers([])
		if (!resourcesDiscover) throw new Error("resources_discover handler was not registered")

		const result = resourcesDiscover({ type: "resources_discover", cwd, reason: "startup" }, undefined) as
			| { skillPaths?: string[] }
			| undefined

		const paths = result?.skillPaths ?? []
		expect(paths.some((p) => p.includes(".claude"))).toBe(false)
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
			createContext({ hasUI: false }),
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

		promptEnrichmentExtension(() => [])(pi)

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

		promptEnrichmentExtension(() => [])(pi)

		expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("[model-roles] Warning:"))
	})

	it("keeps unavailable role warnings when Kimchi auth is already configured", () => {
		vi.spyOn(config, "loadConfig").mockReturnValue({
			apiKey: "test-key",
			agentConfigDir: "",
		} as ReturnType<typeof config.loadConfig>)
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

		promptEnrichmentExtension(() => [])(pi)

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
	promptEnrichmentExtension(() => skillPaths)(pi)
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

// ISO timestamp N days out from test execution — deprecation fixtures must stay
// inside the 30-day session-start notice window regardless of when tests run.
function isoWithinDays(days: number): string {
	return new Date(Date.now() + days * 86_400_000).toISOString()
}

describe("deprecated model notification", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
		_resetDeprecatedNotificationTracking()
		// Default to single-model mode: the ambient multiModel default is true,
		// which would redirect session_start warnings to the orchestrator role
		// model instead of ctx.model. Tests here control the context explicitly.
		vi.spyOn(multiModelModule, "setAndPersistMultiModelEnabled").mockReturnValue({
			value: false,
		} as unknown as ReturnType<typeof multiModelModule.setAndPersistMultiModelEnabled>)
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
		promptEnrichmentExtension(() => [])(pi)
		return {
			handlers,
			sessionStart: handlers.get("session_start"),
			sessionShutdown: handlers.get("session_shutdown"),
			modelSelect: handlers.get("model_select"),
			modelInput: handlers.get("input"),
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
				deprecated_at: isoWithinDays(14),
				replacement_model: replacementModelId,
				...modelProps,
			},
			{ slug: "active-model", display_name: "Active Model", ...modelProps },
			{ slug: replacementModelId, display_name: "Kimi K2.7", ...modelProps },
		]
		setupAvailableModels(models)

		const { sessionStart } = buildExtensionWithHandlers()
		if (!sessionStart) throw new Error("session_start handler not registered")

		const ctx = createContext({ model: { provider: "kimchi-dev", id: deprecatedModelId } })
		await sessionStart({}, ctx)

		expect(ctx.ui.notify as Mock).toHaveBeenCalledWith(
			`Model "${deprecatedModelId}" is deprecated and will be retired on ${isoWithinDays(14).slice(0, 10)}. Switch to "${replacementModelId}" using your client's model selector (/model in the terminal).`,
			"warning",
		)
	})

	it("notifies past-deprecated models with the sunset date and still-served clause", async () => {
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
				deprecated_at: isoWithinDays(-7),
				sunset_at: isoWithinDays(5),
				replacement_model: replacementModelId,
				...modelProps,
			},
			{ slug: replacementModelId, display_name: "Kimi K2.7", ...modelProps },
		]
		setupAvailableModels(models)

		const { sessionStart } = buildExtensionWithHandlers()
		if (!sessionStart) throw new Error("session_start handler not registered")

		const ctx = createContext({ model: { provider: "kimchi-dev", id: deprecatedModelId } })
		await sessionStart({}, ctx)

		expect(ctx.ui.notify as Mock).toHaveBeenCalledWith(
			`Model "${deprecatedModelId}" is deprecated and stops being served on ${isoWithinDays(5).slice(0, 10)}. Still served until then. Switch to "${replacementModelId}" using your client's model selector (/model in the terminal).`,
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
			{ slug: deprecatedModelId, display_name: "Kimi K2.6 Old", deprecated_at: isoWithinDays(14), ...modelProps },
			{ slug: "active-model", display_name: "Active Model", ...modelProps },
		]
		setupAvailableModels(models)

		const { sessionStart } = buildExtensionWithHandlers()
		if (!sessionStart) throw new Error("session_start handler not registered")

		const ctx = createContext({ model: { provider: "kimchi-dev", id: deprecatedModelId } })
		await sessionStart({}, ctx)

		expect(ctx.ui.notify as Mock).toHaveBeenCalledWith(
			`Model "${deprecatedModelId}" is deprecated and will be retired on ${isoWithinDays(14).slice(0, 10)}. Pick a replacement using your client's model selector (/model in the terminal).`,
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
		const models: ModelMetadata[] = [{ slug: "active-model", display_name: "Active Model", ...modelProps }]
		setupAvailableModels(models)

		const { sessionStart } = buildExtensionWithHandlers()
		if (!sessionStart) throw new Error("session_start handler not registered")

		const ctx = createContext({ model: { provider: "kimchi-dev", id: "active-model" } })
		await sessionStart({}, ctx)

		expect((ctx.ui.notify as Mock).mock.calls.length).toBe(0)
	})

	it("notifies once per session per model — repeats do not re-fire", async () => {
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
				deprecated_at: isoWithinDays(14),
				replacement_model: replacementModelId,
				...modelProps,
			},
			{ slug: "active-model", display_name: "Active Model", ...modelProps },
		]
		setupAvailableModels(models)

		const { sessionStart, modelInput } = buildExtensionWithHandlers()
		if (!sessionStart || !modelInput) throw new Error("session_start/input handlers not registered")

		// Session start notifies once; duplicate session starts and the first
		// user message must not re-fire the per-model notification.
		const ctx = createContext({ model: { provider: "kimchi-dev", id: deprecatedModelId } })
		await sessionStart({}, ctx)
		await sessionStart({}, ctx)
		await modelInput({ source: "interactive" }, ctx)

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
				deprecated_at: isoWithinDays(14),
				replacement_model: replacementModelId,
				...modelProps,
			},
			{ slug: "active-model", display_name: "Active Model", ...modelProps },
		]
		setupAvailableModels(models)

		const { sessionStart, sessionShutdown, modelInput } = buildExtensionWithHandlers()
		if (!sessionStart || !modelInput) throw new Error("session_start/input handlers not registered")
		if (!sessionShutdown) throw new Error("session_shutdown handler not registered")

		const ctx = createContext({ model: { provider: "kimchi-dev", id: deprecatedModelId } })

		// First run: notification fires at session start.
		await sessionStart({}, ctx)
		await modelInput({ source: "interactive" }, ctx)
		// Shutdown clears the per-session tracking...
		await sessionShutdown({}, ctx)
		// ...so restarting and messaging notifies again.
		await sessionStart({}, ctx)
		await modelInput({ source: "interactive" }, ctx)

		const notifyMock = ctx.ui.notify as Mock
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
				deprecated_at: isoWithinDays(14),
				replacement_model: "nonexistent-model",
				...modelProps,
			},
			{ slug: "active-model", display_name: "Active Model", ...modelProps },
		]
		setupAvailableModels(models)

		const { sessionStart } = buildExtensionWithHandlers()
		if (!sessionStart) throw new Error("session_start handler not registered")

		const ctx = createContext({ model: { provider: "kimchi-dev", id: deprecatedModelId } })
		await sessionStart({}, ctx)

		expect(ctx.ui.notify as Mock).toHaveBeenCalledWith(
			`Model "${deprecatedModelId}" is deprecated and will be retired on ${isoWithinDays(14).slice(0, 10)}. Pick a replacement using your client's model selector (/model in the terminal).`,
			"warning",
		)
	})
	it("warns once per deprecated model while cycling, even when cycling back and forth", async () => {
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
				deprecated_at: isoWithinDays(14),
				...modelProps,
			},
			{
				slug: "kimi-k2.5-old",
				display_name: "Kimi K2.5 Old",
				deprecated_at: isoWithinDays(14),
				...modelProps,
			},
			{ slug: "active-model", display_name: "Active Model", ...modelProps },
		]
		setupAvailableModels(models)

		const { sessionStart, modelSelect } = buildExtensionWithHandlers()
		if (!sessionStart || !modelSelect) throw new Error("session_start/model_select handlers not registered")

		// Session starts on an active model — nothing notified.
		const startCtx = createContext({ model: { provider: "kimchi-dev", id: "active-model" } })
		await sessionStart({}, startCtx)
		expect((startCtx.ui.notify as Mock).mock.calls.length).toBe(0)

		// Cycling onto a deprecated model notifies once.
		const cycleOneCtx = createContext({ model: { provider: "kimchi-dev", id: deprecatedModelId } })
		await modelSelect({ source: "cycle" }, cycleOneCtx)
		expect(cycleOneCtx.ui.notify as Mock).toHaveBeenCalledWith(
			`Model "${deprecatedModelId}" is deprecated and will be retired on ${isoWithinDays(14).slice(0, 10)}. Pick a replacement using your client's model selector (/model in the terminal).`,
			"warning",
		)

		// Cycling back to a non-deprecated model notifies nothing.
		const cycleAwayCtx = createContext({ model: { provider: "kimchi-dev", id: "active-model" } })
		await modelSelect({ source: "cycle" }, cycleAwayCtx)
		expect((cycleAwayCtx.ui.notify as Mock).mock.calls.length).toBe(0)

		// Cycling back onto the same deprecated model is deduplicated.
		const cycleBackCtx = createContext({ model: { provider: "kimchi-dev", id: deprecatedModelId } })
		await modelSelect({ source: "cycle" }, cycleBackCtx)
		expect((cycleBackCtx.ui.notify as Mock).mock.calls.length).toBe(0)

		// A different deprecated model gets its own warning.
		const cycleTwoCtx = createContext({ model: { provider: "kimchi-dev", id: "kimi-k2.5-old" } })
		await modelSelect({ source: "cycle" }, cycleTwoCtx)
		expect(cycleTwoCtx.ui.notify as Mock).toHaveBeenCalledWith(
			`Model "kimi-k2.5-old" is deprecated and will be retired on ${isoWithinDays(14).slice(0, 10)}. Pick a replacement using your client's model selector (/model in the terminal).`,
			"warning",
		)
	})

	it("warns on deprecated model switches made mid-conversation, at most once per model", async () => {
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
				deprecated_at: isoWithinDays(14),
				...modelProps,
			},
			{
				slug: "kimi-k2.5-old",
				display_name: "Kimi K2.5 Old",
				deprecated_at: isoWithinDays(14),
				...modelProps,
			},
			{ slug: "active-model", display_name: "Active Model", ...modelProps },
		]
		setupAvailableModels(models)

		const { sessionStart, modelSelect, modelInput } = buildExtensionWithHandlers()
		if (!sessionStart || !modelSelect || !modelInput)
			throw new Error("session_start/model_select/input handlers not registered")

		// Session starts on an active model and the first user message is sent —
		// the conversation is underway.
		const firstCtx = createContext({ model: { provider: "kimchi-dev", id: "active-model" } })
		await sessionStart({}, firstCtx)
		await modelInput({ source: "interactive" }, firstCtx)
		expect((firstCtx.ui.notify as Mock).mock.calls.length).toBe(0)

		// Switching to a deprecated model mid-conversation still warns once —
		// the user should know the model they just picked is retiring.
		const switchCtx = createContext({ model: { provider: "kimchi-dev", id: deprecatedModelId } })
		await modelSelect({ source: "cycle" }, switchCtx)
		expect(switchCtx.ui.notify as Mock).toHaveBeenCalledWith(
			`Model "${deprecatedModelId}" is deprecated and will be retired on ${isoWithinDays(14).slice(0, 10)}. Pick a replacement using your client's model selector (/model in the terminal).`,
			"warning",
		)

		// Switching back and forth does not spam: the per-model warning already fired.
		const switchBackCtx = createContext({ model: { provider: "kimchi-dev", id: deprecatedModelId } })
		await modelSelect({ source: "cycle" }, switchBackCtx)
		expect((switchBackCtx.ui.notify as Mock).mock.calls.length).toBe(0)
	})
	it("warns at session start for the deprecated multi-model orchestrator model", async () => {
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
				deprecated_at: isoWithinDays(14),
				...modelProps,
			},
			{ slug: "active-model", display_name: "Active Model", ...modelProps },
		]
		setupAvailableModels(models)
		// Multi-model mode: the session starts on an active model but the
		// orchestrator role model is announced-deprecated. The warning must
		// still fire — it targets the model the session will actually run on.
		vi.spyOn(multiModelModule, "setAndPersistMultiModelEnabled").mockReturnValue({
			value: true,
		} as unknown as ReturnType<typeof multiModelModule.setAndPersistMultiModelEnabled>)
		vi.spyOn(modelRolesModule, "getOrchestratorModelRef").mockReturnValue(`kimchi-dev/${deprecatedModelId}`)

		const { sessionStart } = buildExtensionWithHandlers()
		if (!sessionStart) throw new Error("session_start handler not registered")
		const ctx = createContext({ model: { provider: "kimchi-dev", id: "active-model" } })
		await sessionStart({}, ctx)

		expect(ctx.ui.notify as Mock).toHaveBeenCalledWith(
			`Model "${deprecatedModelId}" is deprecated and will be retired on ${isoWithinDays(14).slice(0, 10)}. Pick a replacement using your client's model selector (/model in the terminal).`,
			"warning",
		)
	})

	it("does not warn when the retirement date is beyond the 30-day notice window", async () => {
		const modelProps: Omit<ModelMetadata, "slug" | "display_name" | "status" | "replacement"> = {
			provider: "kimchi-dev",
			reasoning: false,
			input_modalities: ["text"],
			is_serverless: true,
			limits: { context_window: 128000, max_output_tokens: 8192 },
		}
		const models: ModelMetadata[] = [
			{
				slug: "claude-sonnet-5",
				display_name: "Claude Sonnet 5",
				deprecated_at: isoWithinDays(365),
				...modelProps,
			},
		]
		setupAvailableModels(models)

		const { sessionStart } = buildExtensionWithHandlers()
		if (!sessionStart) throw new Error("session_start handler not registered")
		const ctx = createContext({ model: { provider: "kimchi-dev/anthropic", id: "claude-sonnet-5" } })
		await sessionStart({}, ctx)

		expect((ctx.ui.notify as Mock).mock.calls.length).toBe(0)
	})

	it("notifies for a sunset-only record (vendor retirement, no announced deprecation) within the window", async () => {
		const modelProps: Omit<ModelMetadata, "slug" | "display_name" | "status" | "replacement"> = {
			provider: "kimchi-dev/openai",
			reasoning: false,
			input_modalities: ["text"],
			is_serverless: false,
			limits: { context_window: 128000, max_output_tokens: 8192 },
		}
		const models: ModelMetadata[] = [
			{ slug: "gpt-4", display_name: "GPT-4", sunset_at: isoWithinDays(21), ...modelProps },
			{ slug: "active-model", display_name: "Active Model", ...modelProps },
		]
		setupAvailableModels(models)

		const { sessionStart } = buildExtensionWithHandlers()
		if (!sessionStart) throw new Error("session_start handler not registered")

		// The wording states the retirement plainly instead of claiming an
		// announced deprecation that never happened.
		const ctx = createContext({ model: { provider: "kimchi-dev/openai", id: "gpt-4" } })
		await sessionStart({}, ctx)
		expect(ctx.ui.notify as Mock).toHaveBeenCalledWith(
			`Model "gpt-4" stops being served on ${isoWithinDays(21).slice(0, 10)} (vendor retirement). Pick a replacement using your client's model selector (/model in the terminal).`,
			"warning",
		)
	})

	it("gates on the valid sunset date when deprecated_at is malformed", async () => {
		const modelProps: Omit<ModelMetadata, "slug" | "display_name" | "status" | "replacement"> = {
			provider: "kimchi-dev/openai",
			reasoning: false,
			input_modalities: ["text"],
			is_serverless: false,
			limits: { context_window: 128000, max_output_tokens: 8192 },
		}
		const models: ModelMetadata[] = [
			// A malformed deprecated_at must not fire the warning immediately;
			// the far-future sunset should gate it like any other record.
			{
				slug: "gpt-4",
				display_name: "GPT-4",
				deprecated_at: "not-a-date",
				sunset_at: isoWithinDays(200),
				...modelProps,
			},
		]
		setupAvailableModels(models)

		const { sessionStart } = buildExtensionWithHandlers()
		if (!sessionStart) throw new Error("session_start handler not registered")
		const ctx = createContext({ model: { provider: "kimchi-dev/openai", id: "gpt-4" } })
		await sessionStart({}, ctx)

		expect((ctx.ui.notify as Mock).mock.calls.length).toBe(0)
	})

	it("stays silent for a sunset-only record beyond the notice window", async () => {
		const modelProps: Omit<ModelMetadata, "slug" | "display_name" | "status" | "replacement"> = {
			provider: "kimchi-dev/openai",
			reasoning: false,
			input_modalities: ["text"],
			is_serverless: false,
			limits: { context_window: 128000, max_output_tokens: 8192 },
		}
		const models: ModelMetadata[] = [
			{ slug: "gpt-audio", display_name: "GPT Audio", sunset_at: isoWithinDays(110), ...modelProps },
		]
		setupAvailableModels(models)

		const { sessionStart } = buildExtensionWithHandlers()
		if (!sessionStart) throw new Error("session_start handler not registered")
		const ctx = createContext({ model: { provider: "kimchi-dev/openai", id: "gpt-audio" } })
		await sessionStart({}, ctx)

		expect((ctx.ui.notify as Mock).mock.calls.length).toBe(0)
	})
})

describe("orchestrator default remap on session_start", () => {
	let dir: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-remap-"))
		vi.restoreAllMocks()
	})

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

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
		promptEnrichmentExtension(() => [])(pi)
		return {
			handlers,
			sessionStart: handlers.get("session_start"),
		}
	}

	function remapConfigMock(agentDir: string) {
		vi.spyOn(config, "loadConfig").mockReturnValue({
			apiKey: "test-key",
			agentConfigDir: agentDir,
			region: "us",
			selfHostedUrl: undefined,
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
	}

	function availableMetadata(slug: string): ModelMetadata {
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

	it("remaps the default orchestrator to the sidecar replacement when the default is unavailable", async () => {
		writeFileSync(
			join(dir, "model-deprecations.json"),
			JSON.stringify({ "kimi-k3": { deprecated_at: "2025-01-01T00:00:00Z", replacement_model: "kimi-k4" } }),
		)
		remapConfigMock(dir)
		vi.spyOn(modelRolesModule, "getModelRoles").mockReturnValue({ ...modelRolesModule.DEFAULT_MODEL_ROLES })
		const saveSpy = vi.spyOn(modelRolesModule, "saveModelRoles").mockImplementation(() => {})
		setupAvailableModels([availableMetadata("kimi-k4"), availableMetadata("minimax-m3")])

		const { sessionStart } = buildExtensionWithHandlers()
		if (!sessionStart) throw new Error("session_start handler not registered")
		const ctx = createContext({ model: { provider: "kimchi-dev", id: "kimi-k3" } })
		await sessionStart({}, ctx)

		expect(saveSpy).toHaveBeenCalledTimes(1)
		expect(saveSpy.mock.calls[0][0].orchestrator).toBe("kimchi-dev/kimi-k4")
		const notifyMock = ctx.ui.notify as Mock
		expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining('Remapped to "kimchi-dev/kimi-k4"'), "warning")
	})

	it("respects a user-configured orchestrator override", async () => {
		writeFileSync(
			join(dir, "model-deprecations.json"),
			JSON.stringify({ "kimi-k2.7": { deprecated_at: "2025-01-01T00:00:00Z", replacement_model: "kimi-k3" } }),
		)
		remapConfigMock(dir)
		vi.spyOn(modelRolesModule, "getModelRoles").mockReturnValue({
			...modelRolesModule.DEFAULT_MODEL_ROLES,
			orchestrator: "kimchi-dev/custom-model",
		})
		const saveSpy = vi.spyOn(modelRolesModule, "saveModelRoles").mockImplementation(() => {})
		setupAvailableModels([availableMetadata("kimi-k3")])

		const { sessionStart } = buildExtensionWithHandlers()
		if (!sessionStart) throw new Error("session_start handler not registered")
		const ctx = createContext({ model: { provider: "kimchi-dev", id: "kimi-k2.7" } })
		await sessionStart({}, ctx)

		expect(saveSpy).not.toHaveBeenCalled()
	})

	it("does nothing when the default orchestrator is still available", async () => {
		remapConfigMock(dir)
		vi.spyOn(modelRolesModule, "getModelRoles").mockReturnValue({ ...modelRolesModule.DEFAULT_MODEL_ROLES })
		const saveSpy = vi.spyOn(modelRolesModule, "saveModelRoles").mockImplementation(() => {})
		setupAvailableModels([availableMetadata("kimi-k2.7")])

		const { sessionStart } = buildExtensionWithHandlers()
		if (!sessionStart) throw new Error("session_start handler not registered")
		const ctx = createContext({ model: { provider: "kimchi-dev", id: "kimi-k2.7" } })
		await sessionStart({}, ctx)

		expect(saveSpy).not.toHaveBeenCalled()
	})

	it("does nothing when the sidecar records no available replacement", async () => {
		writeFileSync(
			join(dir, "model-deprecations.json"),
			JSON.stringify({ "kimi-k2.7": { deprecated_at: "2025-01-01T00:00:00Z" } }),
		)
		remapConfigMock(dir)
		vi.spyOn(modelRolesModule, "getModelRoles").mockReturnValue({ ...modelRolesModule.DEFAULT_MODEL_ROLES })
		const saveSpy = vi.spyOn(modelRolesModule, "saveModelRoles").mockImplementation(() => {})
		setupAvailableModels([availableMetadata("kimi-k3")])

		const { sessionStart } = buildExtensionWithHandlers()
		if (!sessionStart) throw new Error("session_start handler not registered")
		const ctx = createContext({ model: { provider: "kimchi-dev", id: "kimi-k2.7" } })
		await sessionStart({}, ctx)

		expect(saveSpy).not.toHaveBeenCalled()
	})
})

describe("retired model substitution notification", () => {
	// The gateway annotates transparently rewritten responses with
	// X-Model-Requested / X-Model-Actual (+ Deprecation/Sunset HTTP-dates).
	// The warning is driven purely by those headers — no sidecar involved.
	const retiredModelId = "glm-5.2-fp8"
	const replacementModelId = "glm-5.3"
	const sunsetDate = new Date(Date.now() + 30 * 86_400_000)

	beforeEach(() => {
		vi.restoreAllMocks()
		_resetDeprecatedNotificationTracking()
	})

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
		promptEnrichmentExtension(() => [])(pi)
		return { afterProviderResponse: handlers.get("after_provider_response") }
	}

	function substitutionHeaders(extra: Record<string, string> = {}): Record<string, string> {
		return {
			"X-Model-Requested": retiredModelId,
			"X-Model-Actual": replacementModelId,
			Sunset: sunsetDate.toUTCString(),
			...extra,
		}
	}

	async function fireSubstitutedResponse(headers: Record<string, string> | Headers) {
		const { afterProviderResponse } = buildExtensionWithHandlers()
		if (!afterProviderResponse) throw new Error("after_provider_response handler not registered")
		const ctx = createContext({ model: { provider: "kimchi-dev", id: retiredModelId } })
		await afterProviderResponse({ type: "after_provider_response", status: 200, headers }, ctx)
		return ctx.ui.notify as Mock
	}

	it("warns once that a deprecated model is served by the replacement, with the sunset date", async () => {
		const notifyMock = await fireSubstitutedResponse(substitutionHeaders())
		expect(notifyMock).toHaveBeenCalledWith(
			`Model "${retiredModelId}" is deprecated (sunsets ${sunsetDate.toISOString().slice(0, 10)}) and currently served by "${replacementModelId}". Switch via /model.`,
			"warning",
		)
	})

	it("fires once per session and model even when the header appears on every response", async () => {
		const notifyMock = await fireSubstitutedResponse(substitutionHeaders())
		expect(notifyMock).toHaveBeenCalledTimes(1)
		const notifyAgain = await fireSubstitutedResponse(substitutionHeaders())
		expect(notifyAgain).not.toHaveBeenCalled()
	})

	it("warns without a sunset clause when the header is absent", async () => {
		const notifyMock = await fireSubstitutedResponse({
			"X-Model-Requested": retiredModelId,
			"X-Model-Actual": replacementModelId,
		})
		expect(notifyMock).toHaveBeenCalledWith(
			`Model "${retiredModelId}" is deprecated and currently served by "${replacementModelId}". Switch via /model.`,
			"warning",
		)
	})

	it("stays silent when the gateway echoes the requested model", async () => {
		const notifyMock = await fireSubstitutedResponse({
			"X-Model-Requested": retiredModelId,
			"X-Model-Actual": retiredModelId,
		})
		expect(notifyMock).not.toHaveBeenCalled()
	})

	it("stays silent on plain responses without the gateway headers", async () => {
		const notifyMock = await fireSubstitutedResponse({})
		expect(notifyMock).not.toHaveBeenCalled()
	})

	it("stays silent when only one of the pair is present", async () => {
		const notifyMock = await fireSubstitutedResponse({ "X-Model-Requested": retiredModelId })
		expect(notifyMock).not.toHaveBeenCalled()
	})

	it("reads a Headers instance, the runtime shape pi-ai forwards", async () => {
		const notifyMock = await fireSubstitutedResponse(new Headers(substitutionHeaders()))
		expect(notifyMock).toHaveBeenCalledWith(
			`Model "${retiredModelId}" is deprecated (sunsets ${sunsetDate.toISOString().slice(0, 10)}) and currently served by "${replacementModelId}". Switch via /model.`,
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
			region: "us",
			selfHostedUrl: undefined,
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

		promptEnrichmentExtension(() => [])(pi)

		const fire = async (event: string, payload: unknown) => {
			const handlers = handlerMap.get(event) ?? []
			const ctx = createContext({ model: { provider: "test", id: "test-model" } })
			let result: unknown
			for (const h of handlers) result = await h(payload, ctx)
			return result
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

	it("does not nudge after a model switch when the previous model called tools", async () => {
		const { fire, sendMessageCalls } = buildNudgeHandlers()

		// Previous model called a tool during the session.
		await fire("tool_execution_start", {})

		// User switches models (e.g. via the UI model picker).
		await fire("model_select", {
			model: { id: "kimi-k2.7", provider: "kimchi-dev" },
			previousModel: undefined,
			source: "set",
		})

		// New user input after the switch.
		await fire("input", { source: "user" })

		// New model responds with orientation text only, no tool calls.
		await fire("turn_end", {
			message: makeAssistantWithStop([{ type: "text", text: "I'll review the branch in detail." }]),
		})

		// No nudge should fire — the model switch reset the session-level
		// tool latch, so the new model's orientation turn is treated like a
		// fresh session.
		expect(sendMessageCalls.length).toBe(0)
	})

	it("does not nudge after a model cycle when the previous model called tools", async () => {
		const { fire, sendMessageCalls } = buildNudgeHandlers()

		// Previous model called a tool during the session.
		await fire("tool_execution_start", {})

		// User cycles models (e.g. via the keyboard shortcut).
		await fire("model_select", {
			model: { id: "kimi-k2.7", provider: "kimchi-dev" },
			previousModel: undefined,
			source: "cycle",
		})

		// New user input after the cycle.
		await fire("input", { source: "user" })

		// New model responds with orientation text only, no tool calls.
		await fire("turn_end", {
			message: makeAssistantWithStop([{ type: "text", text: "I'll review the branch in detail." }]),
		})

		// Cycling is a user-initiated switch and must also reset the latch.
		expect(sendMessageCalls.length).toBe(0)
	})

	it("still nudges after a model restore when the previous model called tools", async () => {
		const { fire, sendMessageCalls } = buildNudgeHandlers()

		// Previous model called a tool during the session.
		await fire("tool_execution_start", {})

		// Session restore is not a user-initiated switch; the conversation
		// continues and the session-level tool latch must stay true.
		await fire("model_select", {
			model: { id: "kimi-k2.7", provider: "kimchi-dev" },
			previousModel: undefined,
			source: "restore",
		})

		// New user input after restore.
		await fire("input", { source: "user" })

		// Model responds with text only, no tool calls.
		await fire("turn_end", {
			message: makeAssistantWithStop([{ type: "text", text: "I'll review the branch in detail." }]),
		})

		// Nudge should fire because restore must not reset the latch.
		expect(sendMessageCalls.length).toBe(1)
		expect((sendMessageCalls[0].message as { customType?: string }).customType).toBe("nudge")
	})

	it("brands unbranded custom messages in the context handler", async () => {
		const { fire } = buildNudgeHandlers()

		const unbranded = {
			role: "custom",
			customType: "exploration-guard-steer",
			content: "Act on your hypothesis now.",
			display: false,
			timestamp: 1,
		}

		const result = (await fire("context", { messages: [unbranded] })) as
			| { messages: Array<{ content: string }> }
			| undefined

		expect(result).toBeDefined()
		expect(isHarnessSteer(result?.messages[0]?.content ?? "")).toBe(true)
		expect(result?.messages[0]?.content).toContain("Act on your hypothesis now.")
	})

	it("leaves already-branded custom messages byte-identical in the context handler", async () => {
		const { fire } = buildNudgeHandlers()

		const branded = {
			role: "custom",
			customType: "nudge",
			content: "<system-reminder>\nYou ended your turn without calling a tool.\n</system-reminder>",
			display: false,
			timestamp: 1,
		}

		// No transform applies: the handler returns undefined, leaving the
		// runtime's message array untouched.
		const result = await fire("context", { messages: [branded] })
		expect(result).toBeUndefined()
	})
})

describe("nudge response pending cleanup", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
		vi.spyOn(agentWorkerContext, "isAgentWorker").mockReturnValue(false)
		vi.spyOn(startupContext, "getAvailableModels").mockReturnValue([])
		vi.spyOn(config, "loadConfig").mockReturnValue({
			apiKey: "",
			agentConfigDir: "",
		} as ReturnType<typeof config.loadConfig>)
	})

	/** Builds the extension on the shared ExtensionAPI mock and returns an
	 *  event firer bound to one session context plus the recorded sends.
	 *  message_end replacements are applied in place, as the SDK does. */
	function buildCleanupHandlers() {
		const shared = createExtensionApi()
		promptEnrichmentExtension(() => [])(shared.api)
		const ctx = createContext({ model: { provider: "test", id: "test-model" } })
		const fire = async (event: string, payload: unknown) => {
			let result: unknown
			for (const handler of shared.getHandlers(event)) {
				result = await handler(payload, ctx)
			}
			if (event === "message_end") applyMessageEndReplacement(payload, result)
			return result
		}
		const sentMessages = () => shared.sendMessage.mock.calls.map(([message]) => message)
		return { fire, sentMessages }
	}

	/** Arms a pending nudge: prior tool call (session latch), new user-input
	 *  cycle, then a text-only drift turn that fires the nudge. */
	async function armPendingNudge(fire: (event: string, payload: unknown) => Promise<unknown>) {
		await fire("tool_execution_start", {})
		await fire("input", { source: "user" })
		await fire("turn_end", { message: makeAssistant([{ type: "text", text: "I will delegate this." }]) })
	}

	it("a streamed token-only acknowledgement stays blanked and ends recovery without further nudges", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)
		expect(sentMessages()).toHaveLength(1)
		expect(sentMessages()[0]?.customType).toBe("nudge")

		// The done token streams split across two delta events, as real deltas do.
		const first = makeAssistant([{ type: "text", text: "<do" }])
		const firstEvent = textDeltaEvent(first, "<do")
		await fire("message_update", firstEvent)
		const second = makeAssistant([{ type: "text", text: "ne>" }])
		const secondEvent = textDeltaEvent(second, "ne>")
		await fire("message_update", secondEvent)

		// The token is a silent acknowledgement — both deltas are blanked.
		expect((first.content[0] as { text: string }).text).toBe("")
		expect((second.content[0] as { text: string }).text).toBe("")
		// The event deltas are zeroed too, so consumers that stream raw
		// deltas (e.g. ACP agent_message_chunk forwarding) never see the
		// hidden recovery response.
		expect(firstEvent.assistantMessageEvent.delta).toBe("")
		expect(secondEvent.assistantMessageEvent.delta).toBe("")

		// At turn_end the done signal ends recovery: no continuation nudge,
		// no empty-turn nudge for the blanked response.
		await fire("turn_end", { message: second })
		expect(sentMessages()).toHaveLength(1)
	})

	it("sentinel recognition alone ends recovery even when evaluation would otherwise re-nudge", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)
		expect(sentMessages()).toHaveLength(1)

		// The done token streams split across two delta events; both are
		// blanked and accumulated.
		const first = makeAssistant([{ type: "text", text: "<do" }])
		await fire("message_update", textDeltaEvent(first, "<do"))
		const second = makeAssistant([{ type: "text", text: "ne>" }])
		await fire("message_update", textDeltaEvent(second, "ne>"))

		// The turn ends with visible drift-shaped text and a non-stop reason,
		// so neither the stopReason "stop" escape nor blanked text can
		// explain recovery ending here (e.g. an extension restored the
		// response text at message_end): only the accumulated exact <done>
		// token skips the continuation evaluation. If sentinel recognition
		// regressed, evaluation would find eligible drift text and fire a
		// second nudge.
		const final = withStop([{ type: "text", text: "I will delegate this to a builder agent next." }], "length")
		await fire("turn_end", { message: final })
		expect(sentMessages()).toHaveLength(1)
	})

	it("a prose-plus-token response with stopReason stop stays hidden and ends recovery through the stop escape", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)
		expect(sentMessages()).toHaveLength(1)

		const response = makeAssistant([{ type: "text", text: "Stopping. <done>" }])
		await fire("message_update", textDeltaEvent(response, "Stopping. <done>"))
		// The prose remains hidden — the existing blanking behavior is unchanged.
		expect((response.content[0] as { text: string }).text).toBe("")

		// The accumulated text is not the exact done signal, so the existing
		// stopReason "stop" escape ends recovery instead.
		await fire("turn_end", { message: response })
		expect(sentMessages()).toHaveLength(1)
	})

	it("clears pending after recovery ends so a later response streams unblanked", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)

		const response = makeAssistant([{ type: "text", text: "I am done with this task." }])
		await fire("message_update", textDeltaEvent(response, "I am done with this task."))
		await fire("turn_end", { message: response })
		expect(sentMessages()).toHaveLength(1)

		// A later unrelated extension-triggered response (no new user input in
		// between) must retain its text during message_update — stale recovery
		// state may not blank it.
		const later = makeAssistant([{ type: "text", text: "Background agent finished." }])
		await fire("message_update", textDeltaEvent(later, "Background agent finished."))
		expect((later.content[0] as { text: string }).text).toBe("Background agent finished.")
	})

	it("an aborted recovery response leaves pending false and sends no further nudge", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)
		expect(sentMessages()).toHaveLength(1)

		await fire("turn_end", { message: withStop([], "aborted") })
		// The abort is respected — no second nudge.
		expect(sentMessages()).toHaveLength(1)

		const later = makeAssistant([{ type: "text", text: "Ferment wake-up." }])
		await fire("message_update", textDeltaEvent(later, "Ferment wake-up."))
		expect((later.content[0] as { text: string }).text).toBe("Ferment wake-up.")
	})

	it("a provider-error attempt preserves pending for the retry and sends no nudge", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)
		expect(sentMessages()).toHaveLength(1)

		// The attempt errors mid-stream: partial text was already blanked and
		// accumulated, and the real extension agent_end payload (no willRetry
		// field) fires after the attempt. turn_end must keep the recovery
		// armed — the upstream loop auto-retries inside the same agent run,
		// and the retry's response is still the answer to the armed nudge.
		const errored = makeAssistant([{ type: "text", text: "Partial answ" }])
		await fire("message_update", textDeltaEvent(errored, "Partial answ"))
		await fire("turn_end", { message: withStop([{ type: "text", text: "" }], "error") })
		await fire("agent_end", { messages: [] })
		// The error is attempt-level — no nudge re-queued for it.
		expect(sentMessages()).toHaveLength(1)

		// The retry streams the token split across deltas: still blanked...
		const first = makeAssistant([{ type: "text", text: "<do" }])
		const firstEvent = textDeltaEvent(first, "<do")
		await fire("message_update", firstEvent)
		const second = makeAssistant([{ type: "text", text: "ne>" }])
		const secondEvent = textDeltaEvent(second, "ne>")
		await fire("message_update", secondEvent)
		expect((first.content[0] as { text: string }).text).toBe("")
		expect((second.content[0] as { text: string }).text).toBe("")
		expect(firstEvent.assistantMessageEvent.delta).toBe("")
		expect(secondEvent.assistantMessageEvent.delta).toBe("")

		// ...and its done signal ends recovery without a second nudge.
		await fire("message_end", { message: second })
		await fire("turn_end", { message: second })
		expect(sentMessages()).toHaveLength(1)
	})

	it("repeat provider errors consume no nudge budget", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)
		expect(sentMessages()).toHaveLength(1)

		// Several errored attempts in a row, each with the full realistic
		// attempt sequence: partial text streams and is blanked while pending,
		// message_end marks nothing (errored attempts are never marked),
		// turn_end keeps the recovery armed, agent_end fires per attempt.
		for (let i = 0; i < 3; i++) {
			const partial = makeAssistant([{ type: "text", text: "Partial" }])
			await fire("message_update", textDeltaEvent(partial, "Partial"))
			await fire("message_end", { message: withStop([{ type: "text", text: "" }], "error") })
			await fire("turn_end", { message: withStop([], "error") })
			await fire("agent_end", { messages: [] })
		}
		expect(sentMessages()).toHaveLength(1)

		// The retry's eventual response is drift text — blanked by
		// message_update and marked withheld at message_end (applied in
		// place), so its consumed recovery does not re-nudge.
		const retry = withStop([{ type: "text", text: "I was going to say..." }], "length")
		await fire("message_update", textDeltaEvent(retry, "I was going to say..."))
		expect((retry.content[0] as { text: string }).text).toBe("")
		await fire("message_end", { message: retry })
		await fire("turn_end", { message: retry })
		expect(sentMessages()).toHaveLength(1)

		// A later visible drift turn in the same user-input cycle still has
		// the full budget minus nudge #1: the second (final) nudge fires now —
		// the errored attempts and the blanked recovery consumed no slot.
		await fire("turn_end", { message: makeAssistant([{ type: "text", text: "I will delegate this now." }]) })
		expect(sentMessages()).toHaveLength(2)
		const second = sentMessages()[1]
		expect(second?.content).toContain("you MUST call the required tool")
	})

	it("a non-retryable terminal error clears pending at settlement", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)
		expect(sentMessages()).toHaveLength(1)

		// A non-retryable failure (e.g. content_filter, invalid request): no
		// retry is scheduled, agent_end fires once, and settlement owns the
		// cleanup.
		await fire("turn_end", { message: withStop([], "error") })
		await fire("agent_end", { messages: [] })
		await fire("agent_settled", {})

		const later = makeAssistant([{ type: "text", text: "Ferment wake-up." }])
		await fire("message_update", textDeltaEvent(later, "Ferment wake-up."))
		expect((later.content[0] as { text: string }).text).toBe("Ferment wake-up.")
	})

	it("exhausted retries clear pending at settlement", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)
		expect(sentMessages()).toHaveLength(1)

		// Every retryable attempt fails until the budget is spent. Each
		// attempt-level agent_end must keep the recovery armed; only the
		// settlement after the final failure clears it.
		for (let i = 0; i < 4; i++) {
			const partial = makeAssistant([{ type: "text", text: "Partial" }])
			await fire("message_update", textDeltaEvent(partial, "Partial"))
			await fire("message_end", { message: withStop([{ type: "text", text: "" }], "error") })
			await fire("turn_end", { message: withStop([], "error") })
			await fire("agent_end", { messages: [] })
		}
		expect(sentMessages()).toHaveLength(1)

		const midRetry = makeAssistant([{ type: "text", text: "Still waiting on retries." }])
		await fire("message_update", textDeltaEvent(midRetry, "Still waiting on retries."))
		expect((midRetry.content[0] as { text: string }).text).toBe("")

		await fire("agent_settled", {})

		const later = makeAssistant([{ type: "text", text: "Ferment wake-up." }])
		await fire("message_update", textDeltaEvent(later, "Ferment wake-up."))
		expect((later.content[0] as { text: string }).text).toBe("Ferment wake-up.")
	})

	it("a retry cancelled during backoff clears pending at settlement — no aborted turn is emitted", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)
		expect(sentMessages()).toHaveLength(1)

		// The upstream retry sleep is aborted (user cancels during backoff):
		// the installed SDK emits auto_retry_end ("Retry cancelled") and
		// returns false — NO extra aborted turn, so no turn_end fires for the
		// cancelled attempt. Settlement is therefore the ONLY cleanup
		// opportunity; this test must not fabricate an aborted turn_end (that
		// would clear pending through the abort path and mask the settlement
		// behavior under test).
		await fire("turn_end", { message: withStop([], "error") })
		await fire("agent_end", { messages: [] })
		await fire("agent_settled", {})

		const later = makeAssistant([{ type: "text", text: "Ferment wake-up." }])
		await fire("message_update", textDeltaEvent(later, "Ferment wake-up."))
		expect((later.content[0] as { text: string }).text).toBe("Ferment wake-up.")
	})

	it("budget exhaustion after two nudges leaves pending false", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)
		expect(sentMessages()).toHaveLength(1)

		// First recovery response is truncated (stopReason "length") — a
		// second nudge is still eligible, and it re-arms pending.
		await fire("turn_end", { message: withStop([{ type: "text", text: "I was going to say..." }], "length") })
		expect(sentMessages()).toHaveLength(2)

		// Second recovery response is also truncated — budget exhausted, and
		// the pending state armed by the second nudge is consumed.
		await fire("turn_end", { message: withStop([{ type: "text", text: "Still going..." }], "length") })
		expect(sentMessages()).toHaveLength(2)

		const later = makeAssistant([{ type: "text", text: "Unrelated follow-up." }])
		await fire("message_update", textDeltaEvent(later, "Unrelated follow-up."))
		expect((later.content[0] as { text: string }).text).toBe("Unrelated follow-up.")
	})

	it("a suppressed recovery attempt (question in the response) leaves pending false", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)
		expect(sentMessages()).toHaveLength(1)

		// The recovery response asks a blocking question with a non-stop
		// reason: evaluation suppresses the re-nudge, and the consumed
		// pending state must not blank later turns.
		const asking = withStop([{ type: "text", text: "Should I abort the rebase? I will wait for your word." }], "length")
		await fire("turn_end", { message: asking })
		expect(sentMessages()).toHaveLength(1)

		const later = makeAssistant([{ type: "text", text: "Unrelated follow-up." }])
		await fire("message_update", textDeltaEvent(later, "Unrelated follow-up."))
		expect((later.content[0] as { text: string }).text).toBe("Unrelated follow-up.")
	})

	it("does not require a second nudge from a fully blanked recovery response", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)
		expect(sentMessages()).toHaveLength(1)

		// The streamed response was fully blanked, so no text remains for
		// evaluateTurn to inspect — recovery ends without a second nudge.
		const blanked = withStop([{ type: "text", text: "" }], "length")
		await fire("turn_end", { message: blanked })
		expect(sentMessages()).toHaveLength(1)
	})

	it("excludes an empty recovery response from the empty-turn nudge after pending is consumed", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)
		expect(sentMessages()).toHaveLength(1)

		// A new agent run resets the run-level tool latch, so only the
		// consumed pending state can exclude this empty response from
		// EmptyTurnNudge (mixed instructions during a recovery cycle).
		await fire("agent_start", {})
		await fire("turn_end", { message: withStop([], "length") })
		expect(sentMessages()).toHaveLength(1)
	})

	it("ordinary empty responses still take the empty-turn branch", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()

		await fire("agent_start", {})
		await fire("input", { source: "user" })
		await fire("turn_end", { message: makeAssistant([]) })

		const messages = sentMessages()
		expect(messages).toHaveLength(1)
		expect(messages[0]?.content).toContain("If you have finished")
	})

	it("agent_settled clears abandoned pending and accumulator state; agent_end does not", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)
		expect(sentMessages()).toHaveLength(1)

		// The recovery run is abandoned before its turn_end fires. The
		// attempt-level agent_end must NOT clear the state (a retry may still
		// be in flight); settlement owns the cleanup.
		await fire("agent_end", { messages: [] })
		const midRetry = makeAssistant([{ type: "text", text: "Still the protocol answer." }])
		await fire("message_update", textDeltaEvent(midRetry, "Still the protocol answer."))
		expect((midRetry.content[0] as { text: string }).text).toBe("")

		await fire("agent_settled", {})

		const later = makeAssistant([{ type: "text", text: "Ferment wake-up." }])
		await fire("message_update", textDeltaEvent(later, "Ferment wake-up."))
		expect((later.content[0] as { text: string }).text).toBe("Ferment wake-up.")
	})

	it("accepted pre-settlement limitation: a post-terminal-error followUp response is blanked once, then heals", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)
		expect(sentMessages()).toHaveLength(1)

		// Terminal error, then the per-attempt agent_end — the moment another
		// extension's agent_end handler queues an unrelated followUp. The
		// upstream loop sees hasQueuedMessages() and continues BEFORE
		// settlement, so the session continuation (below) runs with pending
		// still armed. ACCEPTED LIMITATION (upstream exposes no retry state
		// to extension agent_end handlers; see the agent_settled handler
		// comment): the unrelated text-only response is blanked like a
		// protocol response for this one turn. When the lifecycle fix lands,
		// tighten this assertion.
		await fire("turn_end", { message: withStop([], "error") })
		await fire("agent_end", { messages: [] })

		// The continuation streams with no intervening user input or tool
		// call: blanked at message_update, marked withheld at message_end
		// (applied in place), and its successful turn_end consumes pending
		// (respected stop → no re-nudge).
		const unrelated = withStop([{ type: "text", text: "Background agent finished." }], "stop")
		await fire("message_update", textDeltaEvent(unrelated, "Background agent finished."))
		expect((unrelated.content[0] as { text: string }).text).toBe("")
		await fire("message_end", { message: unrelated })
		await fire("turn_end", { message: unrelated })
		expect(sentMessages()).toHaveLength(1)

		// Settlement cleans up whatever the consumed turn left behind...
		await fire("agent_settled", {})

		// ...so a later unrelated response streams normally again.
		const later = makeAssistant([{ type: "text", text: "Second follow-up." }])
		await fire("message_update", textDeltaEvent(later, "Second follow-up."))
		expect((later.content[0] as { text: string }).text).toBe("Second follow-up.")
	})

	it("accepted pre-settlement limitation: a followUp response that follows text with a tool call stays blanked but clears pending", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)
		expect(sentMessages()).toHaveLength(1)

		await fire("turn_end", { message: withStop([], "error") })
		await fire("agent_end", { messages: [] })

		// The continuation's text streams first — already blanked by the
		// still-armed pending state (the accepted limitation) — and the
		// response then emits a tool call. Tools start executing only after
		// the message finishes streaming, so tool_execution_start cannot
		// rescue the current response's text; it only clears pending for
		// LATER turns.
		const continuation = withStop(
			[
				{ type: "text", text: "" },
				{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
			],
			"toolUse",
		)
		await fire("message_update", textDeltaEvent(continuation, "Background agent finished."))
		expect((continuation.content[0] as { text: string }).text).toBe("")
		// message_end does NOT mark the tool-bearing response: the guard
		// must keep counting it.
		await fire("message_end", { message: continuation })
		expect((continuation as unknown as Record<symbol, unknown>)[ASSISTANT_OUTPUT_WITHHELD]).toBeUndefined()

		// Tool execution clears pending for later turns.
		await fire("tool_execution_start", {})
		await fire("turn_end", { message: continuation })
		expect(sentMessages()).toHaveLength(1)

		// A later response with no intervening user input streams normally —
		// the tool call cleared pending, even though the continuation's own
		// text was blanked and is not restored.
		const later = makeAssistant([{ type: "text", text: "Second follow-up." }])
		await fire("message_update", textDeltaEvent(later, "Second follow-up."))
		expect((later.content[0] as { text: string }).text).toBe("Second follow-up.")
	})

	it("message_end blanks and withholds the token-only recovery acknowledgement", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)
		expect(sentMessages()).toHaveLength(1)

		const first = makeAssistant([{ type: "text", text: "<do" }])
		await fire("message_update", textDeltaEvent(first, "<do"))
		const second = makeAssistant([{ type: "text", text: "ne>" }])
		await fire("message_update", textDeltaEvent(second, "ne>"))

		// The stored message drops the text and carries the withheld marker,
		// so the guard and every later consumer see a neutral message. The
		// replacement is applied in place, so `second` — the object turn_end
		// receives — IS the replaced message.
		const result = (await fire("message_end", { message: second })) as { message: AssistantMessage }
		expect(result?.message).toBeDefined()
		expect((second as unknown as Record<symbol, unknown>)[ASSISTANT_OUTPUT_WITHHELD]).toBe(true)
		expect(second.content).toEqual([])
		expect(second.stopReason).toBe("stop")

		await fire("turn_end", { message: second })
		expect(sentMessages()).toHaveLength(1)
	})

	it("message_end marks an empty recovery response as withheld", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)
		expect(sentMessages()).toHaveLength(1)

		const empty = withStop([], "stop")
		const result = (await fire("message_end", { message: empty })) as { message: AssistantMessage }
		expect(result?.message).toBeDefined()
		expect((empty as unknown as Record<symbol, unknown>)[ASSISTANT_OUTPUT_WITHHELD]).toBe(true)
		expect(empty.content).toEqual([])

		// Respected stop — no empty-turn nudge for the blanked response.
		await fire("turn_end", { message: empty })
		expect(sentMessages()).toHaveLength(1)
	})

	it("message_end blanks and withholds a stop-respected prose recovery response", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)
		expect(sentMessages()).toHaveLength(1)

		const response = makeAssistant([{ type: "text", text: "Stopping. <done>" }])
		await fire("message_update", textDeltaEvent(response, "Stopping. <done>"))
		await fire("message_end", { message: response })
		expect((response as unknown as Record<symbol, unknown>)[ASSISTANT_OUTPUT_WITHHELD]).toBe(true)
		expect(response.content).toEqual([])

		// The stop escape ends recovery — prose is not restored.
		await fire("turn_end", { message: response })
		expect(sentMessages()).toHaveLength(1)
	})

	it("message_end folds non-streamed pending text into the accumulator before blanking", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)
		expect(sentMessages()).toHaveLength(1)

		// A provider that returns the full response without text_delta
		// events: the final message still carries the whole token.
		const whole = makeAssistant([{ type: "text", text: "<done>" }])
		await fire("message_end", { message: whole })
		expect(whole.content).toEqual([])

		// The accumulator saw the token: the done signal ends recovery.
		await fire("turn_end", { message: whole })
		expect(sentMessages()).toHaveLength(1)
	})

	it("message_end does not withhold a tool-bearing recovery response", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)
		expect(sentMessages()).toHaveLength(1)

		const withTool = makeAssistant([
			{ type: "text", text: "Delegating now." },
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
		])
		await fire("message_update", textDeltaEvent(withTool, "Delegating now."))
		const result = await fire("message_end", { message: withTool })
		expect(result).toBeUndefined()
		// Tool-bearing messages stay visible to the guard — only the text
		// was blanked by the pending message_update handler.
	})

	it("message_end does not withhold an errored attempt — the retry still owns the recovery", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await armPendingNudge(fire)
		expect(sentMessages()).toHaveLength(1)

		const errored = withStop([{ type: "text", text: "" }], "error")
		const result = await fire("message_end", { message: errored })
		expect(result).toBeUndefined()

		// The errored attempt's turn_end keeps pending armed for the retry.
		await fire("turn_end", { message: errored })
		const retry = makeAssistant([{ type: "text", text: "<done>" }])
		await fire("message_update", textDeltaEvent(retry, "<done>"))
		expect((retry.content[0] as { text: string }).text).toBe("")
	})

	it("consumes a non-pending bare done token at message_end without any nudge", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()

		// Lost bookkeeping: no nudge is armed, yet the model emits a bare
		// token (e.g. state was reset while the response was in flight).
		await fire("tool_execution_start", {})
		await fire("input", { source: "user" })
		await fire("agent_start", {})

		const bare = makeAssistant([{ type: "text", text: "<done>" }])
		const result = (await fire("message_end", { message: bare })) as { message: AssistantMessage }
		expect(result?.message).toBeDefined()
		expect((bare as unknown as Record<symbol, unknown>)[ASSISTANT_OUTPUT_WITHHELD]).toBe(true)
		expect(bare.content).toEqual([])

		// The marker is what excludes the now-empty message from the
		// empty-turn nudge (the run-level tool latch was reset above).
		await fire("turn_end", { message: bare })
		expect(sentMessages()).toHaveLength(0)
	})

	it("message_end leaves ordinary non-pending text responses untouched", async () => {
		const { fire, sentMessages } = buildCleanupHandlers()
		await fire("tool_execution_start", {})
		await fire("input", { source: "user" })

		const ordinary = makeAssistant([{ type: "text", text: "Ordinary answer. <done>" }])
		const result = await fire("message_end", { message: ordinary })
		expect(result).toBeUndefined()
		expect((ordinary.content[0] as { text: string }).text).toBe("Ordinary answer. <done>")
		expect(sentMessages()).toHaveLength(0)
	})
})

describe("exploration guard × continuation nudge integration", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
		vi.spyOn(agentWorkerContext, "isAgentWorker").mockReturnValue(false)
		vi.spyOn(startupContext, "getAvailableModels").mockReturnValue([])
		vi.spyOn(config, "loadConfig").mockReturnValue({
			apiKey: "",
			agentConfigDir: "",
		} as ReturnType<typeof config.loadConfig>)
	})

	/** Registers BOTH extensions on one shared API in production order
	 *  (src/cli.ts registers the exploration guard before prompt enrichment),
	 *  so guard turn_end handlers run before the nudge handlers — exactly the
	 *  ordering the message_end marking must compensate for. message_end
	 *  replacements are applied in place, as the SDK does. */
	function buildGuardedHandlers() {
		const shared = createExtensionApi()
		explorationGuardExtension(shared.api)
		promptEnrichmentExtension(() => [])(shared.api)
		const ctx = createContext({ model: { provider: "test", id: "test-model" } })
		const fire = async (event: string, payload: unknown) => {
			let result: unknown
			for (const handler of shared.getHandlers(event)) {
				result = await handler(payload, ctx)
			}
			if (event === "message_end") applyMessageEndReplacement(payload, result)
			return result
		}
		const sentMessages = () => shared.sendMessage.mock.calls.map(([message]) => message)
		const nudges = () => sentMessages().filter((m) => (m as { customType?: string }).customType === "nudge")
		const guardSteers = () =>
			sentMessages().filter((m) => (m as { customType?: string }).customType === "exploration-guard-steer")
		return { fire, sentMessages, nudges, guardSteers }
	}

	/** Establishes the session tool latch, a fresh user-input cycle, and a
	 *  new agent run, then returns nothing — the caller drives the turns. */
	async function primeSession(fire: (event: string, payload: unknown) => Promise<unknown>) {
		await fire("session_start", {})
		await fire("tool_execution_start", {})
		await fire("input", { source: "user" })
		await fire("agent_start", {})
	}

	it("recovery responses stay neutral to the guard while ordinary visible turns still trip it", async () => {
		const { fire, nudges, guardSteers } = buildGuardedHandlers()
		await primeSession(fire)

		// The visible drift answer counts (no-tool streak 1) and fires nudge #1.
		const drift = makeAssistant([{ type: "text", text: "I will delegate this." }])
		await fire("message_end", { message: drift })
		await fire("turn_end", { message: drift })
		expect(nudges()).toHaveLength(1)

		// Split-token recovery: marked at message_end, consumed at turn_end.
		// The in-place replacement means turn_end (and the guard, which runs
		// before the nudge handlers) sees the blanked, marked message.
		const first = makeAssistant([{ type: "text", text: "<do" }])
		await fire("message_update", textDeltaEvent(first, "<do"))
		const second = makeAssistant([{ type: "text", text: "ne>" }])
		await fire("message_update", textDeltaEvent(second, "ne>"))
		await fire("message_end", { message: second })
		await fire("turn_end", { message: second })
		expect(nudges()).toHaveLength(1)
		expect(guardSteers()).toHaveLength(0)

		// Control: two ordinary visible no-tool turns (question-shaped, so no
		// nudge fires) push the streak from 1 to 3 — the warn steer proves the
		// guard is alive and the protocol turns were genuinely neutral.
		const question1 = makeAssistant([{ type: "text", text: "Question one: proceed?" }])
		await fire("message_end", { message: question1 })
		await fire("turn_end", { message: question1 })
		const question2 = makeAssistant([{ type: "text", text: "Question two: or wait?" }])
		await fire("message_end", { message: question2 })
		await fire("turn_end", { message: question2 })
		expect(guardSteers()).toHaveLength(1)
		const steerText = (guardSteers()[0]?.content as Array<{ type: string; text: string }>)
			?.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("")
		expect(steerText).toContain("3 consecutive turns with no tool calls")
	})

	it("an empty recovery response never reaches the guard's no-tool streak", async () => {
		const { fire, nudges, guardSteers } = buildGuardedHandlers()
		await primeSession(fire)

		// Drift answer (streak 1) fires nudge #1.
		const drift = makeAssistant([{ type: "text", text: "I will delegate this." }])
		await fire("message_end", { message: drift })
		await fire("turn_end", { message: drift })
		expect(nudges()).toHaveLength(1)

		// The token-only recovery ends the first round (streak stays 1).
		const first = makeAssistant([{ type: "text", text: "<do" }])
		await fire("message_update", textDeltaEvent(first, "<do"))
		const second = makeAssistant([{ type: "text", text: "ne>" }])
		await fire("message_update", textDeltaEvent(second, "ne>"))
		await fire("message_end", { message: second })
		await fire("turn_end", { message: second })

		// A later drift turn in the same user-input cycle (streak 2) still has
		// budget left, so nudge #2 re-arms recovery — the realistic path to a
		// pending EMPTY response (the trace's step 8 shape).
		const driftAgain = makeAssistant([{ type: "text", text: "I will delegate the verification next." }])
		await fire("message_end", { message: driftAgain })
		await fire("turn_end", { message: driftAgain })
		expect(nudges()).toHaveLength(2)

		// The empty response to nudge #2: marked withheld at message_end
		// (applied in place), stop respected — neither an empty-turn nudge nor
		// a guard steer follows, and the streak stays at 2 (below the warn
		// threshold of 3, proving the empty protocol turn counted for nothing).
		const empty = withStop([], "stop")
		await fire("message_end", { message: empty })
		await fire("turn_end", { message: empty })
		expect(nudges()).toHaveLength(2)
		expect(guardSteers()).toHaveLength(0)
	})

	it("a stop-respected prose recovery response stays neutral to the guard", async () => {
		const { fire, nudges, guardSteers } = buildGuardedHandlers()
		await primeSession(fire)

		const drift = makeAssistant([{ type: "text", text: "I will delegate this." }])
		await fire("message_end", { message: drift })
		await fire("turn_end", { message: drift })
		expect(nudges()).toHaveLength(1)

		const response = makeAssistant([{ type: "text", text: "Stopping. <done>" }])
		await fire("message_update", textDeltaEvent(response, "Stopping. <done>"))
		await fire("message_end", { message: response })
		await fire("turn_end", { message: response })
		expect(nudges()).toHaveLength(1)
		expect(guardSteers()).toHaveLength(0)
	})
})

describe("debug prompts cleanup", () => {
	beforeEach(() => {
		delete process.env.KIMCHI_DEBUG_PROMPTS
		delete process.env.KIMCHI_DEBUG_SESSION
	})

	afterEach(() => {
		delete process.env.KIMCHI_DEBUG_PROMPTS
		delete process.env.KIMCHI_DEBUG_SESSION
	})

	function buildExtensionWithDebugFlag(debugPrompts: boolean) {
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
			getFlag: (name: string) => (name === "debug-prompts" ? debugPrompts : undefined),
		} as unknown as ExtensionAPI
		promptEnrichmentExtension(() => [])(pi)
		return {
			beforeAgentStart: handlers.get("before_agent_start"),
		}
	}

	it("does not re-enable debug mode on a second turn when the flag is off", async () => {
		const { beforeAgentStart } = buildExtensionWithDebugFlag(false)
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const ctx = createContext({ hasUI: false })

		// First turn: flag is off, env vars are unset.
		await beforeAgentStart({}, ctx)

		// Second turn: flag is still off. With the buggy cleanup, the first
		// turn would have left KIMCHI_DEBUG_SESSION as the string "undefined",
		// which is truthy and would re-enable debug mode here.
		await beforeAgentStart({}, ctx)

		expect(process.env.KIMCHI_DEBUG_PROMPTS).toBeUndefined()
		expect(process.env.KIMCHI_DEBUG_SESSION).toBeUndefined()
	})

	it("writes debug files and sets env vars when the flag is on", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-debug-prompts-"))
		try {
			const { beforeAgentStart } = buildExtensionWithDebugFlag(true)
			if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

			const ctx = createContext({ cwd: dir, hasUI: false })
			await beforeAgentStart({}, ctx)

			expect(process.env.KIMCHI_DEBUG_PROMPTS).toBe("1")
			expect(process.env.KIMCHI_DEBUG_SESSION).toBeDefined()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
