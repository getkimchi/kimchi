/**
 * Orchestrator-mode prompt content for multi-model orchestration.
 *
 * Covers the orchestrator's team section (Your Team + Your Capabilities) and the
 * per-phase DOs/DONTs, agent management rules, token budgets, and plan quality
 * checklist. The subagent response protocol and single-model instructions live
 * in `prompt-construction/system-prompt.ts` next to `buildSystemPrompt`, which
 * is the module that knows about modes.
 */

import { renderAgentWorkerBudgetTable } from "../agents/worker-budget-policy.js"
import type { PromptMode } from "../prompt-construction/system-prompt.js"
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
// Orchestrator Mode Instructions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Orchestrator instruction building blocks (static parts)
// ---------------------------------------------------------------------------

const STEP_1_CLASSIFY = `### Step 1 — Classify the task

Decide whether the task is **simple** or **complex**:

- **Simple**: single-file change, no design decisions required, unambiguous what to write.
- **Complex**: anything involving multiple files, a layered architecture, modifying existing code you haven't read, or any decision about structure or interfaces.`

const STEP_2_PIPELINE = `### Step 2 — Identify required pipeline steps

Select only the steps the task needs:

- explore — reading files and tracing code to understand the codebase.
- research — consulting documentation, APIs, or external sources.
- plan — designing the approach, writing specs, deciding interfaces.
- build — writing, modifying, or refactoring code.
- review — verifying correctness and checking for bugs.

**Match the pipeline to the request**: review code → explore + review; plan an approach → explore + plan; explore/research only → produce a summary. The full plan→build→review pipeline applies only to writing or modifying code. **Greenfield projects** (empty directory): skip explore.

**Intent boundary — never exceed what was asked.** Concrete rules:
- If the pipeline does not include **build**, do not create, modify, or delete source files. Report findings only.
- If the pipeline does not include **plan**, do not produce a spec or design document.
- If the pipeline is **review-only** (explore + review), output a findings report. Do not fix or apply issues.
- If the pipeline is **explore-only** or **research-only**, produce a summary. Do not plan, build, or review.

Include the intent boundary in every subagent prompt.`

const STEP_4_EXECUTE = `### Step 4 — Execute

Run the steps in order. For steps you own, use your tools directly. For steps you delegate, call the Agent tool and wait for it to complete before proceeding unless you explicitly run it in the background. Never perform a step yourself while an Agent for that step is running or after you have delegated it.`

const PLAN_SPEC_REQUIREMENTS = `The spec MUST break the work into **small, independently-buildable chunks** — each chunk is a single cohesive unit (typically 1–3 files) that can be verified independently. Keep implementation and its tests in the same chunk — the agent that writes the code has the best context to test it. Include for each chunk: the file paths, method signatures / interfaces, expected behaviour, acceptance criteria, and a **complexity** classification:
   - **simple** — straightforward CRUD, data structures, boilerplate, CLI wiring, simple input parsing. A standard-tier Builder can implement this from the spec alone.
   - **complex** — concurrency (goroutines, threads, channels, mutexes, worker pools), state machines, graph algorithms (topological sort, cycle detection, BFS/DFS), dynamic programming, signal handling, tricky synchronization, or any logic where correctness depends on subtle ordering or edge cases. Requires a heavy-tier Builder.

**What makes a good complex chunk spec:** For each chunk classified as \`complex\`, the spec MUST include: (1) the specific concurrency/algorithm primitives to use (e.g. "sync.WaitGroup + buffered channel of size N", not just "use concurrency"), (2) the lifecycle of goroutines/threads (who spawns, who waits, what triggers shutdown), (3) the error propagation path (which errors cancel other work, which are collected and returned). A complex chunk without these details is not ready for delegation — the builder will invent the design and likely get it wrong, causing repeated aborts.

Chunks must be ordered so each one can build on the previous.`

