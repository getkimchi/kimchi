/**
 * Orchestrator-mode prompt content for multi-model orchestration.
 *
 * Provides the orchestrator with:
 * - Team roster (Your team + Your roles) — which models fill which roles,
 *   rendered dynamically from the modelRoles config.
 * - Delegation guidance — how to think about when to delegate vs. implement
 *   directly, and how to process sub-agent results. No rigid pipeline or
 *   process prescription.
 * - Budget reference table and agent management rules.
 *
 * Model-specific behavior guidelines (e.g. minimax over-thinking) are injected
 * per-model via the guidelines resolver, not here.
 *
 * The subagent response protocol and single-model instructions live in
 * `prompt-construction/system-prompt.ts`.
 */

import { renderDelegationThinkingLevelTable, renderOrchestratorThinkingTable } from "../agents/thinking-level-policy.js"
import { renderAgentWorkerBudgetTable } from "../agents/worker-budget-policy.js"
import type { ModelCustomMetadata } from "./model-metadata.js"
import { resolveOrchestrationGuideline } from "./model-registry/guidelines/guidelines-resolver.js"
import type { ModelRegistry } from "./model-registry/index.js"
import type { ModelTier, OrchestrationModelDescriptor } from "./model-registry/types.js"
import type { ModelRoles, RoleModelAssignment } from "./model-roles.js"
import { modelIdFromRef, normalizeRoleModels, splitModelRef } from "./model-roles.js"
import { resolveModelRoleNames } from "./orchestrator-roles.js"

export interface OrchestrationInstructionsContext {
	currentModelId?: string
	registry?: ModelRegistry
	/** Role-based model assignments for orchestrator mode. */
	roles?: ModelRoles
	/** Custom model metadata for non-registry models. */
	customConfigs?: ReadonlyMap<string, ModelCustomMetadata>
}

export interface OrchestrationInstructionsResult {
	instructionsSection: string
}

/** Usage guidance for each role, injected into the team section. */
const ROLE_GUIDANCE: Record<string, string> = {
	builder: `**When to use:** Implementing code, writing files, fixing bugs, building features, compiling and testing.
**How to scope:** Give the Builder a complete, self-contained task — e.g. "Implement the X module with tests, compile, and verify" — not individual edits. Include file paths, expected interfaces, and acceptance criteria in the prompt. The Builder has read/write/bash/edit/grep/find/ls tools and can iterate on its own.
**Budget guidance:** Implementation tasks need at least 150000 tokens and 30 turns. Complex multi-file builds may need 200000 tokens and 40 turns. Never set below 50000 tokens.`,
	reviewer: `**When to use:** Verifying correctness after implementation, checking for bugs, running tests, reviewing against spec.
**How to scope:** Pass the list of files to review and the original task requirements. The Reviewer reads code, runs tests, and writes findings to a file. It does not fix issues — it reports them.
**Budget guidance:** Review tasks typically need 50000 tokens and 20 turns.`,
	explorer: `**When to use:** Understanding the codebase before acting, tracing code paths, finding where things are defined, reading files.
**How to scope:** Give specific files or directories to explore and a clear question to answer. The Explorer is read-only — it cannot write or edit files. It returns findings directly in its result.
**Budget guidance:** Exploration typically needs 100000 tokens and 25 turns.`,
	planner: `**When to use:** Designing an approach for complex tasks, writing specs, deciding on architecture before implementation.
**How to scope:** Pass the task description and any relevant files. The Planner writes a spec to a file and returns the path. Use when the task is complex enough that a structured approach will save time.
**Budget guidance:** Planning typically needs 60000 tokens and 10 turns.`,
	researcher: `**When to use:** Looking up external information — library APIs, version compatibility, documentation, best practices.
**How to scope:** Give a specific research question. The Researcher uses web_search and web_fetch. It returns cited findings.
**Budget guidance:** Research typically needs 100000 tokens and 25 turns.`,
}

export function resolveOrchestrationInstructions(
	ctx: OrchestrationInstructionsContext,
): OrchestrationInstructionsResult {
	return {
		instructionsSection: buildOrchestrationChapter(ctx.roles, ctx.currentModelId, ctx.registry, ctx.customConfigs),
	}
}

// ---------------------------------------------------------------------------
// Orchestrator instruction building blocks
// ---------------------------------------------------------------------------

