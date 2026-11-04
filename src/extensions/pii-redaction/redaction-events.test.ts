// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { afterEach, describe, expect, it, vi } from "vitest"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { emitRedactionFacts, KIMCHI_DISABLE_REDACTION_EVENTS, PII_REDACTION_EVENTS } from "./redaction-events.js"
import type { RedactionReport } from "./redactor.js"

type EmittedEvent = { channel: string; payload: unknown }

function makePi(): { pi: ReturnType<typeof createExtensionApi>["api"]; emitted: EmittedEvent[] } {
	const { api } = createExtensionApi()
	const emitted: EmittedEvent[] = []
	// Collect emissions by subscribing through the shared mock's bus.
	for (const channel of [PII_REDACTION_EVENTS.REDACTED, PII_REDACTION_EVENTS.ENGINE_DEGRADED]) {
		api.events.on(channel, (payload: unknown) => emitted.push({ channel, payload }))
	}
	return { pi: api, emitted }
}

function report(overrides: Partial<RedactionReport> = {}): RedactionReport {
	return { entities: {}, stringsScanned: 1, engineFailures: 0, ...overrides }
}

describe("emitRedactionFacts", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("emits one REDACTED event per entity type with its count and the invocation denominator", () => {
		const { pi, emitted } = makePi()
		emitRedactionFacts(
			pi,
			"tool_result",
			report({ entities: { EMAIL_ADDRESS: 2, OPENAI_API_KEY: 1 }, stringsScanned: 7 }),
		)
		expect(emitted).toEqual([
			{
				channel: PII_REDACTION_EVENTS.REDACTED,
				payload: {
					surface: "tool_result",
					entity_type: "EMAIL_ADDRESS",
					count: 2,
					strings_scanned: 7,
					is_subagent: false,
				},
			},
			{
				channel: PII_REDACTION_EVENTS.REDACTED,
				payload: {
					surface: "tool_result",
					entity_type: "OPENAI_API_KEY",
					count: 1,
					strings_scanned: 7,
					is_subagent: false,
				},
			},
		])
	})

	it("emits ENGINE_DEGRADED when scans failed, alongside REDACTED events", () => {
		const { pi, emitted } = makePi()
		emitRedactionFacts(pi, "user_input", report({ entities: { EMAIL_ADDRESS: 1 }, engineFailures: 2 }))
		expect(emitted.map((e) => e.channel)).toEqual([PII_REDACTION_EVENTS.REDACTED, PII_REDACTION_EVENTS.ENGINE_DEGRADED])
		expect(emitted[1].payload).toEqual({ surface: "user_input", failures: 2, is_subagent: false })
	})

	it("emits nothing when the report is empty", () => {
		const { pi, emitted } = makePi()
		emitRedactionFacts(pi, "assistant_message", report())
		expect(emitted).toEqual([])
	})

	it("payloads carry no free-text fields (privacy contract)", () => {
		const { pi, emitted } = makePi()
		const rawEmail = "john.doe@example.com"
		const rawKey = "sk-proj-abcdef1234567890"
		emitRedactionFacts(
			pi,
			"tool_result",
			report({ entities: { EMAIL_ADDRESS: 1, OPENAI_API_KEY: 1 }, engineFailures: 1 }),
		)
		const serialized = JSON.stringify(emitted)
		expect(serialized).not.toContain(rawEmail)
		expect(serialized).not.toContain(rawKey)
		// Structured fields only.
		for (const { payload } of emitted) {
			for (const key of Object.keys(payload as Record<string, unknown>)) {
				expect(["surface", "entity_type", "count", "strings_scanned", "failures", "is_subagent"]).toContain(key)
			}
		}
	})

	it("kill switch silences all emission", () => {
		vi.stubEnv(KIMCHI_DISABLE_REDACTION_EVENTS, "1")
		const { pi, emitted } = makePi()
		emitRedactionFacts(pi, "user_input", report({ entities: { EMAIL_ADDRESS: 1 }, engineFailures: 1 }))
		expect(emitted).toEqual([])
	})

	it("swallows pi.events errors (redaction never depends on the bus)", () => {
		const pi = {
			events: {
				emit: () => {
					throw new Error("no bus on this host")
				},
			},
			// biome-ignore lint/suspicious/noExplicitAny: minimal ExtensionAPI stub — this test exercises a bus-less host
		} as any
		expect(() =>
			emitRedactionFacts(pi, "tool_result", report({ entities: { EMAIL_ADDRESS: 1 }, engineFailures: 1 })),
		).not.toThrow()
	})
})
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
