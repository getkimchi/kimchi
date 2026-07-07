import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { appendBeforeBody, postProcessHtmlExport, postProcessJsonlExport } from "./export-post-process.js"
import * as sessionMetadataStore from "./session-metadata-store.js"
import { _resetSessionMetadataStore } from "./session-metadata-store.js"
import type { ConfigChangeRecord, SessionStartMetadata } from "./session-metadata-store.js"

function mockMetadata(): SessionStartMetadata {
	return {
		os: {
			"telemetry.os": "linux",
			"telemetry.arch": "amd64",
			"telemetry.host_os": "linux",
			"telemetry.is_wsl": false,
		},
		config: {
			"config.model": "test/model",
			"config.provider": "test-provider",
			"config.search_provider": "test-search",
			"config.telemetry_enabled": false,
			"config.permission_mode": "default",
			"config.agents_enabled": true,
			"config.mcp_server_count": 2,
			"config.multi_model_enabled": true,
			"config.model_roles.orchestrator": "test/orch",
			"config.model_roles.planner": "test/p1,test/p2",
			"config.model_roles.builder": "test/build",
			"config.model_roles.reviewer": "test/rev1,test/rev2",
			"config.model_roles.explorer": "test/explore",
			"config.model_roles.researcher": "test/research",
			"config.model_roles.judge": "test/judge",
		},
		capturedAt: 1700000000000,
	}
}

