/**
 * Tests for the subagent bash wall-clock clamp extension.
 */

import type { BashToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import {
	createSubagentBashClampExtension,
	DEFAULT_BASH_TIMEOUT_SECONDS,
	resolveBashTimeout,
	subagentBashDefaultTimeoutExtension,
} from "./subagent-bash-clamp.js"
import type { SubagentBashClampedPayload } from "./subagent-bash-clamp-events.js"

const ctx = createContext()

function bashEvent(input: Record<string, unknown>, toolName = "bash", toolCallId = "tc-1"): BashToolCallEvent {
	return { toolName, input, toolCallId } as unknown as BashToolCallEvent
}

function bashResultEvent(
	content: string,
	opts: { toolCallId?: string; isError?: boolean; toolName?: string; details?: unknown; usage?: unknown } = {},
): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: opts.toolName ?? "bash",
		toolCallId: opts.toolCallId ?? "tc-1",
		input: {},
		content: [{ type: "text", text: content }],
		isError: opts.isError ?? true,
		...(opts.details !== undefined ? { details: opts.details } : {}),
		...(opts.usage !== undefined ? { usage: opts.usage } : {}),
	} as unknown as ToolResultEvent
}

describe("resolveBashTimeout", () => {
	it("returns the default when input is undefined", () => {
		expect(resolveBashTimeout(undefined)).toBe(DEFAULT_BASH_TIMEOUT_SECONDS)
	})

	it("returns the default when timeout is absent or null", () => {
		expect(resolveBashTimeout({})).toBe(DEFAULT_BASH_TIMEOUT_SECONDS)
		expect(resolveBashTimeout({ timeout: null })).toBe(DEFAULT_BASH_TIMEOUT_SECONDS)
	})

	it("treats a non-positive timeout (upstream 'no timeout') as unset so the bound is not model-toggleable", () => {
		expect(resolveBashTimeout({ timeout: 0 })).toBe(DEFAULT_BASH_TIMEOUT_SECONDS)
		expect(resolveBashTimeout({ timeout: -10 })).toBe(DEFAULT_BASH_TIMEOUT_SECONDS)
	})

	it("preserves an explicit positive timeout", () => {
		expect(resolveBashTimeout({ timeout: 30 })).toBe(30)
		expect(resolveBashTimeout({ timeout: 0.5 })).toBe(0.5)
	})

	it("honours a custom default", () => {
		expect(resolveBashTimeout({}, 45)).toBe(45)
	})
})

describe("subagentBashDefaultTimeoutExtension", () => {
	it("fills in the default when timeout is absent", () => {
		const { api, getHandler } = createExtensionApi()
		subagentBashDefaultTimeoutExtension(api)
		const event = bashEvent({ command: "sleep 1" })
		getHandler("tool_call")(event, ctx)
		expect(event.input.timeout).toBe(DEFAULT_BASH_TIMEOUT_SECONDS)
	})

	it("treats an explicit non-positive timeout as absent", () => {
		const { api, getHandler } = createExtensionApi()
		subagentBashDefaultTimeoutExtension(api)
		const event = bashEvent({ timeout: 0 })
		getHandler("tool_call")(event, ctx)
		expect(event.input.timeout).toBe(DEFAULT_BASH_TIMEOUT_SECONDS)
	})

	it("preserves an explicit positive timeout", () => {
		const { api, getHandler } = createExtensionApi()
		subagentBashDefaultTimeoutExtension(api)
		const event = bashEvent({ timeout: 42 })
		getHandler("tool_call")(event, ctx)
		expect(event.input.timeout).toBe(42)
	})

	it("ignores non-bash tools", () => {
		const { api, getHandler } = createExtensionApi()
		subagentBashDefaultTimeoutExtension(api)
		const event = bashEvent({}, "read")
		getHandler("tool_call")(event, ctx)
		expect(event.input.timeout).toBeUndefined()
	})
})

