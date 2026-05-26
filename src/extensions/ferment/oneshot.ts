import type { Ferment } from "../../ferment/types.js"

/**
 * Build the one-shot envelope sent to the planner. Shared by the `/ferment one-shot`
 * slash command and the non-interactive `--ferment-oneshot` bench path so both
 * exercise the identical instruction set.
 */
export function buildOneshotNudge(ferment: Ferment, intent: string): string {
	return `You are running a one-shot ferment: "${ferment.name}" (ID: ${ferment.id}).

User intent: "${intent}"

Your task — execute ALL of the following steps WITHOUT pausing to ask the user:
1. Call scope_ferment with:
   - ferment_id: "${ferment.id}"
   - title: concise 3-5 word Ferment name derived from the task
   - goal: derived from the user intent
   - success_criteria: what observable outcome proves the goal
   - constraints: any technical constraints implied by the intent
   - phases: the smallest useful ordered plan, usually 2–4 phases with 1–3 concrete steps each
   - every step must include a specific verify bash command when the task allows it
2. For each phase in order: call activate_ferment_phase, then refine_ferment_phase (if steps not pre-set), then for each step: start_ferment_step → (delegate to Agent worker) → complete_ferment_step
3. Only mark a step complete after its implementation and verification have been attempted, and include verification results in the completion summary
4. When all phases are done and the final relevant verification passes or the remaining blocker is explicit: call complete_ferment

CRITICAL: Do NOT ask for confirmation, do not narrate progress to the user, and do not create extra process work. Scope from the provided task, delegate implementation to workers, verify with the cheapest task-relevant commands, and execute autonomously until complete_ferment is called. After complete_ferment returns, produce one concise final assistant message with no tool calls.

Only the ferment lifecycle tools for this existing ferment, "Agent", "get_subagent_result", "read", and metadata-only "set_phase" are available — launch an Agent for any implementation or verification work. Do not start another ferment in this one-shot run. Use get_subagent_result to collect background Agent results. There is no shell CLI for ferment phase or step transitions; use the ferment tools directly.`
}
