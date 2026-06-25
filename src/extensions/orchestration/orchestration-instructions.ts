/**
 * Orchestrator-mode prompt content for multi-model orchestration.
 *
 * Covers the orchestrator's team section (Your Team + Your Capabilities) and the
 * per-phase DOs/DONTs, agent management rules, token budgets, and plan quality
 * checklist. The subagent response protocol and single-model instructions live
 * in `prompt-construction/system-prompt.ts` next to `buildSystemPrompt`, which
 * is the module that knows about modes.
 */

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

From the following steps, select only the ones the task actually needs:

- explore — reading files, tracing code, understanding the existing codebase before acting.
- research — consulting external sources: documentation, internet resources, library APIs, versioning, guidelines, or anything not contained in this codebase.
- plan — designing the approach, writing specs, deciding on interfaces before implementing.
- build — writing, modifying, or refactoring code.
- review — verifying correctness, checking for bugs, confirming the implementation matches intent.

Omit steps that add no value. A simple fix may need only build. A complex feature may need all phases. **Match the pipeline to the request**: if the user asks to review code, run explore + review — not plan + build + review. If the user asks to plan an approach, run explore + plan — not the full pipeline. If the user asks to explore or research, do only that. The mandatory plan->build->review pipeline applies only when the task involves writing or modifying code. **Greenfield projects** (empty directory, no existing code to read): skip explore entirely — there is nothing to explore. Merge any discovery work into the plan phase instead.

**Intent boundary — never exceed what was asked.** The selected pipeline is the scope ceiling. No agent — orchestrator or subagent — may perform actions that belong to a pipeline step not selected above. Concrete rules:
- If the pipeline does not include **build**, no source files may be created, modified, or deleted. No commits may be made. Findings and suggestions are reported, never applied.
- If the pipeline does not include **plan**, no spec or design document is produced — the task is executed or evaluated directly.
- If the pipeline is **review-only** (explore + review), the output is a findings report. Do not fix, refactor, or apply any of the reported issues. Do not offer to apply fixes inline. Report what you found and stop.
- If the pipeline is **explore-only** or **research-only**, produce a summary. Do not plan, build, or review.

When delegating to subagents, include the intent boundary explicitly in the agent prompt so the subagent knows what it must not do.`

const STEP_4_EXECUTE = `### Step 4 — Execute

Run the steps in order. For steps you own, use your tools directly. For steps you delegate, call the Agent tool and wait for it to complete before proceeding unless you explicitly run it in the background. Never perform a step yourself while an Agent for that step is running or after you have delegated it.`

const PLAN_SPEC_REQUIREMENTS = `The spec MUST break the work into **small, independently-buildable chunks** — each chunk is a single cohesive unit (typically 1–3 files) that can be verified independently. Keep implementation and its tests in the same chunk — the agent that writes the code has the best context to test it. Include for each chunk: the file paths, method signatures / interfaces, expected behaviour, acceptance criteria, and a **complexity** classification:
   - **simple** — straightforward CRUD, data structures, boilerplate, CLI wiring, simple input parsing. A standard-tier Builder can implement this from the spec alone.
   - **complex** — concurrency (goroutines, threads, channels, mutexes, worker pools), state machines, graph algorithms (topological sort, cycle detection, BFS/DFS), dynamic programming, signal handling, tricky synchronization, or any logic where correctness depends on subtle ordering or edge cases. Requires a heavy-tier Builder.

**What makes a good complex chunk spec:** For each chunk classified as \`complex\`, the spec MUST include: (1) the specific concurrency/algorithm primitives to use (e.g. "sync.WaitGroup + buffered channel of size N", not just "use concurrency"), (2) the lifecycle of goroutines/threads (who spawns, who waits, what triggers shutdown), (3) the error propagation path (which errors cancel other work, which are collected and returned). A complex chunk without these details is not ready for delegation — the builder will invent the design and likely get it wrong, causing repeated aborts.

Chunks must be ordered so each one can build on the previous.`

