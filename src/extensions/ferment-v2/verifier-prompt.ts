/**
 * verifier-prompt.ts — the Ferment V2 verifier's per-run task prompt.
 *
 * The verifier records requirements before validating them. The initial
 * prompt carries the objective and host-gathered workspace facts — against the ferment **baseline** when one
 * exists, against HEAD otherwise (changed files, diff stat, test-inventory
 * flags with `f1…` IDs) — the path of the host-reserved baseline worktree
 * with the attribution and vacuous-test steps and the known worktree traps,
 * while implementer context is released by record_requirements after the
 * initial requirement list has been accepted.
 */

import type { TodoItem } from "../todos/types.js"
import type { VerifierRequirement } from "./requirements.js"
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
				`Test-inventory flags (host-detected changes to the pre-existing test suite; a met verdict requires every flag ID addressed by some check's flags array, and every modified, deleted, or renamed test file a "baseline_test" check citing a matching host receipt from run_original_test):`,
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
			"For changed/deleted/renamed test flags, use run_original_test to run host-retrieved original assertions against current code. New tests run against baseline code only assess non-vacuity; they cannot satisfy original-test obligations.",
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
	todos: readonly TodoItem[]
	/** The proposed final answer (last tool-free assistant entry), when one exists. */
	proposedAnswer?: string
	/** The task-facing reason of the previous verifier `continue` verdict, when one exists. */
	previousGap?: string
	/** The persisted ready contract this review must verify (acknowledge; additions only). */
	requirements?: {
		items: readonly VerifierRequirement[]
		contractVersion: number
		provenance: string
		/** Highest r<n> ID ever allocated; additions must use fresh IDs above it. */
		idWatermark: number
	}
	/** Why no established contract applies to this review (degraded or stale). */
	requirementsUnavailable?: string
}

function formatRequirementItems(items: readonly VerifierRequirement[]): string {
	return items
		.map(
			(item) =>
				`- ${item.id} [${item.category}] ${item.requirement}\n  source: ${item.source}\n  acceptance: ${item.acceptance}`,
		)
		.join("\n")
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
			"Baseline worktree: unavailable for this run (creation failed) — inspect original source with git show; treat runtime attribution as uncertain without evidence of which code ran.",
		)
	}
	if (input.integrityUnenforced) {
		sections.push(
			"Integrity guard: unavailable for this run (the host could not snapshot the working tree) — any file you create, modify, or delete in the working tree will NOT be reverted. Do not write to the working tree at all.",
		)
	}
	const hasFlags = "workspace" in input.facts && input.facts.workspace.testInventoryFlags.length > 0
	if (input.requirements) {
		const provenanceLabel = input.requirements.provenance.replaceAll("_", " ")
		sections.push(
			[
				`Established requirements (persisted contract v${input.requirements.contractVersion}, drafted ${provenanceLabel} before implementation):`,
				formatRequirementItems(input.requirements.items),
				"These obligations were sourced from the objective and baseline repository contracts before any candidate code existed; they are authoritative for this review. Call record_requirements with exactly this list to acknowledge it and receive implementation context.",
				"Reverse coverage: before your verdict, reread the objective above and map every substantive clause to a listed requirement and a check that verifies it — do not stop at checking the recorded IDs. A substantive clause mapping to no requirement is an omission.",
				`If you discover an omitted task-grounded obligation, add it: call record_requirements with the current list verbatim plus the new obligation (a fresh ID such as r${input.requirements.idWatermark + 1}, above the allocated watermark), a source-grounded reason quoting where the objective or a repository contract requires it, and expectedVersion ${input.requirements.contractVersion}. The added obligation is binding immediately: verify it in this review like any other — fully verified it permits met, unmet or unverified it requires continue.`,
				"Existing items can never be changed, weakened, recategorized, or removed in this review — it stays additions-only. If one seems wrong, return a continue verdict whose reason states the proposed amendment in the exact form the implementer can pass to amend_ferment_v2_requirements: the criterion ID, the corrected requirement/source/acceptance/category, and the objective or repository evidence. The obligation stays binding until an accepted amendment changes it; this review never rewrites criteria itself, and changes to the user's objective require the user's own edit flow.",
				"Verify every listed requirement independently and reference their IDs in your checks.",
				'Cite only [eN] evidence IDs stamped on your tool results, one bare ID string per array entry (for example "e25" in the JSON evidence arrays).',
				...(hasFlags
					? [
							"Every test-inventory flag ID listed above must be addressed by some check's flags array before a met verdict is accepted.",
						]
					: []),
			].join("\n\n"),
		)
		return sections.join("\n\n")
	}
	if (input.requirementsUnavailable) {
		sections.push(
			`Requirements contract: unavailable — ${input.requirementsUnavailable}. Derive a working list of observable requirements from the objective and call record_requirements with it before validating candidate behavior; its result supplies the implementer context. A met verdict cannot be certified without an established contract, so when no established requirement remains unresolved, report the outage instead of claiming completion.`,
		)
	} else {
		sections.push(
			"First derive observable requirements from the objective and relevant repository contracts. Call record_requirements alone before validating candidate behavior; its result supplies the implementer context. Then verify the recorded requirements independently and reference their IDs in your checks",
		)
	}
	sections.push(
		[
			'and end with exactly one JSON object matching the output contract. Cite only [eN] evidence IDs stamped on your tool results, one bare ID string per array entry (for example "e25" in the JSON evidence arrays).',
			...(hasFlags
				? [
						"Every test-inventory flag ID listed above must be addressed by some check's flags array before a met verdict is accepted.",
					]
				: []),
		].join(" "),
	)
	return sections.join("\n\n")
}

/** Released to the same session only after its initial requirements are recorded. */
export function buildVerifierValidationContext(
	input: Pick<FermentV2VerifierTaskInput, "todos" | "proposedAnswer" | "previousGap">,
): string {
	const sections: string[] = []
	sections.push(`Implementer's current Todos (context only, self-reported):\n${formatTodoState(input.todos)}`)
	if (input.proposedAnswer !== undefined) {
		sections.push(
			`Proposed final answer (the complete last tool-free assistant message; compare final-answer requirements against it literally):\n${input.proposedAnswer}`,
		)
	}
	if (input.previousGap) {
		sections.push(`Previous verifier gap (already reported to the implementer):\n${input.previousGap}`)
	}
	return sections.join("\n\n")
}
