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

import type { ExtensionAPI, ExtensionContext, MessageRenderer } from "@earendil-works/pi-coding-agent"
import { Container, Text } from "@earendil-works/pi-tui"
import type { Step } from "../../ferment/types.js"
import * as EntryTriggerRegistry from "../../shared/planning/entry-trigger-registry.js"
import * as PromptSupplementRegistry from "../../shared/planning/prompt-supplement-registry.js"
import { isAgentWorker } from "../agent-worker-context.js"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"
import { requestSharedFooterRender } from "../shared-footer.js"
import { registerTipProvider } from "../tips/registry.js"
import { maybeTriggerFermentCompaction } from "./auto-compaction.js"
import { fermentBreadcrumbRenderer } from "./breadcrumb-renderer.js"
import { registerFermentCommands } from "./commands.js"
import { registerFermentEvents } from "./events.js"
import { FERMENT_STOP_POLICY_SHORTCUT, canToggleFermentStopPolicy } from "./footer-status.js"
import { type PendingPlanReview, promptPlanReview } from "./plan-review.js"
import { buildFermentPromptBlock } from "./prompt-block.js"
import { type FermentRuntime, defaultFermentRuntime } from "./runtime.js"
import { scheduleFermentWakeUp } from "./scheduler.js"
import { confirmPendingScope } from "./scoping-confirmation.js"
import { FERMENT_REQUEST_MESSAGE_TYPE, type FermentRequestMessageDetails } from "./scoping.js"
import { getActive, getActiveId, getContinuationPolicy } from "./state.js"
import { createFermentTipProvider } from "./tips.js"
import { registerFermentTodoSync } from "./todo-sync.js"
import { applyFermentRuntimeToolProfile } from "./tool-scope.js"
import { registerKnowledgeTools } from "./tools/knowledge.js"
import { buildFreeformScopingFeedbackMessage, registerLifecycleTools } from "./tools/lifecycle.js"
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

