// Esc never stops background work by itself. When Esc finds work still
// running, this asks the user whether to stop it. "Stop all" needs a
// deliberate choice, so pressing Esc many times can never kill work.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { type BackgroundWorkItem, listBackgroundWork, stopAllBackgroundWork } from "../../shared/background-work.js"
import { withRawInputCapture } from "../shared-input.js"
import { isStaleCtxError } from "../stale-ctx.js"

export const STOP_DIALOG_TITLE = "Background work is still running"
export const KEEP_RUNNING = "Keep running"
export const STOP_ALL = "Stop all"

const MAX_LABELS = 3
const MAX_LINE_CHARS = 100

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function kindLine(items: BackgroundWorkItem[], noun: string): string | null {
	if (items.length === 0) return null
	const head = `${plural(items.length, noun)}   `
	const labels = items.slice(0, MAX_LABELS).map((item) => item.label)
	const rest = items.length - labels.length
	const tail = rest > 0 ? ` +${rest} more` : ""
	let body = labels.join(" · ")
	const room = MAX_LINE_CHARS - head.length - tail.length
	if (body.length > room) body = `${body.slice(0, Math.max(0, room - 1))}…`
	return `${head}${body}${tail}`
}

/** Dialog title: a heading, then one line per kind of work. */
export function formatTitle(items: BackgroundWorkItem[]): string {
	const lines = [
		STOP_DIALOG_TITLE,
		kindLine(
			items.filter((item) => item.kind === "process"),
			"command",
		),
		kindLine(
			items.filter((item) => item.kind === "agent"),
			"agent",
		),
	]
	return lines.filter((line): line is string => line !== null).join("\n")
}

/** Notice after "Stop all". Work may end on its own while the dialog is open. */
export function formatStopped(processes: number, agents: number): string {
	const parts: string[] = []
	if (processes > 0) parts.push(plural(processes, "command"))
	if (agents > 0) parts.push(plural(agents, "agent"))
	if (parts.length === 0) return "Nothing was running"
	return `Stopped ${parts.join(" and ")}`
}

export interface StopBackgroundPrompt {
	onEscape(): void
	/** Call from `agent_settled`: an Esc during the run asks once the run has ended. */
	onRunSettled(ctx: ExtensionContext): void
	dispose(): void
}

export function createStopBackgroundPrompt(getCtx: () => ExtensionContext | null): StopBackgroundPrompt {
	let busy = false
	// Esc came during a run. The run is still aborting, so ask when it has settled.
	let askAfterRun = false
	let dialogAbort: AbortController | undefined
	// Bumped on dispose so work started for an old session ends quietly.
	let generation = 0

	const openDialog = async (ctx: ExtensionContext, gen: number) => {
		const sessionId = ctx.sessionManager.getSessionId()
		const items = listBackgroundWork(sessionId)
		// The in-flight command often ends with the aborted turn.
		if (items.length === 0) return
		const abort = new AbortController()
		dialogAbort = abort
		const choice = await withRawInputCapture(() =>
			ctx.ui.select(formatTitle(items), [KEEP_RUNNING, STOP_ALL], { signal: abort.signal }),
		)
		if (choice !== STOP_ALL || gen !== generation) return
		const { processes, agents } = await stopAllBackgroundWork(sessionId)
		if (gen !== generation) return
		if (ctx.hasUI) ctx.ui.notify(formatStopped(processes, agents), "info")
	}

	const run = (ctx: ExtensionContext) => {
		const gen = generation
		busy = true
		openDialog(ctx, gen)
			.catch((err) => {
				if (!isStaleCtxError(err)) console.error("stop-background: dialog failed:", err)
			})
			.finally(() => {
				if (gen !== generation) return
				busy = false
				dialogAbort = undefined
			})
	}

	return {
		onEscape() {
			if (busy) return
			const ctx = getCtx()
			if (!ctx) return
			try {
				if (!ctx.hasUI) return
				if (!ctx.isIdle()) {
					askAfterRun = true
					return
				}
				if (listBackgroundWork(ctx.sessionManager.getSessionId()).length === 0) return
				run(ctx)
			} catch (err) {
				if (!isStaleCtxError(err)) throw err
			}
		},
		onRunSettled(ctx) {
			if (!askAfterRun) return
			askAfterRun = false
			if (busy || !ctx.hasUI) return
			run(ctx)
		},
		dispose() {
			generation++
			askAfterRun = false
			dialogAbort?.abort()
			dialogAbort = undefined
			busy = false
		},
	}
}
