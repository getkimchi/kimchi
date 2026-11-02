import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../../config.js"
import { logEvents, type RecordedEvent } from "../otlp-test-utils.js"
import { _resetSharedAccumulators, TelemetryContext } from "../session-context.js"
import {
	createRedactionHandlers,
	REDACTION_TELEMETRY_ATTR_ALLOWLIST,
	REDACTION_TELEMETRY_RECORDS,
} from "./redactions.js"

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

/** Bare (dot-less) ambient attribute keys the telemetry pipeline stamps on
 *  every OTLP record — mirrored from handlers/steers.test.ts. */
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
])

describe("handlers/redactions", () => {
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

	async function flush(ctx: TelemetryContext): Promise<RecordedEvent[]> {
		ctx.flushLogBuffer()
		await Promise.allSettled([...ctx.inFlight])
		const events = logEvents(fetchMock)
		fetchMock.mockClear()
		return events
	}

	it("pii_redaction:redacted → pii_redaction.redacted record with surface, entity_type, count, strings_scanned", async () => {
		const ctx = new TelemetryContext(makeConfig())
		const handlers = createRedactionHandlers()
		handlers.onRedactionRedacted(ctx, {
			surface: "tool_result",
			entity_type: "EMAIL_ADDRESS",
			count: 2,
			strings_scanned: 5,
			is_subagent: false,
		})
		const attrs = attrsOf(await flush(ctx), REDACTION_TELEMETRY_RECORDS.REDACTED)
		expect(attrs).toMatchObject({
			surface: "tool_result",
			entity_type: "EMAIL_ADDRESS",
			count: "2",
			strings_scanned: "5",
			is_subagent: "false",
		})
	})

	it("emits one pii_redaction.session_affected per handler instance, on the first redaction only", async () => {
		const ctx = new TelemetryContext(makeConfig())
		const handlers = createRedactionHandlers()
		const redaction = { surface: "assistant_message", entity_type: "PHONE_NUMBER", count: 1, is_subagent: false }
		handlers.onRedactionRedacted(ctx, redaction)
		const first = await flush(ctx)
		expect(first.map((e) => e.eventName)).toEqual([
			REDACTION_TELEMETRY_RECORDS.SESSION_AFFECTED,
			REDACTION_TELEMETRY_RECORDS.REDACTED,
		])

		handlers.onRedactionRedacted(ctx, redaction)
		const second = await flush(ctx)
		expect(second.map((e) => e.eventName)).toEqual([REDACTION_TELEMETRY_RECORDS.REDACTED])
	})

	it("drops malformed payloads (unknown surface, empty entity, non-positive count)", async () => {
		const ctx = new TelemetryContext(makeConfig())
		const handlers = createRedactionHandlers()
		for (const raw of [
			{ surface: "prompt", entity_type: "EMAIL_ADDRESS", count: 1 },
			{ surface: "tool_result", entity_type: "", count: 1 },
			{ surface: "tool_result", entity_type: "EMAIL_ADDRESS", count: 0 },
			{ surface: "tool_result", count: 1 },
			null,
		]) {
			handlers.onRedactionRedacted(ctx, raw)
		}
		expect(logEvents(fetchMock)).toEqual([])
	})

	it("drops non-finite counts and entity_type outside the marker namespace charset", async () => {
		const ctx = new TelemetryContext(makeConfig())
		const handlers = createRedactionHandlers()
		for (const raw of [
			// NaN: `NaN <= 0` is false, so it would slip through a naive check.
			{ surface: "tool_result", entity_type: "EMAIL_ADDRESS", count: NaN },
			{ surface: "tool_result", entity_type: "EMAIL_ADDRESS", count: 1.5 },
			// Free text must never land in the entity_type attribute.
			{ surface: "tool_result", entity_type: "john.doe@example.com", count: 1 },
			{ surface: "tool_result", entity_type: "email address", count: 1 },
		]) {
			handlers.onRedactionRedacted(ctx, raw)
		}
		handlers.onEngineDegraded(ctx, { surface: "user_input", failures: Number.POSITIVE_INFINITY })
		expect(logEvents(fetchMock)).toEqual([])
	})

	it("latch is scoped per handler instance — concurrent sessions each get their own session_affected", async () => {
		const ctxA = new TelemetryContext(makeConfig())
		const ctxB = new TelemetryContext(makeConfig())
		const handlersA = createRedactionHandlers()
		const handlersB = createRedactionHandlers()
		const event = { surface: "user_input", entity_type: "EMAIL_ADDRESS", count: 1, is_subagent: false }
		handlersA.onRedactionRedacted(ctxA, event)
		handlersB.onRedactionRedacted(ctxB, event)
		// Sequential flushes share fetchMock — interleaved reads would mix batches.
		const batchA = await flush(ctxA)
		const batchB = await flush(ctxB)
		for (const batch of [batchA, batchB]) {
			expect(batch.filter((e) => e.eventName === REDACTION_TELEMETRY_RECORDS.SESSION_AFFECTED)).toHaveLength(1)
		}
	})

	it("reset() re-arms the session_affected latch (session_start on a reused instance)", async () => {
		const ctx = new TelemetryContext(makeConfig())
		const handlers = createRedactionHandlers()
		const event = { surface: "user_input", entity_type: "EMAIL_ADDRESS", count: 1, is_subagent: false }
		handlers.onRedactionRedacted(ctx, event)
		expect((await flush(ctx)).filter((e) => e.eventName === REDACTION_TELEMETRY_RECORDS.SESSION_AFFECTED)).toHaveLength(
			1,
		)

		handlers.reset()
		handlers.onRedactionRedacted(ctx, event)
		expect((await flush(ctx)).filter((e) => e.eventName === REDACTION_TELEMETRY_RECORDS.SESSION_AFFECTED)).toHaveLength(
			1,
		)
	})

	it("pii_redaction:engine_degraded → pii_redaction.engine_degraded record with surface + failures", async () => {
		const ctx = new TelemetryContext(makeConfig())
		const handlers = createRedactionHandlers()
		handlers.onEngineDegraded(ctx, { surface: "user_input", failures: 2, is_subagent: true })
		const attrs = attrsOf(await flush(ctx), REDACTION_TELEMETRY_RECORDS.ENGINE_DEGRADED)
		expect(attrs).toMatchObject({
			surface: "user_input",
			failures: "2",
			is_subagent: "true",
		})
	})

	it("attribute allowlist contract: every handler is covered by REDACTION_TELEMETRY_ATTR_ALLOWLIST", async () => {
		const ctx = new TelemetryContext(makeConfig())
		const handlers = createRedactionHandlers()
		// Poison payloads with extraneous (would-be sensitive) fields.
		handlers.onRedactionRedacted(ctx, {
			surface: "user_input",
			entity_type: "EMAIL_ADDRESS",
			count: 1,
			is_subagent: false,
			matched_text: "john.doe@example.com",
			json_key: "password",
		})
		handlers.onEngineDegraded(ctx, {
			surface: "tool_result",
			failures: 1,
			is_subagent: false,
			original_text: "call me at john.doe@example.com",
		})
		for (const record of await flush(ctx)) {
			const allowed = new Set([
				...(REDACTION_TELEMETRY_ATTR_ALLOWLIST[record.eventName as keyof typeof REDACTION_TELEMETRY_ATTR_ALLOWLIST] ??
					[]),
				...AMBIENT_BARE_KEYS,
			])
			for (const key of Object.keys(record.attrs)) {
				// Dotted keys (user.account_uuid, telemetry.*, os.*) are pipeline-owned
				if (key.includes(".")) continue
				expect(allowed.has(key)).toBe(true)
			}
			expect(JSON.stringify(record.attrs)).not.toContain("john.doe@example.com")
		}
	})
})
