/**
 * Mode-specific prompt content for multi-model orchestration.
 *
 * - Orchestrator: task approach, sharing context, Agent delegation rules, role-based model selection, budgets
 * - Subagent: response protocol, factual accuracy, tool discovery
 * - Single-model: empty (no orchestration content)
 */

import type { PromptMode } from "../prompt-construction/system-prompt.js"
import { buildOrchestrationGuidelinesSection } from "./model-registry/guidelines/guidelines-resolver.js"
import type { ModelRegistry } from "./model-registry/index.js"
import type { OrchestrationModelDescriptor } from "./model-registry/types.js"
import type { ModelRoles, RoleModelAssignment } from "./model-roles.js"
import { modelIdFromRef, normalizeRoleModels, splitModelRef } from "./model-roles.js"

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
	if (ctx.mode === "single") {
		return resolveSingleModelInstructions(ctx.currentModelId)
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

Omit steps that add no value. A simple fix may need only build. A complex feature may need all phases. **Match the pipeline to the request**: if the user asks to review code, run explore + review — not plan + build + review. If the user asks to plan an approach, run explore + plan — not the full pipeline. If the user asks to explore or research, do only that. The mandatory plan→build→review pipeline applies only when the task involves writing or modifying code. **Greenfield projects** (empty directory, no existing code to read): skip explore entirely — there is nothing to explore. Merge any discovery work into the plan phase instead.

**Intent boundary — never exceed what was asked.** The selected pipeline is the scope ceiling. No agent — orchestrator or subagent — may perform actions that belong to a pipeline step not selected above. Concrete rules:
- If the pipeline does not include **build**, no source files may be created, modified, or deleted. No commits may be made. Findings and suggestions are reported, never applied.
- If the pipeline does not include **plan**, no spec or design document is produced — the task is executed or evaluated directly.
- If the pipeline is **review-only** (explore + review), the output is a findings report. Do not fix, refactor, or apply any of the reported issues. Do not offer to apply fixes inline. Report what you found and stop.
- If the pipeline is **explore-only** or **research-only**, produce a summary. Do not plan, build, or review.

When delegating to subagents, include the intent boundary explicitly in the agent prompt so the subagent knows what it must not do.

### Step 3 — Decide what to do yourself vs. delegate

Look at **Your Capabilities** above. Your roles are the authoritative signal — not your confidence, not your general intelligence:

- If a step matches your roles, **do it yourself** — unless the workload is large enough that a cheaper model from the matching pool would be more efficient. In particular: if plan is in your roles, you write the plan yourself. For explore, you may delegate to a lighter model from the Explorer pool when the exploration involves many files; for a few files, do it yourself.
- **Exception — review must always be delegated**: You MUST delegate review to an Agent from the Reviewer pool. The review agent runs in a separate, fresh context — it has no memory of earlier planning or build decisions, which provides independence. When selecting the reviewer, **prefer a standard-tier Reviewer** that can reliably complete within the timeout — heavy-tier models are slower and more prone to timing out as subagents. Only use a heavy-tier Reviewer when the code involves complex concurrency, security-critical logic, or novel architectural patterns. The same model family in a fresh context is far better than a weaker model with a different name.
- If a step does not match your roles, delegate it to a model from the matching role pool in **Your Team** — regardless of whether you think you could attempt it.
- When a role pool has multiple models, match the model's **tier** to the task complexity: use the heaviest model for complex or ambiguous work, the lightest for mechanical work.
- If your tier is heavy: for each step the task needs, apply the previous rules. In practice this means **you write the plan yourself in-process** (heavy-tier orchestrators always list plan among their roles), save the spec file (interfaces, file paths, method signatures) to the Documents directory, then delegate only the steps you do not own — typically build — to a cheaper Agent call, passing the spec file path.
- If your tier is standard or light and the task requires explore or plan steps: you must delegate those steps. Your roles list is the gate — if a step type is not listed there, you are not qualified to perform it regardless of task scope or apparent simplicity.
- **Exception — simple research (overrides every rule above)**: If a task only needs a quick factual lookup (e.g. library comparisons, version numbers, API references, a single fact), call web_search directly and answer from the results — do NOT delegate to an Agent. For simple lookups this is strictly cheaper, faster, and more reliable than spawning an Agent. The roles-based delegation rules apply only when research requires deep analysis, reading multiple long documents, or synthesising information across many sources.

The goal is to use the model best suited for each step, not the one already running. Pick the persona and model for each step from **Your Team**. You MUST always pass a concrete \`model\` — never omit it:
- Build chunks -> Agent(type: "Builder", model: <standard-tier model for simple chunks, heavy-tier for complex>)
- Code review -> Agent(type: "Reviewer", model: <standard-tier model>)
- Fix review issues -> Agent(type: "Fixer", model: <standard-tier model>)
- Explore codebase -> Agent(type: "Explore", model: <light-tier or standard-tier model>)
- Verify plan -> Agent(type: "Plan", model: <heavy-tier model>)

### Step 4 — Execute

Run the steps in order. For steps you own, use your tools directly. For steps you delegate, call the Agent tool and wait for it to complete before proceeding unless you explicitly run it in the background. Never perform a step yourself while an Agent for that step is running or after you have delegated it.

#### Mandatory pipeline for complex tasks

When Step 1 classified the task as **complex**, you MUST execute it as a phased pipeline — never lump everything into a single Agent call or do it all yourself. The phases below are sequential; each one produces an artefact the next one consumes.

1. **Plan phase** — Produce a Markdown spec file in the Documents directory. The spec MUST break the work into **small, independently-buildable chunks** — each chunk is a single cohesive unit (typically 1–3 files) that can be verified independently. Keep implementation and its tests in the same chunk — the agent that writes the code has the best context to test it. Include for each chunk: the file paths, method signatures / interfaces, expected behaviour, acceptance criteria, and a **complexity** classification:
   - **simple** — straightforward CRUD, data structures, boilerplate, CLI wiring, simple input parsing. A standard-tier Builder can implement this from the spec alone.
   - **complex** — concurrency (goroutines, threads, channels, mutexes, worker pools), state machines, graph algorithms (topological sort, cycle detection, BFS/DFS), dynamic programming, signal handling, tricky synchronization, or any logic where correctness depends on subtle ordering or edge cases. Requires a heavy-tier Builder.

**What makes a good complex chunk spec:** For each chunk classified as \`complex\`, the spec MUST include: (1) the specific concurrency/algorithm primitives to use (e.g. "sync.WaitGroup + buffered channel of size N", not just "use concurrency"), (2) the lifecycle of goroutines/threads (who spawns, who waits, what triggers shutdown), (3) the error propagation path (which errors cancel other work, which are collected and returned). A complex chunk without these details is not ready for delegation — the builder will invent the design and likely get it wrong, causing repeated aborts.

Chunks must be ordered so each one can build on the previous. If plan is in your roles, write it yourself; otherwise delegate to a Planner agent.

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

**Who verifies:** A model with \`plan\` or \`review\` in its roles. Read the model descriptions to pick the right verifier — checklist-style verification can use a standard-tier model, but plans involving concurrency or algorithmic design need a model whose description confirms it can reason about correctness.

**Verification prompt:** The verifier receives: (1) the original task description, (2) the plan spec file path. Verifier reads both, then outputs a brief markdown verdict:
- APPROVED — the plan is complete, buildable, and aligned with requirements.
- NEEDS_REVISION — list specific gaps with file/chunk references.

The verifier MUST check **build feasibility** and **complexity classification** for each chunk:
- **Build feasibility**: is the spec detailed enough that a standard-tier Builder model can implement it without inventing design decisions? Are concurrency primitives named (e.g. "use sync.WaitGroup + channels", not just "use concurrency")? Are state transitions explicit? Are synchronization points specified?
- **Complexity accuracy**: is the chunk classified correctly? A chunk using concurrency primitives, worker pools, channels, mutexes, signal handling, graph algorithms (topological sort, cycle detection, BFS/DFS), or any logic where correctness depends on subtle ordering MUST be marked \`complex\`. A chunk marked \`simple\` that contains any of these is a classification error.
- **Chunk scope**: does any single chunk combine multiple independent concurrency concerns (e.g. worker pool scheduling AND signal handling AND fail-fast cancellation)? A chunk that stacks 3+ concurrency mechanisms must be split — models spend excessive generation time reasoning about all interactions at once, frequently hitting duration limits. Split along natural seams: e.g. one chunk for the core execution loop with worker pool, a separate chunk for signal handling and graceful shutdown wired on top.
If any chunk fails either check, the verdict MUST be NEEDS_REVISION with the specific gaps listed.

**Handling the verdict:** If APPROVED: proceed to build phase. If NEEDS_REVISION: fix the gaps (yourself if plan is in your roles; otherwise delegate to a Planner agent). After revision, send ONLY the changed sections back to the verifier — not the full plan. Maximum one re-verification round; if still not approved, proceed with documented reservations.
2. **Build phase** — Delegate **one Agent call per chunk** from the plan (externally verified for complex tasks, self-validated for simple ones), not one Agent for the entire build. Each agent gets the spec file path and is told which chunk to implement. Instruct every build agent to: (1) write the implementation, (2) write tests, (3) verify the code compiles and passes lint, (4) run tests exactly once. If compilation fails or tests fail, report the failures and stop — do not iterate on fix-retry cycles. The orchestrator will spawn a targeted fix agent if needed. If chunks are independent (no data dependency), run up to 3 build agents in parallel with run_in_background. If chunks are sequential, run them one at a time, passing the previous chunk's output as context to the next. **Model selection for builders**: use a standard-tier Builder for all chunks. Standard-tier models are faster and more reliable within subagent time/token budgets. Reserve heavy-tier Builders only as a fallback when a standard-tier Builder has already failed on the same chunk.
**Build-to-review transition**: When the last build chunk's subagent completes, transition to review phase immediately. Do NOT read the subagent's output files yourself, do NOT run tests yourself, do NOT verify the code. Trust the subagent's completion report. The Reviewer subagent will independently verify everything in a fresh context — that is the whole point of the review phase.
3. **Review phase** — After all build chunks complete, delegate a single review agent. Prefer a **standard-tier Reviewer** that reliably completes within the timeout. Only use a heavy-tier Reviewer for complex concurrency, security-critical logic, or novel architectural patterns — and if you do, apply heavy-tier duration scaling (1.5x max_duration). The review agent runs in a fresh context with no memory of earlier work. Pass the spec file path and the full list of created files. **Review delegation is mandatory** — you MUST spawn a Reviewer Agent even if you already ran tests during build. Your in-process verification is not a substitute: you have context bias from planning and building; the reviewer does not.

**Review output contract:** Instruct the review agent to write its findings to a Markdown file in the Documents directory (e.g. \`.kimchi/docs/review.md\`). The file MUST contain:
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
- If the verdict is ALL_PASS → review phase is complete. Produce ONE final summary message and stop. Do not repeat the summary.
- If the verdict is HAS_FAILURES → this is fix round 1. Spawn ONE more fix agent with the remaining failures. When it returns its verification file, read it. That is fix round 2.
- After round 2, STOP regardless of outcome. If failures remain, report them to the user as unresolved. Do NOT attempt a third round. Do NOT debug manually. Do NOT write smoke tests. Do NOT run the binary.
- If remaining failures are tests that assert specific ordering of concurrently-executed operations (e.g. checking which goroutine/thread finishes first), these are non-deterministic test design flaws, not implementation bugs. Report them as known flaky tests and stop — do not attempt to fix non-deterministic ordering assertions.

**Review phase turn budget:** The entire review phase (from \`set_phase(review)\` to final summary) should complete in at most 10 orchestrator turns: 1 turn to dispatch the reviewer, 1 turn to read the review file, 1 turn to dispatch the fixer (if needed), 1 turn to read the verification file, 1 turn for a possible second fix round, 1 turn for the final summary. If you are approaching 10 turns in the review phase, stop immediately and produce the summary with whatever state you have.

**Review verdicts are final**: Never edit a review report to change its verdict. If a flag is genuinely wrong, add a separate rationale note alongside the original review — do not alter the reviewer's output.

**Orchestrator discipline**: Between delegation calls, you may do at most 5 tool calls (e.g. reading the spec file, setting the phase, checking a subagent result). If you find yourself doing reads, edits, bash calls, or writes on implementation files, STOP — you are doing a subagent's job. Delegate it instead. **Post-abort anti-pattern**: When a subagent aborts (budget or turns), do NOT manually complete its remaining work — this is the most common violation. Spawn a follow-up Agent scoped to the unfinished portion. List what the aborted agent completed and what remains. The orchestrator orchestrates; it does not build.

### Sharing context between agents

Pass plans and structured findings as Markdown files in the Documents directory, not as inline blobs in prompts.

### Agent management

- Write Agent prompts that are fully self-contained. Agents start with fresh context by default — include necessary instructions directly, or point them to a Markdown file containing larger context.
- When delegating \`plan\` before \`build\`, have the Plan agent write a Markdown spec file (full method signatures, file paths, interfaces) to the Documents directory. Pass that file path to the build Agent — it must not rediscover what was already decided.
- Spawn independent subtasks in parallel with \`run_in_background: true\`: do NOT run more than 3 concurrent Agents.
- After an Agent returns, TRUST its output unless the subagent itself reported errors or produced obviously incomplete work. Do NOT re-read source files just to verify a successful subagent's findings — this is the most common source of wasted orchestrator turns. Instead, have the subagent write its substantive output to a Markdown file in the Documents directory and return the file path. Read ONLY that file (or pass it to the next subagent). For build agents specifically: if the agent reports tests pass and compilation succeeds, move on to the next chunk or to review. Do NOT re-read the code it wrote. For correction tasks, call Agent again with the correction task rather than fixing inline.
- If an Agent call returns an error of any kind (including protocol violation, timeout, or exit error): do NOT attempt to implement or debug the work yourself. First assess whether the failure is retryable (e.g. transient timeouts or protocol violations) or not (e.g. missing files, permission errors, or invalid inputs). For retryable failures, call a replacement Agent with a corrected or simplified prompt — allow at most one retry per delegated step. For non-retryable failures, report the failure clearly and stop immediately without retrying.
- **When a subagent returns agent_outcome.outcome other than "completed"**: the work is likely partial or invalid. Do NOT pick up the remaining work yourself — that defeats the purpose of delegation and wastes orchestrator tokens. Inspect agent_outcome.report before acting. Resume the same Agent only when remaining_steps are a direct continuation and preserving session context is valuable; use a changed-approach resume when the same thread still matters but the prior approach stalled; spawn a NEW follow-up Agent when remaining_steps have a clean narrower task boundary; run a short finalizer resume when the report is missing or the work appears finished but did not return completed; or stop/skip and report when blocked or unclear. Do not blindly retry the same prompt. **Include dependency context** in any replacement prompt: paste the public type signatures and function signatures of packages the follow-up agent will import (e.g. structs, interfaces, exported functions from earlier chunks) directly in the prompt so it does not waste turns re-reading files.
- Do NOT call Agent for work you can do in a single tool call.
- Use \`inherit_context: true\` only when the Agent needs the parent conversation history. Otherwise keep the default fresh context.
- Inline images in your conversation are forwarded automatically to vision-capable Agents when needed. If no vision-capable model is available, the harness will automatically switch to one.

### Model selection for delegation

You MUST always pass a \`model\` parameter on every Agent call — never omit it. Use the **Your Team** section above to pick the right model. Read each model's **description** and **tier** to match it to the task.

- **Standard-tier models** for well-scoped tasks: CRUD, straightforward tests, mechanical fixes, code review, applying review findings.
- **Heavy-tier models** for complex work: concurrency, graph algorithms, architectural reasoning, plan verification. Also use heavy-tier as a retry when a standard-tier model has failed on the same chunk.
- **Light-tier models** for trivial work: codebase exploration, simple verification.
- Read the model's **description** before selecting — a model in a role pool is a candidate, not a guarantee. Its description may reveal limitations.
- If the subtask involves images or visual content, select a model with \`Vision: yes\`.
- **Default to the lightest model that can handle the work.** Only escalate tier when the task genuinely requires it.

### Review delegation

The full review/fix/verification contract is described in the **Review phase** of the mandatory pipeline above. In summary: delegate to a standard-tier Reviewer (reliable completion outweighs thoroughness — use heavy-tier only for complex concurrency or security-critical code), require a findings file, pass it to a fix agent if needed, read only the verification report, and stop after at most 2 fix rounds. The entire review phase must complete in at most 10 orchestrator turns.

### Token budgets and turn caps

Include a \`max_turns\` for every Agent call. Use \`token_budget\` when the caller or task scope needs an output-token cap; it caps **cumulative output tokens** (tokens generated by the agent across all turns). It does not count input tokens, which grow as a side-effect of conversation length and are not controllable by the agent.

Match the budget to the **delegated task scope**, not the overall project complexity:
If the user explicitly asks for the Agent tool with a specific \`token_budget\`, make that Agent call once with the requested value. Do not ask to increase the budget or substitute a larger budget before the tool runs.

| Agent task scope | max_turns | max_duration | optional token_budget |
|---|---|---|---|
| Single file (one module, one test file, one doc) | 12 | 300s | 50000 |
| Multi-file package (concurrent logic, worker pools, complex state) | 30 | 600s | 150000 |
| Review (read code + write findings report) | 20 | 600s | 100000 |
| Full project or large codebase exploration | 25 | 300s | 100000 |
| Plan or research document (writing, not coding) | 10 | 180s | 60000 |

**Always set \`max_duration\`** on every Agent call. Subagents can hang on blocking operations (deadlocked tests, infinite loops, stuck network calls) where token budget and turn limits do not trigger. The duration cap is the last line of defence against runaway agents.

**Heavy-tier model duration scaling:** When delegating to a heavy-tier model (high per-token cost, slower generation), multiply \`max_duration\` by 1.5x. A task that needs 600s with a standard-tier model needs 900s with a heavy-tier model. **However, prefer standard-tier models for build subagents** — heavy-tier models frequently time out as subagents because they spend too long reasoning before acting. Use heavy-tier builders only as a retry after a standard-tier builder has already failed on the same chunk.

Use the **multi-file package** tier when a build chunk involves concurrency primitives, worker pools, channels, or complex state machines — these require more iterative test-fix cycles than simple CRUD code. When in doubt between single-file and multi-file, prefer the larger budget — an abort followed by a follow-up agent costs more total tokens than a generous initial budget.

The turn cap is the primary delegated-worker budget. If an Agent returns \`agent_outcome.outcome: "budget_exhausted"\`, do not mark the delegated work complete from that aborted result. Inspect \`agent_outcome.report\` and choose deliberately:

| Signal | Action |
|---|---|
| Completed outcome + report.status completed | Use the result or complete the linked Ferment step. |
| Missing report | Resume the same Agent with \`max_turns: 1\` and instruct it to call \`submit_agent_report\` without doing more task work. |
| Budget exhausted + direct continuation in remaining_steps | Resume the same Agent with a bounded fresh \`max_turns\` allocation and a steering prompt. |
| Budget exhausted + same thread but stalled approach | Resume the same Agent once with a changed-approach steering prompt. |
| Budget exhausted + separable remaining_steps | Spawn a narrower linked replacement Agent for the clean task boundary. |
| Budget exhausted + appears finished | Run a short finalizer resume, then complete only from a completed outcome. |
| Max duration or inactivity | Assume a possible hang or blocked operation; resume only if the steering prompt avoids the stall, otherwise spawn a narrower replacement or stop/report. |
| Failed, stopped, blocked, or unclear report | Spawn a corrected replacement only if there is a clear task boundary; otherwise stop/skip and report the worker report. |

### What makes a good plan

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

function resolveOrchestratorInstructions(ctx: OrchestrationInstructionsContext): string {
	const parts: string[] = []

	if (ctx.roles && ctx.registry) {
		parts.push(buildRoleAssignmentsSection(ctx.roles, ctx.registry, ctx.currentModelId))
	}

	parts.push(ORCHESTRATOR_INSTRUCTIONS)

	const orchGuidelines = buildOrchestrationGuidelinesSection(ctx.currentModelId, ctx.registry)
	if (orchGuidelines) parts.push(orchGuidelines)

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

function formatModelEntry(ref: string, registry?: ModelRegistry): string {
	const displayName = resolveModelDisplayName(ref, registry)
	const descriptor = resolveDescriptor(ref, registry)
	const parsed = splitModelRef(ref)
	const providerInfo = parsed ? `, provider: \`${parsed.provider}\`` : ""

	const tierInfo = descriptor ? `Tier: ${descriptor.capabilities.tier}` : ""
	const vision = descriptor?.capabilities.vision ? " | Vision: yes" : ""
	const description = descriptor?.capabilities.description ?? ""

	const meta = [tierInfo, vision].filter(Boolean).join("")
	const metaSuffix = meta ? ` — ${meta}` : ""

	const lines = [`- **${displayName}** (id: \`${ref}\`${providerInfo})${metaSuffix}`]
	if (description) {
		lines.push(`  ${description}`)
	}
	return lines.join("\n")
}

