import type { Ferment } from "../../ferment/types.js"
import { SHARED_PLANNING_PROCESS } from "../../shared/planning/shared-planning-process.js"

/**
 * Build the one-shot envelope sent to the planner. Shared by the `/ferment one-shot`
 * slash command and the non-interactive `--ferment-oneshot` bench path so both
 * exercise the identical instruction set.
 */
export function buildOneshotNudge(ferment: Ferment, intent: string): string {
	return `You are running a one-shot ferment: "${ferment.name}" (ID: ${ferment.id}).

User intent: "${intent}"

## Your job

Follow the shared planning process below. The only differences from interactive ferment scoping are:
- **Interview**: call \`ask_user\` as normal — questions are automatically routed to a judge that stands in for the user. You do not need to do anything special.
- **Completion Criteria**: \`confirm_ferment_completion_criteria\` is not available in one-shot mode. Draft criteria from the intent and include them directly in \`scope_ferment.success_criteria\`.
- Then call \`scope_ferment\` with the complete plan.

${SHARED_PLANNING_PROCESS}

## One-shot execution

1. **Call scope_ferment** (ferment_id: "${ferment.id}") with:
   - title: concise 3-5 word name derived from the task
   - goal: what the task asks for, in one sentence
   - success_criteria: observable, verifiable outcomes
   - constraints: technical constraints implied by the intent
   - phases: the smallest useful ordered plan — usually 1–3 phases with 1–4 steps each; every step must have a description and, where possible, a verify bash command
   - gates: exactly P1, P2, P3 — each with id, verdict, rationale, evidence. The schema hard-rejects calls missing this array.

2. **For each phase**, call activate_ferment_phase, then for each step:
   - call start_ferment_step with an explicit budget_tier chosen from the scoped work shape: narrow, standard (normal implementation default), or complex
   - spawn an Agent worker with the exact task_ref returned by start_ferment_step and explicit max_turns, max_duration, and token_budget — always set all three to the selected limits returned by the tool
   - require the worker to call submit_agent_report before its final answer
   - inspect agent_outcome when the worker returns. Call complete_ferment_step with worker_agent_id and the report summary only when outcome is "completed" and report.status is "completed"
   - if the worker exhausts its budget, fails, or stops, do not mark the step complete. Inspect its report, then use resume_subagent for a bounded direct continuation, spawn a narrower linked replacement for separable remaining work, or stop/report when blocked. Do not raise the limits and retry the same broad task

3. **When all phases are done**, call complete_ferment.

## Turn discipline

Every turn MUST end with a ferment lifecycle tool call or an Agent spawn. Do not produce a summary and stop — that leaves the ferment stalled. The only permitted text-only turn is the single final message after complete_ferment returns.

## Toolset

Toolset follows the ferment lifecycle:
- During the planning phase (before the first successful \`activate_ferment_phase\`), only read-only research tools and the ferment planning tools are available: \`read\`, \`grep\`, \`find\`, \`ls\`, \`web_fetch\`, \`web_search\`, \`set_phase\`, plus \`scope_ferment\`, \`update_ferment_scope_field\`, \`confirm_ferment_completion_criteria\`, \`list_ferments\`, \`ask_user\`. Use these to draft the plan.
- Once \`activate_ferment_phase\` returns success, the implementation toolset unlocks on the NEXT model turn: \`bash\`, \`edit\`, \`write\`, \`Agent\`, \`resume_subagent\`, \`get_subagent_result\`, and the remaining ferment lifecycle tools (\`refine_ferment_phase\`, \`complete_ferment_phase\`, \`start_ferment_step\`, \`complete_ferment_step\`, \`verify_ferment_step\`, etc.). Launch an \`Agent\` worker for any implementation or verification work — workers keep their full toolset regardless of the planner profile.
- Do not start another ferment in this one-shot run. Use \`get_subagent_result\` to collect background Agent results. There is no shell CLI for ferment phase or step transitions; use the ferment tools directly.`
}
