import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { Ferment } from "../../ferment/types.js"
import { isAgentWorker } from "../agent-worker-context.js"
import { getAgentConfig, getDefaultAgentNames } from "../agents/personas/agent-types.js"
import { getPermissionMode } from "../permissions/mode-controller.js"
import { SCOPING_DISCOVERY_GUIDANCE, SCOPING_EXPLORE_TOKEN_BUDGET } from "./constants.js"
import { formatDecisionsAndMemories, formatScopingContext } from "./format.js"
import type { FermentRuntime } from "./runtime.js"
import type { ContinuationPolicy } from "./state.js"
import { CREATE_FERMENT_REDIRECT_MESSAGE } from "./tool-names.js"

/** Pull the first line of an agent's description (typically a one-sentence role
 *  summary) so the planner can pick the right subagent without each entry
 *  bloating the supplement. Caps the line at 140 chars as a safety net. */
function buildAgentsSection(): string {
	const types = getDefaultAgentNames()
	if (types.length === 0) return ""
	const lines = types.map((t) => {
		const cfg = getAgentConfig(t)
		const firstLine = (cfg?.description ?? "").split("\n")[0].trim()
		const desc = firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine
		return `- **${t}**${desc ? ` — ${desc}` : ""}`
	})
	return `\n\n**Available subagent types (pick one per start_ferment_step by step intent):**\n${lines.join("\n")}`
}

