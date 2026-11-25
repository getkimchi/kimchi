import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import {
	flushRawStdout,
	writeRawStdout,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/output-guard.js"
import type { ReviewPanelChildUsage } from "../review-panel/types.js"

export const REVIEW_PRINT_GRACE_MS = 60_000
export const REVIEW_PRINT_EXIT_MARGIN_MS = 3_000

let jsonEnabled = false
let settled = false
let termination: ReviewPrintTermination | undefined

export interface ReviewPrintTerminationOptions {
	deadlineMs: number
	abort: (reason: unknown) => void
	/** @internal Test-only watchdog shortening; production keeps the fixed 60 s grace. */
	graceMs?: number
	/** @internal Test-only final margin; production exits three seconds before KILL. */
	exitMarginMs?: number
}

function writeJson(value: unknown): void {
	writeRawStdout(`${JSON.stringify(value)}\n`)
}

export async function configureReviewPrintStream(enabled: boolean): Promise<void> {
	jsonEnabled = enabled
	settled = false
}

export function emitReviewSystemMessage(ctx: ExtensionCommandContext, pi: ExtensionAPI): void {
	if (!jsonEnabled) return
	const active = new Set(pi.getActiveTools())
	const message = {
		role: "system",
		content: ctx.getSystemPrompt(),
		timestamp: Date.now(),
		toolsAdded: pi.getAllTools().filter((tool) => active.has(tool.name)),
	}
	writeJson({ type: "message_start", message })
	writeJson({ type: "message_end", message })
}

export function emitReviewChildUsage(usage: ReviewPanelChildUsage): void {
	if (!jsonEnabled) return
	writeJson({ type: "child_usage", ...usage })
}

export function emitReviewAgentSettled(): void {
	if (!jsonEnabled || settled) return
	settled = true
	writeJson({ type: "agent_settled", aborted: false })
}

export async function flushReviewPrintEvents(): Promise<void> {
	await flushRawStdout()
}

/** Scoped replacement for upstream print-mode's immediate TERM disposal. Only
 * an active review command installs this; ordinary print sessions are untouched. */
export class ReviewPrintTermination {
	private readonly previous = new Map<NodeJS.Signals, NodeJS.SignalsListener[]>()
	private readonly abortController = new AbortController()
	private timer: ReturnType<typeof setTimeout> | undefined
	private terminated = false
	private finished = false
	private forced = false
	private readonly terminateHandler = () => this.terminate()

	constructor(private readonly options: ReviewPrintTerminationOptions) {}

	get signal(): AbortSignal {
		return this.abortController.signal
	}

	start(): void {
		for (const signal of ["SIGTERM"] as const) {
			const listeners = process.listeners(signal) as NodeJS.SignalsListener[]
			this.previous.set(signal, listeners)
			for (const listener of listeners) process.off(signal, listener)
			process.on(signal, this.terminateHandler)
		}
		const exitAt =
			this.options.deadlineMs +
			(this.options.graceMs ?? REVIEW_PRINT_GRACE_MS) -
			(this.options.exitMarginMs ?? REVIEW_PRINT_EXIT_MARGIN_MS)
		this.timer = setTimeout(
			() => {
				if (this.finished) return
				this.forced = true
				this.terminated = true
				this.options.abort(new Error("Review print finalization grace expired."))
				this.abortController.abort(new Error("Review print finalization grace expired."))
				void flushReviewPrintEvents().finally(() => {
					process.exitCode = 143
					// Last-resort watchdog only. Normal and TERM finalization return through
					// the ordinary print host and never need an immediate process.exit.
					process.exit(143)
				})
			},
			Math.max(0, exitAt - Date.now()),
		)
		this.timer.unref?.()
	}

	private terminate(): void {
		if (this.finished || this.terminated) return
		this.terminated = true
		const reason = new Error("Review print received SIGTERM; finalizing durable review output.")
		this.options.abort(reason)
		this.abortController.abort(reason)
		process.exitCode = 143
	}

	async finish(): Promise<void> {
		if (this.finished) return
		this.finished = true
		if (this.timer) clearTimeout(this.timer)
		emitReviewAgentSettled()
		await flushReviewPrintEvents()
		for (const [signal, listeners] of this.previous) {
			process.off(signal, this.terminateHandler)
			for (const listener of listeners) process.on(signal, listener)
		}
		this.previous.clear()
		termination = undefined
		if (this.terminated && !this.forced) process.exitCode = 143
	}
}

export function startReviewPrintTermination(options: ReviewPrintTerminationOptions): ReviewPrintTermination {
	if (termination) throw new Error("A review print finalization scope is already active.")
	termination = new ReviewPrintTermination(options)
	termination.start()
	return termination
}
