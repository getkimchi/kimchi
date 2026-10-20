import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { SessionUpdate } from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildArtifactLinkChunks, TurnArtifactBuffer } from "./artifact-links.js"

// Narrow a chunk-shaped SessionUpdate for assertions (the builder only
// ever emits agent_message_chunk variants).
const chunkOf = (u: SessionUpdate) =>
	u as { sessionUpdate: string; content: Record<string, unknown>; messageId?: string; _meta?: unknown }

// Contract tests for the artifact domain module (chunk shape, attribution
// merge, attachment point, drop rule, dedupe). End-to-end coverage of the
// live/replay paths is in server.test.ts.
describe("buildArtifactLinkChunks", () => {
	const artifact = { path: "/a/slides.pptx", name: "slides.pptx", uri: "file:///a/slides.pptx" }

	it("emits one resource_link chunk per artifact, marked type=artifact", () => {
		const chunks = buildArtifactLinkChunks({
			messageId: "km.3",
			artifacts: [artifact, { path: "/a/b.pdf", name: "b.pdf", uri: "file:///a/b.pdf", mimeType: "application/pdf" }],
		})
		expect(chunks).toHaveLength(2)
		expect(chunks[0]).toMatchObject({
			sessionUpdate: "agent_message_chunk",
			content: { type: "resource_link", uri: "file:///a/slides.pptx", name: "slides.pptx" },
			messageId: "km.3",
			_meta: { "kimchi.dev": { type: "artifact" } },
		})
		// mimeType ∈ optional field: absent on the first artifact, present on
		// the second — never serialized as undefined.
		expect("mimeType" in chunkOf(chunks[0]).content).toBe(false)
		expect(chunkOf(chunks[1]).content.mimeType).toBe("application/pdf")
	})

	it("merges the block's emitted model attribution into the chunk meta", () => {
		const seen = new Map([["km.3", { modelId: "kimi-k3", requestedModelId: "auto" }]])
		const chunks = buildArtifactLinkChunks({ messageId: "km.3", artifacts: [artifact], seenModelMeta: seen })
		expect(chunks[0]._meta).toMatchObject({
			"kimchi.dev": { type: "artifact", modelId: "kimi-k3", requestedModelId: "auto" },
		})
	})
})