const AGENT_MANAGEMENT = `### Agent management

- Write Agent prompts that are fully self-contained. Agents start with fresh context by default — include necessary instructions directly, or point them to a Markdown file containing larger context.
- When delegating \`plan\` before \`build\`, have the Plan agent write a Markdown spec file (full method signatures, file paths, interfaces) to the Documents directory. Pass that file path to the build Agent — it must not rediscover what was already decided.
- Spawn independent subtasks in parallel with \`run_in_background: true\`: do NOT run more than 3 concurrent Agents.
- After an Agent returns, TRUST its output unless the subagent itself reported errors or produced obviously incomplete work. Do NOT re-read source files just to verify a successful subagent's findings — this is the most common source of wasted orchestrator turns. For artifact-producing agents (Plan, Reviewer, Fixer, and Researcher when the research is non-trivial), have the subagent write its substantive output to a Markdown file in the Documents directory and return the file path. Read ONLY that file (or pass it to the next subagent). Explore is the exception: Explore agents return decision-ready findings directly in the Agent result and must not be asked to write Markdown files, reports, docs, notes, or scratch files. For build agents specifically: if the agent reports tests pass and compilation succeeds, move on to the next step. Do NOT re-read the code it wrote. For correction tasks, call Agent again with the correction task rather than fixing inline.
- If an Agent call returns an error of any kind (including protocol violation, timeout, or exit error): first assess whether the failure is retryable (e.g. transient timeouts or protocol violations) or not (e.g. missing files, permission errors, or invalid inputs). For retryable failures, call a replacement Agent with a corrected or simplified prompt — allow at most one retry per delegated step. You may also implement the remaining work directly when it's small enough and you understand the problem well enough after the sub-agent's attempt.
- **When a subagent returns agent_outcome.outcome other than "completed"**: the work is likely partial or invalid. Inspect agent_outcome.report before acting. Resume the same Agent only when remaining_steps are a direct continuation and preserving session context is valuable; use a changed-approach resume when the same thread still matters but the prior approach stalled; spawn a NEW follow-up Agent when remaining_steps have a clean narrower task boundary; run a short finalizer resume when the report is missing or the work appears finished but did not return completed; or implement the remaining work directly if it's small enough. Do not blindly retry the same prompt. **Include dependency context** in any replacement prompt: paste the public type signatures and function signatures of packages the follow-up agent will import (e.g. structs, interfaces, exported functions from earlier chunks) directly in the prompt so it does not waste turns re-reading files.
- Do NOT call Agent for work you can do in a single tool call.
- Use General-Purpose agents as a last resort only — when no specialized persona fits the task. Always prefer the specialized agent: Builder for implementation, Explore for codebase reading, Reviewer for verification, Researcher for web research, Plan for design. General-Purpose agents lack specialization and produce lower-quality results.
- Use \`inherit_context: true\` only when the Agent needs the parent conversation history. Otherwise keep the default fresh context.
- Inline images in your conversation are forwarded automatically to vision-capable Agents when needed. If no vision-capable model is available, the harness will automatically switch to one.
- Scope every Explore prompt with exact starting files and/or directories, prioritized symbols/search terms, one decision-relevant question to answer, allowed expansion rules for when it may follow imports/callers/related tests, and a qualitative stop condition tied to that question. Before delegating Explore, do cheap parent-side discovery/existence checks so the prompt starts from real anchors. Good Explore prompt: "Inspect /app/src/program.cbl. Answer only: what are the SELECT/FD entries and PIC-derived record widths? Follow no procedure logic. Stop once record layouts are known. Return decision-ready findings to the parent; do not write files." Bad Explore prompt: "Analyze the COBOL program and write a complete implementation spec."
- **Skills**: If a loaded skill contradicts Orchestration, Orchestration wins. Do not follow alternate subagent workflows from skills when they conflict.`