describe("createSubagentBashClampExtension", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		return () => vi.useRealTimers()
	})

	/** Registers the clamp at t=0 (mirrors agent-runner's Date.now() at worker start), then fires at elapsedMs. */
	function clampAndFire(maxDurationSeconds: number, elapsedMs: number, event: BashToolCallEvent): void {
		vi.setSystemTime(0)
		const { api, getHandlers } = createExtensionApi()
		createSubagentBashClampExtension(maxDurationSeconds, Date.now())(api)
		const handlers = getHandlers<BashToolCallEvent>("tool_call")
		expect(handlers).toHaveLength(1)
		vi.setSystemTime(elapsedMs)
		handlers[0](event, ctx)
	}

	it("registers a tool_call handler", () => {
		vi.setSystemTime(0)
		const { api, getHandlers } = createExtensionApi()
		createSubagentBashClampExtension(60, 0)(api)
		expect(getHandlers("tool_call")).toHaveLength(1)
	})

	it("applies the default timeout when absent and budget remains", () => {
		const event = bashEvent({ command: "sleep 1" })
		clampAndFire(600, 0, event)
		expect(event.input.timeout).toBe(DEFAULT_BASH_TIMEOUT_SECONDS)
	})

	it("clamps the timeout to the remaining max_duration budget", () => {
		const event = bashEvent({ command: "sleep 30" })
		clampAndFire(60, 50_000, event) // 10s remain of the 60s budget
		expect(event.input.timeout).toBe(10)
	})

	it("clamps an explicit timeout that exceeds the remaining budget", () => {
		const event = bashEvent({ timeout: 120 })
		clampAndFire(60, 45_000, event) // 15s remain
		expect(event.input.timeout).toBe(15)
	})

	it("clamps an explicit non-positive timeout instead of honouring 'no timeout'", () => {
		// 15s remain; without containment Math.min(0, 15) = 0 would mean "no timeout"
		const event = bashEvent({ timeout: 0 })
		clampAndFire(60, 45_000, event)
		expect(event.input.timeout).toBe(15)
	})

	it("preserves an explicit timeout below the remaining budget", () => {
		const event = bashEvent({ timeout: 30 })
		clampAndFire(600, 0, event)
		expect(event.input.timeout).toBe(30)
	})

	it("floors at 1s when the budget is exhausted", () => {
		const event = bashEvent({ command: "sleep 5" })
		clampAndFire(60, 120_000, event) // budget (60s) is well past
		expect(event.input.timeout).toBe(1)
	})

	it("ignores non-bash tools", () => {
		const event = bashEvent({}, "read")
		clampAndFire(60, 0, event)
		expect(event.input.timeout).toBeUndefined()
	})

	it("with maxDuration=0 the budget is exhausted at t=0 (contract: agent-runner guards with effectiveMaxDuration > 0)", () => {
		const event = bashEvent({ command: "sleep 1" })
		clampAndFire(0, 0, event)
		expect(event.input.timeout).toBe(1)
	})
})

describe("createSubagentBashClampExtension clamp events", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		return () => vi.useRealTimers()
	})

	/** Registers the clamp (with optional agent type) at t=0, fires at elapsedMs,
	 *  and returns the pi.events emit calls the fire produced. */
	function clampAndCapture(
		maxDurationSeconds: number,
		elapsedMs: number,
		event: BashToolCallEvent,
		agentType?: string,
	): Array<[string, SubagentBashClampedPayload]> {
		vi.setSystemTime(0)
		const { api, getHandlers, emitEvent } = createExtensionApi()
		createSubagentBashClampExtension(maxDurationSeconds, Date.now(), agentType)(api)
		vi.setSystemTime(elapsedMs)
		getHandlers<BashToolCallEvent>("tool_call")[0](event, ctx)
		return emitEvent.mock.calls as Array<[string, SubagentBashClampedPayload]>
	}

	it("publishes subagent_bash_clamp:clamped when the budget tail clamps the timeout", () => {
		const event = bashEvent({ command: "sleep 30" })
		const calls = clampAndCapture(60, 50_000, event) // 10s remain of the 60s budget
		expect(calls).toHaveLength(1)
		const [channel, payload] = calls[0]
		expect(channel).toBe("subagent_bash_clamp:clamped")
		expect(payload).toEqual({
			toolCallId: "tc-1",
			reason: "budget_tail",
			requestedTimeoutS: DEFAULT_BASH_TIMEOUT_SECONDS,
			clampedToS: 10,
			remainingMs: 10_000,
		})
	})

	it("publishes budget_exhausted when the floor at 1s fires", () => {
		const event = bashEvent({ timeout: 120 })
		const calls = clampAndCapture(60, 120_000, event) // 60s past the deadline
		expect(calls).toHaveLength(1)
		const [channel, payload] = calls[0]
		expect(channel).toBe("subagent_bash_clamp:clamped")
		expect(payload).toEqual({
			toolCallId: "tc-1",
			reason: "budget_exhausted",
			requestedTimeoutS: 120,
			clampedToS: 1,
			remainingMs: -60_000,
		})
	})

	it("forwards the agent type on the payload", () => {
		const event = bashEvent({ command: "sleep 30" })
		const calls = clampAndCapture(60, 50_000, event, "general-purpose")
		expect(calls).toHaveLength(1)
		expect(calls[0][1].agentType).toBe("general-purpose")
	})

	it("does not publish when no clamping happened (timeout preserved)", () => {
		const event = bashEvent({ timeout: 30 })
		const calls = clampAndCapture(600, 0, event) // 600s remain
		expect(event.input.timeout).toBe(30)
		expect(calls).toHaveLength(0)
	})

	it("does not publish when the exhausted floor does not reduce the timeout", () => {
		// Model asked for 0.5s; the exhausted floor raises it to 1 — no reduction.
		const event = bashEvent({ timeout: 0.5 })
		const calls = clampAndCapture(60, 120_000, event)
		expect(event.input.timeout).toBe(1)
		expect(calls).toHaveLength(0)
	})

	it("does not publish for non-bash tools", () => {
		const event = bashEvent({}, "read")
		const calls = clampAndCapture(60, 50_000, event)
		expect(calls).toHaveLength(0)
	})
})

