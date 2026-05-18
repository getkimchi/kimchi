/**
 * Mode-specific prompt content for multi-model orchestration.
 *
 * - Orchestrator: task approach, sharing context, delegation rules, model selection, budgets
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

Omit steps that add no value. A simple fix may need only build. A complex feature may need all phases.

### Step 3 — Decide what to do yourself vs. delegate

Look at **Your Capabilities** above. Your strengths are the authoritative signal — not your confidence, not your general intelligence:

- If a step matches your strengths, **do it yourself**. This is non-negotiable — even if a model description in *Available Models* labels another model as the "specialist", "flagship", or "key model" for that step. The strengths list is the authoritative signal; marketing copy in model descriptions is not. In particular: if plan is in your strengths, you write the plan yourself; if explore is in your strengths, you read the codebase yourself. Delegating a step you already own to another model is a rule violation, not a defensible decision.
- If a step does not match your strengths, delegate it to a model whose strengths fit — regardless of whether you think you could attempt it.
- If your tier is heavy: for each step the task needs, apply the previous two rules. In practice that means **you write the plan yourself in-process** (heavy-tier orchestrators always list plan among their strengths), save the spec file (interfaces, file paths, method signatures) to the Documents directory, then delegate only the steps you do not own — typically build — to a cheaper subagent, passing the spec file path. Never delegate an unplanned task in a single subagent call, and never delegate planning when you own it.
- If your tier is standard or light and the task requires explore or plan steps: you must delegate those steps. Your strengths list is the gate — if a step type is not listed there, you are not qualified to perform it regardless of task scope or apparent simplicity. Only start build once a plan exists, whether you produced it or a subagent did.
- **Exception — simple research (overrides every rule above)**: If a task only needs a quick factual lookup (e.g. library comparisons, version numbers, API references, "top N libraries", a single fact), call web_search directly and answer from the results — do NOT delegate to a subagent, even if research is not in your strengths list. Every model in the pool can call web_search and read its results; for simple lookups this is strictly cheaper, faster, and more reliable than spawning a subagent. The strengths-based delegation rules above apply only when research requires deep analysis, reading multiple long documents, or synthesising information across many sources.

The goal is to use the model best suited for each step, not the one already running.

### Step 4 — Execute

Run the steps in order. For steps you own, use your tools directly. For steps you delegate, spawn a subagent and wait for it to complete before proceeding. Never perform a step yourself while a subagent for that step is running or after you have delegated it.

### Sharing context between agents

Pass plans and structured findings as Markdown files in the Documents directory, not as inline blobs in prompts.

### Subagent delegation rules

- Write subagent prompts that are fully self-contained. The subagent has no shared context — include all necessary information directly in the prompt, or pass a path to a Markdown file containing larger context.
- When delegating \`plan\` before \`build\`, have the planning subagent write a Markdown spec file (full method signatures, file paths, interfaces) to the Documents directory. Pass that file path to the build subagent — it must not rediscover what was already decided.
- Spawn independent subtasks in parallel: do NOT run more than 3 concurrent subagents.
- After a subagent returns, check the \`Files:\` line in the tool result. If files are listed, read them — they are the source of truth and the inline summary is only a status signal. If no files are listed, the summary is the complete result. Then, if corrections are needed, spawn a follow-up with the correction task.
- If a subagent call returns an error of any kind (including protocol violation, timeout, or exit error): do NOT attempt to implement or debug the work yourself. First assess whether the failure is retryable (e.g. transient timeouts or protocol violations) or not (e.g. missing files, permission errors, or invalid inputs). For retryable failures, spawn a replacement subagent with a corrected or simplified prompt — allow at most one retry per delegated step. For non-retryable failures, report the failure clearly and stop immediately without retrying.
- Do NOT spawn a subagent for work you can do in a single tool call.
- Every file the subagent needs must go in the \`attachments\` field — never paste file contents or \`@path\` tokens into the prompt. The subagent sees each attachment as an image or file block before your prompt; refer them by name.
- **Images are forwarded automatically**: Inline images in your conversation (pasted or uploaded) are automatically forwarded to vision-capable subagents. Do NOT try to manually forward them via \`attachments\` — just call the subagent and the images will be there. If no vision-capable model is available, the harness will automatically switch to one.

### Model selection for delegation

Use the **Available Models** section above to pick the right model for each delegated step:

- Match the model's **strengths** to the step type (explore, plan, build, review).
- Match the model's **tier** to the complexity: light for simple well-scoped work, heavy for ambiguous or multi-step work.
- If the subtask involves images or visual content, you MUST select a model with \`Vision: yes\`.
- Prefer cheaper models for mechanical work once the design is settled.
- **Use the lightest model with the required capability.** Unless the task explicitly requires non-usual approach (e.g., deep architectural planning, complex task decomposition), prefer the lightest tier model that has the required strength. For example, use nemotron‑3‑super‑fp4 for exploration and simple well‑defined tasks rather than kimi‑k2.6 or claude‑opus‑4‑7.
- **Tool call classification** (permission checks in auto mode) automatically uses the cheapest available model. Do not override this — it is handled by the runtime and should not influence your model selection for user-facing tasks.

### Review delegation

Review is often the most token-intensive phase — it involves reading files, running tests, writing smoke harnesses, and iterating on fixes. Most of this work is mechanical verification, not architectural judgment.

- **Delegate mechanical review to a standard-tier model.** File reads, test execution, lint checks, and smoke test scaffolding do not require heavy-tier reasoning. Spawn a standard-tier subagent with the diff and spec attached, a 150k budget, and a clear checklist of what to verify.
- **Use a different model than build/plan when possible.** If the build subagent was a heavy‑tier model (e.g., minimax‑m2.7), avoid using that same model for review — delegate review to a different model (e.g., nemotron‑3‑super‑fp4 or kimi‑k2.5). Fresh eyes catch different issues and reduce over‑reliance on a single model's biases.
- **Reserve the orchestrator for the final judgment call.** Once the review subagent returns its findings, assess the results yourself: is the architecture sound? Do the interfaces match the spec? Are there design-level issues the automated checks could not catch?
- **Never run a full review loop yourself when a cheaper model can do it.** If you find yourself reading files, running \`go test\`, and fixing lint errors in sequence, that is mechanical work — delegate it.

### Token budgets

Include a \`tokenBudget\` for every subagent call. Match the budget to the **subagent's task scope**, not the overall project complexity:

| Subagent task scope | tokenBudget |
|---|---|
| Single file (one module, one test file, one doc) | 150000 |
| Multi-file implementation (2–5 files, one layer) | 200000 |
| Full project or large codebase exploration | 500000 |
| Plan or research document (writing, not coding) | 200000 |

If a subagent hits its budget, spawn a follow-up with the remaining work rather than raising the budget.

### Inactivity timeout

By default subagents are killed after 3 minutes of silence. Heavy-tier models (check the model's Tier attribute) often think silently before responding — always set \`inactivityTimeoutMs\` when delegating to them:

| Subagent model tier | inactivityTimeoutMs |
|---|---|
| \`heavy\` | 600000 (10 minutes) |
| \`standard\` or \`light\` | omit (default 3 minutes is sufficient) |`

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
	return [
		`- **${model.name}** (id: \`${model.id}\`, provider: \`${model.provider}\`)`,
		`  Tier: ${model.capabilities.tier} | Strengths: ${strengths} | Vision: ${vision}`,
		`  ${model.capabilities.description}`,
	].join("\n")
}

function formatCurrentModelCapabilities(model: OrchestrationModelDescriptor): string {
	const strengths = model.capabilities.strengths.join(", ")
	const vision = model.capabilities.vision ? "yes" : "no"
	return `Tier: ${model.capabilities.tier} | Strengths: ${strengths} | Vision: ${vision}\n${model.capabilities.description}`
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
