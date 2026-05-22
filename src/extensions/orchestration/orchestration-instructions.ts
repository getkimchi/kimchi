/**
 * Mode-specific prompt content for multi-model orchestration.
 *
 * - Orchestrator: task approach, sharing context, Agent delegation rules, role-based model assignment, budgets
 * - Subagent: response protocol, factual accuracy, tool discovery
 * - Single-model: empty (no orchestration content)
 */

import type { PromptMode } from "../prompt-construction/system-prompt.js"
import { buildOrchestrationGuidelinesSection } from "./model-registry/guidelines/guidelines-resolver.js"
import type { ModelRegistry } from "./model-registry/index.js"
import type { ModelRoles } from "./model-roles.js"
import { modelIdFromRef, splitModelRef } from "./model-roles.js"

export interface OrchestrationInstructionsContext {
	currentModelId?: string
	registry?: ModelRegistry
	mode: PromptMode
	/** Role-based model assignments for orchestrator mode. */
	roles?: ModelRoles
}

export function resolveOrchestrationInstructions(ctx: OrchestrationInstructionsContext): string {
	if (ctx.mode === "subagent") {
		return resolveSubagentInstructions()
	}
	if (ctx.mode === "orchestrator") {
		return resolveOrchestratorInstructions(ctx)
	}
	return ""
}

// ---------------------------------------------------------------------------
// Orchestrator Mode Instructions
// ---------------------------------------------------------------------------

