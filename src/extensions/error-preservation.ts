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
 * The preserved value is stored as a symbol registered in the GLOBAL symbol
 * registry (`Symbol.for`) and made ENUMERABLE:
 * - global registry: the setter (extensions) and the getters (retry/compaction
 *   patches) must share one symbol even across module instances in the
 *   bundled binary;
 * - enumerable: pi spreads messages into copies between `message_end` and the
 *   run-loop retry classifier, and spread copies carry own enumerable SYMBOL
 *   properties too — non-enumerable ones are silently dropped, so a
 *   mid-stream failure would otherwise classify its own display placeholder
 *   and never retry. Symbols stay invisible to JSON.stringify and Object.keys,
 *   so the raw error never reaches serialized output or the LLM request
 *   payload (requests are built from role/content only).
 *
 * Writable and configurable: pi replaces a message in place after
 * `message_end` (`AgentSession._replaceMessageInPlace` deletes every string
 * key, then `Object.assign`s the replacement onto the same object). Writing
 * onto a read-only own property throws, so a later handler that returns a
 * replacement message — the rate-limit notice does, for any gateway deadline
 * — would turn a handled provider error into an unhandled TypeError.
 */

const RAW_ERROR_SYMBOL = Symbol.for("kimchi.rawErrorMessage")

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
			enumerable: true,
			writable: true,
			configurable: true,
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

/**
 * True when a raw error was preserved on the message (in-process symbol),
 * as opposed to `getRawErrorMessage` falling back to the current display
 * `errorMessage`. Callers that must distinguish "a preserved raw"
 * from "fallback" (e.g. compaction recovery, where a fallback must not win
 * over a stale audit entry) gate on this.
 */
export function hasPreservedRawErrorMessage(message: ErrorMessageHolder): boolean {
	return RAW_ERROR_SYMBOL in message
}