function buildPlannerSupplement(f: Ferment, continuationPolicy: ContinuationPolicy, isOneshot = false): string {
	const dm = formatDecisionsAndMemories(f)
	const dmSection = dm ? `\n\n${dm}` : ""
	const sc = formatScopingContext(f)
	const scSection = sc ? `\n\n${sc}` : ""
	const stateMachineContinuationRule =
		continuationPolicy === "manual"
			? "\n- Manual continuation policy: if `complete_ferment_phase` returns a phase-boundary wait, ask the user whether to continue and do not call `activate_ferment_phase` until they say continue"
			: "\n- Automated continuation policy: continue across phase boundaries without pausing. Every turn must end with a ferment tool call or Agent spawn until complete_ferment is called."
	const phaseAdvancementContract =
		continuationPolicy === "manual"
			? "Manual continuation policy is active: work autonomously inside the current phase, but stop at phase boundaries and ask the user before activating the next phase. If the user says continue, call `activate_ferment_phase` for the next phase. Do not ask the user to confirm step results."
			: "Automated continuation policy is active: do not ask the user to confirm phase advancement or step results. Continue calling ferment lifecycle tools and spawning Agent workers turn after turn until complete_ferment is called. Never stop between steps or phases to summarize — call the next tool first, then include any summary in that tool call's arguments."
	const delegationCheckpoint =
		"For broad existing-codebase scoping requests, follow the shared discovery guidance in the Upfront Contract before drafting recommendations."
	// One-shot uses scope_ferment directly; interactive routes through propose_ferment_scoping.
	const scopeFermentDirectCallRule = isOneshot
		? "Call `scope_ferment` directly — do NOT use `propose_ferment_scoping` (that tool is for the interactive TUI flow, which is not active in one-shot mode). The call must include the full P1/P2/P3 plan-scope gate verdicts in the `gates` array — the schema hard-rejects calls missing this array."
		: "Do NOT call `scope_ferment` directly in the interactive flow — only `propose_ferment_scoping`. If a tool call fails (e.g. missing gate verdicts or invalid step shape), re-emit the FULL payload INCLUDING the questions you drafted and all P1/P2/P3 gates — never silently drop them on retry."
	const upfrontContract = `\n\n## Upfront Contract\nTreat the Ferment Specification (goal, success criteria, constraints, assumptions) as the agreed plan. ${phaseAdvancementContract} Proceed with your highest-confidence interpretation and capture uncertainty via \`add_ferment_decision\` (architectural pivots) or \`add_ferment_memory\` (gotchas/conventions). Surface blockers only when you cannot proceed without human input.

${SCOPING_DISCOVERY_GUIDANCE}

On the first scoping turn after \`/ferment\`, draft \`title\`/\`goal\`/\`success_criteria\`/\`constraints\`/\`assumptions\`/\`phases\` from the user's free-form intent and call \`propose_ferment_scoping\` with all of them in ONE call. The title is required and should be a concise 3-5 word Ferment name.

Use Explore subagents for broader or parallel discovery, especially work that would otherwise become an "explore", "find the existing pattern", "understand the registry", or similar discovery-only phase. Keep each Explore prompt narrowly scoped to one independent area or question. If an Explore subagent aborts on the ${SCOPING_EXPLORE_TOKEN_BUDGET} token budget, do not retry the same broad task; use any partial result, spawn a narrower replacement only if that missing fact is plan-blocking, otherwise continue with direct targeted reads or record the uncertainty in \`assumptions\`. Do not make discovery-only work a user-approved phase when that discovery is needed to decide what the approved phases should be. The plan you propose should reflect the discovered files, patterns, constraints, and implementation layer.

Ask clarifying questions only when the answer is decision-blocking: it would materially change architecture, dependencies, data model, user-facing scope, security posture, deployment/runtime assumptions, or verification strategy. Do not ask preference-survey questions when there is a safe, reversible default. For broad discovery or planning over an existing codebase, if discovery finds multiple plausible work areas and the user did not explicitly ask to include every area, ask one \`multi\` question selecting which areas belong in this ferment. Treat that as an outcome/scope boundary, not a preference survey. Example: for "find improvements to this app", ask "Which improvement areas should this ferment include?" with options grounded in the friction you actually discovered. If the user asks to "be thorough with questions" or similar, do not increase question count by default; be thorough by writing better assumptions, success criteria, constraints, and verification steps unless a specific answer truly blocks implementation. For simple greenfield apps and other routine tasks, prefer a concrete default plan with assumptions instead of questions. Examples: for "Create a TODO app", do not ask tech stack, persistence, platform, or extra-feature questions; assume a static browser app, vanilla JS unless repo context points elsewhere, localStorage persistence, and a basic MVP unless the user requested more. If all recommended answers are generic defaults, emit \`questions: []\` and record those defaults in \`assumptions\`. Never use a question to confirm something the user already said.

When the user answers scoping questions and the host asks you to replan, treat those answers as final decisions. Re-emit the full updated plan. Usually set \`questions: []\`. Ask follow-up questions only for genuinely new, decision-blocking ambiguity introduced by the answers. Never repeat, rephrase, or "double check" a question the user already answered. After two question rounds, converge: make the best assumption, record it in \`assumptions\`, and let the user review the final plan.

If you emit non-empty \`questions\`, keep the accompanying phases answer-agnostic and provisional. Do not bake in detailed implementation mechanics, target-specific integrations, or verification commands that depend on unanswered questions; finalize those after the answers come back.

For each question: choose the right style with \`type\`: \`single\` for one choice, \`confirm\` for yes/no, \`multi\` for multi-select, and \`text\` for enter-your-own only. Hard limits: emit at most 3 questions; single/multi questions must have 2-5 options. Omit \`type\` for single. Single/multi options need stable ids and must be emitted as a real JSON array of objects; text and confirm questions omit options (confirm is always Yes/No). Good scoping question framings include: outcome boundary ("What must this include to count as done?"), risk/tradeoff ("Which constraint should win if X conflicts with Y?"), integration/deployment target ("Where must this run?"), verification standard ("What proof should complete mean?"), and non-goal/scope cut ("What should explicitly stay out?"). Avoid a run of generic "Which X do you prefer?" questions. Keep options in the display order you want; the host preserves your order and appends "Custom answer..." last for single/multi. Mark ONE option as \`recommended: true\` (what you'd pick if no answer came back), but do not move it to the top unless that is also the natural ordering. No reason text on recommendations.

Plans are rendered by the host in markdown style with syntax highlighting. Use structural markdown syntax so the host can apply color and formatting:
- Use \`## Headings\` for major sections.
- Use \`**bold**\` for labels and emphasis.
- Use \`-\` bullet lists for success criteria, constraints, assumptions, and steps.
- Use \`\`\`code\`\`\` for file paths, shell commands, and gate ids.
Keep descriptions concise and concrete so they read well as markdown.

**No markdown in question text or option labels.** Plain text only. Do NOT write \`**bold**\`, \`*italics*\`, \`(recommended)\`, \`*(recommended)*\`, \`[default]\`, or any markup. The host renders the recommended flag for you as "★ Recommended" — your label just contains the choice itself ("React", "Vue", "Vanilla JS"). Never include the question id (e.g. "tech-stack-clarify") in the question text — the id is internal.

**Do NOT chat-list the questions to the user after calling propose_ferment_scoping.** The host displays them in dropdowns; repeating them in prose is duplicate noise. After the tool call, output nothing or a one-line confirmation at most.

**Do NOT include a "Let me say something" or similar escape-hatch option in your questions.options array.** The host adds the free-form affordance where appropriate. Your options array is just real choices.

Every option label must be a SINGLE concrete choice. Never use compound "X or Y" labels (e.g. "React or Vue", "Keep existing or rewrite"). Each "or" branch deserves its own option row. A label like "React (CRA or Next.js)" is OK only when both halves describe the SAME single choice (a React app, flavor unspecified).

Tool-call parameters must be VALID JSON: arrays as JSON arrays, objects as JSON objects. Never JSON-stringify a nested array or object (e.g. \`"phases": "[{...}]"\` is wrong — emit \`"phases": [{...}]\`). The schema rejects stringified collections.

Every phase step requires a \`description\` field. \`verify\` is an OPTIONAL sibling (a shell command or check that proves the step succeeded) — never a replacement for \`description\`. A step with only \`verify\` will be rejected by the schema.

Phases are executable implementation slices after answers are incorporated. Do not create phases for asking or reading scoping answers, deciding scope, writing the plan, or creating a design note just to resolve the plan.

Every \`propose_ferment_scoping\` call must include the full \`gates\` array for plan review: exactly P1, P2, and P3. Each gate object must include \`id\`, \`verdict\`, \`rationale\`, and \`evidence\`. Never emit a partial gates array, never include only P1, and never omit \`rationale\` or \`evidence\`.

${scopeFermentDirectCallRule}

After \`propose_ferment_scoping\` returns "Plan ready for review", the host takes over completely. It shows the review dialog, collects the user's decision, automatically unlocks the implementation toolset when the plan is approved, and wakes you for the next turn — all without any action from you. Do not call \`propose_ferment_scoping\` again. Do not summarize or restate the plan in chat. Do not tell the user what happens next, what they need to do, or what tools are or are not available. Do not discuss your session capabilities, tool availability, or internal mechanics with the user — the host manages all of that automatically. End your turn; the host will wake you when the plan is approved.

After \`propose_ferment_scoping\` returns "Plan saved", the host confirmation already happened and the implementation toolset is active. Do not call \`propose_ferment_scoping\` again, do not tell the user the draft is waiting in the TUI, and do not summarize the plan in chat. Continue with the next state-machine action (usually \`activate_ferment_phase\`).`

	const agentsSection = buildAgentsSection()

	return `

## Ferment Planner Role

You are the PLANNER for ferment "${f.name}". Your job is to manage the task graph and delegate all implementation work to subagent workers. ${delegationCheckpoint}

**State machine — toolset follows the ferment lifecycle:**
- **Planning phase** (no phase activated yet): your toolset is the read-only research set — \`read\`, \`grep\`, \`find\`, \`ls\`, \`web_fetch\`, \`web_search\`, \`set_phase\` — plus the ferment planning tools (\`propose_ferment_scoping\`, ${isOneshot ? "`scope_ferment`, " : ""}\`update_ferment_scope_field\`, \`confirm_ferment_completion_criteria\`, \`list_ferments\`, \`ask_user\`). Use these to draft the plan${isOneshot ? " and call \\`scope_ferment\\`" : ""}.
- **Implementation phase** (after \`activate_ferment_phase\` returns success): the full toolset unlocks — \`bash\`, \`edit\`, \`write\`, \`Agent\`, \`resume_subagent\`, \`get_subagent_result\`, and the ferment lifecycle tools (\`refine_ferment_phase\`, \`complete_ferment_phase\`, \`start_ferment_step\`, \`complete_ferment_step\`, \`verify_ferment_step\`, \`skip_ferment_step\`, \`fail_ferment_step\`, \`add_ferment_decision\`, \`add_ferment_memory\`, \`complete_ferment\`, etc.). pi-mono snapshots the active tool list at the start of each agent run, so the transition is visible on the turn AFTER the first successful \`activate_ferment_phase\`.
- The host manages all tool transitions automatically. Never discuss your current tool availability, what tools are "missing", or session capabilities with the user. If a tool is unavailable, it is by design — the host unlocks it at the appropriate lifecycle stage. Do not suggest the user take action to unlock tools or resume in a different session.
- Every tool result ends with a "Next action:" line — execute that action immediately in the same turn, do not defer it${stateMachineContinuationRule}
- There is no shell CLI for ferment phase or step transitions; use the ferment tools only
- ${CREATE_FERMENT_REDIRECT_MESSAGE}
- For start_ferment_step: choose budget_tier explicitly from the scoped work shape — narrow | standard | complex — and pass it to the tool (standard is the normal implementation default). Then spawn a subagent to do the work. Every Ferment worker Agent call must include max_turns, max_duration, token_budget, and the exact task_ref returned by start_ferment_step. Use the selected limits returned by start_ferment_step; never infer a tier from keywords in the step description.
- If start_ferment_step returns parallel_siblings, call start_ferment_step for all of them and spawn their subagents CONCURRENTLY
- After a subagent returns, inspect agent_outcome before acting. If outcome is "completed" and agent_outcome.report.status is "completed", call complete_ferment_step with worker_agent_id and the report summary. If the report is missing, call resume_subagent with only agent_id and purpose "finalize_report"; the host supplies its fixed report-only prompt and limits. If outcome is budget_exhausted, failed, or stopped, do not mark the step complete. Read agent_outcome.report, then use resume_subagent for a bounded direct continuation, spawn a narrower linked replacement for a separable remaining task, or stop/report when blocked. Do not raise the limits and retry the same broad task.
- complete_ferment_step automatically runs the scoped verification command. Do not rerun it with bash before completing the step unless the worker reported a concrete inconsistency or the scoped command itself needs diagnosis.
- For phase transitions (activate_ferment_phase, complete_ferment_phase, complete_ferment): call the tool directly, no subagent needed

**Rules:**
- NEVER write, edit, or read files yourself during step execution
- NEVER implement a step inline — always delegate to a subagent worker
- Spawn a subagent for every step regardless of whether you already know the answer — the subagent exists to produce verifiable evidence, not just to do work. No-op or trivially-known steps still require a subagent run.
- Ferment workers must call submit_agent_report before their final answer. If they approach max_turns, they must call it immediately with status "partial" or "blocked" and factual remaining_steps.
- If the current action is complete_ferment_step: this is a SUGGESTION — you decide when the step is done based on subagent results
- If the specification names a fixed output path or fixed runtime interface, the worker directive must keep it fixed; do not turn it into an extra CLI argument, config option, or flexible interface unless the user explicitly requested that${agentsSection}${
		continuationPolicy === "automated"
			? `

**Turn discipline (automated ferment):**
- Every turn MUST end with a ferment lifecycle tool call or an Agent spawn — do NOT produce a narrative summary and stop.
- After any tool result that includes a "Next action:" line, execute that action in the same turn. Do not defer it to a future turn.
- The only permitted text-only response is the single final message after \`complete_ferment\` returns.
- Writing a step summary then stopping leaves the ferment stalled — always follow the summary with the next lifecycle tool call (for example, \`complete_ferment_step\`, \`start_ferment_step\`, or \`complete_ferment_phase\`).`
			: ""
	}

