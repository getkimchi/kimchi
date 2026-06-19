/**
 * Spinner state machine tests for `uiExtension`.
 *
 * The cooking animation is driven by the full event lifecycle of an assistant
 * message: turn_start → message_start → message_update(thinking_start/_delta/_end
 * | text_start) → message_end → turn_end. This file exercises that lifecycle
 * end-to-end through the real `uiExtension` default export, asserting on the
 * mock UI's `setWorkingVisible` call sequence.
 *
 * `createWorkingAnimator` is replaced with a stub that tracks which animator
 * instances had their cleanup invoked before being overwritten — that's the
 * leak-safety contract enforced by `startIndicator`'s
 * `stopWorkingAnimation?.()` call.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

// Per-animator cleanup tracking. Each entry is true iff that animator's cleanup
// was invoked (either by startIndicator's overwrite or by an explicit stop).
const animatorCleanupCalled: boolean[] = vi.hoisted(() => [])

vi.mock("./spinner.js", async () => {
	const actual = await vi.importActual<typeof import("./spinner.js")>("./spinner.js")
	return {
		...actual,
		createWorkingAnimator: (_onUpdate: (char: string, message: string) => void) => {
			const id = animatorCleanupCalled.length
			animatorCleanupCalled.push(false)
			return () => {
				animatorCleanupCalled[id] = true
			}
		},
	}
})

// Imported AFTER vi.mock so the mock applies.
const uiExtension = (await import("./ui.js")).default

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>

interface MockUi {
	setWorkingVisible: ReturnType<typeof vi.fn>
	setWorkingIndicator: ReturnType<typeof vi.fn>
	setWorkingMessage: ReturnType<typeof vi.fn>
	notify: ReturnType<typeof vi.fn>
	setStatus: ReturnType<typeof vi.fn>
	setHeader: ReturnType<typeof vi.fn>
	setFooter: ReturnType<typeof vi.fn>
	setEditorComponent: ReturnType<typeof vi.fn>
	onTerminalInput: ReturnType<typeof vi.fn>
}

interface MockCtx {
	ui: MockUi
	hasUI: boolean
	cwd: string
	model: undefined
	modelRegistry: { getAvailable: ReturnType<typeof vi.fn> }
	getContextUsage: ReturnType<typeof vi.fn>
	isIdle: ReturnType<typeof vi.fn>
	abort: ReturnType<typeof vi.fn>
}

function createMockUi(): MockUi {
	return {
		setWorkingVisible: vi.fn(),
		setWorkingIndicator: vi.fn(),
		setWorkingMessage: vi.fn(),
		notify: vi.fn(),
		setStatus: vi.fn(),
		setHeader: vi.fn(),
		setFooter: vi.fn(),
		setEditorComponent: vi.fn(),
		onTerminalInput: vi.fn(() => () => {}),
	}
}

function createMockCtx(ui: MockUi = createMockUi()): MockCtx {
	return {
		ui,
		hasUI: true,
		cwd: "/tmp/test",
		model: undefined,
		modelRegistry: { getAvailable: vi.fn(() => []) },
		getContextUsage: vi.fn(() => undefined),
		isIdle: vi.fn(() => true),
		abort: vi.fn(),
	}
}

function createMockPi() {
	const handlers = new Map<string, Handler[]>()
	const on = vi.fn((event: string, handler: Handler) => {
		if (!handlers.has(event)) handlers.set(event, [])
		handlers.get(event)?.push(handler)
	})
	const registerCommand = vi.fn()
	const pi = { on, registerCommand } as unknown as Parameters<typeof uiExtension>[0]
	return { handlers, pi, on, registerCommand }
}

function getHandler(handlers: Map<string, Handler[]>, event: string): Handler {
	const list = handlers.get(event)
	if (!list || list.length === 0) throw new Error(`No handler registered for ${event}`)
	return list[0]
}

interface SpinnerHandlers {
	turnStart: Handler
	messageUpdate: Handler
	messageStart: Handler
	messageEnd: Handler
	toolExecutionStart: Handler
	toolExecutionEnd: Handler
	agentEnd: Handler
}

interface Setup {
	handlers: SpinnerHandlers
	ctx: MockCtx
	ui: MockUi
	/** Asserts every animator except possibly the last was cleaned up before being overwritten. */
	assertCleanupsBeforeOverwrite: () => void
}

function callsTo(ui: MockUi): boolean[] {
	return ui.setWorkingVisible.mock.calls.map((args) => args[0] as boolean)
}

