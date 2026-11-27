import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	encodeCwdDir,
	hasAcpForkProvenance,
	persistAcpFork,
	readSessionHeader,
	resolveSessionPathById,
} from "./session-file.js"

vi.mock("node:fs", async (importActual) => {
	const actual = await importActual<typeof import("node:fs")>()
	return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) }
})
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs")

const directories: string[] = []
afterEach(() => {
	vi.mocked(writeFileSync).mockReset().mockImplementation(actualFs.writeFileSync)
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

	it("reads a session header larger than the initial peek", () => {
		const directory = mkdtempSync(join(tmpdir(), "kimchi-file-large-header-"))
		directories.push(directory)
		const parentSession = `${join(directory, "source")}-${"x".repeat(9 * 1024)}.jsonl`
		const header = {
			type: "session",
			version: 3,
			id: "large-header",
			cwd: directory,
			timestamp: new Date().toISOString(),
			parentSession,
		}
		const path = join(directory, "large-header.jsonl")
		writeFileSync(path, `${JSON.stringify(header)}\n`)

		expect(readFileSync(path, "utf-8").length).toBeGreaterThan(8 * 1024)
		expect(readSessionHeader(path)).toEqual({ id: "large-header", cwd: directory, parentSession })
	})

	it("validates provenance position and preserves unreadable-source errors", () => {
		const directory = mkdtempSync(join(tmpdir(), "kimchi-file-provenance-"))
		directories.push(directory)
		const header = { type: "session", version: 3, id: "source", cwd: directory, timestamp: new Date().toISOString() }
		const marker = { type: "custom", customType: "kimchi:acp-fork", id: "marker", timestamp: new Date().toISOString() }
		const path = join(directory, "fork.jsonl")
		writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(marker)}\n`)
		expect(hasAcpForkProvenance(path)).toBe(true)
		writeFileSync(
			path,
			`${JSON.stringify(header)}\n${JSON.stringify({ type: "custom", customType: "other" })}\n${JSON.stringify(marker)}\n`,
		)
		expect(hasAcpForkProvenance(path)).toBe(false)
		writeFileSync(path, "not-json\n")
		expect(hasAcpForkProvenance(path)).toBe(false)
		expect(() => hasAcpForkProvenance(join(directory, "missing.jsonl"))).toThrow(/ENOENT/)
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
			source: { sessionId: source.getSessionId(), cwd: directory, sessionManager: source },
			cwd: directory,
			sessionDir: directory,
			sourceId: "source",
			sourcePath: path,
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
		const originalRecord = before
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { customType?: string; id: string; parentId: string | null; data: unknown })
			.find((entry) => entry.customType === "subagents:record")
		const copiedRecord = contents
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { customType?: string; id: string; parentId: string | null; data: unknown })
			.find((entry) => entry.customType === "kimchi:acp-fork-subagent-metadata")
		expect(copiedRecord).toEqual({
			...originalRecord,
			id: selectedId,
			customType: "kimchi:acp-fork-subagent-metadata",
			data: {},
		})
		expect(readFileSync(path, "utf-8")).toBe(before)
	})

	it("preserves the selected live branch when the source file is not yet persisted", () => {
		const directory = mkdtempSync(join(tmpdir(), "kimchi-file-live-fallback-"))
		directories.push(directory)
		const source = SessionManager.create(directory, directory, { id: "source" })
		source.appendMessage({ role: "user", content: [{ type: "text", text: "live prompt" }], timestamp: 1 })
		const liveEntryId = source.appendCustomEntry("live-only", { content: "only in memory" })
		source.branch(liveEntryId)
		const sourcePath = source.getSessionFile()
		if (!sourcePath) throw new Error("expected allocated source path")
		rmSync(sourcePath)

		const result = persistAcpFork({
			source: { sessionId: source.getSessionId(), cwd: directory, sessionManager: source },
			cwd: directory,
			sessionDir: directory,
			sourceId: "source",
			sourcePath,
		})

		const contents = readFileSync(result.path, "utf-8")
		expect(contents).toContain("live prompt")
		expect(contents).toContain('"customType":"live-only"')
		expect(contents).toContain("only in memory")
		expect(readSessionHeader(result.path)?.parentSession).toBe(sourcePath)
		expect(existsSync(sourcePath)).toBe(false)
	})

	it("uses the caller's validated source path instead of rediscovering it", () => {
		const directory = mkdtempSync(join(tmpdir(), "kimchi-file-race-"))
		directories.push(directory)
		const source = SessionManager.create(directory, directory, { id: "source" })
		source.appendMessage({ role: "user", content: [{ type: "text", text: "validated source" }], timestamp: 1 })
		const sourcePath = source.getSessionFile()
		if (!sourcePath) throw new Error("expected source path")
		const competingPath = join(directory, "0000_source.jsonl")
		const competingHeader = {
			type: "session",
			version: 3,
			id: "competing",
			cwd: directory,
			timestamp: new Date().toISOString(),
		}
		writeFileSync(
			competingPath,
			`${JSON.stringify(competingHeader)}\n${JSON.stringify({ type: "custom", id: "competing-entry", customType: "unvalidated" })}\n`,
		)
		expect(resolveSessionPathById(directory, "source")).toBe(competingPath)

		const result = persistAcpFork({ cwd: directory, sessionDir: directory, sourceId: "source", sourcePath })
		expect(readFileSync(result.path, "utf-8")).toContain("validated source")
		expect(readFileSync(result.path, "utf-8")).not.toContain("unvalidated")
		expect(readSessionHeader(result.path)?.parentSession).toBe(sourcePath)
	})

	it("removes a partially written fork while preserving the write error", () => {
		const directory = mkdtempSync(join(tmpdir(), "kimchi-file-write-failure-"))
		directories.push(directory)
		const source = SessionManager.create(directory, directory, { id: "source" })
		source.appendMessage({ role: "user", content: [{ type: "text", text: "source transcript" }], timestamp: 1 })
		const sourcePath = source.getSessionFile()
		if (!sourcePath) throw new Error("expected source path")
		const before = readdirSync(directory)
		vi.mocked(writeFileSync).mockImplementationOnce((file) => {
			actualFs.writeFileSync(file, "partial fork")
			throw new Error("simulated disk full")
		})

		expect(() => persistAcpFork({ cwd: directory, sessionDir: directory, sourceId: "source", sourcePath })).toThrow(
			"simulated disk full",
		)
		expect(readdirSync(directory)).toEqual(before)
	})

	it("rejects a missing validated source file", () => {
		const directory = mkdtempSync(join(tmpdir(), "kimchi-file-missing-"))
		directories.push(directory)
		expect(() =>
			persistAcpFork({
				cwd: directory,
				sessionDir: directory,
				sourceId: "missing",
				sourcePath: join(directory, "missing.jsonl"),
			}),
		).toThrow(/ENOENT/)
	})
})