describe("postProcessJsonlExport", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = join(tmpdir(), `kimchi-jsonl-export-test-${Date.now()}`)
		mkdirSync(tmpDir, { recursive: true })
		_resetSessionMetadataStore()
	})

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true })
		} catch {
			// ignore cleanup errors
		}
		vi.restoreAllMocks()
	})

	it("injects appVersion into the session header line", () => {
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s1" }),
			JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hello" } }),
		]
		const filePath = join(tmpDir, "export.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		postProcessJsonlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		const header = JSON.parse(result[0])
		expect(header.type).toBe("session")
		expect(header.appVersion).toBeDefined()
	})

	it("preserves trace ID injection", () => {
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s1" }),
			JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hello" } }),
			JSON.stringify({ type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: "hi" } }),
			JSON.stringify({
				type: "custom",
				id: "t1",
				parentId: "e2",
				customType: "trace_ids",
				data: { traceIds: ["trace-abc"] },
			}),
		]
		const filePath = join(tmpDir, "export-trace.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		postProcessJsonlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		const assistant = JSON.parse(result[2])
		expect(assistant.traceIds).toEqual(["trace-abc"])
	})

	it("is idempotent when run twice", () => {
		const lines = [JSON.stringify({ type: "session", version: 3, id: "s1" })]
		const filePath = join(tmpDir, "export-idempotent.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		postProcessJsonlExport(filePath)
		postProcessJsonlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		expect(result.length).toBe(1)
		const header = JSON.parse(result[0])
		expect(header.appVersion).toBeDefined()
	})

	it("does not inject appVersion when the first line is not a session header", () => {
		const lines = [
			JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hello" } }),
		]
		const filePath = join(tmpDir, "export-no-header.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		postProcessJsonlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		const entry = JSON.parse(result[0])
		expect(entry.appVersion).toBeUndefined()
	})

	it("throws on malformed JSONL", () => {
		const filePath = join(tmpDir, "export-bad.jsonl")
		writeFileSync(filePath, "not-json\n", "utf-8")
		expect(() => postProcessJsonlExport(filePath)).toThrow()
	})

	it("injects OS metadata into the session header line", () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(mockMetadata())
		const lines = [JSON.stringify({ type: "session", version: 3, id: "s1" })]
		const filePath = join(tmpDir, "export-os.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		postProcessJsonlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		const header = JSON.parse(result[0])
		expect(header["telemetry.os"]).toBe("linux")
		expect(header["telemetry.arch"]).toBe("amd64")
		expect(header["telemetry.host_os"]).toBe("linux")
		expect(header["telemetry.is_wsl"]).toBe(false)
	})

	it("injects config snapshot incl. multimodel into the session header line", () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(mockMetadata())
		const lines = [JSON.stringify({ type: "session", version: 3, id: "s1" })]
		const filePath = join(tmpDir, "export-config.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		postProcessJsonlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		const header = JSON.parse(result[0])
		expect(header["config.multi_model_enabled"]).toBe(true)
		expect(header["config.model_roles.orchestrator"]).toBe("test/orch")
		expect(header["config.model_roles.planner"]).toBe("test/p1,test/p2")
		expect(header["config.model_roles.builder"]).toBe("test/build")
		expect(header["config.model_roles.reviewer"]).toBe("test/rev1,test/rev2")
		expect(header["config.model_roles.explorer"]).toBe("test/explore")
		expect(header["config.model_roles.researcher"]).toBe("test/research")
		expect(header["config.model_roles.judge"]).toBe("test/judge")
		const configKeys = Object.keys(header).filter((k) => k.startsWith("config."))
		expect(configKeys.length).toBe(15)
	})

	it("appends config-change entries as custom entries", () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(undefined)
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([
			{ key: "theme", value: "dark", timestamp: 1234567890 },
			{ key: "count", value: 5, timestamp: 1234567891 },
		] as ConfigChangeRecord[])
		const lines = [JSON.stringify({ type: "session", version: 3, id: "s1" })]
		const filePath = join(tmpDir, "export-changes.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		postProcessJsonlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		expect(result.length).toBe(3)
		const first = JSON.parse(result[1])
		expect(first.type).toBe("custom")
		expect(first.customType).toBe("config_changed")
		expect(first.parentId).toBeNull()
		expect(first.id).toBe("config_changed:theme:1234567890")
		expect(first.data.key).toBe("theme")
		expect(first.data.value).toBe("dark")
		expect(first.data.timestamp).toBe(1234567890)
		const second = JSON.parse(result[2])
		expect(second.type).toBe("custom")
		expect(second.customType).toBe("config_changed")
		expect(second.parentId).toBeNull()
		expect(second.id).toBe("config_changed:count:1234567891")
		expect(second.data.value).toBe(5)
	})

	it("config-change values are PII-redacted", () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(undefined)
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([
			{ key: "endpoint", value: "redacted:url", timestamp: 1000 },
			{ key: "apiKey", value: "redacted:secret", timestamp: 1001 },
			{ key: "email", value: "redacted:email", timestamp: 1002 },
		] as ConfigChangeRecord[])
		const lines = [JSON.stringify({ type: "session", version: 3, id: "s1" })]
		const filePath = join(tmpDir, "export-redacted.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		postProcessJsonlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		// header + 3 change entries
		expect(result.length).toBe(4)
		const values = result.slice(1).map((l) => JSON.parse(l).data.value)
		expect(values).toEqual(["redacted:url", "redacted:secret", "redacted:email"])
		// assert the redacted forms pass through verbatim — not raw URL/email/key
		for (const v of values) {
			expect(v).not.toContain("http")
			expect(v).not.toContain("@")
			expect(v).not.toContain("sk-")
		}
	})

	it("works with telemetry disabled — change capture decoupled from telemetry", () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(mockMetadata())
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([
			{ key: "theme", value: "dark", timestamp: 9999 },
		] as ConfigChangeRecord[])
		const lines = [JSON.stringify({ type: "session", version: 3, id: "s1" })]
		const filePath = join(tmpDir, "export-telemetry-off.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		postProcessJsonlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		expect(result.length).toBe(2)
		const header = JSON.parse(result[0])
		expect(header["config.telemetry_enabled"]).toBe(false)
		expect(header["telemetry.os"]).toBe("linux")
		const change = JSON.parse(result[1])
		expect(change.type).toBe("custom")
		expect(change.customType).toBe("config_changed")
	})

	it("is idempotent — running twice yields identical output with no duplicate change entries", () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(mockMetadata())
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([
			{ key: "theme", value: "dark", timestamp: 1234567890 },
			{ key: "count", value: 5, timestamp: 1234567891 },
		] as ConfigChangeRecord[])
		const lines = [JSON.stringify({ type: "session", version: 3, id: "s1" })]
		const filePath = join(tmpDir, "export-idempotent-changes.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		postProcessJsonlExport(filePath)
		const firstRun = readFileSync(filePath, "utf-8")

		postProcessJsonlExport(filePath)
		const secondRun = readFileSync(filePath, "utf-8")

		expect(secondRun).toBe(firstRun)
		const result = secondRun.split("\n").filter((l) => l.trim().length > 0)
		expect(result.length).toBe(3)
	})

	it("no-ops when store is empty (legacy session re-import)", () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(undefined)
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([])
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s1" }),
			JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hello" } }),
		]
		const filePath = join(tmpDir, "export-empty-store.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		postProcessJsonlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		expect(result.length).toBe(2)
		const header = JSON.parse(result[0])
		expect(header.appVersion).toBeDefined()
		expect(header["telemetry.os"]).toBeUndefined()
	})
})