function setupExtension(): Setup {
	const { handlers, pi } = createMockPi()
	uiExtension(pi)

	const ctx = createMockCtx()

	const h: SpinnerHandlers = {
		turnStart: getHandler(handlers, "turn_start"),
		messageUpdate: getHandler(handlers, "message_update"),
		messageStart: getHandler(handlers, "message_start"),
		messageEnd: getHandler(handlers, "message_end"),
		toolExecutionStart: getHandler(handlers, "tool_execution_start"),
		toolExecutionEnd: getHandler(handlers, "tool_execution_end"),
		agentEnd: getHandler(handlers, "agent_end"),
	}

	const assertCleanupsBeforeOverwrite = () => {
		// Every animator except the last must have been cleaned before being overwritten.
		// The last may or may not be cleaned depending on whether an explicit stop
		// happened after it was created (e.g. message_end, agent_end, text_start).
		for (let i = 0; i < animatorCleanupCalled.length - 1; i++) {
			expect(animatorCleanupCalled[i], `Animator #${i} was not cleaned up before animator #${i + 1} was created`).toBe(
				true,
			)
		}
	}

	return { handlers: h, ctx, ui: ctx.ui, assertCleanupsBeforeOverwrite }
}

beforeEach(() => {
	animatorCleanupCalled.length = 0
})

const assistantMessage = { role: "assistant" as const, content: [] }

function messageUpdate(type: string) {
	return {
		type: "message_update",
		message: assistantMessage,
		assistantMessageEvent: { type },
	}
}

