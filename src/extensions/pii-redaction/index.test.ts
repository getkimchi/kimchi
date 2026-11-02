/**
 * Extension-level probes for the pii-redaction hooks: they must emit
 * pii_redaction:* bus events when the resource is enabled (and nothing
 * when it is not), and must never throw on a broken settings block — the
 * extension runner discards rejected results, and a throwing gate would
 * store and send unredacted content. Sits between the redactor unit tests
 * and the TUI E2E — it pins the hook → pi.events wiring without a live
 * harness.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { invalidateJsonCache } from "../../config/json.js"
import { resetOrgPolicyForTests } from "../../org-policy.js"
import { getResourceSettingsPath, setResourceOverride } from "../../resources/store.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import piiRedactionExtension from "./index.js"
import { PII_REDACTION_EVENTS } from "./redaction-events.js"
import { resetRedactorEngine } from "./redactor.js"
import { PII_REDACTION_RESOURCE_ID } from "./resource.js"

// The hook-level contract for a broken settings block: the extension runner
// (pi-coding-agent) catches handler rejections and DISCARDS their results,
// so a gate that throws stores and sends unredacted content with only a
// per-event log. The gates must therefore never throw on a typo'd
// `redaction.excludedEntities` — the redactor's snapshot degrades to
// defaults and redaction stays ON. (Adjudicated failure-002/security-002.)

describe("pii-redaction hooks — broken settings block", () => {
	let codingAgentDir: string
	const api = createExtensionApi()

	beforeEach(() => {
		codingAgentDir = mkdtempSync(join(tmpdir(), "kimchi-redact-hooks-"))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", codingAgentDir)
		vi.stubEnv("KIMCHI_ENABLE_RESOURCES", "extensions.pii-redaction")
		piiRedactionExtension(api.api)
	})

	afterEach(() => {
		resetRedactorEngine()
		vi.unstubAllEnvs()
		rmSync(codingAgentDir, { recursive: true, force: true })
	})

	function writeSettings(redaction: unknown): void {
		writeFileSync(join(codingAgentDir, "settings.json"), JSON.stringify({ redaction }))
		invalidateJsonCache(getResourceSettingsPath())
	}

	it("message_end still returns a redacted message when excludedEntities has a typo", async () => {
		writeSettings({ excludedEntities: ["SSN"] }) // unknown: the real name is US_SSN
		resetRedactorEngine()
		const message = {
			role: "assistant",
			content: [{ type: "text", text: ["contact ", "jane.doe", String.fromCharCode(64), "example.com"].join("") }],
		}
		const results = await api.emit("message_end", { message })
		const returned = results[0] as { message?: { content?: { text?: string }[] } } | undefined
		expect(returned).toBeDefined() // a rejected handler would yield undefined (runner discards)
		const text = returned?.message?.content?.[0]?.text ?? ""
		expect(text.includes(String.fromCharCode(64))).toBe(false) // the address is gone
		expect(text.includes("[REDACTED-EMAIL_ADDRESS]")).toBe(true)
	})

	it("tool_result still returns redacted content under the same settings", async () => {
		writeSettings({ excludedEntities: ["SSN"] })
		resetRedactorEngine()
		const content = [
			{ type: "text", text: ["mail ", "jane.doe", String.fromCharCode(64), "example.com", " end"].join("") },
		]
		const results = await api.emit("tool_result", { content })
		const returned = results[0] as { content?: { text?: string }[] } | undefined
		expect(returned).toBeDefined()
		const text = returned?.content?.[0]?.text ?? ""
		expect(text.includes("[REDACTED-EMAIL_ADDRESS]")).toBe(true)
	})
})

type EmittedEvent = { channel: string; payload: unknown }

function makePi() {
	const harness = createExtensionApi()
	const emitted: EmittedEvent[] = []
	for (const channel of [PII_REDACTION_EVENTS.REDACTED, PII_REDACTION_EVENTS.ENGINE_DEGRADED]) {
		harness.api.events.on(channel, (payload: unknown) => emitted.push({ channel, payload }))
	}
	return {
		...harness,
		emitted,
		invoke: (event: string, payload: unknown) =>
			Promise.all(
				harness
					.getHandlers(event)
					// The hooks under test ignore ctx entirely.
					.map((handler) => handler(payload, undefined as unknown as Parameters<typeof handler>[1])),
			),
	}
}

describe("pii-redaction extension — event emission wiring", () => {
	let codingAgentDir: string

	beforeEach(() => {
		codingAgentDir = mkdtempSync(join(tmpdir(), "pii-events-"))
		// The resources store reads settings from KIMCHI_CODING_AGENT_DIR.
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", codingAgentDir)
		writeFileSync(join(codingAgentDir, "settings.json"), "{}")
		resetOrgPolicyForTests()
		setResourceOverride(PII_REDACTION_RESOURCE_ID, true)
		resetRedactorEngine()
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		resetOrgPolicyForTests()
		resetRedactorEngine()
		rmSync(codingAgentDir, { recursive: true, force: true })
	})

	it("before_provider_request emits one REDACTED event per entity type on cache miss, once per message", async () => {
		const { api, invoke, emitted } = makePi()
		piiRedactionExtension(api)

		const card = ["4532", "0151", "1283", "0366"].join("") // Luhn-valid
		const userMessage = { role: "user", content: `Contact alice@example.com about invoice CC: ${card}` }
		const makeEvent = (message: unknown) => ({ payload: { messages: [message] } })

		await invoke("before_provider_request", makeEvent(userMessage))
		const channelsAfterFirst = emitted.map((e) => e.channel)
		expect(channelsAfterFirst.filter((c) => c === PII_REDACTION_EVENTS.REDACTED)).toHaveLength(2)

		// Second request: cache hit for the same message reference — no re-emit.
		emitted.length = 0
		await invoke("before_provider_request", makeEvent(userMessage))
		expect(emitted).toEqual([])
	})

	it("before_provider_request emits exactly once when one payload carries the same message reference twice", async () => {
		const { api, invoke, emitted } = makePi()
		piiRedactionExtension(api)

		// A duplicated reference makes Promise.all run two cache-miss paths
		// concurrently — the in-flight map must collapse them to one redaction
		// and one emission (regression: double emission on concurrent misses).
		const userMessage = { role: "user", content: "Contact alice@example.com" }
		await invoke("before_provider_request", { payload: { messages: [userMessage, userMessage] } })
		expect(emitted).toHaveLength(1)
		const payload = emitted[0].payload as Record<string, unknown>
		expect(payload.surface).toBe("user_input")
		expect(payload.entity_type).toBe("EMAIL_ADDRESS")
		expect(payload.count).toBe(1)
	})

	it("before_provider_request labels surfaces by message role, not uniformly user_input", async () => {
		const { api, invoke, emitted } = makePi()
		piiRedactionExtension(api)

		// Restored history: an unclean assistant message on cache miss must
		// not inflate the user_input dimension.
		const assistantMessage = { role: "assistant", content: "Reply to bob@corp.org" }
		await invoke("before_provider_request", { payload: { messages: [assistantMessage] } })
		expect(emitted).toEqual([
			{
				channel: PII_REDACTION_EVENTS.REDACTED,
				payload: expect.objectContaining({ surface: "assistant_message", entity_type: "EMAIL_ADDRESS", count: 1 }),
			},
		])
	})

	// Regression for the live-host failure mode: message_end is where user
	// messages are actually redacted (it runs before before_provider_request),
	// so user_input facts must be labelled from the message_role here. And the
	// payload is the real array-shaped content, whose traversal goes through
	// the walker's array branch.
	it("message_end roles map to the right surface: user -> user_input, system -> no emission", async () => {
		const { api, invoke, emitted } = makePi()
		piiRedactionExtension(api)

		await invoke("message_end", {
			message: { role: "user", content: [{ type: "text", text: "Contact alice@example.com" }] },
		})
		expect(emitted).toEqual([
			{
				channel: PII_REDACTION_EVENTS.REDACTED,
				payload: expect.objectContaining({
					surface: "user_input",
					entity_type: "EMAIL_ADDRESS",
					count: 1,
				}),
			},
		])

		emitted.length = 0
		await invoke("message_end", { message: { role: "system", content: "You are Kimchi; email ops@cast.ai" } })
		expect(emitted).toEqual([])
	})

	it("message_end emits REDACTED events with surface assistant_message", async () => {
		const { api, invoke, emitted } = makePi()
		piiRedactionExtension(api)

		await invoke("message_end", { message: { role: "assistant", content: "Reply to bob@corp.org" } })
		expect(emitted).toEqual([
			{
				channel: PII_REDACTION_EVENTS.REDACTED,
				payload: expect.objectContaining({ surface: "assistant_message", entity_type: "EMAIL_ADDRESS", count: 1 }),
			},
		])
	})

	it("tool_result emits REDACTED events aggregated across text blocks, surface tool_result", async () => {
		const { api, invoke, emitted } = makePi()
		piiRedactionExtension(api)

		await invoke("tool_result", {
			content: [
				{ type: "text", text: "email a@b.co and c@d.co" },
				{ type: "image", source: {} },
				{ type: "text", text: "clean" },
			],
		})
		expect(emitted).toEqual([
			{
				channel: PII_REDACTION_EVENTS.REDACTED,
				payload: expect.objectContaining({ surface: "tool_result", entity_type: "EMAIL_ADDRESS", count: 2 }),
			},
		])
	})

	it("emits nothing when the resource is off — zero I/O", async () => {
		setResourceOverride(PII_REDACTION_RESOURCE_ID, false)
		const { api, invoke, emitted } = makePi()
		piiRedactionExtension(api)

		const message = { role: "user", content: "alice@example.com" }
		await invoke("before_provider_request", { payload: { messages: [message] } })
		await invoke("message_end", { message })
		await invoke("tool_result", { content: [{ type: "text", text: "alice@example.com" }] })
		expect(emitted).toEqual([])
	})
})