const THINKING_LEVELS = `### Thinking levels

\`thinking\` controls extended reasoning for the orchestrator and each delegated worker. Levels (lowest to highest): off, minimal, low, medium, high, xhigh. Use the lowest level that fits the task — higher thinking costs more tokens and time.

**Orchestrator (main thread):** keep thinking low while coordinating (spawning agents, reading artifact paths). Raise only when interpreting ambiguous subagent reports or making complex delegation decisions.

${renderOrchestratorThinkingTable()}

**Delegated workers:** pass \`thinking\` on every \`Agent\` call. Orchestrator-provided \`thinking\` overrides agent profile defaults. Match the level to the task complexity — simple work gets lower thinking, complex work (concurrency, algorithms, subtle logic) gets higher.

${renderDelegationThinkingLevelTable()}

**Self-performed work:** when you decide to do work yourself instead of delegating, call \`set_phase\` with the same phase-scoped \`thinking\` level you would have passed to an Agent.

**Retry escalation:** when spawning a replacement or \`resume_subagent\` after \`budget_exhausted\` or a stalled approach, bump \`thinking\` one tier from the prior call. Do not exceed the per-scope ceiling shown in the retry column.

**Non-reasoning models:** if the target model shows Extended thinking: no in Your team above, use \`off\` or the highest level the model supports — never request levels the model cannot run.`

const TOKEN_BUDGETS = `### Token budgets and turn caps

Include a \`max_turns\` for every Agent call. Use \`token_budget\` when the caller or task scope needs an output-token cap; it caps **cumulative output tokens** (tokens generated by the agent across all turns). It does not count input tokens, which grow as a side-effect of conversation length and are not controllable by the agent.

Match the budget to the **delegated task scope**, not the overall project complexity.

If the user explicitly asks for the Agent tool with a specific \`token_budget\`, make that Agent call once with the requested value. Do not ask to increase the budget or substitute a larger budget before the tool runs.

${renderAgentWorkerBudgetTable()}

**Always set \`max_duration\`** on every Agent call. Subagents can hang on blocking operations (deadlocked tests, infinite loops, stuck network calls) where token budget and turn limits do not trigger. The duration cap is the last line of defence against runaway agents.

**Heavy-tier model duration scaling:** The \`max_duration\` values in the table above are base values for standard-tier models. When delegating to a heavy-tier model, multiply the base \`max_duration\` by 1.5x.

The turn cap is the primary delegated-worker budget. If an Agent returns \`agent_outcome.outcome: "budget_exhausted"\`, do not mark the delegated work complete from that aborted result. Inspect \`agent_outcome.report\` and choose deliberately:

| Signal | Action |
|---|---|
| Completed outcome + report.status completed | Use the result or complete the linked Ferment step. |
| Missing report | Call \`resume_subagent\` with only \`agent_id\` and purpose \`finalize_report\`; the host supplies fixed report-only limits. |
| Budget exhausted + direct continuation in remaining_steps | Call \`resume_subagent\` with a bounded fresh budget and steering prompt. |
| Budget exhausted + same thread but stalled approach | Call \`resume_subagent\` once with a changed-approach steering prompt. |
| Budget exhausted + separable remaining_steps | Spawn a narrower linked replacement Agent for the clean task boundary. |
| Budget exhausted + appears finished | Run a short finalizer resume, then complete only from a completed outcome. |
| Max duration or inactivity | Assume a possible hang or blocked operation; resume only if the steering prompt avoids the stall, otherwise spawn a narrower replacement or stop/report. |
| Failed, stopped, blocked, or unclear report | Spawn a corrected replacement only if there is a clear task boundary; otherwise stop/skip and report the worker report. |`

// ---------------------------------------------------------------------------
// Orchestrator instruction builder
// ---------------------------------------------------------------------------

interface RoleContext {
	roles?: ModelRoles
	currentModelId?: string
	registry?: ModelRegistry
	customConfigs?: ReadonlyMap<string, ModelCustomMetadata>
}

function modelListForRole(assignment: RoleModelAssignment): string {
	return normalizeRoleModels(assignment)
		.map((r) => `\`${r}\``)
		.join(", ")
}

