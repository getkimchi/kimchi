import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { savePlanMarkdown } from "../../shared/planning/plan-markdown.js"
import { findWorkContinuation } from "./continuation.js"
import { type FileTransition, readAttributedFileState, readRepositoryTransitions } from "./file-transitions.js"

vi.mock("./file-transitions.js", () => ({
	readRepositoryTransitions: vi.fn(),
	readAttributedFileState: vi.fn(),
}))
const git = vi.hoisted(() => ({ defaults: "refs/remotes/origin/trunk\n" }))
vi.mock("node:child_process", () => ({
	execFile: vi.fn((_command, _args, _options, callback) => callback(null, git.defaults, "")),
}))

let cwd: string
const planningWork = "11111111-1111-4111-8111-111111111111"
const otherWork = "22222222-2222-4222-8222-222222222222"
const after = { blob: "b".repeat(40), mode: "100644" }
let transitions: FileTransition[]
function artifact(overrides: Partial<FileTransition> = {}): FileTransition {
	return {
		type: "file_transition",
		transitionId: randomUUID(),
		toolCallId: "write-plan",
		sessionId: "planner",
		workId: planningWork,
		cwd,
		repository: join(cwd, ".git"),
		worktree: cwd,
		path: "docs/adr/decision.md",
		baseline: "a".repeat(40),
		baselineFile: null,
		before: null,
		after,
		cursor: { bytes: 0, digest: "empty" },
		branch: "feature",
		recordedAt: new Date().toISOString(),
		...overrides,
	}
}
beforeEach(() => {
	cwd = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-continuation-")))
	git.defaults = "refs/remotes/origin/trunk\n"
	vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent"))
	mkdirSync(join(cwd, "docs/adr"), { recursive: true })
	writeFileSync(join(cwd, "docs/adr/decision.md"), "# Decision\n")
	transitions = [artifact()]
	vi.mocked(readRepositoryTransitions).mockImplementation(async () => ({
		repository: join(cwd, ".git"),
		worktree: cwd,
		branch: "feature",
		transitions,
	}))
	vi.mocked(readAttributedFileState).mockResolvedValue(after)
})
afterEach(() => {
	vi.clearAllMocks()
	vi.unstubAllEnvs()
	rmSync(cwd, { recursive: true, force: true })
})

