import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import questionnaireExtension, { formatAnswerText, normalizeQuestionType } from "./questionnaire.js"
import { clearSecrets, storeSecret } from "./secrets-store.js"

function registeredQuestionnaireTool() {
	let tool:
		| {
				execute: (
					toolCallId: string,
					params: unknown,
					signal: AbortSignal | undefined,
					onUpdate: unknown,
					ctx: unknown,
				) => Promise<{ content: { text: string }[]; details: { cancelled: boolean } }>
		  }
		| undefined
	const pi = {
		registerTool: vi.fn((registered) => {
			tool = registered as typeof tool
		}),
		on: vi.fn(),
	} as unknown as ExtensionAPI
	questionnaireExtension(pi)
	if (!tool) throw new Error("questionnaire tool was not registered")
	return tool
}

function makePi() {
	const handlers = new Map<string, unknown[]>()
	const pi = {
		registerTool: vi.fn(),
		on: vi.fn((event: string, handler: unknown) => {
			const existing = handlers.get(event) ?? []
			existing.push(handler)
			handlers.set(event, existing)
		}),
	} as unknown as ExtensionAPI & { handlers: Map<string, unknown[]> }
	pi.handlers = handlers
	return pi
}

describe("questionnaire tool_call interceptor", () => {
	beforeEach(() => clearSecrets())

	it("intercepts write tool and substitutes secrets", () => {
		storeSecret("api_key", "real123")
		const pi = makePi()
		questionnaireExtension(pi)
		const toolCallHandlers = pi.handlers.get("tool_call")
		expect(toolCallHandlers).toHaveLength(1)
		const event = {
			toolName: "write",
			input: { content: "API_KEY=${kimchi_secret:api_key}" },
		}
		const result = ((toolCallHandlers ?? [])[0] as (e: unknown) => { block: boolean })(event as never)
		expect(result).toEqual({ block: false })
		expect((event.input as { content: string }).content).toBe("API_KEY=real123")
	})

	it("intercepts edit tool and substitutes secrets in newString", () => {
		storeSecret("token", "tok456")
		const pi = makePi()
		questionnaireExtension(pi)
		const toolCallHandlers = pi.handlers.get("tool_call")
		const event = {
			toolName: "edit",
			input: { path: ".env", oldString: "x", newString: "TOKEN=${kimchi_secret:token}" },
		}
		const result = ((toolCallHandlers ?? [])[0] as (e: unknown) => { block: boolean })(event as never)
		expect(result).toEqual({ block: false })
		expect((event.input as { newString: string }).newString).toBe("TOKEN=tok456")
	})

	it("intercepts bash command and prepends env vars", () => {
		storeSecret("db_pass", "p@ssw0rd")
		const pi = makePi()
		questionnaireExtension(pi)
		const toolCallHandlers = pi.handlers.get("tool_call")
		const event = {
			toolName: "bash",
			input: { command: 'echo "DB=${kimchi_secret:db_pass}" > .env' },
		}
		const result = ((toolCallHandlers ?? [])[0] as (e: unknown) => { block: boolean })(event as never)
		expect(result).toEqual({ block: false })
		const cmd = (event.input as { command: string }).command
		// Env var assignment is prepended; placeholder replacement depends on the handler's regex
		expect(cmd).toContain("KIMCHI_SECRET_db_pass='p@ssw0rd'")
		expect(cmd).toContain("$KIMCHI_SECRET_db_pass")
		expect(cmd).not.toContain("${kimchi_secret:db_pass}")
	})

	it("ignores non-target tools", () => {
		const pi = makePi()
		questionnaireExtension(pi)
		const toolCallHandlers = pi.handlers.get("tool_call")
		const event = {
			toolName: "read",
			input: { path: "/tmp" },
		}
		const result = ((toolCallHandlers ?? [])[0] as (e: unknown) => { block: boolean })(event as never)
		expect(result).toEqual({ block: false })
		expect((event.input as { path: string }).path).toBe("/tmp")
	})
})

describe("normalizeQuestionType", () => {
	it("keeps canonical question types unchanged", () => {
		expect(normalizeQuestionType(undefined)).toBe("single")
		expect(normalizeQuestionType("single")).toBe("single")
		expect(normalizeQuestionType("multi")).toBe("multi")
		expect(normalizeQuestionType("text")).toBe("text")
		expect(normalizeQuestionType("confirm")).toBe("confirm")
		expect(normalizeQuestionType("password")).toBe("password")
	})

	it("throws on unknown strings instead of defaulting to single (no aliases)", () => {
		expect(() => normalizeQuestionType("radio")).toThrow(/Unknown question type/)
		expect(() => normalizeQuestionType("checkbox")).toThrow(/Unknown question type/)
		expect(() => normalizeQuestionType("")).toThrow(/Unknown question type/)
	})
})

