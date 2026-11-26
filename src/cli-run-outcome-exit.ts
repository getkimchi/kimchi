import {
	formatRunOutcomeDiagnostic,
	KIMCHI_NO_PROMPT_EXIT_CODE,
	KIMCHI_NO_RESULT_EXIT_CODE,
	type RunOutcomeClassification,
} from "./run-outcome.js"

/**
 * Post-main exit handling for silent non-interactive runs. A nonzero exit code
 * already means the run failed loudly (model error, infrastructure), so only an
 * unset or zero code is replaced.
 */
export function applyPostMainRunOutcomeExitPolicy(outcome: RunOutcomeClassification): boolean {
	if (outcome.kind === "ok") return false
	if (Number(process.exitCode ?? 0) !== 0) return false
	// A nonzero above already carried the native failure and diagnostic. Supply
	// both when trailing state prevented pi's assistant-specific branch.
	if (outcome.kind === "failed") {
		console.error(outcome.diagnostic)
		process.exitCode = 1
		return true
	}
	console.error(formatRunOutcomeDiagnostic(outcome))
	process.exitCode = outcome.kind === "no-prompt" ? KIMCHI_NO_PROMPT_EXIT_CODE : KIMCHI_NO_RESULT_EXIT_CODE
	return true
}
