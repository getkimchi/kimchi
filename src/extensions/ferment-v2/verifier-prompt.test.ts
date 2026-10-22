import { describe, expect, it } from "vitest"
import type { TodoItem } from "../todos/types.js"
import {
	buildVerifierTaskPrompt,
	buildVerifierValidationContext,
	type FermentV2VerifierFacts,
} from "./verifier-prompt.js"
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
	it("carries objective facts while withholding implementer context", () => {
		const prompt = buildVerifierTaskPrompt({
			objective: "Implement the login flow",
			cwd: "/workspace",
			facts,
			todos,
		})
		expect(prompt).toContain("Implement the login flow")
		expect(prompt).toContain("modified: src/a.ts")
		expect(prompt).toContain("added: src/new.test.ts")
		expect(prompt).toContain("branch main")
		expect(prompt).not.toContain("Implement feature A")
		expect(prompt).not.toContain("Write tests")
		expect(prompt).toContain("derive every check from this")
		expect(prompt).toContain("[eN] evidence IDs")
	})

	it("instructs a seeded review to acknowledge, add omissions, and never rewrite existing criteria", () => {
		const prompt = buildVerifierTaskPrompt({
			objective: "Implement the login flow",
			cwd: "/workspace",
			facts,
			todos,
			requirements: {
				items: [
					{
						id: "r1",
						requirement: "The login flow returns hello",
						source: "Objective: return hello",
						acceptance: "Output equals hello",
						category: "behavior",
					},
				],
				contractVersion: 3,
				provenance: "pre_implementation",
				idWatermark: 5,
			},
		})
		expect(prompt).toContain("persisted contract v3")
		expect(prompt).toContain("Call record_requirements with exactly this list to acknowledge it")
		// Reverse coverage: map objective clauses, not just recorded IDs.
		expect(prompt).toContain("Reverse coverage")
		expect(prompt).toContain("map every substantive clause to a listed requirement and a check")
		// The addition procedure: fresh-ID hint, expected version, binding immediately.
		expect(prompt).toContain("a fresh ID such as r6")
		expect(prompt).toContain("expectedVersion 3")
		expect(prompt).toContain("binding immediately")
		// Existing criteria are immutable in this review: proposals route through
		// the implementer's amendment tool, the review stays additions-only.
		expect(prompt).toContain("never be changed, weakened, recategorized, or removed")
		expect(prompt).toContain("additions-only")
		expect(prompt).toContain("amend_ferment_v2_requirements")
		expect(prompt).toContain("the user's own edit flow")
	})

	it("notes unavailable facts outside git", () => {
		const prompt = buildVerifierTaskPrompt({
			objective: "Research the API",
			cwd: "/tmp",
			facts: { basis: "outside_git" },
			todos: [],
		})
		expect(prompt).toContain("not a git repository")
		expect(prompt).not.toContain("Todos")
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

	it("includes the proposed answer and previous gap when present", () => {
		const prompt = buildVerifierValidationContext({
			todos,
			proposedAnswer: "THE ANSWER",
			previousGap: "Remaining requirement: exact output.",
		})
		expect(prompt).toContain("THE ANSWER")
		expect(prompt).toContain("Previous verifier gap")
		expect(prompt).toContain("Remaining requirement: exact output.")
	})

	it("includes Todo notes so the verifier sees the implementer's recorded evidence", () => {
		const prompt = buildVerifierValidationContext({ todos })
		expect(prompt).toContain("(note: Evidence: ran vitest)")
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
		expect(prompt).toContain("must be addressed by some check's flags array")
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
		expect(prompt).toContain("use run_original_test")
		expect(prompt).toContain("cannot satisfy original-test obligations")
		expect(prompt).toContain("Never install dependencies")
	})

	it("asks for a baseline_test run of every flagged pre-existing test file, naming the full baseline commit", () => {
		const prompt = buildVerifierTaskPrompt({
			objective: "Fix the bug",
			cwd: "/workspace",
			facts: {
				basis: "baseline",
				workspace: workspace({
					testInventoryFlags: [{ id: "f1", kind: "test_file_modified", path: "src/a.test.ts" }],
				}),
			},
			todos: [],
		})
		expect(prompt).toContain('a "baseline_test" check citing a matching host receipt')
		expect(prompt).toContain("run_original_test")
		expect(prompt).toContain("Then verify the recorded requirements independently")
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
