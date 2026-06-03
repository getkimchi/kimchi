import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { appendBeforeBody, postProcessHtmlExport, postProcessJsonlExport } from "./export-post-process.js"

describe("postProcessJsonlExport", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = join(tmpdir(), `kimchi-jsonl-export-test-${Date.now()}`)
		mkdirSync(tmpDir, { recursive: true })
	})

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true })
		} catch {
			// ignore cleanup errors
		}
	})

	it("injects appVersion into the header line", () => {
		const lines = [
			JSON.stringify({ type: "header", version: 3, id: "s1" }),
			JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hello" } }),
		]
		const filePath = join(tmpDir, "export.jsonl")
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8")

		postProcessJsonlExport(filePath)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		const header = JSON.parse(result[0])
		expect(header.type).toBe("header")
		expect(header.appVersion).toBeDefined()
	})

	it("preserves trace ID injection", () => {
		const lines = [
			JSON.stringify({ type: "header", version: 3, id: "s1" }),
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
		const lines = [JSON.stringify({ type: "header", version: 3, id: "s1" })]
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

	it("does not inject appVersion when the first line is not a header", () => {
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
})

describe("postProcessHtmlExport", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = join(tmpdir(), `kimchi-html-export-test-${Date.now()}`)
		mkdirSync(tmpDir, { recursive: true })
	})

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true })
		} catch {
			// ignore cleanup errors
		}
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
