import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isRawInputCaptureActive } from "../shared-input.js"
import type { PermissionOrigin, ToolPermissionPrompter } from "./prompter.js"
import { promptForApproval } from "./prompts.js"

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
	notice: string,
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
			ctx.ui.notify(notice, "info")
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
	const unsubscribeInput = ctx.ui.onTerminalInput(() => {
		if (Date.now() - openedAt < timing.openingGuardMs) return { consume: true }
		return undefined
	})
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
 * Interactive escalation only. Connected clients keep their ordinary card
 * lifecycle: cards do not capture the terminal keyboard.
 */
export function createEscalatedTerminalPrompter(
	ctx: ExtensionContext,
	lastInputAt: LastTerminalInput,
	hasOtherDialogs: HasOtherDialogs,
): ToolPermissionPrompter {
	return {
		request: async (req) => {
			const selectionController = new AbortController()
			const forwardAbort = () => selectionController.abort(req.signal?.reason)
			const detachParentAbort = () => req.signal?.removeEventListener("abort", forwardAbort)
			const attachParentAbort = () => {
				if (!req.signal) return
				if (req.signal.aborted) forwardAbort()
				else req.signal.addEventListener("abort", forwardAbort, { once: true })
			}
			// Unlike selector cancellation, waiting always follows the parent
			// controller, so losing a slot does not lose the mode-change signal.
			const requestSignal = req.signal ?? selectionController.signal
			const hasForeignDialog = () => isRawInputCaptureActive() || hasOtherDialogs()
			const notice = `Subagent ${originLabel(req.origin)} is waiting for permission. Its prompt will open when the input editor is empty and no other dialog is active.`
			// The toast above fades; this line stays for as long as the prompt
			// is held back, and goes away once the selector is on screen.
			const status = `Subagent ${req.origin?.persona ?? "assistant"} is waiting for permission · its prompt opens when the input is empty and no dialog is open`
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
			// A selector that gave way to another dialog leaves the working
			// indicator hidden for that dialog to restore (see promptForApproval).
			let workingLeftHidden = false
			try {
				while (true) {
					try {
						await waitForEscalatedInput(
							ctx,
							lastInputAt,
							requestSignal,
							notice,
							hasForeignDialog,
							DEFAULT_TIMING,
							showStatus,
						)
					} catch (error) {
						if (requestSignal.aborted) return { kind: "aborted" }
						throw error
					} finally {
						clearStatus()
					}
					attachParentAbort()
					const outcome = await promptForApproval({
						toolName: req.toolName,
						input: req.input,
						ctx,
						subtitle: req.subtitle,
						riskScore: req.riskScore,
						choices: req.choices,
						origin: req.origin,
						signal: selectionController.signal,
						onForeignDialog: (onWithdraw) =>
							watchEscalatedDialog(
								ctx,
								() => {
									// Never forward later aborts into a selector whose slot
									// was already taken by another dialog.
									detachParentAbort()
									onWithdraw()
								},
								hasForeignDialog,
								selectionController.signal,
							),
					})
					if (outcome.kind !== "aborted" || requestSignal.aborted) {
						workingLeftHidden = false
						return outcome
					}
					// A different dialog withdrew this selection. The old selector
					// is left alone; a fresh one is opened after it finishes.
					workingLeftHidden = true
				}
			} finally {
				detachParentAbort()
				clearStatus()
				// The request ended while held back. If the dialog we gave way to
				// is gone and did not restore the indicator itself, nobody else will.
				if (workingLeftHidden && !hasForeignDialog()) ctx.ui.setWorkingVisible?.(true)
			}
		},
	}
}
