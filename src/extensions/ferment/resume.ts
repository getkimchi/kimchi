import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { appendRefEntry } from "./nudge.js"
import { type FermentRuntime, defaultFermentRuntime } from "./runtime.js"
import { scheduleFermentWakeUp } from "./scheduler.js"
import { createApplyAndPersist } from "./tool-helpers.js"
import { setActiveFermentAndApplyProfile } from "./tool-scope.js"
import { checkWorktree } from "./worktree.js"

/**
 * Shared by session_start (env-var path) and the /ferment Continue picker.
 * Flips paused to running, validates worktree, re-arms the scoping gate for
 * drafts, and schedules the next legal action so the planner picks up work.
 */
export function resumeFerment(
	pi: ExtensionAPI,
	fermentId: string,
	ctx: ExtensionContext,
	runtime: FermentRuntime = defaultFermentRuntime,
	opts: { allowManualPhaseBoundary?: boolean } = {},
): void {
	const storage = runtime.getStorage()
	const applyAndPersist = createApplyAndPersist(runtime)
	let existing = storage.get(fermentId)
	if (!existing) {
		setActiveFermentAndApplyProfile(pi, runtime, undefined)
		return
	}

	if (existing.status === "complete" || existing.status === "abandoned") {
		setActiveFermentAndApplyProfile(pi, runtime, undefined)
		return
	}

	// Session_shutdown sets running ferments to "paused"; flip back to running
	// on resume so the engine produces a real next-action nudge.
	if (existing.status === "paused") {
		const out = applyAndPersist(existing.id, { type: "resume" })
		if (out.ok) existing = out.ferment
	}

	setActiveFermentAndApplyProfile(pi, runtime, existing)
	appendRefEntry(pi, existing.id)

	const wtCheck = checkWorktree(existing)
	if (wtCheck.severity !== "ok" && wtCheck.message) {
		pi.appendEntry("ferment_worktree_warning", { text: wtCheck.message })
		if (wtCheck.severity === "block") {
			return
		}
	}

	if (existing.status === "draft" && ctx?.hasUI) {
		runtime.markScopingInteractive(existing.id)
	}

	scheduleFermentWakeUp(pi, runtime, { ...opts, fermentId: existing.id, tag: "Resume wake-up" })
}
