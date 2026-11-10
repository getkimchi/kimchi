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
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { invalidateJsonCache } from "../../config/json.js"
import { resetOrgPolicyForTests } from "../../org-policy.js"
import { getResourceSettingsPath, setResourceOverride } from "../../resources/store.js"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { type AttestEntryData, messageDigest, PII_ATTEST_ENTRY_TYPE } from "./attestation.js"
import piiRedactionExtension from "./index.js"
import { PII_REDACTION_EVENTS } from "./redaction-events.js"
import { getRedactionFingerprint, resetRedactorEngine } from "./redactor.js"
import { PII_REDACTION_RESOURCE_ID } from "./resource.js"
import { resetTokenVaults, substituteTokens, vaultForSession } from "./vault.js"

// Toggleable engine-analyze override for the attestation failure tests —
// same pattern as redactor.test.ts: `null` (default) delegates to the real
// engine, so every other test in this file exercises real redaction.
const engineScanOverride = vi.hoisted(() => ({
	scanImpl: null as ((text: string) => Promise<unknown>) | null,
}))

vi.mock("@bulkhead-ai/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@bulkhead-ai/core")>()
	return {
		...actual,
		createEngine: (...args: Parameters<typeof actual.createEngine>) => {
			const engine = actual.createEngine(...args)
			if (!engineScanOverride.scanImpl) return engine
			const overridden = Object.create(engine) as typeof engine
			overridden.analyze = engineScanOverride.scanImpl as typeof engine.analyze
			return overridden
		},
	}
})

// Toggleable getVersion override for the unreadable-build-version test:
// `null` (default) delegates to the real one.
const versionOverride = vi.hoisted(() => ({ version: null as string | null }))
vi.mock("../../utils.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../utils.js")>()
	return { ...actual, getVersion: () => versionOverride.version ?? actual.getVersion() }
})

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

	it("keeps image bytes intact through message_end and before_provider_request while still redacting the text", async () => {
		const { api, invoke } = makePi()
		piiRedactionExtension(api)
		const tokenShaped = ["cio", "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF"].join("")
		const image = { type: "image", mimeType: "image/png", data: `iVBORw0KGgoA/+${tokenShaped}/+AAAAElFTkSuQmCC==` }
		const message = { role: "user", content: [{ type: "text", text: "mail alice@example.com" }, image] }

		const [stored] = (await invoke("message_end", { message })) as [{ message: typeof message }]
		expect(stored.message.content[1]).toEqual(image)
		expect(stored.message.content[0]).toEqual({ type: "text", text: "mail [REDACTED-EMAIL_ADDRESS]" })

		const dataUrl = { type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } }
		const payload = { messages: [{ role: "user", content: [dataUrl] }] }
		const [sent] = (await invoke("before_provider_request", { payload })) as [typeof payload]
		expect(sent.messages[0].content[0]).toEqual(dataUrl)
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
		contexts.clear()
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		resetOrgPolicyForTests()
		resetRedactorEngine()
		resetTokenVaults()
		rmSync(codingAgentDir, { recursive: true, force: true })
	})

	// One context (stable sessionManager object identity) per session id:
	// the vault lifecycle deletes by exact-owner identity.
	const contexts = new Map<string, ReturnType<typeof createContext>>()
	const ctxFor = (sessionId: string) => {
		const cached = contexts.get(sessionId)
		if (cached) return cached
		const created = createContext({ sessionManager: { getSessionId: () => sessionId } })
		contexts.set(sessionId, created)
		return created
	}

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

// ─── Resume attestation ──────────────────────────────────────────────────────
// A stored message is skipped by the resume request-walk only when the file
// carries write-time evidence (clean scan, zero engine failures, under the
// current detection fingerprint). Every case below fails if the
// corresponding guard is removed: trust without evidence, fingerprint
// match, failure handling, healing, seeding, and isolation.

