/**
 * LLM nudges and post-mutation hooks.
 *
 * - `appendRefEntry`: writes a hidden session entry that survives compaction —
 *   used so resumed sessions can find the active ferment.
 * - `maybeInjectReactiveContinuationNudge`: under automated policy, injects an
 *   action-specific prompt only after an assistant turn stalls without tool calls.
 * - `maybeInjectFermentStopNudge`: under automated policy, injects an action-
 *   specific prompt when the model ends its turn with `stopReason "stop"` after
 *   making tool calls — i.e. it did real work but chose to stop rather than
 *   continuing the ferment lifecycle. This covers the case where the agent
 *   completes a step/phase tool call then produces a summary and exits without
 *   calling the next ferment lifecycle tool.
 * - `onStepCompleted` / `onPhaseCompleted`: stable post-mutation hooks tools
 *   call after writing storage. Today they re-sync active ferment state; keep
 *   callers on the hook so future post-mutation logic has one place to live.
 *
 * All `pi.sendMessage` calls use `deliverAs: "followUp"` to avoid the
 * "agent is already processing" error when triggered from inside tool execute
 * handlers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Ferment } from "../../ferment/types.js"
import { decideContinuation } from "./continuation.js"
import { type FermentRuntime, defaultFermentRuntime } from "./runtime.js"
import { scheduleNextFermentAction } from "./scheduler.js"
import { MAX_SCOPING_EXPLORE_TURNS, bumpScopingExploreTurns, resetScopingExploreTurns } from "./state.js"

export function appendRefEntry(pi: ExtensionAPI, fermentId: string): void {
	void pi.sendMessage({
		customType: "ferment_reference",
		content: [{ type: "text", text: `active: ${fermentId}` }],
		display: false,
		details: { fermentId },
	})
}

const MAX_CONSECUTIVE_REACTIVE_NUDGES = 1
const reactiveNudgeCounts = new Map<string, number>()

// ─── Ferment stop nudge (tool-call turn that ended with stopReason "stop") ────
// Separate counter so it doesn't count down the reactive (text-only) budget.
const MAX_CONSECUTIVE_STOP_NUDGES = 2
const stopNudgeCounts = new Map<string, number>()

export function resetReactiveContinuationNudgeCount(fermentId: string): void {
	reactiveNudgeCounts.delete(fermentId)
}

export function resetAllReactiveContinuationNudgeCounts(): void {
	reactiveNudgeCounts.clear()
}

export function resetFermentStopNudgeCount(fermentId: string): void {
	stopNudgeCounts.delete(fermentId)
}

export function resetAllFermentStopNudgeCounts(): void {
	stopNudgeCounts.clear()
}

export function refreshActiveFermentFromStorage(runtime: FermentRuntime): Ferment | undefined {
	const id = runtime.getActiveId()
	if (!id) return undefined
	const fresh = runtime.getStorage().get(id)
	if (fresh) runtime.setActive(fresh)
	return fresh
}

export function maybeInjectReactiveContinuationNudge(
	pi: ExtensionAPI,
	runtime: FermentRuntime = defaultFermentRuntime,
): void {
	if (!runtime.isAutomatedContinuationEnabled()) return
	const id = runtime.getActiveId()
	if (!id) return
	const fresh = refreshActiveFermentFromStorage(runtime)
	const inactive = !fresh || fresh.status === "complete" || fresh.status === "abandoned"
	if (inactive) runtime.setActive(undefined)
	if (inactive || fresh.status === "paused") {
		resetReactiveContinuationNudgeCount(id)
		return
	}

	const decision = decideContinuation(fresh, runtime.getContinuationPolicy())
	if (decision.type !== "continue") return

	const count = reactiveNudgeCounts.get(fresh.id) ?? 0
	if (count >= MAX_CONSECUTIVE_REACTIVE_NUDGES) {
		const suppressionText = `Continuation nudge suppressed after ${count} consecutive text-only assistant turns for "${fresh.name}".`
		void pi.sendMessage(
			{
				customType: "ferment_breadcrumb",
				content: [{ type: "text", text: suppressionText }],
				display: true,
				details: { text: suppressionText, variant: "step" },
			},
			{ triggerTurn: false },
		)
		return
	}

	reactiveNudgeCounts.set(fresh.id, count + 1)
	scheduleNextFermentAction(pi, fresh, runtime, {
		tag: "Reactive continuation nudge",
		deliverAsFollowUp: true,
	})
}

/**
 * Fired from `turn_end` when the assistant made tool calls this turn but then
 * ended with `stopReason === "stop"` while a ferment still requires action.
 *
 * The reactive continuation nudge only fires on *text-only* turns
 * (`!toolCallSeen`). Without this nudge, the pattern:
 *
 *   complete_ferment_step → summary text → [stop]
 *
 * would leave the ferment running with no automatic prompt to call
 * `start_ferment_step` or `complete_ferment_phase` next.
 *
 * Returns true if a nudge was injected.
 */
