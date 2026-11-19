import type { Api, Model } from "@earendil-works/pi-ai"
import {
	type ClassifierDegradedPayload,
	type ClassifierUnavailablePayload,
	PERMISSION_EVENTS,
} from "./permissions-events.js"
import type { ClassifierFailureCode, ClassifierResult } from "./types.js"

type ClassifierHealth =
	| {
			channel: typeof PERMISSION_EVENTS.CLASSIFIER_UNAVAILABLE
			payload: ClassifierUnavailablePayload
			message: string
			/** Dedup key for once-per-session warnings: one per distinct notification copy. */
			notifyKey: string
	  }
	| {
			channel: typeof PERMISSION_EVENTS.CLASSIFIER_DEGRADED
			payload: ClassifierDegradedPayload
			message: string
			/** Dedup key for once-per-session warnings: one per distinct notification copy. */
			notifyKey: string
	  }

// Fixed outage copy. Never interpolate provider/model text into these —
// the failure reason from the ladder is diagnostic-only and must not reach
// the model, the prompt, or the user (guarded by SENTINEL_SECRET tests).

/** Prompt subtitle shown when the classifier failed and the user is asked instead. */
export const CLASSIFIER_UNAVAILABLE_PROMPT_SUBTITLE =
	"Permission classifier unavailable — your confirmation is needed for this call."

/** Prompt subtitle when a subagent's call is escalated to the parent session
 *  because its classifier failed. */
export const CLASSIFIER_UNAVAILABLE_SUBAGENT_PROMPT_SUBTITLE =
	"The permission classifier is unavailable, so this subagent's call needs your approval."

/** Block reason handed to the model when the classifier failed and nobody can confirm the call. */
export const CLASSIFIER_UNAVAILABLE_BLOCK_REASON =
	"Blocked: the permission classifier is temporarily unavailable and nobody can confirm this call here. " +
	"The call did not run. Do not retry it in a loop — continue with work that needs no approval, or stop " +
	"and report to the user that the classifier is unavailable."

/** Subagent guidance appended to a block reason when the blocked session is a worker. */
export const CLASSIFIER_SUBAGENT_GUIDANCE =
	" Report this to the main agent so it can run the step itself with the user's confirmation."

/** Subagent variant of the outage reason: the child cannot prompt anyone, but the main agent can. */
export const CLASSIFIER_UNAVAILABLE_BLOCK_REASON_SUBAGENT =
	CLASSIFIER_UNAVAILABLE_BLOCK_REASON + CLASSIFIER_SUBAGENT_GUIDANCE

/** Not-configured class (no_api_key / no_candidates): a setup problem, not an outage. */
export const CLASSIFIER_NOT_CONFIGURED_BLOCK_REASON =
	"Blocked: the permission classifier is not configured in this environment (no Kimchi API key or no " +
	"classifier models are available). The call did not run. Do not retry it in a loop — fix the classifier " +
	"configuration, add an allow rule (/permissions), or stop and report to the user that permission " +
	"checking cannot run."

/** Per-input class (invalid_output): the backend answered, so one retry is acceptable. */
export const CLASSIFIER_INVALID_OUTPUT_BLOCK_REASON =
	"Blocked: the permission classifier returned an unparseable answer for this call. The call did not run. " +
	"One retry is acceptable; if it fails again, stop and report to the user that the classifier is " +
	"misbehaving, and continue with work that needs no approval."

/**
 * Pick the block reason for a failed classification. Transport-class codes
 * get the outage copy, static setup problems get actionable configuration
 * copy, and a per-input parse failure allows one retry. The subagent guidance
 * is appended when the blocked session is a worker.
 */
export function classifierBlockReason(failureCode: ClassifierFailureCode | undefined, isWorker: boolean): string {
	const base =
		failureCode === "no_api_key" || failureCode === "no_candidates"
			? CLASSIFIER_NOT_CONFIGURED_BLOCK_REASON
			: failureCode === "invalid_output"
				? CLASSIFIER_INVALID_OUTPUT_BLOCK_REASON
				: CLASSIFIER_UNAVAILABLE_BLOCK_REASON
	return isWorker ? base + CLASSIFIER_SUBAGENT_GUIDANCE : base
}

