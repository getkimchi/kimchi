/**
 * Spinner state machine tests for `uiExtension`.
 *
 * The cooking animation is driven by the full event lifecycle of an assistant
 * message: turn_start → message_start → message_update(thinking_start/_delta/_end
 * | text_start) → message_end → turn_end. This file exercises that lifecycle
 * end-to-end through the real `uiExtension` default export, asserting on the
 * mock UI's `setWorkingVisible` call sequence and the (thinking…)/(thought for
 * Ns) suffix that the spinner message renders.
 *
 * `createWorkingAnimator` is replaced with a stub that:
 *  - tracks which animator instances had their cleanup invoked before being
 *    overwritten (the leak-safety contract enforced by `startIndicator`'s
 *    `stopWorkingAnimation?.()` call), and
 *  - captures the onUpdate callback so tests can manually drive the rendering
 *    loop without real timers firing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Per-animator cleanup tracking. Each entry is true iff that animator's cleanup
// was invoked (either by startIndicator's overwrite or by an explicit stop).
const animatorCleanupCalled: boolean[] = vi.hoisted(() => [])

// Captured onUpdate callbacks. animatorCallbacks[N-1] is the N-th animator's
// callback. Tests invoke `tickLatestAnimator()` to simulate the animator's
// render() call against the current thinkingStatus / ctx state.
const animatorCallbacks: Array<(char: string, message: string) => void> = vi.hoisted(() => [])

vi.mock("./spinner.js", async () => {
	const actual = await vi.importActual<typeof import("./spinner.js")>("./spinner.js")
	return {
		...actual,
		createWorkingAnimator: (onUpdate: (char: string, message: string) => void) => {
			const id = animatorCleanupCalled.length
			animatorCleanupCalled.push(false)
			animatorCallbacks.push(onUpdate)
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

interface MockTheme {
	fg: (color: string, text: string) => string
	getFgAnsi: (color: string) => string
}

interface MockCtx {
	ui: MockUi & { theme: MockTheme }
	hasUI: boolean
	cwd: string
	model: undefined
	modelRegistry: { getAvailable: ReturnType<typeof vi.fn> }
	getContextUsage: ReturnType<typeof vi.fn>
	isIdle: ReturnType<typeof vi.fn>
	abort: ReturnType<typeof vi.fn>
	shutdown: ReturnType<typeof vi.fn>
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

function createMockTheme(): MockTheme {
	return {
		fg: (_color: string, text: string) => `<${text}>`,
		// Return a real ANSI escape (not RST_FG, so resolvedAccentFg keeps it
		// instead of falling back to TEAL_FG). The actual byte values don't
		// matter for the tests — they assert on substrings of setWorkingMessage
		// rather than the full ANSI-encoded payload.
		getFgAnsi: (_color: string) => "\x1b[38;2;138;190;183m",
	}
}

function createMockCtx(ui: MockUi = createMockUi()): MockCtx {
	return {
		ui: { ...ui, theme: createMockTheme() },
		hasUI: true,
		cwd: "/tmp/test",
		model: undefined,
		modelRegistry: { getAvailable: vi.fn(() => []) },
		getContextUsage: vi.fn(() => undefined),
		isIdle: vi.fn(() => true),
		abort: vi.fn(),
		shutdown: vi.fn(),
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
	turnEnd: Handler
	input: Handler
	agentEnd: Handler
}

interface Setup {
	handlers: SpinnerHandlers
	ctx: MockCtx
	ui: MockUi
	/** Asserts every animator except possibly the last was cleaned up before being overwritten. */
	assertCleanupsBeforeOverwrite: () => void
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
		turnEnd: getHandler(handlers, "turn_end"),
		input: getHandler(handlers, "input"),
		agentEnd: getHandler(handlers, "agent_end"),
	}

	const assertCleanupsBeforeOverwrite = () => {
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
	animatorCallbacks.length = 0
})

function callsTo(ui: MockUi): boolean[] {
	return ui.setWorkingVisible.mock.calls.map((args) => args[0] as boolean)
}

/**
 * Drive the most recently created animator's onUpdate callback as the
 * animator's internal render() loop would. Lets us assert on the rendered
 * spinner message without dealing with real timers.
 */