export function maybeInjectFermentStopNudge(
	pi: ExtensionAPI,
	runtime: FermentRuntime = defaultFermentRuntime,
): boolean {
	if (!runtime.isAutomatedContinuationEnabled()) return false
	const id = runtime.getActiveId()
	if (!id) return false
	const fresh = refreshActiveFermentFromStorage(runtime)
	const inactive = !fresh || fresh.status === "complete" || fresh.status === "abandoned"
	if (inactive) runtime.setActive(undefined)
	if (inactive || fresh.status === "paused") {
		stopNudgeCounts.delete(id)
		return false
	}

	// Treat complete_ferment as continuable here: after the last phase all
	// phases can be terminal and the engine returns a complete_ferment action,
	// but the ferment is not yet status:"complete" until the tool is actually
	// called. Without this flag the stop-nudge path would return idle and fail
	// to recover the final lifecycle step.
	const decision = decideContinuation(fresh, runtime.getContinuationPolicy(), {
		treatCompleteFermentAsContinue: true,
	})
	if (decision.type !== "continue") return false

	const count = stopNudgeCounts.get(fresh.id) ?? 0
	if (count >= MAX_CONSECUTIVE_STOP_NUDGES) {
		const suppressionText = `Ferment stop nudge suppressed after ${count} consecutive early-stop turns for "${fresh.name}".`
		void pi.sendMessage(
			{
				customType: "ferment_breadcrumb",
				content: [{ type: "text", text: suppressionText }],
				display: true,
				details: { text: suppressionText, variant: "step" },
			},
			{ triggerTurn: false },
		)
		return false
	}

	stopNudgeCounts.set(fresh.id, count + 1)
	scheduleNextFermentAction(pi, fresh, runtime, {
		tag: "Ferment stop nudge",
		deliverAsFollowUp: true,
		treatCompleteFermentAsContinue: true,
	})
	return true
}

export function onStepCompleted(runtime: FermentRuntime = defaultFermentRuntime): void {
	refreshActiveFermentFromStorage(runtime)
}

export function onPhaseCompleted(runtime: FermentRuntime = defaultFermentRuntime): void {
	// Refresh the in-memory active ferment cache after the storage write. The agent
	// drives state; no silent activate_ferment_phase here. Prior versions auto-advanced
	// the next planned phase, which left the FSM in PHASE_ACTIVE
	// behind the agent's back and caused every subsequent agent-initiated
	// activate_ferment_phase to be rejected.
	refreshActiveFermentFromStorage(runtime)
}

/**
 * Called from turn_end when a tool call is seen. Resets the stop-nudge counter
 * since the model is actively driving the ferment forward — back-to-back tool
 * turns should not count against the stop-nudge budget.
 */
export function onFermentToolCallSeen(fermentId: string): void {
	stopNudgeCounts.delete(fermentId)
}

// ─── Scoping exploration progress nudge ───────────────────────────────────────
// During draft scoping, detects when the model has spent too many turns on
// read-like exploration without progressing through the scoping steps
// (ask_user, confirm_ferment_completion_criteria, propose_ferment_scoping).
// Unlike the reactive continuation nudge (which only fires on text-only turns),
// this fires even when the model IS making tool calls — just the wrong kind.

/** Tool names that indicate the model is making scoping progress, not just exploring. */
const SCOPING_PROGRESS_TOOLS = new Set([
	"ask_user",
	"confirm_ferment_completion_criteria",
	"propose_ferment_scoping",
	"Agent",
])

/** Check if any tool call in the turn was a scoping-progress tool. */
export function hasScopingProgressTool(toolNames: string[]): boolean {
	return toolNames.some((name) => SCOPING_PROGRESS_TOOLS.has(name))
}

/**
 * Called from turn_end when a draft ferment's scoping is interactive.
 * If the model made tool calls but none were scoping-progress tools,
 * bump the exploration turn counter and inject a nudge after the threshold.
 *
 * Returns true if a nudge was injected.
 */
export function maybeInjectScopingProgressNudge(pi: ExtensionAPI, fermentId: string, toolNames: string[]): boolean {
	if (hasScopingProgressTool(toolNames)) {
		resetScopingExploreTurns(fermentId)
		return false
	}

	const count = bumpScopingExploreTurns(fermentId)
	if (count < MAX_SCOPING_EXPLORE_TURNS) return false

	// Reset after nudge so we don't spam every turn
	resetScopingExploreTurns(fermentId)

	void pi.sendMessage(
		{
			customType: "ferment_scoping_progress_nudge",
			content: [
				{
					type: "text",
					text: `SCOPING PROGRESS CHECK: You have spent ${count} turns reading files without advancing through the scoping steps. Stop exploring and move to the next scoping step NOW.

- If you haven't asked the user any questions yet, call ask_user with your interview questions (Step 2).
- If you've completed the interview, call confirm_ferment_completion_criteria to confirm success criteria (Step 3).
- If criteria are confirmed, call propose_ferment_scoping with the full plan (Step 5).
- Do NOT continue reading more files. You have enough context to proceed.`,
				},
			],
			display: false,
			details: undefined,
		},
		{ triggerTurn: true },
	)
	return true
}
