import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetRedactorEngine } from "../extensions/pii-redaction/redactor.js"
import { redactHtmlExport, redactJsonlExport } from "./export-post-process.js"

function makeTmpFile(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "kimchi-export-test-"))
	const filePath = join(dir, "export.jsonl")
	writeFileSync(filePath, content, "utf-8")
	return filePath
}

describe("redactJsonlExport", () => {
	beforeEach(() => resetRedactorEngine())
	afterEach(() => resetRedactorEngine())

	it("redacts API keys and Bearer tokens from JSONL transcript entries", async () => {
		const entries = [
			JSON.stringify({
				type: "user",
				id: "msg-1",
				content: "My API key is AKIAIOSFODNN7EXAMPLE",
			}),
			JSON.stringify({
				type: "assistant",
				id: "msg-2",
				content: "Using Bearer sk-1234567890abcdef1234567890abcdef",
			}),
		].join("\n")
		const filePath = makeTmpFile(entries)

		await redactJsonlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
		expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE")
		expect(result).not.toContain("1234567890abcdef1234567890abcdef")
		expect(result).toContain("[REDACTED-AWS_ACCESS_KEY]")
		expect(result).toContain("[REDACTED-CRYPTO]")
		// Structure preserved — id and type fields intact
		expect(result).toContain('"msg-1"')
		expect(result).toContain('"msg-2"')
		expect(result).toContain('"type":"user"')
		expect(result).toContain('"type":"assistant"')
	})

	it("redacts email and SSN from tool result entries", async () => {
		const entries = [
			JSON.stringify({
				type: "tool_result",
				id: "tr-1",
				data: {
					output: "Contact john.doe@example.com, SSN: 489-36-2157",
				},
			}),
		].join("\n")
		const filePath = makeTmpFile(entries)

		await redactJsonlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
		expect(result).not.toContain("john.doe@example.com")
		expect(result).not.toContain("489-36-2157")
		expect(result).toContain("[REDACTED-EMAIL_ADDRESS]")
		expect(result).toContain("[REDACTED-US_SSN]")
		// Nested structure preserved
		expect(result).toContain('"tool_result"')
		expect(result).toContain('"tr-1"')
		expect(result).toContain('"data"')
		expect(result).toContain('"output"')
	})

	it("preserves entries with no PII unchanged", async () => {
		const entry = JSON.stringify({
			type: "user",
			id: "msg-clean",
			content: "This message has no secrets at all.",
		})
		const filePath = makeTmpFile(entry)

		await redactJsonlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
		expect(result).toContain('"msg-clean"')
		expect(result).toContain("This message has no secrets at all.")
	})

	it("passes through non-JSON lines unchanged", async () => {
		const filePath = makeTmpFile("not json at all\n")

		await redactJsonlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
		expect(result).toContain("not json at all")
	})
})

describe("redactHtmlExport", () => {
	beforeEach(() => resetRedactorEngine())
	afterEach(() => resetRedactorEngine())

	it("redacts secrets from base64-encoded session data in HTML export", async () => {
		const sessionData = {
			entries: [
				{
					type: "user",
					id: "msg-1",
					content: "Key: AKIAIOSFODNN7EXAMPLE, Email: admin@cast.ai",
				},
			],
		}
		const base64 = Buffer.from(JSON.stringify(sessionData)).toString("base64")
		const dir = mkdtempSync(join(tmpdir(), "kimchi-html-test-"))
		const filePath = join(dir, "export.html")
		writeFileSync(
			filePath,
			`<html><body><script id="session-data" type="application/json">${base64}</script></body></html>`,
			"utf-8",
		)

		await redactHtmlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
		expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE")
		expect(result).not.toContain("admin@cast.ai")
		// Decode the redacted base64 to verify structure preserved
		const match = result.match(/<script id="session-data" type="application\/json">([A-Za-z0-9+/=]+)<\/script>/)
		expect(match).not.toBeNull()
		if (!match || !match[1]) throw new Error("session-data not found")
		const decoded = JSON.parse(Buffer.from(match[1], "base64").toString("utf-8"))
		expect(decoded.entries[0].id).toBe("msg-1")
		expect(decoded.entries[0].type).toBe("user")
		expect(decoded.entries[0].content).toContain("[REDACTED-AWS_ACCESS_KEY]")
		expect(decoded.entries[0].content).toContain("[REDACTED-EMAIL_ADDRESS]")
	})

	it("leaves file unchanged when session-data tag is missing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-html-test-"))
		const filePath = join(dir, "export.html")
		const original = "<html><body><p>No session data here</p></body></html>"
		writeFileSync(filePath, original, "utf-8")

		await redactHtmlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
		expect(result).toBe(original)
	})
})
