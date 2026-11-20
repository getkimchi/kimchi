import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isRawInputCaptureActive } from "../shared-input.js"
import type { PermissionOrigin, PermissionRequest } from "./prompter.js"
import { type ApprovalOutcome, promptForApproval } from "./prompts.js"

const RECENT_INPUT_QUIET_MS = 1000
const OPENING_INPUT_GUARD_MS = 500
const INTERACTION_POLL_MS = 25

interface EscalatedInteractionTiming {
	quietMs: number
	openingGuardMs: number
	pollMs: number
}

const DEFAULT_TIMING: EscalatedInteractionTiming = {
	quietMs: RECENT_INPUT_QUIET_MS,
	openingGuardMs: OPENING_INPUT_GUARD_MS,
	pollMs: INTERACTION_POLL_MS,
}

/** The parent session's time of its most recent raw terminal input. */
export type LastTerminalInput = () => number

export type HasOtherDialogs = () => boolean

function interactionBlocked(
	ctx: ExtensionContext,
	lastInputAt: LastTerminalInput,
	quietMs: number,
	hasOtherDialogs: HasOtherDialogs,
): boolean {
	return (
		isRawInputCaptureActive() ||
		ctx.ui.getEditorText().length > 0 ||
		Date.now() - lastInputAt() < quietMs ||
		hasOtherDialogs()
	)
}

function waitForPoll(signal: AbortSignal, ms: number): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer)
			signal.removeEventListener("abort", done)
			resolve()
		}
		const timer = setTimeout(done, ms)
		signal.addEventListener("abort", done, { once: true })
	})
}

/**
 * Wait without changing the editor. A background request must not replace a
 * draft or an already-focus-trapping dialog just because its worker finished.
 */
export async function waitForEscalatedInput(
	ctx: ExtensionContext,
	lastInputAt: LastTerminalInput,
	signal: AbortSignal,
	/** Toast shown once when the request is held back; omit to stay silent. */
	notice: string | undefined,
	hasOtherDialogs: HasOtherDialogs,
	timing: EscalatedInteractionTiming = DEFAULT_TIMING,
	/** Called once, when the request is first held back. */
	onDeferred?: () => void,
): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) return
	let notified = false
	while (interactionBlocked(ctx, lastInputAt, timing.quietMs, hasOtherDialogs)) {
		if (signal.aborted) throw signal.reason ?? new Error("Permission prompt aborted")
		if (!notified) {
			if (notice) ctx.ui.notify(notice, "info")
			onDeferred?.()
			notified = true
		}
		await waitForPoll(signal, timing.pollMs)
	}
	if (signal.aborted) throw signal.reason ?? new Error("Permission prompt aborted")
}

/**
 * Treat a selector as withdrawn without aborting or hiding it. A later mode
 * change must not make that stale selector clear the new dialog's slot.
 */
export function watchEscalatedDialog(
	ctx: ExtensionContext,
	onWithdraw: () => void,
	hasOtherDialogs: HasOtherDialogs,
	signal?: AbortSignal,
	timing: EscalatedInteractionTiming = DEFAULT_TIMING,
): () => void {
	if (ctx.mode !== "tui" || !ctx.hasUI) return () => {}
	let stopped = false
	const stop = () => {
		if (stopped) return
		stopped = true
		clearInterval(interval)
		unsubscribeInput()
		signal?.removeEventListener("abort", stop)
	}
	const check = () => {
		if (hasOtherDialogs()) {
			onWithdraw()
			stop()
		}
	}
	const interval = setInterval(check, timing.pollMs)
	const openedAt = Date.now()
	// No guard at all for a text box: its opening keys are the user's typing.
	const unsubscribeInput =
		timing.openingGuardMs > 0
			? ctx.ui.onTerminalInput(() => {
					if (Date.now() - openedAt < timing.openingGuardMs) return { consume: true }
					return undefined
				})
			: () => {}
	check()
	signal?.addEventListener("abort", stop, { once: true })
	return stop
}

/** Rendered by the status line's info row (components/status-line.ts). */
const WAITING_STATUS_KEY = "permission-subagent-wait"

function originLabel(origin: PermissionOrigin | undefined): string {
	const persona = origin?.persona ?? "assistant"
	return origin?.description ? `${persona} — ${origin.description}` : persona
}

/**
 * What asking produced: the user's answer, or `deferred` when the selector
 * could not open or gave way to another dialog before an answer was given.
 * A deferred request goes back to waiting and is asked again.
 */
export type EscalatedPromptResult = ApprovalOutcome | { kind: "deferred" }

export interface EscalatedTerminalOptions {
	lastInputAt: LastTerminalInput
	hasOtherDialogs: HasOtherDialogs
	/** Called once per request, the first time it is held back. */
	onFirstHold?: () => void
	timing?: EscalatedInteractionTiming
}

