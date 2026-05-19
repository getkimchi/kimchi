/**
 * LLM nudges and post-mutation hooks.
 *
 * - `appendRefEntry`: writes a hidden session entry that survives compaction —
 *   used so resumed sessions can find the active ferment.
 * - `maybeInjectReactiveContinuationNudge`: under automated policy, injects an
 *   action-specific prompt only after an assistant turn stalls without tool calls.
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

export function resetReactiveContinuationNudgeCount(fermentId: string): void {
	reactiveNudgeCounts.delete(fermentId)
}

export function resetAllReactiveContinuationNudgeCounts(): void {
	reactiveNudgeCounts.clear()
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