function buildModelSelection(ctx: RoleContext): string {
	if (!ctx.roles) {
		return `### Model selection

Always pass a \`model\` parameter on every Agent call. Read the model's **description** in **Your team** before selecting — it may reveal limitations. If the subtask involves images or visual content, select a model with Vision: yes.`
	}

	const builderModels = modelListForRole(ctx.roles.builder)
	const reviewerModels = modelListForRole(ctx.roles.reviewer)
	const explorerModels = modelListForRole(ctx.roles.explorer)
	const plannerModels = modelListForRole(ctx.roles.planner)

	const lines: string[] = []
	lines.push("### Model selection")
	lines.push("")
	lines.push(
		"Always pass a `model` parameter on every Agent call — never omit it. Match the model tier to the task: use the lightest-tier model that can handle the work, and escalate to a heavier tier only after a lighter model has failed on the same task. Read the model's **description** in **Your team** before selecting — it may reveal limitations.",
	)
	lines.push("")
	lines.push(
		"Always pass a `thinking` parameter on every Agent call — never omit it. Use the **Thinking levels** table below. Match the level to the task complexity — simple work gets lower thinking, complex work gets higher.",
	)
	lines.push("")
	lines.push(`- **Builder** (code implementation): ${builderModels}`)
	lines.push(`- **Reviewer** (code review, verification): ${reviewerModels}`)
	lines.push(`- **Explorer** (codebase exploration): ${explorerModels}`)
	lines.push(`- **Planner** (design, specs): ${plannerModels}`)
	lines.push("")
	lines.push("If the subtask involves images or visual content, select a model with Vision: yes.")
	lines.push("")
	lines.push(
		"**Tool descriptions vs. Orchestration:** Tool descriptions summarize capabilities. Detailed policy for delegation, budgets, model selection, and artifact handoff lives in this Orchestration section. If a tool description appears to set policy differently, follow Orchestration.",
	)
	return lines.join("\n")
}

function buildOrchestrationChapter(
	roles?: ModelRoles,
	currentModelId?: string,
	registry?: ModelRegistry,
	customConfigs?: ReadonlyMap<string, ModelCustomMetadata>,
): string {
	const ctx: RoleContext = { roles, currentModelId, registry, customConfigs }

	const parts: string[] = []

	// 1. Core delegation philosophy
	parts.push(`## Orchestration

You are the orchestrator. Your job is to figure out what steps are needed to solve the problem, delegate each step to a sub-agent, and process each sub-agent's result to decide what to do next. You cannot read files, write code, run commands, or search the web directly — everything goes through sub-agents.

Before starting long-running work, briefly orient the user: state what you intend to do and why in one or two sentences. After the orientation, proceed quietly — do not narrate the meta-process in subsequent turns.`)

	// 2. Team roster (dynamic from modelRoles config)
	if (roles) {
		parts.push(buildTeamSubsection(roles, registry, customConfigs))
		parts.push(buildRolesSubsection(currentModelId, roles, registry, customConfigs))
	}

	// 3. Model-specific orchestration guidelines (per-model, injected only for the active orchestrator)
	const modelNotes = resolveOrchestrationGuideline(currentModelId, registry)
	if (modelNotes) {
		parts.push(`### Model-specific notes\n\n${modelNotes}`)
	}

	// 4. Delegation guidance — the orchestrator can only delegate, not implement
	parts.push(`### Delegation

You are a pure orchestrator — you cannot read files, write code, run commands, or search the web. Your only way to interact with the world is through sub-agents. Everything goes through delegation:

- To understand the codebase: dispatch Agent(type: "Explore") to read files and trace code. Process the findings to plan your next step.
- To research external information: dispatch Agent(type: "Researcher") to search the web and documentation.
- To plan an approach: dispatch Agent(type: "Plan") to design the solution, or use create_todos to track your own plan.
- To implement code: dispatch Agent(type: "Builder") to write, edit, and test.
- To review work: dispatch Agent(type: "Reviewer") to verify correctness.
- To fix issues: dispatch Agent(type: "Fixer") to apply corrections.

**Break the task into phases before delegating.** Do not pass the entire task to a single sub-agent. Instead, decide what phases of work are needed and delegate each phase as a self-contained unit. For example, instead of dispatching a Builder to "build and train CIFAR-10", dispatch separate Builders for: (1) install dependencies and build the framework, (2) prepare training data, (3) train the model and verify output. Each phase should be completable within the budget you set.

**Match the budget to the task.** The budget you set determines what the sub-agent can accomplish. A 4000-token budget is enough for a single file read and small edit. A full feature implementation needs at least 150000 tokens and 30 turns. If a phase cannot be completed within a reasonable budget, decompose it further.

When a sub-agent returns, read its result carefully and decide:
- Is the work complete? Move to the next phase or report to the user.
- Is the work incomplete or failed? Call resume_subagent with a fresh budget and a steering prompt, or decompose the remaining work differently.
- Do you need more information? Dispatch an Explore or Researcher agent.

Trust sub-agent output unless it reported errors or produced obviously incomplete work. Do not blindly retry the same approach.

### Your available tools

You have exactly these tools — no others:
- **Agent** — dispatch a sub-agent (Builder, Explore, Reviewer, Researcher, Plan, Fixer, or General-Purpose)
- **resume_subagent** — resume a previously aborted sub-agent with a steering prompt
- **get_subagent_result** — check the status and output of a background sub-agent
- **create_todos** / **update_todos** / **add_todo** / **mark_todo** / **clear_todos** — track your progress
- **questionnaire** — ask the user a question (interactive mode only)

Delegate all file I/O, shell commands, and web searches to sub-agents.`)

	// 5. Model selection (role-to-model routing, dynamic)
	parts.push(buildModelSelection(ctx))

	// 6. Agent management rules
	parts.push(AGENT_MANAGEMENT)

	// 7. Thinking levels
	parts.push(THINKING_LEVELS)

	// 8. Budget reference
	parts.push(TOKEN_BUDGETS)

	return parts.join("\n\n")
}

