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

	it("stuck_session backstop does NOT abort a subagent (advisory-only, per spec)", async () => {
		// Regression test for S1: the stuck_session backstop is advisory-only.
		// A backstop fire in a subagent must emit the WARN event and the steer
		// message (advisory) but must NOT set subagentAbortPending — so no
		// SUBAGENT_ABORT event and no ctx.abort() at turn_end. Signature
		// detectors (e.g. consecutive_identical) retain the existing abort
		// behavior (covered by the test above).
		vi.doMock("./agent-worker-context.js", () => ({ isAgentWorker: () => true }))

		const { api, handlers, events } = createMockApi()
		const emitSpy = events.emit as ReturnType<typeof vi.fn>
		const abortFn = vi.fn()
		const { default: loopGuardExtension } = await import("./loop-guard.js")

		loopGuardExtension(api)
		await getHandler(handlers, "session_start")({}, { abort: abortFn })

		// Feed 40 varied tool_result events to trigger the stuck_session
		// backstop (no signature detector can match because every record is
		// unique). Same shape as the variedToolResult helper below.
		const tools = ["bash", "read", "grep", "edit", "write"]
		function variedToolResult(i: number) {
			return {
				toolName: tools[i % tools.length],
				input: { command: `unique-${i}`, path: `/tmp/f-${i}.txt`, pattern: `p-${i}` },
				isError: i % 2 === 0,
				content: [{ type: "text", text: `output-${i}` }],
			}
		}
		for (let i = 0; i < 40; i++) {
			getHandler(handlers, "tool_result")(variedToolResult(i))
		}

		// The WARN event fires (advisory) with is_subagent: true and the
		// stuck_session detector — the backstop is still reported to telemetry.
		const warnCalls = emitSpy.mock.calls.filter(([ch]: unknown[]) => ch === LOOP_GUARD_EVENTS.WARN)
		expect(warnCalls.length).toBe(1)
		const warnPayload = warnCalls[0][1] as { detector: string; count: number; is_subagent: boolean }
		expect(warnPayload.detector).toBe("stuck_session")
		expect(warnPayload.is_subagent).toBe(true)

		// The steer message is sent (advisory) with the first-fire text.
		const sendCalls = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
			([msg]: unknown[]) => (msg as { customType?: string })?.customType === "loop-guard-steer",
		)
		expect(sendCalls.length).toBe(1)

		// turn_end must NOT abort the subagent: no SUBAGENT_ABORT event, no ctx.abort().
		getHandler(handlers, "turn_end")()
		const abortCalls = emitSpy.mock.calls.filter(([ch]: unknown[]) => ch === LOOP_GUARD_EVENTS.SUBAGENT_ABORT)
		expect(abortCalls.length).toBe(0)
		expect(abortFn).not.toHaveBeenCalled()

		// Escalation is exercised in the subagent path: 20 more varied records
		// trigger the 2nd backstop fire with the escalated (warnCount===2) text.
		for (let i = 40; i < 60; i++) {
			getHandler(handlers, "tool_result")(variedToolResult(i))
		}
		const warnCalls2 = emitSpy.mock.calls.filter(([ch]: unknown[]) => ch === LOOP_GUARD_EVENTS.WARN)
		expect(warnCalls2.length).toBe(2)
		expect((warnCalls2[1][1] as { count: number }).count).toBe(2)
		const sendCalls2 = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
			([msg]: unknown[]) => (msg as { customType?: string })?.customType === "loop-guard-steer",
		)
		expect(sendCalls2.length).toBe(2)
		const secondText = ((sendCalls2[1][0] as { content: Array<{ text: string }> }).content[0]?.text ?? "")
		expect(secondText).toContain("Second loop warning")

		// Still no abort after the 2nd backstop fire.
		getHandler(handlers, "turn_end")()
		const abortCalls2 = emitSpy.mock.calls.filter(([ch]: unknown[]) => ch === LOOP_GUARD_EVENTS.SUBAGENT_ABORT)
		expect(abortCalls2.length).toBe(0)
		expect(abortFn).not.toHaveBeenCalled()
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

	/** Produce a varied tool_result event whose toolName/input/content differ
	 *  per index so no signature detector can match — only the backstop fires. */
	function variedToolResult(i: number) {
		const tools = ["bash", "read", "grep", "edit", "write"]
		return {
			toolName: tools[i % tools.length],
			input: { command: `unique-${i}`, path: `/tmp/f-${i}.txt`, pattern: `p-${i}` },
			isError: i % 2 === 0,
			content: [{ type: "text", text: `output-${i}` }],
		}
	}

	/** Extract the text of every loop-guard-steer sendMessage, in order. */
	function steerTexts(sendMessage: ReturnType<typeof vi.fn>): string[] {
		return sendMessage.mock.calls
			.filter(([msg]: unknown[]) => (msg as { customType?: string })?.customType === "loop-guard-steer")
			.map(([msg]: unknown[]) => ((msg as { content: Array<{ text: string }> }).content[0]?.text ?? ""))
	}

	it("first backstop fire (call 40) sends the unchanged first-fire steer text", async () => {
		const { api, handlers } = createMockApi()
		const { default: loopGuardExtension } = await import("./loop-guard.js")
		loopGuardExtension(api)
		await getHandler(handlers, "session_start")({}, { abort: vi.fn() })

		for (let i = 0; i < 40; i++) {
			getHandler(handlers, "tool_result")(variedToolResult(i))
		}

		const texts = steerTexts(api.sendMessage as ReturnType<typeof vi.fn>)
		expect(texts.length).toBe(1)
		expect(texts[0]).toContain("STOP and change your approach")
		expect(texts[0]).toContain("stuck session")
		expect(texts[0]).toContain("40 tool calls")
	})

	it("second fire (20 calls later) sends the escalated warnCount===2 message", async () => {
		const { api, handlers } = createMockApi()
		const { default: loopGuardExtension } = await import("./loop-guard.js")
		loopGuardExtension(api)
		await getHandler(handlers, "session_start")({}, { abort: vi.fn() })

		for (let i = 0; i < 60; i++) {
			getHandler(handlers, "tool_result")(variedToolResult(i))
		}

		const texts = steerTexts(api.sendMessage as ReturnType<typeof vi.fn>)
		expect(texts.length).toBe(2)
		expect(texts[0]).toContain("STOP and change your approach")
		expect(texts[1]).toContain("Second loop warning")
		expect(texts[1]).toContain("not converging")
	})

	it("third fire (20 more calls) sends the warnCount>=3 message with #3 and ignored-count", async () => {
		const { api, handlers } = createMockApi()
		const { default: loopGuardExtension } = await import("./loop-guard.js")
		loopGuardExtension(api)
		await getHandler(handlers, "session_start")({}, { abort: vi.fn() })

		for (let i = 0; i < 80; i++) {
			getHandler(handlers, "tool_result")(variedToolResult(i))
		}

		const texts = steerTexts(api.sendMessage as ReturnType<typeof vi.fn>)
		expect(texts.length).toBe(3)
		expect(texts[2]).toContain("Loop warning #3")
		expect(texts[2]).toContain("ignored 2 previous loop-guard steers")
	})
})
