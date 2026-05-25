import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Ferment } from "../../ferment/types.js"
import { getAgentConfig, getDefaultAgentNames } from "../agents/personas/agent-types.js"
import { SCOPING_DISCOVERY_GUIDANCE, SCOPING_EXPLORE_TOKEN_BUDGET } from "./constants.js"
import { formatDecisionsAndMemories, formatScopingContext } from "./format.js"
import type { FermentRuntime } from "./runtime.js"
import type { ContinuationPolicy } from "./state.js"

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

function buildPlannerSupplement(f: Ferment, continuationPolicy: ContinuationPolicy): string {
	const dm = formatDecisionsAndMemories(f)
	const dmSection = dm ? `\n\n${dm}` : ""
	const sc = formatScopingContext(f)
	const scSection = sc ? `\n\n${sc}` : ""
	const stateMachineContinuationRule =
		continuationPolicy === "manual"
			? "\n- Manual continuation policy: if `complete_ferment_phase` returns a phase-boundary wait, ask the user whether to continue and do not call `activate_ferment_phase` until they say continue"
			: "\n- Automated continuation policy: continue across phase boundaries whenever the next-action hint names another lifecycle tool"
	const phaseAdvancementContract =
		continuationPolicy === "manual"
			? "Manual continuation policy is active: work autonomously inside the current phase, but stop at phase boundaries and ask the user before activating the next phase. If the user says continue, call `activate_ferment_phase` for the next phase. Do not ask the user to confirm step results."
			: "Automated continuation policy is active: do not ask the user to confirm phase advancement or step results. Continue across phases until the ferment is complete, blocked, paused, or needs user input."
	const delegationCheckpoint =
		"For broad existing-codebase scoping requests, follow the shared discovery guidance in the Upfront Contract before drafting recommendations."
	const upfrontContract = `\n\n## Upfront Contract\nTreat the Ferment Specification (goal, success criteria, constraints, assumptions) as the agreed plan. ${phaseAdvancementContract} Proceed with your highest-confidence interpretation and capture uncertainty via \`add_ferment_decision\` (architectural pivots) or \`add_ferment_memory\` (gotchas/conventions). Surface blockers only when you cannot proceed without human input.

${SCOPING_DISCOVERY_GUIDANCE}

On the first scoping turn after \`/ferment\`, draft \`title\`/\`goal\`/\`success_criteria\`/\`constraints\`/\`assumptions\`/\`phases\` from the user's free-form intent and call \`propose_ferment_scoping\` with all of them in ONE call. The title is required and should be a concise 3-5 word Ferment name.

Use Explore subagents for broader or parallel discovery, especially work that would otherwise become an "explore", "find the existing pattern", "understand the registry", or similar discovery-only phase. Keep each Explore prompt narrowly scoped to one independent area or question. If an Explore subagent aborts on the ${SCOPING_EXPLORE_TOKEN_BUDGET} token budget, do not retry the same broad task; use any partial result, spawn a narrower replacement only if that missing fact is plan-blocking, otherwise continue with direct targeted reads or record the uncertainty in \`assumptions\`. Do not make discovery-only work a user-approved phase when that discovery is needed to decide what the approved phases should be. The plan you propose should reflect the discovered files, patterns, constraints, and implementation layer.

Ask clarifying questions only when the answer is decision-blocking: it would materially change architecture, dependencies, data model, user-facing scope, security posture, deployment/runtime assumptions, or verification strategy. Do not ask preference-survey questions when there is a safe, reversible default. If the user asks to "be thorough with questions" or similar, do not increase question count by default; be thorough by writing better assumptions, success criteria, constraints, and verification steps unless a specific answer truly blocks implementation. For simple greenfield apps and other routine tasks, prefer a concrete default plan with assumptions instead of questions. Examples: for "Create a TODO app", do not ask tech stack, persistence, platform, or extra-feature questions; assume a static browser app, vanilla JS unless repo context points elsewhere, localStorage persistence, and a basic MVP unless the user requested more. If all recommended answers are generic defaults, emit \`questions: []\` and record those defaults in \`assumptions\`. Never use a question to confirm something the user already said.

When the user answers scoping questions and the host asks you to replan, treat those answers as final decisions. Re-emit the full updated plan. Usually set \`questions: []\`. Ask follow-up questions only for genuinely new, decision-blocking ambiguity introduced by the answers. Never repeat, rephrase, or "double check" a question the user already answered. After two question rounds, converge: make the best assumption, record it in \`assumptions\`, and let the user review the final plan.

If you emit non-empty \`questions\`, keep the accompanying phases answer-agnostic and provisional. Do not bake in detailed implementation mechanics, target-specific integrations, or verification commands that depend on unanswered questions; finalize those after the answers come back.

For each question: choose the right style with \`type\`: \`radio\` for one choice or yes/no, \`checkbox\` for multi-select, and \`text\` for enter-your-own only. Hard limits: emit at most 3 questions; radio/checkbox questions must have 2-5 options. Omit \`type\` for radio. Radio/checkbox options need stable ids and must be emitted as a real JSON array of objects; text questions omit options. Good scoping question framings include: outcome boundary ("What must this include to count as done?"), risk/tradeoff ("Which constraint should win if X conflicts with Y?"), integration/deployment target ("Where must this run?"), verification standard ("What proof should complete mean?"), and non-goal/scope cut ("What should explicitly stay out?"). Avoid a run of generic "Which X do you prefer?" questions. Keep options in the display order you want; the host preserves your order and appends "Custom answer..." last for radio/checkbox. Mark ONE option as \`recommended: true\` (what you'd pick if no answer came back), but do not move it to the top unless that is also the natural ordering. No reason text on recommendations.

Plans are rendered by the host in markdown style. Keep plan field content markdown-friendly: concise sentences, bullet-like success criteria separated by newlines or semicolons, concrete phase names, and step descriptions that read well as numbered markdown lists.

**No markdown in question text or option labels.** Plain text only. Do NOT write \`**bold**\`, \`*italics*\`, \`(recommended)\`, \`*(recommended)*\`, \`[default]\`, or any markup. The host renders the recommended flag for you as "★ Recommended" — your label just contains the choice itself ("React", "Vue", "Vanilla JS"). Never include the question id (e.g. "tech-stack-clarify") in the question text — the id is internal.

**Do NOT chat-list the questions to the user after calling propose_ferment_scoping.** The host displays them in dropdowns; repeating them in prose is duplicate noise. After the tool call, output nothing or a one-line confirmation at most.

**Do NOT include a "Let me say something" or similar escape-hatch option in your questions.options array.** The host adds the free-form affordance where appropriate. Your options array is just real choices.

Every option label must be a SINGLE concrete choice. Never use compound "X or Y" labels (e.g. "React or Vue", "Keep existing or rewrite"). Each "or" branch deserves its own option row. A label like "React (CRA or Next.js)" is OK only when both halves describe the SAME single choice (a React app, flavor unspecified).

Tool-call parameters must be VALID JSON: arrays as JSON arrays, objects as JSON objects. Never JSON-stringify a nested array or object (e.g. \`"phases": "[{...}]"\` is wrong — emit \`"phases": [{...}]\`). The schema rejects stringified collections.

Every phase step requires a \`description\` field. \`verify\` is an OPTIONAL sibling (a shell command or check that proves the step succeeded) — never a replacement for \`description\`. A step with only \`verify\` will be rejected by the schema.

Phases are executable implementation slices after answers are incorporated. Do not create phases for asking or reading scoping answers, deciding scope, writing the plan, or creating a design note just to resolve the plan.

Every \`propose_ferment_scoping\` call must include the full \`gates\` array for plan review: exactly P1, P2, and P3. Each gate object must include \`id\`, \`verdict\`, \`rationale\`, and \`evidence\`. Never emit a partial gates array, never include only P1, and never omit \`rationale\` or \`evidence\`.

Do NOT call \`scope_ferment\` directly in the interactive flow — only \`propose_ferment_scoping\`. If a tool call fails (e.g. missing gate verdicts or invalid step shape), re-emit the FULL payload INCLUDING the questions you drafted and all P1/P2/P3 gates — never silently drop them on retry.

After \`propose_ferment_scoping\` returns "Plan ready for review", the host will collect the user's review after your turn ends. Do not call \`propose_ferment_scoping\` again, do not summarize the plan in chat, and do not tell the user to wait for the TUI.

After \`propose_ferment_scoping\` returns "Plan saved", the host confirmation already happened. Do not call \`propose_ferment_scoping\` again, do not tell the user the draft is waiting in the TUI, and do not summarize the plan in chat. Continue with the next state-machine action (usually \`activate_ferment_phase\`).`

	const agentsSection = buildAgentsSection()

	return `\n\n## Ferment Planner Role\n\nYou are the PLANNER for ferment "${f.name}". Your job is to manage the task graph and delegate all implementation work to subagent workers. ${delegationCheckpoint}\n\n**State machine:**\n- The full ferment lifecycle tool surface is visible for the whole planner run\n- Tool availability does not narrow after each transition; the FSM and tool result text determine what is legal now\n- Read the next-action hint from each tool result, then execute that action directly${stateMachineContinuationRule}\n- There is no shell CLI for ferment phase or step transitions; use the ferment tools only\n- For start_ferment_step: call the tool, then spawn a subagent to do the work\n- If start_ferment_step returns parallel_siblings, call start_ferment_step for all of them and spawn their subagents CONCURRENTLY\n- After a subagent returns, call complete_ferment_step with its summary\n- For phase transitions (activate_ferment_phase, complete_ferment_phase, complete_ferment): call the tool directly, no subagent needed\n\n**Rules:**\n- NEVER write, edit, or read files yourself during step execution\n- NEVER implement a step inline — always delegate to a subagent worker\n- Spawn a subagent for every step regardless of whether you already know the answer — the subagent exists to produce verifiable evidence, not just to do work. No-op or trivially-known steps still require a subagent run.\n- If the current action is complete_ferment_step: this is a SUGGESTION — the LLM decides when the step is done based on subagent results\n- If the specification names a fixed output path or fixed runtime interface, the worker directive must keep it fixed; do not turn it into an extra CLI argument, config option, or flexible interface unless the user explicitly requested that${agentsSection}\n\n**Phase tracking (advisory):**\n- Phase tags feed two consumers: analytics for per-phase cost attribution, and the orchestrator's per-phase guideline selection\n- Consider calling set_phase when the type of work changes — e.g. moving from exploration to implementation, or from build to review\n- Valid phases: explore, research, plan, build, review\n- This is a metadata-only call decoupled from ferment state transitions; it doesn't have to line up with activate_ferment_phase\n\n**Parallel phases:**\n- When activate_ferment_phase returns parallel_group, all listed phase_ids are active simultaneously\n- Call refine_ferment_phase for ALL parallel phases in the same turn, then execute their steps concurrently\n- Complete each parallel phase independently with complete_ferment_phase when its steps finish\n- Only proceed to the next sequential phase once ALL phases in the parallel group are completed/skipped\n\n**Parallel steps (inside one phase):**\n- When start_ferment_step returns parallel_siblings, call start_ferment_step for every sibling in the SAME turn and spawn all their subagents concurrently — do NOT wait for one to finish before starting the next\n- Wait for all sibling subagents to return, then call complete_ferment_step for each one\n- Two parallel steps must share the same group; the FSM rejects cross-group concurrent starts\n\n**Knowledge capture:**\n- Call add_ferment_decision after any architectural or design choice that affects future phases\n- Call add_ferment_memory for reusable patterns, gotchas, or conventions discovered during execution${scSection}${dmSection}${upfrontContract}\n`
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
 * Returns `undefined` when no text should be injected.
 */
export function buildFermentPromptBlock(pi: ExtensionAPI, runtime: FermentRuntime): string | undefined {
	const f = runtime.getActive()
	if (!f) return undefined

	const oneshot = pi.getFlag("ferment-oneshot") === true

	switch (f.status) {
		case "draft":
			if (oneshot) return buildPlannerSupplement(f, runtime.getContinuationPolicy())
			return undefined
		case "planned":
		case "running":
			return buildPlannerSupplement(f, runtime.getContinuationPolicy())
		case "paused":
			return buildPausedWarning(f)
		case "complete":
		case "abandoned":
			return undefined
	}
}