describe("TurnArtifactBuffer", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "kimchi-artifact-links-"))
	})
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	const writeCall = (path: string) => ({
		toolName: "write",
		args: { path, content: "x" },
		result: { content: [{ type: "text", text: "done" }] },
		cwd: tmpDir,
	})

	it("attaches to the LAST noted text block and clears after flush", () => {
		const target = join(tmpDir, "out.pdf")
		writeFileSync(target, "pdf")
		const buffer = new TurnArtifactBuffer()
		buffer.collectFromToolCall(writeCall(target))
		buffer.noteTextBlock("km.1")
		buffer.noteTextBlock("km.2")
		const chunks = buffer.flush()
		expect(chunks).toHaveLength(1)
		expect(chunkOf(chunks[0]).messageId).toBe("km.2")
		expect(buffer.size).toBe(0)
		expect(buffer.flush()).toEqual([])
	})

	it("dedupes repeated paths across tool calls within the turn", () => {
		const target = join(tmpDir, "out.pdf")
		writeFileSync(target, "pdf")
		const buffer = new TurnArtifactBuffer()
		buffer.collectFromToolCall(writeCall(target))
		buffer.collectFromToolCall(writeCall(target))
		buffer.noteTextBlock("km.9")
		expect(buffer.flush()).toHaveLength(1)
	})

	it("drops artifacts of a text-less turn (nothing to attach to)", () => {
		const target = join(tmpDir, "out.pdf")
		writeFileSync(target, "pdf")
		const buffer = new TurnArtifactBuffer()
		buffer.collectFromToolCall(writeCall(target))
		expect(buffer.flush()).toEqual([])
		expect(buffer.size).toBe(0)
	})

	it("collect passes verifyExists:false through (replay skips the on-disk check)", () => {
		const missing = join(tmpDir, "gone.pdf")
		const buffer = new TurnArtifactBuffer()
		buffer.collectFromToolCall({ ...writeCall(missing), verifyExists: false })
		buffer.noteTextBlock("km.1")
		const chunks = buffer.flush(undefined, { verifyExists: false })
		expect(chunks).toHaveLength(1)
		expect(chunkOf(chunks[0]).content.uri).toBe(pathToFileURL(missing).href)
	})

	it("live flush drops an artifact deleted before the turn ended", () => {
		const target = join(tmpDir, "temp.pdf")
		writeFileSync(target, "pdf")
		const buffer = new TurnArtifactBuffer()
		buffer.collectFromToolCall(writeCall(target))
		buffer.noteTextBlock("km.1")
		rmSync(target)
		expect(buffer.flush()).toEqual([])
	})

	it("caps turn-level sniffed accumulation, evicting the oldest sniffed entry", () => {
		const buffer = new TurnArtifactBuffer()
		for (let i = 0; i < 40; i++) {
			const p = join(tmpDir, `f${i}.pdf`)
			writeFileSync(p, "pdf") // fresh mtime passes the window
			buffer.collectFromToolCall({
				toolName: "bash",
				args: { command: "ls" },
				result: { content: [{ type: "text", text: p }] },
				cwd: tmpDir,
				windowStart: Date.now() - 1000,
			})
		}
		buffer.noteTextBlock("km.1")
		const chunks = buffer.flush()
		expect(chunks).toHaveLength(32) // MAX_TURN_ARTIFACTS
		const names = chunks.map((c) => chunkOf(c).content.name)
		expect(names).toContain("f39.pdf")
		expect(names).not.toContain("f0.pdf") // oldest evicted
	})

	it("evicts only sniffed entries (write/edit artifacts stay past the cap)", () => {
		const buffer = new TurnArtifactBuffer()
		const written = join(tmpDir, "written.md")
		writeFileSync(written, "md")
		buffer.collectFromToolCall(writeCall(written)) // first, intentional
		for (let i = 0; i < 40; i++) {
			const p = join(tmpDir, `f${i}.pdf`)
			writeFileSync(p, "pdf")
			buffer.collectFromToolCall({
				toolName: "bash",
				args: { command: "ls" },
				result: { content: [{ type: "text", text: p }] },
				cwd: tmpDir,
				windowStart: Date.now() - 1000,
			})
		}
		buffer.noteTextBlock("km.1")
		const names = buffer.flush().map((c) => chunkOf(c).content.name)
		expect(names).toHaveLength(33)
		expect(names).toContain("written.md")
	})

	it("declared and write/edit artifacts bypass the sniffed cap", () => {
		const buffer = new TurnArtifactBuffer()
		for (let i = 0; i < 40; i++) {
			const p = join(tmpDir, `f${i}.pdf`)
			writeFileSync(p, "pdf")
			buffer.collectFromToolCall({
				toolName: "bash",
				args: { command: "ls" },
				result: { content: [{ type: "text", text: p }] },
				cwd: tmpDir,
				windowStart: Date.now() - 1000,
			})
		}
		// Late plan: must not be ejected by earlier sniffed noise.
		const plan = join(tmpDir, "plan.md")
		writeFileSync(plan, "md")
		buffer.collectFromToolCall({
			toolName: "submit_plan",
			args: {},
			result: { content: [{ type: "text", text: "ok" }], details: { artifacts: [{ path: plan }] } },
			cwd: tmpDir,
		})
		buffer.noteTextBlock("km.1")
		const chunks = buffer.flush()
		expect(chunks).toHaveLength(33)
		expect(chunks.map((c) => chunkOf(c).content.name)).toContain("plan.md")
	})

	it("disambiguates colliding basenames with the shortest unique path suffix", () => {
		mkdirSync(join(tmpDir, "docs"))
		mkdirSync(join(tmpDir, "out"))
		writeFileSync(join(tmpDir, "docs", "report.md"), "md")
		writeFileSync(join(tmpDir, "out", "report.md"), "md")
		writeFileSync(join(tmpDir, "solo.pdf"), "pdf")
		const buffer = new TurnArtifactBuffer()
		buffer.collectFromToolCall(writeCall(join(tmpDir, "docs", "report.md")))
		buffer.collectFromToolCall(writeCall(join(tmpDir, "out", "report.md")))
		buffer.collectFromToolCall(writeCall(join(tmpDir, "solo.pdf")))
		buffer.noteTextBlock("km.1")
		const names = buffer.flush().map((c) => chunkOf(c).content.name)
		expect(names.sort()).toEqual(["docs/report.md", "out/report.md", "solo.pdf"])
	})
})
