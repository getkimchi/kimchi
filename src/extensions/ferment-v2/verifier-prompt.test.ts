import { describe, expect, it } from "vitest"
import type { TodoItem } from "../todos/types.js"
import { buildVerifierTaskPrompt, type FermentV2VerifierFacts } from "./verifier-prompt.js"
import type { WorkspaceFacts } from "./workspace.js"

const todos: TodoItem[] = [
	{ id: 1, status: "in_progress", content: "Implement feature A", activeForm: "Implementing feature A" },
	{ id: 2, status: "completed", content: "Write tests", note: "Evidence: ran vitest" },
]

function workspace(overrides: Partial<WorkspaceFacts> = {}): WorkspaceFacts {
	return {
		baseline: "baseline-1234567890",
		changedFiles: [
			{ status: "M", path: "src/a.ts" },
			{ status: "A", path: "src/new.test.ts" },
		],
		diffStat: "",
		testInventoryFlags: [],
		testInventoryIncomplete: false,
		git: { branch: "main", head: "abc123def456", commitsSinceBaseline: 0, uncommittedFiles: 2 },
		truncated: false,
		...overrides,
	}
}

const facts: FermentV2VerifierFacts = { basis: "baseline", workspace: workspace() }

describe("buildVerifierTaskPrompt", () => {
	it("aims a review at thinly tested behavior, and a re-review beyond the fixed findings", () => {
		const first = buildVerifierTaskPrompt({ objective: "Implement the login flow", cwd: "/workspace", facts, todos })
		const again = buildVerifierTaskPrompt({
			objective: "Implement the login flow",
			cwd: "/workspace",
			facts,
			todos,
			previousGap: "Check the public login endpoint",
		})
		expect(first).toContain("the delivery's own tests exercise thinly or not at all")
		expect(first).toContain("not for missing tests or polish")
		expect(first).not.toContain("Fixed findings are not evidence")
		expect(again).toContain(
			"Fixed findings are not evidence that the rest of the objective is met. After re-checking them",
		)
		// The re-check of earlier gaps stays, ahead of the focus.
		expect(again.indexOf("Previous verifier gap")).toBeLessThan(again.indexOf("Fixed findings are not evidence"))
	})

	it("puts the objective first, then the facts, then implementer context", () => {
		const prompt = buildVerifierTaskPrompt({
			objective: "Implement the login flow",
			cwd: "/workspace",
			facts,
			todos,
			proposedAnswer: "THE ANSWER",
			previousGap: "Check the public login endpoint",
		})
		expect(prompt).toContain("Objective (the only authority; derive every check from it):\nImplement the login flow")
		expect(prompt).toContain("modified: src/a.ts")
		expect(prompt).toContain("Implement feature A")
		expect(prompt).toContain("(note: Evidence: ran vitest)")
		expect(prompt).toContain("THE ANSWER")
		expect(prompt).toContain("submit_verdict.finalAnswer")
		expect(prompt).toContain("Check the public login endpoint")
		expect(prompt).toContain("report_finding")
		expect(prompt.indexOf("Objective (")).toBeLessThan(prompt.indexOf("Working tree facts"))
		expect(prompt.indexOf("Working tree facts")).toBeLessThan(prompt.indexOf("Implementer's current Todos"))
		expect(prompt).not.toContain("JSON")
	})

	it("notes unavailable facts outside git", () => {
		const prompt = buildVerifierTaskPrompt({
			objective: "Research the API",
			cwd: "/tmp",
			facts: { basis: "outside_git" },
			todos: [],
		})
		expect(prompt).toContain("not a git repository")
		expect(prompt).toContain("(no Todos)")
		expect(prompt).not.toContain("Baseline worktree")
	})

	it("tells the verifier to inspect git itself when the facts could not be gathered", () => {
		const prompt = buildVerifierTaskPrompt({
			objective: "Do it",
			cwd: "/workspace",
			facts: { basis: "unavailable" },
			todos: [],
		})
		expect(prompt).toContain("unavailable for this run — git failed while gathering them")
		expect(prompt).toContain("there is no test-inventory flag list")
		expect(prompt).toContain("git status and git diff")
		expect(prompt).not.toContain("Test-inventory flags")
	})

	it("omits optional sections when absent", () => {
		const prompt = buildVerifierTaskPrompt({
			objective: "Do it",
			cwd: "/workspace",
			facts: { basis: "head", workspace: workspace() },
			todos: [],
		})
		expect(prompt).not.toContain("completion confidence")
		expect(prompt).not.toContain("Proposed final answer")
		expect(prompt).not.toContain("Previous verifier gap")
		expect(prompt).not.toContain("Integrity guard")
		expect(prompt).not.toContain("Baseline worktree")
	})

	it("renders baseline facts: changed files, diff stat, git state, and flagged test changes with IDs", () => {
		const prompt = buildVerifierTaskPrompt({
			objective: "Fix the bug",
			cwd: "/workspace",
			facts: {
				basis: "baseline",
				workspace: workspace({
					diffStat: " src/a.ts | 2 +-\n 2 files changed",
					testInventoryFlags: [
						{ id: "f1", kind: "test_file_deleted", path: "src/old.test.ts" },
						{ id: "f2", kind: "skip_marker_added", path: "src/a.test.ts", detail: "it.skip('works')" },
					],
					git: { branch: "main", head: "abc123", commitsSinceBaseline: 2, uncommittedFiles: 2 },
					truncated: true,
				}),
			},
			todos: [],
		})
		expect(prompt).toContain("compared against the baseline baseline-123")
		expect(prompt).toContain("captured when the objective started")
		expect(prompt).toContain("modified: src/a.ts")
		expect(prompt).toContain("Diff stat vs baseline")
		expect(prompt).toContain("2 commit(s) since baseline")
		expect(prompt).toContain("truncated by the host")
		expect(prompt).toContain("- f1: test file deleted — src/old.test.ts")
		expect(prompt).toContain("- f2: skip marker added — src/a.test.ts (it.skip('works'))")
		expect(prompt).toContain("run the original version of modified, deleted, or renamed tests against current code")
	})

	it("renders HEAD-based facts when the ferment has no baseline, without baseline-only details", () => {
		const prompt = buildVerifierTaskPrompt({
			objective: "Fix the bug",
			cwd: "/workspace",
			facts: {
				basis: "head",
				workspace: workspace({
					baseline: "head-abcdef123456789",
					diffStat: " src/a.ts | 2 +-",
					testInventoryFlags: [{ id: "f1", kind: "test_file_modified", path: "src/a.test.ts" }],
					git: { branch: "main", head: "head-abcdef", commitsSinceBaseline: 0, uncommittedFiles: 2 },
				}),
			},
			todos: [],
		})
		expect(prompt).toContain("compared against HEAD head-abcdef1")
		expect(prompt).toContain("no baseline snapshot was captured for this objective")
		expect(prompt).toContain("uncommitted changes from before it started are included")
		expect(prompt).toContain("Diff stat vs HEAD")
		expect(prompt).toContain("- f1: test file modified — src/a.test.ts")
		expect(prompt).not.toContain("commit(s) since baseline")
		// Without a ferment baseline there is no baseline worktree to miss.
		expect(prompt).not.toContain("Baseline worktree")
	})

	it("tells the verifier when the test inventory could not be collected completely", () => {
		const prompt = buildVerifierTaskPrompt({
			objective: "Fix the bug",
			cwd: "/workspace",
			facts: {
				basis: "baseline",
				workspace: workspace({
					testInventoryFlags: [{ id: "f1", kind: "test_file_modified", path: "src/a.test.ts" }],
					testInventoryIncomplete: true,
				}),
			},
			todos: [],
		})
		expect(prompt).toContain("could not collect the test inventory completely")
		expect(prompt).toContain("inspect the changed test files yourself")
	})

	it("carries the baseline worktree path with the attribution and vacuous-test steps and the traps", () => {
		const prompt = buildVerifierTaskPrompt({
			objective: "Fix the bug",
			cwd: "/workspace",
			facts,
			baselineWorktree: "/tmp/kimchi-ferment-v2-baseline-x",
			todos: [],
		})
		expect(prompt).toContain("Baseline worktree (host-provided, disposable): /tmp/kimchi-ferment-v2-baseline-x")
		expect(prompt).toContain("checked out on first use")
		expect(prompt).toContain("Execution there is NOT isolated")
		expect(prompt).toContain("workspace links")
		expect(prompt).toContain("inconclusive")
		expect(prompt).toContain("editable installs")
		expect(prompt).toContain("generated artifacts")
		expect(prompt).toContain("the original tests are in this worktree")
		expect(prompt).toContain("Never install dependencies")
	})

	it("explains a missing baseline worktree when a ferment baseline exists", () => {
		const prompt = buildVerifierTaskPrompt({ objective: "Do it", cwd: "/workspace", facts, todos: [] })
		expect(prompt).toContain("Baseline worktree: unavailable")
	})

	it("warns the verifier not to write when integrity is unenforced", () => {
		const prompt = buildVerifierTaskPrompt({
			objective: "Do it",
			cwd: "/workspace",
			facts: { basis: "unavailable" },
			integrityUnenforced: true,
			todos: [],
		})
		expect(prompt).toContain("Integrity guard: unavailable for this run")
		expect(prompt).toContain("will NOT be reverted")
		expect(prompt).toContain("Do not write to the working tree at all")
	})
})