function formatRoleSection(roleName: string, assignment: RoleModelAssignment, registry?: ModelRegistry): string {
	const models = normalizeRoleModels(assignment)
	const entries = models.map((ref) => formatModelEntry(ref, registry))
	return `### ${roleName}\n${entries.join("\n\n")}`
}

function formatCurrentModelCapabilities(currentModelId: string, registry?: ModelRegistry): string {
	const descriptor = resolveDescriptor(currentModelId, registry)
	if (!descriptor) return "No capability information available for this model."
	const roles = descriptor.capabilities.roles.join(", ")
	const vision = descriptor.capabilities.vision ? "yes" : "no"
	return `Tier: ${descriptor.capabilities.tier} | Roles: ${roles} | Vision: ${vision}\n${descriptor.capabilities.description}`
}

function buildRoleAssignmentsSection(roles: ModelRoles, registry?: ModelRegistry, currentModelId?: string): string {
	const sections: string[] = []

	const plannerModels = normalizeRoleModels(roles.planner)
	const orchestratorIsPlanner = plannerModels.length === 1 && plannerModels[0] === roles.orchestrator
	if (!orchestratorIsPlanner) {
		sections.push(formatRoleSection("Planner", roles.planner, registry))
	}

	sections.push(formatRoleSection("Builder", roles.builder, registry))
	sections.push(formatRoleSection("Reviewer", roles.reviewer, registry))
	sections.push(formatRoleSection("Explorer", roles.explorer, registry))

	const capabilitiesSection = currentModelId
		? formatCurrentModelCapabilities(currentModelId, registry)
		: "No capability information available for this model."

	return `## Your Team\n\n${sections.join("\n\n")}\n\n## Your Capabilities\n\n${capabilitiesSection}`
}

// ---------------------------------------------------------------------------
// Single-Model Mode Instructions
// ---------------------------------------------------------------------------

function resolveSingleModelInstructions(currentModelId?: string): string {
	const modelClause = currentModelId ? ` Your model ID is \`${currentModelId}\`.` : ""
	return `## Single-Model Mode

You are running in single-model mode.${modelClause} All work in this session runs on the currently selected model. Handle tasks directly yourself unless delegation is clearly beneficial.

You may spawn subagents with the \`Agent\` tool for parallel work or to isolate long-running tasks. When you do, you MUST always pass your own model ID in the \`model\` parameter — never delegate to a different model.`
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
