import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { invalidateJsonCache } from "../../config/json.js"
import { getResourceSettingsPath } from "../../resources/store.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import piiRedactionExtension from "./index.js"
import { resetRedactorEngine } from "./redactor.js"

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
