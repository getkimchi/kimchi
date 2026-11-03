import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetRedactorEngine } from "../extensions/pii-redaction/redactor.js"
import { postProcessHtmlExportOnce, postProcessJsonlExportOnce, runSecureExport } from "./export-post-process.js"
import * as sessionMetadataStore from "./session-metadata-store.js"
import { _resetSessionMetadataStore } from "./session-metadata-store.js"

// Toggleable engine-scan override for the fail-closed end-to-end tests. When
// `scanImpl` is null (the default) createEngine returns the real engine; the
// engine-failure test sets a rejecting scan to simulate a redaction failure.
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
			// Delegate to the real engine but intercept `scan` — Object.create
			// keeps the prototype (setExcludeEntities etc.) intact.
			const overridden = Object.create(engine) as typeof engine
			overridden.scan = engineScanOverride.scanImpl as typeof engine.scan
			return overridden
		},
	}
})

function makeTmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix))
}

function buildRawHtml(sessionData: unknown): string {
	const encoded = Buffer.from(JSON.stringify(sessionData)).toString("base64")
	return `<html><body><script id="session-data" type="application/json">${encoded}</script></body></html>`
}

function readHtmlPayload(html: string): Record<string, unknown> {
	const match = html.match(/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/)
	if (!match?.[1]) throw new Error("session-data script not found")
	return JSON.parse(Buffer.from(match[1], "base64").toString("utf-8")) as Record<string, unknown>
}

describe("single-pass export redaction (assemble-then-redact)", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = makeTmpDir("kimchi-export-redact-")
		_resetSessionMetadataStore()
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
		resetRedactorEngine()
		vi.restoreAllMocks()
	})

	it("redacts secrets from JSONL entries in the single pass", async () => {
		const entries = [
			JSON.stringify({ type: "session", version: 3, id: "s1" }),
			JSON.stringify({
				type: "message",
				id: "msg-1",
				message: { role: "user", content: "My API key is AKIAIOSFODNN7EXAMPLE" },
			}),
			JSON.stringify({
				type: "custom",
				id: "diag-1",
				customType: "request_diagnostics",
				data: { status: 200, traceId: "diag-trace-123" },
			}),
		].join("\n")
		const filePath = join(tmpDir, "export.jsonl")
		writeFileSync(filePath, `${entries}\n`, "utf-8")

		await postProcessJsonlExportOnce(filePath)

		const result = readFileSync(filePath, "utf-8")
		expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE")
		expect(result).toContain("[REDACTED-AWS_ACCESS_KEY]")
		// Trace IDs survive redaction unchanged.
		expect(result).toContain("diag-trace-123")
		expect(JSON.parse(result.split("\n")[0] ?? "").appVersion).toBeDefined()
	})

	it("redacts the JSONL header systemPrompt", async () => {
		const lines = [JSON.stringify({ type: "session", version: 3, id: "s1" })]
		const filePath = join(tmpDir, "export.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		await postProcessJsonlExportOnce(filePath, {
			systemPrompt: "Use the gateway key sk-abcdef1234567890 for auth.",
		})

		const result = readFileSync(filePath, "utf-8")
		expect(result).not.toContain("sk-abcdef1234567890")
		const header = JSON.parse(result.split("\n")[0] ?? "")
		expect(header.systemPrompt).toContain("[REDACTED-OPENAI_API_KEY]")
	})

	it("redacts the HTML top-level systemPrompt", async () => {
		const sessionData = {
			version: 3,
			id: "s1",
			systemPrompt: "Contact admin@cast.ai — token ghp_1234567890abcdef1234567890abcdef",
			entries: [],
		}
		const filePath = join(tmpDir, "export.html")
		writeFileSync(filePath, buildRawHtml(sessionData), "utf-8")

		await postProcessHtmlExportOnce(filePath)

		const data = readHtmlPayload(readFileSync(filePath, "utf-8"))
		expect(data.systemPrompt).not.toContain("admin@cast.ai")
		expect(data.systemPrompt).not.toContain("ghp_1234567890abcdef1234567890abcdef")
		expect(data.systemPrompt).toContain("[REDACTED-EMAIL_ADDRESS]")
	})

	it("redacts a secret in a config_changed value in the final file", async () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(undefined)
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([
			{ key: "apiKey", value: "sk-leaked-secret-123456", timestamp: 1234 },
		] as sessionMetadataStore.ConfigChangeRecord[])

		// JSONL
		const jsonlPath = join(tmpDir, "changes.jsonl")
		writeFileSync(jsonlPath, `${JSON.stringify({ type: "session", version: 3, id: "s1" })}\n`, "utf-8")
		await postProcessJsonlExportOnce(jsonlPath)
		const jsonlResult = readFileSync(jsonlPath, "utf-8")
		expect(jsonlResult).not.toContain("sk-leaked-secret-123456")
		expect(jsonlResult).toContain("[REDACTED-OPENAI_API_KEY]")

		// HTML
		const htmlPath = join(tmpDir, "changes.html")
		writeFileSync(htmlPath, buildRawHtml({ version: 3, id: "s1", entries: [] }), "utf-8")
		await postProcessHtmlExportOnce(htmlPath)
		const htmlResult = readFileSync(htmlPath, "utf-8")
		expect(htmlResult).not.toContain("sk-leaked-secret-123456")
	})

	it("redacts the persona system prompt and transcript inside a sub-agent tab payload", async () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(undefined)
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([])
		const sessionData = {
			version: 3,
			id: "s1",
			entries: [
				{
					type: "custom",
					id: "sub-1",
					parentId: null,
					customType: "subagents:record",
					data: {
						id: "agent-001",
						type: "Explore",
						status: "completed",
						startedAt: 1700000000000,
						completedAt: 1700000010000,
						systemPrompt: "Authenticate with sk-persona-secret-key-9876.",
						transcript: [
							{
								isSidechain: true,
								agentId: "agent-001",
								type: "user",
								message: { role: "user", content: "ping john.doe@example.com" },
								timestamp: "2026-01-01T00:00:00.000Z",
								cwd: "/project",
							},
						],
					},
				},
			],
		}
		const filePath = join(tmpDir, "tab.html")
		writeFileSync(filePath, buildRawHtml(sessionData), "utf-8")

		await postProcessHtmlExportOnce(filePath)

		const result = readFileSync(filePath, "utf-8")
		// The tab payload script exists…
		const dataMatch = result.match(/id="subagent-data-agent-001">([\s\S]*?)<\/script>/)
		expect(dataMatch).not.toBeNull()
		if (!dataMatch) throw new Error("subagent data not found")
		// …and its decoded content is redacted.
		const subData = JSON.parse(Buffer.from(dataMatch[1], "base64").toString("utf-8")) as {
			systemPrompt?: string
			entries: Array<{ message: { content: unknown } }>
		}
		expect(subData.systemPrompt).not.toContain("sk-persona-secret-key-9876")
		expect(subData.systemPrompt).toContain("[REDACTED-OPENAI_API_KEY]")
		const transcriptText = JSON.stringify(subData.entries[0]?.message)
		expect(transcriptText).not.toContain("john.doe@example.com")
		expect(transcriptText).toContain("[REDACTED-EMAIL_ADDRESS]")
		// The tab bar's visible label/subtitle survived (they carry no secrets).
		expect(result).toContain("Explore")
	})

	it("passes clean config values through unchanged (no over-redaction)", async () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(undefined)
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([
			{ key: "theme", value: "nord-light", timestamp: 1000 },
		] as sessionMetadataStore.ConfigChangeRecord[])
		const filePath = join(tmpDir, "clean.jsonl")
		writeFileSync(filePath, `${JSON.stringify({ type: "session", version: 3, id: "s1" })}\n`, "utf-8")

		await postProcessJsonlExportOnce(filePath)

		const result = readFileSync(filePath, "utf-8")
		expect(result).toContain("nord-light")
		expect(result).not.toContain("[REDACTED")
	})

	it("is idempotent — re-running the redaction changes nothing", async () => {
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s1" }),
			JSON.stringify({
				type: "message",
				id: "m1",
				message: { role: "user", content: "key AKIAIOSFODNN7EXAMPLE here" },
			}),
		]
		const filePath = join(tmpDir, "idempotent.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		await postProcessJsonlExportOnce(filePath)
		const first = readFileSync(filePath, "utf-8")
		await postProcessJsonlExportOnce(filePath)
		const second = readFileSync(filePath, "utf-8")

		expect(second).toBe(first)
		expect(second).not.toContain("AKIAIOSFODNN7EXAMPLE")
	})
})