const PLAN_VERIFICATION = `**Plan verification (required for complex tasks, optional for simple):** After self-validation, decide whether the plan needs external verification.

**Skip verification when ALL of these apply:**
- Single-file change or 2 files maximum
- Well-understood pattern (e.g. adding a field, fixing a nil check)
- No new architecture, interfaces, or data flow
- No ambiguous requirements

**Require verification when ANY of these apply:**
- 3+ files or 2+ chunks
- New architecture, abstraction layer, or unfamiliar pattern
- Unclear or incomplete requirements
- Concurrency, state machines, or distributed logic

**Verification prompt:** The verifier reads the task description and spec, then outputs:
- APPROVED — the plan is complete, buildable, and aligned.
- NEEDS_REVISION — list specific gaps with file/chunk references.

The verifier checks **build feasibility** and **complexity classification** for each chunk:
- **Build feasibility**: is the spec detailed enough that a standard-tier Builder can implement it without inventing design? Are concurrency primitives, state transitions, and synchronization points explicit?
- **Complexity accuracy**: a chunk using concurrency, worker pools, mutexes, signal handling, or graph algorithms MUST be \`complex\`. A \`simple\` chunk containing any of these is misclassified.
- **Chunk scope**: split chunks that stack 3+ independent concurrency mechanisms (e.g. worker pool + signal handling + fail-fast cancellation).

If any check fails, the verdict MUST be NEEDS_REVISION with the specific gaps.`

const REVIEW_PHASE = `**Review output contract:** The review agent writes findings to a Markdown file in the Documents directory (e.g. \`.kimchi/docs/review.md\`) containing:
- **Verdict**: APPROVED or NEEDS_FIXES
- **Issues** (if NEEDS_FIXES): numbered list with file path, line reference, problem description, and suggested fix

The review agent runs tests, checks lint, and verifies the implementation matches the spec.

**If the review agent times out or produces no output:** Retry ONCE with a standard-tier Reviewer. If the retry also fails, skip review and report the failure. Do NOT attempt a third reviewer.

**Handling review results:** Read ONLY the review file. If APPROVED, produce the final summary and stop. If NEEDS_FIXES, delegate a fix agent with the review file and spec file paths.

**Fix agent contract:** The fix agent must: (1) read the review findings, (2) apply all fixes, (3) run the full test suite (with race/thread-safety detection if applicable) and lint, (4) write a verification report to the Documents directory (e.g. \`.kimchi/docs/verification.md\`) with:
- **Test output**: pass/fail count and failures
- **Lint output**: warnings or errors
- **Verdict**: ALL_PASS or HAS_FAILURES

**After the fix agent completes:** Read ONLY the verification file. Take no other action.
- If ALL_PASS → review phase is complete. Produce one final summary and stop.
- If HAS_FAILURES → spawn one more fix agent with the remaining failures (round 2).
- After round 2, stop regardless of outcome. Report unresolved failures to the user.
- If remaining failures assert specific ordering of concurrent operations, report them as known flaky tests and stop.

**Review phase turn budget:** Complete the review phase in at most 10 orchestrator turns. If approaching 10 turns, produce the summary with whatever state you have.

**Review verdicts are final**: Do not edit a review report. If a flag is genuinely wrong, add a separate rationale note alongside it.`

const ORCHESTRATOR_DISCIPLINE = `**Orchestrator discipline**: Between delegation calls, you may do at most 5 tool calls (e.g. reading the spec file, setting the phase, checking a subagent result). If you find yourself doing reads, edits, bash calls, or writes on implementation files, STOP — you are doing a subagent's job. Delegate it instead. **Post-abort anti-pattern**: When a subagent aborts (budget or turns), do NOT manually complete its remaining work — this is the most common violation. Spawn a follow-up Agent scoped to the unfinished portion. List what the aborted agent completed and what remains.`

const AGENT_MANAGEMENT = `### Agent management

- Write Agent prompts that are fully self-contained. Include instructions directly or point to a Markdown file with larger context.
- When delegating \`plan\` before \`build\`, have the Plan agent write a Markdown spec to the Documents directory. Pass that path to the Builder; it must not rediscover the plan.
- Spawn independent subtasks in parallel with \`run_in_background: true\`; do NOT run more than 3 concurrent Agents.
- After an Agent returns, TRUST its output unless it reported errors or produced obviously incomplete work. Do NOT re-read source files to verify successful work. For artifact-producing agents (Plan, Reviewer, Fixer, non-trivial Researcher), have the agent write its output to a Markdown file in the Documents directory and read only that file. Explore agents are the exception: they return decision-ready findings directly and must not write Markdown files. For build agents, if tests pass and compilation succeeds, move to the next chunk or to review.
- If an Agent call errors (protocol violation, timeout, exit error, etc.), do NOT debug it yourself. Assess whether the failure is retryable. Retryable failures get one replacement Agent with a corrected or simplified prompt. Non-retryable failures are reported and stop the step.
- **When a subagent outcome is not "completed":** inspect \`agent_outcome.report\` before acting. Resume the same Agent only for direct continuations; use a changed-approach resume for stalled threads; spawn a new follow-up Agent for clean narrower boundaries; run a short finalizer when the report is missing; stop/skip when blocked or unclear. Include dependency context (public types, function signatures) in replacement prompts so the agent does not re-read files.
- Do NOT call Agent for work you can do in a single tool call.
- Use \`inherit_context: true\` only when the Agent needs the parent conversation history.
- Inline images are forwarded automatically to vision-capable Agents; the harness falls back to a vision model if needed.

### Model selection

Always pass a \`model\` parameter on every Agent call. Default to the lightest-tier model in the relevant pool. Escalate to heavy-tier only for concurrency, algorithms, architectural reasoning, or when a standard-tier model already failed on the same chunk. Check the model's description for limitations. Use a vision-capable model for image or visual content.`

