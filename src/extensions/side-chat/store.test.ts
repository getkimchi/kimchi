import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import { openSideChatLog, persistableThread, type SideThread, sideChatFile } from "./store.js"

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 0 })
const assistant = (text: string, stopReason = "stop") =>
	({ role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: 0 }) as SideThread[number]

let dir: string | undefined

function tempSessionDir(): string {
	dir = mkdtempSync(join(tmpdir(), "side-chat-store-"))
	return dir
}

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true })
	dir = undefined
})

function mainSession(sessionDir: string, overrides: { sessionFile?: string; sessionId?: string } = {}) {
	return {
		getCwd: () => "/project",
		getSessionDir: () => sessionDir,
		getSessionFile: () =>
			"sessionFile" in overrides ? overrides.sessionFile : join(sessionDir, "2026-01-01_main-1.jsonl"),
		getSessionId: () => overrides.sessionId ?? "main-1",
	}
}

describe("sideChatFile", () => {
	it("nests side chats under the owning main session", () => {
		expect(sideChatFile("/sessions", "main-1", "side-1")).toBe(
			join("/sessions", "side-chats", "main-1", "side-1.jsonl"),
		)
	})
})

describe("persistableThread", () => {
	it("keeps a settled thread unchanged", () => {
		const thread = [user("Which cache?"), assistant("LRU.")]

		expect(persistableThread(thread)).toBe(thread)
	})

	it("excludes a reply that is still streaming", () => {
		const thread = [user("Which cache?"), assistant("Use the…", "pending")]

		expect(persistableThread(thread)).toEqual([user("Which cache?")])
	})

	it("keeps a reply persisted as aborted when the chat closed mid-stream", () => {
		const thread = [user("Which cache?"), assistant("Use the…", "aborted")]

		expect(persistableThread(thread)).toBe(thread)
	})

	it("only excludes a trailing in-flight reply", () => {
		const thread = [user("Which cache?"), assistant("Use the…", "pending"), user("more")]

		expect(persistableThread(thread)).toBe(thread)
	})
})

describe("openSideChatLog", () => {
	it("appends the side thread to its own session file and reads it back", () => {
		const sessionDir = tempSessionDir()
		const log = openSideChatLog(mainSession(sessionDir), "side-1")

		log.append([user("Which cache?"), assistant("LRU.")])
		log.append([user("Why?")])

		expect(log.read()).toEqual([user("Which cache?"), assistant("LRU."), user("Why?")])
		expect(openSideChatLog(mainSession(sessionDir), "side-1").read()).toEqual(log.read())
	})

	it("writes a Pi session header and a linear message chain", () => {
		const sessionDir = tempSessionDir()
		openSideChatLog(mainSession(sessionDir), "side-1").append([user("a")])
		openSideChatLog(mainSession(sessionDir), "side-1").append([assistant("b")])

		const file = sideChatFile(sessionDir, "main-1", "side-1") ?? ""
		const [header, first, second] = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
		expect(header).toMatchObject({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "side-1",
			cwd: "/project",
			parentSession: join(sessionDir, "2026-01-01_main-1.jsonl"),
		})
		expect(first).toMatchObject({ type: "message", parentId: null, message: user("a") })
		expect(second).toMatchObject({ type: "message", parentId: first.id })
	})

	it("creates no file until there is something to save", () => {
		const sessionDir = tempSessionDir()
		const log = openSideChatLog(mainSession(sessionDir), "side-1")

		log.append([])

		expect(log.read()).toEqual([])
		expect(existsSync(join(sessionDir, "side-chats"))).toBe(false)
	})

	it("reads another main session's side chat by its owner id", () => {
		const sessionDir = tempSessionDir()
		openSideChatLog(mainSession(sessionDir, { sessionId: "main-0" }), "side-1").append([user("from the original")])

		expect(openSideChatLog(mainSession(sessionDir), "side-1", "main-0").read()).toEqual([user("from the original")])
		expect(openSideChatLog(mainSession(sessionDir), "side-1").read()).toEqual([])
	})

	it("keeps side threads in memory when the main session is not persisted", () => {
		const sessionDir = tempSessionDir()
		const main = mainSession(sessionDir, { sessionFile: undefined, sessionId: "ephemeral-1" })

		openSideChatLog(main, "side-1").append([user("hi")])

		expect(openSideChatLog(main, "side-1").read()).toEqual([user("hi")])
		expect(existsSync(join(sessionDir, "side-chats"))).toBe(false)
	})
})

describe("openSideChatLog errors", () => {
	it("returns no messages for a missing transcript", () => {
		const sessionDir = tempSessionDir()

		expect(openSideChatLog(mainSession(sessionDir), "gone").read()).toEqual([])
	})

	it("refuses unsafe ids as file paths", () => {
		const sessionDir = tempSessionDir()

		expect(sideChatFile(sessionDir, "main-1", "../escape")).toBeUndefined()
		expect(sideChatFile(sessionDir, "../escape", "side-1")).toBeUndefined()
		openSideChatLog(mainSession(sessionDir), "../escape").append([user("hi")])
		expect(existsSync(join(sessionDir, "side-chats"))).toBe(false)
	})

	it("recovers from a torn last line left by a crash", () => {
		const sessionDir = tempSessionDir()
		openSideChatLog(mainSession(sessionDir), "side-1").append([user("before crash")])
		appendFileSync(sideChatFile(sessionDir, "main-1", "side-1") ?? "", '{"type":"message","mess')

		const log = openSideChatLog(mainSession(sessionDir), "side-1")
		log.append([user("after crash")])

		expect(log.read()).toEqual([user("before crash"), user("after crash")])
	})
})
