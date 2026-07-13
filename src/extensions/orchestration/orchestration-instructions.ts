/**
 * Orchestrator-mode prompt content for multi-model orchestration.
 *
 * Provides the orchestrator with:
 * - Team section (Your Team + Your Capabilities) — which models fill which roles,
 *   rendered dynamically from the modelRoles config.
 * - Delegation guidance — how to think about when to delegate vs. implement directly,
 *   and how to process sub-agent results. No rigid pipeline or process prescription.
 * - Budget reference table and agent management rules.
 *
 * Model-specific behavior guidelines (e.g. minimax over-thinking) are injected
 * per-model via the guidelines resolver, not here.
 *
 * The subagent response protocol and single-model instructions live in
 * `prompt-construction/system-prompt.ts` next to `buildSystemPrompt`.
 */

import { renderAgentWorkerBudgetTable } from "../agents/worker-budget-policy.js"
import type { ModelCustomMetadata } from "./model-metadata.js"
import { buildOrchestrationGuidelinesSection } from "./model-registry/guidelines/guidelines-resolver.js"
import type { ModelRegistry } from "./model-registry/index.js"
import type { ModelTier, OrchestrationModelDescriptor } from "./model-registry/types.js"
import type { ModelRoles, RoleModelAssignment } from "./model-roles.js"
import { modelIdFromRef, normalizeRoleModels, splitModelRef } from "./model-roles.js"

export interface OrchestrationInstructionsContext {
	currentModelId?: string
	registry?: ModelRegistry
	/** Role-based model assignments for orchestrator mode. */
	roles?: ModelRoles
	/** Custom model metadata for non-registry models. */
	customConfigs?: ReadonlyMap<string, ModelCustomMetadata>
}

export interface OrchestrationInstructionsResult {
	teamSection: string
	instructionsSection: string
}

export function resolveOrchestrationInstructions(
	ctx: OrchestrationInstructionsContext,
): OrchestrationInstructionsResult {
	const teamSection =
		ctx.roles && ctx.registry
			? buildRoleAssignmentsSection(ctx.roles, ctx.registry, ctx.currentModelId, ctx.customConfigs)
			: ""

	const instructionParts: string[] = []
	instructionParts.push(buildOrchestratorInstructions(ctx.roles, ctx.currentModelId, ctx.registry, ctx.customConfigs))

	const orchGuidelines = buildOrchestrationGuidelinesSection(ctx.currentModelId, ctx.registry)
	if (orchGuidelines) instructionParts.push(orchGuidelines)

	return { teamSection, instructionsSection: instructionParts.join("\n\n") }
}

// ---------------------------------------------------------------------------
// Orchestrator instruction building blocks
// ---------------------------------------------------------------------------

const AGENT_MANAGEMENT = `### Agent management

- Write Agent prompts that are fully self-contained. Agents start with fresh context by default — include necessary instructions directly, or point them to a Markdown file containing larger context.
- When delegating \`plan\` before \`build\`, have the Plan agent write a Markdown spec file (full method signatures, file paths, interfaces) to the Documents directory. Pass that file path to the build Agent — it must not rediscover what was already decided.
- Spawn independent subtasks in parallel with \`run_in_background: true\`: do NOT run more than 3 concurrent Agents.
- After an Agent returns, TRUST its output unless the subagent itself reported errors or produced obviously incomplete work. Do NOT re-read source files just to verify a successful subagent's findings — this is the most common source of wasted orchestrator turns. For artifact-producing agents (Plan, Reviewer, Fixer, and Researcher when the research is non-trivial), have the subagent write its substantive output to a Markdown file in the Documents directory and return the file path. Read ONLY that file (or pass it to the next subagent). Explore is the exception: Explore agents return decision-ready findings directly in the Agent result and must not be asked to write Markdown files, reports, docs, notes, or scratch files. For build agents specifically: if the agent reports tests pass and compilation succeeds, move on to the next chunk or to review. Do NOT re-read the code it wrote. For correction tasks, call Agent again with the correction task rather than fixing inline.
- If an Agent call returns an error of any kind (including protocol violation, timeout, or exit error): first assess whether the failure is retryable (e.g. transient timeouts or protocol violations) or not (e.g. missing files, permission errors, or invalid inputs). For retryable failures, call a replacement Agent with a corrected or simplified prompt — allow at most one retry per delegated step. For non-retryable failures, report the failure clearly and stop immediately without retrying. You may also implement the remaining work directly when it's small enough and you understand the problem well enough after the sub-agent's attempt.
- **When a subagent returns agent_outcome.outcome other than "completed"**: the work is likely partial or invalid. Inspect agent_outcome.report before acting. Resume the same Agent only when remaining_steps are a direct continuation and preserving session context is valuable; use a changed-approach resume when the same thread still matters but the prior approach stalled; spawn a NEW follow-up Agent when remaining_steps have a clean narrower task boundary; run a short finalizer resume when the report is missing or the work appears finished but did not return completed; or stop/skip and report when blocked or unclear. You may also implement the remaining work directly if it's small enough. Do not blindly retry the same prompt. **Include dependency context** in any replacement prompt: paste the public type signatures and function signatures of packages the follow-up agent will import (e.g. structs, interfaces, exported functions from earlier chunks) directly in the prompt so it does not waste turns re-reading files.
- Do NOT call Agent for work you can do in a single tool call.
- Use \`inherit_context: true\` only when the Agent needs the parent conversation history. Otherwise keep the default fresh context.
- Inline images in your conversation are forwarded automatically to vision-capable Agents when needed. If no vision-capable model is available, the harness will automatically switch to one.`

