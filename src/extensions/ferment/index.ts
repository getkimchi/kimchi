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
import {
	consumePlanReviewContext,
	emitPlanReviewDecision,
	emitPlanReviewRequest,
	onPlanReviewDecision,
	onPlanReviewRequest,
	type PlanReviewDecisionPayload,
	type PlanReviewRequestPayload,
} from "../../shared/planning/plan-review-bus.js"
import * as PromptSupplementRegistry from "../../shared/planning/prompt-supplement-registry.js"
import { isAgentWorker } from "../agent-worker-context.js"
import { withBlocked } from "../herdr-events.js"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"
import { buildRemotePlanPrompt } from "../remote-run/prompt-builder.js"
import { runCloudAgent } from "../remote-run/runner.js"
import { requestSharedStatusLineRender } from "../shared-status-line.js"
import { registerTipProvider } from "../tips/registry.js"
import { registerAgentSpawnGuard } from "./agent-spawn-guard.js"
import { maybeTriggerFermentCompaction } from "./auto-compaction.js"
import { fermentBreadcrumbRenderer } from "./breadcrumb-renderer.js"
import { registerFermentCommands } from "./commands.js"
import { decideContinuation } from "./continuation.js"
import { registerFermentEvents } from "./events.js"
import { registerFermentLifecycleContext } from "./lifecycle-context.js"
import { deletePendingProposal } from "./pending-proposal-store.js"
import { type PendingPlanReview, promptPlanReview } from "./plan-review.js"
import { setPendingPlanReviewTrigger } from "./plan-review-trigger.js"
import { buildFermentPromptBlock } from "./prompt-block.js"
import { defaultFermentRuntime, type FermentRuntime } from "./runtime.js"
import { safeSendMessage } from "./safe-send.js"
import { scheduleFermentWakeUp, scheduleNextFermentAction } from "./scheduler.js"
import { FERMENT_REQUEST_MESSAGE_TYPE, type FermentRequestMessageDetails } from "./scoping.js"
import { confirmPendingScope } from "./scoping-confirmation.js"
import { getActive, getActiveId, getContinuationPolicy } from "./state.js"
import { canToggleFermentStopPolicy, FERMENT_STOP_POLICY_SHORTCUT } from "./status-line.js"
import { createFermentTipProvider } from "./tips.js"
import { registerFermentTodoSync } from "./todo-sync.js"
import { createApplyAndPersist } from "./tool-helpers.js"
import { applyFermentRuntimeToolProfile } from "./tool-scope.js"
import { registerKnowledgeTools } from "./tools/knowledge.js"
import { buildFreeformScopingFeedbackMessage, registerLifecycleTools } from "./tools/lifecycle.js"
import { registerPhaseTools } from "./tools/phases.js"
import { registerStepTools } from "./tools/steps.js"

// ─── Public exports for cli.ts and components/status-line.ts ───────────────────────
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
	if (!f?.activePhaseId) return undefined
	const idx = f.phases.findIndex((p) => p.id === f.activePhaseId)
	return idx >= 0 ? idx + 1 : undefined
}