describe("questionnaire confirm validation", () => {
	it("rejects confirm options", async () => {
		const tool = registeredQuestionnaireTool()
		const result = await tool.execute(
			"call-1",
			{
				questions: [
					{
						id: "ship",
						type: "confirm",
						prompt: "Ship it?",
						options: [{ id: "sure", label: "Sure" }],
					},
				],
			},
			undefined,
			undefined,
			{ hasUI: true, ui: { custom: vi.fn() } },
		)
		expect(result.details.cancelled).toBe(true)
		expect(result.content[0]?.text).toContain('type "confirm"')
		expect(result.content[0]?.text).toContain("must not have options")
	})

	it("rejects allowOther on confirm", async () => {
		const tool = registeredQuestionnaireTool()
		const result = await tool.execute(
			"call-1",
			{
				questions: [{ id: "ship", type: "confirm", prompt: "Ship it?", allowOther: true }],
			},
			undefined,
			undefined,
			{ hasUI: true, ui: { custom: vi.fn() } },
		)
		expect(result.details.cancelled).toBe(true)
		expect(result.content[0]?.text).toContain('type "confirm"')
		expect(result.content[0]?.text).toContain("must not set allowOther")
	})
})

describe("questionnaire password validation", () => {
	it("rejects password with options", async () => {
		const tool = registeredQuestionnaireTool()
		const result = await tool.execute(
			"call-1",
			{
				questions: [
					{
						id: "api_key",
						type: "password",
						prompt: "Enter secret",
						options: [{ id: "a", label: "A" }],
					},
				],
			},
			undefined,
			undefined,
			{ hasUI: true, ui: { custom: vi.fn() } },
		)
		expect(result.details.cancelled).toBe(true)
		expect(result.content[0]?.text).toContain('type "password"')
		expect(result.content[0]?.text).toContain("must not have options")
	})

	it("rejects allowOther on password", async () => {
		const tool = registeredQuestionnaireTool()
		const result = await tool.execute(
			"call-1",
			{
				questions: [{ id: "api_key", type: "password", prompt: "Enter secret", allowOther: true }],
			},
			undefined,
			undefined,
			{ hasUI: true, ui: { custom: vi.fn() } },
		)
		expect(result.details.cancelled).toBe(true)
		expect(result.content[0]?.text).toContain('type "password"')
		expect(result.content[0]?.text).toContain("must not set allowOther")
	})
})