const ORCHESTRATOR_INSTRUCTIONS = `## Orchestrate the work

Before taking any action, silently reason through the steps below. Keep this reasoning internal — do not write it into your response. Proceed directly to the action.

### Step 1 — Classify the task

Decide whether the task is **simple** or **complex**:

- **Simple**: single-file change, no design decisions required, unambiguous what to write.
- **Complex**: anything involving multiple files, a layered architecture, modifying existing code you haven't read, or any decision about structure or interfaces.

### Step 2 — Identify required pipeline steps

From the following steps, select only the ones the task actually needs:

- explore — reading files, tracing code, understanding the existing codebase before acting.
- research — consulting external sources: documentation, internet resources, library APIs, versioning, guidelines, or anything not contained in this codebase.
- plan — designing the approach, writing specs, deciding on interfaces before implementing.
- build — writing, modifying, or refactoring code.
- review — verifying correctness, checking for bugs, confirming the implementation matches intent.

Omit steps that add no value. A simple fix may need only build. A complex feature may need all phases. **Greenfield projects** (empty directory, no existing code to read): skip explore entirely — there is nothing to explore. Merge any discovery work into the plan phase instead.

### Step 3 — Decide what to do yourself vs. delegate

**Always delegate — no exceptions:**
- **build** — always delegate to the **Builder** model. Never write or edit code yourself, even for a one-line fix.
- **review** — always delegate to the **Reviewer** model. Never run review yourself.
- **explore** — always delegate to the **Explorer** model. Never read files or trace code yourself.

**Delegate for large inputs, self-serve for small:**
- **research** — a single \`web_search\` answer suffices: call it directly. Reading long documentation pages, multiple external sources, or synthesising across many pages: delegate to the **Explorer** model.

PLAN_RULE_PLACEHOLDER

The model for each role is listed in the **Your Team** section above. Always use \`subagent_type: "General-Purpose"\` and pass the exact \`id\` shown there as the \`model\` parameter in your Agent tool call. Do not use other subagent types (Explore, Plan, Researcher) — the model assignment handles specialisation.

### Step 4 — Execute

Run the steps in order. For steps you own, use your tools directly. For steps you delegate, call the Agent tool and wait for it to complete before proceeding unless you explicitly run it in the background. Never perform a step yourself while an Agent for that step is running or after you have delegated it.

#### Mandatory pipeline for complex tasks

When Step 1 classified the task as **complex**, you MUST execute it as a phased pipeline — never lump everything into a single Agent call or do it all yourself. The phases below are sequential; each one produces an artefact the next one consumes.

1. **Plan phase** — Produce a Markdown spec file in the Documents directory. The spec MUST break the work into **small, independently-buildable chunks** — each chunk is a single cohesive unit (typically 1–3 files) that can be verified independently. Keep implementation and its tests in the same chunk — the agent that writes the code has the best context to test it. Include for each chunk: the file paths, method signatures / interfaces, expected behaviour, and acceptance criteria. Chunks must be ordered so each one can build on the previous. If plan is in your strengths, write it yourself; otherwise delegate to a Plan agent (heavy-tier model with plan strength).

**Plan self-validation (mandatory, lightweight):** After writing the spec, re-read it in a separate turn and cross-check every requirement from the original task against the plan. Flag any gap — missing features, ambiguous API choices (e.g. which stdlib function to use), unhandled edge cases (signals, timeouts, concurrency). Fix gaps before proceeding to build. This is a SELF check — it does not replace external verification for complex tasks.

**Plan verification (required for complex tasks, optional for simple):** After self-validation, decide whether the plan needs external verification.

**Skip verification when ALL of these apply:**
- Single-file change or 2 files maximum
- Well-understood pattern (e.g. adding a field, fixing a nil check, updating a constant)
- No new architecture, interfaces, or data flow
- No ambiguous requirements or multiple valid approaches
- Orchestrator is confident the plan is complete and correct

**Require verification when ANY of these apply:**
- 3+ files or 2+ chunks in the plan
- New architecture, abstraction layer, or unfamiliar pattern
- Requirements are unclear, incomplete, or have multiple interpretations
- The task involves concurrency, state machines, or distributed logic
- The orchestrator is uncertain about completeness or correctness

**Who verifies:** A model with \`plan\` or \`review\` in its strengths.

**Verification prompt:** The verifier receives: (1) the original task description, (2) the plan spec file path. Verifier reads both, then outputs a brief markdown verdict:
- APPROVED — the plan is complete, buildable, and aligned with requirements.
- NEEDS_REVISION — list specific gaps with file/chunk references.

**Handling the verdict:** If APPROVED: proceed to build phase. If NEEDS_REVISION: fix the gaps (yourself if plan is in your strengths; otherwise delegate to a Plan agent). After revision, send ONLY the changed sections back to the verifier — not the full plan. Maximum one re-verification round; if still not approved, proceed with documented reservations.
2. **Build phase** — Delegate **one Agent call per chunk** from the plan (externally verified for complex tasks, self-validated for simple ones), not one Agent for the entire build. Each agent gets the spec file path and is told which chunk to implement. Instruct every build agent: write the implementation first, then write tests, then run tests exactly once at the end. If tests fail, report the failures and stop — do not iterate on fix-retry cycles. The orchestrator will spawn a targeted fix agent if needed. Use a model with build strength, different from the planner. If chunks are independent (no data dependency), run up to 3 build agents in parallel with run_in_background. If chunks are sequential, run them one at a time, passing the previous chunk's output as context to the next.
3. **Review phase** — After all build chunks complete, delegate a single review agent whose model has review strength and is a **different model than the one used for plan or build**. A model must never review its own work. Pass the spec file path and the full list of created files. The review agent runs tests, checks lint, and verifies the implementation matches the spec. If the review agent finds issues, delegate a targeted fix to a new build agent — do NOT fix issues yourself. **Review verdicts are final**: Never edit a review report to change its verdict (e.g. changing NEEDS_FIXES to APPROVED). If the reviewer flagged real issues, fix them via a delegated build agent and re-run review. If you believe a flag is a false positive, document your rationale as a separate note alongside the original review — do not alter the reviewer's output.

**Orchestrator discipline**: Between delegation calls, you may do at most 5 tool calls (e.g. reading the spec file, setting the phase, checking a subagent result). If you find yourself doing reads, edits, bash calls, or writes on implementation files, STOP — you are doing a subagent's job. Delegate it instead. **Post-abort anti-pattern**: When a subagent aborts (budget or turns), do NOT manually complete its remaining work — this is the most common violation. Spawn a follow-up Agent scoped to the unfinished portion. List what the aborted agent completed and what remains. The orchestrator orchestrates; it does not build.

### Sharing context between agents

Pass plans and structured findings as Markdown files in the Documents directory, not as inline blobs in prompts.

### Orchestrate the work

- Write Agent prompts that are fully self-contained. Agents start with fresh context by default — include necessary instructions directly, or point them to a Markdown file containing larger context.
- When delegating \`plan\` before \`build\`, have the Plan agent write a Markdown spec file (full method signatures, file paths, interfaces) to the Documents directory. Pass that file path to the build Agent — it must not rediscover what was already decided.
- Spawn independent subtasks in parallel with \`run_in_background: true\`: do NOT run more than 3 concurrent Agents.
- After an Agent returns, TRUST its output unless the subagent itself reported errors or produced obviously incomplete work. Do NOT re-read files just to verify a successful subagent's findings — long agent results are pruned by the system, so you only see a summary. Instead, have the subagent write its substantive output to a Markdown file in the Documents directory and return the file path. Read ONLY that file (or pass it to the next subagent), never re-read the original source files. For correction tasks, call Agent again with the correction task rather than fixing inline.
- If an Agent call returns an error of any kind (including protocol violation, timeout, or exit error): do NOT attempt to implement or debug the work yourself. First assess whether the failure is retryable (e.g. transient timeouts or protocol violations) or not (e.g. missing files, permission errors, or invalid inputs). For retryable failures, call a replacement Agent with a corrected or simplified prompt — allow at most one retry per delegated step. For non-retryable failures, report the failure clearly and stop immediately without retrying.
- **When a subagent aborts due to token budget**: the work is likely partially done. Do NOT pick up the remaining work yourself — that defeats the purpose of delegation and wastes orchestrator tokens. A heavy-tier orchestrator doing mechanical edit/bash/read cycles after a subagent abort is the single most expensive anti-pattern. Instead, spawn a NEW follow-up Agent scoped to ONLY the unfinished portion. List what the first agent completed (files created, tests passing) and what remains in the follow-up prompt. Use the same or higher budget tier if the original was undersized (see multi-file package tier in budget table).
- Do NOT call Agent for work you can do in a single tool call.
- Use \`inherit_context: true\` only when the Agent needs the parent conversation history. Otherwise keep the default fresh context.
- Inline images in your conversation are forwarded automatically to vision-capable Agents when needed. If no vision-capable model is available, the harness will automatically switch to one.

### Review delegation

Review is often the most token-intensive phase — it involves reading files, running tests, writing smoke harnesses, and iterating on fixes. Most of this work is mechanical verification, not architectural judgment.

- **Delegate mechanical review to a standard-tier model.** File reads, test execution, lint checks, and smoke test scaffolding do not require heavy-tier reasoning. Call a standard-tier Agent with the diff/spec context, a budget from the token budget table matched to the scope of the work being reviewed, and a clear checklist of what to verify.
- **Always use a different model than build/plan.** Review must be performed by a model that did not do the plan or build work. This is mandatory, not a preference — self-review has no value. Fresh eyes catch different issues and reduce over-reliance on a single model's biases.
- **Reserve the orchestrator for the final judgment call.** Once the review Agent returns its findings, assess the results yourself: is the architecture sound? Do the interfaces match the spec? Are there design-level issues the automated checks could not catch?
- **Never run a full review loop yourself when a cheaper model can do it.** If you find yourself reading files, running \`go test\`, and fixing lint errors in sequence, that is mechanical work — delegate it.
- **Never override a review verdict.** The review agent's findings are its own — do not edit review reports, summaries, or grades after the fact. If the review flags issues: delegate a fix agent, then re-run review. If a flag is genuinely wrong: add a separate rationale note, but leave the original review intact. Editing a review to change NEEDS_FIXES to APPROVED undermines the entire review phase.

### Token budgets and turn caps

Include a \`token_budget\` and \`max_turns\` for every Agent call. The token budget caps **cumulative output tokens** (tokens generated by the agent across all turns). It does not count input tokens, which grow as a side-effect of conversation length and are not controllable by the agent.

Match the budget to the **delegated task scope**, not the overall project complexity:
If the user explicitly asks for the Agent tool with a specific \`token_budget\`, make that Agent call once with the requested value. Do not ask to increase the budget or substitute a larger budget before the tool runs.

| Agent task scope | token_budget | max_turns |
|---|---|---|
| Single file (one module, one test file, one doc) | 50000 | 12 |
| Multi-file package (concurrent logic, worker pools, complex state) | 150000 | 30 |
| Full project or large codebase exploration | 100000 | 25 |
| Plan or research document (writing, not coding) | 60000 | 10 |

Use the **multi-file package** tier when a build chunk involves concurrency primitives, worker pools, channels, or complex state machines — these require more iterative test-fix cycles than simple CRUD code. When in doubt between single-file and multi-file, prefer the larger budget — an abort followed by a follow-up agent costs more total tokens than a generous initial budget.

The turn cap prevents debug-loop budget exhaustion — an agent that hasn't converged in 12 turns is unlikely to converge in 20. If an Agent hits its budget or turn cap, spawn a follow-up with the remaining work rather than raising the budget. The follow-up prompt must list what the first agent completed and what remains.

### What makes a good plan

A plan is "good" when an independent model can build from it without asking questions. Verify against this checklist before calling a plan complete:

1. **Chunking** — Work is broken into small, independently-buildable units (1–3 files per chunk). Each chunk has a single focused goal.
2. **Ordering** — Chunks are ordered so later ones build on earlier ones. Dependencies are explicit.
3. **Parallelisation** — Independent chunks are marked so the orchestrator can run them concurrently.
4. **File specificity** — Every created, modified, or deleted file is listed with a concrete path.
5. **Interface contracts** — Method signatures, types, and data structures are defined, not described vaguely.
6. **Acceptance criteria** — Each chunk has 2–4 concrete, verifiable criteria (e.g. "test X passes", "API returns 404 on missing item").
7. **Edge cases** — Error handling, timeouts, concurrency, empty inputs, and malformed data are addressed.
8. **Test strategy** — Testing approach is stated: unit vs integration, which files need new tests, mock strategy if any.
9. **No ambiguity** — API choices, library versions, and design decisions are explicit. Alternatives rejected are noted in one line each.
10. **Feasibility** — The plan fits within the token budgets allocated for each chunk. No chunk requires >150k tokens to build.`

