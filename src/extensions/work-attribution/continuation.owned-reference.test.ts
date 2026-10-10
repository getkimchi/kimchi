import { randomUUID } from "node:crypto"
import type * as Fs from "node:fs"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { savePlanMarkdown } from "../../shared/planning/plan-markdown.js"
import { createContext } from "../__mocks__/context.js"
import { appendWorkRecord } from "../work-attribution.js"
import { findWorkContinuation } from "./continuation.js"
import { type FileTransition, readAttributedFileState, readRepositoryTransitions } from "./file-transitions.js"
import { flushWorkSummaries } from "./summary.js"

vi.mock("node:fs", async (original) => {
	const actual = await original<typeof Fs>()
	return { ...actual, realpathSync: Object.assign(vi.fn(actual.realpathSync), { native: actual.realpathSync.native }) }
})
vi.mock("./file-transitions.js", () => ({ readRepositoryTransitions: vi.fn(), readAttributedFileState: vi.fn() }))

const workId = "11111111-1111-4111-8111-111111111111"
let cwd: string
let transitions: FileTransition[]
beforeEach(() => {
	cwd = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-owned-reference-")))
	vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent"))
	mkdirSync(join(cwd, "docs"))
	mkdirSync(join(cwd, "other"))
	transitions = []
	vi.mocked(readRepositoryTransitions).mockImplementation(async () => ({
		repository: join(cwd, ".git"),
		worktree: cwd,
		transitions,
	}))
	// Each recorded edit was changed since, so a mention can only name its work.
	vi.mocked(readAttributedFileState).mockResolvedValue(null)
})
afterEach(async () => {
	await flushWorkSummaries()
	vi.clearAllMocks()
	vi.unstubAllEnvs()
	rmSync(cwd, { recursive: true, force: true })
})
function edit(path: string, worktree = cwd): FileTransition {
	return {
		type: "file_transition",
		transitionId: randomUUID(),
		toolCallId: "write",
		sessionId: "planner",
		workId,
		cwd: worktree,
		repository: join(cwd, ".git"),
		worktree,
		path,
		baseline: null,
		baselineFile: null,
		before: null,
		after: { blob: "b".repeat(40), mode: "100644" },
		cursor: { bytes: 0, digest: "empty" },
	}
}
async function owned(text: string): Promise<boolean> {
	return (await findWorkContinuation({ cwd }, text, undefined)).owned
}

it.each([
	["an unowned file", () => [], false],
	["a file with the same name in another directory", () => [edit("other/adr.md")], false],
	["an edited file", () => [edit("docs/adr.md")], true],
	["a file edited in another worktree of the repository", () => [edit("docs/adr.md", "/elsewhere/worktree")], true],
] as const)("finds whether a mention of %s has an owner", async (_case, rows, expected) => {
	transitions.push(...rows())
	expect(await owned("Implement docs/adr.md")).toBe(expected)
})

it("matches an owner through a directory alias", async () => {
	symlinkSync(join(cwd, "docs"), join(cwd, "alias"), "dir")
	transitions.push(edit("docs/adr.md"))
	expect(await owned("Implement alias/adr.md")).toBe(true)
})

it.each(["path", "snapshotPath"] as const)("keeps the owner of a deleted plan's %s", async (key) => {
	const saved = savePlanMarkdown({ cwd, name: "deleted", planText: "# Plan\n", workId })
	appendWorkRecord(createContext({ cwd }), { type: "plan", ...saved }, workId)
	const path = saved[key]
	if (!path) throw new Error("Missing retained plan")
	rmSync(path)
	expect(await owned(`Implement ${path}`)).toBe(true)
})

it("resolves only the plan records that name a deleted plan", async () => {
	mkdirSync(join(cwd, ".kimchi/plans"), { recursive: true })
	const planner = createContext({ cwd })
	for (let index = 0; index < 200; index++)
		appendWorkRecord(planner, { type: "plan", path: `.kimchi/plans/plan-${index}.md` }, workId)
	appendWorkRecord(planner, { type: "plan", path: ".kimchi/plans/deleted.md" }, workId)
	await flushWorkSummaries()
	vi.mocked(realpathSync).mockClear()
	expect(await owned(`Implement ${join(cwd, ".kimchi/plans/deleted.md")}`)).toBe(true)
	expect(realpathSync).toHaveBeenCalledOnce()
})