describe("pii-redaction attestation — resume seeding from write-time evidence", () => {
	let codingAgentDir: string

	// Assembled, not literal (see the fixture-assembly note at the top).
	const EMAIL = ["attest.user", "example.org"].join("@")
	const currentFp = () => getRedactionFingerprint()

	beforeEach(() => {
		codingAgentDir = mkdtempSync(join(tmpdir(), "pii-attest-"))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", codingAgentDir)
		writeFileSync(join(codingAgentDir, "settings.json"), "{}")
		invalidateJsonCache(getResourceSettingsPath())
		resetOrgPolicyForTests()
		setResourceOverride(PII_REDACTION_RESOURCE_ID, true)
		resetRedactorEngine()
		resetTokenVaults()
		engineScanOverride.scanImpl = null
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		resetOrgPolicyForTests()
		resetRedactorEngine()
		resetTokenVaults()
		engineScanOverride.scanImpl = null
		rmSync(codingAgentDir, { recursive: true, force: true })
	})

	/** A ctx whose sessionManager serves `entries` from getEntries(). */
	const ctxForEntries = (entries: unknown[]) =>
		createContext({ sessionManager: { getEntries: () => entries as SessionEntry[] } })

	const messageEntry = (id: string, message: unknown) => ({ type: "message", id, message })
	const attestEntry = (items: { id: string; message: unknown }[], fp = currentFp()) => ({
		type: "custom",
		customType: PII_ATTEST_ENTRY_TYPE,
		data: { v: 1, fp, ids: items.map(({ id, message }) => ({ id, d: messageDigest(message) })) },
	})

	it("seeds attested messages — the first resumed request performs no scan", async () => {
		const { api, invoke, emitted } = makePi()
		piiRedactionExtension(api)

		// Raw PII in the stored message: a scan would redact it, so the raw
		// text surviving to the payload is the proof that no scan happened.
		const stored = { role: "user", content: `mail ${EMAIL}` }
		const tokenized = { role: "assistant", content: "already [REDACTED-EMAIL_ADDRESS] and [EMAIL_ADDRESS_3]" }
		const entries = [
			messageEntry("m1", stored),
			messageEntry("m2", tokenized),
			attestEntry([
				{ id: "m1", message: stored },
				{ id: "m2", message: tokenized },
			]),
		]
		const ctx = ctxForEntries(entries)

		await invoke("session_start", { reason: "resume" }, ctx)
		emitted.length = 0

		const [result] = (await invoke("before_provider_request", { payload: { messages: [stored, tokenized] } }, ctx)) as [
			{ messages: unknown[] },
		]
		expect(emitted).toEqual([])
		expect(JSON.stringify(result)).toContain(EMAIL)
		expect(result.messages[0]).toBe(stored)
	})

	it("scans and redacts unattested restored messages containing raw secrets", async () => {
		const { api, invoke, emitted } = makePi()
		piiRedactionExtension(api)

		const stored = { role: "user", content: `mail ${EMAIL}` }
		// The file DOES carry attestation — for a different, clean message.
		// m1 itself is unattested and must still be scanned.
		const cleanMsg = { role: "assistant", content: "clean" }
		const entries = [
			messageEntry("m0", cleanMsg),
			messageEntry("m1", stored),
			attestEntry([{ id: "m0", message: cleanMsg }]),
		]
		const ctx = ctxForEntries(entries)

		await invoke("session_start", { reason: "resume" }, ctx)
		const [result] = (await invoke("before_provider_request", { payload: { messages: [stored] } }, ctx)) as [
			{ messages: unknown[] },
		]
		const text = JSON.stringify(result)
		expect(text).not.toContain(EMAIL)
		expect(text).toContain("EMAIL_ADDRESS")
		expect(emitted.length).toBeGreaterThan(0)
	})

	it("does not seed attest entries made under a different detection fingerprint", async () => {
		const { api, invoke, emitted } = makePi()
		piiRedactionExtension(api)

		const stored = { role: "user", content: `mail ${EMAIL}` }
		// Evidence from another policy/build: the fingerprint never matches.
		const entries = [messageEntry("m1", stored), attestEntry([{ id: "m1", message: stored }], "0".repeat(16))]
		const ctx = ctxForEntries(entries)

		await invoke("session_start", { reason: "resume" }, ctx)
		const [result] = (await invoke("before_provider_request", { payload: { messages: [stored] } }, ctx)) as [
			{ messages: unknown[] },
		]
		expect(JSON.stringify(result)).not.toContain(EMAIL)
		expect(emitted.length).toBeGreaterThan(0)
	})

	it("does not attest a message whose message_end scan failed open", async () => {
		const h = makePi()
		piiRedactionExtension(h.api)
		engineScanOverride.scanImpl = () => Promise.reject(new Error("engine exploded"))
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		const stored = { role: "assistant", content: `mail ${EMAIL}` }
		const entries = [messageEntry("m1", stored)]

		const [replaced] = (await h.invoke("message_end", { message: stored })) as [{ message: typeof stored }]
		// Fail-open semantics preserved: original text returned.
		expect(replaced.message.content).toContain(EMAIL)

		await h.invoke("turn_end", { type: "turn_end", turnIndex: 0 }, ctxForEntries(entries))
		expect(h.getAppendedEntries(PII_ATTEST_ENTRY_TYPE)).toEqual([])
		errSpy.mockRestore()
	})

	it("does not cache a request scan that failed open — the next request rescans (regression)", async () => {
		const { api, invoke } = makePi()
		piiRedactionExtension(api)
		let scans = 0
		engineScanOverride.scanImpl = (text) => {
			// The walker scans every string in the message object (`role`
			// included) — count only the content string.
			if (text.includes("@")) scans += 1
			return Promise.reject(new Error("engine exploded"))
		}
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		const stored = { role: "user", content: `mail ${EMAIL}` }
		// A fresh payload per request, as the runner builds them: the hook
		// replaces payload.messages with the redacted array, so reusing one
		// event object would scan the redacted clone instead of `stored`.
		const makeEvent = () => ({ payload: { messages: [stored] } })

		await invoke("before_provider_request", makeEvent())
		expect(scans).toBe(1)
		await invoke("before_provider_request", makeEvent())
		// The pre-existing bug cached the fail-open result: the second
		// request was a cache hit and the raw text kept flowing.
		expect(scans).toBe(2)
		errSpy.mockRestore()
	})

	it("heals an unattested session: one clean scan, attested at turn_end, seeded on the next resume", async () => {
		const first = makePi()
		piiRedactionExtension(first.api)

		const stored = { role: "user", content: "nothing sensitive here" }
		const entries = [messageEntry("m1", stored)]
		const ctx = ctxForEntries(entries)

		// One clean full scan of previously-unattested history.
		await first.invoke("before_provider_request", { payload: { messages: [stored] } }, ctx)
		await first.invoke("turn_end", { type: "turn_end", turnIndex: 0 }, ctx)
		const appended = first.getAppendedEntries<AttestEntryData>(PII_ATTEST_ENTRY_TYPE)
		expect(appended).toEqual([{ v: 1, fp: currentFp(), ids: [{ id: "m1", d: messageDigest(stored) }] }])

		// Fresh process, fresh objects from the same file: the attest entry
		// now makes the first request scan-free.
		const restored = structuredClone(stored)
		const entries2 = [messageEntry("m1", restored), attestEntry([{ id: "m1", message: restored }])]
		const second = makePi()
		piiRedactionExtension(second.api)
		let scans = 0
		engineScanOverride.scanImpl = () => {
			scans += 1
			return Promise.resolve([])
		}
		const ctx2 = ctxForEntries(entries2)
		await second.invoke("session_start", { reason: "resume" }, ctx2)
		await second.invoke("before_provider_request", { payload: { messages: [restored] } }, ctx2)
		expect(scans).toBe(0)
		expect(second.emitted).toEqual([])
	})

	it("never attests messages written while redaction is disabled", async () => {
		setResourceOverride(PII_REDACTION_RESOURCE_ID, false)
		const h = makePi()
		piiRedactionExtension(h.api)

		const stored = { role: "user", content: `mail ${EMAIL}` }
		// message_end with the resource off: no redaction, no evidence.
		await h.invoke("message_end", { message: stored })

		setResourceOverride(PII_REDACTION_RESOURCE_ID, true)
		const entries = [messageEntry("m1", stored)]
		await h.invoke("turn_end", { type: "turn_end", turnIndex: 0 }, ctxForEntries(entries))
		expect(h.getAppendedEntries(PII_ATTEST_ENTRY_TYPE)).toEqual([])
	})

	it("seeds only for startup/resume/fork — never reload or new", async () => {
		const stored = { role: "user", content: `mail ${EMAIL}` }
		for (const [reason, shouldSeed] of [
			["reload", false],
			["new", false],
			["startup", true],
			["fork", true],
		] as const) {
			const h = makePi()
			piiRedactionExtension(h.api)
			// Fresh object per iteration: the module-level cache is shared.
			const msg = structuredClone(stored)
			const ctx = ctxForEntries([messageEntry("m1", msg), attestEntry([{ id: "m1", message: msg }])])
			await h.invoke("session_start", { reason }, ctx)
			h.emitted.length = 0
			await h.invoke("before_provider_request", { payload: { messages: [msg] } }, ctx)
			if (shouldSeed) expect(h.emitted).toEqual([])
			else expect(h.emitted.length).toBeGreaterThan(0)
		}
	})

	it("ignores forged or malformed attest entries without throwing", async () => {
		const { api, invoke, emitted } = makePi()
		piiRedactionExtension(api)

		const stored = { role: "user", content: `mail ${EMAIL}` }
		const entries = [
			messageEntry("m1", stored),
			{ type: "custom", id: "c1", customType: "other", data: {} },
			// Wrong schema version.
			{
				type: "custom",
				customType: PII_ATTEST_ENTRY_TYPE,
				data: { v: 2, fp: currentFp(), ids: [{ id: "m1", d: "x" }] },
			},
			// ids not an array.
			{ type: "custom", customType: PII_ATTEST_ENTRY_TYPE, data: { v: 1, fp: currentFp(), ids: "m1" } },
			// non-string ids.
			{ type: "custom", customType: PII_ATTEST_ENTRY_TYPE, data: { v: 1, fp: currentFp(), ids: [42] } },
			// id of a non-message entry.
			{ type: "custom", customType: PII_ATTEST_ENTRY_TYPE, data: { v: 1, fp: currentFp(), ids: ["c1"] } },
			// id matching no entry at all.
			{ type: "custom", customType: PII_ATTEST_ENTRY_TYPE, data: { v: 1, fp: currentFp(), ids: ["nope"] } },
			// missing data.
			{ type: "custom", customType: PII_ATTEST_ENTRY_TYPE, data: undefined },
			// different custom type entirely.
			{ type: "custom", customType: "something-else", data: { v: 1, fp: currentFp(), ids: ["m1"] } },
		]
		const ctx = ctxForEntries(entries)

		await invoke("session_start", { reason: "resume" }, ctx)
		const [result] = (await invoke("before_provider_request", { payload: { messages: [stored] } }, ctx)) as [
			{ messages: unknown[] },
		]
		expect(JSON.stringify(result)).not.toContain(EMAIL)
		expect(emitted.length).toBeGreaterThan(0)
	})

	it("scans a message whose reference did not come from the session entries (identity break)", async () => {
		const { api, invoke } = makePi()
		piiRedactionExtension(api)

		const stored = { role: "user", content: `mail ${EMAIL}` }
		const entries = [messageEntry("m1", stored), attestEntry([{ id: "m1", message: stored }])]
		const ctx = ctxForEntries(entries)

		await invoke("session_start", { reason: "resume" }, ctx)
		// Same content, different object: the seeded cache is keyed by
		// reference, so this is a miss and must be scanned.
		const clone = structuredClone(stored)
		const [result] = (await invoke("before_provider_request", { payload: { messages: [clone] } }, ctx)) as [
			{ messages: unknown[] },
		]
		expect(JSON.stringify(result)).not.toContain(EMAIL)
	})

	it("keeps attestation state isolated between two concurrent sessionManagers", async () => {
		const h = makePi()
		const { invoke, emitted, getAppendedEntries } = h
		piiRedactionExtension(h.api)

		const msgA = { role: "user", content: "clean A" }
		const msgB = { role: "user", content: `mail ${EMAIL}` }
		const ctxA = ctxForEntries([messageEntry("a1", msgA)])
		const ctxB = ctxForEntries([messageEntry("b1", msgB)])

		// Interleaved at the production await points.
		await invoke("session_start", { reason: "resume" }, ctxA)
		await invoke("before_provider_request", { payload: { messages: [msgA] } }, ctxA) // heals A
		await invoke("turn_end", { type: "turn_end", turnIndex: 0 }, ctxB) // B has no evidence
		expect(getAppendedEntries(PII_ATTEST_ENTRY_TYPE)).toEqual([])

		await invoke("turn_end", { type: "turn_end", turnIndex: 0 }, ctxA) // A attests only its own id
		expect(getAppendedEntries<AttestEntryData>(PII_ATTEST_ENTRY_TYPE)).toEqual([
			{ v: 1, fp: currentFp(), ids: [{ id: "a1", d: messageDigest(msgA) }] },
		])

		// B's message was never seeded by A's evidence: still scanned.
		await invoke("before_provider_request", { payload: { messages: [msgB] } }, ctxB)
		expect(emitted.length).toBeGreaterThan(0)
	})

	it("survives a stale extension context at turn_end — nothing attested, no throw", async () => {
		const h = makePi()
		piiRedactionExtension(h.api)

		const stored = { role: "user", content: "clean" }
		const ctx = ctxForEntries([messageEntry("m1", stored)])
		await h.invoke("before_provider_request", { payload: { messages: [stored] } }, ctx) // heal

		h.invalidate()
		await expect(h.invoke("turn_end", { type: "turn_end", turnIndex: 0 }, ctx)).resolves.toBeDefined()
		expect(h.getAppendedEntries(PII_ATTEST_ENTRY_TYPE)).toEqual([])
	})

	it("never attests a stored message whose clean scan still redacts something (raw PII on disk)", async () => {
		const h = makePi()
		piiRedactionExtension(h.api)

		// A legacy file: the raw email is on disk. The request scan redacts
		// it for the provider, but the stored object still holds raw text —
		// so the scan output can never match the stored content, and the
		// message must never be attested. (Attesting it would seed the raw
		// stored form on the next resume.)
		const stored = { role: "user", content: `mail ${EMAIL}` }
		const ctx = ctxForEntries([messageEntry("m1", stored)])

		const [result] = (await h.invoke("before_provider_request", { payload: { messages: [stored] } }, ctx)) as [
			{ messages: unknown[] },
		]
		expect(JSON.stringify(result)).not.toContain(EMAIL)
		await h.invoke("turn_end", { type: "turn_end", turnIndex: 0 }, ctx)
		expect(h.getAppendedEntries(PII_ATTEST_ENTRY_TYPE)).toEqual([])
	})

	it("does not seed an attest entry whose recorded digest does not match the stored content", async () => {
		const h = makePi()
		piiRedactionExtension(h.api)

		// Forged: right fingerprint, right id, wrong digest. The seed-side
		// digest verification must fail closed into a rescan.
		const stored = { role: "user", content: `mail ${EMAIL}` }
		const entries = [
			messageEntry("m1", stored),
			{
				type: "custom",
				customType: PII_ATTEST_ENTRY_TYPE,
				data: { v: 1, fp: currentFp(), ids: [{ id: "m1", d: "0".repeat(64) }] },
			},
		]
		const ctx = ctxForEntries(entries)

		await h.invoke("session_start", { reason: "resume" }, ctx)
		const [result] = (await h.invoke("before_provider_request", { payload: { messages: [stored] } }, ctx)) as [
			{ messages: unknown[] },
		]
		expect(JSON.stringify(result)).not.toContain(EMAIL)
	})

	it("appends exactly one attest entry for a second turn_end over unchanged entries", async () => {
		const h = makePi()
		piiRedactionExtension(h.api)

		const stored = { role: "assistant", content: "clean text" }
		const ctx = ctxForEntries([messageEntry("m1", stored)])
		await h.invoke("message_end", { message: stored })
		await h.invoke("turn_end", { type: "turn_end", turnIndex: 0 }, ctx)
		await h.invoke("turn_end", { type: "turn_end", turnIndex: 0 }, ctx)
		expect(h.getAppendedEntries(PII_ATTEST_ENTRY_TYPE)).toHaveLength(1)
	})

	it("disables attestation when the build version is unreadable", async () => {
		versionOverride.version = "unknown"
		resetRedactorEngine()
		try {
			// The fingerprint degrades to the disabled sentinel.
			expect(getRedactionFingerprint()).toBe("")

			const h = makePi()
			piiRedactionExtension(h.api)
			const stored = { role: "assistant", content: "clean text" }
			const ctx = ctxForEntries([messageEntry("m1", stored)])
			await h.invoke("message_end", { message: stored })
			await h.invoke("turn_end", { type: "turn_end", turnIndex: 0 }, ctx)
			// No evidence recorded, nothing attested, nothing seedable.
			expect(h.getAppendedEntries(PII_ATTEST_ENTRY_TYPE)).toEqual([])
		} finally {
			versionOverride.version = null
			resetRedactorEngine()
		}
	})

	it("fails safe when an earlier message_end handler returns a fresh replacement object", async () => {
		const h = makePi()
		// The runner chains message_end handlers: an earlier handler's
		// returned replacement becomes the message later handlers receive,
		// but the ORIGINAL event.message is what gets persisted (in-place).
		// Simulate that chain manually around pii-redaction's handler.
		h.api.on("message_end", (event: unknown) => {
			const msg = (event as { message: { role: string } }).message
			return { message: { ...msg } } as never
		})
		piiRedactionExtension(h.api)
		const handlers = h.getHandlers("message_end")
		expect(handlers.length).toBe(2)

		const stored = { role: "assistant", content: "clean text" }
		const runnerCtx = createContext()
		const earlier = (await handlers[0]({ message: stored }, runnerCtx)) as unknown as {
			message: typeof stored
		}
		expect(earlier.message).not.toBe(stored) // a fresh replacement object

		// pii-redaction's handler receives the replacement — its evidence
		// keys the intermediate object, not the one that persists.
		await handlers[1]({ message: earlier.message }, runnerCtx)

		const ctx = ctxForEntries([messageEntry("m1", stored)])
		await h.invoke("turn_end", { type: "turn_end", turnIndex: 0 }, ctx)
		// Fail-safe: no write-time attest happened.
		expect(h.getAppendedEntries(PII_ATTEST_ENTRY_TYPE)).toEqual([])

		// Healing recovers: the next request scans the persisted original,
		// re-keys the evidence, and the following turn end attests it.
		await h.invoke("before_provider_request", { payload: { messages: [stored] } }, ctx)
		await h.invoke("turn_end", { type: "turn_end", turnIndex: 0 }, ctx)
		expect(h.getAppendedEntries<AttestEntryData>(PII_ATTEST_ENTRY_TYPE)).toHaveLength(1)
	})

	it("contract: real SessionManager round-trip — attest persists, identity holds, context untouched", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pii-attest-sm-"))
		const sm = SessionManager.create(dir, dir)
		const stored = { role: "user", content: [{ type: "text", text: `mail ${EMAIL}` }], timestamp: 1 }
		const entryId = sm.appendMessage(stored as never)
		sm.appendCustomEntry(PII_ATTEST_ENTRY_TYPE, {
			v: 1,
			fp: currentFp(),
			ids: [{ id: entryId, d: messageDigest(stored) }],
		})
		const file = sm.getSessionFile()
		if (!file) throw new Error("session file missing")

		const reopened = SessionManager.open(file, dir)
		const entries = reopened.getEntries() as Array<{
			type: string
			id?: string
			message?: unknown
			customType?: string
			data?: unknown
		}>

		// The identity chain the seeding relies on: context messages ARE the
		// entry message objects, so seeding keyed on entry.message hits at
		// request time. Pins the upstream behavior against drift.
		const ctxMsgs = reopened.buildSessionContext().messages
		const msgEntries = entries.filter((e) => e.type === "message")
		expect(msgEntries).toHaveLength(1)
		expect(ctxMsgs).toHaveLength(1)
		expect(ctxMsgs[0]).toBe(msgEntries[0].message)

		// The attest entry round-trips as a custom entry and never enters
		// the LLM context (contextMessages count already proves it).
		const attest = entries.find((e) => e.type === "custom")
		expect(attest?.customType).toBe(PII_ATTEST_ENTRY_TYPE)

		// End-to-end over the real file: seed, then a scan-free request.
		const h = makePi()
		const { invoke, emitted } = h
		piiRedactionExtension(h.api)
		const ctx = ctxForEntries(entries)
		await invoke("session_start", { reason: "resume" }, ctx)
		const [result] = (await invoke(
			"before_provider_request",
			{ payload: { messages: [msgEntries[0].message] } },
			ctx,
		)) as [{ messages: unknown[] }]
		expect(emitted).toEqual([])
		expect(JSON.stringify(result)).toContain(EMAIL)

		rmSync(dir, { recursive: true, force: true })
	})
})
