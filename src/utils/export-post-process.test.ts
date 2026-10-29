import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	appendBeforeBody,
	computeDefaultExportPath,
	type ExportSessionInfo,
	postProcessHtmlExportOnce,
	postProcessJsonlExportOnce,
	runSecureExport,
} from "./export-post-process.js"
import type { ConfigChangeRecord, SessionStartMetadata } from "./session-metadata-store.js"
import * as sessionMetadataStore from "./session-metadata-store.js"
import { _resetSessionMetadataStore } from "./session-metadata-store.js"

// Counting wrapper over node:fs.writeFileSync — the single-write assertions
// need to observe writes made by the pipeline under test, and ESM module
// namespaces cannot be spied on directly. The wrapper delegates to the real
// implementation, so all other tests are unaffected.
const writeCalls = vi.hoisted(() => ({ count: 0, paths: [] as string[] }))
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>()
	return {
		...actual,
		writeFileSync: ((path: unknown, ...rest: unknown[]) => {
			writeCalls.count += 1
			writeCalls.paths.push(String(path))
			// biome-ignore lint/suspicious/noExplicitAny: delegate with the original signature
			return (actual.writeFileSync as any)(path, ...rest)
		}) as typeof actual.writeFileSync,
	}
})

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

function makeTmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix))
}

/** Build a minimal raw HTML export around a session-data payload. */
function buildRawHtml(sessionData: unknown): string {
	const encoded = Buffer.from(JSON.stringify(sessionData)).toString("base64")
	return `<html><body><script id="session-data" type="application/json">${encoded}</script></body></html>`
}

/** Read the decoded session-data payload back out of a processed HTML export. */
function readHtmlPayload(html: string): Record<string, unknown> {
	const match = html.match(/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/)
	if (!match?.[1]) throw new Error("session-data script not found")
	return JSON.parse(Buffer.from(match[1], "base64").toString("utf-8")) as Record<string, unknown>
}

