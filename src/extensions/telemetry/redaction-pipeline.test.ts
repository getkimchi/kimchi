// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
/**
 * Integration probe: pii-redaction hook → pi.events bus → telemetry
 * handler → OTLP flush, wired through a shared emitter exactly the way the
 * real host's runtime eventBus joins the two extensions.
 *
 * Written to bisect a production-shaped failure: redaction markers reached
 * the provider but no pii_redaction.* records reached the OTLP endpoint.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../config.js"
import { resetOrgPolicyForTests } from "../../org-policy.js"
import { setResourceOverride } from "../../resources/store.js"
import { createMiniEventBus } from "../__mocks__/mini-event-bus.js"
import piiRedactionExtension from "../pii-redaction/index.js"
import { PII_REDACTION_EVENTS } from "../pii-redaction/redaction-events.js"
import { resetRedactorEngine } from "../pii-redaction/redactor.js"
import { PII_REDACTION_RESOURCE_ID } from "../pii-redaction/resource.js"
import telemetryExtension from "./index.js"
import { logEvents } from "./otlp-test-utils.js"
import { _resetSharedAccumulators } from "./session-context.js"

vi.mock("../../api/me.js", () => ({
	getMe: vi.fn().mockResolvedValue({ id: "test-user", email: "test@example.com" }),
}))

type HookFn = (event: unknown, ctx?: unknown) => unknown

/** One pi stub per extension, sharing one bus — like the host runtime. */
function makePi(bus: ReturnType<typeof createMiniEventBus>, hooks: Map<string, HookFn>) {
	return {
		on: (name: string, fn: HookFn) => {
			hooks.set(name, fn)
			return () => {}
		},
		events: { emit: bus.emit, on: bus.events.on },
		// biome-ignore lint/suspicious/noExplicitAny: this test needs two stub api objects wired to one shared bus — a shape createExtensionApi() cannot express
	} as any
}

function makeConfig(): TelemetryConfig {
	return {
		enabled: true,
		endpoint: "https://test.example.com/logs",
		metricsEndpoint: "https://test.example.com/metrics",
		headers: {},
		apiKey: "",
	}
}

describe("pii-redaction → telemetry OTLP pipeline (shared bus)", () => {
	let codingAgentDir: string
	let originalFetch: typeof globalThis.fetch
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		codingAgentDir = mkdtempSync(join(tmpdir(), "pii-pipeline-"))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", codingAgentDir)
		writeFileSync(join(codingAgentDir, "settings.json"), "{}")
		resetOrgPolicyForTests()
		setResourceOverride(PII_REDACTION_RESOURCE_ID, true)
		resetRedactorEngine()
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
		vi.unstubAllEnvs()
		resetOrgPolicyForTests()
		resetRedactorEngine()
		_resetSharedAccumulators()
		rmSync(codingAgentDir, { recursive: true, force: true })
	})

	it("a user_prompt with one email yields pii_redaction.redacted + session_affected on OTLP", async () => {
		const bus = createMiniEventBus()
		const redactionHooks = new Map<string, HookFn>()
		piiRedactionExtension(makePi(bus, redactionHooks))

		const telemetryHooks = new Map<string, HookFn>()
		telemetryExtension(makeConfig())(makePi(bus, telemetryHooks))
		// session_start registration order mirrors cli.ts: pii-redaction is
		// registered after telemetry, but bus subscriptions land in the same
		// runtime — order must not matter.
		const sessionCtx = {
			sessionManager: { getSessionId: () => "test-session-1" },
			model: undefined,
			hasUI: true,
			// biome-ignore lint/suspicious/noExplicitAny: minimal session context stub
		} as any
		await telemetryHooks.get("session_start")?.({}, sessionCtx)

		await redactionHooks.get("before_provider_request")?.({
			payload: { messages: [{ role: "user", content: "Contact alice@example.com" }] },
		})

		// Flush via the session shutdown path — it flushes the log buffer.
		await telemetryHooks.get("session_shutdown")?.({}, sessionCtx)

		const events = logEvents(fetchMock)
		const names = events.map((e) => e.eventName)
		expect(names).toContain("pii_redaction.session_affected")
		expect(names).toContain("pii_redaction.redacted")
		const redacted = events.filter((e) => e.eventName === "pii_redaction.redacted")
		expect(redacted.map((e) => e.attrs.entity_type)).toEqual(["EMAIL_ADDRESS"])
	})

	it("subscription exists: telemetry factory registers a handler for the redaction channel", () => {
		const bus = createMiniEventBus()
		const telemetryHooks = new Map<string, HookFn>()
		telemetryExtension(makeConfig())(makePi(bus, telemetryHooks))

		const seen: unknown[] = []
		bus.events.on(PII_REDACTION_EVENTS.REDACTED, (raw: unknown) => seen.push(raw))
		bus.emit(PII_REDACTION_EVENTS.REDACTED, {
			surface: "user_input",
			entity_type: "EMAIL_ADDRESS",
			count: 1,
			strings_scanned: 1,
			is_subagent: false,
		})
		expect(seen).toHaveLength(1)
	})
})
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