/**
 * Bounded code tail appended to outage block reasons so downstream tool-error
 * telemetry can recover the failure code. Enum values only — never provider text.
 */
export function classifierBlockReasonCodeTail(failureCode: ClassifierFailureCode | undefined): string {
	return failureCode ? ` (code=${failureCode})` : ""
}

/** How to carry on while the classifier cannot decide: the same two routes in every notice. */
const CLASSIFIER_BLOCKED_WAYS_OUT = "run the step in the main session or add an allow rule (/permissions)"

/**
 * Per-blocked-call user notice, worded for the cause. Tool name only — no
 * command text or path (same privacy stance as the health events above).
 */
export function classifierBlockedNotice(toolName: string, failureCode: ClassifierFailureCode | undefined): string {
	if (failureCode === "no_api_key") {
		return (
			`Permission classifier has no Kimchi API key — ${toolName} was blocked. To continue now, set ` +
			"KIMCHI_API_KEY or add an allow rule (/permissions)."
		)
	}
	if (failureCode === "no_candidates") {
		return (
			`Permission classifier has no models available — ${toolName} was blocked. To continue now, ` +
			`${CLASSIFIER_BLOCKED_WAYS_OUT}.`
		)
	}
	if (failureCode === "invalid_output") {
		return (
			`Permission classifier returned an unusable answer — ${toolName} was blocked. To continue now, ` +
			`${CLASSIFIER_BLOCKED_WAYS_OUT}.`
		)
	}
	return (
		`Permission classifier unavailable — ${toolName} was blocked. Calls that need classification are blocked ` +
		`until it recovers. To continue now, ${CLASSIFIER_BLOCKED_WAYS_OUT}.`
	)
}

/** Info notice shown once when a breaker probe succeeds and the classifier recovers. */
export const CLASSIFIER_RECOVERED_NOTICE = "Permission classifier is back."

/** Keep free-form model/provider diagnostics out of health events and notifications. */
export function classifierHealth(
	result: ClassifierResult,
	candidates: readonly Model<Api>[],
	missingRefs: string[],
	signal?: AbortSignal,
): ClassifierHealth | undefined {
	if (signal?.aborted || result.failureCode === "aborted") return undefined
	if (!result.ok) {
		const failureCode = result.failureCode ?? (candidates.length ? "provider_error" : "no_candidates")
		return {
			channel: PERMISSION_EVENTS.CLASSIFIER_UNAVAILABLE,
			payload: { failureCode, missingRefs },
			// Only no_api_key has distinct copy; other codes share one generic warning.
			notifyKey:
				failureCode === "no_api_key"
					? `${PERMISSION_EVENTS.CLASSIFIER_UNAVAILABLE}:no_api_key`
					: PERMISSION_EVENTS.CLASSIFIER_UNAVAILABLE,
			// Fixed copy per failure code; never interpolate free-form diagnostics.
			message:
				failureCode === "no_api_key"
					? "Permissions classifier has no Kimchi API key configured. Set KIMCHI_API_KEY to enable auto-approval; calls requiring classification will keep asking for confirmation (or are blocked without a UI)."
					: "Permissions classifier unavailable. Calls requiring classification need confirmation or are blocked without a UI.",
		}
	}
	if (result.usedModelId && (missingRefs.length > 0 || result.usedModelId !== candidates[0]?.id)) {
		return {
			channel: PERMISSION_EVENTS.CLASSIFIER_DEGRADED,
			payload: { usedModelId: result.usedModelId, missingRefs },
			notifyKey: PERMISSION_EVENTS.CLASSIFIER_DEGRADED,
			message: "Permissions classifier is using a fallback model or has reduced model availability.",
		}
	}
	return undefined
}
