// Tests for src/resume-by-name.ts.
//
// SessionManager is mocked at the package boundary so the tests exercise the
// arg-rewriting logic without touching the real session store. The fake
// SessionInfo records below carry only the fields the resolver reads.

import type { SessionInfo } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return { ...actual, readdir: vi.fn() }
})

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return { ...actual, SessionManager: { listAll: vi.fn() } }
})

// Imports must come AFTER the vi.mock calls so the mocks are wired up.
const { pickSessionByName, resolveResumeNameArgs } = await import("./resume-by-name.js")
const { SessionManager } = await import("@earendil-works/pi-coding-agent")
const { readdir } = await import("node:fs/promises")

const AGENT_DIR = "/fake/agent-dir"
const CWD = "/home/user/project"

const readdirMock = vi.mocked(readdir)

function fakeSession(overrides: Partial<SessionInfo>): SessionInfo {
	return {
		path: "/fake/agent-dir/sessions/--x--/session.jsonl",
		id: "019f1780-8034-7435-85aa-3e86037676ee",
		cwd: CWD,
		created: new Date("2026-01-01T00:00:00Z"),
		modified: new Date("2026-01-01T00:00:00Z"),
		messageCount: 1,
		firstMessage: "hello",
		allMessagesText: "hello",
		...overrides,
	}
}

const listAllMock = vi.mocked(SessionManager.listAll)

function mockSessions(...sessions: SessionInfo[]) {
	listAllMock.mockReset()
	listAllMock.mockResolvedValue(sessions)
	// One fake per-project subdirectory under <agentDir>/sessions.
	readdirMock.mockReset()
	readdirMock.mockResolvedValue([{ isDirectory: () => true, isSymbolicLink: () => false, name: "--x--" }] as never)
}

describe("findNameCandidates via resolveResumeNameArgs", () => {
	it("rewrites two-token -r <name> when a named session exists", async () => {
		mockSessions(fakeSession({ name: "parser spike", path: "/s/p.jsonl" }))
		expect(await resolveResumeNameArgs(["-r", "parser spike"], AGENT_DIR, CWD)).toEqual(["--session", "/s/p.jsonl"])
	})

	it("rewrites --resume <name> the same way", async () => {
		mockSessions(fakeSession({ name: "parser spike", path: "/s/p.jsonl" }))
		expect(await resolveResumeNameArgs(["--resume", "parser spike"], AGENT_DIR, CWD)).toEqual([
			"--session",
			"/s/p.jsonl",
		])
	})

	it("rewrites the glued --resume=<name> form", async () => {
		mockSessions(fakeSession({ name: "parser-spike", path: "/s/p.jsonl" }))
		expect(await resolveResumeNameArgs(["--resume=parser-spike"], AGENT_DIR, CWD)).toEqual(["--session", "/s/p.jsonl"])
	})

	it("rewrites the glued -r<name> form", async () => {
		mockSessions(fakeSession({ name: "parser-spike", path: "/s/p.jsonl" }))
		expect(await resolveResumeNameArgs(["-rparser-spike"], AGENT_DIR, CWD)).toEqual(["--session", "/s/p.jsonl"])
	})

	it("preserves surrounding args", async () => {
		mockSessions(fakeSession({ name: "spike", path: "/s/p.jsonl" }))
		expect(await resolveResumeNameArgs(["--model", "fake", "-r", "spike", "review this"], AGENT_DIR, CWD)).toEqual([
			"--model",
			"fake",
			"--session",
			"/s/p.jsonl",
			"review this",
		])
	})

	it("handles multiple name candidates in one argv", async () => {
		mockSessions(
			fakeSession({ name: "spike", path: "/s/spike.jsonl" }),
			fakeSession({ name: "other", path: "/s/other.jsonl" }),
		)
		expect(
			await resolveResumeNameArgs(["-r", "spike", "--provider", "fake", "--resume=other"], AGENT_DIR, CWD),
		).toEqual(["--session", "/s/spike.jsonl", "--provider", "fake", "--session", "/s/other.jsonl"])
	})

	it("leaves args unchanged when no session has the name", async () => {
		mockSessions(fakeSession({ name: "parser spike" }))
		const input = ["-r", "no such name"]
		expect(await resolveResumeNameArgs(input, AGENT_DIR, CWD)).toBe(input)
	})

	it("leaves selector-shaped values to normalizeResumeIdArgs", async () => {
		mockSessions(fakeSession({ name: "019f1780-8034-7435-85aa-3e86037676ee" }))
		const input = ["-r", "019f1780-8034-7435-85aa-3e86037676ee", "-r", "./session.jsonl"]
		expect(await resolveResumeNameArgs(input, AGENT_DIR, CWD)).toBe(input)
	})

	it("does not treat flags as names", async () => {
		mockSessions(fakeSession({ name: "model" }))
		const input = ["-r", "--model", "fake"]
		expect(await resolveResumeNameArgs(input, AGENT_DIR, CWD)).toBe(input)
	})

	it("skips the disk scan entirely when no name candidates exist", async () => {
		listAllMock.mockReset()
		readdirMock.mockReset()
		const input = ["-p", "just a prompt"]
		expect(await resolveResumeNameArgs(input, AGENT_DIR, CWD)).toBe(input)
		expect(SessionManager.listAll).not.toHaveBeenCalled()
	})

	it("returns args unchanged when the sessions root cannot be read", async () => {
		listAllMock.mockReset()
		readdirMock.mockReset()
		readdirMock.mockRejectedValue(new Error("EACCES"))
		const input = ["-r", "spike"]
		expect(await resolveResumeNameArgs(input, AGENT_DIR, CWD)).toBe(input)
		expect(SessionManager.listAll).not.toHaveBeenCalled()
	})

	it("matches names case-insensitively", async () => {
		mockSessions(fakeSession({ name: "Parser Spike", path: "/s/p.jsonl" }))
		expect(await resolveResumeNameArgs(["-r", "parser SPIKE"], AGENT_DIR, CWD)).toEqual(["--session", "/s/p.jsonl"])
	})
})

describe("pickSessionByName", () => {
	it("prefers sessions from the current project over other projects", () => {
		const local = fakeSession({ name: "spike", cwd: CWD, path: "/s/local.jsonl", modified: new Date(1) })
		const foreign = fakeSession({ name: "spike", cwd: "/elsewhere", path: "/s/foreign.jsonl", modified: new Date(2) })
		expect(pickSessionByName([foreign, local], "spike", CWD)?.path).toBe("/s/local.jsonl")
	})

	it("picks the most recently modified session when names repeat", () => {
		const older = fakeSession({ name: "spike", path: "/s/old.jsonl", modified: new Date(1) })
		const newer = fakeSession({ name: "spike", path: "/s/new.jsonl", modified: new Date(2) })
		expect(pickSessionByName([older, newer], "spike", CWD)?.path).toBe("/s/new.jsonl")
	})

	it("falls back to other projects when no local session matches", () => {
		const foreign = fakeSession({ name: "spike", cwd: "/elsewhere", path: "/s/foreign.jsonl" })
		expect(pickSessionByName([foreign], "spike", CWD)?.path).toBe("/s/foreign.jsonl")
	})

	it("returns undefined for sessions without a name or with a different name", () => {
		expect(pickSessionByName([fakeSession({ name: undefined })], "spike", CWD)).toBeUndefined()
		expect(pickSessionByName([fakeSession({ name: "other" })], "spike", CWD)).toBeUndefined()
	})
})
