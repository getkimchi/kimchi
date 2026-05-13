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
import { registerPhaseTools } from "./tools/phases.js"
import { registerStepTools } from "./tools/steps.js"

// ─── Public exports for cli.ts and components/footer.ts ──────────────────────
// Keep the existing signatures so external imports don't break.

export function getActiveFerment() {
	return getActive()
}

/** 1-based phase index or undefined */
export function getCurrentPhaseIndex(): number | undefined {
	const f = getActive()
	if (!f || !f.activePhaseId) return undefined
	const idx = f.phases.findIndex((p) => p.id === f.activePhaseId)
	return idx >= 0 ? idx + 1 : undefined
}

/** Active phase name or undefined */
export function getCurrentPhaseName(): string | undefined {
	const f = getActive()
	if (!f || !f.activePhaseId) return undefined
	return f.phases.find((p) => p.id === f.activePhaseId)?.name
}

/** For CLI --ferment resume */
export function getActiveFermentIdForResume(): string | undefined {
	return getActiveId()
}

/** Backward compat for any code using these names */
export function getCurrentBatchIndex(): number | undefined {
	return getCurrentPhaseIndex()
}
export function getCurrentBatchName(): string | undefined {
	return getCurrentPhaseName()
}
export function getCurrentRecipe(): Step[] {
	const f = getActive()
	return f?.phases.find((p) => p.id === f.activePhaseId)?.steps ?? []
}

// ═══════════════════════════════════════════════════════════════════════════════
// Extension factory
// ═══════════════════════════════════════════════════════════════════════════════

export default function fermentExtension(pi: ExtensionAPI, runtime: FermentRuntime = defaultFermentRuntime) {
	registerFermentEvents(pi, runtime)
	registerFermentCommands(pi, runtime)

	// ─── Tool registrations ───────────────────────────────────────────────────
	registerLifecycleTools(pi, runtime)
	registerPhaseTools(pi, runtime)
	registerStepTools(pi, runtime)
	registerKnowledgeTools(pi, runtime)
}
