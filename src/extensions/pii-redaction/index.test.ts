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
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import piiRedactionExtension from "./index.js"
import { PII_REDACTION_EVENTS } from "./redaction-events.js"
import { resetRedactorEngine } from "./redactor.js"
import { PII_REDACTION_RESOURCE_ID } from "./resource.js"
import { resetTokenVaults, substituteTokens, vaultForSession } from "./vault.js"

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
		invoke: (event: string, payload: unknown, ctx?: unknown): Promise<unknown[]> =>
			Promise.all(
				harness
					.getHandlers(event)
					// ctx defaults to undefined: hooks resolve the session vault
					// from it when present and degrade to markers without it.
					.map(async (handler) => (await handler(payload, ctx as Parameters<typeof handler>[1])) as unknown),
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

	// Regression (PR #1619 review): pi-ai's ToolResultMessage carries role
	// "toolResult", not "tool" — a tool-result message in restored history
	// (before_provider_request cache miss) was redacted but never reported.
	it("before_provider_request maps toolResult-role messages to the tool_result surface", async () => {
		const { api, invoke, emitted } = makePi()
		piiRedactionExtension(api)

		const toolResultMessage = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: "Output file contains alice@example.com" }],
		}
		await invoke("before_provider_request", { payload: { messages: [toolResultMessage] } })
		expect(emitted).toEqual([
			{
				channel: PII_REDACTION_EVENTS.REDACTED,
				payload: expect.objectContaining({ surface: "tool_result", entity_type: "EMAIL_ADDRESS", count: 1 }),
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

	// Regression (double-reporting bug): a tool result's `details` mirrors the
	// rendered content (e.g. details.display.output repeats content[].text).
	// The tool_result hook redacts only content; the upstream runner keeps the
	// original raw `details` when a handler returns no replacement, and the
	// agent loop then fires message_end for the toolResult message — whose
	// deep walk re-redacted `details` and emitted a SECOND tool_result fact for
	// the same redaction. The hook must redact `details` in the same invocation
	// so each copy is scanned and reported exactly once.
	//
	// PII is assembled at runtime (String.fromCharCode(64)) because a literal
	// address in this file would itself be redacted on write.
	it("tool_result redacts the details mirror; message_end then emits nothing extra", async () => {
		const { api, invoke, emitted } = makePi()
		piiRedactionExtension(api)

		const EMAIL = ["jane.doe", "example.com"].join(String.fromCharCode(64))
		const PII_TEXT = `mail ${EMAIL} now`
		const details = { display: { output: PII_TEXT }, raw: { output: PII_TEXT } }

		const results = (await invoke("tool_result", {
			content: [{ type: "text", text: PII_TEXT }],
			details,
		})) as unknown as Array<{ content: Array<{ type: string; text?: string }>; details?: typeof details }>
		const hookResult = results[0]

		// The hook redacts all copies in one invocation: one event, count = 3
		// (one per scrubbed string copy — per-copy count semantics).
		expect(emitted).toEqual([
			{
				channel: PII_REDACTION_EVENTS.REDACTED,
				payload: expect.objectContaining({
					surface: "tool_result",
					entity_type: "EMAIL_ADDRESS",
					count: 3,
					strings_scanned: 3,
				}),
			},
		])
		expect(hookResult?.content[0]?.text).not.toContain(EMAIL)
		expect(hookResult?.details?.display.output).not.toContain(EMAIL)
		expect(hookResult?.details?.raw.output).not.toContain(EMAIL)
		// Shape survives — only the values are scrubbed.
		expect(Object.keys(hookResult?.details ?? {})).toEqual(["display", "raw"])

		// The host then fires message_end for the toolResult message built from
		// the hook results — the storage walk must net to zero and emit nothing.
		emitted.length = 0
		await invoke("message_end", {
			message: { role: "toolResult", content: hookResult?.content, details: hookResult?.details },
		})
		expect(emitted).toEqual([])
	})

	it("tool_result reports PII that lives only in details, once", async () => {
		const { api, invoke, emitted } = makePi()
		piiRedactionExtension(api)

		const EMAIL = ["sam.smith", "example.com"].join(String.fromCharCode(64))
		const results = (await invoke("tool_result", {
			content: [{ type: "text", text: "clean output" }],
			details: { display: { output: `contact ${EMAIL}` } },
		})) as unknown as Array<{ details?: { display?: { output?: string } } }>

		expect(emitted).toEqual([
			{
				channel: PII_REDACTION_EVENTS.REDACTED,
				payload: expect.objectContaining({ surface: "tool_result", entity_type: "EMAIL_ADDRESS", count: 1 }),
			},
		])
		expect(results[0]?.details?.display?.output).not.toContain(EMAIL)
	})

	it("tool_result without details returns no details key (runner keeps the original)", async () => {
		const { api, invoke } = makePi()
		piiRedactionExtension(api)

		const results = (await invoke("tool_result", {
			content: [{ type: "text", text: "no secrets here" }],
		})) as unknown as Array<Record<string, unknown>>

		expect(results[0]).toBeDefined()
		expect("details" in (results[0] ?? {})).toBe(false)
	})

	// A non-array `content` must not skip the details copy: this hook is the
	// single emission owner for every tool result, whatever the content shape
	// (the runner always passes an array today, but the hook is defensive for
	// unknown hosts). Only the details key is returned — the runner keeps the
	// original content when no replacement is given.
	it("tool_result redacts details even when content is not an array", async () => {
		const { api, invoke, emitted } = makePi()
		piiRedactionExtension(api)

		const EMAIL = ["kai.lee", "example.com"].join(String.fromCharCode(64))
		const results = (await invoke("tool_result", {
			content: "not an array",
			details: { display: { output: `contact ${EMAIL}` } },
		})) as unknown as Array<{ content?: unknown; details?: { display?: { output?: string } } }>

		expect(emitted).toEqual([
			{
				channel: PII_REDACTION_EVENTS.REDACTED,
				payload: expect.objectContaining({ surface: "tool_result", entity_type: "EMAIL_ADDRESS", count: 1 }),
			},
		])
		expect("content" in (results[0] ?? {})).toBe(false) // runner keeps the original
		expect(results[0]?.details?.display?.output).not.toContain(EMAIL)
		expect(results[0]?.details?.display?.output).toContain("[REDACTED-EMAIL_ADDRESS]")
	})

	// A details-side scan failure must not discard the content redaction that
	// succeeded: the details measurement is isolated, so the hook still
	// returns redacted content and keeps the original details for message_end
	// (the pre-fix failure behavior). The walker has no cycle guard — a
	// self-referencing details object makes the deep walk throw.
	it("a failing details scan keeps the content redaction and the original details", async () => {
		const { api, invoke, emitted } = makePi()
		piiRedactionExtension(api)

		const EMAIL = ["ann.fox", "example.com"].join(String.fromCharCode(64))
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		const results = (await invoke("tool_result", {
			content: [{ type: "text", text: `mail ${EMAIL} now` }],
			details: cyclic,
		})) as unknown as Array<{ content: Array<{ text?: string }>; details?: unknown }>

		expect(results[0]?.content[0]?.text).not.toContain(EMAIL)
		expect(results[0]?.content[0]?.text).toContain("[REDACTED-EMAIL_ADDRESS]")
		// No details replacement: the runner keeps the original object.
		expect("details" in (results[0] ?? {})).toBe(false)
		// One event from the content scan; the failed details scan adds nothing.
		expect(emitted).toEqual([
			{
				channel: PII_REDACTION_EVENTS.REDACTED,
				payload: expect.objectContaining({ surface: "tool_result", entity_type: "EMAIL_ADDRESS", count: 1 }),
			},
		])
	})

	// The `{}` return path (non-array content, no details): absent keys mean
	// "not replaced" for the runner, so this must stay a true no-op with no
	// emission — pinning the equivalence with the pre-fix early return.
	it("tool_result with non-array content and no details returns an empty no-op", async () => {
		const { api, invoke, emitted } = makePi()
		piiRedactionExtension(api)

		const results = (await invoke("tool_result", {
			content: "plain string",
		})) as unknown as Array<Record<string, unknown>>

		expect(results[0]).toEqual({})
		expect(emitted).toEqual([])
	})

	// Regression for the double-reporting class of bug: one tool result with the
	// same PII mirrored into content and details is scanned by three hooks in
	// sequence (tool_result -> message_end -> before_provider_request) and must
	// report each redacted copy exactly once, from the first hook that
	// introduces the marker.
	it("reports each redacted copy exactly once across the disk and provider hooks", async () => {
		const { api, invoke, emitted } = makePi()
		piiRedactionExtension(api)

		const EMAIL = ["jane.doe", "acmecorp.com"].join(String.fromCharCode(64))
		const PATH = ["", "Users", "alice", ".aws", "credentials"].join("/")
		const TEXT = `mail ${EMAIL} key ${PATH}`

		// 1. tool_result owns both copies.
		const results = (await invoke("tool_result", {
			content: [{ type: "text", text: TEXT }],
			details: { display: { output: TEXT } },
		})) as unknown as Array<{ content: Array<{ text?: string }>; details?: unknown }>
		const hook = results[0]
		expect(emitted).toHaveLength(2)
		expect(emitted).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					channel: PII_REDACTION_EVENTS.REDACTED,
					payload: expect.objectContaining({ surface: "tool_result", entity_type: "EMAIL_ADDRESS", count: 2 }),
				}),
				expect.objectContaining({
					channel: PII_REDACTION_EVENTS.REDACTED,
					payload: expect.objectContaining({ surface: "tool_result", entity_type: "LOCAL_PATH", count: 2 }),
				}),
			]),
		)

		// 2. message_end re-walks the same copy: markers net out.
		emitted.length = 0
		const message = { role: "toolResult", content: hook?.content, details: hook?.details }
		await invoke("message_end", { message })
		expect(emitted).toEqual([])

		// 3. The request hook re-scans for the provider: still netted, no events.
		const payload = { payload: { messages: [message] } }
		await invoke("before_provider_request", payload)
		expect(emitted).toEqual([])

		// 4. A second request hits the reference cache: no scan, no re-emission.
		await invoke("before_provider_request", { payload: { messages: [message] } })
		expect(emitted).toEqual([])

		// The provider payload is scrubbed for both categories.
		const sent = JSON.stringify(payload)
		expect(sent).not.toContain(EMAIL)
		expect(sent).not.toContain(PATH)
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

