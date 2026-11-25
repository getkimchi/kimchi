import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { raceWithTimeout } from "../../shared/race-with-timeout.js"
import type { ReviewPanelChildUsage, ReviewPanelDroppedUsage } from "./types.js"

type Usage = ReviewPanelChildUsage["usage"]

function usageKey(provider: string, model: string, writer: string): string {
	return JSON.stringify({ writer, provider, model })
}

function zeroUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function add(
	target: Usage,
	message: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
): void {
	target.input += message.input ?? 0
	target.output += message.output ?? 0
	target.cacheRead += message.cacheRead ?? 0
	target.cacheWrite += message.cacheWrite ?? 0
}

export interface ReviewUsageFlushOptions {
	deadline?: number
	exitMarginMs?: number
}

/** Tracks message_end once per child session. Differential flushes include
 * cleanup traffic once; close detaches every subscription and blocks all later emission. */
export class ReviewPanelUsageBuffer {
	private readonly totals = new Map<string, ReviewPanelChildUsage>()
	private readonly flushed = new Map<string, Usage>()
	private readonly subscriptions = new Map<AgentSession, () => void>()
	private readonly deliveryController = new AbortController()
	private closed = false

	constructor(
		private readonly emit: ((usage: ReviewPanelChildUsage, signal: AbortSignal) => void | Promise<void>) | undefined,
		private readonly parentToolCallId?: string,
		private readonly onDrop?: (dropped: ReviewPanelDroppedUsage) => void,
	) {}

	attach(writer: string, session: AgentSession): void {
		if (this.closed || this.subscriptions.has(session)) return
		const detach = session.subscribe((event) => {
			if (this.closed || event.type !== "message_end" || event.message.role !== "assistant") return
			const message = event.message
			const key = usageKey(message.provider, message.model, writer)
			const current = this.totals.get(key) ?? {
				writer,
				provider: message.provider,
				model: message.model,
				usage: zeroUsage(),
				...(this.parentToolCallId === undefined ? {} : { parentToolCallId: this.parentToolCallId }),
			}
			add(current.usage, message.usage)
			this.totals.set(key, current)
		})
		this.subscriptions.set(session, detach)
	}

	private drop(entry: ReviewPanelChildUsage): void {
		const dropped: ReviewPanelDroppedUsage = { ...entry, usage: { ...entry.usage }, reason: "deadline" }
		this.onDrop?.(dropped)
		console.warn(
			`[review-panel] Dropped child usage at the deadline: ${entry.writer}/${entry.provider}/${entry.model} ` +
				`input=${entry.usage.input} output=${entry.usage.output} cacheRead=${entry.usage.cacheRead} cacheWrite=${entry.usage.cacheWrite}`,
		)
	}

	async flush(options: ReviewUsageFlushOptions = {}): Promise<void> {
		if (!this.emit || this.closed) return
		const cutoff = options.deadline === undefined ? undefined : options.deadline - (options.exitMarginMs ?? 0)
		const entries = [...this.totals.entries()].sort(([left], [right]) => left.localeCompare(right))
		for (const [key, entry] of entries) {
			if (this.closed) return
			const prior = this.flushed.get(key) ?? zeroUsage()
			const delta: Usage = {
				input: entry.usage.input - prior.input,
				output: entry.usage.output - prior.output,
				cacheRead: entry.usage.cacheRead - prior.cacheRead,
				cacheWrite: entry.usage.cacheWrite - prior.cacheWrite,
			}
			if (Object.values(delta).every((value) => value === 0)) continue
			const remaining = cutoff === undefined ? undefined : Math.max(0, cutoff - Date.now())
			if (this.deliveryController.signal.aborted) {
				this.drop(entry)
				continue
			}
			const delivery = this.emit({ ...entry, usage: delta }, this.deliveryController.signal)
			if (delivery instanceof Promise) {
				if (remaining === 0) {
					// A synchronously emitted record is already safe, but a pending
					// callback must not be allowed to extend this coordinator past D.
					this.abortDelivery("Review usage delivery deadline expired")
					this.drop({ ...entry, usage: delta })
					void delivery.catch(() => {})
					continue
				}
				const delivered = await raceWithTimeout(
					delivery,
					remaining ?? Number.POSITIVE_INFINITY,
					"timeout" as const,
					() => this.abortDelivery("Review usage delivery timed out"),
				)
				if (delivered === "timeout") {
					// The pending callback is intentionally not awaited and is lost. A fresh
					// wrap-up never replays it or charges this delta twice.
					this.drop({ ...entry, usage: delta })
					continue
				}
			}
			this.flushed.set(key, { ...entry.usage })
		}
	}

	private abortDelivery(reason: string): void {
		if (!this.deliveryController.signal.aborted) this.deliveryController.abort(new Error(reason))
	}

	close(): void {
		if (this.closed) return
		this.closed = true
		this.abortDelivery("Review usage delivery closed")
		for (const detach of this.subscriptions.values()) detach()
		this.subscriptions.clear()
	}
}
