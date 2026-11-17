import { InteractiveMode } from "@earendil-works/pi-coding-agent"

/**
 * Instance surface the working-indicator patch touches. `workingVisible`,
 * `clearStatusIndicator`, `showWorkingStatusIndicator` and
 * `isExtensionCommand` are private upstream members — the declaration here
 * documents the adapter contract; access goes through the prototype patch.
 */
interface WorkingIndicatorHost {
	/** Whether the user's settings allow the working spinner (turn_start's guard). */
	workingVisible: boolean
	/** True when the text is an extension command (runs without an LLM turn). */
	isExtensionCommand(text: string): boolean
	showWorkingStatusIndicator(): void
	clearStatusIndicator(kind?: "working"): void
	getUserInput(): Promise<string>
}

/**
 * Show the working spinner as soon as the main loop accepts a prompt.
 *
 * Upstream first shows it at turn_start — after every before_agent_start
 * hook has completed — so a slow pre-request hook (the memory digest's
 * bounded first-turn wait, compaction-adjacent hooks, custom extensions)
 * parks the screen between the optimistic echo and the first request with
 * no activity indicator at all. Arming the indicator at prompt acceptance
 * covers that window; turn_start's own show is idempotent
 * (it re-shows only when the active indicator is not already "working") and
 * agent_end clears it as before.
 *
 * Scope: this covers prompts accepted by the interactive input loop. Turns
 * entered another way keep upstream's behavior — no spinner until
 * turn_start: auto-compaction inside the run replaces the armed indicator
 * with the compaction one (compaction_start → compaction_end) before the
 * hooks run, and compaction-queued or startup initialMessage prompts never
 * pass through getUserInput. A re-arm after compaction_end needs a
 * run-intent signal the TUI does not have (manual /compact fires the same
 * events with no following turn), so those windows are a documented gap,
 * not a regression — they had no indicator before this patch either.
 */
export const showWorkingIndicatorForAcceptedPrompt = (mode: WorkingIndicatorHost, text: string): void => {
	// Extension commands (kimchi's /memory list and friends) execute without
	// an agent turn — a spinner would spin over panels and notifications.
	if (mode.isExtensionCommand(text)) return
	// Mirror turn_start's guard: a user who hid the working indicator keeps
	// that preference for the pre-request window too.
	if (!mode.workingVisible) return
	mode.showWorkingStatusIndicator()
}

/**
 * Wrap a getUserInput implementation with pre-request spinner arming:
 * on loop re-entry drop a stale "working" indicator (a run that aborted
 * before turn_start — a before_agent_start throw — never reaches
 * agent_end's clear, and the loop re-enters here right after the error
 * renders), and arm the indicator when a prompt is accepted.
 */
export function wrapGetUserInput(
	getUserInput: (this: WorkingIndicatorHost) => Promise<string>,
): (this: WorkingIndicatorHost) => Promise<string> {
	return async function patchedGetUserInput(this: WorkingIndicatorHost): Promise<string> {
		this.clearStatusIndicator("working")
		const text = await getUserInput.call(this)
		showWorkingIndicatorForAcceptedPrompt(this, text)
		return text
	}
}

/** Patch InteractiveMode so the working spinner spans the pre-request window. */
export function applyInteractiveWorkingIndicatorPatch(): void {
	// biome-ignore lint/suspicious/noExplicitAny: private upstream prototype adapter
	const prototype = InteractiveMode.prototype as any
	if (prototype.__kimchiWorkingIndicatorPatched) return
	if (typeof prototype.getUserInput !== "function") {
		// Surface a renamed/moved upstream method instead of installing a wrapper
		// over undefined — that would break every prompt submission.
		console.warn("working-indicator patch: InteractiveMode.getUserInput not found, pre-request spinner inactive")
		return
	}
	prototype.__kimchiWorkingIndicatorPatched = true

	prototype.getUserInput = wrapGetUserInput(
		// biome-ignore lint/suspicious/noExplicitAny: private upstream prototype adapter
		prototype.getUserInput as (this: any) => Promise<string>,
	)
}