describe("postProcessHtmlExport", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = join(tmpdir(), `kimchi-html-export-test-${Date.now()}`)
		mkdirSync(tmpDir, { recursive: true })
		_resetSessionMetadataStore()
	})

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true })
		} catch {
			// ignore cleanup errors
		}
		vi.restoreAllMocks()
	})

	it("injects trace-id renderer script before </body>", () => {
		const sessionData = {
			version: 3,
			id: "test-session",
			entries: [
				{ id: "m1", parentId: null, type: "message", message: { role: "user", content: "hello" } },
				{ id: "m2", parentId: "m1", type: "message", message: { role: "assistant", content: "hi" } },
			],
		}
		const encoded = Buffer.from(JSON.stringify(sessionData)).toString("base64")
		const mockHtml = `<!DOCTYPE html>
<html>
<head><title>Export</title></head>
<body>
<script id="session-data" type="application/json">${encoded}</script>
</body>
</html>`

		const outputPath = join(tmpDir, "export.html")
		writeFileSync(outputPath, mockHtml, "utf-8")

		postProcessHtmlExport(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		expect(result).toContain('id="trace-id-renderer"')
		expect(result).toContain("</body>")
	})

	it("is idempotent when run twice", () => {
		const mockHtml = `<!DOCTYPE html>
<html>
<head><title>Export</title></head>
<body>
<script id="session-data" type="application/json">${Buffer.from(JSON.stringify({ version: 3, id: "s", entries: [] })).toString("base64")}</script>
</body>
</html>`

		const outputPath = join(tmpDir, "idempotent.html")
		writeFileSync(outputPath, mockHtml, "utf-8")

		postProcessHtmlExport(outputPath)
		postProcessHtmlExport(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		const traceIdCount = result.split('id="trace-id-renderer"').length - 1
		expect(traceIdCount).toBe(1)
	})

	it("appends footer and script to end when </body> is missing", () => {
		const sessionData = {
			version: 3,
			id: "test-session",
			entries: [
				{ id: "m1", parentId: null, type: "message", message: { role: "user", content: "hello" } },
				{ id: "m2", parentId: "m1", type: "message", message: { role: "assistant", content: "hi" } },
			],
		}
		const encoded = Buffer.from(JSON.stringify(sessionData)).toString("base64")
		const mockHtml = `<!DOCTYPE html>
<html>
<head><title>Export</title></head>
<body>
<script id="session-data" type="application/json">${encoded}</script>`

		const outputPath = join(tmpDir, "no-body.html")
		writeFileSync(outputPath, mockHtml, "utf-8")

		postProcessHtmlExport(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		expect(result).toContain('id="trace-id-renderer"')
		expect(result.endsWith("</script>\n")).toBe(true)
	})

	it("throws on corrupted base64 session data", () => {
		const mockHtml = `<!DOCTYPE html>
<html>
<body>
<script id="session-data" type="application/json">!!!invalid!!!</script>
</body>
</html>`

		const outputPath = join(tmpDir, "bad-base64.html")
		writeFileSync(outputPath, mockHtml, "utf-8")

		expect(() => postProcessHtmlExport(outputPath)).toThrow()
	})

	it("injects host metadata into session-data block", () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(mockMetadata())
		const sessionData = {
			version: 3,
			id: "s1",
			entries: [{ id: "m1", parentId: null, type: "message", message: { role: "user", content: "hello" } }],
		}
		const encoded = Buffer.from(JSON.stringify(sessionData)).toString("base64")
		const mockHtml = `<script id="session-data" type="application/json">${encoded}</script>`
		const outputPath = join(tmpDir, "host-metadata.html")
		writeFileSync(outputPath, mockHtml, "utf-8")

		postProcessHtmlExport(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		const match = result.match(/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/)
		expect(match).not.toBeNull()
		if (!match) throw new Error("session-data script not found")
		const data = JSON.parse(Buffer.from(match[1], "base64").toString("utf-8")) as Record<string, unknown>
		expect(data.hostMetadata).toBeDefined()
		const hostMetadata = data.hostMetadata as Record<string, unknown>
		const os = hostMetadata.os as Record<string, unknown>
		const cfg = hostMetadata.config as Record<string, unknown>
		expect(os["telemetry.os"]).toBe("linux")
		expect(cfg["config.multi_model_enabled"]).toBe(true)
		expect(cfg["config.model_roles.orchestrator"]).toBe("test/orch")
	})

	it("injects config-change entries into session-data entries", () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(undefined)
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([
			{ key: "theme", value: "dark", timestamp: 1234567890 },
		] as ConfigChangeRecord[])
		const sessionData = {
			version: 3,
			id: "s1",
			entries: [{ id: "m1", parentId: null, type: "message", message: { role: "user", content: "hello" } }],
		}
		const encoded = Buffer.from(JSON.stringify(sessionData)).toString("base64")
		const mockHtml = `<script id="session-data" type="application/json">${encoded}</script>`
		const outputPath = join(tmpDir, "config-changes.html")
		writeFileSync(outputPath, mockHtml, "utf-8")

		postProcessHtmlExport(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		const match = result.match(/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/)
		expect(match).not.toBeNull()
		if (!match) throw new Error("session-data script not found")
		const data = JSON.parse(Buffer.from(match[1], "base64").toString("utf-8")) as {
			entries: Array<Record<string, unknown>>
		}
		expect(data.entries.length).toBe(2)
		const change = data.entries.find((e) => e.customType === "config_changed")
		expect(change).toBeDefined()
		expect(change?.id).toBe("config_changed:theme:1234567890")
		expect(change?.parentId).toBeNull()
		expect((change?.data as Record<string, unknown>).key).toBe("theme")
		expect((change?.data as Record<string, unknown>).value).toBe("dark")
	})

	it("injects session-metadata renderer script before </body>", () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(mockMetadata())
		const sessionData = { version: 3, id: "s1", entries: [] }
		const encoded = Buffer.from(JSON.stringify(sessionData)).toString("base64")
		const mockHtml = `<!DOCTYPE html>
<html>
<head><title>Export</title></head>
<body>
<script id="session-data" type="application/json">${encoded}</script>
</body>
</html>`
		const outputPath = join(tmpDir, "metadata-renderer.html")
		writeFileSync(outputPath, mockHtml, "utf-8")

		postProcessHtmlExport(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		expect(result.includes('id="session-metadata-renderer"')).toBe(true)
		const rendererIdx = result.indexOf('id="session-metadata-renderer"')
		const bodyIdx = result.indexOf("</body>")
		expect(bodyIdx).toBeGreaterThan(rendererIdx)
	})

	it("is idempotent when run twice (metadata + changes)", () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(mockMetadata())
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([
			{ key: "theme", value: "dark", timestamp: 1234567890 },
		] as ConfigChangeRecord[])
		const sessionData = {
			version: 3,
			id: "s1",
			entries: [{ id: "m1", parentId: null, type: "message", message: { role: "user", content: "hello" } }],
		}
		const encoded = Buffer.from(JSON.stringify(sessionData)).toString("base64")
		const mockHtml = `<script id="session-data" type="application/json">${encoded}</script>`
		const outputPath = join(tmpDir, "idempotent-metadata.html")
		writeFileSync(outputPath, mockHtml, "utf-8")

		postProcessHtmlExport(outputPath)
		postProcessHtmlExport(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		expect(result.split('id="session-metadata-renderer"').length - 1).toBe(1)
		expect(result.split('id="trace-id-renderer"').length - 1).toBe(1)
		const match = result.match(/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/)
		expect(match).not.toBeNull()
		if (!match) throw new Error("session-data script not found")
		const data = JSON.parse(Buffer.from(match[1], "base64").toString("utf-8")) as {
			entries: Array<Record<string, unknown>>
			hostMetadata?: unknown
		}
		expect(data.entries.length).toBe(2)
		expect(data.hostMetadata).toBeDefined()
	})
})

describe("appendBeforeBody", () => {
	it("inserts before </body> when present", () => {
		const result = appendBeforeBody("<div></body>", "<footer></footer>")
		expect(result).toBe("<div><footer></footer>\n</body>")
	})

	it("appends to end when </body> is missing", () => {
		const result = appendBeforeBody("<html><body>hi", "<footer></footer>")
		expect(result).toBe("<html><body>hi\n<footer></footer>\n")
	})
})

describe("postProcessJsonlExport — redaction", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = join(tmpdir(), `kimchi-redact-jsonl-test-${Date.now()}`)
		mkdirSync(tmpDir, { recursive: true })
		_resetSessionMetadataStore()
	})

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true })
		} catch {
			// ignore cleanup errors
		}
		vi.restoreAllMocks()
	})

	it("redacts CastAI API keys in JSONL message text", () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(undefined)
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([])
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s1" }),
			JSON.stringify({
				type: "message",
				id: "e1",
				parentId: null,
				message: { role: "user", content: [{ type: "text", text: "Use key castai_v1_leaked_token" }] },
			}),
		]
		const filePath = join(tmpDir, "export.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		postProcessJsonlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		const msg = JSON.parse(result[1])
		const text = msg.message.content[0].text
		expect(text).toContain("REDACTED")
		expect(text).not.toContain("castai_v1_leaked_token")
	})

	it("redacts Bearer tokens in tool call arguments in JSONL", () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(undefined)
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([])
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s1" }),
			JSON.stringify({
				type: "message",
				id: "e1",
				parentId: null,
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-1",
							name: "bash",
							arguments: {
								command:
									'curl -H "Authorization: Bearer ghp_1234567890abcdef1234567890abcdef12345678" https://api.example.com',
							},
						},
					],
				},
			}),
		]
		const filePath = join(tmpDir, "export-bearer.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		postProcessJsonlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		const msg = JSON.parse(result[1])
		const cmd = msg.message.content[0].arguments.command
		expect(cmd).toContain("REDACTED")
		expect(cmd).not.toContain("ghp_1234567890abcdef")
	})

	it("redacts auth JSON fields while preserving structure in JSONL", () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(undefined)
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([])
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s1" }),
			JSON.stringify({
				type: "message",
				id: "e1",
				parentId: null,
				message: {
					role: "toolResult",
					toolName: "write",
					content: [{ type: "text", text: "wrote config" }],
					details: { auth: { token: "castai_v1_secret" }, password: "mypass" },
				},
			}),
		]
		const filePath = join(tmpDir, "export-auth.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		postProcessJsonlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		const msg = JSON.parse(result[1])
		// auth object should be replaced entirely
		expect(msg.message.details.auth).toContain("REDACTED")
		expect(msg.message.details.password).toContain("REDACTED")
	})

	it("includes sub-agent transcript in JSONL export", () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(undefined)
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([])
		const outputFile = join(tmpDir, "agent-001.output")
		const transcriptEntries = [
			{
				isSidechain: true,
				agentId: "agent-001",
				type: "user",
				message: { role: "user", content: "Explore the codebase" },
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/project",
			},
			{
				isSidechain: true,
				agentId: "agent-001",
				type: "assistant",
				message: { role: "assistant", content: [{ type: "text", text: "Found files" }] },
				timestamp: "2026-01-01T00:00:01.000Z",
				cwd: "/project",
			},
		]
		writeFileSync(outputFile, `${transcriptEntries.map((e) => JSON.stringify(e)).join("\n")}\n`)
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s1" }),
			JSON.stringify({
				type: "custom",
				id: "sub-1",
				parentId: null,
				customType: "subagents:record",
				data: {
					id: "agent-001",
					type: "Explore",
					status: "completed",
					result: "Found files",
					startedAt: 1700000000000,
					completedAt: 1700000001000,
					outputFile,
					sessionFile: "/tmp/session.jsonl",
				},
			}),
		]
		const filePath = join(tmpDir, "export-subagent.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		postProcessJsonlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		const subEntry = JSON.parse(result[1])
		expect(subEntry.data.transcript).toHaveLength(2)
		expect(subEntry.data.transcript[0].type).toBe("user")
		expect(subEntry.data.transcript[1].type).toBe("assistant")
		// Local file paths stripped
		expect(subEntry.data.outputFile).toBeUndefined()
		expect(subEntry.data.sessionFile).toBeUndefined()
	})

	it("preserves trace IDs alongside redaction in JSONL", () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(undefined)
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([])
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s1" }),
			JSON.stringify({
				type: "message",
				id: "e1",
				parentId: null,
				message: { role: "user", content: [{ type: "text", text: "hello castai_v1_leaked" }] },
			}),
			JSON.stringify({ type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: "hi" } }),
			JSON.stringify({
				type: "custom",
				id: "t1",
				parentId: "e2",
				customType: "trace_ids",
				data: { traceIds: ["trace-abc"] },
			}),
		]
		const filePath = join(tmpDir, "export-trace-redact.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		postProcessJsonlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		const userMsg = JSON.parse(result[1])
		expect(userMsg.message.content[0].text).toContain("REDACTED")
		const assistant = JSON.parse(result[2])
		expect(assistant.traceIds).toEqual(["trace-abc"])
	})
})

