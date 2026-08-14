import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	addHandoffNoteToSessionJsonl,
	buildHandoffNote,
	copySessionFileAndAddHandoffNote,
	removeTempDir,
} from "./handoff-note.js"

function msgEntry(id: string, parentId: string | null, message: Record<string, unknown>): string {
	return JSON.stringify({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message })
}

function userMsg(content: string): Record<string, unknown> {
	return { role: "user", content: [{ type: "text", text: content }], timestamp: 1 }
}

describe("buildHandoffNote", () => {
	const base = {
		fromPlatform: "darwin",
		fromCwd: "/home/dev/projects/demo",
		toCwd: "/home/sandbox/demo",
		gitIdentityProvisioned: true,
		gitCredential: { host: "github.com" },
	}

	it("rsync: uncommitted changes carried, gitignored not; .kimchi synced when in the include list", () => {
		const note = buildHandoffNote({
			...base,
			git: { headSha: "a1b2c3d", dirty: true },
			workspace: { kind: "rsync", fileCount: 42, syncedDotKimchi: true },
		})
		expect(note).toContain("rsync of the working tree (42 files)")
		expect(note).toContain("uncommitted local changes were carried over")
		expect(note).toContain("Gitignored content")
		expect(note).toContain("(.kimchi/ — ferment plans & runtime, transient docs) was synced")
	})

	it("rsync: states the tree was clean instead of claiming carried-over changes", () => {
		const note = buildHandoffNote({
			...base,
			git: { headSha: "a1b2c3d", dirty: false },
			workspace: { kind: "rsync", fileCount: 42, syncedDotKimchi: true },
		})
		expect(note).toContain("rsync of the working tree (42 files)")
		expect(note).toContain("the working tree was clean — no uncommitted changes existed to carry over")
		expect(note).not.toContain("uncommitted local changes were carried over")
	})

	it("rsync: omits the carried-over claim when the local git state is unknown", () => {
		const note = buildHandoffNote({
			...base,
			workspace: { kind: "rsync", fileCount: 42, syncedDotKimchi: true },
		})
		expect(note).toContain("rsync of the working tree (42 files)")
		expect(note).not.toContain("uncommitted local changes were carried over")
		expect(note).not.toContain("the working tree was clean")
		expect(note).toContain("Gitignored content")
	})

	it("rsync: warns explicitly when .kimchi was not synced", () => {
		const note = buildHandoffNote({
			...base,
			workspace: { kind: "rsync", fileCount: 10, syncedDotKimchi: false },
		})
		expect(note).toContain("(.kimchi/ — ferment plans & runtime, transient docs) was NOT synced")
		expect(note).toContain("do not expect ferment state or prior working documents to exist here")
	})

	it("describes a fresh git clone and missing uncommitted changes", () => {
		const note = buildHandoffNote({
			...base,
			workspace: { kind: "git-clone", repo: "https://github.com/org/repo.git", branch: "main" },
		})
		expect(note).toContain("fresh git clone of https://github.com/org/repo.git (branch main)")
		expect(note).toContain("uncommitted changes and gitignored content were NOT carried over")
	})

	it("clone: appends the local HEAD anchor when available", () => {
		const note = buildHandoffNote({
			...base,
			git: { headSha: "a1b2c3d", dirty: true },
			workspace: { kind: "git-clone", repo: "https://github.com/org/repo.git" },
		})
		expect(note).toContain("local repo was at commit a1b2c3d")
	})

	it("includes the git anchor in the previous-environment line", () => {
		const note = buildHandoffNote({
			...base,
			git: { headSha: "a1b2c3d", dirty: true },
			workspace: { kind: "none" },
		})
		expect(note).toContain("darwin, cwd /home/dev/projects/demo (local repo at a1b2c3d, working tree dirty)")
	})

	it("shows only dirtiness when the sha is unavailable", () => {
		const note = buildHandoffNote({
			...base,
			git: { dirty: true },
			workspace: { kind: "none" },
		})
		expect(note).toContain("/home/dev/projects/demo (working tree dirty)")
	})

	it("omits the git anchor entirely outside git repos", () => {
		const note = buildHandoffNote({ ...base, git: undefined, workspace: { kind: "none" } })
		expect(note).not.toContain("local repo at")
		expect(note).not.toContain("working tree dirty")
	})

	it("describes no-sync provisioning", () => {
		const note = buildHandoffNote({ ...base, workspace: { kind: "none" } })
		expect(note).toContain("no workspace content was synced")
	})

	it("states git identity and credential status", () => {
		const note = buildHandoffNote({
			...base,
			workspace: { kind: "none" },
			gitIdentityProvisioned: false,
			gitCredential: undefined,
		})
		expect(note).toContain("Git identity provisioned in sandbox: no")
		expect(note).toContain("Git credential: not provisioned")
	})

	it("points the agent at concrete ways to check and install tools", () => {
		const note = buildHandoffNote({ ...base, workspace: { kind: "none" } })
		expect(note).toContain("command -v")
		expect(note).toContain("package manager")
		expect(note).toContain("History is not fully replayable here")
	})
})

describe("addHandoffNoteToSessionJsonl", () => {
	it("appends the note as a user message chained to the last entry", () => {
		const src = [
			JSON.stringify({ type: "session", version: 3, id: "root", timestamp: "t", cwd: "/x" }),
			msgEntry("u1", "root", userMsg("hello")),
			"",
		].join("\n")

		const out = addHandoffNoteToSessionJsonl(src, "NOTE TEXT")
		const lines = out.split("\n")
		// session header + original user msg + appended note + trailing empty line
		expect(lines).toHaveLength(4)
		expect(lines[0]).toContain('"type":"session"')
		expect(lines[1]).toBe(src.split("\n")[1])
		const note = JSON.parse(lines[2])
		expect(note.type).toBe("message")
		expect(note.parentId).toBe("u1")
		expect(note.message.role).toBe("user")
		expect(note.message.content[0].type).toBe("text")
		expect(note.message.content[0].text).toBe("NOTE TEXT")
		expect(out.endsWith("\n")).toBe(true)
	})

	it("preserves malformed lines verbatim", () => {
		const src = ["not json {{{", msgEntry("u1", "root", userMsg("hi"))].join("\n")
		const out = addHandoffNoteToSessionJsonl(src, "NOTE")
		expect(out.split("\n")[0]).toBe("not json {{{")
	})
})

describe("copySessionFileAndAddHandoffNote", () => {
	let dir: string
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "handoff-test-"))
	})
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	it("writes an annotated copy without mutating the original", () => {
		const original = `${msgEntry("u1", "root", userMsg("hello"))}\n`
		const sessionFile = join(dir, "session.jsonl")
		writeFileSync(sessionFile, original)

		const copy = copySessionFileAndAddHandoffNote(sessionFile, "NOTE TEXT")
		expect(copy).toBeDefined()
		expect(copy).not.toBe(sessionFile)
		if (!copy) throw new Error("expected copy to be defined")

		// Original untouched.
		expect(readFileSync(sessionFile, "utf8")).toBe(original)
		// Copy contains original content plus the note.
		const copyText = readFileSync(copy, "utf8")
		expect(copyText).toContain("hello")
		expect(copyText).toContain("NOTE TEXT")

		// The copy sits at the root of its own temp dir; removeTempDir on its
		// parent fully cleans it up.
		removeTempDir(dirname(copy))
		expect(existsSync(copy)).toBe(false)
	})

	it("returns undefined for a missing file", () => {
		expect(copySessionFileAndAddHandoffNote(join(dir, "nope.jsonl"), "NOTE")).toBeUndefined()
	})
})
