import { Key, matchesKey } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isBareExitAlias } from "./exit-utils.js"
import uiExtension, { findNextCompatibleModel } from "./ui.js"

// Helper to create a minimal Model mock
function makeModel(id: string, contextWindow: number, input: string[] = ["text", "image"]) {
	return { id, provider: "test", name: id, contextWindow, input } as import("@earendil-works/pi-ai").Model<
		import("@earendil-works/pi-ai").Api
	>
}

describe("isBareExitAlias", () => {
	it("returns true for exact 'exit' input", () => {
		expect(isBareExitAlias("exit")).toBe(true)
	})

	it("returns true for 'exit' with leading/trailing whitespace", () => {
		expect(isBareExitAlias("  exit  ")).toBe(true)
		expect(isBareExitAlias("\texit\n")).toBe(true)
		expect(isBareExitAlias("  exit")).toBe(true)
		expect(isBareExitAlias("exit  ")).toBe(true)
	})

	it("returns false for '/exit' command", () => {
		expect(isBareExitAlias("/exit")).toBe(false)
	})

	it("returns false for 'EXIT' (case sensitive)", () => {
		expect(isBareExitAlias("EXIT")).toBe(false)
		expect(isBareExitAlias("Exit")).toBe(false)
	})

	it("returns false for empty input", () => {
		expect(isBareExitAlias("")).toBe(false)
		expect(isBareExitAlias("   ")).toBe(false)
	})

	it("returns false for other text", () => {
		expect(isBareExitAlias("hello")).toBe(false)
		expect(isBareExitAlias("exit now")).toBe(false)
		expect(isBareExitAlias("please exit")).toBe(false)
		expect(isBareExitAlias("quit")).toBe(false)
	})
})

describe("Ctrl+C abort key matching", () => {
	it("matchesKey recognizes Ctrl+C raw byte (\\x03)", () => {
		expect(matchesKey("\x03", Key.ctrl("c"))).toBe(true)
	})

	it("does not match other keys as Ctrl+C", () => {
		expect(matchesKey("\x1b", Key.ctrl("c"))).toBe(false) // Escape
		expect(matchesKey("\r", Key.ctrl("c"))).toBe(false) // Enter
		expect(matchesKey("c", Key.ctrl("c"))).toBe(false) // plain c
	})

	it("matchesKey recognizes Escape separately from Ctrl+C", () => {
		expect(matchesKey("\x1b", Key.escape)).toBe(true)
		expect(matchesKey("\x03", Key.escape)).toBe(false)
	})
})

