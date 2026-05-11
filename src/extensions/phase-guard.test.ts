import type { ExtensionAPI, InputEvent, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import * as taxonomy from "./permissions/taxonomy.js"
import phaseGuardExtension from "./phase-guard.js"
import * as tags from "./tags.js"

vi.mock("./tags.js", () => ({
	getCurrentPhase: vi.fn(),
	isValidPhase: vi.fn((p: string) => ["explore", "plan", "build", "review", "research"].includes(p)),
}))

vi.mock("./permissions/taxonomy.js", () => ({
	isReadOnlyBashCommand: vi.fn(),
}))

function textContent(text: string) {
	return { type: "text" as const, text }
}

function createMockApi() {
	const appendEntryData: { type: string; data: unknown }[] = []
	const handlers = new Map<string, ((ev: unknown, ...args: unknown[]) => unknown)[]>()

	const pi: ExtensionAPI = {
		on: vi.fn((event, handler) => {
			if (!handlers.has(event)) handlers.set(event, [])
			handlers.get(event)?.push(handler as (ev: unknown, ...args: unknown[]) => unknown)
		}),
		appendEntry: vi.fn((type: string, data?: unknown) => {
			appendEntryData.push({ type, data })
		}),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		getFlag: vi.fn(),
		registerMessageRenderer: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		setSessionName: vi.fn(),
		getSessionName: vi.fn(),
		setLabel: vi.fn(),
		exec: vi.fn(),
		getActiveTools: vi.fn(),
		getAllTools: vi.fn(),
		setActiveTools: vi.fn(),
		getCommands: vi.fn(),
		setModel: vi.fn(),
		getThinkingLevel: vi.fn(),
		setThinkingLevel: vi.fn(),
		registerProvider: vi.fn(),
		replaceTool: vi.fn(),
		deleteTool: vi.fn(),
		hasTool: vi.fn(),
		registerMode: vi.fn(),
		replaceMode: vi.fn(),
		getModes: vi.fn(),
		getMode: vi.fn(),
		setMode: vi.fn(),
		urnOff: vi.fn(),
		copyUrl: vi.fn(),
		performAction: vi.fn(),
		triggerHighlight: vi.fn(),
		saveConfig: vi.fn(),
		getExtensionDir: vi.fn(),
		getWorkingDir: vi.fn(),
		getSessionFile: vi.fn(),
		getExtensionConfig: vi.fn(),
		getExtensionCustomInstructions: vi.fn(),
		getSession: vi.fn(),
		env: {} as Record<string, string>,
		setModeList: vi.fn(),
		getConversationChoices: vi.fn(),
		addTag: vi.fn(),
		removeTag: vi.fn(),
		registerGlobalShortcut: vi.fn(),
		getVersion: vi.fn(),
		getContextLengthLimit: vi.fn(),
		addQueuedTasks: vi.fn(),
		clearQueuedTasks: vi.fn(),
		getQueuedTasks: vi.fn(),
		deleteQueuedTask: vi.fn(),
		registerEntryRenderer: vi.fn(),
		getUI: vi.fn(),
	} as unknown as ExtensionAPI

	return { pi, handlers, appendEntryData }
}

function emitToolCall(
	handlers: ReturnType<typeof createMockApi>["handlers"],
	event: ToolCallEvent,
): { block?: boolean; reason?: string } | undefined {
	const toolCallHandlers = handlers.get("tool_call") ?? []
	for (const h of toolCallHandlers) {
		const r = h(event)
		const cast = r as { block?: boolean; reason?: string } | undefined
		if (r && cast?.block) return cast
	}
	return undefined
}

function emitToolResult(handlers: ReturnType<typeof createMockApi>["handlers"], event: ToolResultEvent): void {
	const toolResultHandlers = handlers.get("tool_result") ?? []
	for (const h of toolResultHandlers) {
		h(event)
	}
}

function emitInput(
	handlers: ReturnType<typeof createMockApi>["handlers"],
	event: { source: InputEvent["source"] },
): void {
	const inputHandlers = handlers.get("input") ?? []
	for (const h of inputHandlers) {
		h(event)
	}
}

describe("phase-guard extension", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("allows subagent in build phase", () => {
		const { pi, handlers } = createMockApi()
		vi.mocked(tags.getCurrentPhase).mockReturnValue("build")
		phaseGuardExtension(pi)
		const result = emitToolCall(handlers, {
			type: "tool_call",
			toolCallId: "tc-1",
			toolName: "subagent",
			input: { provider: "x", model: "y", prompt: "p" },
		})
		expect(result).toBeUndefined()
	})

	it("allows set_phase in build phase", () => {
		const { pi, handlers } = createMockApi()
		vi.mocked(tags.getCurrentPhase).mockReturnValue("build")
		phaseGuardExtension(pi)
		const result = emitToolCall(handlers, {
			type: "tool_call",
			toolCallId: "tc-1",
			toolName: "set_phase",
			input: { phase: "review" },
		})
		expect(result).toBeUndefined()
	})

	it("blocks edit in build phase", () => {
		const { pi, handlers, appendEntryData } = createMockApi()
		vi.mocked(tags.getCurrentPhase).mockReturnValue("build")
		vi.mocked(taxonomy.isReadOnlyBashCommand).mockReturnValue(false)
		phaseGuardExtension(pi)
		const result = emitToolCall(handlers, {
			type: "tool_call",
			toolCallId: "tc-1",
			toolName: "edit",
			input: { path: "f.ts", oldString: "a", newText: "b" },
		})
		expect(result).toEqual(expect.objectContaining({ block: true }))
		expect(result?.reason).toContain("blocked")
		expect(appendEntryData).toHaveLength(1)
		expect(appendEntryData[0].type).toBe("phase-guard-violation")
		expect(appendEntryData[0].data).toMatchObject({ toolName: "edit", phase: "build" })
	})

	it("blocks write in build phase", () => {
		const { pi, handlers, appendEntryData } = createMockApi()
		vi.mocked(tags.getCurrentPhase).mockReturnValue("build")
		vi.mocked(taxonomy.isReadOnlyBashCommand).mockReturnValue(false)
		phaseGuardExtension(pi)
		const result = emitToolCall(handlers, {
			type: "tool_call",
			toolCallId: "tc-1",
			toolName: "write",
			input: { path: "f.ts", content: "x" },
		})
		expect(result).toEqual(expect.objectContaining({ block: true }))
		expect(appendEntryData[0].data).toMatchObject({ toolName: "write", phase: "build" })
	})

	it("allows read in build phase", () => {
		const { pi, handlers } = createMockApi()
		vi.mocked(tags.getCurrentPhase).mockReturnValue("build")
		phaseGuardExtension(pi)
		const result = emitToolCall(handlers, {
			type: "tool_call",
			toolCallId: "tc-1",
			toolName: "read",
			input: { path: "f.ts" },
		})
		expect(result).toBeUndefined()
	})

	it("allows grep in build phase", () => {
		const { pi, handlers } = createMockApi()
		vi.mocked(tags.getCurrentPhase).mockReturnValue("build")
		phaseGuardExtension(pi)
		const result = emitToolCall(handlers, {
			type: "tool_call",
			toolCallId: "tc-1",
			toolName: "grep",
			input: { pattern: "x" },
		})
		expect(result).toBeUndefined()
	})

	it("allows read-only bash in build phase", () => {
		const { pi, handlers } = createMockApi()
		vi.mocked(tags.getCurrentPhase).mockReturnValue("build")
		vi.mocked(taxonomy.isReadOnlyBashCommand).mockReturnValue(true)
		phaseGuardExtension(pi)
		const result = emitToolCall(handlers, {
			type: "tool_call",
			toolCallId: "tc-1",
			toolName: "bash",
			input: { command: "cat f.ts" },
		})
		expect(result).toBeUndefined()
	})

	it("blocks destructive bash in build phase", () => {
		const { pi, handlers, appendEntryData } = createMockApi()
		vi.mocked(tags.getCurrentPhase).mockReturnValue("build")
		vi.mocked(taxonomy.isReadOnlyBashCommand).mockReturnValue(false)
		phaseGuardExtension(pi)
		const result = emitToolCall(handlers, {
			type: "tool_call",
			toolCallId: "tc-1",
			toolName: "bash",
			input: { command: "rm -rf out" },
		})
		expect(result).toEqual(expect.objectContaining({ block: true }))
		expect(appendEntryData[0].type).toBe("phase-guard-violation")
	})

	it("allows write in explore phase", () => {
		const { pi, handlers } = createMockApi()
		vi.mocked(tags.getCurrentPhase).mockReturnValue("explore")
		phaseGuardExtension(pi)
		const result = emitToolCall(handlers, {
			type: "tool_call",
			toolCallId: "tc-1",
			toolName: "write",
			input: { path: "f.ts", content: "x" },
		})
		expect(result).toBeUndefined()
	})

	it("allows write in plan phase", () => {
		const { pi, handlers } = createMockApi()
		vi.mocked(tags.getCurrentPhase).mockReturnValue("plan")
		phaseGuardExtension(pi)
		const result = emitToolCall(handlers, {
			type: "tool_call",
			toolCallId: "tc-1",
			toolName: "edit",
			input: { path: "f.ts", oldString: "a", newText: "b" },
		})
		expect(result).toBeUndefined()
	})

	it("allows write in review phase", () => {
		const { pi, handlers } = createMockApi()
		vi.mocked(tags.getCurrentPhase).mockReturnValue("review")
		phaseGuardExtension(pi)
		const result = emitToolCall(handlers, {
			type: "tool_call",
			toolCallId: "tc-1",
			toolName: "edit",
			input: { path: "f.ts", oldString: "a", newText: "b" },
		})
		expect(result).toBeUndefined()
	})

	it("allows write in research phase", () => {
		const { pi, handlers } = createMockApi()
		vi.mocked(tags.getCurrentPhase).mockReturnValue("research")
		phaseGuardExtension(pi)
		const result = emitToolCall(handlers, {
			type: "tool_call",
			toolCallId: "tc-1",
			toolName: "write",
			input: { path: "f.ts", content: "x" },
		})
		expect(result).toBeUndefined()
	})

	it("blocks unknown custom tools in build phase", () => {
		const { pi, handlers, appendEntryData } = createMockApi()
		vi.mocked(tags.getCurrentPhase).mockReturnValue("build")
		phaseGuardExtension(pi)
		const result = emitToolCall(handlers, {
			type: "tool_call",
			toolCallId: "tc-1",
			toolName: "mcp_do_some_write",
			input: { action: "deploy" },
		})
		expect(result).toEqual(expect.objectContaining({ block: true }))
		expect(appendEntryData[0].type).toBe("phase-guard-violation")
	})

	it("enriches block reason after subagent failure", () => {
		const { pi, handlers, appendEntryData } = createMockApi()
		vi.mocked(tags.getCurrentPhase).mockReturnValue("build")
		vi.mocked(taxonomy.isReadOnlyBashCommand).mockReturnValue(false)

		phaseGuardExtension(pi)

		// Simulate subagent failure
		emitToolResult(handlers, {
			type: "tool_result",
			toolCallId: "sa-1",
			toolName: "subagent",
			input: {},
			content: [textContent(JSON.stringify({ reason: "token_budget_exceeded" }))],
			isError: true,
			details: {},
		})

		// Try a write after the failure
		const result = emitToolCall(handlers, {
			type: "tool_call",
			toolCallId: "tc-2",
			toolName: "edit",
			input: { path: "f.ts", oldString: "a", newText: "b" },
		})

		expect(result).toEqual(expect.objectContaining({ block: true }))
		expect(result?.reason).toContain("Do NOT attempt to implement or complete this work yourself")
		expect(result?.reason).toContain("Spawn a replacement subagent")
		expect(appendEntryData).toHaveLength(2)
		expect(appendEntryData[0].type).toBe("phase-guard-subagent-failure")
		expect(appendEntryData[1].data).toMatchObject({ postSubagentFailure: true })
	})

	it("logs phase-guard-subagent-failure only once per failure window", () => {
		const { pi, handlers, appendEntryData } = createMockApi()
		vi.mocked(tags.getCurrentPhase).mockReturnValue("build")
		phaseGuardExtension(pi)

		emitToolResult(handlers, {
			type: "tool_result",
			toolCallId: "sa-1",
			toolName: "subagent",
			input: {},
			content: [textContent('{"reason":"timeout"}')],
			isError: true,
			details: {},
		})
		emitToolResult(handlers, {
			type: "tool_result",
			toolCallId: "sa-2",
			toolName: "subagent",
			input: {},
			content: [textContent('{"reason":"timeout"}')],
			isError: true,
			details: {},
		})

		const failures = appendEntryData.filter((e) => e.type === "phase-guard-subagent-failure")
		expect(failures).toHaveLength(1)
		expect(failures[0].data).toMatchObject({ reason: "timeout" })
	})

	it("resets subagent failure state on new user input", () => {
		const { pi, handlers } = createMockApi()
		vi.mocked(tags.getCurrentPhase).mockReturnValue("build")
		vi.mocked(taxonomy.isReadOnlyBashCommand).mockReturnValue(false)

		phaseGuardExtension(pi)

		// Simulate subagent failure
		emitToolResult(handlers, {
			type: "tool_result",
			toolCallId: "sa-1",
			toolName: "subagent",
			input: {},
			content: [textContent('{"reason":"timeout"}')],
			isError: true,
			details: {},
		})

		// New user input arrives
		emitInput(handlers, { source: "interactive" })

		// Try a write
		const result = emitToolCall(handlers, {
			type: "tool_call",
			toolCallId: "tc-2",
			toolName: "edit",
			input: { path: "f.ts", oldString: "a", newText: "b" },
		})

		// Should NOT contain the post-failure enrichment
		expect(result).toEqual(expect.objectContaining({ block: true }))
		expect(result?.reason).not.toContain("Do NOT attempt to implement or complete this work yourself")
	})

	it("does not reset subagent failure state on extension-sourced input", () => {
		const { pi, handlers } = createMockApi()
		vi.mocked(tags.getCurrentPhase).mockReturnValue("build")
		vi.mocked(taxonomy.isReadOnlyBashCommand).mockReturnValue(false)

		phaseGuardExtension(pi)

		emitToolResult(handlers, {
			type: "tool_result",
			toolCallId: "sa-1",
			toolName: "subagent",
			input: {},
			content: [textContent('{"reason":"timeout"}')],
			isError: true,
			details: {},
		})

		emitInput(handlers, { source: "extension" })

		const result = emitToolCall(handlers, {
			type: "tool_call",
			toolCallId: "tc-2",
			toolName: "edit",
			input: { path: "f.ts", oldString: "a", newText: "b" },
		})

		expect(result?.reason).toContain("Do NOT attempt to implement or complete this work yourself")
	})

	it("extracts failure reason from JSON content", () => {
		const { pi, handlers, appendEntryData } = createMockApi()
		vi.mocked(tags.getCurrentPhase).mockReturnValue("build")
		phaseGuardExtension(pi)

		emitToolResult(handlers, {
			type: "tool_result",
			toolCallId: "sa-1",
			toolName: "subagent",
			input: {},
			content: [textContent(JSON.stringify({ reason: "output_stalled" }))],
			isError: true,
			details: {},
		})

		expect(appendEntryData[0].data).toMatchObject({ reason: "output_stalled" })
	})

	it("extracts failure reason from heuristic in plain text", () => {
		const { pi, handlers, appendEntryData } = createMockApi()
		vi.mocked(tags.getCurrentPhase).mockReturnValue("build")
		phaseGuardExtension(pi)

		emitToolResult(handlers, {
			type: "tool_result",
			toolCallId: "sa-1",
			toolName: "subagent",
			input: {},
			content: [textContent("subagent died with token_budget_exceeded")],
			isError: true,
			details: {},
		})

		expect(appendEntryData[0].data).toMatchObject({ reason: "token_budget_exceeded" })
	})
})