// ---------------------------------------------------------------------------
// Role-based model assignments with tier + description
// ---------------------------------------------------------------------------

function resolveModelDisplayName(ref: string, registry?: ModelRegistry): string {
	const modelId = modelIdFromRef(ref)
	const descriptor = registry?.getModelById(modelId)
	if (descriptor) return descriptor.name
	return modelId
		.split(/[-_]/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ")
}

function resolveDescriptor(ref: string, registry?: ModelRegistry): OrchestrationModelDescriptor | undefined {
	const modelId = modelIdFromRef(ref)
	return registry?.getModelById(modelId)
}

function defaultDescription(_ref: string, roleNames: string[]): string {
	if (roleNames.length > 0) {
		const roles = roleNames.join(", ")
		return `This model was configured by the user to handle ${roles} work.`
	}
	return "This model was configured by the user."
}

interface ResolvedModelMeta {
	tier: ModelTier
	vision: boolean
	reasoning: boolean
	description: string
}

/**
 * Look up custom metadata by ref. Accepts either a full ref (`provider/model-id`)
 * or a bare model id (`model-id`) — settings metadata is keyed by full ref, but
 * the orchestrator current-model lookup sometimes has only the bare id.
 */
export function lookupCustomConfig(
	ref: string,
	customConfigs?: ReadonlyMap<string, ModelCustomMetadata>,
): ModelCustomMetadata | undefined {
	if (!customConfigs) return undefined
	const direct = customConfigs.get(ref)
	if (direct) return direct
	// Fallback: ref might be the bare model id. Find the matching full-ref key.
	for (const [key, value] of customConfigs) {
		if (key !== ref && modelIdFromRef(key) === ref) return value
	}
	return undefined
}

function resolveModelMeta(
	ref: string,
	registry?: ModelRegistry,
	customConfigs?: ReadonlyMap<string, ModelCustomMetadata>,
	roles?: ModelRoles,
): ResolvedModelMeta {
	const descriptor = resolveDescriptor(ref, registry)
	const custom = lookupCustomConfig(ref, customConfigs)
	const roleNames = resolveModelRoleNames(ref, roles)

	const tier = custom?.tier ?? descriptor?.capabilities.tier ?? "standard"
	const vision = custom?.vision ?? descriptor?.capabilities.vision ?? false
	const reasoning = custom?.reasoning ?? descriptor?.capabilities.reasoning ?? false
	const description = custom?.description ?? descriptor?.capabilities.description ?? defaultDescription(ref, roleNames)

	return { tier, vision, reasoning, description }
}

function formatModelEntry(
	ref: string,
	registry?: ModelRegistry,
	customConfigs?: ReadonlyMap<string, ModelCustomMetadata>,
	roles?: ModelRoles,
	teamRole?: string,
): string {
	const displayName = resolveModelDisplayName(ref, registry)
	const parsed = splitModelRef(ref)
	const providerInfo = parsed ? `, provider: \`${parsed.provider}\`` : ""

	const meta = resolveModelMeta(ref, registry, customConfigs, roles)
	const tierInfo = `Tier: ${meta.tier}`
	const visionInfo = ` | Vision: ${meta.vision ? "yes" : "no"}`
	const reasoningInfo = ` | Extended thinking: ${meta.reasoning ? "yes" : "no"}`
	const metaSuffix = ` — ${tierInfo}${visionInfo}${reasoningInfo}`

	const lines = [`- **${displayName}** (id: \`${ref}\`${providerInfo})${metaSuffix}`]
	const roleLabel = teamRole?.toLowerCase()
	const description = roleLabel ? `Delegate **${roleLabel}** work to this model. ${meta.description}` : meta.description
	lines.push(`  ${description}`)
	return lines.join("\n")
}

function formatRoleSection(
	roleName: string,
	assignment: RoleModelAssignment,
	registry?: ModelRegistry,
	customConfigs?: ReadonlyMap<string, ModelCustomMetadata>,
	roles?: ModelRoles,
): string {
	const models = normalizeRoleModels(assignment)
	const entries = models.map((ref) => formatModelEntry(ref, registry, customConfigs, roles, roleName))
	const guidance = ROLE_GUIDANCE[roleName.toLowerCase()]
	return `### ${roleName}\n${entries.join("\n\n")}${guidance ? `\n\n${guidance}` : ""}`
}

function formatCurrentModelCapabilities(
	currentModelId: string,
	registry?: ModelRegistry,
	customConfigs?: ReadonlyMap<string, ModelCustomMetadata>,
	roles?: ModelRoles,
): string {
	const meta = resolveModelMeta(currentModelId, registry, customConfigs, roles)
	const ownRoles = resolveModelRoleNames(currentModelId, roles)

	const lines: string[] = []
	lines.push(
		`Tier: ${meta.tier} | Vision: ${meta.vision ? "yes" : "no"} | Extended thinking: ${meta.reasoning ? "yes" : "no"}`,
	)
	lines.push(meta.description)
	lines.push("")

	if (!roles) return lines.join("\n")

	const delegableRoles: Array<{ role: string; assignment: RoleModelAssignment }> = [
		{ role: "planner", assignment: roles.planner },
		{ role: "builder", assignment: roles.builder },
		{ role: "reviewer", assignment: roles.reviewer },
		{ role: "explorer", assignment: roles.explorer },
		{ role: "researcher", assignment: roles.researcher },
	]

	const owned: string[] = []
	const delegated: string[] = []

	const agentTypeForRole: Record<string, string> = {
		planner: "Plan",
		builder: "Builder",
		reviewer: "Reviewer",
		explorer: "Explore",
		researcher: "Researcher",
	}

	for (const { role, assignment } of delegableRoles) {
		if (ownRoles.includes(role)) {
			owned.push(role)
		} else {
			const models = normalizeRoleModels(assignment)
			const modelList = models.map((r) => `\`${r}\``).join(", ")
			const agentType = agentTypeForRole[role] ?? role
			delegated.push(
				`- You do not have the **${role}** role. Delegate to Agent(type: "${agentType}") using one of: ${modelList}.`,
			)
		}
	}

	if (owned.length > 0) {
		lines.push(
			`You have these roles: **${owned.join(", ")}**. You may perform this work yourself or delegate to a team member — choose whichever is more efficient.`,
		)
	}
	if (delegated.length > 0) {
		lines.push("")
		lines.push(...delegated)
	}

	return lines.join("\n")
}

function buildTeamSubsection(
	roles: ModelRoles,
	registry?: ModelRegistry,
	customConfigs?: ReadonlyMap<string, ModelCustomMetadata>,
): string {
	const sections: string[] = []

	const plannerModels = normalizeRoleModels(roles.planner)
	const orchestratorIsPlanner = plannerModels.length === 1 && plannerModels[0] === roles.orchestrator
	if (!orchestratorIsPlanner) {
		sections.push(formatRoleSection("Planner", roles.planner, registry, customConfigs, roles))
	}

	sections.push(formatRoleSection("Builder", roles.builder, registry, customConfigs, roles))
	sections.push(formatRoleSection("Reviewer", roles.reviewer, registry, customConfigs, roles))
	sections.push(formatRoleSection("Explorer", roles.explorer, registry, customConfigs, roles))
	sections.push(formatRoleSection("Researcher", roles.researcher, registry, customConfigs, roles))

	return `### Your team\n\n${sections.join("\n\n")}`
}

function buildRolesSubsection(
	currentModelId: string | undefined,
	roles: ModelRoles,
	registry?: ModelRegistry,
	customConfigs?: ReadonlyMap<string, ModelCustomMetadata>,
): string {
	const capabilitiesSection = currentModelId
		? formatCurrentModelCapabilities(currentModelId, registry, customConfigs, roles)
		: "No capability information available for this model."

	return `### Your roles\n\n${capabilitiesSection}`
}
