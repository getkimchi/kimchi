import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isRawInputCaptureActive } from "../shared-input.js"
import type { PermissionOrigin, ToolPermissionPrompter } from "./prompter.js"
import { promptForApproval } from "./prompts.js"

const RECENT_INPUT_QUIET_MS = 1000
const OPENING_INPUT_GUARD_MS = 200
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

function interactionBlocked(ctx: ExtensionContext, lastInputAt: LastTerminalInput, quietMs: number): boolean {
	return isRawInputCaptureActive() || ctx.ui.getEditorText().length > 0 || Date.now() - lastInputAt() < quietMs
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
	timing: EscalatedInteractionTiming = DEFAULT_TIMING,
): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) return
	let notified = false
	while (interactionBlocked(ctx, lastInputAt, timing.quietMs)) {
		if (signal.aborted) throw signal.reason ?? new Error("Permission prompt aborted")
		if (!notified) {
			ctx.ui.notify(notice, "info")
			notified = true
		}
		await waitForPoll(signal, timing.pollMs)
	}
	if (signal.aborted) throw signal.reason ?? new Error("Permission prompt aborted")
}

/**
 * Protect the selector, but not the feedback input that follows it. A
 * raw-input dialog withdraws the selector so the foreground dialog survives.
 * During the short opening window terminal input is consumed before the
 * selector can answer through its number/navigation shortcuts.
 */
export function watchEscalatedDialog(
	ctx: ExtensionContext,
	controller: AbortController,
	timing: EscalatedInteractionTiming = DEFAULT_TIMING,
): () => void {
	if (ctx.mode !== "tui" || !ctx.hasUI) return () => {}
	let stopped = false
	const stop = () => {
		if (stopped) return
		stopped = true
		clearInterval(interval)
		unsubscribeInput()
		controller.signal.removeEventListener("abort", stop)
	}
	const check = () => {
		if (isRawInputCaptureActive()) {
			controller.abort()
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
	controller.signal.addEventListener("abort", stop, { once: true })
	return stop
}

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
): ToolPermissionPrompter {
	return {
		request: async (req) => {
			const selectionController = new AbortController()
			const forwardAbort = () => selectionController.abort(req.signal?.reason)
			if (req.signal?.aborted) forwardAbort()
			else req.signal?.addEventListener("abort", forwardAbort, { once: true })
			const notice = `Subagent ${originLabel(req.origin)} is waiting for permission. Its prompt will open when the input editor is empty and no other dialog is active.`
			try {
				while (true) {
					await waitForEscalatedInput(ctx, lastInputAt, selectionController.signal, notice)
					const outcome = await promptForApproval({
						toolName: req.toolName,
						input: req.input,
						ctx,
						subtitle: req.subtitle,
						riskScore: req.riskScore,
						choices: req.choices,
						origin: req.origin,
						signal: selectionController.signal,
						onForeignDialog: (controller) => watchEscalatedDialog(ctx, controller),
					})
					if (outcome.kind !== "aborted" || req.signal?.aborted) return outcome
					// A foreign dialog or an in-flight key withdrew this selection.
					// Wait for a quiet input state before restoring the selector.
				}
			} finally {
				req.signal?.removeEventListener("abort", forwardAbort)
			}
		},
	}
}