describe("findNextCompatibleModel", () => {
	it("returns the next model when current is compatible", () => {
		const models = [makeModel("a", 100_000), makeModel("b", 100_000), makeModel("c", 100_000)]
		const result = findNextCompatibleModel(models, 0, 50_000, false)
		expect(result.model).toBe(models[1])
		expect(result.skipped).toHaveLength(0)
	})

	it("wraps around to the start of the list", () => {
		const models = [makeModel("a", 100_000), makeModel("b", 100_000)]
		const result = findNextCompatibleModel(models, 1, 50_000, false)
		expect(result.model).toBe(models[0])
	})

	it("skips models with insufficient context window and records reason", () => {
		const models = [makeModel("current", 100_000), makeModel("small", 10_000), makeModel("big", 100_000)]
		// currentIndex = 0, currentTokens = 50_000 — "small" at offset 1 doesn't fit, "big" at offset 2 does
		const result = findNextCompatibleModel(models, 0, 50_000, false)
		expect(result.model).toBe(models[2])
		expect(result.skipped).toHaveLength(1)
		expect(result.skipped[0].model).toBe(models[1])
		expect(result.skipped[0].reason).toContain("10K context")
		expect(result.skipped[0].reason).toContain("50K tokens")
	})

	it("skips non-vision models when hasImages is true and records reason", () => {
		const models = [
			makeModel("current-vision", 100_000, ["text", "image"]),
			makeModel("text-only", 100_000, ["text"]),
			makeModel("other-vision", 100_000, ["text", "image"]),
		]
		const result = findNextCompatibleModel(models, 0, 50_000, true, models[0])
		expect(result.model).toBe(models[2])
		expect(result.skipped).toHaveLength(1)
		expect(result.skipped[0].model).toBe(models[1])
		expect(result.skipped[0].reason).toContain("no vision support")
	})

	it("returns the first non-vision model when hasImages is false", () => {
		const models = [makeModel("vision", 100_000, ["text", "image"]), makeModel("text-only", 100_000, ["text"])]
		const result = findNextCompatibleModel(models, 0, 50_000, false)
		expect(result.model).toBe(models[1])
		expect(result.skipped).toHaveLength(0)
	})

	it("skips both context-window-incompatible AND non-vision models", () => {
		const models = [
			makeModel("current", 100_000, ["text", "image"]),
			makeModel("small-text", 10_000, ["text"]),
			makeModel("no-vision", 100_000, ["text"]),
			makeModel("big-vision", 100_000, ["text", "image"]),
		]
		// currentTokens=50_000 → "small-text" fails context check, "no-vision" fails vision check
		const result = findNextCompatibleModel(models, 0, 50_000, true, models[0])
		expect(result.model).toBe(models[3])
		expect(result.skipped).toHaveLength(2)
	})

	it("returns undefined model when no compatible candidate exists (all skipped)", () => {
		const models = [
			makeModel("current", 100_000, ["text", "image"]),
			makeModel("small", 10_000),
			makeModel("text-only", 100_000, ["text"]),
		]
		// 50k tokens exceeds "small"; hasImages=true blocks "text-only"
		const result = findNextCompatibleModel(models, 0, 50_000, true, models[0])
		expect(result.model).toBeUndefined()
		expect(result.skipped).toHaveLength(2)
		expect(result.skipped[0].reason).toContain("context")
		expect(result.skipped[1].reason).toContain("vision")
	})

	it("allows switching to non-vision models when current model also lacks vision", () => {
		const noVision = makeModel("current-no-vision", 100_000, ["text"])
		const models = [noVision, makeModel("text-only-a", 100_000, ["text"]), makeModel("text-only-b", 100_000, ["text"])]
		const result = findNextCompatibleModel(models, 0, 50_000, true, noVision)
		expect(result.model).toBe(models[1])
		expect(result.skipped).toHaveLength(0)
	})

	it("blocks non-vision models when current model has vision and images are present", () => {
		const visionModel = makeModel("current-vision", 100_000, ["text", "image"])
		const models = [
			visionModel,
			makeModel("text-only", 100_000, ["text"]),
			makeModel("other-vision", 100_000, ["text", "image"]),
		]
		const result = findNextCompatibleModel(models, 0, 50_000, true, visionModel)
		expect(result.model).toBe(models[2])
		expect(result.skipped).toHaveLength(1)
		expect(result.skipped[0].model).toBe(models[1])
		expect(result.skipped[0].reason).toContain("no vision support")
	})

	it("returns empty skipped array for an empty list", () => {
		const result = findNextCompatibleModel([], 0, null, false)
		expect(result.model).toBeUndefined()
		expect(result.skipped).toHaveLength(0)
	})

	it("works when currentIndex is at the last model (wraps to first)", () => {
		const models = [makeModel("a", 100_000), makeModel("b", 100_000)]
		const result = findNextCompatibleModel(models, 1, null, false)
		expect(result.model).toBe(models[0])
	})

	it("never returns the model at currentIndex (always skips self)", () => {
		const models = [makeModel("only", 100_000)]
		const result = findNextCompatibleModel(models, 0, null, false)
		expect(result.model).toBeUndefined()
	})

	it("skips currentIndex even when it is the only compatible model", () => {
		// Two models: one at currentIndex (compatible) and one incompatible.
		// findNextCompatibleModel should return undefined because the only
		// compatible candidate is at currentIndex itself.
		const models = [makeModel("current", 100_000), makeModel("small", 10_000)]
		const result = findNextCompatibleModel(models, 0, 50_000, false)
		expect(result.model).toBeUndefined()
		expect(result.skipped).toHaveLength(1)
	})
})

type FakeHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown

function makeFakePi() {
	const handlers: Record<string, FakeHandler[]> = {}
	return {
		handlers,
		on: vi.fn((event: string, handler: FakeHandler) => {
			handlers[event] ??= []
			handlers[event].push(handler)
		}),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		registerFlag: vi.fn(),
		getFlag: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
	}
}

