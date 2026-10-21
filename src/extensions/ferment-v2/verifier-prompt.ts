/**
 * verifier-prompt.ts — the Ferment V2 verifier's per-run task prompt.
 *
 * Until requirements exist (the drafting slice), the verifier derives its
 * checks from the objective; the prompt therefore carries the objective, the
 * host-gathered workspace facts — against the ferment **baseline** when one
 * exists, against HEAD otherwise (changed files, diff stat, test-inventory
 * flags with `f1…` IDs) — the path of the host-reserved baseline worktree
 * with the attribution and vacuous-test steps and the known worktree traps,
 * the implementer's Todos (low-trust context), the proposed final answer,
 * and the previous verifier gap.
 */

import type { TodoItem } from "../todos/types.js"
import type { FermentV2CompletionConfidence } from "./types.js"
import type { TestInventoryFlag, WorkspaceChangedFile, WorkspaceFacts } from "./workspace.js"

/**
 * Host-gathered facts for one verifier run, by basis:
 * - `baseline`: compared against the ferment baseline snapshot;
 * - `head`: no ferment baseline exists, compared against the before-run HEAD;
 * - `unavailable`: a git workspace whose facts could not be gathered
 *   (snapshot or diff failed, HEAD unresolvable);
 * - `outside_git`: not a git repository.
 */
export type FermentV2VerifierFacts =
	| { basis: "baseline" | "head"; workspace: WorkspaceFacts }
	| { basis: "unavailable" }
	| { basis: "outside_git" }

function formatChangedFile(file: WorkspaceChangedFile): string {
	const label =
		file.status === "A" ? "added" : file.status === "D" ? "deleted" : file.status === "R" ? "renamed" : "modified"
	return `- ${label}: ${file.path}${file.from ? ` (from ${file.from})` : ""}`
}

function formatTestInventoryFlag(flag: TestInventoryFlag): string {
	const kind = flag.kind.replaceAll("_", " ")
	return `- ${flag.id}: ${kind} — ${flag.path}${flag.detail ? ` (${flag.detail})` : ""}${
		flag.requirementId ? ` [requirement ${flag.requirementId}]` : ""
	}`
}

function formatTodoState(todos: readonly TodoItem[]): string {
	if (todos.length === 0) return "(no Todos)"
	return todos.map((todo) => `- [${todo.status}] ${todo.content}${todo.note ? ` (note: ${todo.note})` : ""}`).join("\n")
}

/** Renders the facts section for the run's basis. */
function formatFactsSection(facts: FermentV2VerifierFacts): string {
	if (facts.basis === "outside_git") {
		return [
			"Working tree facts (host-gathered):",
			"(unavailable — not a git repository; there is no baseline snapshot, no test-inventory flag list, and no baseline worktree; inspect the directory directly)",
		].join("\n")
	}
	if (facts.basis === "unavailable") {
		return [
			"Working tree facts (host-gathered):",
			"(unavailable for this run — git failed while gathering them; there is no test-inventory flag list; inspect the changes yourself with read-only git commands such as git status and git diff)",
		].join("\n")
	}
	const workspace = facts.workspace
	const gitState = [
		workspace.git.branch ? `branch ${workspace.git.branch}` : undefined,
		workspace.git.head ? `HEAD ${workspace.git.head.slice(0, 12)}` : undefined,
		facts.basis === "baseline" && workspace.git.commitsSinceBaseline !== undefined
			? `${workspace.git.commitsSinceBaseline} commit(s) since baseline`
			: undefined,
		`${workspace.git.uncommittedFiles} uncommitted file change(s)`,
	]
		.filter(Boolean)
		.join(", ")
	const basisLabel = facts.basis === "baseline" ? "baseline" : "HEAD"
	const changedFiles = workspace.changedFiles.length
		? workspace.changedFiles.map(formatChangedFile).join("\n")
		: `(no changed files vs ${basisLabel})`
	const header =
		facts.basis === "baseline"
			? `Working tree facts (host-gathered, compared against the baseline ${workspace.baseline.slice(0, 12)} captured when the objective started — untracked files included):`
			: `Working tree facts (host-gathered, compared against HEAD ${workspace.baseline.slice(0, 12)} — no baseline snapshot was captured for this objective, so uncommitted changes from before it started are included; untracked files included):`
	const lines = [header, changedFiles]
	if (workspace.diffStat) lines.push(`Diff stat vs ${basisLabel}:\n${workspace.diffStat}`)
	lines.push(`git state: ${gitState}`)
	if (workspace.truncated) {
		lines.push("(the changed-file list or the diff stat was truncated by the host)")
	}
	if (workspace.testInventoryFlags.length > 0) {
		lines.push(
			[
				`Test-inventory flags (host-detected changes to the pre-existing test suite; a met verdict requires every flag ID addressed by some check's flags array, and every modified, deleted, or renamed test file a "baseline_test" check that ran its baseline version — git show ${workspace.baseline}:<path>):`,
				...workspace.testInventoryFlags.map(formatTestInventoryFlag),
			].join("\n"),
		)
	}
	if (workspace.testInventoryIncomplete) {
		lines.push(
			"(the host could not collect the test inventory completely — the flag list may be missing pre-existing test deletions, renames, modifications, or added skip/only markers; inspect the changed test files yourself)",
		)
	}
	return lines.join("\n")
}

