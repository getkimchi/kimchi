// ACP extension method handler for rating the settled response.
// Vendor contract: docs/acp-feedback.md. Wire name: `_kimchi.dev/feedback` —
// advertised via _meta["kimchi.dev"].feedback. Action-discriminated for
// future flows; the only action today is "rate_response".

import { RequestError } from "@agentclientprotocol/sdk"
import { consumeRatingWindow, getRatingWindow } from "../../../extensions/feedback/rating-window.js"
import { type RecordRatingResult, recordRating } from "../../../extensions/feedback/record-rating.js"
import type { SessionTurnTarget } from "../types.js"

const ACTION_RATE_RESPONSE = "rate_response"

/**
 * Feedback handler for `_kimchi.dev/feedback`.
 *
 * Validates the submission, consults the cross-surface rating window (armed
 * by the feedback extension on `agent_settled`, cleared for
 * cancelled/errored turns by the ACP server), records the rating through the
 * shared record seam (transcript entry + telemetry, never into LLM context),
 * and consumes the window — one rating per settled response.
 *
 * Validation order keeps caller bugs (invalidParams, -32602) distinct from
 * request-state problems (invalidRequest, -32600): parameter shape first,
 * then session existence, then the in-progress gate, then the window.
 */
export async function handleFeedback(
	getTarget: (sessionId: string) => SessionTurnTarget | undefined,
	params: Record<string, unknown>,
): Promise<RecordRatingResult> {
	const sessionId = params.sessionId
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw RequestError.invalidParams(undefined, "sessionId is required and must be a non-empty string")
	}

	if (params.action !== ACTION_RATE_RESPONSE) {
		throw RequestError.invalidParams(
			undefined,
			`unknown action ${JSON.stringify(params.action)} — expected "rate_response"`,
		)
	}

	const sentiment = params.sentiment
	if (sentiment !== "positive" && sentiment !== "negative") {
		throw RequestError.invalidParams(undefined, 'sentiment must be "positive" or "negative"')
	}

	const reason = params.reason
	if (reason !== undefined && typeof reason !== "string") {
		throw RequestError.invalidParams(undefined, "reason must be a string when provided")
	}

	const target = getTarget(sessionId)
	if (!target) {
		throw RequestError.invalidParams(undefined, `unknown sessionId ${sessionId}`)
	}

	if (target.turnActive) {
		throw RequestError.invalidRequest(undefined, "a prompt is already in progress for this session")
	}

	const ratingWindow = getRatingWindow(sessionId)
	if (!ratingWindow) {
		throw RequestError.invalidRequest(undefined, "no settled response to rate")
	}

	try {
		const result = recordRating({
			appendEntry: (customType, details) => target.session.sessionManager.appendCustomEntry(customType, details),
			sentiment,
			reason: reason ?? "",
			window: ratingWindow,
		})
		consumeRatingWindow(sessionId)
		return result
	} catch (err) {
		// The only remaining throw source is the transcript write (telemetry
		// is swallowed inside the record seam), so nothing was recorded and
		// the window above is still armed — a client retry is safe. Map to a
		// controlled internal error instead of letting the raw failure escape
		// as a generic -32603 (precedent: the server's browser-auth path).
		const detail = err instanceof Error ? err.message : String(err)
		throw RequestError.internalError(undefined, `failed to record rating: ${detail}`)
	}
}
