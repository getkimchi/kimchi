/**
 * Mode-specific prompt content for multi-model orchestration.
 *
 * - Orchestrator: task approach, sharing context, Agent delegation rules, model selection, budgets
 * - Subagent: response protocol, factual accuracy, tool discovery
 * - Single-model: empty (no orchestration content)
 */

import type { PromptMode } from "../prompt-construction/system-prompt.js"
import { buildOrchestrationGuidelinesSection } from "./model-registry/guidelines/guidelines-resolver.js"
import type { ModelRegistry } from "./model-registry/index.js"
import type { OrchestrationModelDescriptor } from "./model-registry/types.js"

export interface OrchestrationInstructionsContext {
	currentModelId?: string
	registry?: ModelRegistry
	mode: PromptMode
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

**Rule: if build is included, review must always follow it. Never omit review after a build step.**

### Step 3 — Decide what to do yourself vs. delegate

Your strengths list is the authoritative routing signal — not your confidence, not model descriptions.

**Always delegate — no exceptions:**
- **build** — always delegate to a standard-tier model with \`build\` strength. Never write or edit code yourself, even for a one-line fix.
- **review** — always delegate to a standard-tier model with \`review\` strength. Never run review yourself.
- **explore** — always delegate to a light-tier model with \`explore\` strength. Never read files or trace code yourself.

**Delegate for large inputs, self-serve for small:**
- **research** — a single \`web_search\` answer suffices: call it directly. Reading long documentation pages, multiple external sources, or synthesising across many pages: delegate to a light-tier model with \`research\` strength.

**Always self-serve:**
- **plan** — always write the plan yourself in-process. Save the spec (interfaces, file paths, method signatures) to the Documents directory. Never delegate planning.

The goal is to use the model best suited for each step, not the one already running.

### Step 4 — Execute

Run the steps in order. For steps you own, use your tools directly. For steps you delegate, call the Agent tool and wait for it to complete before proceeding unless you explicitly run it in the background. Never perform a step yourself while an Agent for that step is running or after you have delegated it.

### Sharing context between agents

Pass plans and structured findings as Markdown files in the Documents directory, not as inline blobs in prompts.

### Agent delegation rules

- Write Agent prompts that are fully self-contained. Agents start with fresh context by default — include necessary instructions directly, or point them to a Markdown file containing larger context.
- When delegating \`plan\` before \`build\`, have the Plan agent write a Markdown spec file (full method signatures, file paths, interfaces) to the Documents directory. Pass that file path to the build Agent — it must not rediscover what was already decided.
- Spawn independent subtasks in parallel with \`run_in_background: true\`: do NOT run more than 3 concurrent Agents.
- After an Agent returns, read any file paths it reports before relying on its summary. Those files are the source of truth and the inline summary is only a status signal. Then, if corrections are needed, call Agent again with the correction task.
- If an Agent call returns an error of any kind (including protocol violation, timeout, exit error, or context limit reached): do NOT attempt to implement or debug the work yourself. First assess whether the failure is retryable (e.g. transient timeouts, protocol violations, or context limit reached) or not (e.g. missing files, permission errors, or invalid inputs). For retryable failures, call a replacement Agent with a corrected or simplified prompt — allow at most one retry per delegated step. For context limit failures specifically, split the remaining work into smaller scoped Agent calls rather than raising the budget or doing the work in-process. For non-retryable failures, report the failure clearly and stop immediately without retrying.
- Use \`inherit_context: true\` only when the Agent needs the parent conversation history. Otherwise keep the default fresh context.
- Inline images in your conversation are forwarded automatically to vision-capable Agents when needed. If no vision-capable model is available, the harness will automatically switch to one.

### Model selection for delegation

Match the delegated step to the required tier and strength:

- **build** — standard-tier model with \`build\` strength.
- **review** — standard-tier model with \`review\` strength.
- **explore** — light-tier model with \`explore\` strength.
- **research** (when delegated) — light-tier model with \`research\` strength.
- If the subtask involves images or visual content, you MUST select a model with \`Vision: yes\`.
- **Tool call classification** (permission checks in auto mode) automatically uses the cheapest available model. Do not override this — it is handled by the runtime and should not influence your model selection for user-facing tasks.

### Review

Review is always delegated (see Step 3). After the review Agent returns its findings:

1. Triage findings by severity:
   - **High/Critical** — correctness bugs, security issues, data loss risks, broken interfaces. Delegate a new build Agent to fix these immediately.
   - **Medium/Low** — style, naming, minor inefficiencies, non-blocking suggestions. Do NOT fix these. Report them to the user as a brief list so they can decide.
2. Assess the architecture and interfaces yourself: are the design decisions sound regardless of line-level bugs?

### Token budgets

Include a \`token_budget\` for every Agent call. Match the budget to the **delegated task scope**, not the overall project complexity:
If the user explicitly asks for the Agent tool with a specific \`token_budget\`, make that Agent call once with the requested value. Do not ask to increase the budget or substitute a larger budget before the tool runs.

| Agent task scope | token_budget |
|---|---|
| Single file (one module, one test file, one doc) | 150000 |
| Multi-file implementation (2–5 files, one layer) | 200000 |
| Full project or large codebase exploration | 500000 |
| Plan or research document (writing, not coding) | 200000 |

If an Agent hits its budget, spawn a follow-up with the remaining work rather than raising the budget.`

function resolveOrchestratorInstructions(ctx: OrchestrationInstructionsContext): string {
	const parts: string[] = []

	if (ctx.registry) {
		parts.push(buildModelCapabilitiesSection(ctx.registry, ctx.currentModelId))
	}

	parts.push(ORCHESTRATOR_INSTRUCTIONS)

	const orchGuidelines = buildOrchestrationGuidelinesSection(ctx.currentModelId, ctx.registry)
	if (orchGuidelines) parts.push(orchGuidelines)

	return parts.join("\n\n")
}

function formatModel(model: OrchestrationModelDescriptor): string {
	const strengths = model.capabilities.strengths.join(", ")
	const vision = model.capabilities.vision ? "yes" : "no"
	return `- **${model.name}** (id: \`${model.id}\`, provider: \`${model.provider}\`)\n  Tier: ${model.capabilities.tier} | Strengths: ${strengths} | Vision: ${vision}`
}

function formatCurrentModelCapabilities(model: OrchestrationModelDescriptor): string {
	const strengths = model.capabilities.strengths.join(", ")
	const vision = model.capabilities.vision ? "yes" : "no"
	return `Tier: ${model.capabilities.tier} | Strengths: ${strengths} | Vision: ${vision}`
}

function buildModelCapabilitiesSection(registry: ModelRegistry, currentModelId?: string): string {
	const currentDescriptor = currentModelId
		? registry.getModelsWithCapabilities().find((m) => m.id === currentModelId)
		: undefined
	const currentModelCapabilities = currentDescriptor
		? formatCurrentModelCapabilities(currentDescriptor)
		: "No capability information available for this model."

	const subagentModels = registry.getModelsWithCapabilities().filter((m) => m.id !== currentModelId)
	const modelsSection =
		subagentModels.length > 0 ? subagentModels.map(formatModel).join("\n\n") : "(No models available)"

	return `## Available Models

Each model is described with: **Tier** (heavy/standard/light — cost vs capability), **Strengths** (build, explore, review, plan, research), **Vision** (image input support).

${modelsSection}

## Your Capabilities

${currentModelCapabilities}`
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