function registerFermentStopPolicyShortcut(pi: ExtensionAPI, runtime: FermentRuntime): void {
	pi.registerShortcut(FERMENT_STOP_POLICY_SHORTCUT, {
		description: "Toggle Ferment stop policy",
		handler: () => {
			const active = runtime.getActive()
			if (!canToggleFermentStopPolicy(active)) return

			const next = runtime.getContinuationPolicy() === "manual" ? "automated" : "manual"
			runtime.setContinuationPolicy(next)
			applyFermentRuntimeToolProfile(pi, runtime)
			requestSharedFooterRender()
		},
	})
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
	// Wire pi.events into the runtime so createApplyAndPersist can emit domain
	// events for every state mutation without importing from telemetry.
	runtime.events = pi.events

	const unregisterFermentTips = registerTipProvider(createFermentTipProvider(runtime))
	let unregisterFermentTodoSync: (() => void) | undefined
	if (!isAgentWorker()) {
		unregisterFermentTodoSync = registerFermentTodoSync(pi)
	}
	let planReviewTimer: ReturnType<typeof setTimeout> | undefined
	let planReviewRunning = false
	// ExtensionContext is populated on session start
	let ctx: ExtensionContext | undefined

	const clearPlanReviewTimer = () => {
		if (planReviewTimer) {
			clearTimeout(planReviewTimer)
			planReviewTimer = undefined
		}
	}

	const isCurrentPendingReview = (review: PendingPlanReview): boolean =>
		runtime.getPendingPlanReview(review.fermentId) === review

	const runPendingPlanReview = async (ctx: Pick<ExtensionContext, "ui"> | undefined, review: PendingPlanReview) => {
		if (planReviewRunning) return
		if (!isCurrentPendingReview(review)) return

		planReviewRunning = true
		try {
			const outcome = await promptPlanReview(ctx, { planMarkdown: review.planMarkdown })
			if (!outcome) return
			if (outcome.kind === "cancelled") {
				return
			}

			if (!isCurrentPendingReview(review)) return

			if (outcome.kind === "start" || outcome.kind === "start_auto") {
				const scopeOutcome = confirmPendingScope(runtime, review.fermentId, undefined, "turn_end", pi)
				if (!scopeOutcome.ok) {
					ctx?.ui?.notify?.(`Failed to save plan: ${scopeOutcome.error.message}`, "error")
					return
				}
				if (outcome.kind === "start_auto") {
					runtime.setContinuationPolicy("automated")
					applyFermentRuntimeToolProfile(pi, runtime)
					requestSharedFooterRender()
				}
				runtime.clearPendingPlanReview(review.fermentId)
				scheduleFermentWakeUp(pi, runtime, {
					deliverAsFollowUp: true,
					fermentId: review.fermentId,
					tag: "Plan review start",
				})
				return
			}

			void pi.sendMessage(
				{
					content: buildFreeformScopingFeedbackMessage(review.fermentId, outcome.text),
					customType: "ferment_scoping_iteration",
					display: false,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			)
		} finally {
			planReviewRunning = false
		}
	}

	pi.on("session_start", (_event, _ctx) => {
		ctx = _ctx
	})

	pi.on("session_shutdown", () => {
		clearPlanReviewTimer()
		runtime.clearAllPendingPlanReviews()
		unregisterFermentTips()
		unregisterFermentTodoSync?.()
	})

	pi.on("agent_end", (_event, ctx) => {
		const review = runtime.getCurrentPendingPlanReview()
		if (!planReviewRunning && review) {
			clearPlanReviewTimer()
			planReviewTimer = setTimeout(() => {
				planReviewTimer = undefined
				void runPendingPlanReview(ctx, review)
			}, 0)
		}

		// Drain any remaining pending compactions at agent_end (catches the case
		// where the ferment completes within a single agent run and the turn_end
		// handler already cleared most pending entries).
		maybeTriggerFermentCompaction(pi, ctx, runtime)
	})

	pi.registerMessageRenderer(FERMENT_REQUEST_MESSAGE_TYPE, fermentRequestRenderer)
	registerFermentStopPolicyShortcut(pi, runtime)
	registerFermentEvents(pi, runtime)
	registerFermentCommands(pi, runtime)

	// ─── Message renderers ────────────────────────────────────────────────────
	pi.registerMessageRenderer("ferment_breadcrumb", fermentBreadcrumbRenderer)
	pi.registerMessageRenderer("ferment_ack", fermentBreadcrumbRenderer)
	pi.registerMessageRenderer("ferment_worktree_warning", fermentBreadcrumbRenderer)
	pi.registerMessageRenderer("ferment_oneshot_failed", fermentBreadcrumbRenderer)

	// Same `ferment-planning-block` for interactive and oneshot — both modes
	// register through the shared registry so `compose('ferment')` returns it
	// regardless of which entry path bootstrapped the session.
	const fermentPlanningBlock = {
		id: "ferment-planning-block",
		render: () => {
			if (!ctx) return undefined
			return buildFermentPromptBlock(ctx, pi, runtime)
		},
	}
	PromptSupplementRegistry.register("ferment-planning-block", fermentPlanningBlock, {
		modes: ["ferment"],
	})
	createSystemPromptBlocks(pi, "ferment").register(fermentPlanningBlock)

	// ─── Entry triggers (planning mode routing) ───────────────────────────
	// The actual ferment-creation logic lives in commands.ts (slash command
	// handler) and state.ts (KIMCHI_ACTIVE_FERMENT env-var reader); the
	// registry entries make the routing table explicit and discoverable.
	EntryTriggerRegistry.register("/ferment-new", (event) => {
		if (event.kind !== "slash-command") return { kind: "noop" }
		if (event.command !== "new") return { kind: "noop" }
		return { kind: "enter-mode", mode: "ferment", reason: "/ferment new <intent>" }
	})
	EntryTriggerRegistry.register("KIMCHI_ACTIVE_FERMENT", (event) => {
		if (event.kind !== "env-var") return { kind: "noop" }
		if (event.name !== "KIMCHI_ACTIVE_FERMENT") return { kind: "noop" }
		if (!event.value) return { kind: "noop" }
		return { kind: "enter-mode", mode: "ferment", reason: `KIMCHI_ACTIVE_FERMENT=${event.value}` }
	})

	// ─── Tool registrations ───────────────────────────────────────────────────
	registerLifecycleTools(pi, runtime)
	registerPhaseTools(pi, runtime)
	registerStepTools(pi, runtime)
	registerKnowledgeTools(pi, runtime)
}