describe("export redaction fail-closed (engine failure)", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = makeTmpDir("kimchi-export-failclosed-")
		_resetSessionMetadataStore()
		resetRedactorEngine()
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
		resetRedactorEngine()
		engineScanOverride.scanImpl = null
		vi.restoreAllMocks()
	})

	it("a redaction engine failure aborts the export: rejects, temp swept, pre-existing destination intact, no new file", async () => {
		engineScanOverride.scanImpl = () => Promise.reject(new Error("engine exploded"))
		const finalPath = join(tmpDir, "out.html")
		writeFileSync(finalPath, "previous export — must survive", "utf-8")
		chmodSync(finalPath, 0o640)
		const before = readFileSync(finalPath, "utf-8")

		await expect(
			runSecureExport({
				mode: "html",
				outputPath: "out.html",
				session: { sessionFile: join(tmpDir, "s.jsonl"), cwd: tmpDir },
				upstreamExport: (tempPath) => {
					writeFileSync(tempPath, buildRawHtml({ version: 3, id: "s1", entries: [] }), "utf-8")
					return tempPath
				},
				pipeline: (tempPath) => postProcessHtmlExportOnce(tempPath),
			}),
		).rejects.toThrow("engine exploded")

		// The pre-existing export is byte-intact at its original mode.
		expect(readFileSync(finalPath, "utf-8")).toBe(before)
		expect(statSync(finalPath).mode & 0o777).toBe(0o640)
		// No temp left, no new file anywhere.
		expect(readdirSync(tmpDir)).toEqual(["out.html"])
	})

	it("a redaction engine failure aborts a fresh export too — no file this attempt created", async () => {
		engineScanOverride.scanImpl = () => Promise.reject(new Error("engine exploded"))

		await expect(
			runSecureExport({
				mode: "jsonl",
				outputPath: "new-export.jsonl",
				session: { sessionFile: join(tmpDir, "s.jsonl"), cwd: tmpDir },
				upstreamExport: (tempPath) => {
					writeFileSync(tempPath, `${JSON.stringify({ type: "session", version: 3, id: "s1" })}\n`, "utf-8")
					return tempPath
				},
				pipeline: (tempPath) => postProcessJsonlExportOnce(tempPath),
			}),
		).rejects.toThrow("engine exploded")

		expect(existsSync(join(tmpDir, "new-export.jsonl"))).toBe(false)
		expect(readdirSync(tmpDir)).toEqual([])
	})
})
