import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../../config.js"
import { logEvents, type RecordedEvent } from "../otlp-test-utils.js"
import { _resetSharedAccumulators, TelemetryContext } from "../session-context.js"
import { handleSteerAborted, handleSteerFired, handleSteerOutcome, STEER_TELEMETRY_ATTR_ALLOWLIST } from "./steers.js"

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
		region: "us",
		...overrides,
	}
}

function attrsOf(events: RecordedEvent[], eventName: string): Record<string, unknown> | undefined {
	return events.find((record) => record.eventName === eventName)?.attrs
}

/** Bare (dot-less) ambient attribute keys the telemetry pipeline stamps on
 *  every OTLP record — source, session_type, client, ferment_id, etc. These
 *  are pipeline-owned, not handler-owned, so the allowlist test filters them
 *  out of the "handler only surfaces OUR attributes" assertion. */
const AMBIENT_BARE_KEYS = new Set([
	"client",
	"source",
	"session_type",
	"session_type_changed",
	"previous_session_type",
	"ferment_id",
	"phase_id",
	"step_id",
	"run_id",
	"model",
	"region",
])

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

	it("steer:aborted → steer.aborted OTLP record with kind, reason, interactive, is_subagent", async () => {
		const events = await emitted(handleSteerAborted, {
			kind: "exploration_guard",
			reason: "turn_end",
			is_subagent: false,
			interactive: true,
		})
		const attrs = attrsOf(events, "steer.aborted")
		expect(attrs).toMatchObject({
			kind: "exploration_guard",
			reason: "turn_end",
			is_subagent: "false",
			interactive: "true",
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
		// The producer-leaked fields must not surface, and no value may contain
		// the leaked content in any key. (The full ambient-id surface is the
		// pipeline's, not this handler's — we only assert OUR allowlist keys
		// are the only steer-* attrs and nothing leaked through.)
		const steerAttrs = Object.keys(attrs ?? {}).filter((k) => !k.includes(".") && !AMBIENT_BARE_KEYS.has(k))
		expect(steerAttrs.sort()).toEqual([...STEER_TELEMETRY_ATTR_ALLOWLIST["steer:fired"]].sort())
		for (const value of Object.values(attrs ?? {})) {
			expect(String(value)).not.toContain("secrets")
			expect(String(value)).not.toContain("/etc/passwd")
		}
	})
})