const PLAN_VERIFICATION = `**Plan self-validation (mandatory, lightweight):** After the spec is written, re-read it in a separate turn and cross-check every requirement from the original task against the plan. Flag any gap — missing features, ambiguous API choices (e.g. which stdlib function to use), unhandled edge cases (signals, timeouts, concurrency). Fix gaps before proceeding to build.

**Plan verification (required for complex tasks, optional for simple):** After self-validation, decide whether the plan needs external verification.

**Skip verification when ALL of these apply:**
- Single-file change or 2 files maximum
- Well-understood pattern (e.g. adding a field, fixing a nil check, updating a constant)
- No new architecture, interfaces, or data flow
- No ambiguous requirements or multiple valid approaches

**Require verification when ANY of these apply:**
- 3+ files or 2+ chunks in the plan
- New architecture, abstraction layer, or unfamiliar pattern
- Requirements are unclear, incomplete, or have multiple interpretations
- The task involves concurrency, state machines, or distributed logic

**Verification prompt:** The verifier receives: (1) the original task description, (2) the plan spec file path. Verifier reads both, then outputs a brief markdown verdict:
- APPROVED — the plan is complete, buildable, and aligned with requirements.
- NEEDS_REVISION — list specific gaps with file/chunk references.

The verifier MUST check **build feasibility** and **complexity classification** for each chunk:
- **Build feasibility**: is the spec detailed enough that a standard-tier Builder model can implement it without inventing design decisions? Are concurrency primitives named (e.g. "use sync.WaitGroup + channels", not just "use concurrency")? Are state transitions explicit? Are synchronization points specified?
- **Complexity accuracy**: is the chunk classified correctly? A chunk using concurrency primitives, worker pools, channels, mutexes, signal handling, graph algorithms (topological sort, cycle detection, BFS/DFS), or any logic where correctness depends on subtle ordering MUST be marked \`complex\`. A chunk marked \`simple\` that contains any of these is a classification error.
- **Chunk scope**: does any single chunk combine multiple independent concurrency concerns (e.g. worker pool scheduling AND signal handling AND fail-fast cancellation)? A chunk that stacks 3+ concurrency mechanisms must be split — models spend excessive generation time reasoning about all interactions at once, frequently hitting duration limits. Split along natural seams: e.g. one chunk for the core execution loop with worker pool, a separate chunk for signal handling and graceful shutdown wired on top.
If any chunk fails either check, the verdict MUST be NEEDS_REVISION with the specific gaps listed.`

const REVIEW_PHASE = `**Review output contract:** Instruct the review agent to write its findings to a Markdown file in the Documents directory (e.g. \`.kimchi/docs/review.md\`). The file MUST contain:
- **Verdict**: APPROVED or NEEDS_FIXES
- **Issues** (if NEEDS_FIXES): numbered list, each with the file path, line reference, description of the problem, and suggested fix

The review agent runs tests, checks lint, and verifies the implementation matches the spec, then writes all findings to the review file. It must NOT fix issues itself — only report them.

**If the review agent times out or produces no output:** Retry ONCE with the same or a different standard-tier Reviewer. If the retry also fails, skip review and report to the user that review could not be completed. Do NOT attempt a third reviewer.

**Handling review results:** After the review agent completes, read ONLY the review file — do NOT re-read source files yourself. If the verdict is APPROVED, the review phase is done — produce the final summary and stop. If the verdict is NEEDS_FIXES, delegate a fix agent: pass it the review file path and the spec file path.

**Fix agent contract:** Instruct the fix agent to: (1) read the review findings file, (2) apply all fixes, (3) run the full test suite (with race/thread-safety detection if applicable) and lint, (4) write a verification report to the Documents directory (e.g. \`.kimchi/docs/verification.md\`) containing:
- **Test output**: pass/fail count, any failures
- **Lint output**: any warnings or errors
- **Verdict**: ALL_PASS or HAS_FAILURES

**After the fix agent completes:** Read ONLY the verification file — this is the ONLY action you take. Do NOT re-read source files, do NOT run tests yourself, do NOT grep, do NOT smoke-test, do NOT write any file, do NOT build the binary, do NOT create test scripts. Then:
- If the verdict is ALL_PASS -> review phase is complete. Produce ONE final summary message and stop. Do not repeat the summary.
- If the verdict is HAS_FAILURES -> this is fix round 1. Spawn ONE more fix agent with the remaining failures. When it returns its verification file, read it. That is fix round 2.
- After round 2, STOP regardless of outcome. If failures remain, report them to the user as unresolved. Do NOT attempt a third round. Do NOT debug manually. Do NOT write smoke tests. Do NOT run the binary.
- If remaining failures are tests that assert specific ordering of concurrently-executed operations (e.g. checking which goroutine/thread finishes first), these are non-deterministic test design flaws, not implementation bugs. Report them as known flaky tests and stop — do not attempt to fix non-deterministic ordering assertions.

**Review phase turn budget:** The entire review phase (from \`set_phase(review)\` to final summary) should complete in at most 10 orchestrator turns. If you are approaching 10 turns in the review phase, stop immediately and produce the summary with whatever state you have.

**Review verdicts are final**: Never edit a review report to change its verdict. If a flag is genuinely wrong, add a separate rationale note alongside the original review — do not alter the reviewer's output.`