describe("formatAnswerText", () => {
	it("masks password answers", () => {
		const questions = [
			{
				id: "api_key",
				label: "API Key",
				prompt: "Enter API key",
				type: "password" as const,
				options: [],
				allowOther: false,
				required: true,
			},
		]
		const answers = [{ id: "api_key", value: "secret123", label: "secret123", wasCustom: true }]
		expect(formatAnswerText(questions, answers)).toBe("API Key: user provided: (hidden)")
	})

	it("formats a single-select answer with index", () => {
		const questions = [
			{
				id: "scope",
				label: "Scope",
				prompt: "What scope?",
				type: "single" as const,
				options: [{ id: "auth", label: "Auth module" }],
				allowOther: false,
				required: true,
			},
		]
		const answers = [{ id: "scope", value: "auth", label: "Auth module", wasCustom: false, index: 1 }]
		expect(formatAnswerText(questions, answers)).toBe("Scope: user selected: 1. Auth module")
	})

	it("formats a custom (free-text) answer", () => {
		const questions = [
			{
				id: "scope",
				label: "Scope",
				prompt: "What scope?",
				type: "single" as const,
				options: [],
				allowOther: true,
				required: true,
			},
		]
		const answers = [{ id: "scope", value: "just the tests", label: "just the tests", wasCustom: true }]
		expect(formatAnswerText(questions, answers)).toBe("Scope: user wrote: just the tests")
	})

	it("formats a multi-select answer", () => {
		const questions = [
			{
				id: "features",
				label: "Features",
				prompt: "Which features?",
				type: "multi" as const,
				options: [
					{ id: "a", label: "Pagination" },
					{ id: "b", label: "Sorting" },
				],
				allowOther: false,
				required: true,
			},
		]
		const answers = [
			{
				id: "features",
				value: "Pagination, Sorting",
				label: "Pagination, Sorting",
				wasCustom: false,
				values: ["a", "b"],
				labels: ["Pagination", "Sorting"],
				indices: [1, 2],
			},
		]
		expect(formatAnswerText(questions, answers)).toBe("Features: user selected: 1. Pagination, 2. Sorting")
	})

	it("formats multiple answers across questions", () => {
		const questions = [
			{
				id: "scope",
				label: "Scope",
				prompt: "?",
				type: "single" as const,
				options: [{ id: "a", label: "A" }],
				allowOther: false,
				required: true,
			},
			{
				id: "priority",
				label: "Priority",
				prompt: "?",
				type: "single" as const,
				options: [{ id: "h", label: "High" }],
				allowOther: false,
				required: true,
			},
		]
		const answers = [
			{ id: "scope", value: "a", label: "A", wasCustom: false, index: 1 },
			{ id: "priority", value: "h", label: "High", wasCustom: false, index: 1 },
		]
		expect(formatAnswerText(questions, answers)).toBe("Scope: user selected: 1. A\nPriority: user selected: 1. High")
	})

	it("formats a confirm answer", () => {
		const questions = [
			{
				id: "proceed",
				label: "Confirm",
				prompt: "Proceed?",
				type: "confirm" as const,
				options: [
					{ id: "yes", label: "Yes" },
					{ id: "no", label: "No" },
				],
				allowOther: false,
				required: true,
			},
		]
		const answers = [{ id: "proceed", value: "yes", label: "Yes", wasCustom: false, index: 1 }]
		expect(formatAnswerText(questions, answers)).toBe("Confirm: user selected: 1. Yes")
	})

	it("handles an answer without index (e.g. confirm)", () => {
		const questions = [
			{
				id: "q1",
				label: "Q1",
				prompt: "?",
				type: "single" as const,
				options: [{ id: "v", label: "Val" }],
				allowOther: false,
				required: true,
			},
		]
		const answers = [{ id: "q1", value: "v", label: "Val", wasCustom: false }]
		expect(formatAnswerText(questions, answers)).toBe("Q1: user selected: Val")
	})

	it("uses answer id as fallback when question label not found", () => {
		const questions = [
			{
				id: "unknown",
				label: "X",
				prompt: "?",
				type: "single" as const,
				options: [],
				allowOther: true,
				required: true,
			},
		]
		const answers = [{ id: "missing_q", value: "v", label: "Val", wasCustom: false, index: 1 }]
		expect(formatAnswerText(questions, answers)).toBe("missing_q: user selected: 1. Val")
	})

	it("handles empty answers list", () => {
		const questions = [
			{ id: "q1", label: "Q1", prompt: "?", type: "single" as const, options: [], allowOther: true, required: true },
		]
		expect(formatAnswerText(questions, [])).toBe("")
	})

	it("formats multi-select with labels but no indices", () => {
		const questions = [
			{ id: "q1", label: "Q1", prompt: "?", type: "multi" as const, options: [], allowOther: false, required: true },
		]
		const answers = [
			{
				id: "q1",
				value: "a, b",
				label: "A, B",
				wasCustom: false,
				values: ["a", "b"],
				labels: ["A", "B"],
			},
		]
		expect(formatAnswerText(questions, answers)).toBe("Q1: user selected: A, B")
	})
})

describe("renderResult", () => {
	interface ToolWithRenderResult {
		execute: (
			toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: unknown,
		) => Promise<{ content: { text: string }[]; details: { cancelled: boolean } }>
		renderResult: (
			result: unknown,
			options: unknown,
			theme: unknown,
			context: unknown,
		) => { render: (w: number) => string[] }
	}
	const tool = registeredQuestionnaireTool() as ToolWithRenderResult

	const mockTheme = {
		fg: (color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	}

	it("masks password answers with (hidden)", () => {
		const result = {
			details: {
				questions: [
					{
						id: "api_key",
						label: "API Key",
						prompt: "Enter secret",
						type: "password" as const,
						options: [],
						allowOther: false,
						required: true,
					},
				],
				answers: [{ id: "api_key", value: "hunter2", label: "hunter2", wasCustom: true }],
				cancelled: false,
			},
		}
		const rendered = tool.renderResult(result, {}, mockTheme, {})
		const lines = rendered.render(80)
		const output = lines.join("\n")
		expect(output).toContain("(hidden)")
		expect(output).not.toContain("hunter2")
	})
})
