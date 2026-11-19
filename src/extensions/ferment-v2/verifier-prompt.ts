/**
 * verifier-prompt.ts — the Ferment V2 verifier's per-run task prompt.
 *
 * Order matters: the objective (the only authority) comes first, then the
 * host-gathered workspace facts — against the ferment **baseline** when one
 * exists, against HEAD otherwise (changed files, diff stat, test-inventory
 * flags with `f1…` IDs) — and the host-reserved baseline worktree, and only
 * then open findings and the implementer's self-reported context.
 */

import type { TodoItem } from "../todos/types.js"
import type { OpenFinding } from "./verifier-report.js"
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
	return `- ${flag.id}: ${kind} — ${flag.path}${flag.detail ? ` (${flag.detail})` : ""}`
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
				"Test-inventory flags (host-detected changes to the pre-existing test suite; run the original version of modified, deleted, or renamed tests against current code):",
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
			"Baseline source is available for inspection and optional comparisons; it is checked out on first use. Execution there is NOT isolated: shared node_modules/workspace links, Python editable installs, and generated artifacts can resolve current implementation code. A baseline cwd alone does not establish which code ran. Treat an unconfirmed comparison as inconclusive.",
			"For changed/deleted/renamed test flags, the original tests are in this worktree; run their assertions against current code. New tests run against baseline code only assess non-vacuity.",
			"Keep baseline production code intact. Never install dependencies, delete or replace shared node_modules, or commit in this disposable worktree. Leave cleanup to the host.",
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
	/** Findings earlier reviews left open, with the implementer's responses. */
	openFindings?: readonly OpenFinding[]
	todos: readonly TodoItem[]
	/** The proposed final answer (last tool-free assistant entry), when one exists. */
	proposedAnswer?: string
	/** The task-facing reason of the previous verifier `continue` verdict, when one exists. */
	previousGap?: string
}

const UNTESTED_FOCUS =
	"Spend your effort on objective clauses and behavior the delivery's own tests exercise thinly or not at all. Look there for wrong or missing behavior a user of the feature would hit, not for missing tests or polish."

const UNTESTED_FOCUS_REREVIEW =
	"Fixed findings are not evidence that the rest of the objective is met. After re-checking them, spend this review on what earlier reviews likely did not reach: objective clauses no finding touches, and behavior the delivery's own tests exercise thinly or not at all. Look there for wrong or missing behavior a user of the feature would hit, not for missing tests or polish."

function formatOpenFindings(findings: readonly OpenFinding[]): string {
	return [
		"Open findings from earlier reviews (resolve every one with resolve_finding before submitting):",
		...findings.map((finding) => {
			const response = finding.response
				? `implementer response: ${finding.response.status} — ${finding.response.evidence}`
				: "implementer response: none"
			const history = finding.disputesRejected ? ` (${finding.disputesRejected} earlier dispute(s) rejected)` : ""
			return `- ${finding.id} [${finding.clause}]${history}\n  expected: ${finding.expected}\n  observed: ${finding.observed}\n  ${response}`
		}),
		[
			"Re-run each finding's own failing input against the current code: fixed or still_failing, with the [eN] evidence of that run. For fixed, quote that input as reproduction; it must appear in a cited command, its output, or the probe file you wrote.",
			"For a disputed finding: Accept a dispute only when a quoted passage — from the objective, a repository file, or a specification the objective delegates to — shows that the finding's expected result is wrong or outside the objective's scope. Reject it when it rests on what the code, engine, or library can or cannot do (feasibility never removes a requirement); on the objective not mentioning the case when the expectation follows from a clause's plain reading or from conditions it names; on the delivered behavior; or on the implementer's word. If the quoted passage supports the finding, reject the dispute. A rejected dispute keeps the finding open; dispute_accepted must quote its source exactly (the host checks objective and repository quotes).",
		].join(" "),
	].join("\n")
}

/** Build the verifier's task prompt: objective first, then facts, open findings, and implementer context. */
export function buildVerifierTaskPrompt(input: FermentV2VerifierTaskInput): string {
	const sections: string[] = []
	sections.push(`Objective (the only authority; derive every check from it):\n${input.objective}`)
	sections.push(formatFactsSection(input.facts))
	if (input.baselineWorktree) {
		sections.push(formatBaselineWorktreeSection(input.baselineWorktree))
	} else if (input.facts.basis === "baseline") {
		// A baseline exists but no worktree could be reserved: the verifier
		// must know attribution cannot lean on a clean pre-change checkout.
		sections.push(
			"Baseline worktree: unavailable for this run (creation failed) — inspect original source with git show; treat runtime attribution as uncertain without evidence of which code ran.",
		)
	}
	if (input.integrityUnenforced) {
		sections.push(
			"Integrity guard: unavailable for this run (the host could not snapshot the working tree) — any file you create, modify, or delete in the working tree will NOT be reverted. Do not write to the working tree at all.",
		)
	}
	if (input.openFindings?.length) sections.push(formatOpenFindings(input.openFindings))
	sections.push(`Implementer's current Todos (context only, self-reported):\n${formatTodoState(input.todos)}`)
	if (input.proposedAnswer !== undefined) {
		sections.push(
			`Proposed final answer (the complete last tool-free assistant message; list exact-output requirements in submit_verdict.finalAnswer and the host compares them literally):\n${input.proposedAnswer}`,
		)
	}
	if (input.previousGap && !input.openFindings?.length) {
		sections.push(`Previous verifier gap (already reported to the implementer; re-check it):\n${input.previousGap}`)
	}
	sections.push(input.openFindings?.length || input.previousGap ? UNTESTED_FOCUS_REREVIEW : UNTESTED_FOCUS)
	sections.push(
		"Record each objective violation with report_finding as soon as you observe it, citing the [eN] IDs of the executed results. Retract a finding whose expectation proves wrong. Finish with submit_verdict.",
	)
	return sections.join("\n\n")
}
