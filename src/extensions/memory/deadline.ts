import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"

export type RecallDeliveryStatus = "selected" | "attachedToTurn" | "steered"
export type RecallCancellationReason = "cancelled" | "timed-out" | "droppedStale"

export class RecallDeadlineError extends Error {
	constructor(readonly reason: RecallCancellationReason) {
		super(`memory recall ${reason}`)
		this.name = "RecallDeadlineError"
	}
}

export interface RecallDeadlineOptions {
	scheduledStep: string
	generation: number
	timeoutMs: number
	parentSignal?: AbortSignal
	id?: string
}

/** One retrieval attempt. Ownership is local to an extension instance; the
 * AsyncLocalStorage holds only the request signal, never another run's state. */
export class RecallDeadline {
	readonly id: string
	readonly scheduledStep: string
	readonly generation: number
	readonly signal: AbortSignal
	readonly expiresAt: number
	readonly createdAt: number

	readonly #controller = new AbortController()
	#timer?: NodeJS.Timeout
	#status?: RecallDeliveryStatus
	#cancellation?: RecallCancellationReason

	constructor(options: RecallDeadlineOptions) {
		this.id = options.id ?? randomUUID()
		this.scheduledStep = options.scheduledStep
		this.generation = options.generation
		this.createdAt = Date.now()
		this.expiresAt = this.createdAt + Math.max(0, options.timeoutMs)
		this.signal = options.parentSignal
			? AbortSignal.any([this.#controller.signal, options.parentSignal])
			: this.#controller.signal
		if (this.signal.aborted) this.#setCancellation(options.parentSignal?.aborted ? "cancelled" : "timed-out")
		else {
			this.#timer = setTimeout(() => this.#abort("timed-out"), Math.max(0, options.timeoutMs))
			this.#timer.unref()
			this.signal.addEventListener(
				"abort",
				() => {
					if (this.#controller.signal.aborted) return
					this.#setCancellation("cancelled")
					clearTimeout(this.#timer)
				},
				{ once: true },
			)
		}
	}

	get status(): RecallDeliveryStatus | undefined {
		return this.#status
	}

	get cancellationReason(): RecallCancellationReason | undefined {
		return this.#cancellation
	}

	get remainingMs(): number {
		return Math.max(0, this.expiresAt - Date.now())
	}

	get conclusion(): string {
		// An actual attachment/steer already happened and is not retroactively
		// undone by later scheduling. Selection, however, is only intermediate:
		// aborting after it must not result in a delivered trace.
		if (this.#status === "attachedToTurn" || this.#status === "steered") return this.#status
		return recallCancellationReason(this.signal.reason) ?? this.#cancellation ?? this.#status ?? "unreachable"
	}

	assertActive(currentGeneration = this.generation): void {
		if (currentGeneration !== this.generation) this.#abort("droppedStale")
		if (this.#cancellation) throw new RecallDeadlineError(this.#cancellation)
		this.signal.throwIfAborted()
	}

	canDeliver(currentGeneration = this.generation): boolean {
		try {
			this.assertActive(currentGeneration)
			return true
		} catch {
			return false
		}
	}

	markDelivered(status: RecallDeliveryStatus, currentGeneration = this.generation): void {
		this.assertActive(currentGeneration)
		this.#status = status
	}

	/** Record that the delivery API accepted its payload. Call this only
	 * after the API returns successfully; it is not permission to send. */
	recordAcceptedDelivery(status: "attachedToTurn" | "steered"): void {
		this.#status = status
	}

	cancel(reason: RecallCancellationReason = "cancelled"): void {
		this.#abort(reason)
	}

	dispose(): void {
		clearTimeout(this.#timer)
	}

	trace(): Record<string, unknown> {
		return {
			recall_id: this.id,
			scheduledStep: this.scheduledStep,
			generation: this.generation,
			conclusion: this.conclusion,
		}
	}

	#abort(reason: RecallCancellationReason): void {
		if (this.#controller.signal.aborted) return
		this.#setCancellation(reason)
		this.#controller.abort(new RecallDeadlineError(reason))
		clearTimeout(this.#timer)
	}

	#setCancellation(reason: RecallCancellationReason): void {
		this.#cancellation ??= reason
	}
}

const requestScope = new AsyncLocalStorage<{ signal: AbortSignal }>()

export function withRecallDeadline<T>(deadline: RecallDeadline, work: () => Promise<T>): Promise<T> {
	return requestScope.run({ signal: deadline.signal }, work)
}

/** Settle promptly at the deadline while propagating cancellation to owned
 * work through the request scope. The underlying promise remains observed
 * by the race, so its late rejection cannot become an unhandled error. */
export async function awaitRecallDeadline<T>(work: Promise<T>, deadline: RecallDeadline): Promise<T> {
	deadline.assertActive()
	let listener: (() => void) | undefined
	const cancelled = new Promise<never>((_resolve, reject) => {
		listener = () => reject(deadline.signal.reason)
		deadline.signal.addEventListener("abort", listener, { once: true })
	})
	try {
		return await Promise.race([work, cancelled])
	} finally {
		if (listener) deadline.signal.removeEventListener("abort", listener)
	}
}

export function currentRecallSignal(): AbortSignal | undefined {
	return requestScope.getStore()?.signal
}

export function mergeRecallSignal(signal?: AbortSignal | null): AbortSignal | undefined {
	const recall = currentRecallSignal()
	if (!recall) return signal ?? undefined
	if (!signal || signal === recall) return recall
	return AbortSignal.any([signal, recall])
}

export function recallCancellationReason(err: unknown): RecallCancellationReason | undefined {
	if (err instanceof RecallDeadlineError) return err.reason
	if (err && typeof err === "object" && "reason" in err) {
		const reason = (err as { reason?: unknown }).reason
		if (reason === "cancelled" || reason === "timed-out" || reason === "droppedStale") return reason
	}
	return undefined
}
