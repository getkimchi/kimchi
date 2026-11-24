import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { type ClassifierOptions, type ClassifyInput, classifyToolCall } from "./classifier.js"
import { CLASSIFIER_BREAKER_WINDOW_MS } from "./constants.js"
import type { ClassifierFailureCode, ClassifierResult } from "./types.js"

/**
 * Failure codes that look like an outage of the classifier backend (transport,
 * auth lookup, budget) rather than a property of one input or a static
 * configuration problem. Only these trip the breaker: `aborted` is a user
 * cancel, `invalid_output` can be specific to one call, and `no_api_key` /
 * `no_candidates` are static and already instant.
 */
const TRIP_CODES: ReadonlySet<ClassifierFailureCode> = new Set([
	"timeout",
	"provider_error",
	"budget_exhausted",
	"auth_timeout",
	"auth_unavailable",
])

type Breaker =
	| { state: "closed" }
	/** Skip the provider; hand back `stored` until the window elapses. */
	| { state: "open"; openedAt: number; stored: ClassifierResult }
	/** One call is probing; concurrent callers still get `stored`. */
	| { state: "probing"; stored: ClassifierResult }

// Module-level so a parent session and its subagents (same process) share one
// breaker: an outage anywhere skips the per-call ladder wait everywhere until
// a probe succeeds.
let breaker: Breaker = { state: "closed" }

export interface BreakerOutcome {
	result: ClassifierResult
	/** True when this call's failure just opened the breaker (first failure of a window, or a failed probe). */
	tripped: boolean
	/** True when a probe succeeded and closed the breaker. */
	recovered: boolean
	/** True when the result came from the breaker's stored failure — no provider call was made. */
	fromBreaker: boolean
}

/**
 * Wrap `classifyToolCall` with a circuit breaker: after one full ladder fails
 * with a transport-class code, further calls skip the provider (and its
 * repeated 25 s budget) and get the stored failure back immediately. After
 * the window, the next call probes by running the ladder with its normal
 * options — a probe succeeds exactly when a normal call would (capping the
 * probe below the ladder budget would starve the first model via the
 * ladder's reserve-for-next logic and keep the breaker open past recovery).
 * Success closes the breaker, a transport-class failure re-opens it for
 * another window, and any other failure (bad output, static setup) closes it
 * too — the backend answered, so this is not an outage.
 */
export async function classifyToolCallViaBreaker(
	candidates: readonly Model<Api>[],
	modelRegistry: Pick<ModelRegistry, "getApiKeyAndHeaders" | "hasConfiguredAuth">,
	call: ClassifyInput,
	options: ClassifierOptions,
	signal?: AbortSignal,
): Promise<BreakerOutcome> {
	if (breaker.state === "open" && Date.now() - breaker.openedAt >= CLASSIFIER_BREAKER_WINDOW_MS) {
		// Window elapsed: this call becomes the probe. The state flip below is
		// synchronous, so concurrent calls keep getting the stored failure.
		const { stored } = breaker
		breaker = { state: "probing", stored }
		try {
			const result = await classifyToolCall(candidates, modelRegistry, call, options, signal)
			return recordProbe(result)
		} catch (err) {
			// A throwing probe must not wedge the breaker in `probing` for the
			// lifetime of a long-lived process — re-arm it open with an expired
			// window so the next call probes again, then surface the error.
			breaker = { state: "open", openedAt: Date.now() - CLASSIFIER_BREAKER_WINDOW_MS, stored }
			throw err
		}
	}
	if (breaker.state === "open" || breaker.state === "probing") {
		return { result: breaker.stored, tripped: false, recovered: false, fromBreaker: true }
	}
	const result = await classifyToolCall(candidates, modelRegistry, call, options, signal)
	return recordResult(result)
}

/** A call made while the breaker was closed: trip on transport-class failures. */
function recordResult(result: ClassifierResult): BreakerOutcome {
	// A call that started while closed can settle after a concurrent call
	// already tripped the breaker (or after a probe claimed the state): never
	// overwrite the stored failure or re-report the trip — one warning per trip.
	if (breaker.state !== "closed") {
		return { result, tripped: false, recovered: false, fromBreaker: false }
	}
	if (result.ok || !result.failureCode || !TRIP_CODES.has(result.failureCode)) {
		return { result, tripped: false, recovered: false, fromBreaker: false }
	}
	breaker = { state: "open", openedAt: Date.now(), stored: result }
	return { result, tripped: true, recovered: false, fromBreaker: false }
}

/** A probe call: success or a non-outage failure closes the breaker; a transport-class failure re-opens it. */
function recordProbe(result: ClassifierResult): BreakerOutcome {
	// The probe claim guarantees a probing state with a stored failure.
	const stored = breaker.state === "probing" ? breaker.stored : result
	if (result.ok) {
		breaker = { state: "closed" }
		return { result, tripped: false, recovered: true, fromBreaker: false }
	}
	if (result.failureCode === "aborted") {
		// A user cancel is not an outage signal — let the next call probe again.
		breaker = { state: "open", openedAt: Date.now() - CLASSIFIER_BREAKER_WINDOW_MS, stored }
		return { result, tripped: false, recovered: false, fromBreaker: false }
	}
	if (!result.failureCode || !TRIP_CODES.has(result.failureCode)) {
		// The backend answered (unparseable output) or the setup is static (no
		// key, no candidates) — neither is an outage, so the breaker closes and
		// the result is handled like a normal call's. Not a "recovered" signal:
		// the classifier did not produce a verdict.
		breaker = { state: "closed" }
		return { result, tripped: false, recovered: false, fromBreaker: false }
	}
	breaker = { state: "open", openedAt: Date.now(), stored: result }
	return { result, tripped: true, recovered: false, fromBreaker: false }
}

/** Reset the breaker state. For tests only — real sessions share the state on purpose. */
export function resetClassifierBreakerForTests(): void {
	breaker = { state: "closed" }
}