/** Active phase name or undefined */
export function getCurrentPhaseName(): string | undefined {
	const f = getActive()
	if (!f?.activePhaseId) return undefined
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

export default function fermentExtension(pi: ExtensionAPI, runtime: FermentRuntime = defaultFermentRuntime) {
	// Wire pi.events into the runtime so createApplyAndPersist can emit domain
	// events for every state mutation without importing from telemetry.
	runtime.events = pi.events

	registerFermentLifecycleContext(pi, runtime)

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
		// Unsubscribed when this review resolves; otherwise one listener would
		// accumulate on the shared event bus for every review ever presented.
		// `dismissReview` is assigned lazily by the prompt via onDismissRegister.
		let dismissReview: (() => void) | undefined
		const unsubscribeDismiss = onPlanReviewDecision(pi, (payload: PlanReviewDecisionPayload) => {
			if (payload.planReviewSource !== "ferment") return
			if (payload.source !== "plannotator") return
			dismissReview?.()
		})
		try {
			// promptPlanReview is TUI-only and returns undefined without prompting
			// in other modes — only activate the herdr blocked pair when it will
			// actually wait on the user (see herdr-events.ts PROTOCOL).
			const reviewPromise =
				ctx.mode === "tui"
					? withBlocked(pi.events, "Ferment plan review", () =>
							promptPlanReview(ctx, {
								planMarkdown: review.planMarkdown,
								onDismissRegister: (dismiss) => {
									dismissReview = dismiss
								},
							}),
						)
					: promptPlanReview(ctx, { planMarkdown: review.planMarkdown })

			// Fire-and-forget: emit a decision when the TUI resolves.
			// The decision handler below acts on whichever surface decides first.
			void reviewPromise
				.then((outcome) => {
					unsubscribeDismiss()
					if (!outcome) {
						// No decision UI was presented (non-TUI or dismissed without a
						// choice): clear the pending review and restore tools, but keep
						// the persisted proposal for a later resume. planReviewRunning
						// must reset here — no decision is emitted, so the decision
						// handler never runs for this outcome.
						runtime.clearPendingPlanReview(review.fermentId)
						applyFermentRuntimeToolProfile(pi, runtime)
						planReviewRunning = false
						return
					}
					if (outcome.kind === "cancelled") {
						emitPlanReviewDecision(pi, {
							decision: "rework",
							source: "kimchi-tui",
							planReviewSource: "ferment",
							fermentId: review.fermentId,
						})
						return
					}
					if (outcome.kind === "start" || outcome.kind === "start_auto") {
						emitPlanReviewDecision(pi, {
							decision: "execute",
							source: "kimchi-tui",
							planReviewSource: "ferment",
							fermentId: review.fermentId,
							auto: outcome.kind === "start_auto",
						})
					} else if (outcome.kind === "start_cloud") {
						emitPlanReviewDecision(pi, {
							decision: "start_cloud",
							source: "kimchi-tui",
							planReviewSource: "ferment",
							fermentId: review.fermentId,
						})
					} else if (outcome.kind === "feedback") {
						emitPlanReviewDecision(pi, {
							decision: "feedback",
							feedback: outcome.text,
							source: "kimchi-tui",
							planReviewSource: "ferment",
							fermentId: review.fermentId,
						})
					}
				})
				.catch(() => {
					// If the TUI review promise rejects (unexpected error, not a
					// plannotator-driven dismiss), clean up the dismiss listener and
					// reset planReviewRunning so a failed popup doesn't leave ferment
					// stuck waiting forever.
					unsubscribeDismiss()
					planReviewRunning = false
				})
		} finally {
			// planReviewRunning stays true until the decision handler clears it.
			// The TUI prompt is fire-and-forget — the finally runs immediately.
		}
	}

	// Decision handler for ferment plan reviews — handles decisions from both
	// the TUI review component and plannotator's browser UI (first decision wins).
	onPlanReviewDecision(pi, (payload: PlanReviewDecisionPayload) => {
		if (payload.planReviewSource !== "ferment") return
		const reviewCtx = consumePlanReviewContext()
		if (!reviewCtx) return
		const fermentId = payload.fermentId ?? reviewCtx.fermentId
		if (!fermentId) return

		planReviewRunning = false

		if (payload.decision === "execute") {
			const scopeOutcome = confirmPendingScope(runtime, fermentId, undefined, "turn_end", pi)
			if (!scopeOutcome.ok) {
				reviewCtx.ctx?.ui?.notify?.(`Failed to save plan: ${scopeOutcome.error.message}`, "error")
				return
			}
			if (payload.auto) {
				runtime.setContinuationPolicy("automated")
				requestSharedStatusLineRender()
			}
			runtime.clearPendingPlanReview(fermentId)
			applyFermentRuntimeToolProfile(pi, runtime)
			scheduleFermentWakeUp(pi, runtime, {
				deliverAs: "followUp",
				fermentId,
				tag: "Plan review start",
			})
		} else if (payload.decision === "start_cloud") {
			// Confirm pending scope so the ferment is saved locally, then spawn
			// a remote agent to execute the plan in a cloud sandbox. The local
			// ferment is left as-is (scoped, not activated) — the remote agent
			// creates its own ferment from the plan text.
			const scopeOutcome = confirmPendingScope(runtime, fermentId, undefined, "turn_end", pi)
			if (!scopeOutcome.ok) {
				reviewCtx.ctx?.ui?.notify?.(`Failed to save plan: ${scopeOutcome.error.message}`, "error")
				return
			}
			runtime.clearPendingPlanReview(fermentId)
			applyFermentRuntimeToolProfile(pi, runtime)
			// Pause the ferment before spawning the cloud agent so the scheduler
			// can't nudge the agent to activate_ferment_phase between confirm
			// and spawn. The ferment is completed (on sync) or resumed (on
			// review/custom/done) when the cloud agent finishes.
			const pauseOutcome = createApplyAndPersist(runtime)(fermentId, { type: "pause" })
			if (pauseOutcome.ok) {
				runtime.setActive(pauseOutcome.ferment)
			}
			const planMarkdown = reviewCtx.planText
			const cloudPrompt = buildRemotePlanPrompt(planMarkdown, { origin: "ferment" })
			const cloudDescription = `cloud: ${planMarkdown.slice(0, 60)}${planMarkdown.length > 60 ? "..." : ""}`
			const ui = reviewCtx.ctx?.ui
			void runCloudAgent(pi, reviewCtx.ctx, cloudPrompt, cloudDescription, {
				background: true,
				origin: "ferment plan",
				fermentId,
			}).catch((err) => {
				// Spawn failed after the ferment was paused — resume it so the
				// user isn't left with a stuck ferment and no recovery path,
				// and surface the error.
				const message = err instanceof Error ? err.message : String(err)
				ui?.notify?.(`Could not start the cloud agent: ${message}`, "error")
				const resumeOutcome = createApplyAndPersist(runtime)(fermentId, { type: "resume" })
				if (resumeOutcome.ok) {
					runtime.setActive(resumeOutcome.ferment)
				}
			})
		} else if (payload.decision === "feedback") {
			// Clear the pending review before triggering the revision turn.
			// The model needs its full toolset to revise the plan (read files,
			// ask_user, etc.). If the pending review were left set, tool-scope.ts
			// would suppress all tools via `hasPendingPlanReview`, blocking the
			// revision. The model will set a new pending review by calling
			// `propose_ferment_scoping` again once the revision is complete.
			runtime.clearPendingPlanReview(fermentId)
			applyFermentRuntimeToolProfile(pi, runtime)
			safeSendMessage(
				pi,
				{
					content: buildFreeformScopingFeedbackMessage(fermentId, payload.feedback ?? ""),
					customType: "ferment_scoping_iteration",
					display: false,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			)
		} else {
			// rework / cancel — delete the persisted proposal and clear the
			// in-memory pending review, then restore the planning-ferment tool
			// profile. Without this, `hasPendingPlanReview` in tool-scope.ts
			// keeps all tools suppressed, leaving the model unable to call any
			// tools after the user cancels the review.
			deletePendingProposal(fermentId)
			runtime.clearPendingPlanReview(fermentId)
			applyFermentRuntimeToolProfile(pi, runtime)
		}
	})

	// Register the plan-review trigger so `resumeFerment` can present a
	// re-armed review directly (no LLM turn) after hydrating from the sidecar.
	setPendingPlanReviewTrigger((triggerCtx) => {
		const review = runtime.getCurrentPendingPlanReview()
		if (!planReviewRunning && review) {
			// Always emit — subscribers self-select. The onPlanReviewRequest
			// listener below schedules runPendingPlanReview via planReviewTimer.
			// In non-TUI, promptPlanReview returns undefined → clear-only branch
			// restores tools without deleting the persisted proposal.
			emitPlanReviewRequest(
				pi,
				{ planContent: review.planMarkdown, source: "ferment", fermentId: review.fermentId },
				{ ctx: triggerCtx, planText: review.planMarkdown, fermentId: review.fermentId },
			)
		}
	})

	// When propose_ferment_scoping emits a plan-review request (source=ferment),
	// trigger the TUI popup. propose_ferment_scoping already set the pending
	// review and persisted the proposal — this just shows the review UI.
	onPlanReviewRequest(pi, (payload: PlanReviewRequestPayload) => {
		if (payload.source !== "ferment") return
		const sessionCtx = ctx
		if (!sessionCtx) return
		const review = runtime.getCurrentPendingPlanReview()
		if (!review || planReviewRunning) return
		clearPlanReviewTimer()
		planReviewTimer = setTimeout(() => {
			planReviewTimer = undefined
			void runPendingPlanReview(sessionCtx, review)
		}, 0)
	})

	pi.on("session_start", (_event, _ctx) => {
		ctx = _ctx
		runtime.clearMidTurnOneshotWarnings()
		runtime.clearMidTurnCompactionTracking()

		// (Re)wire the ferment todo bridge to the current session id. The
		// session-scoped todo store requires every store call to target a
		// specific session; the bridge captures the id at subscribe time so its
		// internal handlers stay pure.
		unregisterFermentTodoSync?.()
		unregisterFermentTodoSync = undefined
		if (!isAgentWorker()) {
			unregisterFermentTodoSync = registerFermentTodoSync(pi, ctx.sessionManager.getSessionId())
		}
	})

	pi.on("session_shutdown", () => {
		clearPlanReviewTimer()
		runtime.clearAllPendingPlanReviews()
		unregisterFermentTips()
		unregisterFermentTodoSync?.()
		unregisterFermentTodoSync = undefined
	})

	pi.on("agent_end", async (_event, ctx) => {
		// Present a pending plan review when the turn ends. Reviews can exist
		// without an in-turn emission (restored state, direct set), so this
		// block emits the request — storing the review context the decision
		// handler consumes — then schedules the popup directly. The
		// planReviewTimer/planReviewRunning guards ensure we never re-emit or
		// re-schedule when the in-turn proposal already opened (or queued) the
		// same review, which would double-open plannotator's browser.
		const review = runtime.getCurrentPendingPlanReview()
		if (!planReviewRunning && !planReviewTimer && review) {
			emitPlanReviewRequest(
				pi,
				{ planContent: review.planMarkdown, source: "ferment", fermentId: review.fermentId },
				{ ctx, planText: review.planMarkdown, fermentId: review.fermentId },
			)
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