describe("continuing saved work", () => {
	it("continues a named native plan without requiring a Git repository", async () => {
		const saved = savePlanMarkdown({ cwd, name: "feature", planText: "# Plan", workId: planningWork })
		vi.mocked(readRepositoryTransitions).mockResolvedValue(undefined)
		expect(await findWorkContinuation({ cwd }, `Implement ${saved.path}`)).toMatchObject({
			workId: planningWork,
			source: "saved-plan",
			evidence: { path: saved.path },
		})
	})
	it.each([
		"Implement docs/adr/decision.md",
		"/skill:implement @docs/adr/decision.md",
		"Follow [the ADR](docs/adr/decision.md).",
		"Follow [the ADR section](docs/adr/decision.md#steps).",
	])("continues the exact saved artifact named by the user: %s", async (text) => {
		expect(await findWorkContinuation({ cwd }, text)).toMatchObject({
			workId: planningWork,
			source: "named-artifact",
			evidence: { path: join(cwd, "docs/adr/decision.md"), transitionId: transitions[0].transitionId },
		})
	})
	it("uses user arguments after skill expansion and ignores paths in the skill body", async () => {
		const prompt =
			'<skill name="implement" location="/skills/implement/SKILL.md">\nImplement examples/example.md.\n</skill>'
		expect(await findWorkContinuation({ cwd }, prompt)).toBeUndefined()
		expect(await findWorkContinuation({ cwd }, `${prompt}\n\ndocs/adr/decision.md`)).toMatchObject({
			workId: planningWork,
			source: "named-artifact",
		})
	})
	it("requires the saved artifact to remain unchanged", async () => {
		vi.mocked(readAttributedFileState).mockResolvedValue({ ...after, blob: "changed" })
		expect(await findWorkContinuation({ cwd }, "Implement docs/adr/decision.md")).toBeUndefined()
	})
	it("does not choose an artifact that multiple works edited", async () => {
		transitions.push(artifact({ workId: otherWork }))
		expect(await findWorkContinuation({ cwd }, "Implement docs/adr/decision.md")).toBeUndefined()
	})
	it("does not resolve conflicting saved-plan and artifact owners", async () => {
		const plan = savePlanMarkdown({ cwd, name: "other", planText: "# Other", workId: otherWork })
		expect(await findWorkContinuation({ cwd }, `Implement docs/adr/decision.md and ${plan.path}`)).toBeUndefined()
	})
	it("does not use branch fallback for an explicit unknown artifact", async () => {
		expect(
			await findWorkContinuation({ cwd }, "Implement docs/adr/missing.md", { allowBranchFallback: true }),
		).toBeUndefined()
	})
	it("does not ignore an unknown Markdown link with a section fragment", async () => {
		expect(
			await findWorkContinuation({ cwd }, "Implement [the other design](docs/adr/missing.md#details).", {
				allowBranchFallback: true,
			}),
		).toBeUndefined()
	})
	it("requires callers to allow the branch fallback", async () => {
		expect(await findWorkContinuation({ cwd }, "/skill:implement")).toBeUndefined()
	})
	it("labels missing-path continuation as a recent branch match", async () => {
		expect(await findWorkContinuation({ cwd }, "/skill:implement", { allowBranchFallback: true })).toMatchObject({
			workId: planningWork,
			source: "recent-branch",
			evidence: {
				branch: "feature",
				path: join(cwd, "docs/adr/decision.md"),
				transitionId: transitions[0].transitionId,
			},
		})
	})
	it.each([
		{ branch: "trunk" },
		{ branch: undefined },
		{ branch: "different-feature" },
		{ recordedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() },
		{ recordedAt: undefined },
		{ worktree: "/other-worktree" },
	])("does not guess from ineligible planning evidence: %j", async (fields) => {
		transitions = [artifact(fields)]
		expect(await findWorkContinuation({ cwd }, "/skill:implement", { allowBranchFallback: true })).toBeUndefined()
	})
	it("leaves two recent planning works separate", async () => {
		transitions.push(artifact({ workId: otherWork, path: "docs/adr/another.md" }))
		expect(await findWorkContinuation({ cwd }, "/skill:implement", { allowBranchFallback: true })).toBeUndefined()
	})
	it("does not let a later human change become a branch match", async () => {
		vi.mocked(readAttributedFileState).mockResolvedValue({ ...after, blob: "human-edit" })
		expect(await findWorkContinuation({ cwd }, "/skill:implement", { allowBranchFallback: true })).toBeUndefined()
	})
	it("does not guess when the repository default branch is unknown", async () => {
		git.defaults = ""
		expect(await findWorkContinuation({ cwd }, "/skill:implement", { allowBranchFallback: true })).toBeUndefined()
	})
	it("does not continue planning on the repository default branch", async () => {
		git.defaults = "refs/remotes/origin/feature\n"
		expect(await findWorkContinuation({ cwd }, "/skill:implement", { allowBranchFallback: true })).toBeUndefined()
	})
	it("leaves unrelated recent source edits out of a planning work", async () => {
		transitions.push(artifact({ workId: otherWork, path: "src/other.ts" }))
		expect(await findWorkContinuation({ cwd }, "/skill:implement", { allowBranchFallback: true })).toBeUndefined()
	})
	it("does not forget an older competing artifact owner", async () => {
		transitions.unshift(
			artifact({
				workId: otherWork,
				recordedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
			}),
		)
		expect(await findWorkContinuation({ cwd }, "/skill:implement", { allowBranchFallback: true })).toBeUndefined()
	})
})