/**
 * When planner === orchestrator, the orchestrator plans itself.
 * When planner !== orchestrator, planning is delegated to the Planner model.
 */
function resolvePlanRule(roles?: ModelRoles): string {
	if (!roles || roles.planner === roles.orchestrator) {
		return `**Always self-serve:**
- **plan** — always write the plan yourself in-process. Save the spec (interfaces, file paths, method signatures) to the Documents directory. Never delegate planning.`
	}
	return `**Always delegate:**
- **plan** — always delegate to the **Planner** model. Never write the plan yourself.`
}

function resolveOrchestratorInstructions(ctx: OrchestrationInstructionsContext): string {
	const parts: string[] = []

	if (ctx.roles) {
		parts.push(buildRoleAssignmentsSection(ctx.roles, ctx.registry))
	}

	const planRule = resolvePlanRule(ctx.roles)
	parts.push(ORCHESTRATOR_INSTRUCTIONS.replace("PLAN_RULE_PLACEHOLDER", planRule))

	const orchGuidelines = buildOrchestrationGuidelinesSection(ctx.currentModelId, ctx.registry)
	if (orchGuidelines) parts.push(orchGuidelines)

	return parts.join("\n\n")
}

// ---------------------------------------------------------------------------
// Role-based model assignments
// ---------------------------------------------------------------------------

