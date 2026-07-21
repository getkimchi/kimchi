import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import orphanToolResultRepairExtension, { rewriteSessionJsonl } from "./orphan-tool-result-repair.js"

// ─── fixtures ────────────────────────────────────────────────────────────────

/** Build a pi-ai assistant message with the given toolCall blocks. */
function assistant(toolCalls: Array<{ id: string; name: string }>): Record<string, unknown> {
	return {
		role: "assistant",
		content: toolCalls.map((tc) => ({ type: "toolCall", id: tc.id, name: tc.name, arguments: {} })),
		stopReason: "toolUse",
	}
}

/** Build a pi-ai toolResult message. */
function toolResult(toolCallId: string, text = "ok"): Record<string, unknown> {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "someTool",
		content: [{ type: "text", text }],
		isError: false,
	}
}

/** Wrap a message in a session JSONL message entry. */
function messageEntry(message: Record<string, unknown>): Record<string, unknown> {
	return { type: "message", id: `entry-${Math.random().toString(36).slice(2)}`, message }
}

/** A non-message session entry (e.g. compaction). */
function compactionEntry(summary = "summarized"): Record<string, unknown> {
	return { type: "compaction", id: "c1", summary }
}

/** A custom session entry. */
function customEntry(): Record<string, unknown> {
	return { type: "custom", id: "x1", data: { note: "kept" } }
}

/** Mock ExtensionAPI that captures event handlers. */
function makeMockPI() {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {}
	return {
		pi: {
			on(event: string, handler: (...args: unknown[]) => unknown) {
				handlers[event] = handler
			},
			registerCommand: () => {},
		} as unknown as ExtensionAPI,
		async fire(event: string, ...args: unknown[]): Promise<unknown> {
			return handlers[event]?.(...args)
		},
	}
}

/** Build a mock ctx whose sessionManager.getSessionFile() returns `filePath`. */
function makeCtx(filePath: string | undefined): { sessionManager: { getSessionFile(): string | undefined } } {
	return {
		sessionManager: {
			getSessionFile: () => filePath,
		},
	}
}

// ─── temp-dir helpers ────────────────────────────────────────────────────────

let tmpDir: string

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repair-test-"))
})

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeSession(fileName: string, lines: string[]): string {
	const file = path.join(tmpDir, fileName)
	fs.writeFileSync(file, lines.join("\n"), "utf8")
	return file
}

// ─── rewriteSessionJsonl (pure helper) ──────────────────────────────────────

describe("rewriteSessionJsonl", () => {
	it("drops an orphaned toolResult line and keeps all other lines", () => {
		const lines = [
			JSON.stringify(messageEntry(assistant([{ id: "call:1", name: "t" }]))),
			JSON.stringify(messageEntry(toolResult("call:1", "matched"))),
			JSON.stringify(messageEntry(toolResult("call:orphan", "no matching toolCall"))),
			JSON.stringify(compactionEntry()),
			JSON.stringify(customEntry()),
		]

		const { rewritten, dropped } = rewriteSessionJsonl(lines)

		expect(dropped).toBe(1)
		expect(rewritten.length).toBe(4)
		// The orphaned toolResult is gone.
		expect(rewritten.some((l) => l.includes("call:orphan"))).toBe(false)
		// The matched pair survives.
		expect(rewritten.some((l) => l.includes("call:1"))).toBe(true)
		// Non-message entries are kept verbatim.
		expect(rewritten.some((l) => l.includes('"type":"compaction"'))).toBe(true)
		expect(rewritten.some((l) => l.includes('"type":"custom"'))).toBe(true)
	})

	it("is idempotent: a well-formed session is left byte-equivalent (dropped=0)", () => {
		const lines = [
			JSON.stringify(messageEntry(assistant([{ id: "call:1", name: "t" }]))),
			JSON.stringify(messageEntry(toolResult("call:1", "matched"))),
			JSON.stringify(compactionEntry()),
		]

		const { rewritten, dropped } = rewriteSessionJsonl(lines)

		expect(dropped).toBe(0)
		// Byte-equivalent: same lines in the same order.
		expect(rewritten).toEqual(lines)
	})

	it("is idempotent: re-running on already-repaired output drops nothing", () => {
		const poisoned = [
			JSON.stringify(messageEntry(assistant([{ id: "call:1", name: "t" }]))),
			JSON.stringify(messageEntry(toolResult("call:1"))),
			JSON.stringify(messageEntry(toolResult("call:orphan"))),
		]
		const first = rewriteSessionJsonl(poisoned)
		expect(first.dropped).toBe(1)

		const second = rewriteSessionJsonl(first.rewritten)
		expect(second.dropped).toBe(0)
		expect(second.rewritten).toEqual(first.rewritten)
	})

	it("keeps malformed (unparseable) lines as-is", () => {
		const lines = [
			JSON.stringify(messageEntry(assistant([{ id: "call:1", name: "t" }]))),
			"this is not valid json {{{",
			JSON.stringify(messageEntry(toolResult("call:1"))),
		]

		const { rewritten, dropped } = rewriteSessionJsonl(lines)

		expect(dropped).toBe(0)
		expect(rewritten).toEqual(lines)
	})
})

