import type { Api, Model } from "@earendil-works/pi-ai"
import {
	type ClassifierDegradedPayload,
	type ClassifierUnavailablePayload,
	PERMISSION_EVENTS,
} from "./permissions-events.js"
import type { ClassifierResult } from "./types.js"

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