const ORCHESTRATOR_DISCIPLINE = `**Orchestrator discipline**: Between delegation calls, you may do at most 5 tool calls (e.g. reading the spec file, setting the phase, checking a subagent result). If you find yourself doing reads, edits, bash calls, or writes on implementation files, STOP — you are doing a subagent's job. Delegate it instead. **Post-abort anti-pattern**: When a subagent aborts (budget or turns), do NOT manually complete its remaining work — this is the most common violation. Spawn a follow-up Agent scoped to the unfinished portion. List what the aborted agent completed and what remains. The orchestrator orchestrates; it does not build.`

const AGENT_MANAGEMENT = `### Agent management

- Write Agent prompts that are fully self-contained. Agents start with fresh context by default — include necessary instructions directly, or point them to a Markdown file containing larger context.
- When delegating \`plan\` before \`build\`, have the Plan agent write a Markdown spec file (full method signatures, file paths, interfaces) to the Documents directory. Pass that file path to the build Agent — it must not rediscover what was already decided.
- Spawn independent subtasks in parallel with \`run_in_background: true\`: do NOT run more than 3 concurrent Agents.
- After an Agent returns, TRUST its output unless the subagent itself reported errors or produced obviously incomplete work. Do NOT re-read source files just to verify a successful subagent's findings — this is the most common source of wasted orchestrator turns. For artifact-producing agents (Plan, Reviewer, Fixer, and Researcher when the research is non-trivial), have the subagent write its substantive output to a Markdown file in the Documents directory and return the file path. Read ONLY that file (or pass it to the next subagent). Explore is the exception: Explore agents return decision-ready findings directly in the Agent result and must not be asked to write Markdown files, reports, docs, notes, or scratch files. For build agents specifically: if the agent reports tests pass and compilation succeeds, move on to the next chunk or to review. Do NOT re-read the code it wrote. For correction tasks, call Agent again with the correction task rather than fixing inline.
- If an Agent call returns an error of any kind (including protocol violation, timeout, or exit error): do NOT attempt to implement or debug the work yourself. First assess whether the failure is retryable (e.g. transient timeouts or protocol violations) or not (e.g. missing files, permission errors, or invalid inputs). For retryable failures, call a replacement Agent with a corrected or simplified prompt — allow at most one retry per delegated step. For non-retryable failures, report the failure clearly and stop immediately without retrying.
- **When a subagent aborts due to token budget or duration limit**: the work is likely partially done. Do NOT pick up the remaining work yourself — that defeats the purpose of delegation and wastes orchestrator tokens. Instead, spawn a NEW follow-up Agent scoped to ONLY the unfinished portion. List what the first agent completed (files created, tests passing) and what remains in the follow-up prompt. Use the same or higher budget tier if the original was undersized (see multi-file package tier in budget table). **Include dependency context**: paste the public type signatures and function signatures of packages the follow-up agent will import (e.g. structs, interfaces, exported functions from earlier chunks) directly in the prompt so it does not waste turns re-reading files.
- Do NOT call Agent for work you can do in a single tool call.
- Use \`inherit_context: true\` only when the Agent needs the parent conversation history. Otherwise keep the default fresh context.
- Inline images in your conversation are forwarded automatically to vision-capable Agents when needed. If no vision-capable model is available, the harness will automatically switch to one.

### Model selection

Always pass a \`model\` parameter on every Agent call — never omit it. Default to the lightest-tier model from the relevant pool. Escalate to heavy-tier only for concurrency, algorithms, architectural reasoning, or when a standard-tier model has already failed on the same chunk. Read the model's **description** before selecting — it may reveal limitations. If the subtask involves images or visual content, select a model with Vision: yes.`