// ─── orphanToolResultRepairExtension (session_start handler) ─────────────────

describe("orphanToolResultRepairExtension", () => {
	it("rewrites a poisoned fixture: orphan gone from disk and .bak matches original", async () => {
		const { pi, fire } = makeMockPI()
		orphanToolResultRepairExtension(pi)

		const originalLines = [
			JSON.stringify(messageEntry(assistant([{ id: "call:1", name: "t" }]))),
			JSON.stringify(messageEntry(toolResult("call:1", "matched"))),
			JSON.stringify(messageEntry(toolResult("call:orphan", "no matching toolCall"))),
			JSON.stringify(compactionEntry()),
		]
		const file = writeSession("session.jsonl", originalLines)
		const originalBytes = fs.readFileSync(file, "utf8")

		await fire("session_start", { type: "session_start", reason: "resume" }, makeCtx(file))

		// The orphan is gone from the rewritten file.
		const rewritten = fs.readFileSync(file, "utf8")
		expect(rewritten.includes("call:orphan")).toBe(false)
		expect(rewritten.includes("call:1")).toBe(true)

		// A .bak backup exists and matches the original bytes exactly.
		const backup = `${file}.bak`
		expect(fs.existsSync(backup)).toBe(true)
		expect(fs.readFileSync(backup, "utf8")).toBe(originalBytes)
	})

	it("leaves a clean session unchanged and writes no .bak (no rewrite needed)", async () => {
		const { pi, fire } = makeMockPI()
		orphanToolResultRepairExtension(pi)

		const cleanLines = [
			JSON.stringify(messageEntry(assistant([{ id: "call:1", name: "t" }]))),
			JSON.stringify(messageEntry(toolResult("call:1", "matched"))),
			JSON.stringify(compactionEntry()),
		]
		const file = writeSession("clean.jsonl", cleanLines)
		const originalBytes = fs.readFileSync(file, "utf8")

		await fire("session_start", { type: "session_start", reason: "resume" }, makeCtx(file))

		// File is byte-equivalent to the original — no rewrite occurred.
		expect(fs.readFileSync(file, "utf8")).toBe(originalBytes)
		// No .bak is written when there is nothing to repair.
		expect(fs.existsSync(`${file}.bak`)).toBe(false)
	})

	it("never throws when the session file is missing", async () => {
		const { pi, fire } = makeMockPI()
		orphanToolResultRepairExtension(pi)

		const missingFile = path.join(tmpDir, "does-not-exist.jsonl")

		// Should resolve without throwing; nothing is written.
		await expect(
			fire("session_start", { type: "session_start", reason: "resume" }, makeCtx(missingFile)),
		).resolves.toBeUndefined()

		expect(fs.existsSync(missingFile)).toBe(false)
		expect(fs.existsSync(`${missingFile}.bak`)).toBe(false)
	})

	it("never throws when getSessionFile() returns undefined (new session)", async () => {
		const { pi, fire } = makeMockPI()
		orphanToolResultRepairExtension(pi)

		await expect(
			fire("session_start", { type: "session_start", reason: "new" }, makeCtx(undefined)),
		).resolves.toBeUndefined()
	})
})