describe("postProcessHtmlExport — redaction", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = join(tmpdir(), `kimchi-redact-html-test-${Date.now()}`)
		mkdirSync(tmpDir, { recursive: true })
		_resetSessionMetadataStore()
	})

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true })
		} catch {
			// ignore cleanup errors
		}
		vi.restoreAllMocks()
	})

	it("redacts CastAI API keys in HTML export", () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(undefined)
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([])
		const sessionData = {
			version: 3,
			id: "s1",
			entries: [
				{
					id: "m1",
					parentId: null,
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "Use key castai_v1_leaked" }] },
				},
			],
			systemPrompt: "You are an agent with key sk-abc123def456",
		}
		const encoded = Buffer.from(JSON.stringify(sessionData)).toString("base64")
		const mockHtml = `<script id="session-data" type="application/json">${encoded}</script>`
		const outputPath = join(tmpDir, "export.html")
		writeFileSync(outputPath, mockHtml, "utf-8")

		postProcessHtmlExport(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		const match = result.match(/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/)
		expect(match).not.toBeNull()
		if (!match) throw new Error("session-data script not found")
		const data = JSON.parse(Buffer.from(match[1], "base64").toString("utf-8"))
		const text = data.entries[0].message.content[0].text
		expect(text).toContain("REDACTED")
		expect(text).not.toContain("castai_v1_leaked")
		expect(data.systemPrompt).toContain("REDACTED")
		expect(data.systemPrompt).not.toContain("sk-abc123def456")
	})

	it("injects sub-agent transcript renderer script", () => {
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
					data: { id: "agent-001", type: "Explore", status: "completed", transcript: [] },
				},
			],
		}
		const encoded = Buffer.from(JSON.stringify(sessionData)).toString("base64")
		const mockHtml = `<script id="session-data" type="application/json">${encoded}</script>`
		const outputPath = join(tmpDir, "subagent.html")
		writeFileSync(outputPath, mockHtml, "utf-8")

		postProcessHtmlExport(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		expect(result).toContain('id="subagent-renderer"')
	})

	it("injects request diagnostics renderer script", () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(undefined)
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([])
		const sessionData = {
			version: 3,
			id: "s1",
			entries: [
				{
					type: "custom",
					id: "diag-1",
					parentId: null,
					customType: "request_diagnostics",
					data: { status: 200, durationMs: 350, isRetry: false },
				},
			],
		}
		const encoded = Buffer.from(JSON.stringify(sessionData)).toString("base64")
		const mockHtml = `<script id="session-data" type="application/json">${encoded}</script>`
		const outputPath = join(tmpDir, "diagnostics.html")
		writeFileSync(outputPath, mockHtml, "utf-8")

		postProcessHtmlExport(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		expect(result).toContain('id="diagnostics-renderer"')
	})

	it("redacts Bearer tokens in tool call arguments in HTML", () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(undefined)
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([])
		const sessionData = {
			version: 3,
			id: "s1",
			entries: [
				{
					id: "m1",
					parentId: null,
					type: "message",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "call-1",
								name: "bash",
								arguments: {
									command:
										'curl -H "Authorization: Bearer ghp_1234567890abcdef1234567890abcdef12345678" https://api.example.com',
								},
							},
						],
					},
				},
			],
		}
		const encoded = Buffer.from(JSON.stringify(sessionData)).toString("base64")
		const mockHtml = `<script id="session-data" type="application/json">${encoded}</script>`
		const outputPath = join(tmpDir, "export-bearer.html")
		writeFileSync(outputPath, mockHtml, "utf-8")

		postProcessHtmlExport(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		const match = result.match(/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/)
		expect(match).not.toBeNull()
		if (!match) throw new Error("session-data script not found")
		const data = JSON.parse(Buffer.from(match[1], "base64").toString("utf-8"))
		const cmd = data.entries[0].message.content[0].arguments.command
		expect(cmd).toContain("REDACTED")
		expect(cmd).not.toContain("ghp_1234567890abcdef")
	})
})