const TOKEN_BUDGETS = `### Token budgets and turn caps

Include a \`max_turns\` for every Agent call. Use \`token_budget\` when the caller or task scope needs an output-token cap; it caps **cumulative output tokens** (tokens generated by the agent across all turns). It does not count input tokens, which grow as a side-effect of conversation length and are not controllable by the agent.

Match the budget to the **delegated task scope**, not the overall project complexity.

If the user explicitly asks for the Agent tool with a specific \`token_budget\`, make that Agent call once with the requested value. Do not ask to increase the budget or substitute a larger budget before the tool runs.

${renderAgentWorkerBudgetTable()}

**Always set \`max_duration\`** on every Agent call. Subagents can hang on blocking operations (deadlocked tests, infinite loops, stuck network calls) where token budget and turn limits do not trigger. The duration cap is the last line of defence against runaway agents.

**Heavy-tier model duration scaling:** When delegating to a heavy-tier model, multiply \`max_duration\` by 1.5x.

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

function buildRoleDirectives(ctx: RoleContext): string {
	if (!ctx.roles) {
		return `### Model selection

Pass a \`model\` parameter on every Agent call. Default to the lightest-tier model from the relevant role pool. Read the model's **description** in **Your Team** above before selecting — it may reveal limitations or strengths. If the subtask involves images or visual content, select a model with Vision: yes.`
	}

	const builderModels = modelListForRole(ctx.roles.builder)
	const reviewerModels = modelListForRole(ctx.roles.reviewer)
	const explorerModels = modelListForRole(ctx.roles.explorer)
	const plannerModels = modelListForRole(ctx.roles.planner)

	const lines: string[] = []
	lines.push("### Model selection")
	lines.push("")
	lines.push(
		"Pass a `model` parameter on every Agent call. Default to the lightest-tier model from the relevant role pool. Escalate to heavy-tier only after a lighter model has failed on the same task. Read the model's **description** in **Your Team** above before selecting — it may reveal limitations or strengths.",
	)
	lines.push("")
	lines.push(`- **Builder** (code implementation): ${builderModels}`)
	lines.push(`- **Reviewer** (code review, verification): ${reviewerModels}`)
	lines.push(`- **Explorer** (codebase exploration): ${explorerModels}`)
	lines.push(`- **Planner** (design, specs): ${plannerModels}`)
	lines.push("")
	lines.push("If the subtask involves images or visual content, select a model with Vision: yes.")
	return lines.join("\n")
}

