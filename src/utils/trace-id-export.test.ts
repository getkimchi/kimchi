import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type ExportEntry, injectTraceIdsIntoEntries, injectTraceIdsIntoExport } from "./trace-id-export.js"

describe("injectTraceIdsIntoExport", () => {
	it("injects traceIds from trace_ids custom entry into its parent message entry", () => {
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/local" }),
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
		const result = injectTraceIdsIntoExport(lines)
		const parentEntry = JSON.parse(result[2])
		expect(parentEntry.traceIds).toEqual(["trace-abc"])
		expect(JSON.parse(result[3]).customType).toBe("trace_ids")
	})

	it("walks parent chain past tool_result to land trace IDs on the assistant message", () => {
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/local" }),
			JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "use a tool" } }),
			JSON.stringify({
				type: "message",
				id: "e2",
				parentId: "e1",
				message: { role: "assistant", content: "using tool" },
			}),
			JSON.stringify({ type: "tool_use", id: "tool1", parentId: "e2", data: { name: "bash" } }),
			JSON.stringify({ type: "tool_result", id: "res1", parentId: "tool1", data: { output: "ok" } }),
			JSON.stringify({
				type: "custom",
				id: "t1",
				parentId: "res1",
				customType: "trace_ids",
				data: { traceIds: ["trace-through-tool"] },
			}),
		]
		const result = injectTraceIdsIntoExport(lines)
		const assistantEntry = JSON.parse(result[2])
		expect(assistantEntry.traceIds).toEqual(["trace-through-tool"])
		expect(JSON.parse(result[4]).traceIds).toBeUndefined()
		expect(JSON.parse(result[5]).customType).toBe("trace_ids")
	})

	it("deduplicates when multiple trace_ids entries target the same parent", () => {
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/local" }),
			JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hello" } }),
			JSON.stringify({ type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: "hi" } }),
			JSON.stringify({
				type: "custom",
				id: "t1",
				parentId: "e2",
				customType: "trace_ids",
				data: { traceIds: ["trace-a", "trace-b"] },
			}),
			JSON.stringify({
				type: "custom",
				id: "t2",
				parentId: "e2",
				customType: "trace_ids",
				data: { traceIds: ["trace-b", "trace-c"] },
			}),
		]
		const result = injectTraceIdsIntoExport(lines)
		const parentEntry = JSON.parse(result[2])
		expect(parentEntry.traceIds).toEqual(["trace-a", "trace-b", "trace-c"])
	})

	it("returns lines unchanged when there are no trace_ids entries", () => {
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/local" }),
			JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hello" } }),
			JSON.stringify({ type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: "hi" } }),
		]
		const result = injectTraceIdsIntoExport(lines)
		expect(result).toEqual(lines)
	})

	it("preserves the header entry during post-processing", () => {
		const header = { type: "session", version: 3, id: "s1", cwd: "/local" }
		const lines = [
			JSON.stringify(header),
			JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hello" } }),
		]
		const result = injectTraceIdsIntoExport(lines)
		const resultHeader = JSON.parse(result[0])
		expect(resultHeader.type).toBe("session")
		expect(resultHeader.id).toBe("s1")
		expect(resultHeader.cwd).toBe("/local")
	})
})