function tickLatestAnimator(char = "|", message = "Chopping"): void {
	const cb = animatorCallbacks[animatorCallbacks.length - 1]
	if (!cb) throw new Error("No animator captured — call turn_start (or another start) first")
	cb(char, message)
}

const assistantMessage = { role: "assistant" as const, content: [] }

function messageUpdateEvent(type: string) {
	return {
		type: "message_update",
		message: assistantMessage,
		assistantMessageEvent: { type },
	}
}

const turnEndEvent = {
	type: "turn_end",
	turnIndex: 0,
	message: assistantMessage,
	toolResults: [],
}

describe("uiExtension spinner lifecycle", () => {
	describe("the core bug fix — spinner survives message_start", () => {
		it("keeps the spinner on through the gap before the first content event", () => {
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
			handlers.messageUpdate(messageUpdateEvent("thinking_start"), ctx)
			handlers.messageUpdate(messageUpdateEvent("thinking_delta"), ctx)
			handlers.messageUpdate(messageUpdateEvent("thinking_end"), ctx)
			handlers.messageEnd({ type: "message_end", message: assistantMessage }, ctx)

			// ON (turn_start) → ON (message_start, re-arms for loader creation)
			// → ON (thinking_start, restarts animator) → OFF (message_end).
			expect(callsTo(ui)).toEqual([true, true, true, false])

			assertCleanupsBeforeOverwrite()
		})
	})

	describe("pure text turn (no reasoning)", () => {
		it("kills the spinner at text_start, not at message_start", () => {
			const { handlers, ctx, ui, assertCleanupsBeforeOverwrite } = setupExtension()

			handlers.turnStart({}, ctx)
			handlers.messageStart({ type: "message_start", message: assistantMessage }, ctx)
			handlers.messageUpdate(messageUpdateEvent("text_start"), ctx)
			handlers.messageUpdate(messageUpdateEvent("text_delta"), ctx)
			handlers.messageEnd({ type: "message_end", message: assistantMessage }, ctx)

			expect(callsTo(ui)).toEqual([true, true, false, false])

			assertCleanupsBeforeOverwrite()
		})
	})

	describe("thinking then text", () => {
		it("keeps the spinner alive through thinking, kills it at text_start", () => {
			const { handlers, ctx, ui, assertCleanupsBeforeOverwrite } = setupExtension()

			handlers.turnStart({}, ctx)
			handlers.messageStart({ type: "message_start", message: assistantMessage }, ctx)
			handlers.messageUpdate(messageUpdateEvent("thinking_start"), ctx)
			handlers.messageUpdate(messageUpdateEvent("thinking_delta"), ctx)
			handlers.messageUpdate(messageUpdateEvent("thinking_end"), ctx)
			handlers.messageUpdate(messageUpdateEvent("text_start"), ctx)
			handlers.messageEnd({ type: "message_end", message: assistantMessage }, ctx)

			expect(callsTo(ui)).toEqual([true, true, true, false, false])

			assertCleanupsBeforeOverwrite()
		})
	})

	describe("tool execution", () => {
		it("restarts the spinner for tool calls and stops it after the last tool", () => {
			const { handlers, ctx, ui, assertCleanupsBeforeOverwrite } = setupExtension()

			handlers.turnStart({}, ctx)
			handlers.messageStart({ type: "message_start", message: assistantMessage }, ctx)
			handlers.messageUpdate(messageUpdateEvent("text_start"), ctx)
			handlers.messageEnd({ type: "message_end", message: assistantMessage }, ctx)
			handlers.toolExecutionStart({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" }, ctx)
			handlers.toolExecutionStart({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash" }, ctx)
			handlers.toolExecutionEnd({ type: "tool_execution_end", toolCallId: "t1" }, ctx)
			handlers.toolExecutionEnd({ type: "tool_execution_end", toolCallId: "t2" }, ctx)

			expect(callsTo(ui)).toEqual([true, true, false, false, true, true, false])

			assertCleanupsBeforeOverwrite()
		})
	})

	describe("userInputPending suppression", () => {
		it("keeps the spinner off between tool_execution_end and the next message_start", () => {
			const { handlers, ctx, ui, assertCleanupsBeforeOverwrite } = setupExtension()

			handlers.turnStart({}, ctx)
			handlers.toolExecutionStart({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" }, ctx)
			handlers.toolExecutionEnd({ type: "tool_execution_end", toolCallId: "t1" }, ctx)
			handlers.messageStart({ type: "message_start", message: assistantMessage }, ctx)

			expect(callsTo(ui)).toEqual([true, true, false])

			assertCleanupsBeforeOverwrite()
		})

		it("allows thinking_start to start the spinner after message_start lifts the suppression", () => {
			const { handlers, ctx, ui, assertCleanupsBeforeOverwrite } = setupExtension()

			handlers.turnStart({}, ctx)
			handlers.toolExecutionStart({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" }, ctx)
			handlers.toolExecutionEnd({ type: "tool_execution_end", toolCallId: "t1" }, ctx)
			handlers.messageStart({ type: "message_start", message: assistantMessage }, ctx)
			handlers.messageUpdate(messageUpdateEvent("thinking_start"), ctx)

			expect(callsTo(ui)).toEqual([true, true, false, true])

			assertCleanupsBeforeOverwrite()
		})

		it("suppresses thinking_start while userInputPending is still set (between tool and message_start)", () => {
			// The "suppression lifted at message_start" tests above rely on
			// message_start decrementing the counter first. This test exercises the
			// other branch: when message_start hasn't fired yet (or fired with a
			// non-assistant role), thinking_start must NOT start the spinner.
			const { handlers, ctx, ui, assertCleanupsBeforeOverwrite } = setupExtension()

			handlers.turnStart({}, ctx)
			handlers.toolExecutionStart({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" }, ctx)
			handlers.toolExecutionEnd({ type: "tool_execution_end", toolCallId: "t1" }, ctx)
			// Skip message_start — the suppression must hold.
			handlers.messageUpdate(messageUpdateEvent("thinking_start"), ctx)

			// turn_start ON, tool_execution_start ON, tool_execution_end OFF.
			// thinking_start is suppressed — no setWorkingVisible(true) call.
			expect(callsTo(ui)).toEqual([true, true, false])

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

			expect(callsTo(ui)).toEqual([true, true, false])

			assertCleanupsBeforeOverwrite()
		})
	})

	describe("leak safety", () => {
		it("calls the previous animator cleanup before overwriting stopWorkingAnimation", () => {
			const { handlers, ctx, assertCleanupsBeforeOverwrite } = setupExtension()

			handlers.turnStart({}, ctx)
			handlers.messageStart({ type: "message_start", message: assistantMessage }, ctx)
			handlers.messageUpdate(messageUpdateEvent("thinking_start"), ctx)
			handlers.messageUpdate(messageUpdateEvent("thinking_end"), ctx)
			handlers.messageUpdate(messageUpdateEvent("text_start"), ctx)

			expect(animatorCleanupCalled.length).toBe(2)
			expect(animatorCleanupCalled[0]).toBe(true)
			expect(animatorCleanupCalled[1]).toBe(true)

			assertCleanupsBeforeOverwrite()
		})
	})

	describe("thinkingStatus suffix rendering", () => {
		// The onUpdate callback captures `thinkingStatus` from its enclosing
		// scope. We set it via message_update(thinking_start/_end) then drive the
		// callback via tickLatestAnimator() to assert what setWorkingMessage
		// receives — the actual user-visible spinner text.

		it("renders no suffix when no thinking has happened", () => {
			const { handlers, ctx, ui } = setupExtension()

			handlers.turnStart({}, ctx)
			tickLatestAnimator()

			const message = ui.setWorkingMessage.mock.lastCall?.[0] as string
			expect(message).toContain("Chopping")
			expect(message).not.toContain("(think")
		})

		it("renders the '(thinking…)' suffix while reasoning is in flight", () => {
			const { handlers, ctx, ui } = setupExtension()

			handlers.turnStart({}, ctx)
			handlers.messageUpdate(messageUpdateEvent("thinking_start"), ctx)
			tickLatestAnimator()

			expect(ui.setWorkingMessage).toHaveBeenLastCalledWith(expect.stringContaining("Chopping"))
			expect(ui.setWorkingMessage).toHaveBeenLastCalledWith(expect.stringContaining("(thinking…)"))
		})

		it("renders the '(thought for Ns)' suffix after reasoning ends with duration > 100ms", () => {
			vi.useFakeTimers()
			try {
				vi.setSystemTime(1_000_000)
				const { handlers, ctx, ui } = setupExtension()

				handlers.turnStart({}, ctx)
				vi.setSystemTime(1_000_500) // +500ms: turn_start to thinking_start
				handlers.messageUpdate(messageUpdateEvent("thinking_start"), ctx)
				vi.setSystemTime(1_003_500) // +3s: total thinking duration
				handlers.messageUpdate(messageUpdateEvent("thinking_end"), ctx)
				tickLatestAnimator()

				expect(ui.setWorkingMessage).toHaveBeenLastCalledWith(expect.stringContaining("(thought for 3s)"))
				expect(ui.setWorkingMessage).toHaveBeenLastCalledWith(expect.not.stringContaining("(thinking…)"))
			} finally {
				vi.useRealTimers()
			}
		})

		it("clears the suffix when reasoning was shorter than 100ms", () => {
			vi.useFakeTimers()
			try {
				vi.setSystemTime(1_000_000)
				const { handlers, ctx, ui } = setupExtension()

				handlers.turnStart({}, ctx)
				vi.setSystemTime(1_000_010)
				handlers.messageUpdate(messageUpdateEvent("thinking_start"), ctx)
				vi.setSystemTime(1_000_020) // 10ms total — under the 100ms threshold
				handlers.messageUpdate(messageUpdateEvent("thinking_end"), ctx)
				tickLatestAnimator()

				expect(ui.setWorkingMessage).toHaveBeenLastCalledWith(expect.stringContaining("Chopping"))
				expect(ui.setWorkingMessage).toHaveBeenLastCalledWith(expect.not.stringContaining("(thinking"))
				expect(ui.setWorkingMessage).toHaveBeenLastCalledWith(expect.not.stringContaining("(thought"))
			} finally {
				vi.useRealTimers()
			}
		})

		it("records the duration of the most recent reasoning block", () => {
			// Two thinking blocks in one message: the second one's duration wins.
			vi.useFakeTimers()
			try {
				vi.setSystemTime(1_000_000)
				const { handlers, ctx, ui } = setupExtension()

				handlers.turnStart({}, ctx)
				vi.setSystemTime(1_000_500)
				handlers.messageUpdate(messageUpdateEvent("thinking_start"), ctx)
				vi.setSystemTime(1_001_000) // 500ms
				handlers.messageUpdate(messageUpdateEvent("thinking_end"), ctx)
				vi.setSystemTime(1_002_000)
				handlers.messageUpdate(messageUpdateEvent("thinking_start"), ctx)
				vi.setSystemTime(1_005_000) // 3s
				handlers.messageUpdate(messageUpdateEvent("thinking_end"), ctx)
				tickLatestAnimator()

				expect(ui.setWorkingMessage).toHaveBeenLastCalledWith(expect.stringContaining("(thought for 3s)"))
			} finally {
				vi.useRealTimers()
			}
		})
	})

	describe("turn_end 'Worked for Xs' display", () => {
		beforeEach(() => {
			vi.useFakeTimers()
		})
		afterEach(() => {
			vi.useRealTimers()
		})

		it("shows 'Worked for Xs' and hides after 2.5s", () => {
			const { handlers, ctx, ui } = setupExtension()

			vi.setSystemTime(1_000_000)
			handlers.turnStart({}, ctx)
			vi.advanceTimersByTime(1_500) // simulate 1.5s of work
			handlers.turnEnd(turnEndEvent, ctx)

			// "Worked for 2s" or "1s" depending on duration formatter — accept either
			// word boundary; just assert "Worked for" is present.
			expect(ui.setWorkingVisible).toHaveBeenLastCalledWith(true)
			expect(ui.setWorkingMessage).toHaveBeenLastCalledWith(expect.stringContaining("Worked for"))

			// Just before 2.5s — still visible.
			vi.advanceTimersByTime(2_400)
			expect(ui.setWorkingVisible).toHaveBeenLastCalledWith(true)

			// Past 2.5s — auto-hide fires.
			vi.advanceTimersByTime(200)
			expect(ui.setWorkingVisible).toHaveBeenLastCalledWith(false)
		})

		it("cancels a pending auto-hide timer if turn_end fires again", () => {
			const { handlers, ctx, ui } = setupExtension()

			vi.setSystemTime(1_000_000)
			handlers.turnStart({}, ctx)
			handlers.turnEnd(turnEndEvent, ctx) // first 2.5s auto-hide timer set
			vi.advanceTimersByTime(1_000) // T = T1 + 1000ms
			handlers.turnEnd(turnEndEvent, ctx) // second timer set, first must be cleared

			// Advance to T = T1 + 2600ms — past the first timer's original deadline
			// (T1 + 2500ms) but well before the second timer's (T1 + 3500ms). If the
			// first timer had NOT been cancelled, setWorkingVisible(false) would have
			// fired by now and this assertion would fail.
			vi.advanceTimersByTime(1_600)
			expect(ui.setWorkingVisible).toHaveBeenLastCalledWith(true)

			// Advance past the second timer's deadline.
			vi.advanceTimersByTime(1_000)
			expect(ui.setWorkingVisible).toHaveBeenLastCalledWith(false)
		})
	})

	describe("input handler", () => {
		it("calls ctx.shutdown when the user types bare 'exit'", () => {
			const { handlers, ctx } = setupExtension()

			handlers.input({ type: "input", text: "exit" }, ctx)
			expect(ctx.shutdown).toHaveBeenCalledTimes(1)
		})

		it("calls ctx.shutdown for 'exit' with surrounding whitespace", () => {
			const { handlers, ctx } = setupExtension()

			handlers.input({ type: "input", text: "  exit  " }, ctx)
			expect(ctx.shutdown).toHaveBeenCalledTimes(1)
		})

		it("does not call ctx.shutdown for /exit (slash command)", () => {
			const { handlers, ctx } = setupExtension()

			handlers.input({ type: "input", text: "/exit" }, ctx)
			expect(ctx.shutdown).not.toHaveBeenCalled()
		})

		it("does not call ctx.shutdown for regular text", () => {
			const { handlers, ctx } = setupExtension()

			handlers.input({ type: "input", text: "hello world" }, ctx)
			expect(ctx.shutdown).not.toHaveBeenCalled()
		})
	})

	describe("message_start role guard", () => {
		it("does not touch the spinner when the role is non-assistant", () => {
			// Non-assistant message_start must be a complete no-op — no setWorkingVisible
			// calls and no other side effects on the spinner state machine.
			const { handlers, ctx, ui } = setupExtension()

			handlers.turnStart({}, ctx)
			expect(callsTo(ui)).toEqual([true])

			handlers.messageStart({ type: "message_start", message: { role: "toolResult", content: [] } }, ctx)
			expect(callsTo(ui)).toEqual([true])

			handlers.messageStart({ type: "message_start", message: { role: "user", content: [] } }, ctx)
			expect(callsTo(ui)).toEqual([true])
		})

		it("does not consume userInputPending when the role is non-assistant", () => {
			// The role guard is load-bearing: a toolResult message_start must NOT decrement
			// the userInputPending counter. If it did, the next assistant message_start
			// would see a zero counter and skip the decrement — and a subsequent thinking_start
			// would think the suppression had been lifted (by the assistant message_start)
			// when it actually hadn't been (by the toolResult one).
			//
			// Observable consequence: a toolResult message_start fired between
			// tool_execution_end and thinking_start should leave the suppression active.
			// If the role guard is bypassed, userInputPending would be 0 and thinking_start
			// would call setWorkingVisible(true) — which we can detect.
			const { handlers, ctx, ui } = setupExtension()

			handlers.turnStart({}, ctx)
			handlers.toolExecutionStart({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" }, ctx)
			handlers.toolExecutionEnd({ type: "tool_execution_end", toolCallId: "t1" }, ctx)
			// userInputPending = 1, spinner off.

			handlers.messageStart({ type: "message_start", message: { role: "toolResult", content: [] } }, ctx)
			// toolResult message_start must NOT have touched userInputPending.

			handlers.messageUpdate(messageUpdateEvent("thinking_start"), ctx)
			// If toolResult had decremented (the bug), userInputPending would be 0 and
			// thinking_start would call startIndicator → setWorkingVisible(true).
			// Since toolResult is a no-op, userInputPending stays 1, thinking_start is
			// suppressed, and no extra setWorkingVisible call happens.
			expect(callsTo(ui)).toEqual([true, true, false])
		})
	})
})
