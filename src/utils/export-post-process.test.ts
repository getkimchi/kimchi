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

	it("injects systemPrompt into the session header when provided", () => {
		const lines = [JSON.stringify({ type: "session", version: 3, id: "s1" })]
		const filePath = join(tmpDir, "export-system-prompt.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		postProcessJsonlExport(filePath, { systemPrompt: "You are a helpful assistant." })

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		const header = JSON.parse(result[0])
		expect(header.systemPrompt).toBe("You are a helpful assistant.")
	})

	it("does not inject systemPrompt when it is empty or whitespace", () => {
		const lines = [JSON.stringify({ type: "session", version: 3, id: "s1" })]
		const filePath = join(tmpDir, "export-no-system-prompt.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		postProcessJsonlExport(filePath, { systemPrompt: "   \n  " })

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		const header = JSON.parse(result[0])
		expect(header.systemPrompt).toBeUndefined()
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

	it("skips malformed JSONL lines instead of crashing", () => {
		const filePath = join(tmpDir, "export-bad.jsonl")
		writeFileSync(
			filePath,
			`${JSON.stringify({ type: "session", version: 3, id: "s1" })}
not-json
${JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hello" } })}
`,
			"utf-8",
		)

		postProcessJsonlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		expect(result).toHaveLength(2)
		expect(JSON.parse(result[0]).type).toBe("session")
		expect(JSON.parse(result[1]).type).toBe("message")
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

	it("config-change values pass through unchanged", () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(undefined)
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([
			{ key: "endpoint", value: "https://secret.example.com", timestamp: 1000 },
			{ key: "apiKey", value: "sk-leaked-secret", timestamp: 1001 },
			{ key: "email", value: "user@example.com", timestamp: 1002 },
		] as ConfigChangeRecord[])
		const lines = [JSON.stringify({ type: "session", version: 3, id: "s1" })]
		const filePath = join(tmpDir, "export-passthrough.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		postProcessJsonlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		// header + 3 change entries
		expect(result.length).toBe(4)
		const values = result.slice(1).map((l) => JSON.parse(l).data.value)
		// Redaction runs in a separate pass (redactJsonlExport); post-processing passes values through verbatim.
		expect(values).toEqual(["https://secret.example.com", "sk-leaked-secret", "user@example.com"])
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
		expect(
			result.includes(
				"if (os['telemetry.os']) parts.push('OS: ' + os['telemetry.os'] + '/' + (os['telemetry.arch'] || ''))",
			),
		).toBe(true)
		expect(result.includes("parts.push(models.length > 0 ? 'Models: ' + models.join(', ') : 'Models: —')")).toBe(true)
		expect(result.includes("if (e.type === 'model_change' && e.provider && e.modelId)")).toBe(true)
		expect(result.includes("e.type === 'message' && e.message && e.message.role === 'assistant'")).toBe(true)
		expect(result.includes("Multimodel:")).toBe(false)
		expect(result.includes("Orchestrator:")).toBe(false)
	})

	it("renders Models: — when no models are resolved from session entries", () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(mockMetadata())
		const sessionData = {
			version: 3,
			id: "s1",
			entries: [{ id: "m1", parentId: null, type: "message", message: { role: "user", content: "hello" } }],
		}
		const encoded = Buffer.from(JSON.stringify(sessionData)).toString("base64")
		const mockHtml = `<!DOCTYPE html>
<html>
<head><title>Export</title></head>
<body>
<script id="session-data" type="application/json">${encoded}</script>
</body>
</html>`
		const outputPath = join(tmpDir, "metadata-renderer-no-models.html")
		writeFileSync(outputPath, mockHtml, "utf-8")

		postProcessHtmlExport(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		expect(result.includes("'Models: —'")).toBe(true)
	})

	it("renders unique models resolved from session entries", () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(mockMetadata())
		const sessionData = {
			version: 3,
			id: "s1",
			entries: [
				{ id: "m1", parentId: null, type: "model_change", provider: "p1", modelId: "m1" },
				{ id: "m2", parentId: "m1", type: "message", message: { role: "assistant", provider: "p1", model: "m1" } },
				{ id: "m3", parentId: "m2", type: "model_change", provider: "p2", modelId: "m2" },
				{ id: "m4", parentId: "m3", type: "message", message: { role: "assistant", provider: "p2", model: "m2" } },
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
		const outputPath = join(tmpDir, "metadata-renderer-models.html")
		writeFileSync(outputPath, mockHtml, "utf-8")

		postProcessHtmlExport(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		expect(result.includes("'Models: ' + models.join(', ')")).toBe(true)
		const match = result.match(/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/)
		expect(match).not.toBeNull()
		if (!match) throw new Error("session-data script not found")
		const data = JSON.parse(Buffer.from(match[1], "base64").toString("utf-8")) as {
			entries: Array<Record<string, unknown>>
		}
		const modelChanges = data.entries.filter((e) => e.type === "model_change")
		expect(modelChanges.length).toBe(2)
		expect(modelChanges[0]).toMatchObject({ provider: "p1", modelId: "m1" })
		expect(modelChanges[1]).toMatchObject({ provider: "p2", modelId: "m2" })
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

	it("injects sub-agent tab bar and iframe data", () => {
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
						transcript: [
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
						],
					},
				},
			],
		}
		const encoded = Buffer.from(JSON.stringify(sessionData)).toString("base64")
		const mockHtml = `<html><body><script id="session-data" type="application/json">${encoded}</script></body></html>`
		const outputPath = join(tmpDir, "subagent.html")
		writeFileSync(outputPath, mockHtml, "utf-8")

		postProcessHtmlExport(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		// Tab bar should be injected with a button for the sub-agent.
		expect(result).toContain('id="subagent-tabs"')
		expect(result).toContain("switchToSubAgent")
		expect(result).toContain("Main Session")
		// Hidden data script for the iframe.
		expect(result).toContain('id="subagent-data-agent-001"')
		// The original subagents:record should NOT be expanded into the main entries.
		const match = result.match(/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/)
		const base64Data = match?.[1] ?? ""
		const data = JSON.parse(Buffer.from(base64Data, "base64").toString("utf-8")) as {
			entries: Array<Record<string, unknown>>
		}
		expect(data.entries).toHaveLength(1)
		expect(data.entries[0].type).toBe("custom")
		expect(data.entries[0].customType).toBe("subagents:record")
	})

	it("sub-agent iframe CSS preserves system prompt while hiding header chrome", () => {
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
						systemPrompt: "You are an explorer.",
						transcript: [
							{
								isSidechain: true,
								agentId: "agent-001",
								type: "user",
								message: { role: "user", content: "Explore" },
								timestamp: "2026-01-01T00:00:00.000Z",
								cwd: "/project",
							},
						],
					},
				},
			],
		}
		const encoded = Buffer.from(JSON.stringify(sessionData)).toString("base64")
		const mockHtml = `<html><body><script id="session-data" type="application/json">${encoded}</script></body></html>`
		const outputPath = join(tmpDir, "subagent-system-prompt.html")
		writeFileSync(outputPath, mockHtml, "utf-8")

		postProcessHtmlExport(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		const dataMatch = result.match(/id="subagent-data-agent-001">([\s\S]*?)<\/script>/)
		expect(dataMatch).not.toBeNull()
		if (!dataMatch) throw new Error("subagent data not found")
		const subData = JSON.parse(Buffer.from(dataMatch[1], "base64").toString("utf-8")) as {
			systemPrompt?: string
		}
		expect(subData.systemPrompt).toBe("You are an explorer.")

		// The iframe CSS should hide header chrome but leave room for the system prompt.
		expect(result).toContain("#header-container .header h1")
		expect(result).toContain("#header-container .header .help-bar")
		expect(result).toContain("#header-container .header .header-info")
		expect(result).not.toContain("#header-container{display:none")
	})

	it("enriches sub-agent transcript from .output file outside the export directory", () => {
		// Regression: .output files live under the session directory
		// (~/.config/kimchi/harness/sessions/...), which is unrelated to
		// the export file's location. Passing dirname(exportPath) as
		// baseDir incorrectly rejected these legitimate paths, leaving the
		// exported subagent record without a transcript.
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(undefined)
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([])

		// Create the .output file in a directory completely separate from
		// the export output directory.
		const transcriptDir = join(tmpDir, "session-store", "agent-outputs", "sess-1", "tasks")
		mkdirSync(transcriptDir, { recursive: true })
		const outputFile = join(transcriptDir, "agent-999.output")
		const transcriptEntries = [
			{
				isSidechain: true,
				agentId: "agent-999",
				type: "user",
				message: { role: "user", content: "Review the code" },
				timestamp: "2026-07-08T08:00:00.000Z",
				cwd: "/project",
			},
			{
				isSidechain: true,
				agentId: "agent-999",
				type: "assistant",
				message: { role: "assistant", content: [{ type: "text", text: "Looks good" }] },
				timestamp: "2026-07-08T08:00:01.000Z",
				cwd: "/project",
			},
		]
		writeFileSync(outputFile, `${transcriptEntries.map((e) => JSON.stringify(e)).join("\n")}\n`)

		const sessionData = {
			version: 3,
			id: "sess-1",
			entries: [
				{
					type: "custom",
					id: "sub-2",
					parentId: null,
					customType: "subagents:record",
					data: {
						id: "agent-999",
						type: "Reviewer",
						status: "completed",
						outputFile,
						sessionFile: "/tmp/sess-1.jsonl",
					},
				},
			],
		}
		const encoded = Buffer.from(JSON.stringify(sessionData)).toString("base64")
		const mockHtml = `<html><body><script id="session-data" type="application/json">${encoded}</script></body></html>`
		const outputPath = join(tmpDir, "export.html")
		writeFileSync(outputPath, mockHtml, "utf-8")

		postProcessHtmlExport(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		const match = result.match(/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/)
		expect(match).not.toBeNull()
		const base64Data = match?.[1] ?? ""
		const data = JSON.parse(Buffer.from(base64Data, "base64").toString("utf-8")) as {
			entries: Array<Record<string, unknown>>
		}
		// The original subagents:record should remain unexpanded.
		expect(data.entries[0].type).toBe("custom")
		expect(data.entries[0].customType).toBe("subagents:record")
		// Tab bar should be present.
		expect(result).toContain('id="subagent-tabs"')
		expect(result).toContain('id="subagent-data-agent-999"')
		// No old renderer script.
		expect(result).not.toContain('id="subagent-renderer"')
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
