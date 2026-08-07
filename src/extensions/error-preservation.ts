/**
 * Preserve the original provider error message on an assistant message before
 * it is mutated for display purposes (e.g. replaced with "Retrying…").
 *
 * The upstream retry classifier (`_isRetryableError`) runs in
 * `_handlePostAgentRun`, which fires AFTER `message_end` extensions. If an
 * extension mutates `message.errorMessage` before the classifier reads it,
 * the classifier sees the display placeholder instead of the raw error and
 * fails to identify retryable errors — causing retries to silently stop.
 *
 * The preserved value is stored as a non-enumerable symbol property so it
 * never appears in serialized output or LLM context.
 */

const RAW_ERROR_SYMBOL = Symbol("rawErrorMessage")

/** Message shape that has an optional `errorMessage` string. */
interface ErrorMessageHolder {
	errorMessage?: string
}

/**
 * Store the current `errorMessage` on the message object before it is
 * mutated. Safe to call multiple times — only the first call preserves
 * (subsequent calls see the mutated value and are no-ops because the symbol
 * is already set).
 */
export function preserveRawErrorMessage(message: ErrorMessageHolder): void {
	if (message.errorMessage && !(RAW_ERROR_SYMBOL in message)) {
		Object.defineProperty(message, RAW_ERROR_SYMBOL, {
			value: message.errorMessage,
			enumerable: false,
			writable: false,
			configurable: false,
		})
	}
}

/**
 * Return the original (pre-mutation) error message if one was preserved,
 * otherwise fall back to the current `errorMessage`.
 */
export function getRawErrorMessage(message: ErrorMessageHolder): string | undefined {
	const preserved = (message as Record<symbol, unknown>)[RAW_ERROR_SYMBOL]
	return (typeof preserved === "string" ? preserved : undefined) ?? message.errorMessage
}
