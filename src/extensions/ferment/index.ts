/**
 * Ferment extension entry point.
 *
 * Wires together:
 * - Event handlers (session_start, session_shutdown, input, before_agent_start,
 *   model_select, turn_end)
 * - Slash command (/ferment)
 * - All ferment tools (registered via tools/ submodules)
 *
 * Public exports re-export from ./state.ts for cli.ts and components/status-line.ts.
 */

import type { ExtensionAPI, ExtensionContext, MessageRenderer } from "@earendil-works/pi-coding-agent"
import { Container, Text } from "@earendil-works/pi-tui"
import type { Step } from "../../ferment/types.js"
import * as EntryTriggerRegistry from "../../shared/planning/entry-trigger-registry.js"
import * as PromptSupplementRegistry from "../../shared/planning/prompt-supplement-registry.js"
import { isAgentWorker } from "../agent-worker-context.js"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"
import { requestSharedStatusLineRender } from "../shared-status-line.js"
import { registerTipProvider } from "../tips/registry.js"
import { registerAgentSpawnGuard } from "./agent-spawn-guard.js"
import { maybeTriggerFermentCompaction } from "./auto-compaction.js"
import { fermentBreadcrumbRenderer } from "./breadcrumb-renderer.js"
import { registerFermentCommands } from "./commands.js"
import { decideContinuation } from "./continuation.js"
import { registerFermentEvents } from "./events.js"
import { deletePendingProposal } from "./pending-proposal-store.js"
import { type PendingPlanReview, promptPlanReview } from "./plan-review.js"
import { setPendingPlanReviewTrigger } from "./plan-review-trigger.js"
import { buildFermentPromptBlock } from "./prompt-block.js"
import { createFermentRuntime, type FermentRuntime } from "./runtime.js"
import {
	getFermentSessionState,
	registerFermentSessionState,
	unregisterFermentSessionState,
} from "./session-state.js"
import { safeSendMessage } from "./safe-send.js"
import { scheduleFermentWakeUp, scheduleNextFermentAction } from "./scheduler.js"
import { FERMENT_REQUEST_MESSAGE_TYPE, type FermentRequestMessageDetails } from "./scoping.js"
import { confirmPendingScope } from "./scoping-confirmation.js"
import { getActive, getActiveId, getContinuationPolicy } from "./state.js"
import { canToggleFermentStopPolicy, FERMENT_STOP_POLICY_SHORTCUT } from "./status-line.js"
import { createFermentTipProvider } from "./tips.js"
import { registerFermentTodoSync } from "./todo-sync.js"
import { applyFermentRuntimeToolProfile } from "./tool-scope.js"
import { registerKnowledgeTools } from "./tools/knowledge.js"
import { buildFreeformScopingFeedbackMessage, registerLifecycleTools } from "./tools/lifecycle.js"
import { registerPhaseTools } from "./tools/phases.js"
import { registerStepTools } from "./tools/steps.js"

// ─── Public exports for cli.ts and components/status-line.ts ───────────────────────
// The no-argument overloads keep existing callers working; the optional
// sessionId overload lets multi-session transports (ACP) query the right
// session's ferment state.

export function getActiveFerment(sessionId?: string) {
	return getActive(getFermentSessionState(sessionId))
}

export function getFermentContinuationPolicy(sessionId?: string) {
	return getContinuationPolicy(getFermentSessionState(sessionId))
}

/** 1-based phase index or undefined */
export function getCurrentPhaseIndex(sessionId?: string): number | undefined {
	const f = getActive(getFermentSessionState(sessionId))
	if (!f?.activePhaseId) return undefined
	const idx = f.phases.findIndex((p) => p.id === f.activePhaseId)
	return idx >= 0 ? idx + 1 : undefined
}

/** Active phase name or undefined */
export function getCurrentPhaseName(sessionId?: string): string | undefined {
	const f = getActive(getFermentSessionState(sessionId))
	if (!f?.activePhaseId) return undefined
	return f.phases.find((p) => p.id === f.activePhaseId)?.name
}

/** For CLI --ferment resume */
export function getActiveFermentIdForResume(sessionId?: string): string | undefined {
	return getActiveId(getFermentSessionState(sessionId))
}

