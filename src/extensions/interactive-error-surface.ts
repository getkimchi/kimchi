import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { InteractiveMode } from "@earendil-works/pi-coding-agent"
import { classifyLLMGatewayError } from "../llm-gateway-error.js"
import { formatSanitizedErrorMessage } from "../sanitized-error-message.js"

interface PendingProviderError {
	readonly rawMessage: string
	willRetry: boolean
}

let lastPendingProviderError: PendingProviderError | undefined

/**
 * Pure decision function: given a showError candidate, return the message to
 * render — or `undefined` to suppress.
 *
 * - Non-provider errors pass through unchanged.
 * - Retryable errors → `undefined` (suppress; retry spinner keeps the stage).
 * - "Retry failed after N attempts: ..." → sanitized (exhaustion message).
 * - Non-retryable → sanitized generic message.
 *
 * Exported so the decision logic is testable without InteractiveMode.
 */
export function interceptShowError(
	errorMessage: string,
	_pending: PendingProviderError | undefined,
): string | undefined {
	// The auto_retry_end handler surfaces this final exhaustion message —
	// sanitize it (strips the raw finalError) and render.
	if (errorMessage?.startsWith("Retry failed after")) {
		// If we have the original raw error stored, use it for a better reason tag.
		const rawForReason = lastPendingProviderError?.rawMessage ?? errorMessage
		return formatSanitizedErrorMessage(rawForReason, "interactive", { exhausted: true })
	}

	const classified = classifyLLMGatewayError(errorMessage ?? "")
	if (!classified) return errorMessage // non-provider — pass through

	// Retryable per-attempt errors are suppressed: the upstream retry spinner
	// keeps the stage during retries, and auto_retry_end surfaces the final
	// sanitized message via showError.
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
 * renders it via AssistantMessageComponent. Retryable errors are suppressed
 * (empty string); non-retryable errors are sanitized. This catches the
 * per-attempt error renders that bypass showError.
 *
 * agent_end: resolves the willRetry signal and clears pending state on
 * exhaustion so the next showError renders sanitized (not suppressed).
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

		// Track the pending error; willRetry is resolved at agent_end.
		lastPendingProviderError = { rawMessage: message.errorMessage, willRetry: true }

		// Mutate the message BEFORE the upstream renders it via
		// AssistantMessageComponent. Extensions register before the mode's
		// own message_end handler, so this mutation takes effect first.
		// Retryable: replace with a muted placeholder so the component doesn't
		// leak internals but still renders something (the retry spinner is shown
		// separately via auto_retry_start). Non-retryable: sanitize.
		if (classified.retryable) {
			message.errorMessage = "Retrying…"
		} else {
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
			// because the finalError may have been mutated to "Retrying…".
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