function buildOrchestratorInstructions(
	roles?: ModelRoles,
	currentModelId?: string,
	registry?: ModelRegistry,
	customConfigs?: ReadonlyMap<string, ModelCustomMetadata>,
): string {
	const ctx: RoleContext = { roles, currentModelId, registry, customConfigs }

	const parts: string[] = []

	// 1. Core delegation philosophy
	parts.push(`## Orchestrate the work

Your job is to figure out what steps are needed to solve the problem, work through each step, and decide for each step whether to do it yourself or delegate to a sub-agent. When you delegate, process the sub-agent's response and use it to decide what to do next.

Before starting long-running work, briefly orient the user: state what you intend to do and why in one or two sentences. After the orientation, proceed quietly — do not narrate the meta-process in subsequent turns.`)

	// 2. Delegation guidance (principles, not rules)
	parts.push(`### Delegation

Delegate when it keeps your context clean (the work involves extensive file reading or large output that would bloat your context) or when a specialized model is better suited for the task. Implement directly when the work is small, when you understand the problem well enough after a sub-agent's attempt, or when delegation would add overhead without value.

When a sub-agent fails, inspect what it accomplished, understand why it failed, and adapt. You may retry with a narrower scope, switch to a different model, decompose the task differently, or implement the remaining work directly. Don't blindly retry the same approach.

After a sub-agent returns, trust its output unless it reported errors or produced obviously incomplete work. Do NOT re-read files the subagent created or re-run its tests — move on to the next step.`)

	// 3. Model routing (which model for which role — resolved dynamically from config)
	parts.push(buildRoleDirectives(ctx))

	// 4. Agent management rules
	parts.push(AGENT_MANAGEMENT)

	// 5. Budget reference
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

function matchesRef(candidate: string, refs: string[]): boolean {
	return refs.some((r) => r === candidate || modelIdFromRef(r) === candidate)
}

function resolveModelRoleNames(ref: string, roles?: ModelRoles): string[] {
	if (!roles) return []
	const assigned: string[] = []
	const roleMap: Record<string, RoleModelAssignment> = {
		planner: roles.planner,
		builder: roles.builder,
		reviewer: roles.reviewer,
		explorer: roles.explorer,
		researcher: roles.researcher,
	}
	for (const [roleName, assignment] of Object.entries(roleMap)) {
		if (matchesRef(ref, normalizeRoleModels(assignment))) {
			assigned.push(roleName)
		}
	}
	if (roles.orchestrator === ref || modelIdFromRef(roles.orchestrator) === ref) {
		assigned.unshift("orchestrator")
	}
	return assigned
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
	const description = custom?.description ?? descriptor?.capabilities.description ?? defaultDescription(ref, roleNames)

	return { tier, vision, description }
}

function formatModelEntry(
	ref: string,
	registry?: ModelRegistry,
	customConfigs?: ReadonlyMap<string, ModelCustomMetadata>,
	roles?: ModelRoles,
): string {
	const displayName = resolveModelDisplayName(ref, registry)
	const parsed = splitModelRef(ref)
	const providerInfo = parsed ? `, provider: \`${parsed.provider}\`` : ""

	const meta = resolveModelMeta(ref, registry, customConfigs, roles)
	const tierInfo = `Tier: ${meta.tier}`
	const visionInfo = ` | Vision: ${meta.vision ? "yes" : "no"}`
	const metaSuffix = ` — ${tierInfo}${visionInfo}`

	const lines = [`- **${displayName}** (id: \`${ref}\`${providerInfo})${metaSuffix}`]
	lines.push(`  ${meta.description}`)
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
	const entries = models.map((ref) => formatModelEntry(ref, registry, customConfigs, roles))
	return `### ${roleName}\n${entries.join("\n\n")}`
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
	lines.push(`Tier: ${meta.tier} | Vision: ${meta.vision ? "yes" : "no"}`)
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
				`- You do not have the **${role}** role. Do not perform ${role} work yourself. Delegate to Agent(type: "${agentType}") using one of: ${modelList}.`,
			)
		}
	}

	if (owned.length > 0) {
		lines.push(
			`You have these roles: **${owned.join(", ")}**. You are allowed to perform this work yourself, but delegate to a team member when one is better suited for the task.`,
		)
	}
	if (delegated.length > 0) {
		lines.push("")
		lines.push(...delegated)
	}

	return lines.join("\n")
}

function buildRoleAssignmentsSection(
	roles: ModelRoles,
	registry?: ModelRegistry,
	currentModelId?: string,
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

	const capabilitiesSection = currentModelId
		? formatCurrentModelCapabilities(currentModelId, registry, customConfigs, roles)
		: "No capability information available for this model."

	return `## Your Team\n\n${sections.join("\n\n")}\n\n## Your Capabilities\n\n${capabilitiesSection}`
}
