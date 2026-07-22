import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LOOP_GUARD_EVENTS } from "./loop-guard-events.js"

type Handler = (...args: unknown[]) => Promise<unknown> | unknown

type ToolCallResult = { block?: boolean; reason?: string } | undefined

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

/** Run every registered handler for `event` in registration order,
 *  short-circuiting (like the pi-coding-agent extension runner's
 *  emitToolCall) the first time a handler returns `{ block: true }`.
 *  Handlers that return `{ block: false }` or undefined do not stop the
 *  chain. Returns the result of the last handler that ran. */
async function runToolCallHandlers(
	handlers: Map<string, Handler[]>,
	event: unknown,
): Promise<ToolCallResult> {
	const list = handlers.get("tool_call") ?? []
	let result: ToolCallResult
	for (const handler of list) {
		result = (await handler(event, {})) as ToolCallResult
		if (result?.block) return result
	}
	return result
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

describe("loop-guard + exploration-guard tool_call handler ordering", () => {
	beforeEach(() => {
		vi.resetModules()
		// exploration-guard imports these at module load time.
		vi.doMock("./agent-worker-context.js", () => ({ isAgentWorker: () => false }))
		vi.doMock("./permissions/mode-controller.js", () => ({
			createSessionPermissionFlagController: vi.fn(),
			getSessionPermissionsEnvKey: vi.fn(),
			clearPermissionMode: vi.fn(),
			setPermissionMode: vi.fn(),
			getPermissionMode: vi.fn(() => undefined),
		}))
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("a loop-guard-blocked tool_call still records the tool call in the exploration guard (no false no-tool steer)", async () => {
		// Register both extensions in cli.ts order: exploration guard FIRST,
		// then loop guard. The runner short-circuits emitToolCall on the first
		// { block: true }, so the exploration guard's handler (registered
		// first) runs before the loop guard can block.
		const { api, handlers } = createMockApi()
		const { default: explorationGuardExtension } = await import("./exploration-guard.js")
		const { default: loopGuardExtension } = await import("./loop-guard.js")
		explorationGuardExtension(api, { noToolWarnThreshold: 1, noToolSteerThreshold: 2 })
		loopGuardExtension(api)

		// session_start gives both extensions a ctx. The exploration guard's
		// isEnabled() reads ctx.sessionManager.getSessionId(); return a truthy id.
		const ctx = {
			sessionManager: { getSessionId: () => "test-session" },
			abort: vi.fn(),
		}
		await getHandler(handlers, "session_start")({}, ctx)

		// Drive a bash-repetition loop (12 identical non-error bash results) so
		// the loop guard fires a warn AND stores a blocked bash prefix.
		const command = "yt-dlp https://example.com/video"
		const bashResult = {
			toolName: "bash",
			input: { command },
			isError: false,
			content: [{ type: "text", text: "ok" }],
		}
		for (let i = 0; i < 12; i++) {
			await getHandler(handlers, "tool_result")(bashResult)
		}

		// Now simulate a turn whose ONLY tool call matches the blocked bash
		// prefix. Running the handlers in registration order: exploration guard
		// records the tool call (returns { block: false }), then loop guard
		// blocks it. The turn thus has a recorded tool call — consecutiveNoToolTurns
		// must NOT increment.
		const blockedCall = { toolName: "bash", input: { command } }
		getHandler(handlers, "turn_start")()
		const blockResult = await runToolCallHandlers(handlers, blockedCall)
		expect(blockResult?.block).toBe(true)
		await getHandler(handlers, "turn_end")()

		// After one blocked-only turn, no no-tool steer should have fired yet
		// (noToolWarnThreshold=1 would fire on the FIRST no-tool turn). Assert
		// the exploration guard did NOT send any no-tool steer for this turn.
		const sends = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls
		const noToolSteers = sends.filter(([msg]: unknown[]) =>
			typeof (msg as { content?: Array<{ text?: string }> })?.content?.[0]?.text === "string"
				&& ((msg as { content: Array<{ text: string }> }).content[0].text.includes("no tool calls")))
		expect(noToolSteers.length).toBe(0)

		// Sanity: a SECOND blocked-only turn should also NOT fire the mandatory
		// steer (noToolSteerThreshold=2). It would only fire if both turns were
		// miscounted as no-tool turns.
		getHandler(handlers, "turn_start")()
		const blockResult2 = await runToolCallHandlers(handlers, blockedCall)
		expect(blockResult2?.block).toBe(true)
		await getHandler(handlers, "turn_end")()
		const noToolSteers2 = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(([msg]: unknown[]) =>
			typeof (msg as { content?: Array<{ text?: string }> })?.content?.[0]?.text === "string"
				&& ((msg as { content: Array<{ text: string }> }).content[0].text.includes("You must use a tool this turn")))
		expect(noToolSteers2.length).toBe(0)
	})
})