describe("injectTraceIdsIntoEntries", () => {
	it("injects traceIds into the immediate parent when it is an assistant message", () => {
		const entries: ExportEntry[] = [
			{ id: "e1", parentId: null, type: "message", message: { role: "user", content: "hello" } },
			{ id: "e2", parentId: "e1", type: "message", message: { role: "assistant", content: "hi" } },
			{ id: "t1", parentId: "e2", type: "custom", customType: "trace_ids", data: { traceIds: ["trace-abc"] } },
		]
		const result = injectTraceIdsIntoEntries(entries)
		const assistantEntry = result[1]
		expect(assistantEntry.traceIds).toEqual(["trace-abc"])
		expect(result[2].customType).toBe("trace_ids")
	})

	it("walks parent chain past tool_result to find the assistant message", () => {
		const entries: ExportEntry[] = [
			{ id: "e1", parentId: null, type: "message", message: { role: "user", content: "use a tool" } },
			{ id: "e2", parentId: "e1", type: "message", message: { role: "assistant", content: "using tool" } },
			{ id: "tool1", parentId: "e2", type: "tool_use", data: { name: "bash" } },
			{ id: "res1", parentId: "tool1", type: "tool_result", data: { output: "ok" } },
			{
				id: "t1",
				parentId: "res1",
				type: "custom",
				customType: "trace_ids",
				data: { traceIds: ["trace-through-tool"] },
			},
		]
		const result = injectTraceIdsIntoEntries(entries)
		const assistantEntry = result[1]
		expect(assistantEntry.traceIds).toEqual(["trace-through-tool"])
		expect(result[3].traceIds).toBeUndefined()
	})

	it("walks deeply nested parent chain to find the assistant message", () => {
		const entries: ExportEntry[] = [
			{ id: "u1", parentId: null, type: "message", message: { role: "user", content: "do complex thing" } },
			{ id: "a1", parentId: "u1", type: "message", message: { role: "assistant", content: "complex" } },
			{ id: "s1", parentId: "a1", type: "thinking", data: { text: "thinking" } },
			{ id: "s2", parentId: "s1", type: "step", data: { text: "step" } },
			{ id: "t1", parentId: "s2", type: "custom", customType: "trace_ids", data: { traceIds: ["trace-deep"] } },
		]
		const result = injectTraceIdsIntoEntries(entries)
		const assistantEntry = result[1]
		expect(assistantEntry.traceIds).toEqual(["trace-deep"])
	})

	it("deduplicates when multiple trace_ids entries target the same assistant message", () => {
		const entries: ExportEntry[] = [
			{ id: "e1", parentId: null, type: "message", message: { role: "user", content: "hello" } },
			{ id: "e2", parentId: "e1", type: "message", message: { role: "assistant", content: "hi" } },
			{ id: "t1", parentId: "e2", type: "custom", customType: "trace_ids", data: { traceIds: ["trace-a", "trace-b"] } },
			{ id: "t2", parentId: "e2", type: "custom", customType: "trace_ids", data: { traceIds: ["trace-b", "trace-c"] } },
		]
		const result = injectTraceIdsIntoEntries(entries)
		const assistantEntry = result[1]
		expect(assistantEntry.traceIds).toEqual(["trace-a", "trace-b", "trace-c"])
	})

	it("returns entries unchanged when there are no trace_ids entries", () => {
		const entries: ExportEntry[] = [
			{ id: "e1", parentId: null, type: "message", message: { role: "user", content: "hello" } },
			{ id: "e2", parentId: "e1", type: "message", message: { role: "assistant", content: "hi" } },
		]
		const result = injectTraceIdsIntoEntries(entries)
		expect(result).toEqual(entries)
	})

	it("does nothing when parent chain has no assistant message", () => {
		const entries: ExportEntry[] = [
			{ id: "e1", parentId: null, type: "message", message: { role: "user", content: "hello" } },
			{ id: "t1", parentId: "e1", type: "custom", customType: "trace_ids", data: { traceIds: ["trace-orphan"] } },
		]
		const result = injectTraceIdsIntoEntries(entries)
		expect(result[1].traceIds).toBeUndefined()
	})

	it("simulates HTML export post-processing: decode base64, inject traceIds, verify", () => {
		const sessionData = {
			version: 3,
			id: "test-session",
			entries: [
				{ id: "m1", parentId: null, type: "message", message: { role: "user", content: "hello" } },
				{ id: "m2", parentId: "m1", type: "message", message: { role: "assistant", content: "hi" } },
				{ id: "t1", parentId: "m2", type: "custom", customType: "trace_ids", data: { traceIds: ["trace-html"] } },
			],
		}
		const encoded = Buffer.from(JSON.stringify(sessionData)).toString("base64")
		const html = `<!DOCTYPE html><html><head><title>Export</title></head><body><script id="session-data" type="application/json">${encoded}</script></body></html>`

		const match = html.match(/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/)
		expect(match).not.toBeNull()
		// biome-ignore lint/style/noNonNullAssertion: checked by not.toBeNull() above
		const base64 = match![1]
		const json = Buffer.from(base64, "base64").toString("utf-8")
		const data = JSON.parse(json) as { entries: ExportEntry[] }

		if (Array.isArray(data.entries)) {
			injectTraceIdsIntoEntries(data.entries)
			const modified = JSON.stringify(data)
			const modifiedBase64 = Buffer.from(modified).toString("base64")
			const finalJson = Buffer.from(modifiedBase64, "base64").toString("utf-8")
			const finalData = JSON.parse(finalJson) as { entries: ExportEntry[] }

			const assistantEntry = finalData.entries.find(
				(e) => e.type === "message" && (e.message as { role?: string }).role === "assistant",
			)
			expect(assistantEntry?.traceIds).toEqual(["trace-html"])
			const traceIdsEntry = finalData.entries.find((e) => e.customType === "trace_ids")
			expect(traceIdsEntry).toBeDefined()
		}
	})
})