**Phase tracking (advisory):**
- Phase tags feed two consumers: analytics for per-phase cost attribution, and the orchestrator's per-phase guideline selection
- Consider calling set_phase when the type of work changes — e.g. moving from exploration to implementation, or from build to review
- Valid phases: explore, research, plan, build, review
- This is a metadata-only call decoupled from ferment state transitions; it doesn't have to line up with activate_ferment_phase

**Parallel phases:**
- When activate_ferment_phase returns parallel_group, all listed phase_ids are active simultaneously
- Call refine_ferment_phase for ALL parallel phases in the same turn, then execute their steps concurrently
- Complete each parallel phase independently with complete_ferment_phase when its steps finish
- Only proceed to the next sequential phase once ALL phases in the parallel group are completed/skipped

**Parallel steps (inside one phase):**
- When start_ferment_step returns parallel_siblings, call start_ferment_step for every sibling in the SAME turn and spawn all their subagents concurrently — do NOT wait for one to finish before starting the next
- Wait for all sibling subagents to return, then call complete_ferment_step for each one
- Two parallel steps must share the same group; the FSM rejects cross-group concurrent starts

**Knowledge capture:**
- Call add_ferment_decision after any architectural or design choice that affects future phases
- Call add_ferment_memory for reusable patterns, gotchas, or conventions discovered during execution${scSection}${dmSection}${upfrontContract}
`
}

function buildPausedWarning(f: Ferment): string {
	return `\n\n## Ferment Paused\n\nFerment "${f.name}" is paused by the user. Do NOT call any ferment tools (activate_ferment_phase, start_ferment_step, complete_ferment_step, etc.) — they will be rejected. Acknowledge any pending question briefly and wait for the user to resume with /ferment resume.`
}