/** Backward compat for any code using these names */
export function getCurrentBatchIndex(sessionId?: string): number | undefined {
	return getCurrentPhaseIndex(sessionId)
}
export function getCurrentBatchName(sessionId?: string): string | undefined {
	return getCurrentPhaseName(sessionId)
}
export function getCurrentRecipe(sessionId?: string): Step[] {
	const f = getActive(getFermentSessionState(sessionId))
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
			requestSharedStatusLineRender()
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

export default function fermentExtension(pi: ExtensionAPI, runtime: FermentRuntime = createFermentRuntime()) {
	// Wire pi.events into the runtime so createApplyAndPersist can emit domain
	// events for every state mutation without importing from telemetry.
	runtime.events = pi.events

	// Register this runtime's session state so non-ferment code (status line,
	// telemetry, permissions, surveys) can look it up by session ID.
	pi.on("session_start", (_event, ctx) => {
		registerFermentSessionState(ctx.sessionManager.getSessionId(), runtime.sessionState)
	})
	pi.on("session_shutdown", () => {
		const sessionId = ctx?.sessionManager.getSessionId()
		if (sessionId) unregisterFermentSessionState(sessionId)
	})

	const unregisterFermentTips = registerTipProvider(createFermentTipProvider(runtime))
	let unregisterFermentTodoSync: (() => void) | undefined
	let planReviewTimer: ReturnType<typeof setTimeout> | undefined
	let planReviewRunning = false
	let finalCompletionNudgedThisRun = false
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

	const runPendingPlanReview = async (ctx: ExtensionContext, review: PendingPlanReview) => {
		if (planReviewRunning) return
		if (!isCurrentPendingReview(review)) return

		planReviewRunning = true
		try {
			const outcome = await promptPlanReview(ctx, { planMarkdown: review.planMarkdown })
			if (!outcome) {
				// promptPlanReview resolved to undefined (e.g. UI dismissed without
				// an explicit choice). Treat it the same as cancellation: clear the
				// pending review and restore the tool profile so the model is not
				// left with all tools suppressed.
				runtime.clearPendingPlanReview(review.fermentId)
				applyFermentRuntimeToolProfile(pi, runtime)
				return
			}
			if (outcome.kind === "cancelled") {
				// Delete the persisted proposal and clear the in-memory pending
				// review, then restore the planning-ferment tool profile. Without
				// this, `hasPendingPlanReview` in tool-scope.ts keeps all tools
				// suppressed, leaving the model unable to call any tools after
				// the user cancels the review.
				deletePendingProposal(review.fermentId)
				runtime.clearPendingPlanReview(review.fermentId)
				applyFermentRuntimeToolProfile(pi, runtime)
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
					requestSharedStatusLineRender()
				}
				runtime.clearPendingPlanReview(review.fermentId)
				applyFermentRuntimeToolProfile(pi, runtime)
				scheduleFermentWakeUp(pi, runtime, {
					deliverAs: "followUp",
					fermentId: review.fermentId,
					tag: "Plan review start",
				})
				return
			}

			// Clear the pending review before triggering the revision turn.
			// The model needs its full toolset to revise the plan (read files,
			// ask_user, etc.). If the pending review were left set, tool-scope.ts
			// would suppress all tools via `hasPendingPlanReview`, blocking the
			// revision. The model will set a new pending review by calling
			// `propose_ferment_scoping` again once the revision is complete.
			runtime.clearPendingPlanReview(review.fermentId)
			applyFermentRuntimeToolProfile(pi, runtime)
			safeSendMessage(
				pi,
				{
					content: buildFreeformScopingFeedbackMessage(review.fermentId, outcome.text),
					customType: "ferment_scoping_iteration",
					display: false,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			)
			runtime.clearPendingPlanReview(review.fermentId)
		} finally {
			planReviewRunning = false
		}
	}

	// Register the plan-review trigger so `resumeFerment` can present a
	// re-armed review directly (no LLM turn) after hydrating from the sidecar.
	setPendingPlanReviewTrigger((triggerCtx) => {
		const review = runtime.getCurrentPendingPlanReview()
		if (!planReviewRunning && review) {
			clearPlanReviewTimer()
			planReviewTimer = setTimeout(() => {
				planReviewTimer = undefined
				void runPendingPlanReview(triggerCtx, review)
			}, 0)
		}
	})

	pi.on("session_start", (_event, _ctx) => {
		ctx = _ctx
		const sessionId = ctx.sessionManager.getSessionId()
		registerFermentSessionState(sessionId, runtime.sessionState)
		runtime.clearMidTurnOneshotWarnings()

		// (Re)wire the ferment todo bridge to the current session id. The
		// session-scoped todo store requires every store call to target a
		// specific session; the bridge captures the id at subscribe time so its
		// internal handlers stay pure.
		unregisterFermentTodoSync?.()
		unregisterFermentTodoSync = undefined
		if (!isAgentWorker()) {
			unregisterFermentTodoSync = registerFermentTodoSync(pi, sessionId)
		}
	})

	pi.on("session_shutdown", () => {
		if (ctx) unregisterFermentSessionState(ctx.sessionManager.getSessionId())
		clearPlanReviewTimer()
		runtime.clearAllPendingPlanReviews()
		unregisterFermentTips()
		unregisterFermentTodoSync?.()
		unregisterFermentTodoSync = undefined
	})

	pi.on("agent_end", async (_event, ctx) => {
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
		await maybeTriggerFermentCompaction(pi, ctx, runtime)

		// Completing the final phase does not complete the ferment: complete_ferment
		// still has to run its C-gates and journey grading. If the model ends its run
		// between those two lifecycle actions, retain that final action as a hidden
		// follow-up instead of leaving a planned/running ferment to be paused at
		// session shutdown. This schedules the tool call; it never applies the
		// transition itself, so the completion gates cannot be bypassed.
		const active = runtime.getActive()
		if (!finalCompletionNudgedThisRun && active && runtime.isAutomatedContinuationEnabled()) {
			const decision = decideContinuation(active, runtime.getContinuationPolicy(), {
				treatCompleteFermentAsContinue: true,
			})
			if (decision.type === "continue" && decision.action.kind === "complete_ferment") {
				scheduleNextFermentAction(pi, active, runtime, {
					deliverAs: "followUp",
					tag: "Final completion pending",
					treatCompleteFermentAsContinue: true,
				})
			}
		}
		finalCompletionNudgedThisRun = false
	})

	pi.registerMessageRenderer(FERMENT_REQUEST_MESSAGE_TYPE, fermentRequestRenderer)
	registerFermentStopPolicyShortcut(pi, runtime)
	registerFermentEvents(pi, runtime, {
		onFinalCompletionNudgeScheduled: () => {
			finalCompletionNudgedThisRun = true
		},
	})
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
	registerAgentSpawnGuard(pi, runtime)
}
