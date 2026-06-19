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
   - gates: full plan-scope gate verdicts — exactly P1 (verifiable success signals per phase), P2 (phase ordering), P3 (complete_ferment checklist). Each gate: {id, verdict: "pass", rationale, evidence}. The schema hard-rejects scope_ferment calls missing this array, so include it on the first attempt.
2. For each phase in order: call activate_ferment_phase, then refine_ferment_phase (if steps not pre-set), then for each step: start_ferment_step → (delegate to Agent worker) → complete_ferment_step
3. Only mark a step complete after its implementation and verification have been attempted, and include verification results in the completion summary
4. When all phases are done and the final relevant verification passes or the remaining blocker is explicit: call complete_ferment

CRITICAL: Do NOT ask for confirmation, do not narrate progress to the user, and do not create extra process work. Scope from the provided task, delegate implementation to workers, verify with the cheapest task-relevant commands, and execute autonomously until complete_ferment is called. After complete_ferment returns, produce one concise final assistant message with no tool calls.

Toolset follows the ferment lifecycle:
- During the planning phase (before the first successful \`activate_ferment_phase\`), only read-only research tools and the ferment planning tools are available: \`read\`, \`grep\`, \`find\`, \`ls\`, \`web_fetch\`, \`web_search\`, \`set_phase\`, plus \`scope_ferment\`, \`update_ferment_scope_field\`, \`confirm_ferment_completion_criteria\`, \`list_ferments\`, \`ask_user\`. Use these to draft the plan.
- Once \`activate_ferment_phase\` returns success (typically the first call in step 2 of the task list above), the implementation toolset unlocks on the NEXT model turn: \`bash\`, \`edit\`, \`write\`, \`Agent\`, \`get_subagent_result\`, and the remaining ferment lifecycle tools (\`refine_ferment_phase\`, \`complete_ferment_phase\`, \`start_ferment_step\`, \`complete_ferment_step\`, \`verify_ferment_step\`, etc.). Launch an \`Agent\` worker for any implementation or verification work — workers keep their full toolset regardless of the planner profile.
- Do not start another ferment in this one-shot run. Use \`get_subagent_result\` to collect background Agent results. There is no shell CLI for ferment phase or step transitions; use the ferment tools directly.`
}
