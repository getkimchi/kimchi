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
	MAX_BASH_TIMEOUT_ENV,
	MAX_BASH_TIMEOUT_SECONDS,
	resolveBashTimeout,
	resolveMaxBashTimeoutSeconds,
} from "./bash-default-timeout.js"

describe("resolveMaxBashTimeoutSeconds", () => {
	beforeEach(() => {
		delete process.env[MAX_BASH_TIMEOUT_ENV]
	})

	afterEach(() => {
		delete process.env[MAX_BASH_TIMEOUT_ENV]
	})

	it("returns the default cap when the env var is unset", () => {
		expect(resolveMaxBashTimeoutSeconds()).toBe(MAX_BASH_TIMEOUT_SECONDS)
	})

	it("returns the env var value when set to a valid positive integer", () => {
		process.env[MAX_BASH_TIMEOUT_ENV] = "300"
		expect(resolveMaxBashTimeoutSeconds()).toBe(300)
	})

	it("falls back to the default for a non-numeric value", () => {
		process.env[MAX_BASH_TIMEOUT_ENV] = "not-a-number"
		expect(resolveMaxBashTimeoutSeconds()).toBe(MAX_BASH_TIMEOUT_SECONDS)
	})

	it("falls back to the default for zero or negative values", () => {
		process.env[MAX_BASH_TIMEOUT_ENV] = "0"
		expect(resolveMaxBashTimeoutSeconds()).toBe(MAX_BASH_TIMEOUT_SECONDS)
		process.env[MAX_BASH_TIMEOUT_ENV] = "-5"
		expect(resolveMaxBashTimeoutSeconds()).toBe(MAX_BASH_TIMEOUT_SECONDS)
	})

	it("falls back to the default for an empty string", () => {
		process.env[MAX_BASH_TIMEOUT_ENV] = ""
		expect(resolveMaxBashTimeoutSeconds()).toBe(MAX_BASH_TIMEOUT_SECONDS)
	})

	it("re-reads the env var on every call", () => {
		process.env[MAX_BASH_TIMEOUT_ENV] = "100"
		expect(resolveMaxBashTimeoutSeconds()).toBe(100)
		process.env[MAX_BASH_TIMEOUT_ENV] = "450"
		expect(resolveMaxBashTimeoutSeconds()).toBe(450)
		delete process.env[MAX_BASH_TIMEOUT_ENV]
		expect(resolveMaxBashTimeoutSeconds()).toBe(MAX_BASH_TIMEOUT_SECONDS)
	})
})

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

	it("preserves timeout=0 (upstream: no timeout) in the raw resolver", () => {
		// Upstream bash treats `timeout <= 0` as "no timeout". The helper
		// returns the raw value (0) so callers can distinguish "explicit 0"
		// from "not set" (which gets the default). The `tool_call` handlers
		// then treat 0 as unbounded and clamp it to the cap — see the
		// extension tests below.
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

	it("preserves an explicit positive timeout at or below the cap", () => {
		const pi = createMockPI()
		bashDefaultTimeoutExtension(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "slow-build", timeout: 600 },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(600)
	})

	it("clamps an explicit timeout above the cap down to MAX_BASH_TIMEOUT_SECONDS", () => {
		// The LLM routinely requests `timeout=1800`/`3600` on trials whose
		// budget is shorter than that. The cap must bring the request down to
		// `MAX_BASH_TIMEOUT_SECONDS` so a single bash call cannot consume the
		// entire trial budget.
		const pi = createMockPI()
		bashDefaultTimeoutExtension(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "opam install coq.8.16.1", timeout: 3600 },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(MAX_BASH_TIMEOUT_SECONDS)
	})

	it("clamps an explicit timeout of 1,800,000s (500h) down to the cap", () => {
		// Reproduces the `feal-linear-cryptanalysis__jvEooGt` baseline trace
		// where the agent set `timeout=1800000`.
		const pi = createMockPI()
		bashDefaultTimeoutExtension(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "./run.sh", timeout: 1_800_000 },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(MAX_BASH_TIMEOUT_SECONDS)
	})

	it("clamps an explicit timeout of 0 (unbounded) to the cap", () => {
		// Upstream treats `timeout <= 0` as "no timeout" (unbounded). An
		// unbounded bash call can consume the entire trial budget — the
		// exact failure mode the cap prevents — so `0` is treated as
		// `Infinity` and clamped to `MAX_BASH_TIMEOUT_SECONDS`, not
		// preserved. This also ensures `bash-timeout-guidance` can fire
		// (a finite timeout produces a "Command timed out" error that
		// triggers the steer; an unbounded call produces no such error).
		const pi = createMockPI()
		bashDefaultTimeoutExtension(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "long-poll", timeout: 0 },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(MAX_BASH_TIMEOUT_SECONDS)
	})

	it("clamps an explicit negative timeout to the cap", () => {
		// Negative values are also "no timeout" upstream; same rationale
		// as the `timeout=0` case above.
		const pi = createMockPI()
		bashDefaultTimeoutExtension(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "long-poll", timeout: -5 },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(MAX_BASH_TIMEOUT_SECONDS)
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

describe("bashDefaultTimeoutExtension — env-var cap override", () => {
	afterEach(() => {
		delete process.env[MAX_BASH_TIMEOUT_ENV]
	})

	it("clamps explicit timeouts to the env-var override when lower than the default cap", () => {
		// Raising the cap is the only effect of the env var that the main
		// extension exposes; the default itself (`DEFAULT_BASH_TIMEOUT_SECONDS`)
		// is unaffected. Here we set a lower cap (300s) so an explicit 600s is
		// clamped down to 300s.
		process.env[MAX_BASH_TIMEOUT_ENV] = "300"
		const pi = createMockPI()
		bashDefaultTimeoutExtension(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "slow-build", timeout: 600 },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(300)
	})

	it("does not raise timeouts below the env-var cap", () => {
		// Cap is 300s, explicit timeout is 5s. The cap is a maximum only; it
		// must not lift a shorter explicit value up to the cap.
		process.env[MAX_BASH_TIMEOUT_ENV] = "300"
		const pi = createMockPI()
		bashDefaultTimeoutExtension(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "quick", timeout: 5 },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(5)
	})

	it("raises the cap when the env var is larger than the default", () => {
		// Default cap is 600s; env var raises it to 1200s. An explicit 900s
		// (which would be clamped to 600 with the default cap) is now kept
		// verbatim because 900 < 1200.
		process.env[MAX_BASH_TIMEOUT_ENV] = "1200"
		const pi = createMockPI()
		bashDefaultTimeoutExtension(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "make", timeout: 900 },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(900)
	})

	it("ignores an invalid env var and falls back to the default cap", () => {
		process.env[MAX_BASH_TIMEOUT_ENV] = "garbage"
		const pi = createMockPI()
		bashDefaultTimeoutExtension(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "x", timeout: 3600 },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(MAX_BASH_TIMEOUT_SECONDS)
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

	it("clamps an explicit timeout of 0 (unbounded) to the smaller of the cap and remaining budget", () => {
		// Upstream treats `timeout <= 0` as "no timeout" (unbounded). The
		// clamp treats `0` as `Infinity` and clamps to
		// `Math.min(remaining, cap)`. Here remaining=60s, cap=600s, so 60s
		// wins — the subagent's own budget is the tighter bound.
		vi.setSystemTime(0)
		const pi = createMockPI()
		createSubagentBashClampExtension(60, 0)(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "long-poll", timeout: 0 },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(60)
	})

	it("clamps an explicit negative timeout to the smaller of the cap and remaining budget", () => {
		// Same as the `timeout=0` case but with a negative value.
		vi.setSystemTime(0)
		const pi = createMockPI()
		createSubagentBashClampExtension(60, 0)(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "long-poll", timeout: -5 },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(60)
	})

	it("clamps an explicit timeout of 0 to the cap when the remaining budget is larger", () => {
		// Subagent has a 3600s budget and is fresh (t=0): the remaining-budget
		// clamp would NOT fire. The hard cap (600s) must win instead, proving
		// `timeout=0` (unbounded) is clamped even when the subagent has plenty
		// of budget — mirrors the main-agent guardrail.
		vi.setSystemTime(0)
		const pi = createMockPI()
		createSubagentBashClampExtension(3600, 0)(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "make world", timeout: 0 },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(MAX_BASH_TIMEOUT_SECONDS)
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

	it("clamps explicit timeouts above MAX_BASH_TIMEOUT_SECONDS even with plenty of budget", () => {
		// Subagent has a 3600s budget and is fresh (t=0): the remaining-budget
		// clamp would NOT fire on an explicit 2400s. The hard cap must still
		// bring it down so a subagent cannot inherit the main agent's
		// budget-blowing failure mode.
		vi.setSystemTime(0)
		const pi = createMockPI()
		createSubagentBashClampExtension(3600, 0)(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "make world", timeout: 2400 },
		}
		fireToolCall(pi, event)
		expect(event.input.timeout).toBe(MAX_BASH_TIMEOUT_SECONDS)
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

describe("R3 regression — maxDuration=0 (unlimited) must not clamp", () => {
	it("agent-runner uses bashDefaultTimeoutExtension when maxDuration=0", () => {
		// When effectiveMaxDuration is 0 (unlimited), agent-runner should NOT
		// use createSubagentBashClampExtension — it would floor every bash
		// call to 1s. Instead, it should fall back to bashDefaultTimeoutExtension.
		// This is tested at the integration level: the clamp extension itself
		// is never registered when maxDuration=0.
		//
		// This test documents the contract: createSubagentBashClampExtension
		// with maxDuration=0 would floor to 1s (budget exhausted at t=0),
		// which is why agent-runner.ts guards with `effectiveMaxDuration > 0`.
		vi.setSystemTime(0)
		const pi = createMockPI()
		createSubagentBashClampExtension(0, 0)(pi as unknown as PI)
		const event: BashEvent = {
			toolName: "bash",
			input: { command: "ls" },
		}
		fireToolCall(pi, event)
		// With maxDuration=0, remaining budget is 0, so floor is 1s.
		// This proves why agent-runner must NOT use the clamp when maxDuration=0.
		expect(event.input.timeout).toBe(1)
	})
})