interface FakeUi {
	setWorkingVisible: ReturnType<typeof vi.fn>
	setWorkingIndicator: ReturnType<typeof vi.fn>
	setWorkingMessage: ReturnType<typeof vi.fn>
	setStatus: ReturnType<typeof vi.fn>
	setHeader: ReturnType<typeof vi.fn>
	setFooter: ReturnType<typeof vi.fn>
	setWidget: ReturnType<typeof vi.fn>
	setEditorComponent: ReturnType<typeof vi.fn>
	getEditorComponent: ReturnType<typeof vi.fn>
	addAutocompleteProvider: ReturnType<typeof vi.fn>
	setTheme: ReturnType<typeof vi.fn>
	getTheme: ReturnType<typeof vi.fn>
	getAllThemes: ReturnType<typeof vi.fn>
	theme: { fg: ReturnType<typeof vi.fn>; getFgAnsi: ReturnType<typeof vi.fn> }
	select: ReturnType<typeof vi.fn>
	confirm: ReturnType<typeof vi.fn>
	input: ReturnType<typeof vi.fn>
	editor: ReturnType<typeof vi.fn>
	custom: ReturnType<typeof vi.fn>
	notify: ReturnType<typeof vi.fn>
	showError: ReturnType<typeof vi.fn>
	onTerminalInput: ReturnType<typeof vi.fn>
	setTitle: ReturnType<typeof vi.fn>
	pasteToEditor: ReturnType<typeof vi.fn>
	setEditorText: ReturnType<typeof vi.fn>
	getEditorText: ReturnType<typeof vi.fn>
}

function makeFakeUi(): FakeUi {
	const theme = {
		fg: vi.fn((_name: string, s: string) => s),
		getFgAnsi: vi.fn(() => ""),
	}
	return {
		setWorkingVisible: vi.fn(),
		setWorkingIndicator: vi.fn(),
		setWorkingMessage: vi.fn(),
		setStatus: vi.fn(),
		setHeader: vi.fn(),
		setFooter: vi.fn(),
		setWidget: vi.fn(),
		setEditorComponent: vi.fn(),
		getEditorComponent: vi.fn(() => undefined),
		addAutocompleteProvider: vi.fn(),
		setTheme: vi.fn(),
		getTheme: vi.fn(),
		getAllThemes: vi.fn(() => []),
		theme,
		select: vi.fn(async () => undefined),
		confirm: vi.fn(async () => false),
		input: vi.fn(async () => undefined),
		editor: vi.fn(async () => undefined),
		custom: vi.fn(async () => undefined),
		notify: vi.fn(),
		showError: vi.fn(),
		onTerminalInput: vi.fn(() => () => {}),
		setTitle: vi.fn(),
		pasteToEditor: vi.fn(),
		setEditorText: vi.fn(),
		getEditorText: vi.fn(() => ""),
	}
}

function makeFakeCtx() {
	return {
		hasUI: true,
		ui: makeFakeUi(),
		cwd: "/tmp",
		model: { id: "test-model", provider: "test-provider" },
	}
}

function fire<T = unknown>(pi: ReturnType<typeof makeFakePi>, event: string, payload: T, ctx: unknown) {
	const handlers = pi.handlers[event]
	if (!handlers || handlers.length === 0) {
		throw new Error(`No handler registered for event "${event}"`)
	}
	return handlers[0](payload, ctx)
}