const TOKEN_BUDGETS = `### Token budgets and turn caps

Include a \`token_budget\` and \`max_turns\` for every Agent call. The token budget caps **cumulative output tokens** (tokens generated by the agent across all turns). It does not count input tokens, which grow as a side-effect of conversation length and are not controllable by the agent.

Match the budget to the **delegated task scope**, not the overall project complexity:
If the user explicitly asks for the Agent tool with a specific \`token_budget\`, make that Agent call once with the requested value. Do not ask to increase the budget or substitute a larger budget before the tool runs.

| Agent task scope | token_budget | max_turns | max_duration |
|---|---|---|---|
| Single file (one module, one test file, one doc) | 50000 | 12 | 300s |
| Multi-file package (concurrent logic, worker pools, complex state) | 150000 | 30 | 600s |
| Review (read code + write findings report) | 100000 | 20 | 600s |
| Full project or large codebase exploration | 100000 | 25 | 300s |
| Plan or research document (writing, not coding) | 60000 | 10 | 180s |

**Always set \`max_duration\`** on every Agent call. Subagents can hang on blocking operations (deadlocked tests, infinite loops, stuck network calls) where token budget and turn limits do not trigger. The duration cap is the last line of defence against runaway agents.

**Heavy-tier model duration scaling:** When delegating to a heavy-tier model, multiply \`max_duration\` by 1.5x.

Use the **multi-file package** tier when a build chunk involves concurrency primitives, worker pools, channels, or complex state machines — these require more iterative test-fix cycles than simple CRUD code. When in doubt between single-file and multi-file, prefer the larger budget — an abort followed by a follow-up agent costs more total tokens than a generous initial budget.

The turn cap prevents debug-loop budget exhaustion — an agent that hasn't converged in 12 turns is unlikely to converge in 20. If an Agent hits its budget or turn cap, spawn a follow-up with the remaining work rather than raising the budget. The follow-up prompt must list what the first agent completed and what remains.`

const PLAN_QUALITY_CHECKLIST = `### What makes a good plan

A plan is "good" when an independent model can build from it without asking questions. Verify against this checklist before calling a plan complete:

1. **Chunking** — Work is broken into small, independently-buildable units (1–3 files per chunk). Each chunk has a single focused goal and a **complexity** classification (\`simple\` or \`complex\`). Complex chunks get the multi-file-package token budget; simple chunks get the single-file budget. Both default to standard-tier Builders.
2. **Ordering** — Chunks are ordered so later ones build on earlier ones. Dependencies are explicit.
3. **Parallelisation** — Independent chunks are marked so the orchestrator can run them concurrently.
4. **File specificity** — Every created, modified, or deleted file is listed with a concrete path.
5. **Interface contracts** — Method signatures, types, and data structures are defined, not described vaguely.
6. **Acceptance criteria** — Each chunk has 2–4 concrete, verifiable criteria (e.g. "test X passes", "API returns 404 on missing item").
7. **Edge cases** — Error handling, timeouts, concurrency, empty inputs, and malformed data are addressed.
8. **Test strategy** — Every architectural layer MUST have adequate tests. If the project has a repository/data layer, it needs tests. If it has a service/domain layer, it needs tests. If it has handlers/controllers, it needs tests. If it has a CLI, it needs at least a smoke test. No layer is exempt. Target a test-to-production LOC ratio of at least 1.0. Use the language's idiomatic test patterns (Go: map-based table-driven tests with \`map[string]struct{...}\`; TypeScript: describe/it; Python: pytest parametrize). For concurrency: include a race/thread-safety detector (\`go test -race\`, \`-fsanitize=thread\`). For Go projects: always pass \`-timeout 30s\` (or an appropriate duration) to \`go test\` — tests that deadlock or block on channels will otherwise hang for the default 10 minutes, wasting agent budget. **Anti-flaky rule**: tests must NEVER assert specific ordering of concurrently-produced results. For non-deterministic collections, assert membership or sort before comparing.
9. **No ambiguity** — API choices, library versions, and design decisions are explicit. Alternatives rejected are noted in one line each.
10. **Feasibility** — The plan fits within the token budgets allocated for each chunk. No chunk requires >150k tokens to build.`

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

Before taking any action, silently reason through the steps below. Keep this reasoning internal — do not write it into your response. Proceed directly to the action.`)

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

When Step 1 classified the task as **complex**, you MUST execute it as a phased pipeline — never lump everything into a single Agent call or do it all yourself. The phases are sequential: plan -> build -> review. Each one produces an artefact the next one consumes. Follow the phase directives above for each step.`)

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
