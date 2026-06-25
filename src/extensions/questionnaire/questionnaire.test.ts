import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import questionnaireExtension, { formatAnswerText, normalizeQuestionType } from "./questionnaire.js"

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
		getActiveTools: vi.fn(() => []),
		setActiveTools: vi.fn(),
	} as unknown as ExtensionAPI
	questionnaireExtension(pi)
	if (!tool) throw new Error("questionnaire tool was not registered")
	return tool
}

describe("normalizeQuestionType", () => {
	it("keeps canonical question types unchanged", () => {
		expect(normalizeQuestionType(undefined)).toBe("single")
		expect(normalizeQuestionType("single")).toBe("single")
		expect(normalizeQuestionType("multi")).toBe("multi")
		expect(normalizeQuestionType("text")).toBe("text")
		expect(normalizeQuestionType("confirm")).toBe("confirm")
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

describe("formatAnswerText", () => {
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

describe("questionnaire environment behavior", () => {
	interface FakePi {
		registerTool: ReturnType<typeof vi.fn>
		on: ReturnType<typeof vi.fn>
		getActiveTools: ReturnType<typeof vi.fn>
		setActiveTools: ReturnType<typeof vi.fn>
		// Captures the registered session_start handler so tests can fire it.
		_sessionStart: ((event: unknown, ctx: { hasUI: boolean }) => void) | null
	}

	function makePi(activeTools: string[] = ["questionnaire"]): FakePi {
		const pi: FakePi = {
			registerTool: vi.fn(),
			on: vi.fn(),
			getActiveTools: vi.fn(() => activeTools),
			setActiveTools: vi.fn(),
			_sessionStart: null,
		}
		pi.on.mockImplementation((event: string, handler: (e: unknown, ctx: { hasUI: boolean }) => void) => {
			if (event === "session_start") pi._sessionStart = handler
		})
		return pi
	}

	function makeCtx(mode: "tui" | "rpc" | "json" | "print" | undefined) {
		const ui = {
			input: vi.fn(async () => "user typed"),
			confirm: vi.fn(async () => true),
			select: vi.fn(async () => undefined),
			custom: vi.fn(async () => ({
				questions: [],
				answers: [
					{
						id: "name",
						value: "from custom",
						label: "from custom",
						wasCustom: true,
					},
				],
				cancelled: false,
			})),
		}
		const ctx = { hasUI: true, ui }
		if (mode !== undefined) (ctx as { mode?: string }).mode = mode
		return { ctx, ui }
	}

	it("disables the tool from the active set when session_start fires with no UI", () => {
		const pi = makePi(["questionnaire", "read", "bash"])
		questionnaireExtension(pi as unknown as ExtensionAPI)
		expect(pi._sessionStart).toBeTypeOf("function")

		pi._sessionStart?.({}, { hasUI: false })

		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash"])
	})

	it("leaves the tool enabled when session_start fires with a UI attached", () => {
		const pi = makePi(["questionnaire", "read", "bash"])
		questionnaireExtension(pi as unknown as ExtensionAPI)
		pi._sessionStart?.({}, { hasUI: true })
		// disable/flip hasUI=false path calls setActiveTools; enable path doesn't,
		// because the tool is already in the active set.
		const writes = pi.setActiveTools.mock.calls
		expect(writes).toEqual([])
	})

	it("execute returns a 'do not retry' steer when no UI is attached (defense-in-depth)", async () => {
		const pi = makePi(["questionnaire"])
		questionnaireExtension(pi as unknown as ExtensionAPI)
		const tool = pi.registerTool.mock.calls[0]?.[0] as {
			execute: (
				toolCallId: string,
				params: unknown,
				signal: AbortSignal | undefined,
				onUpdate: unknown,
				ctx: unknown,
			) => Promise<{ content: { text: string }[]; details: { cancelled: boolean } }>
		}

		const result = await tool.execute(
			"call-1",
			{ questions: [{ id: "ship", prompt: "Ship it?" }] },
			undefined,
			undefined,
			{ hasUI: false, ui: { custom: vi.fn() } },
		)

		expect(result.details.cancelled).toBe(true)
		const text = result.content[0]?.text ?? ""
		expect(text).toContain("questionnaire is unavailable")
		expect(text).toContain("Do NOT call questionnaire again")
	})

	// ─── Execute-path routing (ctx.mode) ───────────────────────────────────────
	//
	// The `questionnaire` tool splits into two code paths depending on `ctx.mode`:
	//   - tui    → ctx.ui.custom(...) with the full question form (tested via the TUI suite)
	//   - other  → promptQuestionnaireFallback(ctx.ui, questions) (RPC, json, print modes)
	//
	// These tests confirm the dispatch in `questionnaire.ts` actually invokes the
	// fallback path in non-tui modes, and the custom-form path in tui mode.
	// The fallback behaviour itself (text, confirm, multi, single) is
	// covered exhaustively in `questionnaire-fallback.test.ts`.

	it("routes non-tui modes through promptQuestionnaireFallback (ui.input, not ui.custom)", async () => {
		const tool = registeredQuestionnaireTool()
		const { ctx, ui } = makeCtx("rpc")
		const result = await tool.execute(
			"call-1",
			{
				questions: [
					{
						id: "name",
						type: "text",
						label: "Name",
						prompt: "What is your name?",
					},
				],
			},
			undefined,
			undefined,
			ctx,
		)
		// Fallback path: a single text question resolves via ui.input, never ui.custom.
		expect(ui.input).toHaveBeenCalledWith("What is your name?")
		expect(ui.custom).not.toHaveBeenCalled()
		expect(result.details.cancelled).toBe(false)
		expect(result.content[0]?.text).toContain("Name")
		expect(result.content[0]?.text).toContain("user wrote")
	})

	it("routes non-tui mode 'json' through the fallback as well", async () => {
		const tool = registeredQuestionnaireTool()
		const { ctx, ui } = makeCtx("json")
		await tool.execute(
			"call-1",
			{
				questions: [
					{
						id: "ship",
						type: "confirm",
						label: "Ship",
						prompt: "Ship it?",
					},
				],
			},
			undefined,
			undefined,
			ctx,
		)
		expect(ui.confirm).toHaveBeenCalled()
		expect(ui.custom).not.toHaveBeenCalled()
	})

	it("routes mode 'tui' through ctx.ui.custom (not the fallback)", async () => {
		const tool = registeredQuestionnaireTool()
		const { ctx, ui } = makeCtx("tui")
		const result = await tool.execute(
			"call-1",
			{
				questions: [{ id: "name", type: "text", prompt: "What is your name?" }],
			},
			undefined,
			undefined,
			ctx,
		)
		expect(ui.custom).toHaveBeenCalled()
		// TUI form handles its own input via editor — the fallback's ui.input must NOT be called.
		expect(ui.input).not.toHaveBeenCalled()
		expect(result.details.cancelled).toBe(false)
	})
})
