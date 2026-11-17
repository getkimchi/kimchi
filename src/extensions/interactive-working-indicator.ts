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

/** The compaction_end event's slice the re-arm reads. */
export interface CompactionEndEvent {
	type: "compaction_end"
	/** Upstream distinguishes the sources: manual /compact vs auto triggers. */
	reason: "manual" | "threshold" | "overflow"
	aborted?: boolean
}

/**
 * Show the working spinner as soon as the main loop accepts a prompt.
 *
 * Upstream first shows it at turn_start — after every before_agent_start
 * hook has completed — so a slow pre-request hook (the memory digest's
 * bounded first-turn wait, custom extensions) parks the screen between the
 * optimistic echo and the first request with no activity indicator at all.
 * Arming the indicator at prompt acceptance covers that window;
 * turn_start's own show is idempotent (it re-shows only when the active
 * indicator is not already "working") and agent_end clears it as before.
 *
 * A run that auto-compacts before its hooks (upstream _prepareRun checks
 * compaction first) replaces the armed spinner with the compaction one, and
 * compaction_end clears it into an empty slot — the re-arm below fills that
 * slot from the event's own source distinction: auto reasons (threshold /
 * overflow) only fire inside run lifecycle, so a turn follows, while manual
 * /compact fires the same events with no following turn and must not spin.
 *
 * Scope: prompts accepted by the interactive input loop are covered, and so
 * is any run that auto-compacts first (including startup initialMessage
 * prompts). Still uncovered — upstream behavior, unchanged by this patch:
 * prompts submitted during compaction (they flush as steers into the next
 * run, which shows its own spinner at turn_start) and non-compacting
 * initialMessage runs.
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

/**
 * Re-arm the working spinner after an auto-compaction settles: the original
 * compaction_end handler clears the compaction indicator into an empty
 * status slot while the run's before_agent_start hooks (the memory digest's
 * bounded wait among them) are still ahead of turn_start. Only auto reasons
 * re-arm — manual /compact emits the same event with no following turn.
 */
export const showWorkingIndicatorAfterAutoCompaction = (
	mode: WorkingIndicatorHost,
	event: CompactionEndEvent,
): void => {
	if (event.reason === "manual") return
	// An aborted auto-compaction may not be followed by a turn — the run can
	// die with the cancel. turn_start re-shows if the run survives.
	if (event.aborted) return
	if (!mode.workingVisible) return
	mode.showWorkingStatusIndicator()
}

/**
 * Wrap a handleEvent implementation so a settled auto-compaction re-arms the
 * working spinner after the original handler ran (it clears the compaction
 * indicator; arming after it fills the slot rather than racing it).
 */
export function wrapHandleEvent<E extends { type: string }>(
	handleEvent: (this: WorkingIndicatorHost, event: E) => Promise<void> | void,
): (this: WorkingIndicatorHost, event: E) => Promise<void> {
	return async function patchedHandleEvent(this: WorkingIndicatorHost, event: E): Promise<void> {
		await handleEvent.call(this, event)
		if (isCompactionEnd(event)) showWorkingIndicatorAfterAutoCompaction(this, event)
	}
}

const isCompactionEnd = (event: { type: string }): event is CompactionEndEvent => event.type === "compaction_end"

/** Patch InteractiveMode so the working spinner spans the pre-request window. */
export function applyInteractiveWorkingIndicatorPatch(): void {
	// biome-ignore lint/suspicious/noExplicitAny: private upstream prototype adapter
	const prototype = InteractiveMode.prototype as any
	if (prototype.__kimchiWorkingIndicatorPatched) return
	if (typeof prototype.getUserInput !== "function" || typeof prototype.handleEvent !== "function") {
		// Surface a renamed/moved upstream method instead of installing a wrapper
		// over undefined — that would break every prompt submission.
		console.warn(
			"working-indicator patch: InteractiveMode.getUserInput/handleEvent not found, pre-request spinner inactive",
		)
		return
	}
	prototype.__kimchiWorkingIndicatorPatched = true

	prototype.getUserInput = wrapGetUserInput(
		// biome-ignore lint/suspicious/noExplicitAny: private upstream prototype adapter
		prototype.getUserInput as (this: any) => Promise<string>,
	)
	prototype.handleEvent = wrapHandleEvent(
		// biome-ignore lint/suspicious/noExplicitAny: private upstream prototype adapter
		prototype.handleEvent as (this: any, event: any) => Promise<void>,
	)
}
