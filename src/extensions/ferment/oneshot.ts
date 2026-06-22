import type { Ferment } from "../../ferment/types.js"

/**
 * Build the one-shot envelope sent to the planner. Shared by the `/ferment one-shot`
 * slash command and the non-interactive `--ferment-oneshot` bench path so both
 * exercise the identical instruction set.
 */
export function buildOneshotNudge(ferment: Ferment, intent: string): string {
	return `You are running a one-shot ferment: "${ferment.name}" (ID: ${ferment.id}).

User intent: "${intent}"

## Your job

Execute ALL of the following steps in order WITHOUT pausing to ask the user, read files, or orient yourself first. Call scope_ferment as your VERY FIRST tool call on this turn.

1. **Call scope_ferment immediately** (ferment_id: "${ferment.id}") with:
   - title: concise 3-5 word name derived from the task
   - goal: what the task asks for, in one sentence
   - success_criteria: observable, verifiable outcomes
   - constraints: technical constraints implied by the intent
   - phases: the smallest useful ordered plan — usually 1–3 phases with 1–4 steps each; every step must have a description and, where possible, a verify bash command
   - gates: exactly P1, P2, P3 — each with id, verdict, rationale, evidence. The schema hard-rejects calls missing this array.

2. **For each phase**, call activate_ferment_phase, then for each step:
   - call start_ferment_step
   - spawn an Agent worker with explicit max_turns and max_duration — always set both. Calibrate to step complexity: simple edits 20–30 turns / 300s, typical implementation steps 40–60 turns / 600s, heavy compilation or iterative debugging up to 80 turns / 900s. If a worker exhausts its budget, call complete_ferment_step with what it produced, then spawn a scoped follow-up for remaining work.
   - call complete_ferment_step with the worker's results

3. **When all phases are done**, call complete_ferment.

## Turn discipline

Every turn MUST end with a ferment lifecycle tool call or an Agent spawn. Do not produce a summary and stop — that leaves the ferment stalled. The only permitted text-only turn is the single final message after complete_ferment returns.

## Toolset

Toolset follows the ferment lifecycle:
- During the planning phase (before the first successful \`activate_ferment_phase\`), only read-only research tools and the ferment planning tools are available: \`read\`, \`grep\`, \`find\`, \`ls\`, \`web_fetch\`, \`web_search\`, \`set_phase\`, plus \`scope_ferment\`, \`update_ferment_scope_field\`, \`confirm_ferment_completion_criteria\`, \`list_ferments\`, \`ask_user\`. Use these to draft the plan.
- Once \`activate_ferment_phase\` returns success, the implementation toolset unlocks on the NEXT model turn: \`bash\`, \`edit\`, \`write\`, \`Agent\`, \`get_subagent_result\`, and the remaining ferment lifecycle tools (\`refine_ferment_phase\`, \`complete_ferment_phase\`, \`start_ferment_step\`, \`complete_ferment_step\`, \`verify_ferment_step\`, etc.). Launch an \`Agent\` worker for any implementation or verification work — workers keep their full toolset regardless of the planner profile.
- Do not start another ferment in this one-shot run. Use \`get_subagent_result\` to collect background Agent results. There is no shell CLI for ferment phase or step transitions; use the ferment tools directly.`
}
