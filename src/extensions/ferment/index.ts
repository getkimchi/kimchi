/**
 * Ferment extension entry point.
 *
 * Wires together:
 * - Event handlers (session_start, session_shutdown, input, before_agent_start,
 *   model_select, turn_end)
 * - Slash command (/ferment)
 * - All ferment tools (registered via tools/ submodules)
 *
 * Public exports re-export from ./state.ts for cli.ts and components/footer.ts.
 */

import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent"
import { Container, Text } from "@earendil-works/pi-tui"
import type { Step } from "../../ferment/types.js"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"
import { fermentBreadcrumbRenderer } from "./breadcrumb-renderer.js"
import { registerFermentCommands } from "./commands.js"
import { registerFermentEvents } from "./events.js"
import { buildFermentPromptBlock } from "./prompt-block.js"
import { type FermentRuntime, defaultFermentRuntime } from "./runtime.js"
import { FERMENT_REQUEST_MESSAGE_TYPE, type FermentRequestMessageDetails } from "./scoping.js"
import { getActive, getActiveId, getContinuationPolicy } from "./state.js"
import { registerKnowledgeTools } from "./tools/knowledge.js"
import { registerLifecycleTools } from "./tools/lifecycle.js"
import { registerPhaseTools } from "./tools/phases.js"
import { registerStepTools } from "./tools/steps.js"

// ─── Public exports for cli.ts and components/footer.ts ──────────────────────
// Keep the existing signatures so external imports don't break.

export function getActiveFerment() {
	return getActive()
}

export function getFermentContinuationPolicy() {
	return getContinuationPolicy()
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

const fermentRequestRenderer: MessageRenderer<FermentRequestMessageDetails> = (message, _options, theme) => {
	const intent =
		message.details?.intent ??
		(typeof message.content === "string"
			? message.content.replace(/^User entered ferment request:\s*/u, "")
			: message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n")
					.replace(/^User entered ferment request:\s*/u, ""))

	const container = new Container()
	container.addChild(new Text(`${theme.fg("dim", "❯")}  ${intent}`, 0, 0))
	container.addChild(new Text(`   ${theme.fg("dim", "Drafting the plan...")}`, 0, 0))
	return container
}

// ═══════════════════════════════════════════════════════════════════════════════
// Extension factory
// ═══════════════════════════════════════════════════════════════════════════════

export default function fermentExtension(pi: ExtensionAPI, runtime: FermentRuntime = defaultFermentRuntime) {
	pi.registerMessageRenderer(FERMENT_REQUEST_MESSAGE_TYPE, fermentRequestRenderer)
	registerFermentEvents(pi, runtime)
	registerFermentCommands(pi, runtime)

	// ─── Message renderers ────────────────────────────────────────────────────
	pi.registerMessageRenderer("ferment_breadcrumb", fermentBreadcrumbRenderer)
	pi.registerMessageRenderer("ferment_ack", fermentBreadcrumbRenderer)
	pi.registerMessageRenderer("ferment_worktree_warning", fermentBreadcrumbRenderer)
	pi.registerMessageRenderer("ferment_oneshot_failed", fermentBreadcrumbRenderer)

	createSystemPromptBlocks(pi, "ferment").register({
		id: "ferment-supplement",
		render: () => buildFermentPromptBlock(pi, runtime),
	})

	// ─── Tool registrations ───────────────────────────────────────────────────
	registerLifecycleTools(pi, runtime)
	registerPhaseTools(pi, runtime)
	registerStepTools(pi, runtime)
	registerKnowledgeTools(pi, runtime)
}
