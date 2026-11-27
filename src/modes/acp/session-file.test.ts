import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import {
	encodeCwdDir,
	hasAcpForkProvenance,
	persistAcpFork,
	readSessionHeader,
	resolveSessionPathById,
} from "./session-file.js"

const directories: string[] = []
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("session file discovery and provenance", () => {
	it("resolves and reads the persisted session header", () => {
		const directory = mkdtempSync(join(tmpdir(), "kimchi-file-header-"))
		directories.push(directory)
		const manager = SessionManager.create(directory, directory, { id: "source" })
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 })
		const path = manager.getSessionFile()
		if (!path) throw new Error("expected persisted session")

		expect(resolveSessionPathById(directory, "source")).toBe(path)
		expect(resolveSessionPathById(directory, "missing")).toBeNull()
		expect(readSessionHeader(path)).toMatchObject({ id: "source", cwd: directory })
		expect(encodeCwdDir(directory)).toBe(`--${directory.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`)
	})

	it("honors ACP fork provenance only at the second entry", () => {
		const directory = mkdtempSync(join(tmpdir(), "kimchi-file-provenance-"))
		directories.push(directory)
		const header = { type: "session", version: 3, id: "source", cwd: directory, timestamp: new Date().toISOString() }
		const marker = { type: "custom", customType: "kimchi:acp-fork", id: "marker", timestamp: new Date().toISOString() }
		const path = join(directory, "fork.jsonl")
		writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(marker)}\n`)
		expect(hasAcpForkProvenance(path)).toBe(true)
		writeFileSync(path, `${JSON.stringify(header)}\n`)
		expect(hasAcpForkProvenance(path)).toBe(false)
	})
})

describe("persistAcpFork", () => {
	it("preserves source bytes and structural IDs while making child metadata inert", () => {
		const directory = mkdtempSync(join(tmpdir(), "kimchi-file-copy-"))
		directories.push(directory)
		const source = SessionManager.create(directory, directory, { id: "source" })
		source.appendMessage({ role: "user", content: [{ type: "text", text: "parent prompt" }], timestamp: 1 })
		const selectedId = source.appendCustomEntry("subagents:record", {
			agentId: "worker",
			sessionId: "child",
			parentSessionId: "source",
			toolCallId: "parent-spawn",
			description: "Review source",
			cwd: directory,
			sessionFile: join(directory, "child.jsonl"),
		})
		source.branch(selectedId)
		const path = source.getSessionFile()
		if (!path) throw new Error("expected source path")
		const before = readFileSync(path, "utf-8")

		const result = persistAcpFork({
			source: { sessionId: source.getSessionId(), cwd: directory, sessionFile: path, sessionManager: source },
			cwd: directory,
			sessionDir: directory,
			sourceId: "source",
		})

		const contents = readFileSync(result.path, "utf-8")
		const header = JSON.parse(contents.split("\n")[0]) as { id: string; parentSession: string }
		expect(result.sessionId).not.toBe("source")
		expect(header.parentSession).toBe(path)
		expect(contents).toContain("parent prompt")
		expect(contents.split("\n")[1]).toContain('"customType":"kimchi:acp-fork"')
		expect(contents).toContain('"customType":"kimchi:acp-fork-subagent-metadata"')
		expect(contents).not.toContain('"customType":"subagents:record"')
		expect(contents).toContain(`"id":"${selectedId}"`)
		expect(readFileSync(path, "utf-8")).toBe(before)
	})

	it("rejects a source that is not persisted", () => {
		const directory = mkdtempSync(join(tmpdir(), "kimchi-file-missing-"))
		expect(() => persistAcpFork({ cwd: directory, sessionDir: directory, sourceId: "missing" })).toThrow(
			"unknown or unsaved source session missing",
		)
		rmSync(directory, { recursive: true, force: true })
	})
})
