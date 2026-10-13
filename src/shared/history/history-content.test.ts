import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionManager, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { isEvictedContent, parseLogMarker } from "./history-content.js"

const BIG = "h".repeat(2_000)
const SMALL = "tiny"

/** Content blocks of a message-shaped value (test accessor). */
const contentBlocks = (m: unknown): unknown[] => {
	const content = (m as { content?: unknown }).content
	return Array.isArray(content) ? content : []
}

/** First text block of a message-shaped value (test accessor). */
const textOf = (m: unknown): string | undefined => {
	const first = contentBlocks(m)[0] as { text?: string } | undefined
	return first?.text
}

describe("history residency (D3, against the patched SessionManager)", () => {
	let dir: string
	let sm: SessionManager

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "histres-"))
		sm = SessionManager.create(dir, dir)
	})
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	it("evicts pre-compaction message content and resolves it transparently", () => {
		const bigId = sm.appendMessage({ role: "user", content: [{ type: "text", text: BIG }], timestamp: Date.now() })
		// An assistant entry is required for the log flush to write the file
		// (persist defers until the first assistant message). The runtime only
		// checks role, so a minimal shape suffices — cast for the typed API.
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "short answer" }],
			timestamp: Date.now(),
		} as never)
		const keptId = sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept question" }],
			timestamp: Date.now(),
		})

		sm.appendCompaction("summary of earlier turns", keptId, 1_000)

		// The pre-cut big entry's in-memory content is now a marker.
		const evicted = sm.getEntries().find((e) => e.id === bigId)
		expect(evicted?.type).toBe("message")
		if (evicted?.type !== "message") return
		expect(isEvictedContent(contentBlocks(evicted.message))).toBe(true)

		// The marker resolves back to the exact text via the read seam.
		const resolved = sessionEntryToContextMessages(evicted)
		expect(textOf(resolved[0])).toBe(BIG)

		// The session log keeps the FULL content (durable source of truth).
		const sessionFile = sm.getSessionFile()
		expect(sessionFile).toBeDefined()
		const log = sessionFile ? readFileSync(sessionFile, "utf8") : ""
		expect(log).toContain(BIG)
	})

	it("leaves small messages and post-compaction entries untouched", () => {
		const smallId = sm.appendMessage({ role: "user", content: [{ type: "text", text: SMALL }], timestamp: Date.now() })
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ans" }],
			timestamp: Date.now(),
		} as never)
		const keptId = sm.appendMessage({ role: "user", content: [{ type: "text", text: "kept" }], timestamp: Date.now() })
		sm.appendCompaction("summary", keptId, 100)
		const postId = sm.appendMessage({ role: "user", content: [{ type: "text", text: BIG }], timestamp: Date.now() })

		const byId = (id: string) => sm.getEntries().find((e) => e.id === id)
		const small = byId(smallId)
		if (small?.type !== "message") throw new Error("small entry missing")
		expect(isEvictedContent(contentBlocks(small.message))).toBe(false) // below eviction threshold
		const post = byId(postId)
		if (post?.type !== "message") throw new Error("post entry missing")
		expect(isEvictedContent(contentBlocks(post.message))).toBe(false) // post-compaction stays live
	})

	it("evicts pre-compaction content at RESUME (open) and resolves byte-exact", () => {
		const bigId = sm.appendMessage({ role: "user", content: [{ type: "text", text: BIG }], timestamp: Date.now() })
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ans" }],
			timestamp: Date.now(),
		} as never)
		const keptId = sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept question" }],
			timestamp: Date.now(),
		})
		sm.appendCompaction("resume summary", keptId, 1_000)
		const sessionFile = sm.getSessionFile()
		expect(sessionFile).toBeDefined()

		// Resume: a fresh manager over the same file.
		const resumed = SessionManager.open(sessionFile ?? "")
		const entry = resumed.getEntries().find((e) => e.id === bigId)
		expect(entry?.type).toBe("message")
		if (entry?.type !== "message") return
		expect(isEvictedContent(contentBlocks(entry.message))).toBe(true)
		const resolved = sessionEntryToContextMessages(entry)
		expect(textOf(resolved[0])).toBe(BIG)
		// The display path on the resumed manager renders the full history.
		const display = (resumed as unknown as { buildDisplayEntries: () => unknown[] }).buildDisplayEntries()
		expect(display.length).toBeGreaterThan(3)
	})

	it("parseLogMarker round-trips and rejects malformed text", () => {
		const handle = { file: "/tmp/x.jsonl", offset: 12, length: 99 }
		const marker = `[kimchi-ext:log]${JSON.stringify(handle)}`
		expect(parseLogMarker(marker)).toEqual(handle)
		expect(parseLogMarker("ordinary text")).toBeUndefined()
		expect(parseLogMarker("[kimchi-ext:log]not-json")).toBeUndefined()
		expect(parseLogMarker('[kimchi-ext:log]{"file":"/x","offset":-1,"length":3}')).toBeUndefined()
	})
})