/** Renders the baseline-worktree section with the attribution and vacuous-test steps and the known traps. */
function formatBaselineWorktreeSection(path: string): string {
	return [
		`Baseline worktree (host-provided, disposable): ${path}`,
		[
			"The working tree exactly as it was when the objective started, including files that were untracked then. It is checked out on first use: the first command that references this path may take a moment. Run code there to:",
			"- Attribute test failures: run the same failing test in the baseline worktree — a failure that also fails there is pre-existing, not caused by the implementer's changes; a failure that passes there is a regression.",
			"- Vacuous-test check: copy the implementer's new or changed test files into the baseline worktree, then run them there — they must FAIL there. A new test that passes without the implementer's changes does not verify the change. Distinguish how they fail: an assertion failure is the strong evidence; a test that only fails with a setup or import error (a module that did not exist at baseline, a missing fixture) is weaker, and a test that cannot run at all is inconclusive — treat it as unverified and look for an assertion-level failure instead.",
			"The worktree is disposable and always deleted after this run: you may copy the implementer's new or changed test files into it and run whatever setup those tests need (installs, generators, configuration), but keep the pre-change production code intact — never edit, add, or delete its source files, and never commit anything inside the worktree.",
			"Known traps: a Python editable install (pip -e) points at the main tree, not the worktree — reinstall inside the worktree or treat its baseline results as unreliable; generated files (build output, snapshots, lockfile-derived artifacts) may be stale or absent — regenerate them inside the worktree when cheap; node_modules directories of the main tree (the root one and nested ones up to three levels deep) are already linked into the worktree — deeper ones are not; never delete or replace them.",
		].join("\n"),
	].join("\n")
}

export interface FermentV2VerifierTaskInput {
	objective: string
	cwd: string
	facts: FermentV2VerifierFacts
	/** Absolute path of the host-reserved baseline worktree; absent when none could be reserved. */
	baselineWorktree?: string
	/** True when the host could not snapshot the working tree, so verifier changes will not be reverted. */
	integrityUnenforced?: boolean
	todos: readonly TodoItem[]
	/** The implementer's self-reported completion confidence (low trust). */
	completionConfidence?: FermentV2CompletionConfidence
	/** The proposed final answer (last tool-free assistant entry), when one exists. */
	proposedAnswer?: string
	/** The task-facing reason of the previous verifier `continue` verdict, when one exists. */
	previousGap?: string
}

/** Build the verifier's task prompt: objective, facts, low-trust context, and the output contract. */
export function buildVerifierTaskPrompt(input: FermentV2VerifierTaskInput): string {
	const sections: string[] = []
	sections.push(`Objective (derive every check from this):\n${input.objective}`)
	sections.push(formatFactsSection(input.facts))
	if (input.baselineWorktree) {
		sections.push(formatBaselineWorktreeSection(input.baselineWorktree))
	} else if (input.facts.basis === "baseline") {
		// A baseline exists but no worktree could be reserved: the verifier
		// must know attribution cannot lean on a clean pre-change checkout.
		sections.push(
			"Baseline worktree: unavailable for this run (creation failed) — attribute pre-existing failures by reverting the implementer's changes by hand only when that is cheap and safe, and treat attribution as uncertain otherwise.",
		)
	}
	if (input.integrityUnenforced) {
		sections.push(
			"Integrity guard: unavailable for this run (the host could not snapshot the working tree) — any file you create, modify, or delete in the working tree will NOT be reverted. Do not write to the working tree at all.",
		)
	}
	sections.push(`Implementer's current Todos (context only, self-reported):\n${formatTodoState(input.todos)}`)
	if (input.completionConfidence) {
		sections.push(
			`Implementer's self-reported completion confidence: ${input.completionConfidence} (low trust — verify everything).`,
		)
	}
	if (input.proposedAnswer !== undefined) {
		sections.push(
			`Proposed final answer (the complete last tool-free assistant message; compare final-answer requirements against it literally):\n${input.proposedAnswer}`,
		)
	}
	if (input.previousGap) {
		sections.push(`Previous verifier gap (already reported to the implementer):\n${input.previousGap}`)
	}
	const hasFlags = "workspace" in input.facts && input.facts.workspace.testInventoryFlags.length > 0
	sections.push(
		[
			"Now execute your verification procedure: derive the requirements and their edges from the objective, verify every behaviour independently — your own probes, pre-existing tests, or direct commands; the implementer's tests are context only —",
			"and end with exactly one JSON object matching the output contract. Cite only [eN] evidence IDs stamped on your tool results.",
			...(hasFlags
				? [
						"Every test-inventory flag ID listed above must be addressed by some check's flags array before a met verdict is accepted.",
					]
				: []),
		].join(" "),
	)
	return sections.join("\n\n")
}
