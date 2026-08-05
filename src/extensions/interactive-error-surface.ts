import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { InteractiveMode } from "@earendil-works/pi-coding-agent"
import { classifyLLMGatewayError } from "../llm-gateway-error.js"
import { formatSanitizedErrorMessage } from "../sanitized-error-message.js"
import { preserveRawErrorMessage } from "./error-preservation.js"

interface PendingProviderError {
	readonly rawMessage: string
	willRetry: boolean
}

let lastPendingProviderError: PendingProviderError | undefined

/** Placeholder used when mutating errorMessage for retryable per-attempt errors. */
const RETRYING_PLACEHOLDER = "Retrying…"

/**
 * Pure decision function: given a showError candidate and the pending provider
 * error (if any), return the message to render — or `undefined` to suppress.
 *
 * - Non-provider errors pass through unchanged.
 * - Retryable errors → `undefined` (suppress; retry spinner keeps the stage).
 * - "Retry failed after N attempts: ..." → sanitized (exhaustion message).
 * - "Retrying…" placeholder → `undefined` (suppress stale placeholder).
 * - Non-retryable → sanitized generic message.
 *
 * Exported so the decision logic is testable without InteractiveMode.
 */
export function interceptShowError(
	errorMessage: string,
	pending: PendingProviderError | undefined,
): string | undefined {
	// The auto_retry_end handler surfaces this final exhaustion message —
	// sanitize it (strips the raw finalError) and render.
	if (errorMessage?.startsWith("Retry failed after")) {
		// If we have the original raw error stored, use it for a better reason tag.
		const rawForReason = pending?.rawMessage ?? errorMessage
		return formatSanitizedErrorMessage(rawForReason, "interactive", { exhausted: true })
	}

	// Suppress the stale "Retrying…" placeholder that was set as a per-attempt
	// mutation — it has no value once the retry outcome is decided.
	if (errorMessage === RETRYING_PLACEHOLDER) return undefined

	const classified = classifyLLMGatewayError(errorMessage ?? "")
	if (!classified) return errorMessage // non-provider — pass through

	// Retryable per-attempt errors are suppressed: the upstream retry spinner
	// keeps the stage during retries, and auto_retry_end (or agent_end if
	// retries are disabled) surfaces the final sanitized message.
	if (classified.retryable) return undefined

	// Non-retryable — sanitize and render immediately.
	return formatSanitizedErrorMessage(errorMessage, "interactive", { exhausted: true })
}

/**
 * Wrap InteractiveMode.prototype.showError so provider error strings never
 * reach the terminal raw via the showError path (auto_retry_end, compaction,
 * etc.).
 *
 * Per-attempt errors rendered via AssistantMessageComponent are handled by
 * mutating message.errorMessage in the message_end extension handler BEFORE
 * the upstream renders it — extensions register before the mode's own handler.
 *
 * Follows the same prototype-mutation pattern as paste-to-editor-patch.ts.
 */
export function applyInteractiveErrorSurfacePatch(): void {
	// biome-ignore lint/suspicious/noExplicitAny: private upstream prototype mutation
	const imProto = InteractiveMode.prototype as any
	if (imProto.__kimchiErrorSurfacePatched) return
	imProto.__kimchiErrorSurfacePatched = true

	const originalShowError = imProto.showError
	imProto.showError = function patchedShowError(errorMessage: string): void {
		const result = interceptShowError(errorMessage, lastPendingProviderError)
		if (result === undefined) return // suppress
		originalShowError.call(this, result)
	}
}

/**
 * Extension factory: registers message_end and agent_end handlers.
 *
 * message_end: when an assistant message ends with stopReason "error",
 * mutates `message.errorMessage` BEFORE the upstream's message_end handler
 * renders it via AssistantMessageComponent. Retryable errors are replaced
 * with a muted placeholder; non-retryable errors are sanitized in place.
 * Only retryable errors create pending state — non-retryable errors are
 * fully handled in message_end and do not need agent_end follow-up.
 *
 * agent_end: resolves the willRetry signal. On exhaustion (willRetry false),
 * renders the sanitized message directly via ctx.ui.notify and clears pending
 * state.
 */
export default function interactiveErrorSurfaceExtension(pi: ExtensionAPI): void {
	pi.on("message_end", (event) => {
		const message = event.message
		if (message.role !== "assistant") return
		if (message.stopReason !== "error") {
			lastPendingProviderError = undefined
			return
		}
		if (typeof message.errorMessage !== "string") return
		const classified = classifyLLMGatewayError(message.errorMessage)
		if (!classified) return

		// Mutate the message BEFORE the upstream renders it via
		// AssistantMessageComponent. Extensions register before the mode's
		// own message_end handler, so this mutation takes effect first.
		if (classified.retryable) {
			// Track only retryable errors — agent_end renders the sanitized
			// exhaustion message when retries are exhausted.
			lastPendingProviderError = { rawMessage: message.errorMessage, willRetry: true }
			// Preserve the original error for the retry classifier, which runs
			// in _handlePostAgentRun AFTER this mutation. Without this, the
			// classifier sees "Retrying…" and fails to identify the error as
			// retryable, causing retries to silently stop.
			preserveRawErrorMessage(message)
			// Replace with a muted placeholder so the component doesn't leak
			// internals but still renders something. The placeholder is
			// suppressed by interceptShowError if it reaches showError.
			message.errorMessage = RETRYING_PLACEHOLDER
		} else {
			// Non-retryable: sanitize in place. No pending state is created —
			// the error is fully handled here and agent_end must not re-render.
			message.errorMessage = formatSanitizedErrorMessage(message.errorMessage, "interactive", {
				exhausted: true,
			})
		}
	})

	pi.on("agent_end", (event, ctx) => {
		const willRetry = (event as { willRetry?: boolean }).willRetry === true
		if (!willRetry && lastPendingProviderError) {
			// Retries exhausted — render the sanitized message directly.
			// We can't rely on the upstream auto_retry_end → showError path
			// because the finalError may have been mutated to the placeholder.
			// Rendering here ensures the sanitized message reaches the user.
			const sanitized = formatSanitizedErrorMessage(lastPendingProviderError.rawMessage, "interactive", {
				exhausted: true,
			})
			ctx?.ui?.notify?.(sanitized, "error")
			lastPendingProviderError = undefined
		} else if (lastPendingProviderError) {
			lastPendingProviderError.willRetry = willRetry
		}
	})
}

/** Test-only: reset pending-error state between tests. */
export function __resetInteractiveErrorSurfaceState(): void {
	lastPendingProviderError = undefined
}

/** Test-only: inspect the pending provider error. */
export function __getPendingProviderError(): PendingProviderError | undefined {
	return lastPendingProviderError
}