describe("uiExtension spinner state machine", () => {
	let pi: ReturnType<typeof makeFakePi>
	let ctx: ReturnType<typeof makeFakeCtx>

	beforeEach(() => {
		pi = makeFakePi()
		ctx = makeFakeCtx()
		uiExtension(pi as never)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe("turn_start → agent_end lifecycle", () => {
		it("shows the spinner on turn_start", async () => {
			await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0 }, ctx)
			expect(ctx.ui.setWorkingVisible).toHaveBeenCalledWith(true)
		})

		it("hides the spinner on agent_end", async () => {
			await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0 }, ctx)
			ctx.ui.setWorkingVisible.mockClear()

			await fire(pi, "agent_end", { type: "agent_end", messages: [] }, ctx)
			expect(ctx.ui.setWorkingVisible).toHaveBeenCalledWith(false)
		})

		it("turn_start resets toolsInFlight and userInputPending", async () => {
			// Simulate a prior turn that incremented counters
			await fire(pi, "message_start", { type: "message_start", message: { role: "assistant", content: [] } }, ctx)
			await fire(
				pi,
				"tool_execution_start",
				{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} },
				ctx,
			)
			await fire(
				pi,
				"tool_execution_end",
				{
					type: "tool_execution_end",
					toolCallId: "t1",
					toolName: "bash",
					result: { content: [], isError: false },
					isError: false,
				},
				ctx,
			)
			ctx.ui.setWorkingVisible.mockClear()

			// New turn should not have userInputPending carried over
			await fire(pi, "turn_start", { type: "turn_start", turnIndex: 1 }, ctx)
			ctx.ui.setWorkingVisible.mockClear()

			// Assistant message_start should NOT decrement userInputPending (it was reset by turn_start)
			await fire(pi, "message_start", { type: "message_start", message: { role: "assistant", content: [] } }, ctx)

			// After turn_start, no setWorkingVisible(false) should fire on text streaming start
			expect(ctx.ui.setWorkingVisible).not.toHaveBeenCalledWith(false)
		})
	})

	describe("text streaming (LLM-2071 — bug fix)", () => {
		it("does NOT hide the spinner on message_start when no tools/thinking/input are pending", async () => {
			await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0 }, ctx)
			ctx.ui.setWorkingVisible.mockClear()

			await fire(
				pi,
				"message_start",
				{ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "" }] } },
				ctx,
			)
			expect(ctx.ui.setWorkingVisible).not.toHaveBeenCalledWith(false)
		})

		it("does NOT hide the spinner on text_delta events", async () => {
			await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0 }, ctx)
			await fire(
				pi,
				"message_start",
				{ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "" }] } },
				ctx,
			)
			ctx.ui.setWorkingVisible.mockClear()

			// Stream several text_delta events
			for (const delta of ["Hello", " world", "!"]) {
				await fire(
					pi,
					"message_update",
					{
						type: "message_update",
						message: { role: "assistant", content: [{ type: "text", text: delta }] },
						assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: undefined },
					},
					ctx,
				)
			}

			// No setWorkingVisible(false) during text streaming
			expect(ctx.ui.setWorkingVisible).not.toHaveBeenCalledWith(false)
		})

		it("registers no message_end handler — spinner stays up until agent_end", () => {
			// LLM-2071 deliberately drops the f1be2201 message_end → stopIndicator handler.
			// The spinner is owned by the turn (turn_start → agent_end), so a per-message
			// teardown would just cause flicker between consecutive assistant messages.
			expect(pi.handlers.message_end).toBeUndefined()
		})

		it("ignores non-assistant message_start (user messages do not toggle the spinner)", async () => {
			await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0 }, ctx)
			ctx.ui.setWorkingVisible.mockClear()

			await fire(
				pi,
				"message_start",
				{ type: "message_start", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
				ctx,
			)
			expect(ctx.ui.setWorkingVisible).not.toHaveBeenCalledWith(false)
		})

		it("keeps the spinner up across multiple assistant messages in one turn", async () => {
			await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0 }, ctx)

			// First assistant message (text + toolcall pattern)
			await fire(
				pi,
				"message_start",
				{ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "let me check" }] } },
				ctx,
			)

			// Tool execution round-trip
			await fire(
				pi,
				"tool_execution_start",
				{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} },
				ctx,
			)
			await fire(
				pi,
				"tool_execution_end",
				{
					type: "tool_execution_end",
					toolCallId: "t1",
					toolName: "bash",
					result: { content: [], isError: false },
					isError: false,
				},
				ctx,
			)

			ctx.ui.setWorkingVisible.mockClear()

			// Second assistant message
			await fire(
				pi,
				"message_start",
				{ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "the result is X" }] } },
				ctx,
			)
			await fire(
				pi,
				"message_update",
				{
					type: "message_update",
					message: { role: "assistant", content: [{ type: "text", text: "the result is X" }] },
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "the result is X", partial: undefined },
				},
				ctx,
			)

			// Spinner should NOT be hidden during the second message's text streaming
			expect(ctx.ui.setWorkingVisible).not.toHaveBeenCalledWith(false)
		})
	})

	describe("reasoning (rebuilt from f1be2201)", () => {
		it("re-arms the spinner on thinking_start when no user input is pending", async () => {
			await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0 }, ctx)
			ctx.ui.setWorkingVisible.mockClear()

			await fire(
				pi,
				"message_update",
				{
					type: "message_update",
					message: { role: "assistant", content: [{ type: "thinking", thinking: "pondering" }] },
					assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: undefined },
				},
				ctx,
			)

			// thinking_start should re-arm by calling setWorkingVisible(true)
			expect(ctx.ui.setWorkingVisible).toHaveBeenCalledWith(true)
		})

		it("does NOT re-arm the spinner on thinking_start when user input is pending", async () => {
			await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0 }, ctx)

			// Trigger userInputPending++ by completing a tool
			await fire(
				pi,
				"tool_execution_start",
				{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} },
				ctx,
			)
			await fire(
				pi,
				"tool_execution_end",
				{
					type: "tool_execution_end",
					toolCallId: "t1",
					toolName: "bash",
					result: { content: [], isError: false },
					isError: false,
				},
				ctx,
			)
			ctx.ui.setWorkingVisible.mockClear()

			// thinking_start should be a no-op for the spinner while userInputPending > 0
			await fire(
				pi,
				"message_update",
				{
					type: "message_update",
					message: { role: "assistant", content: [{ type: "thinking", thinking: "pondering" }] },
					assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: undefined },
				},
				ctx,
			)

			expect(ctx.ui.setWorkingVisible).not.toHaveBeenCalledWith(true)
		})

		it("does NOT stop the spinner on thinking_end", async () => {
			await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0 }, ctx)
			await fire(
				pi,
				"message_update",
				{
					type: "message_update",
					message: { role: "assistant", content: [{ type: "thinking", thinking: "pondering" }] },
					assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: undefined },
				},
				ctx,
			)
			ctx.ui.setWorkingVisible.mockClear()

			await fire(
				pi,
				"message_update",
				{
					type: "message_update",
					message: { role: "assistant", content: [{ type: "thinking", thinking: "pondering" }] },
					assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "pondering", partial: undefined },
				},
				ctx,
			)
			expect(ctx.ui.setWorkingVisible).not.toHaveBeenCalledWith(false)
		})

		it("keeps the spinner up across a reasoning → text transition", async () => {
			await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0 }, ctx)
			await fire(
				pi,
				"message_update",
				{
					type: "message_update",
					message: { role: "assistant", content: [{ type: "thinking", thinking: "pondering" }] },
					assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: undefined },
				},
				ctx,
			)
			await fire(
				pi,
				"message_update",
				{
					type: "message_update",
					message: { role: "assistant", content: [{ type: "thinking", thinking: "pondering" }] },
					assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "pondering", partial: undefined },
				},
				ctx,
			)
			ctx.ui.setWorkingVisible.mockClear()

			await fire(
				pi,
				"message_update",
				{
					type: "message_update",
					message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
					assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "answer", partial: undefined },
				},
				ctx,
			)
			expect(ctx.ui.setWorkingVisible).not.toHaveBeenCalledWith(false)
		})
	})

	describe("tool execution", () => {
		it("shows the spinner on tool_execution_start", async () => {
			await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0 }, ctx)
			ctx.ui.setWorkingVisible.mockClear()

			await fire(
				pi,
				"tool_execution_start",
				{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} },
				ctx,
			)
			expect(ctx.ui.setWorkingVisible).toHaveBeenCalledWith(true)
		})

		it("hides the spinner on tool_execution_end when toolsInFlight reaches 0 (user input may be pending)", async () => {
			await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0 }, ctx)
			await fire(
				pi,
				"tool_execution_start",
				{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} },
				ctx,
			)
			ctx.ui.setWorkingVisible.mockClear()

			await fire(
				pi,
				"tool_execution_end",
				{
					type: "tool_execution_end",
					toolCallId: "t1",
					toolName: "bash",
					result: { content: [], isError: false },
					isError: false,
				},
				ctx,
			)
			expect(ctx.ui.setWorkingVisible).toHaveBeenCalledWith(false)
		})

		it("keeps the spinner up across parallel tool_execution_end events until toolsInFlight is 0", async () => {
			await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0 }, ctx)
			await fire(
				pi,
				"tool_execution_start",
				{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} },
				ctx,
			)
			await fire(
				pi,
				"tool_execution_start",
				{ type: "tool_execution_start", toolCallId: "t2", toolName: "read", args: {} },
				ctx,
			)
			ctx.ui.setWorkingVisible.mockClear()

			// First tool ends, but toolsInFlight is still 1
			await fire(
				pi,
				"tool_execution_end",
				{
					type: "tool_execution_end",
					toolCallId: "t1",
					toolName: "bash",
					result: { content: [], isError: false },
					isError: false,
				},
				ctx,
			)
			expect(ctx.ui.setWorkingVisible).not.toHaveBeenCalledWith(false)

			// Second tool ends — toolsInFlight hits 0, spinner should hide
			await fire(
				pi,
				"tool_execution_end",
				{
					type: "tool_execution_end",
					toolCallId: "t2",
					toolName: "read",
					result: { content: [], isError: false },
					isError: false,
				},
				ctx,
			)
			expect(ctx.ui.setWorkingVisible).toHaveBeenCalledWith(false)
		})
	})

	describe("turn_end 'Worked for Xs' status", () => {
		it("shows 'Worked for Xs' on turn_end and hides after 2500ms", async () => {
			vi.useFakeTimers()
			await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0 }, ctx)
			await fire(pi, "agent_end", { type: "agent_end", messages: [] }, ctx)
			ctx.ui.setWorkingVisible.mockClear()
			ctx.ui.setWorkingMessage.mockClear()

			await fire(
				pi,
				"turn_end",
				{
					type: "turn_end",
					turnIndex: 0,
					message: { role: "assistant", content: [{ type: "text", text: "done" }] },
					toolResults: [],
				},
				ctx,
			)

			expect(ctx.ui.setWorkingVisible).toHaveBeenCalledWith(true)
			const lastMessage = ctx.ui.setWorkingMessage.mock.calls.at(-1)?.[0] as string
			expect(lastMessage).toContain("Worked for")

			vi.advanceTimersByTime(2500)
			expect(ctx.ui.setWorkingVisible).toHaveBeenCalledWith(false)
		})

		it("clears any pending workedForTimer on agent_end", async () => {
			vi.useFakeTimers()
			await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0 }, ctx)
			await fire(
				pi,
				"turn_end",
				{
					type: "turn_end",
					turnIndex: 0,
					message: { role: "assistant", content: [{ type: "text", text: "done" }] },
					toolResults: [],
				},
				ctx,
			)
			// Advance less than 2500ms — timer should still be pending
			vi.advanceTimersByTime(1000)
			ctx.ui.setWorkingVisible.mockClear()

			// Next turn_start → agent_end should clear the pending workedForTimer
			await fire(pi, "turn_start", { type: "turn_start", turnIndex: 1 }, ctx)
			ctx.ui.setWorkingVisible.mockClear()
			await fire(pi, "agent_end", { type: "agent_end", messages: [] }, ctx)
			expect(ctx.ui.setWorkingVisible).toHaveBeenCalledWith(false)

			// Advancing past the original 2500ms should NOT trigger an extra hide
			ctx.ui.setWorkingVisible.mockClear()
			vi.advanceTimersByTime(2000)
			expect(ctx.ui.setWorkingVisible).not.toHaveBeenCalledWith(false)
		})
	})

	describe("user input pending suppression", () => {
		it("decrements userInputPending on assistant message_start after a tool finishes", async () => {
			await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0 }, ctx)
			await fire(
				pi,
				"tool_execution_start",
				{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} },
				ctx,
			)
			await fire(
				pi,
				"tool_execution_end",
				{
					type: "tool_execution_end",
					toolCallId: "t1",
					toolName: "bash",
					result: { content: [], isError: false },
					isError: false,
				},
				ctx,
			)
			ctx.ui.setWorkingVisible.mockClear()

			// Assistant message_start decrements userInputPending (does not re-arm spinner)
			await fire(
				pi,
				"message_start",
				{ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "" }] } },
				ctx,
			)

			expect(ctx.ui.setWorkingVisible).not.toHaveBeenCalledWith(true)
		})
	})

	describe("input event handling", () => {
		it("decrements userInputPending when the user types (input event)", async () => {
			await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0 }, ctx)
			await fire(
				pi,
				"tool_execution_start",
				{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} },
				ctx,
			)
			await fire(
				pi,
				"tool_execution_end",
				{
					type: "tool_execution_end",
					toolCallId: "t1",
					toolName: "bash",
					result: { content: [], isError: false },
					isError: false,
				},
				ctx,
			)

			// Now userInputPending should be 1. User types → decrements.
			await fire(pi, "input", { type: "input", text: "yes" }, ctx)

			// Next assistant message_start should NOT decrement userInputPending (it's already 0)
			ctx.ui.setWorkingVisible.mockClear()
			await fire(
				pi,
				"message_start",
				{ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "" }] } },
				ctx,
			)
			expect(ctx.ui.setWorkingVisible).not.toHaveBeenCalledWith(true)
		})
	})
})
