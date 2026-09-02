/**
 * Tests for the subagent bash wall-clock clamp extension.
 */

import type { BashToolCallEvent } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import {
	createSubagentBashClampExtension,
	DEFAULT_BASH_TIMEOUT_SECONDS,
	resolveBashTimeout,
	subagentBashDefaultTimeoutExtension,
} from "./subagent-bash-clamp.js"

const ctx = createContext()

function bashEvent(input: Record<string, unknown>, toolName = "bash"): BashToolCallEvent {
	return { toolName, input } as unknown as BashToolCallEvent
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