const TOKEN_BUDGETS = `### Token budgets and turn caps

Include \`max_turns\` on every Agent call. Use \`token_budget\` to cap cumulative output tokens generated by the agent; it does not count input tokens.

Match the budget to the **delegated task scope**, not the overall project. If the user explicitly requests a \`token_budget\`, honor it once; do not ask for a larger budget first.

${renderAgentWorkerBudgetTable()}

**Always set \`max_duration\`** on every Agent call; it is the last defence against runaway agents on blocking operations.

**Heavy-tier model duration scaling:** multiply \`max_duration\` by 1.5x for heavy-tier models.

Use the **multi-file package** tier for build chunks with concurrency, worker pools, channels, or complex state machines. When in doubt, prefer the larger budget — an abort plus follow-up costs more than a generous initial budget.

If an Agent returns \`agent_outcome.outcome: "budget_exhausted"\`, do not mark the work complete. Inspect \`agent_outcome.report\` and act:

| Signal | Action |
|---|---|
| Completed outcome + report.status completed | Use the result or complete the linked Ferment step. |
| Missing report | Call \`resume_subagent\` with only \`agent_id\` and purpose \`finalize_report\`. |
| Budget exhausted + direct continuation | Call \`resume_subagent\` with a bounded fresh budget and steering prompt. |
| Budget exhausted + stalled approach | Call \`resume_subagent\` once with a changed-approach steering prompt. |
| Budget exhausted + separable remaining steps | Spawn a narrower replacement Agent. |
| Budget exhausted + appears finished | Run a short finalizer resume; complete only from a completed outcome. |
| Max duration or inactivity | Resume only if the steering prompt avoids the stall; otherwise spawn a narrower replacement or stop/report. |
| Failed, stopped, blocked, or unclear report | Spawn a corrected replacement only if there is a clear task boundary; otherwise stop/skip and report. |`

const PLAN_QUALITY_CHECKLIST = `### What makes a good plan

A plan is "good" when an independent model can build from it without asking questions. Verify against this checklist before calling a plan complete:

1. **Chunking** — 1–3 files per chunk; each chunk has one focused goal and a \`simple\` or \`complex\` classification. Complex chunks get the multi-file-package budget; simple chunks get the single-file budget.
2. **Ordering** — Later chunks build on earlier ones; dependencies are explicit.
3. **Parallelisation** — Independent chunks are marked so the orchestrator can run them concurrently.
4. **File specificity** — Every created, modified, or deleted file has a concrete path.
5. **Interface contracts** — Method signatures, types, and data structures are defined, not vague.
6. **Acceptance criteria** — 2–4 concrete, verifiable criteria per chunk.
7. **Edge cases** — Error handling, timeouts, concurrency, empty inputs, and malformed data are addressed.
8. **Test strategy** — Every architectural layer has adequate tests (data, service, handlers, CLI smoke). Target ≥ 1.0 test-to-production LOC. Use idiomatic patterns (Go table-driven, TypeScript describe/it, Python pytest parametrize). For concurrency, use race/thread-safety detectors (\`go test -race\`, \`-fsanitize=thread\`). For Go, pass \`-timeout 30s\` to avoid deadlocks. **Anti-flaky rule**: never assert specific ordering of concurrent results; assert membership or sort first.
9. **No ambiguity** — API choices, library versions, and design decisions are explicit; rejected alternatives noted in one line.
10. **Feasibility** — The plan fits the token budgets; no chunk needs >150k tokens.`

// ---------------------------------------------------------------------------
// Orchestrator instruction builder (generates role-specific DOs/DONTs)
// ---------------------------------------------------------------------------