describe("subagentBashDefaultTimeoutExtension clamp events", () => {
	it("never publishes clamp events (no budget to clamp against)", () => {
		const { api, getHandler, emitEvent } = createExtensionApi()
		subagentBashDefaultTimeoutExtension(api)
		const event = bashEvent({ command: "sleep 1" })
		getHandler("tool_call")(event, ctx)
		expect(event.input.timeout).toBe(DEFAULT_BASH_TIMEOUT_SECONDS)
		expect(emitEvent.mock.calls).toHaveLength(0)
	})
})

describe("createSubagentBashClampExtension result annotation", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		return () => vi.useRealTimers()
	})

	/** Registers the clamp at t=0, fires the tool_call at elapsedMs (creating
	 *  a clamp fact), and returns the tool_result handler + a re-fire helper. */
	function setupClampedCall(maxDurationSeconds: number, elapsedMs: number, event: BashToolCallEvent) {
		vi.setSystemTime(0)
		const { api, getHandlers, getHandler } = createExtensionApi()
		createSubagentBashClampExtension(maxDurationSeconds, Date.now())(api)
		vi.setSystemTime(elapsedMs)
		getHandlers<BashToolCallEvent>("tool_call")[0](event, ctx)
		return getHandler("tool_result")
	}

	it("appends the direct-address exhausted note to a clamp-killed timeout result", () => {
		const handler = setupClampedCall(60, 120_000, bashEvent({ command: "sleep 5" })) // budget exhausted
		const result = handler(
			bashResultEvent("partial output\n\nCommand timed out after 1 seconds", {
				details: { truncation: true },
				usage: { input: 1 },
			}),
			ctx,
		) as unknown as { content: Array<{ type: string; text: string }>; details: unknown; usage: unknown }

		expect(result).toBeDefined()
		expect(result.content).toHaveLength(2)
		expect(result.content[0].text).toContain("Command timed out after 1 seconds")
		expect(result.content[1].text).toContain("You have reached your wall-clock time budget")
		expect(result.content[1].text).toContain("Do not retry commands")
		// details and usage have no fallback in upstream's afterToolCall — they
		// must be passed through, not dropped.
		expect(result.details).toEqual({ truncation: true })
		expect(result.usage).toEqual({ input: 1 })
	})

	it("appends the tail note with the budget recomputed at result time", () => {
		// Clamped to 10s at t=50s; the result arrives at t=54s (e.g. echoed
		// timeout text from a nested process) — the note must report the 6s
		// remaining NOW, not the 10s the clamp was computed from.
		const handler = setupClampedCall(60, 50_000, bashEvent({ command: "sleep 30" }))
		vi.setSystemTime(54_000)
		const result = handler(bashResultEvent("Command timed out after 10 seconds"), ctx) as unknown as {
			content: Array<{ type: string; text: string }>
		}

		expect(result).toBeDefined()
		expect(result.content[1].text).toContain("roughly 6s remain")
		expect(result.content[1].text).toContain("summarize your progress for the orchestrator")
	})

	it("switches to the exhausted note when the budget is spent by result time", () => {
		// Clamped to 10s at t=50s; the command ran the full tail and the result
		// arrives past the deadline — "roughly 10s remain" would overstate.
		const handler = setupClampedCall(60, 50_000, bashEvent({ command: "sleep 30" }))
		vi.setSystemTime(61_000)
		const result = handler(bashResultEvent("Command timed out after 10 seconds"), ctx) as unknown as {
			content: Array<{ type: string; text: string }>
		}

		expect(result).toBeDefined()
		expect(result.content[1].text).toContain("You have reached your wall-clock time budget")
		expect(result.content[1].text).toContain("Do not retry commands")
	})

	it("does not annotate a non-timeout failure on a clamped call", () => {
		const handler = setupClampedCall(60, 120_000, bashEvent({ command: "false" }))
		const result = handler(bashResultEvent("command failed with exit code 1"), ctx)
		expect(result).toBeUndefined()
	})

	it("does not annotate a timeout for a call that was NOT clamped (model-requested)", () => {
		const handler = setupClampedCall(600, 0, bashEvent({ timeout: 30 })) // preserved, no clamp
		const result = handler(bashResultEvent("Command timed out after 30 seconds"), ctx)
		expect(result).toBeUndefined()
	})

	it("does not annotate non-bash results", () => {
		const handler = setupClampedCall(60, 50_000, bashEvent({ command: "sleep 30" }))
		const result = handler(bashResultEvent("Command timed out after 10 seconds", { toolName: "read" }), ctx)
		expect(result).toBeUndefined()
	})

	it("releases the clamp marker after the result (second result for the same call is untouched)", () => {
		const handler = setupClampedCall(60, 120_000, bashEvent({ command: "sleep 5" }))
		expect(handler(bashResultEvent("Command timed out after 1 seconds"), ctx)).toBeDefined()
		expect(handler(bashResultEvent("Command timed out after 1 seconds"), ctx)).toBeUndefined()
	})

	it("does not annotate a successful result on a clamped call", () => {
		const handler = setupClampedCall(60, 50_000, bashEvent({ command: "echo hi" })) // 10s remain, echo fits
		const result = handler(bashResultEvent("hi", { isError: false }), ctx)
		expect(result).toBeUndefined()
	})
})
