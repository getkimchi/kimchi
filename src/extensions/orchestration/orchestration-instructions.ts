/**
 * Mode-specific prompt content for multi-model orchestration.
 *
 * Thin dispatcher: delegates to orchestrator-block.ts for the actual prose.
 *
 * - Orchestrator (fermentActive=false): full plan/build/review pipeline
 * - Orchestrator (fermentActive=true):  dispatch-only block (no pipeline)
 * - Subagent:                           response protocol only
 * - Single-model:                       single-model instructions
 *
 * The (fermentActive=true, permissionMode="plan") cell is unreachable —
 * permissions auto-forces yolo when KIMCHI_ACTIVE_FERMENT is set.
 * It falls through to buildDispatchOnlyBlock as a defensive default.
 */

import { buildModelGuidelinesSection } from "../model-registry/guidelines/guidelines-resolver.js"
import type { ModelRegistry } from "../model-registry/index.js"
import type { PermissionMode } from "../permissions/types.js"
import { buildDispatchOnlyBlock, buildFullOrchestratorBlock } from "../prompt-construction/orchestrator-block.js"
import type { PromptMode } from "../prompt-construction/system-prompt.js"

export interface OrchestrationInstructionsContext {
	currentModelId?: string
	registry?: ModelRegistry
	mode: PromptMode
	permissionMode?: PermissionMode
	/** When true, the ferment planner is active — use dispatch-only block. Phase 7 wires the caller. */
	fermentActive?: boolean
}

export function resolveOrchestrationInstructions(ctx: OrchestrationInstructionsContext): string {
	if (ctx.mode === "subagent") {
		return SUBAGENT_RESPONSE_PROTOCOL
	}
	if (ctx.mode === "orchestrator") {
		const permissionMode = ctx.permissionMode ?? "default"
		const fermentActive = ctx.fermentActive ?? false

		let block: string
		if (fermentActive) {
			// (fermentActive=true, permissionMode="plan") is dead — ferment forces yolo.
			block = buildDispatchOnlyBlock()
		} else {
			block = buildFullOrchestratorBlock({ permissionMode })
		}

		const modelGuidelines = buildModelGuidelinesSection(ctx.currentModelId, ctx.registry)
		return modelGuidelines ? `${block}\n\n${modelGuidelines}` : block
	}
	if (ctx.mode === "single") {
		return resolveSingleModelInstructions(ctx.currentModelId)
	}
	return ""
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

export const SUBAGENT_RESPONSE_PROTOCOL = `## Subagent response protocol

Your final response must be a single JSON object with no other text before or after it:

\`\`\`
{"summary": "...", "files": ["path1", "path2"]}
\`\`\`

- \`summary\`: one paragraph (at most 5 sentences) covering what was done, any critical decisions, and any blockers.
- \`files\`: array of absolute paths to every file written to the Documents directory. Empty array if none.

Write all substantive output (plans, specs, research notes, findings) to files in the Documents directory — never inline in the summary. Do NOT add any text before or after the JSON. Do NOT wrap it in a markdown code fence.`
