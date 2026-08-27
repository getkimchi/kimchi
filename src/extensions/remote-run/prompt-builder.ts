/**
 * Prompt builder for remote plan execution.
 *
 * Constructs the prompt sent to the remote agent when the user picks
 * "Start execution in cloud" from either the plan-mode or ferment review
 * dialog. The prompt includes:
 *
 * 1. Origin-specific instructions (plain execution vs ferment execution)
 * 2. A condensed environment handoff note (informs the agent it's on a
 *    remote Linux sandbox, repo was cloned, changes synced, devkit for
 *    missing tools — inspired by teleport's `buildHandoffNote()`)
 * 3. The approved plan text (inlined — the local plan file path is not
 *    referenced because it doesn't exist on the remote sandbox)
 */

export type RemotePlanOrigin = "plan-mode" | "ferment"

export interface RemotePlanPromptOptions {
	/** The origin of the plan — determines execution instructions. */
	origin: RemotePlanOrigin
}

/** Builds the prompt string for remote plan execution. */
export function buildRemotePlanPrompt(planText: string, opts: RemotePlanPromptOptions): string {
	const { origin } = opts

	const executionInstructions = buildExecutionInstructions(origin)
	const handoffNote = buildHandoffNote()

	return [executionInstructions, handoffNote, "", "---", "", planText].join("\n")
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
