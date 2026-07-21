import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LOOP_GUARD_EVENTS } from "./loop-guard-events.js"

type Handler = (...args: unknown[]) => Promise<unknown> | unknown

function createMockApi(events?: {
	emit: (ch: string, data: unknown) => void
	on: (ch: string, fn: (d: unknown) => void) => () => void
}) {
	const handlers = new Map<string, Handler[]>()
	const on = vi.fn((event: string, handler: Handler) => {
		if (!handlers.has(event)) handlers.set(event, [])
		handlers.get(event)?.push(handler)
	})
	const defaultEvents = {
		emit: vi.fn(),
		on: vi.fn(() => () => {}),
	}
	const api = {
		on,
		events: events ?? defaultEvents,
		sendMessage: vi.fn(),
	} as unknown as ExtensionAPI
	return { api, handlers, events: events ?? defaultEvents }
}

function getHandler(handlers: Map<string, Handler[]>, event: string): Handler {
	const list = handlers.get(event)
	if (!list || list.length === 0) throw new Error(`No handler for ${event}`)
	return list[list.length - 1]
}

describe("loopGuardExtension telemetry", () => {
	beforeEach(() => {
		vi.resetModules()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("emits LOOP_GUARD_EVENTS.WARN on a warn via pi.events.emit", async () => {
		const { api, handlers, events } = createMockApi()
		const emitSpy = events.emit as ReturnType<typeof vi.fn>
		const { default: loopGuardExtension } = await import("./loop-guard.js")

		loopGuardExtension(api)

		// session_start gives us a ctx (needed for ctx.abort on abort path)
		await getHandler(handlers, "session_start")({}, { abort: vi.fn() })

		// Feed 3 identical error outputs to trigger consecutive_identical warn.
		const toolResult = {
			toolName: "bash",
			input: { command: "ls" },
			isError: true,
			content: [{ type: "text", text: "error output" }],
		}
		getHandler(handlers, "tool_result")(toolResult)
		getHandler(handlers, "tool_result")(toolResult)
		getHandler(handlers, "tool_result")(toolResult)

		// The warn emit should have fired with the right channel + payload.
		const warnCalls = emitSpy.mock.calls.filter(([ch]: unknown[]) => ch === LOOP_GUARD_EVENTS.WARN)
		expect(warnCalls.length).toBe(1)
		const payload = warnCalls[0][1] as { detector: string; count: number; is_subagent: boolean }
		expect(payload.detector).toBe("consecutive_identical")
		expect(payload.count).toBe(1)
		expect(payload.is_subagent).toBe(false)
	})

	it("emits LOOP_GUARD_EVENTS.SUBAGENT_ABORT in the turn_end abort path", async () => {
		// Mock isAgentWorker to return true so subagentAbortPending is set.
		vi.doMock("./agent-worker-context.js", () => ({ isAgentWorker: () => true }))

		const { api, handlers, events } = createMockApi()
		const emitSpy = events.emit as ReturnType<typeof vi.fn>
		const abortFn = vi.fn()
		const { default: loopGuardExtension } = await import("./loop-guard.js")

		loopGuardExtension(api)
		await getHandler(handlers, "session_start")({}, { abort: abortFn })

		// Trigger a warn (3 identical error outputs).
		const toolResult = {
			toolName: "bash",
			input: { command: "ls" },
			isError: true,
			content: [{ type: "text", text: "error output" }],
		}
		getHandler(handlers, "tool_result")(toolResult)
		getHandler(handlers, "tool_result")(toolResult)
		getHandler(handlers, "tool_result")(toolResult)

		// The warn emit should have fired with is_subagent: true (since we mocked isAgentWorker).
		const warnCalls = emitSpy.mock.calls.filter(([ch]: unknown[]) => ch === LOOP_GUARD_EVENTS.WARN)
		expect(warnCalls.length).toBe(1)
		expect((warnCalls[0][1] as { is_subagent: boolean }).is_subagent).toBe(true)

		// turn_end should fire the abort + SUBAGENT_ABORT event.
		getHandler(handlers, "turn_end")()

		const abortCalls = emitSpy.mock.calls.filter(([ch]: unknown[]) => ch === LOOP_GUARD_EVENTS.SUBAGENT_ABORT)
		expect(abortCalls.length).toBe(1)
		const abortPayload = abortCalls[0][1] as { detector: string; count: number; is_subagent: boolean }
		expect(abortPayload.detector).toBe("consecutive_identical")
		expect(abortPayload.count).toBe(1)
		expect(abortPayload.is_subagent).toBe(true)
		expect(abortFn).toHaveBeenCalled()
	})

	it("no-ops silently when pi.events is undefined (does not throw)", async () => {
		const handlers = new Map<string, Handler[]>()
		const on = vi.fn((event: string, handler: Handler) => {
			if (!handlers.has(event)) handlers.set(event, [])
			handlers.get(event)?.push(handler)
		})
		// pi.events is undefined — simulates older pi-coding-agent versions.
		const api = { on, sendMessage: vi.fn() } as unknown as ExtensionAPI
		const { default: loopGuardExtension } = await import("./loop-guard.js")

		// Should not throw.
		expect(() => loopGuardExtension(api)).not.toThrow()

		await getHandler(handlers, "session_start")({}, { abort: vi.fn() })

		// Feed 3 identical error outputs to trigger a warn.
		const toolResult = {
			toolName: "bash",
			input: { command: "ls" },
			isError: true,
			content: [{ type: "text", text: "error output" }],
		}
		// These should not throw despite pi.events being undefined.
		expect(() => getHandler(handlers, "tool_result")(toolResult)).not.toThrow()
		expect(() => getHandler(handlers, "tool_result")(toolResult)).not.toThrow()
		expect(() => getHandler(handlers, "tool_result")(toolResult)).not.toThrow()
	})
})

describe("loopGuardExtension escalating steer messages", () => {
	beforeEach(() => {
		vi.resetModules()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	/** Feed N identical failing bash tool_result events. The
	 *  consecutive_identical signature detector fires on the 3rd call; each
	 *  warn clears the window counters, so feeding 3 more re-fires. This
	 *  exercises the escalating steer prefix (buildSteerPrefix) the same way
	 *  the reverted stuck_session backstop used to, but via a real loop
	 *  signal — the only mechanism left to trigger escalation. */
	function feedIdenticalFailures(handlers: Map<string, Handler[]>, n: number): void {
		const toolResult = {
			toolName: "bash",
			input: { command: "ls" },
			isError: true,
			content: [{ type: "text", text: "error output" }],
		}
		for (let i = 0; i < n; i++) {
			getHandler(handlers, "tool_result")(toolResult)
		}
	}

	/** Extract the text of every loop-guard-steer sendMessage, in order. */
	function steerTexts(sendMessage: ReturnType<typeof vi.fn>): string[] {
		return sendMessage.mock.calls
			.filter(([msg]: unknown[]) => (msg as { customType?: string })?.customType === "loop-guard-steer")
			.map(([msg]: unknown[]) => ((msg as { content: Array<{ text: string }> }).content[0]?.text ?? ""))
	}

	it("first signature fire sends the unchanged first-fire steer text", async () => {
		const { api, handlers } = createMockApi()
		const { default: loopGuardExtension } = await import("./loop-guard.js")
		loopGuardExtension(api)
		await getHandler(handlers, "session_start")({}, { abort: vi.fn() })

		feedIdenticalFailures(handlers, 3)

		const texts = steerTexts(api.sendMessage as ReturnType<typeof vi.fn>)
		expect(texts.length).toBe(1)
		expect(texts[0]).toContain("STOP and change your approach")
		expect(texts[0]).toContain("consecutive identical calls")
	})

	it("second fire sends the escalated warnCount===2 message", async () => {
		const { api, handlers } = createMockApi()
		const { default: loopGuardExtension } = await import("./loop-guard.js")
		loopGuardExtension(api)
		await getHandler(handlers, "session_start")({}, { abort: vi.fn() })

		feedIdenticalFailures(handlers, 6)

		const texts = steerTexts(api.sendMessage as ReturnType<typeof vi.fn>)
		expect(texts.length).toBe(2)
		expect(texts[0]).toContain("STOP and change your approach")
		expect(texts[1]).toContain("Second loop warning")
		expect(texts[1]).toContain("not converging")
	})

	it("third fire sends the warnCount>=3 message with #3 and ignored-count", async () => {
		const { api, handlers } = createMockApi()
		const { default: loopGuardExtension } = await import("./loop-guard.js")
		loopGuardExtension(api)
		await getHandler(handlers, "session_start")({}, { abort: vi.fn() })

		feedIdenticalFailures(handlers, 9)

		const texts = steerTexts(api.sendMessage as ReturnType<typeof vi.fn>)
		expect(texts.length).toBe(3)
		expect(texts[2]).toContain("Loop warning #3")
		expect(texts[2]).toContain("ignored 2 previous loop-guard steers")
	})
})
