/**
 * Post-mutation hooks for ferment tools.
 *
 * - `appendRefEntry`: writes a hidden session entry that survives compaction —
 *   used so resumed sessions can find the active ferment.
 * - `onStepCompleted` / `onPhaseCompleted`: stable post-mutation hooks tools
 *   call after writing storage. Today they re-sync active ferment state; keep
 *   callers on the hook so future post-mutation logic has one place to live.
 *
 * User abort (Esc/Ctrl+C) is handled at the `turn_end` boundary in `events.ts`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Ferment } from "../../ferment/types.js"
import { defaultFermentRuntime, type FermentRuntime } from "./runtime.js"
import { safeSendMessage } from "./safe-send.js"

export function appendRefEntry(pi: ExtensionAPI, fermentId: string): void {
	safeSendMessage(pi, {
		customType: "ferment_reference",
		content: [{ type: "text", text: `active: ${fermentId}` }],
		display: false,
		details: { fermentId },
	})
}

export function refreshActiveFermentFromStorage(runtime: FermentRuntime): Ferment | undefined {
	const id = runtime.getActiveId()
	if (!id) return undefined
	const fresh = runtime.getStorage().get(id)
	if (fresh) runtime.setActive(fresh)
	return fresh
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
