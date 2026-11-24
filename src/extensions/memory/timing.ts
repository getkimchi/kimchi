import { type RecallCancellationReason, recallCancellationReason } from "./deadline.js"
import type { TraceRecorder } from "./trace.js"

/** Elapsed wall time for a single request lifecycle, including grouped retries. */
export function elapsedRequestMs(startedAtMonotonicMs: number, now: () => number = () => performance.now()): number {
	return Math.max(0, Math.round(now() - startedAtMonotonicMs))
}

/** Preserve deadline failure categories; generic aborts are not called timeouts. */
export function requestErrorStatus(err: unknown): "failed" | RecallCancellationReason {
	const deadlineReason = recallCancellationReason(err)
	if (deadlineReason) return deadlineReason
	if (typeof err === "object" && err !== null && "name" in err && err.name === "AbortError") return "cancelled"
	return "failed"
}

/** Optional true cancellation label; failures are never mislabeled as cancellations. */
export function requestCancellationMetadata(err: unknown): { cancelled?: RecallCancellationReason } {
	const status = requestErrorStatus(err)
	return status === "failed" ? {} : { cancelled: status }
}

/** Measure one store operation while preserving its return value or original rejection. */
export async function timedStoreCall<T>(
	trace: TraceRecorder | null | undefined,
	context: { kind: string } & Record<string, unknown>,
	call: () => Promise<T>,
	now: () => number = () => performance.now(),
): Promise<T> {
	const startedAt = now()
	try {
		const result = await call()
		trace?.emit({ type: "store_timing", ...context, status: "completed", durationMs: elapsedRequestMs(startedAt, now) })
		return result
	} catch (err) {
		trace?.emit({
			type: "store_timing",
			...context,
			status: requestErrorStatus(err),
			durationMs: elapsedRequestMs(startedAt, now),
		})
		throw err
	}
}
