/**
 * Unit tests for `resolveBashTimeout` (pure helper) and integration tests
 * for the bash default-timeout extension's `tool_call` mutation.
 *
 * The test harness uses a minimal mock of `ExtensionAPI` that records
 * registered handlers, so we can fire `tool_call` events with a stub
 * `BashToolCallEvent` shape and assert on the mutation performed by the
 * handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let mockResourceEnabled = true

vi.mock("../resources/store.js", () => ({
	isResourceEnabled: (id: string) => (id === "extensions.bash-default-timeout" ? mockResourceEnabled : true),
}))

afterEach(() => {
	mockResourceEnabled = true
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PI = import("@earendil-works/pi-coding-agent").ExtensionAPI

interface MockPI {
	handlers: Record<string, Array<(event: unknown) => unknown>>
	on(event: string, handler: (event: unknown) => unknown): void
}

function createMockPI(): MockPI {
	const handlers: MockPI["handlers"] = {}
	return {
		handlers,
		on(event, handler) {
			if (!handlers[event]) handlers[event] = []
			handlers[event].push(handler)
		},
	}
}

interface BashEvent {
	toolName: string
	input: { command?: string; timeout?: number | null }
}

function fireToolCall(pi: MockPI, event: BashEvent): void {
	const handlers = pi.handlers.tool_call ?? []
	for (const handler of handlers) {
		handler(event)
	}
}

import bashDefaultTimeoutExtension, {
	BASH_DEFAULT_TIMEOUT_RESOURCE_ID,
	createSubagentBashClampExtension,
	DEFAULT_BASH_TIMEOUT_SECONDS,
	resolveBashTimeout,
} from "./bash-default-timeout.js"

describe("resolveBashTimeout", () => {
	it("returns the default when input is undefined", () => {
		expect(resolveBashTimeout(undefined)).toBe(DEFAULT_BASH_TIMEOUT_SECONDS)
	})

	it("returns the default when timeout is undefined", () => {
		expect(resolveBashTimeout({})).toBe(DEFAULT_BASH_TIMEOUT_SECONDS)
	})

	it("returns the default when timeout is null", () => {
		// RPC-decoded inputs commonly represent omitted fields as null;
		// treat that as "not set" so the fallback applies.
		expect(resolveBashTimeout({ timeout: null })).toBe(DEFAULT_BASH_TIMEOUT_SECONDS)
	})

	it("preserves an explicit positive timeout", () => {
		expect(resolveBashTimeout({ timeout: 5 })).toBe(5)
		expect(resolveBashTimeout({ timeout: 600 })).toBe(600)
	})

	it("preserves timeout=0 (upstream: no timeout)", () => {
		// Upstream bash treats `timeout <= 0` as "no timeout". Honouring
		// that contract is the whole point of "preserve explicit values" —
		// a user who sets 0 is asking for an unbounded run, and we must
		// not silently clamp it to the default.
		expect(resolveBashTimeout({ timeout: 0 })).toBe(0)
	})

	it("accepts a custom default for tests / call sites", () => {
		expect(resolveBashTimeout({}, 30)).toBe(30)
		expect(resolveBashTimeout({ timeout: 7 }, 30)).toBe(7)
	})
})

describe("bashDefaultTimeoutExtension", () => {
	it("registers a tool_call handler", () => {
		const pi = createMockPI()
		bashDefaultTimeoutExtension(pi as unknown as PI)
		expect(pi.handlers.tool_call).toBeDefined()
		expect(pi.handlers.tool_call.length).toBe(1)
	})

	it("fills in the default timeout when input.timeout is undefined", () => {
		const pi = createMockPI()
		bashDefaultTimeoutExtension(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "ls -la" },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(DEFAULT_BASH_TIMEOUT_SECONDS)
	})

	it("fills in the default timeout when input.timeout is null", () => {
		const pi = createMockPI()
		bashDefaultTimeoutExtension(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "ls -la", timeout: null },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(DEFAULT_BASH_TIMEOUT_SECONDS)
	})

	it("preserves an explicit positive timeout", () => {
		const pi = createMockPI()
		bashDefaultTimeoutExtension(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "slow-build", timeout: 600 },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(600)
	})

	it("preserves an explicit timeout of 0 (no timeout upstream)", () => {
		const pi = createMockPI()
		bashDefaultTimeoutExtension(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "long-poll", timeout: 0 },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(0)
	})

	it("ignores non-bash tool calls", () => {
		const pi = createMockPI()
		bashDefaultTimeoutExtension(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "read",
			input: {},
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBeUndefined()
	})

	it("is a no-op when the resource is disabled", () => {
		mockResourceEnabled = false
		const pi = createMockPI()
		bashDefaultTimeoutExtension(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "ls" },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBeUndefined()
	})

	it("mutates the input in place (not a copy)", () => {
		// The upstream `tool_call` contract documents that later handlers
		// see earlier mutations — i.e. the handler mutates the same object
		// the upstream tool reads from. Guard against accidental
		// reassignment to a new object.
		const pi = createMockPI()
		bashDefaultTimeoutExtension(pi as unknown as PI)
		const input: { command: string; timeout?: number } = { command: "ls" }
		const event: BashEvent = { toolName: "bash", input }
		fireToolCall(pi, event)
		expect(input.timeout).toBe(DEFAULT_BASH_TIMEOUT_SECONDS)
		expect(event.input).toBe(input)
	})
})

describe("createSubagentBashClampExtension", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
		mockResourceEnabled = true
	})

	it("registers a tool_call handler", () => {
		vi.setSystemTime(0)
		const pi = createMockPI()
		createSubagentBashClampExtension(60, 0)(pi as unknown as PI)
		expect(pi.handlers.tool_call).toBeDefined()
		expect(pi.handlers.tool_call.length).toBe(1)
	})

	it("fills in the default timeout when input.timeout is undefined", () => {
		// Plenty of budget: the default (120s) should win.
		vi.setSystemTime(0)
		const pi = createMockPI()
		createSubagentBashClampExtension(600, 0)(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "ls -la" },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(DEFAULT_BASH_TIMEOUT_SECONDS)
	})

	it("clamps the default timeout to the remaining budget", () => {
		// Started at t=0 with a 60s budget; 45s have elapsed, so 15s remain.
		// The default (120s) must be clamped down to 15s.
		vi.setSystemTime(45_000)
		const pi = createMockPI()
		createSubagentBashClampExtension(60, 0)(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "ls -la" },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(15)
	})

	it("preserves an explicit timeout smaller than the remaining budget", () => {
		// 600s budget, 0s elapsed: plenty of room. An explicit 5s is kept.
		vi.setSystemTime(0)
		const pi = createMockPI()
		createSubagentBashClampExtension(600, 0)(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "quick", timeout: 5 },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(5)
	})

	it("clamps an explicit timeout larger than the remaining budget", () => {
		// 60s budget, 45s elapsed => 15s remain. Explicit 600s is clamped.
		vi.setSystemTime(45_000)
		const pi = createMockPI()
		createSubagentBashClampExtension(60, 0)(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "slow-build", timeout: 600 },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(15)
	})

	it("preserves an explicit timeout of 0 (no timeout upstream)", () => {
		// Math.min(0, remaining) === 0, so the no-timeout contract survives.
		vi.setSystemTime(0)
		const pi = createMockPI()
		createSubagentBashClampExtension(60, 0)(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "long-poll", timeout: 0 },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(0)
	})

	it("floors at 1s when the budget is exhausted", () => {
		// Budget was 60s starting at t=0; we are now at t=120s (over budget).
		vi.setSystemTime(120_000)
		const pi = createMockPI()
		createSubagentBashClampExtension(60, 0)(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "ls" },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(1)
	})

	it("computes the deadline lazily at call time, not registration time", () => {
		// Register with a 60s budget at t=0, then advance the clock before
		// firing the event. The clamp must reflect the time elapsed since
		// registration, proving the deadline is read inside the handler.
		vi.setSystemTime(0)
		const pi = createMockPI()
		createSubagentBashClampExtension(60, 0)(pi as unknown as PI)
		vi.setSystemTime(50_000) // 10s remain
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "ls" },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(10)
	})

	it("ignores non-bash tool calls", () => {
		vi.setSystemTime(0)
		const pi = createMockPI()
		createSubagentBashClampExtension(60, 0)(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "read",
			input: {},
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBeUndefined()
	})

	it("is a no-op when the resource is disabled", () => {
		mockResourceEnabled = false
		vi.setSystemTime(0)
		const pi = createMockPI()
		createSubagentBashClampExtension(60, 0)(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "ls" },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBeUndefined()
	})
})

describe("R3 regression — subagent bash timeout clamped to max_duration", () => {
	// Reproduces the subagent budget bug: a subagent with max_duration=300s
	// issues a bash call whose explicit timeout (2400s) exceeds the
	// remaining budget. The clamp must bring it down to ≤ remaining.

	it("clamps explicit timeout=2400 to ≤ remaining budget when max_duration=300", () => {
		// Subagent started at t=0 with max_duration=300s.
		// 10s have elapsed, so 290s remain.
		vi.setSystemTime(10_000)
		const pi = createMockPI()
		createSubagentBashClampExtension(300, 0)(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "sleep 3600", timeout: 2400 },
		}
		fireToolCall(pi, event)
		// Must be clamped to the remaining budget (290s), not 2400.
		expect(event.input.timeout).toBe(290)
		expect(event.input.timeout).toBeLessThanOrEqual(300)
	})

	it("clamps default timeout (omitted) to ≤ remaining budget when max_duration=300", () => {
		// Same subagent, but the LLM omitted timeout — the default (120s)
		// would fit within 290s remaining, but we still assert it's ≤ 300.
		vi.setSystemTime(10_000)
		const pi = createMockPI()
		createSubagentBashClampExtension(300, 0)(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "ls -la" },
		}
		fireToolCall(pi, event)
		// Default is 120s, which is < 290s remaining, so it stays at 120.
		expect(event.input.timeout).toBe(DEFAULT_BASH_TIMEOUT_SECONDS)
		expect(event.input.timeout).toBeLessThanOrEqual(300)
	})

	it("clamps explicit timeout=2400 to ≤ max_duration when budget is nearly exhausted", () => {
		// 290s have elapsed of a 300s budget; only 10s remain.
		vi.setSystemTime(290_000)
		const pi = createMockPI()
		createSubagentBashClampExtension(300, 0)(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "sleep 3600", timeout: 2400 },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(10)
		expect(event.input.timeout).toBeLessThanOrEqual(300)
	})
})

describe("BASH_DEFAULT_TIMEOUT_RESOURCE_ID", () => {
	it("matches the resource registered in definitions.ts", () => {
		// Guard against typos that would silently disable the toggle:
		// changing one without the other breaks /resources UI wiring.
		expect(BASH_DEFAULT_TIMEOUT_RESOURCE_ID).toBe("extensions.bash-default-timeout")
	})
})