/**
 * One escalated request in the terminal, in two steps so that the caller can
 * keep the first one out of the prompt queue: a request that is held back is
 * not on screen and must not make the session's own prompts wait behind it.
 */
export interface EscalatedTerminalInteraction {
	/** Whether the selector may open right now. */
	isPromptable(): boolean
	/**
	 * Hold the request back until the selector may open, without touching the
	 * editor. The toast is shown once per request; the status line stays for
	 * as long as the request is held back. Resolves `false` when the request's
	 * signal fires first.
	 */
	waitUntilPromptable(): Promise<boolean>
	/** Open the selector now. */
	prompt(): Promise<EscalatedPromptResult>
	/** The request is over: clear the waiting line and repair the working indicator. */
	dispose(): void
}

/**
 * Interactive escalation only. Connected clients keep their ordinary card
 * lifecycle: cards do not capture the terminal keyboard.
 */
export function createEscalatedTerminalInteraction(
	ctx: ExtensionContext,
	req: PermissionRequest,
	options: EscalatedTerminalOptions,
): EscalatedTerminalInteraction {
	const timing = options.timing ?? DEFAULT_TIMING
	// Waiting and the selector both follow the request's own signal (mode
	// change, stopped subagent, answer timeout).
	const requestSignal = req.signal ?? new AbortController().signal
	const hasForeignDialog = () => isRawInputCaptureActive() || options.hasOtherDialogs()
	const notice = `Subagent ${originLabel(req.origin)} is waiting for permission. Its prompt will open when the input is empty and no question is open.`
	// The toast above fades; this line stays for as long as the prompt
	// is held back, and goes away once the selector is on screen. Both name
	// only what is checked: menus the user opens are not tracked yet.
	const status = `Subagent ${req.origin?.persona ?? "assistant"} is waiting for permission · its prompt opens when the input is empty and no question is open`
	let statusShown = false
	const showStatus = () => {
		statusShown = true
		ctx.ui.setStatus(WAITING_STATUS_KEY, status)
	}
	const clearStatus = () => {
		if (!statusShown) return
		statusShown = false
		ctx.ui.setStatus(WAITING_STATUS_KEY, undefined)
	}
	let heldBefore = false
	// A selector that gave way to another dialog leaves the working
	// indicator hidden for that dialog to restore (see promptForApproval).
	let workingLeftHidden = false

	return {
		isPromptable: () => !interactionBlocked(ctx, options.lastInputAt, timing.quietMs, hasForeignDialog),

		async waitUntilPromptable() {
			try {
				await waitForEscalatedInput(
					ctx,
					options.lastInputAt,
					requestSignal,
					heldBefore ? undefined : notice,
					hasForeignDialog,
					timing,
					() => {
						showStatus()
						if (heldBefore) return
						heldBefore = true
						options.onFirstHold?.()
					},
				)
				return true
			} catch (error) {
				if (requestSignal.aborted) return false
				throw error
			} finally {
				clearStatus()
			}
		},

		async prompt() {
			const selectionController = new AbortController()
			const forwardAbort = () => selectionController.abort(requestSignal.reason)
			const detachParentAbort = () => requestSignal.removeEventListener("abort", forwardAbort)
			if (requestSignal.aborted) forwardAbort()
			else requestSignal.addEventListener("abort", forwardAbort, { once: true })
			try {
				const outcome = await promptForApproval({
					toolName: req.toolName,
					input: req.input,
					ctx,
					subtitle: req.subtitle,
					riskScore: req.riskScore,
					choices: req.choices,
					origin: req.origin,
					signal: selectionController.signal,
					onForeignDialog: (onWithdraw, phase) =>
						watchEscalatedDialog(
							ctx,
							() => {
								// Never forward later aborts into a selector or text box
								// whose slot was already taken by another dialog.
								detachParentAbort()
								onWithdraw()
							},
							hasForeignDialog,
							selectionController.signal,
							// The selector ignores keys that were already on their way
							// when it opened. The feedback text box must not: the
							// user is typing into it.
							phase === "feedback" ? { ...timing, openingGuardMs: 0 } : timing,
						),
				})
				if (outcome.kind !== "aborted" || requestSignal.aborted) {
					workingLeftHidden = false
					return outcome
				}
				// A different dialog withdrew this selection. The old selector is
				// left alone; the request waits again and a fresh one is opened.
				workingLeftHidden = true
				return { kind: "deferred" }
			} finally {
				detachParentAbort()
			}
		},

		dispose() {
			clearStatus()
			// The request ended while held back. If the dialog we gave way to
			// is gone and did not restore the indicator itself, nobody else will.
			if (workingLeftHidden && !hasForeignDialog()) ctx.ui.setWorkingVisible?.(true)
		},
	}
}