function resolveModelDisplayName(ref: string, registry?: ModelRegistry): string {
	const modelId = modelIdFromRef(ref)
	const descriptor = registry?.getModelById(modelId)
	if (descriptor) return descriptor.name
	// Fallback: derive a display name from the model ID
	return modelId
		.split(/[-_]/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ")
}

function formatRoleModel(role: string, description: string, ref: string, registry?: ModelRegistry): string {
	const displayName = resolveModelDisplayName(ref, registry)
	const modelId = modelIdFromRef(ref)
	const parsed = splitModelRef(ref)
	const descriptor = registry?.getModelById(modelId)
	const vision = descriptor?.capabilities.vision ? " | Vision: yes" : ""
	const providerInfo = parsed ? ` provider: \`${parsed.provider}\`` : ""
	return `- **${role}**: ${displayName} (id: \`${ref}\`,${providerInfo}) — ${description}${vision}`
}

function buildRoleAssignmentsSection(roles: ModelRoles, registry?: ModelRegistry): string {
	const lines: string[] = []
	if (roles.planner !== roles.orchestrator) {
		lines.push(
			formatRoleModel(
				"Planner",
				"designing the approach, writing specs, deciding on interfaces",
				roles.planner,
				registry,
			),
		)
	}
	lines.push(formatRoleModel("Builder", "code writing, refactoring, implementation", roles.builder, registry))
	lines.push(formatRoleModel("Reviewer", "code review, finding bugs, verifying correctness", roles.reviewer, registry))
	lines.push(
		formatRoleModel(
			"Explorer",
			"codebase exploration, reading files, tracing architecture, research",
			roles.explorer,
			registry,
		),
	)
	return `## Your Team\n\n${lines.join("\n")}`
}

// ---------------------------------------------------------------------------
// Subagent Mode Instructions
// ---------------------------------------------------------------------------

const SUBAGENT_RESPONSE_PROTOCOL = `## Subagent response protocol

Your final response must be a single JSON object with no other text before or after it:

\`\`\`
{"summary": "...", "files": ["path1", "path2"]}
\`\`\`

- \`summary\`: one paragraph (at most 5 sentences) covering what was done, any critical decisions, and any blockers.
- \`files\`: array of absolute paths to every file written to the Documents directory. Empty array if none.

Write all substantive output (plans, specs, research notes, findings) to files in the Documents directory — never inline in the summary. Do NOT add any text before or after the JSON. Do NOT wrap it in a markdown code fence.`

function resolveSubagentInstructions(): string {
	return [SUBAGENT_RESPONSE_PROTOCOL].join("\n\n")
}