describe("postProcessJsonlExportOnce", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = makeTmpDir("kimchi-jsonl-export-test-")
		_resetSessionMetadataStore()
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	it("injects appVersion into the session header line", async () => {
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s1" }),
			JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hello" } }),
		]
		const filePath = join(tmpDir, "export.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		await postProcessJsonlExportOnce(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		const header = JSON.parse(result[0])
		expect(header.type).toBe("session")
		expect(header.appVersion).toBeDefined()
	})

	it("injects systemPrompt into the session header when provided", async () => {
		const lines = [JSON.stringify({ type: "session", version: 3, id: "s1" })]
		const filePath = join(tmpDir, "export-system-prompt.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		await postProcessJsonlExportOnce(filePath, { systemPrompt: "You are a helpful assistant." })

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		const header = JSON.parse(result[0])
		expect(header.systemPrompt).toBe("You are a helpful assistant.")
	})

	it("does not inject systemPrompt when it is empty or whitespace", async () => {
		const lines = [JSON.stringify({ type: "session", version: 3, id: "s1" })]
		const filePath = join(tmpDir, "export-no-system-prompt.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		await postProcessJsonlExportOnce(filePath, { systemPrompt: "   \n  " })

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		const header = JSON.parse(result[0])
		expect(header.systemPrompt).toBeUndefined()
	})

	it("preserves trace ID injection", async () => {
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

		await postProcessJsonlExportOnce(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		const assistant = JSON.parse(result[2])
		expect(assistant.traceIds).toEqual(["trace-abc"])
	})

	it("is idempotent when run twice", async () => {
		const lines = [JSON.stringify({ type: "session", version: 3, id: "s1" })]
		const filePath = join(tmpDir, "export-idempotent.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		await postProcessJsonlExportOnce(filePath)
		await postProcessJsonlExportOnce(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		expect(result.length).toBe(1)
		const header = JSON.parse(result[0])
		expect(header.appVersion).toBeDefined()
	})

	it("does not inject appVersion when the first line is not a session header", async () => {
		const lines = [
			JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hello" } }),
		]
		const filePath = join(tmpDir, "export-no-header.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		await postProcessJsonlExportOnce(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		const entry = JSON.parse(result[0])
		expect(entry.appVersion).toBeUndefined()
	})

	it("skips malformed JSONL lines instead of crashing", async () => {
		const filePath = join(tmpDir, "export-bad.jsonl")
		writeFileSync(
			filePath,
			`${JSON.stringify({ type: "session", version: 3, id: "s1" })}
not-json
${JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hello" } })}
`,
			"utf-8",
		)

		await postProcessJsonlExportOnce(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		expect(result).toHaveLength(2)
		expect(JSON.parse(result[0]).type).toBe("session")
		expect(JSON.parse(result[1]).type).toBe("message")
	})

	it("injects OS metadata into the session header line", async () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(mockMetadata())
		const lines = [JSON.stringify({ type: "session", version: 3, id: "s1" })]
		const filePath = join(tmpDir, "export-os.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		await postProcessJsonlExportOnce(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		const header = JSON.parse(result[0])
		expect(header["telemetry.os"]).toBe("linux")
		expect(header["telemetry.arch"]).toBe("amd64")
		expect(header["telemetry.host_os"]).toBe("linux")
		expect(header["telemetry.is_wsl"]).toBe(false)
	})

	it("injects config snapshot incl. multimodel into the session header line", async () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(mockMetadata())
		const lines = [JSON.stringify({ type: "session", version: 3, id: "s1" })]
		const filePath = join(tmpDir, "export-config.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		await postProcessJsonlExportOnce(filePath)

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

	it("appends config-change entries as custom entries", async () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(undefined)
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([
			{ key: "theme", value: "dark", timestamp: 1234567890 },
			{ key: "count", value: 5, timestamp: 1234567891 },
		] as ConfigChangeRecord[])
		const lines = [JSON.stringify({ type: "session", version: 3, id: "s1" })]
		const filePath = join(tmpDir, "export-changes.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		await postProcessJsonlExportOnce(filePath)

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

	it("includes sub-agent transcript in JSONL export", async () => {
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

		await postProcessJsonlExportOnce(filePath)

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

	it("works with telemetry disabled — change capture decoupled from telemetry", async () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(mockMetadata())
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([
			{ key: "theme", value: "dark", timestamp: 9999 },
		] as ConfigChangeRecord[])
		const lines = [JSON.stringify({ type: "session", version: 3, id: "s1" })]
		const filePath = join(tmpDir, "export-telemetry-off.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		await postProcessJsonlExportOnce(filePath)

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

	it("is idempotent — running twice yields identical output with no duplicate change entries", async () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(mockMetadata())
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([
			{ key: "theme", value: "dark", timestamp: 1234567890 },
			{ key: "count", value: 5, timestamp: 1234567891 },
		] as ConfigChangeRecord[])
		const lines = [JSON.stringify({ type: "session", version: 3, id: "s1" })]
		const filePath = join(tmpDir, "export-idempotent-changes.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		await postProcessJsonlExportOnce(filePath)
		const firstRun = readFileSync(filePath, "utf-8")

		await postProcessJsonlExportOnce(filePath)
		const secondRun = readFileSync(filePath, "utf-8")

		expect(secondRun).toBe(firstRun)
		const result = secondRun.split("\n").filter((l) => l.trim().length > 0)
		expect(result.length).toBe(3)
	})

	it("no-ops when store is empty (legacy session re-import)", async () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(undefined)
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([])
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s1" }),
			JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hello" } }),
		]
		const filePath = join(tmpDir, "export-empty-store.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		await postProcessJsonlExportOnce(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		expect(result.length).toBe(2)
		const header = JSON.parse(result[0])
		expect(header.appVersion).toBeDefined()
		expect(header["telemetry.os"]).toBeUndefined()
	})

	it("performs exactly one write to the temp file", async () => {
		const lines = [JSON.stringify({ type: "session", version: 3, id: "s1" })]
		const filePath = join(tmpDir, "export-single-write.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		writeCalls.count = 0
		writeCalls.paths = []
		await postProcessJsonlExportOnce(filePath)
		expect(writeCalls.count).toBe(1)
		expect(writeCalls.paths[0]).toBe(filePath)
	})

	it("still produces redacted output when enrichment throws", async () => {
		const subagents = await import("./export-subagents.js")
		vi.spyOn(subagents, "enrichSubAgentEntries").mockImplementation(() => {
			throw new Error("enrichment exploded")
		})
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s1" }),
			JSON.stringify({
				type: "message",
				id: "e1",
				parentId: null,
				message: { role: "user", content: "my key is sk-abcdef1234567890" },
			}),
		]
		const filePath = join(tmpDir, "export-enrich-fail.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		await postProcessJsonlExportOnce(filePath)

		const result = readFileSync(filePath, "utf-8")
		expect(result).not.toContain("sk-abcdef1234567890")
		expect(result).toContain("[REDACTED-OPENAI_API_KEY]")
	})
})

describe("postProcessHtmlExportOnce", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = makeTmpDir("kimchi-html-export-test-")
		_resetSessionMetadataStore()
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	it("injects trace-id renderer script before </body>", async () => {
		const sessionData = {
			version: 3,
			id: "test-session",
			entries: [
				{ id: "m1", parentId: null, type: "message", message: { role: "user", content: "hello" } },
				{ id: "m2", parentId: "m1", type: "message", message: { role: "assistant", content: "hi" } },
			],
		}
		const outputPath = join(tmpDir, "export.html")
		writeFileSync(outputPath, buildRawHtml(sessionData), "utf-8")

		await postProcessHtmlExportOnce(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		expect(result).toContain('id="trace-id-renderer"')
		expect(result).toContain("</body>")
	})

	it("is idempotent when run twice", async () => {
		const outputPath = join(tmpDir, "idempotent.html")
		writeFileSync(outputPath, buildRawHtml({ version: 3, id: "s", entries: [] }), "utf-8")

		await postProcessHtmlExportOnce(outputPath)
		await postProcessHtmlExportOnce(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		const traceIdCount = result.split('id="trace-id-renderer"').length - 1
		expect(traceIdCount).toBe(1)
	})

	it("appends renderer scripts to the end when </body> is missing", async () => {
		const sessionData = {
			version: 3,
			id: "test-session",
			entries: [
				{ id: "m1", parentId: null, type: "message", message: { role: "user", content: "hello" } },
				{ id: "m2", parentId: "m1", type: "message", message: { role: "assistant", content: "hi" } },
			],
		}
		const encoded = Buffer.from(JSON.stringify(sessionData)).toString("base64")
		const outputPath = join(tmpDir, "no-body.html")
		writeFileSync(
			outputPath,
			`<html><body><script id="session-data" type="application/json">${encoded}</script>`,
			"utf-8",
		)

		await postProcessHtmlExportOnce(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		expect(result).toContain('id="trace-id-renderer"')
		expect(result.endsWith("</script>\n")).toBe(true)
	})

	it("throws on corrupted base64 session data", async () => {
		const outputPath = join(tmpDir, "bad-base64.html")
		writeFileSync(
			outputPath,
			`<!DOCTYPE html><html><body><script id="session-data" type="application/json">!!!invalid!!!</script></body></html>`,
			"utf-8",
		)

		await expect(postProcessHtmlExportOnce(outputPath)).rejects.toThrow()
	})

	it("injects host metadata into session-data block", async () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(mockMetadata())
		const sessionData = {
			version: 3,
			id: "s1",
			entries: [{ id: "m1", parentId: null, type: "message", message: { role: "user", content: "hello" } }],
		}
		const outputPath = join(tmpDir, "host-metadata.html")
		writeFileSync(outputPath, buildRawHtml(sessionData), "utf-8")

		await postProcessHtmlExportOnce(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		const data = readHtmlPayload(result)
		expect(data.hostMetadata).toBeDefined()
		const hostMetadata = data.hostMetadata as Record<string, unknown>
		const os = hostMetadata.os as Record<string, unknown>
		const cfg = hostMetadata.config as Record<string, unknown>
		expect(os["telemetry.os"]).toBe("linux")
		expect(cfg["config.multi_model_enabled"]).toBe(true)
		expect(cfg["config.model_roles.orchestrator"]).toBe("test/orch")
	})

	it("injects config-change entries into session-data entries", async () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(undefined)
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([
			{ key: "theme", value: "dark", timestamp: 1234567890 },
		] as ConfigChangeRecord[])
		const sessionData = {
			version: 3,
			id: "s1",
			entries: [{ id: "m1", parentId: null, type: "message", message: { role: "user", content: "hello" } }],
		}
		const outputPath = join(tmpDir, "config-changes.html")
		writeFileSync(outputPath, buildRawHtml(sessionData), "utf-8")

		await postProcessHtmlExportOnce(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		const data = readHtmlPayload(result) as { entries: Array<Record<string, unknown>> }
		expect(data.entries.length).toBe(2)
		const change = data.entries.find((e) => e.customType === "config_changed")
		expect(change).toBeDefined()
		expect(change?.id).toBe("config_changed:theme:1234567890")
		expect(change?.parentId).toBeNull()
		expect((change?.data as Record<string, unknown>).key).toBe("theme")
		expect((change?.data as Record<string, unknown>).value).toBe("dark")
	})

	it("injects session-metadata renderer script before </body>", async () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(mockMetadata())
		const outputPath = join(tmpDir, "metadata-renderer.html")
		writeFileSync(outputPath, buildRawHtml({ version: 3, id: "s1", entries: [] }), "utf-8")

		await postProcessHtmlExportOnce(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		expect(result.includes('id="session-metadata-renderer"')).toBe(true)
		const rendererIdx = result.indexOf('id="session-metadata-renderer"')
		const bodyIdx = result.indexOf("</body>")
		expect(bodyIdx).toBeGreaterThan(rendererIdx)
		expect(result.includes("Multimodel:")).toBe(false)
		expect(result.includes("Orchestrator:")).toBe(false)
	})

	it("renders Models: — when no models are resolved from session entries", async () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(mockMetadata())
		const sessionData = {
			version: 3,
			id: "s1",
			entries: [{ id: "m1", parentId: null, type: "message", message: { role: "user", content: "hello" } }],
		}
		const outputPath = join(tmpDir, "metadata-renderer-no-models.html")
		writeFileSync(outputPath, buildRawHtml(sessionData), "utf-8")

		await postProcessHtmlExportOnce(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		expect(result.includes("'Models: —'")).toBe(true)
	})

	it("renders unique models resolved from session entries", async () => {
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
		const outputPath = join(tmpDir, "metadata-renderer-models.html")
		writeFileSync(outputPath, buildRawHtml(sessionData), "utf-8")

		await postProcessHtmlExportOnce(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		expect(result.includes("'Models: ' + models.join(', ')")).toBe(true)
		const data = readHtmlPayload(result) as { entries: Array<Record<string, unknown>> }
		const modelChanges = data.entries.filter((e) => e.type === "model_change")
		expect(modelChanges.length).toBe(2)
		expect(modelChanges[0]).toMatchObject({ provider: "p1", modelId: "m1" })
		expect(modelChanges[1]).toMatchObject({ provider: "p2", modelId: "m2" })
	})

	it("is idempotent when run twice (metadata + changes)", async () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(mockMetadata())
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([
			{ key: "theme", value: "dark", timestamp: 1234567890 },
		] as ConfigChangeRecord[])
		const sessionData = {
			version: 3,
			id: "s1",
			entries: [{ id: "m1", parentId: null, type: "message", message: { role: "user", content: "hello" } }],
		}
		const outputPath = join(tmpDir, "idempotent-metadata.html")
		writeFileSync(outputPath, buildRawHtml(sessionData), "utf-8")

		await postProcessHtmlExportOnce(outputPath)
		await postProcessHtmlExportOnce(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		expect(result.split('id="session-metadata-renderer"').length - 1).toBe(1)
		expect(result.split('id="trace-id-renderer"').length - 1).toBe(1)
		const data = readHtmlPayload(result) as { entries: Array<Record<string, unknown>>; hostMetadata?: unknown }
		expect(data.entries.length).toBe(2)
		expect(data.hostMetadata).toBeDefined()
	})

	it("injects sub-agent tab bar and iframe data", async () => {
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
		const outputPath = join(tmpDir, "subagent.html")
		writeFileSync(outputPath, buildRawHtml(sessionData), "utf-8")

		await postProcessHtmlExportOnce(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		expect(result).toContain('id="subagent-tabs"')
		expect(result).toContain("switchToSubAgent")
		expect(result).toContain("Main Session")
		expect(result).toContain('id="subagent-data-agent-001"')
		const data = readHtmlPayload(result) as { entries: Array<Record<string, unknown>> }
		expect(data.entries).toHaveLength(1)
		expect(data.entries[0].type).toBe("custom")
		expect(data.entries[0].customType).toBe("subagents:record")
	})

	it("sub-agent iframe CSS preserves system prompt while hiding header chrome", async () => {
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
		const outputPath = join(tmpDir, "subagent-system-prompt.html")
		writeFileSync(outputPath, buildRawHtml(sessionData), "utf-8")

		await postProcessHtmlExportOnce(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		const dataMatch = result.match(/id="subagent-data-agent-001">([\s\S]*?)<\/script>/)
		expect(dataMatch).not.toBeNull()
		if (!dataMatch) throw new Error("subagent data not found")
		const subData = JSON.parse(Buffer.from(dataMatch[1], "base64").toString("utf-8")) as {
			systemPrompt?: string
		}
		expect(subData.systemPrompt).toBe("You are an explorer.")
		expect(result).toContain("#header-container .header h1")
		expect(result).not.toContain("#header-container{display:none")
	})

	it("enriches sub-agent transcript from .output file outside the export directory", async () => {
		vi.spyOn(sessionMetadataStore, "getSessionStartMetadata").mockReturnValue(undefined)
		vi.spyOn(sessionMetadataStore, "getConfigChanges").mockReturnValue([])

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
		const outputPath = join(tmpDir, "export.html")
		writeFileSync(outputPath, buildRawHtml(sessionData), "utf-8")

		await postProcessHtmlExportOnce(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		const data = readHtmlPayload(result) as { entries: Array<Record<string, unknown>> }
		expect(data.entries[0].type).toBe("custom")
		expect(data.entries[0].customType).toBe("subagents:record")
		expect(result).toContain('id="subagent-tabs"')
		expect(result).toContain('id="subagent-data-agent-999"')
		expect(result).not.toContain('id="subagent-renderer"')
	})

	it("injects request diagnostics renderer script", async () => {
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
		const outputPath = join(tmpDir, "diagnostics.html")
		writeFileSync(outputPath, buildRawHtml(sessionData), "utf-8")

		await postProcessHtmlExportOnce(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		expect(result).toContain('id="diagnostics-renderer"')
	})

	it("performs exactly one write to the temp file", async () => {
		const sessionData = { version: 3, id: "s1", entries: [] }
		const outputPath = join(tmpDir, "single-write.html")
		writeFileSync(outputPath, buildRawHtml(sessionData), "utf-8")

		writeCalls.count = 0
		writeCalls.paths = []
		await postProcessHtmlExportOnce(outputPath)
		expect(writeCalls.count).toBe(1)
		expect(writeCalls.paths[0]).toBe(outputPath)
	})

	it("still produces redacted output when enrichment throws", async () => {
		const subagents = await import("./export-subagents.js")
		vi.spyOn(subagents, "enrichSubAgentEntries").mockImplementation(() => {
			throw new Error("enrichment exploded")
		})
		const sessionData = {
			version: 3,
			id: "s1",
			entries: [
				{
					id: "m1",
					parentId: null,
					type: "message",
					message: { role: "user", content: "my key is sk-abcdef1234567890" },
				},
			],
		}
		const outputPath = join(tmpDir, "enrich-fail.html")
		writeFileSync(outputPath, buildRawHtml(sessionData), "utf-8")

		await postProcessHtmlExportOnce(outputPath)

		const result = readFileSync(outputPath, "utf-8")
		const data = readHtmlPayload(result) as { entries: Array<{ message: { content: string } }> }
		expect(data.entries[0].message.content).not.toContain("sk-abcdef1234567890")
		expect(data.entries[0].message.content).toContain("[REDACTED-OPENAI_API_KEY]")
	})
})

describe("computeDefaultExportPath — upstream filename parity (pinned)", () => {
	it("HTML default matches upstream's `${APP_NAME}-session-<basename>.html` format, based at the session cwd", () => {
		const session: ExportSessionInfo = { sessionFile: "/store/sessions/abc-123.jsonl", cwd: "/work/project" }
		expect(computeDefaultExportPath("html", session)).toBe("/work/project/kimchi-session-abc-123.html")
	})

	it("JSONL default matches upstream's `session-<timestamp>.jsonl` format, based at the session cwd", () => {
		const before = new Date().toISOString().replace(/[:.]/g, "-")
		const path = computeDefaultExportPath("jsonl", { cwd: "/work/project" })
		const after = new Date().toISOString().replace(/[:.]/g, "-")
		expect(path === `/work/project/session-${before}.jsonl` || path === `/work/project/session-${after}.jsonl`).toBe(
			true,
		)
	})

	it("HTML default throws for in-memory sessions (parity with upstream's exporter)", () => {
		expect(() => computeDefaultExportPath("html", { cwd: "/work/project" })).toThrow("Cannot export in-memory session")
	})
})

describe("runSecureExport — workspace lifecycle", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = makeTmpDir("kimchi-secure-export-test-")
		_resetSessionMetadataStore()
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	/** A stub upstream exporter that writes a minimal raw HTML export. */
	const stubHtmlUpstream = (sessionData: unknown) => (tempPath: string) => {
		writeFileSync(tempPath, buildRawHtml(sessionData), "utf-8")
		return tempPath
	}

	it("publishes on success and leaves no temp behind", async () => {
		const session: ExportSessionInfo = { sessionFile: join(tmpDir, "s.jsonl"), cwd: tmpDir }
		const finalPath = await runSecureExport({
			mode: "html",
			outputPath: "out.html",
			session,
			upstreamExport: stubHtmlUpstream({ version: 3, id: "s1", entries: [] }),
			pipeline: (tempPath) => postProcessHtmlExportOnce(tempPath),
		})

		expect(finalPath).toBe(join(tmpDir, "out.html"))
		expect(existsSync(finalPath)).toBe(true)
		const files = readdirSync(tmpDir).filter((f) => f.startsWith("."))
		expect(files).toEqual([])
	})

	it("replaces a pre-existing destination atomically and preserves its mode", async () => {
		const session: ExportSessionInfo = { sessionFile: join(tmpDir, "s.jsonl"), cwd: tmpDir }
		const finalPath = join(tmpDir, "out.html")
		writeFileSync(finalPath, "old export content", "utf-8")
		chmodSync(finalPath, 0o640)

		const result = await runSecureExport({
			mode: "html",
			outputPath: "out.html",
			session,
			upstreamExport: stubHtmlUpstream({ version: 3, id: "s1", entries: [] }),
			pipeline: (tempPath) => postProcessHtmlExportOnce(tempPath),
		})

		expect(result).toBe(finalPath)
		expect(readFileSync(finalPath, "utf-8")).not.toContain("old export content")
		expect(readFileSync(finalPath, "utf-8")).toContain('id="trace-id-renderer"')
		expect(statSync(finalPath).mode & 0o777).toBe(0o640)
		expect(readdirSync(tmpDir).filter((f) => f.startsWith("."))).toEqual([])
	})

	it("on pipeline failure: sweeps the temp, leaves the pre-existing destination byte-intact, and rethrows", async () => {
		const session: ExportSessionInfo = { sessionFile: join(tmpDir, "s.jsonl"), cwd: tmpDir }
		const finalPath = join(tmpDir, "out.html")
		writeFileSync(finalPath, "precious old export", "utf-8")
		const before = readFileSync(finalPath, "utf-8")

		await expect(
			runSecureExport({
				mode: "html",
				outputPath: "out.html",
				session,
				upstreamExport: stubHtmlUpstream({ version: 3, id: "s1", entries: [] }),
				pipeline: () => {
					throw new Error("pipeline exploded")
				},
			}),
		).rejects.toThrow("pipeline exploded")

		expect(readFileSync(finalPath, "utf-8")).toBe(before)
		expect(readdirSync(tmpDir).filter((f) => f.startsWith("."))).toEqual([])
	})

	it("on upstream failure: sweeps the temp and rethrows without touching the destination", async () => {
		const session: ExportSessionInfo = { sessionFile: join(tmpDir, "s.jsonl"), cwd: tmpDir }

		await expect(
			runSecureExport({
				mode: "html",
				outputPath: "out.html",
				session,
				upstreamExport: () => {
					throw new Error("upstream exploded")
				},
				pipeline: () => Promise.resolve(),
			}),
		).rejects.toThrow("upstream exploded")

		expect(existsSync(join(tmpDir, "out.html"))).toBe(false)
		expect(readdirSync(tmpDir).filter((f) => f.startsWith("."))).toEqual([])
	})

	it("default outputPath: upstream receives the pre-created private temp (never undefined, never the public name) and the result publishes at the default path", async () => {
		const session: ExportSessionInfo = { sessionFile: join(tmpDir, "my-session.jsonl"), cwd: tmpDir }
		const upstream = vi.fn(stubHtmlUpstream({ version: 3, id: "s1", entries: [] }))
		let tempModeDuringPipeline = -1
		let receivedTemp = ""

		const finalPath = await runSecureExport({
			mode: "html",
			session,
			upstreamExport: upstream,
			pipeline: async (tempPath) => {
				receivedTemp = tempPath
				tempModeDuringPipeline = statSync(tempPath).mode & 0o777
				await postProcessHtmlExportOnce(tempPath)
			},
		})

		expect(finalPath).toBe(computeDefaultExportPath("html", session))
		expect(finalPath).toBe(join(tmpDir, "kimchi-session-my-session.html"))
		expect(upstream).toHaveBeenCalledTimes(1)
		receivedTemp = upstream.mock.calls[0]?.[0] ?? receivedTemp
		expect(typeof receivedTemp).toBe("string")
		expect(receivedTemp).not.toBe(finalPath)
		// The temp is a private dotfile at mode 0600 while the pipeline runs.
		expect(receivedTemp.startsWith(join(tmpDir, ".kimchi-session-my-session.html.tmp-"))).toBe(true)
		expect(tempModeDuringPipeline).toBe(0o600)
		// Published file exists, no temp left.
		expect(existsSync(finalPath)).toBe(true)
		expect(readdirSync(tmpDir).filter((f) => f.startsWith("."))).toEqual([])
	})

	it("explicit outputPath: same temp-privacy assertions, destination at the explicit path", async () => {
		const session: ExportSessionInfo = { sessionFile: join(tmpDir, "my-session.jsonl"), cwd: tmpDir }
		const upstream = vi.fn(stubHtmlUpstream({ version: 3, id: "s1", entries: [] }))
		let tempModeDuringPipeline = -1

		const finalPath = await runSecureExport({
			mode: "html",
			outputPath: "explicit.html",
			session,
			upstreamExport: upstream,
			pipeline: async (tempPath) => {
				tempModeDuringPipeline = statSync(tempPath).mode & 0o777
				await postProcessHtmlExportOnce(tempPath)
			},
		})

		expect(finalPath).toBe(join(tmpDir, "explicit.html"))
		const receivedTemp = upstream.mock.calls[0]?.[0]
		expect(typeof receivedTemp).toBe("string")
		expect(receivedTemp).not.toBe(finalPath)
		expect(tempModeDuringPipeline).toBe(0o600)
		expect(existsSync(finalPath)).toBe(true)
		expect(readdirSync(tmpDir).filter((f) => f.startsWith("."))).toEqual([])
	})

	it("upstream writing into the pre-created temp keeps the 0600 mode (mode-preservation mechanism)", async () => {
		const session: ExportSessionInfo = { sessionFile: join(tmpDir, "s.jsonl"), cwd: tmpDir }
		let tempModeAfterUpstream = -1

		await runSecureExport({
			mode: "html",
			outputPath: "out.html",
			session,
			upstreamExport: (tempPath) => {
				// Simulate upstream's writeFileSync into the pre-created temp.
				writeFileSync(tempPath, buildRawHtml({ version: 3, id: "s1", entries: [] }), "utf-8")
				tempModeAfterUpstream = statSync(tempPath).mode & 0o777
				return tempPath
			},
			pipeline: () => Promise.resolve(),
		})

		expect(tempModeAfterUpstream).toBe(0o600)
	})

	it("resolves explicit relative and default paths against the session cwd, not process.cwd()", async () => {
		// tmpDir plays the session cwd; the process cwd is the repo and differs.
		const sessionCwd = mkdtempSync(join(tmpDir, "session-cwd-"))
		const session: ExportSessionInfo = { sessionFile: join(sessionCwd, "s.jsonl"), cwd: sessionCwd }
		const upstream = vi.fn(stubHtmlUpstream({ version: 3, id: "s1", entries: [] }))

		// Explicit relative path → lands under the session cwd.
		const explicitPath = await runSecureExport({
			mode: "html",
			outputPath: "nested/deep/out.html",
			session,
			upstreamExport: upstream,
			pipeline: () => Promise.resolve(),
		})
		expect(explicitPath).toBe(join(sessionCwd, "nested", "deep", "out.html"))

		// Default path → lands under the session cwd too.
		const defaultPath = await runSecureExport({
			mode: "html",
			session,
			upstreamExport: upstream,
			pipeline: () => Promise.resolve(),
		})
		expect(defaultPath.startsWith(sessionCwd)).toBe(true)
		expect(defaultPath.endsWith(".html")).toBe(true)

		// Upstream always received an absolute path.
		for (const call of upstream.mock.calls) {
			expect(typeof call[0]).toBe("string")
		}
	})

	it("absolute explicit outputPath passes through unchanged", async () => {
		const session: ExportSessionInfo = { sessionFile: join(tmpDir, "s.jsonl"), cwd: tmpDir }
		const elsewhere = mkdtempSync(join(tmpDir, "elsewhere-"))
		const absolute = join(elsewhere, "abs.html")

		const finalPath = await runSecureExport({
			mode: "html",
			outputPath: absolute,
			session,
			upstreamExport: stubHtmlUpstream({ version: 3, id: "s1", entries: [] }),
			pipeline: () => Promise.resolve(),
		})

		expect(finalPath).toBe(absolute)
		expect(existsSync(absolute)).toBe(true)
	})

	it("returns its own finalPath, not upstream's return value", async () => {
		const session: ExportSessionInfo = { sessionFile: join(tmpDir, "s.jsonl"), cwd: tmpDir }
		const finalPath = await runSecureExport({
			mode: "html",
			outputPath: "out.html",
			session,
			upstreamExport: (tempPath) => {
				writeFileSync(tempPath, buildRawHtml({ version: 3, id: "s1", entries: [] }), "utf-8")
				return "/this/is/not/the/final/path.html"
			},
			pipeline: () => Promise.resolve(),
		})
		expect(finalPath).toBe(join(tmpDir, "out.html"))
	})

	it("publishes new destinations at 0600 (POSIX)", { skip: process.platform === "win32" }, async () => {
		const session: ExportSessionInfo = { sessionFile: join(tmpDir, "s.jsonl"), cwd: tmpDir }
		const finalPath = await runSecureExport({
			mode: "html",
			outputPath: "fresh.html",
			session,
			upstreamExport: stubHtmlUpstream({ version: 3, id: "s1", entries: [] }),
			pipeline: () => Promise.resolve(),
		})
		expect(statSync(finalPath).mode & 0o777).toBe(0o600)
	})

	it("new destination stays 0600 under a restrictive umask (no umask bypass)", {
		skip: process.platform === "win32",
	}, async () => {
		const oldUmask = process.umask(0o077)
		try {
			const session: ExportSessionInfo = { sessionFile: join(tmpDir, "s.jsonl"), cwd: tmpDir }
			const finalPath = await runSecureExport({
				mode: "html",
				outputPath: "umask-test.html",
				session,
				upstreamExport: stubHtmlUpstream({ version: 3, id: "s1", entries: [] }),
				pipeline: () => Promise.resolve(),
			})
			expect(statSync(finalPath).mode & 0o777).toBe(0o600)
		} finally {
			process.umask(oldUmask)
		}
	})

	it("an existing 0600 destination is never widened", { skip: process.platform === "win32" }, async () => {
		const session: ExportSessionInfo = { sessionFile: join(tmpDir, "s.jsonl"), cwd: tmpDir }
		const finalPath = join(tmpDir, "tight.html")
		writeFileSync(finalPath, "old", "utf-8")
		chmodSync(finalPath, 0o600)

		await runSecureExport({
			mode: "html",
			outputPath: "tight.html",
			session,
			upstreamExport: stubHtmlUpstream({ version: 3, id: "s1", entries: [] }),
			pipeline: () => Promise.resolve(),
		})

		expect(statSync(finalPath).mode & 0o777).toBe(0o600)
	})

	it("JSONL exports publish through the same workspace", async () => {
		const session: ExportSessionInfo = { sessionFile: join(tmpDir, "s.jsonl"), cwd: tmpDir }
		const finalPath = await runSecureExport({
			mode: "jsonl",
			outputPath: "out.jsonl",
			session,
			upstreamExport: (tempPath) => {
				writeFileSync(tempPath, `${JSON.stringify({ type: "session", version: 3, id: "s1" })}\n`, "utf-8")
				return tempPath
			},
			pipeline: (tempPath) => postProcessJsonlExportOnce(tempPath, { systemPrompt: "be brief" }),
		})

		expect(finalPath).toBe(join(tmpDir, "out.jsonl"))
		const result = readFileSync(finalPath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		const header = JSON.parse(result[0])
		expect(header.appVersion).toBeDefined()
		expect(header.systemPrompt).toBe("be brief")
		expect(readdirSync(tmpDir).filter((f) => f.startsWith("."))).toEqual([])
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