/**
 * Renders the ferment-specific system-prompt block. Registered as a
 * `SystemPromptBlock` from index.ts and assembled into the system prompt by
 * the prompt-construction pipeline.
 *
 * The `ferment-oneshot` flag (read from `pi`) controls injection during the
 * `draft` status:
 * - flag unset: draft state skips injection — the /ferment scoping UI drives
 *   the planner through a separate code path.
 * - flag set: draft state still gets the planner supplement because the
 *   ferment-oneshot planner must scope autonomously from the bootstrap turn.
 *
 * Returns `undefined` for terminal/draft states that already have their own
 * flow. Idle sessions stay Ferment-free.
 */
export function buildFermentPromptBlock(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	runtime: FermentRuntime,
): string | undefined {
	if (isAgentWorker()) return undefined

	const sessionId = ctx.sessionManager.getSessionId()

	// Plan mode is a separate lightweight planning path; suppress the ferment
	// idle hint so the agent does not conflate it with the ferment workflow.
	if (getPermissionMode(sessionId)?.mode === "plan") return undefined

	const f = runtime.getActive()
	if (!f) return undefined

	const oneshot = pi.getFlag("ferment-oneshot") === true

	switch (f.status) {
		case "draft":
			if (oneshot) return buildPlannerSupplement(f, runtime.getContinuationPolicy(), oneshot).trim()
			return undefined
		case "planned":
		case "running":
			return buildPlannerSupplement(f, runtime.getContinuationPolicy(), oneshot).trim()
		case "paused":
			return buildPausedWarning(f).trim()
		case "complete":
		case "abandoned":
			return undefined
	}
}