describe("pii-redaction hooks — token render mode", () => {
	let codingAgentDir: string

	// Assembled, not literal: write args on this file run under the same
	// redaction the tests exercise.
	const EMAIL = ["robin.hood", "corp-mail.io"].join("@")

	beforeEach(() => {
		codingAgentDir = mkdtempSync(join(tmpdir(), "pii-token-hooks-"))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", codingAgentDir)
		writeFileSync(join(codingAgentDir, "settings.json"), JSON.stringify({ redaction: { renderMode: "tokens" } }))
		invalidateJsonCache(getResourceSettingsPath())
		vi.stubEnv("KIMCHI_ENABLE_RESOURCES", "extensions.pii-redaction")
		resetOrgPolicyForTests()
		resetRedactorEngine()
		resetTokenVaults()
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		resetOrgPolicyForTests()
		resetRedactorEngine()
		resetTokenVaults()
		rmSync(codingAgentDir, { recursive: true, force: true })
	})

	const ctxFor = (sessionId: string) => createContext({ sessionManager: { getSessionId: () => sessionId } })

	it("message_end stores a stable token and reports the same facts as markers", async () => {
		const { api, invoke, emitted } = makePi()
		piiRedactionExtension(api)
		await invoke("session_start", {}, ctxFor("s1"))

		const message = { role: "assistant", content: [{ type: "text", text: `ping ${EMAIL}` }] }
		const results = await invoke("message_end", { message }, ctxFor("s1"))
		const text = (results[0] as { message?: { content?: { text?: string }[] } })?.message?.content?.[0]?.text ?? ""
		expect(text).toBe("ping [EMAIL_ADDRESS_1]")
		expect(emitted).toEqual([
			expect.objectContaining({
				channel: PII_REDACTION_EVENTS.REDACTED,
				payload: expect.objectContaining({ surface: "assistant_message", entity_type: "EMAIL_ADDRESS", count: 1 }),
			}),
		])
	})

	it("tokens are stable across hooks within a session (tool_result → message_end)", async () => {
		const { api, invoke } = makePi()
		piiRedactionExtension(api)
		await invoke("session_start", {}, ctxFor("s1"))

		const toolResults = await invoke(
			"tool_result",
			{ content: [{ type: "text", text: `found ${EMAIL}` }] },
			ctxFor("s1"),
		)
		const toolText = (toolResults[0] as { content?: { text?: string }[] })?.content?.[0]?.text ?? ""
		expect(toolText).toBe("found [EMAIL_ADDRESS_1]")

		const msgResults = await invoke(
			"message_end",
			{ message: { role: "user", content: `reply to ${EMAIL}` } },
			ctxFor("s1"),
		)
		const msgText = (msgResults[0] as { message?: { content?: unknown } })?.message?.content as string
		expect(msgText).toBe("reply to [EMAIL_ADDRESS_1]")
	})

	it("before_provider_request cache: re-scan of tokenized text nets to zero facts", async () => {
		const { api, invoke, emitted } = makePi()
		piiRedactionExtension(api)
		await invoke("session_start", {}, ctxFor("s1"))

		const message = { role: "user", content: `mail ${EMAIL}` }
		const payload = { payload: { messages: [message] } }
		await invoke("before_provider_request", payload, ctxFor("s1"))
		expect(JSON.stringify(payload)).toContain("[EMAIL_ADDRESS_1]")
		expect(emitted).toHaveLength(1)

		// Reference-cache hit: no rescan, no re-emission.
		emitted.length = 0
		await invoke("before_provider_request", payload, ctxFor("s1"))
		expect(emitted).toEqual([])
	})

	it("no session vault → markers even under token-mode settings (no identity, no tokens)", async () => {
		const { api, invoke } = makePi()
		piiRedactionExtension(api)
		// No session_start: hook has no session id to key a vault under.
		const message = { role: "assistant", content: [{ type: "text", text: `ping ${EMAIL}` }] }
		const results = await invoke("message_end", { message }, ctxFor("s9"))
		const text = (results[0] as { message?: { content?: { text?: string }[] } })?.message?.content?.[0]?.text ?? ""
		expect(text).toBe("ping [REDACTED-EMAIL_ADDRESS]")
	})

	it("tokens never cross-substitute: foreign-session tokens render verbatim", async () => {
		const { api, invoke } = makePi()
		piiRedactionExtension(api)
		await invoke("session_start", {}, ctxFor("sa"))
		await invoke("session_start", {}, ctxFor("sb"))

		const a = await invoke(
			"message_end",
			{ message: { role: "assistant", content: [{ type: "text", text: `a ${EMAIL}` }] } },
			ctxFor("sa"),
		)
		const bEmail = ["jordan.plus", "other-corp.io"].join("@")
		const b = await invoke(
			"message_end",
			{ message: { role: "assistant", content: [{ type: "text", text: `b ${bEmail}` }] } },
			ctxFor("sb"),
		)

		const textA = (a[0] as { message?: { content?: { text?: string }[] } })?.message?.content?.[0]?.text ?? ""
		const textB = (b[0] as { message?: { content?: { text?: string }[] } })?.message?.content?.[0]?.text ?? ""
		// Counters are process-global: the two sessions issue distinct tokens
		// for distinct values, so a foreign token can never alias.
		expect(textA).toBe("a [EMAIL_ADDRESS_1]")
		expect(textB).toBe("b [EMAIL_ADDRESS_2]")
		// sa's vault recovers only sa's value; sb's token passes through
		// VERBATIM under sa's vault — never a wrong value.
		const vaultA = vaultForSession("sa")
		expect(vaultA).toBeDefined()
		expect(vaultA && substituteTokens(vaultA, textA)).toBe(`a ${EMAIL}`)
		expect(vaultA && substituteTokens(vaultA, textB)).toBe("b [EMAIL_ADDRESS_2]")
	})

	it("markdown transformer substitutes against the paint vault; passthrough without one", async () => {
		const { api, invoke, getMarkdownTransformers } = makePi()
		piiRedactionExtension(api)
		const transformers = getMarkdownTransformers()
		expect(transformers).toHaveLength(1)
		const paint = (text: string) =>
			transformers[0](text, { messageType: "assistant", isStreaming: false, availableWidth: 80 })
		// No session → no paint vault → transformers pass through.
		expect(paint("text [EMAIL_ADDRESS_1]")).toBe("text [EMAIL_ADDRESS_1]")

		await invoke("session_start", {}, ctxFor("s1"))
		await invoke("message_end", { message: { role: "assistant", content: `call ${EMAIL}` } }, ctxFor("s1"))
		// Paint-time: the tokenized stored text renders with its original.
		expect(paint("call [EMAIL_ADDRESS_1]")).toBe(`call ${EMAIL}`)
		// ...and markers are never touched by the substitution layer.
		expect(paint("x [REDACTED-EMAIL_ADDRESS]")).toBe("x [REDACTED-EMAIL_ADDRESS]")

		await invoke("session_shutdown", {}, ctxFor("s1"))
		expect(paint("call [EMAIL_ADDRESS_1]")).toBe("call [EMAIL_ADDRESS_1]")
	})
})
