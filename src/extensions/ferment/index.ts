/**
 * Ferment extension entry point.
 *
 * Wires together:
 * - Event handlers (session_start, session_shutdown, input, before_agent_start,
 *   model_select, turn_end)
 * - Slash commands (/ferment, /auto, /pause, /progress)
 * - All ferment tools (registered via tools/ submodules)
 *
 * Public exports re-export from ./state.ts for cli.ts and components/footer.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Step } from "../../ferment/types.js"
import { registerFermentCommands } from "./commands.js"
import { registerFermentEvents } from "./events.js"
import { type FermentRuntime, defaultFermentRuntime } from "./runtime.js"
import { getActive, getActiveId } from "./state.js"
import { registerKnowledgeTools } from "./tools/knowledge.js"
import { registerLifecycleTools } from "./tools/lifecycle.js"
import { registerStageTools } from "./tools/stages.js"
import { registerStepTools } from "./tools/steps.js"

// ─── Public exports for cli.ts and components/footer.ts ──────────────────────
// Keep the existing signatures so external imports don't break.

export function getActiveFerment() {
	return getActive()
}

/** 1-based stage index or undefined */
export function getCurrentStageIndex(): number | undefined {
	const f = getActive()
	if (!f || !f.activeStageId) return undefined
	const idx = f.stages.findIndex((p) => p.id === f.activeStageId)
	return idx >= 0 ? idx + 1 : undefined
}

/** @deprecated Use getCurrentStageIndex */
export const getCurrentPhaseIndex = getCurrentStageIndex

/** Active stage name or undefined */
export function getCurrentStageName(): string | undefined {
	const f = getActive()
	if (!f || !f.activeStageId) return undefined
	return f.stages.find((p) => p.id === f.activeStageId)?.name
}

/** @deprecated Use getCurrentStageName */
export const getCurrentPhaseName = getCurrentStageName

/** For CLI --ferment resume */
export function getActiveFermentIdForResume(): string | undefined {
	return getActiveId()
}

/** Backward compat for any code using these names */
export function getCurrentBatchIndex(): number | undefined {
	return getCurrentStageIndex()
}
export function getCurrentBatchName(): string | undefined {
	return getCurrentStageName()
}
export function getCurrentRecipe(): Step[] {
	const f = getActive()
	return f?.stages.find((p) => p.id === f.activeStageId)?.steps ?? []
}

// ═══════════════════════════════════════════════════════════════════════════════
// Extension factory
// ═══════════════════════════════════════════════════════════════════════════════

export default function fermentExtension(pi: ExtensionAPI, runtime: FermentRuntime = defaultFermentRuntime) {
	registerFermentEvents(pi, runtime)
	registerFermentCommands(pi, runtime)

	// ─── Tool registrations ───────────────────────────────────────────────────
	registerLifecycleTools(pi, runtime)
	registerStageTools(pi, runtime)
	registerStepTools(pi, runtime)
	registerKnowledgeTools(pi, runtime)
}