interface PhaseDirectiveContext {
	ownRoles: string[]
	roles?: ModelRoles
	registry?: ModelRegistry
	customConfigs?: ReadonlyMap<string, ModelCustomMetadata>
}

function modelListForRole(assignment: RoleModelAssignment): string {
	return normalizeRoleModels(assignment)
		.map((r) => `\`${r}\``)
		.join(", ")
}

function buildPlanPhaseDirectives(ctx: PhaseDirectiveContext): string {
	const owns = ctx.ownRoles.includes("planner")
	const lines: string[] = []

	lines.push("#### Plan phase")
	lines.push("")

	if (owns) {
		lines.push("- DO write the plan yourself. Produce a Markdown spec file in the Documents directory.")
		lines.push("- DO self-validate: re-read the spec and cross-check every requirement from the original task.")
	} else {
		const models = ctx.roles ? modelListForRole(ctx.roles.planner) : "a Planner model"
		lines.push("- DO NOT write the plan yourself. You do not have the planner role.")
		lines.push(`- DO delegate planning to Agent(type: "Plan", model: ${models}).`)
		lines.push(
			"- DO self-validate after the Plan agent returns: re-read the spec and cross-check every requirement from the original task.",
		)
	}

	lines.push("")
	lines.push(PLAN_SPEC_REQUIREMENTS)
	lines.push("")
	lines.push(PLAN_VERIFICATION)
	lines.push("")

	if (owns) {
		lines.push(
			"**Handling the verdict:** If APPROVED: proceed to build phase. If NEEDS_REVISION: fix the gaps yourself. After revision, send ONLY the changed sections back to the verifier — not the full plan. Maximum one re-verification round; if still not approved, proceed with documented reservations.",
		)
	} else {
		const models = ctx.roles ? modelListForRole(ctx.roles.planner) : "a Planner model"
		lines.push(
			`**Handling the verdict:** If APPROVED: proceed to build phase. If NEEDS_REVISION: delegate revisions to Agent(type: "Plan", model: ${models}). After revision, send ONLY the changed sections back to the verifier — not the full plan. Maximum one re-verification round; if still not approved, proceed with documented reservations.`,
		)
	}

	return lines.join("\n")
}

function buildBuildPhaseDirectives(ctx: PhaseDirectiveContext): string {
	const lines: string[] = []
	const models = ctx.roles ? modelListForRole(ctx.roles.builder) : "a Builder model"

	lines.push("#### Build phase")
	lines.push("")
	lines.push("- DO NOT build code yourself. Delegate one Agent call per chunk from the plan.")
	lines.push(
		`- DO delegate each chunk to Agent(type: "Builder", model: ${models}). Simple chunks use a standard-tier Builder; complex chunks (concurrency, state machines, algorithms) require a heavy-tier Builder. Retries may escalate to a heavier tier when the first choice fails.`,
	)
	lines.push("- DO pass the spec file path and tell each agent which chunk to implement.")
	lines.push(
		"- DO instruct every build agent to: (1) write the implementation, (2) write tests, (3) verify compilation and lint, (4) run tests exactly once. If compilation or tests fail, the agent reports failures and stops — no fix-retry cycles.",
	)
	lines.push(
		"- DO run up to 3 independent chunks in parallel with run_in_background. Run sequential chunks one at a time.",
	)
	lines.push(
		"- DO NOT read the subagent's output files yourself, run tests yourself, or verify the code after the last build chunk completes. Transition to review immediately.",
	)

	return lines.join("\n")
}

function buildReviewPhaseDirectives(ctx: PhaseDirectiveContext): string {
	const lines: string[] = []
	const models = ctx.roles ? modelListForRole(ctx.roles.reviewer) : "a Reviewer model"

	lines.push("#### Review phase")
	lines.push("")
	lines.push(
		"- DO NOT review code yourself. Always delegate to a Reviewer agent in a fresh context — even when reviewer is in your roles. The fresh context provides independence from planning and building.",
	)
	lines.push(
		`- DO delegate to Agent(type: "Reviewer", model: ${models}). Prefer a standard-tier Reviewer — heavy-tier models are slower and more prone to timing out. Only use a heavy-tier Reviewer for complex concurrency, security-critical logic, or novel architectural patterns.`,
	)
	lines.push("- DO pass the spec file path and the full list of created files.")
	lines.push("")
	lines.push(REVIEW_PHASE)

	return lines.join("\n")
}