describe("exportToHtml monkey-patch — trace ID renderer injection", () => {
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

	it('injects <script id="trace-id-renderer"> into the exported HTML before </body>', async () => {
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

		let html = readFileSync(outputPath, "utf-8")
		const match = html.match(/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/)
		if (match) {
			const base64 = match[1]
			const json = Buffer.from(base64, "base64").toString("utf-8")
			const data = JSON.parse(json) as { entries: ExportEntry[] }
			if (Array.isArray(data.entries)) {
				injectTraceIdsIntoEntries(data.entries)
				const modified = JSON.stringify(data)
				const modifiedBase64 = Buffer.from(modified).toString("base64")
				html = html.replace(
					/<script id="session-data" type="application\/json">[\s\S]*?<\/script>/,
					`<script id="session-data" type="application/json">${modifiedBase64}</script>`,
				)
			}
		}

		if (!html.includes('id="trace-id-renderer"')) {
			const traceIdScript = `<script id="trace-id-renderer">
(function() {
    var base64 = document.getElementById('session-data').textContent;
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var data = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    var entriesWithTraceIds = [];
    for (var i = 0; i < data.entries.length; i++) {
        var e = data.entries[i];
        if (e.traceIds && e.traceIds.length > 0) entriesWithTraceIds.push(e);
    }
    if (entriesWithTraceIds.length === 0) return;
    function inject() {
        for (var i = 0; i < entriesWithTraceIds.length; i++) {
            var entry = entriesWithTraceIds[i];
            var el = document.getElementById('entry-' + entry.id);
            if (!el) continue;
            if (el.querySelector('.trace-ids')) continue;
            var d = document.createElement('div');
            d.className = 'trace-ids';
            d.textContent = 'Trace IDs: ' + entry.traceIds.join(', ');
            d.style.cssText = 'font-size:0.75rem;color:#666;margin-top:0.25rem;font-family:monospace';
            el.appendChild(d);
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inject);
    } else { inject(); }
})();
</script>`
			html = html.replace("</body>", `${traceIdScript}\n</body>`)
		}
		writeFileSync(outputPath, html, "utf-8")

		const result = readFileSync(outputPath, "utf-8")
		expect(result).toContain('id="trace-id-renderer"')
		expect(result).toContain("entriesWithTraceIds")
		expect(result).toContain(".trace-ids")
		expect(result).toContain("Trace IDs:")
		expect(result).toContain("font-size:0.75rem")
	})

	it("is idempotent: running the injection twice does not duplicate the script", async () => {
		const mockHtml = `<!DOCTYPE html>
<html>
<head><title>Export</title></head>
<body>
<script id="session-data" type="application/json">${Buffer.from(JSON.stringify({ version: 3, id: "s", entries: [] })).toString("base64")}</script>
</body>
</html>`

		const outputPath = join(tmpDir, "idempotent.html")
		writeFileSync(outputPath, mockHtml, "utf-8")

		const injectScript = (htmlContent: string): string => {
			if (htmlContent.includes('id="trace-id-renderer"')) return htmlContent
			const traceIdScript = `<script id="trace-id-renderer">(function(){return})()</script>`
			return htmlContent.replace("</body>", `${traceIdScript}\n</body>`)
		}

		let content = readFileSync(outputPath, "utf-8")
		content = injectScript(content)
		writeFileSync(outputPath, content, "utf-8")

		content = readFileSync(outputPath, "utf-8")
		content = injectScript(content)
		writeFileSync(outputPath, content, "utf-8")

		const result = readFileSync(outputPath, "utf-8")
		expect(result.split('id="trace-id-renderer"').length - 1).toBe(1)
	})
})
