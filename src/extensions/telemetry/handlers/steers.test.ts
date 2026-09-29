import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../../config.js"
import { logEvents, type RecordedEvent } from "../otlp-test-utils.js"
import { _resetSharedAccumulators, TelemetryContext } from "../session-context.js"
import { handleSteerFired, handleSteerOutcome } from "./steers.js"

vi.mock("../../../api/me.js", () => ({
	getMe: vi.fn().mockResolvedValue({ id: "test-user", email: "test@example.com" }),
}))

function makeConfig(overrides: Partial<TelemetryConfig> = {}): TelemetryConfig {
	return {
		enabled: true,
		endpoint: "https://test.example.com/logs",
		metricsEndpoint: "https://test.example.com/metrics",
		headers: { Authorization: "Bearer test" },
		apiKey: "",
		...overrides,
	}
}

function attrsOf(events: RecordedEvent[], eventName: string): Record<string, unknown> | undefined {
	return events.find((record) => record.eventName === eventName)?.attrs
}

describe("handlers/steers", () => {
	let originalFetch: typeof globalThis.fetch
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		originalFetch = globalThis.fetch
		fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: vi.fn().mockResolvedValue(""),
		} as unknown as Response)
		globalThis.fetch = fetchMock
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
		_resetSharedAccumulators()
		vi.restoreAllMocks()
	})

	async function emitted(
		handler: (ctx: TelemetryContext, raw: unknown) => void,
		raw: unknown,
	): Promise<RecordedEvent[]> {
		const ctx = new TelemetryContext(makeConfig())
		handler(ctx, raw)
		ctx.flushLogBuffer()
		await Promise.allSettled([...ctx.inFlight])
		return logEvents(fetchMock)
	}

	it("steer:fired → steer.fired OTLP record with kind, reason, interactive, is_subagent", async () => {
		const events = await emitted(handleSteerFired, {
			kind: "todo_early_nudge",
			reason: "early_nudge",
			is_subagent: false,
			interactive: true,
		})
		const attrs = attrsOf(events, "steer.fired")
		expect(attrs).toMatchObject({
			kind: "todo_early_nudge",
			reason: "early_nudge",
			is_subagent: "false",
			interactive: "true",
		})
	})

	it("steer:outcome → steer.outcome OTLP record with kind, outcome, interactive, is_subagent", async () => {
		const events = await emitted(handleSteerOutcome, {
			kind: "bash_tool_guard",
			outcome: "repeated",
			is_subagent: false,
			interactive: false,
		})
		const attrs = attrsOf(events, "steer.outcome")
		expect(attrs).toMatchObject({
			kind: "bash_tool_guard",
			outcome: "repeated",
			is_subagent: "false",
			interactive: "false",
		})
	})

	it("drops payloads missing kind or reason — never emits a malformed record", async () => {
		expect(await emitted(handleSteerFired, { reason: "x" })).toHaveLength(0)
		expect(await emitted(handleSteerFired, { kind: "todo_early_nudge" })).toHaveLength(0)
		expect(await emitted(handleSteerOutcome, { kind: "loop_guard" })).toHaveLength(0)
		expect(await emitted(handleSteerOutcome, { kind: "loop_guard", outcome: "weird" })).toHaveLength(0)
	})

	it("privacy: emitted attributes are limited to the allowlist plus ambient ids — no free-text fields", async () => {
		const events = await emitted(handleSteerFired, {
			kind: "bash_tool_guard",
			reason: "block",
			is_subagent: true,
			interactive: false,
			// A producer bug leaking fields must not propagate through the handler.
			command: "cat secrets.txt",
			path: "/etc/passwd",
		})
		const attrs = attrsOf(events, "steer.fired")
		expect(attrs).toMatchObject({ kind: "bash_tool_guard", reason: "block", is_subagent: "true", interactive: "false" })
		for (const [key, value] of Object.entries(attrs ?? {})) {
			expect(key).not.toMatch(/command|path|text/i)
			expect(String(value)).not.toContain("secrets")
			expect(String(value)).not.toContain("/etc/passwd")
		}
	})
})
