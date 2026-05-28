import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ModelMetadata } from "../../models.js"
import * as startupContext from "../../startup-context.js"
import * as agentWorkerContext from "../agent-worker-context.js"
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