function buildExplorePhaseDirectives(ctx: PhaseDirectiveContext): string {
	const owns = ctx.ownRoles.includes("explorer")
	const lines: string[] = []

	lines.push("#### Explore phase")
	lines.push("")

	if (owns) {
		const models = ctx.roles ? modelListForRole(ctx.roles.explorer) : "an Explorer model"
		lines.push("- DO explore the codebase yourself for small explorations (a few files).")
		lines.push(`- DO delegate large explorations (many files) to Agent(type: "Explore", model: ${models}).`)
	} else {
		const models = ctx.roles ? modelListForRole(ctx.roles.explorer) : "an Explorer model"
		lines.push("- DO NOT explore the codebase yourself. You do not have the explorer role.")
		lines.push(`- DO delegate to Agent(type: "Explore", model: ${models}).`)
	}
	lines.push(
		"- DO ask Explore agents to return decision-ready findings directly in the Agent result. Do NOT ask Explore agents to write Markdown files, reports, docs, notes, or scratch files.",
	)

	return lines.join("\n")
}

function buildResearchPhaseDirectives(ctx: PhaseDirectiveContext): string {
	const owns = ctx.ownRoles.includes("researcher")
	const lines: string[] = []

	lines.push("#### Research phase")
	lines.push("")
	lines.push(
		"- For quick factual lookups (library comparisons, version numbers, API references), call web_search directly — do not spawn an Agent.",
	)

	if (owns) {
		lines.push("- DO perform deep research yourself when it requires analysis across multiple sources.")
		lines.push(
			`- DO delegate large research tasks to Agent(type: "Researcher") when the scope is too broad for a single web_search call.`,
		)
	} else {
		const models = ctx.roles ? modelListForRole(ctx.roles.researcher) : "a Researcher model"
		lines.push("- DO NOT perform deep research yourself. You do not have the researcher role.")
		lines.push(`- DO delegate deep research to Agent(type: "Researcher", model: ${models}).`)
	}

	return lines.join("\n")
}

function buildOrchestratorInstructions(
	roles?: ModelRoles,
	currentModelId?: string,
	registry?: ModelRegistry,
	customConfigs?: ReadonlyMap<string, ModelCustomMetadata>,
): string {
	const ownRoles = currentModelId && roles ? resolveModelRoleNames(currentModelId, roles) : []

	const ctx: PhaseDirectiveContext = { ownRoles, roles, registry, customConfigs }

	const parts: string[] = []

	parts.push(`## Orchestrate the work

Before starting long-running work — a sequence of exploration or implementation tool calls, a delegation to a subagent, or a multi-step plan — briefly orient the user: state what you intend to do and why in one or two sentences. For complex tasks, name the phases you will work through (for example: "I'll start by mapping the handlers, then propose fixes, then implement"). This is the user's window to interrupt if your approach is wrong — do not skip it.

After the orientation, reason through the pipeline steps below (classification, pipeline selection, phase directives) and proceed with the work. Do not narrate the meta-process (which pipeline step you are on, which phase you are in) — only the intent and observable progress.`)

	parts.push(STEP_1_CLASSIFY)
	parts.push(STEP_2_PIPELINE)

	// Step 3 — per-phase DOs/DONTs (generated from roles)
	parts.push(`### Step 3 — Your responsibilities per phase

Read **Your Capabilities** above. The sections below tell you exactly what to DO and what NOT to do for each pipeline phase. Follow them literally.

Pass durable artifacts as Markdown files in the Documents directory: plans/specs, review findings, verification reports, and non-trivial research notes. Explore findings are not durable artifacts; consume them directly from the Agent result.`)

	parts.push(buildPlanPhaseDirectives(ctx))
	parts.push(buildBuildPhaseDirectives(ctx))
	parts.push(buildReviewPhaseDirectives(ctx))
	parts.push(buildExplorePhaseDirectives(ctx))
	parts.push(buildResearchPhaseDirectives(ctx))

	parts.push(STEP_4_EXECUTE)

	parts.push(`#### Mandatory pipeline for complex tasks

When Step 1 classified the task as **complex**, you MUST execute it as a phased pipeline — never lump everything into a single Agent call or do it all yourself. Each phase produces an artefact the next one consumes.`)

	parts.push(ORCHESTRATOR_DISCIPLINE)
	parts.push(AGENT_MANAGEMENT)
	parts.push(TOKEN_BUDGETS)
	parts.push(PLAN_QUALITY_CHECKLIST)

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

function defaultDescription(ref: string, roleNames: string[]): string {
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
