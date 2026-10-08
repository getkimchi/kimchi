/**
 * Parser for completion-budget cap rejections from OpenAI-compatible serving
 * backends behind the Kimchi gateway.
 *
 * Incident (2026-10-06, trace a64dcd390fad8775c9cc7724a47324c2): the Python
 * LiteLLM router preserved this backend rejection —
 * `max_completion_tokens is too large: 512000.This model supports at most
 * 262144 completion tokens.`
 *
 * The parser is intentionally the ONLY source of a correction ceiling: limits
 * are never guessed from model metadata (`MaxInputTokens`, alias
 * `max_output_tokens`, context windows) because catalog data has not been
 * shown to represent the actual worker deployment limit. If a rejection does
 * not state a parseable ceiling, no correction is possible.
 */

export interface BudgetCapRejection {
	/** The budget the rejected request actually carried. */
	requestedBudget: number
	/** The serving ceiling the backend stated in the rejection. */
	limit: number
}

/**
 * Matches both the current field (`max_completion_tokens`) and the legacy
 * field (`max_tokens`). Tolerates the missing space seen in the incident
 * message (`512000.This`) and optional provider prefixes (LiteLLM wraps the
 * backend verdict in `BadRequestError: ...` style text).
 */
const BUDGET_CAP_REJECTION_RE =
	/\bmax(?:_completion)?_tokens is too large:\s*(\d+)\s*\.\s*(?:This model|the model|it) supports at most\s*(\d+)\s*completion tokens/i

/**
 * Parse a completion-budget cap rejection from a raw provider error message.
 * Returns `undefined` for anything else — non-matching errors, negative or
 * non-integer budgets (those never match `\d+`), and rejections whose stated
 * budget does not actually exceed the stated ceiling.
 */
export function parseBudgetCapRejection(rawMessage: string | undefined): BudgetCapRejection | undefined {
	if (!rawMessage) return undefined
	const match = BUDGET_CAP_REJECTION_RE.exec(rawMessage)
	if (!match) return undefined
	const requestedBudget = Number.parseInt(match[1] ?? "", 10)
	const limit = Number.parseInt(match[2] ?? "", 10)
	if (!Number.isSafeInteger(requestedBudget) || !Number.isSafeInteger(limit)) return undefined
	if (requestedBudget <= 0 || limit <= 0) return undefined
	// A rejection that does not actually exceed the ceiling is not a budget-cap
	// mismatch (e.g. the backend restating its limit for a different field) —
	// correcting it would lower a budget for no reason.
	if (requestedBudget <= limit) return undefined
	return { requestedBudget, limit }
}
