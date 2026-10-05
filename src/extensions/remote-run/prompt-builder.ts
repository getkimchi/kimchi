/**
 * Prompt builder for remote plan execution.
 *
 * Constructs the prompt sent to the remote agent when the user picks
 * "Execute the plan in a remote workspace" from either the plan-mode or ferment review
 * dialog. The prompt includes:
 *
 * 1. Origin-specific instructions (plain execution vs ferment execution)
 * 2. A condensed environment handoff note (informs the agent it's on a
 *    remote Linux sandbox, repo was cloned, changes synced, devkit for
 *    missing tools — inspired by teleport's `buildHandoffNote()`)
 * 3. An optional commit-discipline section when the dispatch carries git
 *    intent (PR-first flow — commit on the branch, never push)
 * 4. The approved plan text (inlined — the local plan file path is not
 *    referenced because it doesn't exist on the remote sandbox)
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { promptForRemoteBranch, type RemoteGitWorkflow, slugifyPlanBranch } from "./git-workflow.js"

export type RemotePlanOrigin = "plan-mode" | "ferment"

export interface RemotePlanPromptOptions {
	/** The origin of the plan — determines execution instructions. */
	origin: RemotePlanOrigin
	/**
	 * Git intent captured at dispatch (PR-first flow). When set, the prompt
	 * carries commit discipline: the agent commits on the branch, never
	 * pushes, and leaves the worktree clean. Absent = plain run.
	 */
	gitWorkflow?: RemoteGitWorkflow
}

/** Builds the prompt string for remote plan execution. */
export function buildRemotePlanPrompt(planText: string, opts: RemotePlanPromptOptions): string {
	const { origin, gitWorkflow } = opts

	const executionInstructions = buildExecutionInstructions(origin)
	const handoffNote = buildHandoffNote()
	const parts = [executionInstructions, handoffNote]
	if (gitWorkflow) parts.push(buildGitWorkflowSection(gitWorkflow))
	parts.push("", "---", "", planText)
	return parts.join("\n")
}

/**
 * Commit discipline for PR-intent runs. Includes a verify/create fallback
 * line so the flow stays correct even if worker branch-creation behavior
 * changes server-side (branch absent → agent creates it from current HEAD).
 */
function buildGitWorkflowSection(gitWorkflow: RemoteGitWorkflow): string {
	const { branch, baseBranch } = gitWorkflow
	const provenance = baseBranch ? ` (created from \`${baseBranch}\` at provisioning)` : ""
	return [
		"",
		"[Git workflow — PR-first execution]",
		`You are on branch \`${branch}\`, already checked out${provenance}. Verify with \`git branch --show-current\` — if it does not show \`${branch}\`, create and switch to \`${branch}\` from the current HEAD before starting.`,
		"Commit your work on this branch in logical commits. Never push — the harness pushes after user review.",
		"Commit only files you changed for this task — the worktree may contain the user's pre-existing uncommitted files; never add those.",
		"Leave the worktree clean when done, and end with a short summary of the commits you made.",
	].join("\n")
}

/**
 * Captures git intent (branch name via promptForRemoteBranch) and composes
 * the remote plan prompt in one step — the shared entry point for both cloud
 * dispatch paths (plan-mode approval and ferment plan review). Escape at the
 * picker, an empty custom-name submit, invalid custom names, or
 * non-interactive modes yield a plain-run prompt with no intent.
 */
export async function buildRemotePlanPromptWithIntent(
	ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "mode" | "ui">,
	planText: string,
	opts: Omit<RemotePlanPromptOptions, "gitWorkflow">,
): Promise<{ prompt: string; gitWorkflow: RemoteGitWorkflow | undefined }> {
	const gitWorkflow = await promptForRemoteBranch(ctx, slugifyPlanBranch(planText))
	return { prompt: buildRemotePlanPrompt(planText, { ...opts, gitWorkflow }), gitWorkflow }
}

function buildExecutionInstructions(origin: RemotePlanOrigin): string {
	if (origin === "ferment") {
		return [
			"The user approved the following plan and wants it executed as a ferment.",
			"Start a ferment with this plan and execute it — scope it using the plan's structure (goal, constraints, chunks), activate the first phase, and work through every step.",
			"The plan text below follows the shared plan format with ## Goal, ## Constraints, and ## Chunks sections.",
		].join(" ")
	}
	return "The user approved the following plan. Execute it now — work through every chunk and verify your work."
}

/**
 * Condensed handoff note for a fresh remote session.
 *
 * Unlike teleport's `buildHandoffNote()` (which annotates an existing
 * session JSONL), this is part of the prompt text itself — the remote
 * agent is a fresh session with no conversation history.
 */
function buildHandoffNote(): string {
	return [
		"",
		"[Remote execution] You are running on a remote Linux sandbox.",
		"The repository was cloned from the local machine's git origin and uncommitted changes were synced to the sandbox.",
		"Verify tool availability with `command -v <tool>`. If tools are missing, install them using the devkit skill.",
	].join("\n")
}

/**
 * Steer prompt for the PR review loop: the user's review feedback plus the
 * commit-discipline reminder. The baseline was captured at dispatch — every
 * fix must land as a commit ON THE SAME branch to be visible to the
 * <baseSha>...HEAD diff; pushing stays the harness's job (after review).
 */
export function buildRemoteSteerPrompt(opts: { feedback: string; gitWorkflow?: RemoteGitWorkflow }): string {
	const branch = opts.gitWorkflow?.branch
	const reminder = branch
		? [
				`You previously worked on branch \`${branch}\` of the cloned repository in this same session. Stay on it — do NOT create or switch branches (verify with \`git branch --show-current\`).`,
				"Commit every change you make on that same branch (git add + git commit) — the harness diffs the captured baseline...HEAD and pushes after user review; work that isn't committed is invisible to the review loop.",
				"Do NOT push, create pull requests, or run destructive git commands (reset --hard, clean, rebase).",
			].join("\n")
		: "Commit your work so the results survive the session."
	return [
		"The user reviewed the diff of your previous work in this session and left feedback. Apply it directly now.",
		"",
		opts.feedback.trim(),
		"",
		`[Commit discipline] ${reminder}`,
	].join("\n")
}