describe("uiExtension spinner lifecycle", () => {
	describe("the core bug fix — spinner survives message_start", () => {
		it("keeps the spinner on through the gap before the first content event", () => {
			// Regression test for the user-reported bug. Before the fix, message_start
			// killed the spinner, leaving a blank TUI for the entire reasoning window.
			const { handlers, ctx, ui } = setupExtension()

			handlers.turnStart({}, ctx)
			handlers.messageStart({ type: "message_start", message: assistantMessage }, ctx)
			// No message_update yet — model is still warming up. Spinner must still be on.
			expect(ui.setWorkingVisible).toHaveBeenLastCalledWith(true)
		})

		it("preserves the spinner across a full thinking-only turn", () => {
			const { handlers, ctx, ui, assertCleanupsBeforeOverwrite } = setupExtension()

			handlers.turnStart({}, ctx)
			handlers.messageStart({ type: "message_start", message: assistantMessage }, ctx)
			handlers.messageUpdate(messageUpdate("thinking_start"), ctx)
			handlers.messageUpdate(messageUpdate("thinking_delta"), ctx)
			handlers.messageUpdate(messageUpdate("thinking_end"), ctx)
			handlers.messageEnd({ type: "message_end", message: assistantMessage }, ctx)

			// ON (turn_start) → ON (thinking_start, restarts animator) → OFF (message_end).
			// message_start is a no-op. text_start never fires for a pure-thinking turn.
			expect(callsTo(ui)).toEqual([true, true, false])

			assertCleanupsBeforeOverwrite()
		})
	})

	describe("pure text turn (no reasoning)", () => {
		it("kills the spinner at text_start, not at message_start", () => {
			const { handlers, ctx, ui, assertCleanupsBeforeOverwrite } = setupExtension()

			handlers.turnStart({}, ctx)
			handlers.messageStart({ type: "message_start", message: assistantMessage }, ctx)
			handlers.messageUpdate(messageUpdate("text_start"), ctx)
			handlers.messageUpdate(messageUpdate("text_delta"), ctx)
			handlers.messageEnd({ type: "message_end", message: assistantMessage }, ctx)

			// ON (turn_start) → OFF (text_start) → OFF (message_end, no-op since already off).
			expect(callsTo(ui)).toEqual([true, false, false])

			assertCleanupsBeforeOverwrite()
		})
	})

	describe("thinking then text", () => {
		it("keeps the spinner alive through thinking, kills it at text_start", () => {
			const { handlers, ctx, ui, assertCleanupsBeforeOverwrite } = setupExtension()

			handlers.turnStart({}, ctx)
			handlers.messageStart({ type: "message_start", message: assistantMessage }, ctx)
			handlers.messageUpdate(messageUpdate("thinking_start"), ctx)
			handlers.messageUpdate(messageUpdate("thinking_delta"), ctx)
			handlers.messageUpdate(messageUpdate("thinking_end"), ctx)
			handlers.messageUpdate(messageUpdate("text_start"), ctx)
			handlers.messageEnd({ type: "message_end", message: assistantMessage }, ctx)

			// ON (turn_start) → ON (thinking_start, restarts) → OFF (text_start) → OFF (message_end, no-op).
			expect(callsTo(ui)).toEqual([true, true, false, false])

			assertCleanupsBeforeOverwrite()
		})
	})

	describe("tool execution", () => {
		it("restarts the spinner for tool calls and stops it after the last tool", () => {
			const { handlers, ctx, ui, assertCleanupsBeforeOverwrite } = setupExtension()

			handlers.turnStart({}, ctx)
			handlers.messageStart({ type: "message_start", message: assistantMessage }, ctx)
			handlers.messageUpdate(messageUpdate("text_start"), ctx)
			handlers.messageEnd({ type: "message_end", message: assistantMessage }, ctx)
			handlers.toolExecutionStart({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" }, ctx)
			handlers.toolExecutionStart({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash" }, ctx)
			handlers.toolExecutionEnd({ type: "tool_execution_end", toolCallId: "t1" }, ctx)
			handlers.toolExecutionEnd({ type: "tool_execution_end", toolCallId: "t2" }, ctx)

			// ON (turn_start) → OFF (text_start) → OFF (message_end, no-op) → ON (tool_execution_start #1)
			// → ON (tool_execution_start #2, restarts) → OFF (tool_execution_end #2, the last).
			// tool_execution_end #1 doesn't stop the spinner because toolsInFlight is still 1.
			expect(callsTo(ui)).toEqual([true, false, false, true, true, false])

			assertCleanupsBeforeOverwrite()
		})
	})

	describe("userInputPending suppression", () => {
		it("keeps the spinner off between tool_execution_end and the next message_start", () => {
			// When the last tool finishes, the TUI may be about to block on a prompt.
			// The spinner is killed at tool_execution_end and must stay off through
			// message_start — message_start just decrements the counter, no UI change.
			const { handlers, ctx, ui, assertCleanupsBeforeOverwrite } = setupExtension()

			handlers.turnStart({}, ctx)
			handlers.toolExecutionStart({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" }, ctx)
			handlers.toolExecutionEnd({ type: "tool_execution_end", toolCallId: "t1" }, ctx)
			handlers.messageStart({ type: "message_start", message: assistantMessage }, ctx)

			// turn_start ON, tool_execution_start ON, tool_execution_end OFF.
			// message_start is a no-op (userInputPending decremented, no setWorkingVisible call).
			expect(callsTo(ui)).toEqual([true, true, false])

			assertCleanupsBeforeOverwrite()
		})

		it("allows thinking_start to start the spinner after message_start lifts the suppression", () => {
			// Counter is decremented at message_start. By the time thinking_start fires,
			// userInputPending is 0, so the spinner re-arms.
			const { handlers, ctx, ui, assertCleanupsBeforeOverwrite } = setupExtension()

			handlers.turnStart({}, ctx)
			handlers.toolExecutionStart({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" }, ctx)
			handlers.toolExecutionEnd({ type: "tool_execution_end", toolCallId: "t1" }, ctx)
			handlers.messageStart({ type: "message_start", message: assistantMessage }, ctx)
			handlers.messageUpdate(messageUpdate("thinking_start"), ctx)

			// turn_start ON, tool_execution_start ON, tool_execution_end OFF, message_start NO-OP,
			// thinking_start ON.
			expect(callsTo(ui)).toEqual([true, true, false, true])

			assertCleanupsBeforeOverwrite()
		})
	})

	describe("agent_end", () => {
		it("stops the spinner and clears in-flight state", () => {
			const { handlers, ctx, ui, assertCleanupsBeforeOverwrite } = setupExtension()

			handlers.turnStart({}, ctx)
			handlers.toolExecutionStart({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" }, ctx)
			// Don't end the tool — simulate the agent ending mid-tool.
			handlers.agentEnd({ type: "agent_end", messages: [] }, ctx)

			// turn_start ON, tool_execution_start ON, agent_end OFF.
			expect(callsTo(ui)).toEqual([true, true, false])

			assertCleanupsBeforeOverwrite()
		})
	})

	describe("leak safety", () => {
		it("calls the previous animator cleanup before overwriting stopWorkingAnimation", () => {
			// Specifically guards against timer leaks: if startIndicator ever forgets
			// the `stopWorkingAnimation?.()` call before assigning, the previous
			// animator's timers would never be cleared.
			const { handlers, ctx, assertCleanupsBeforeOverwrite } = setupExtension()

			handlers.turnStart({}, ctx) // animator #0
			handlers.messageStart({ type: "message_start", message: assistantMessage }, ctx)
			// thinking_start triggers a re-arm — animator #1
			handlers.messageUpdate(messageUpdate("thinking_start"), ctx)
			handlers.messageUpdate(messageUpdate("thinking_end"), ctx)
			// text_start triggers a stop + no new animator
			handlers.messageUpdate(messageUpdate("text_start"), ctx)

			expect(animatorCleanupCalled.length).toBe(2)
			// animator #0 was overwritten by #1 — must have been cleaned up
			expect(animatorCleanupCalled[0]).toBe(true)
			// animator #1 is the last and was stopped by text_start
			expect(animatorCleanupCalled[1]).toBe(true)

			assertCleanupsBeforeOverwrite()
		})
	})
})
