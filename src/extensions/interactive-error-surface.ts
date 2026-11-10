import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { InteractiveMode } from "@earendil-works/pi-coding-agent"
import { classifyLLMGatewayError } from "../llm-gateway-error.js"
import { formatSanitizedErrorMessage } from "../sanitized-error-message.js"
import { RATE_LIMIT_MAX_WAIT_MS, rateLimitWaitMs } from "../upstream-retry-patch.js"
import { preserveRawErrorMessage } from "./error-preservation.js"

interface PendingProviderError {
	readonly rawMessage: string
	willRetry: boolean
	/**
	 * True once the exhaustion sanitized message was rendered at agent_end, so
	 * the imminent auto_retry_end → showError interception suppresses the
	 * duplicate instead of rendering it twice. Never set while retries are
	 * pending — the entry is overwritten fresh on each subsequent error.
	 */
	notified?: boolean
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
	// sanitize it (strips the raw finalError) and render. Skipped when the
	// extension already rendered the exhaustion message at agent_end
	// (pending.notified): the retry finally ended, but the message is up.
	if (errorMessage?.startsWith("Retry failed after")) {
		if (pending?.notified) return undefined
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
		if (message.role !== "assistant") {
			// A user message ends the turn boundaries: any pending provider error
			// from a previous turn (e.g. a retry the user aborted) is stale now,
			// and its agent_end already fired. Clear it so a later agent_end
			// (for a turn that completed or that the user cancelled) cannot
			// resurrect an old exhaustion render.
			if (message.role === "user") lastPendingProviderError = undefined
			return
		}
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
			// A rate-limit deadline past the wait bound is refused by the retry classifier, and
			// the rate-limit-notice extension (registered after this one) renders the definitive
			// "not retrying" guidance on the message itself — pending state here would only
			// duplicate it as an agent_end exhaustion notification.
			const waitMs = rateLimitWaitMs(message)
			const noticeOwnsMessaging = waitMs !== undefined && waitMs > RATE_LIMIT_MAX_WAIT_MS
			// Track only retryable errors — agent_end renders the sanitized
			// exhaustion message when retries are exhausted.
			if (!noticeOwnsMessaging) {
				lastPendingProviderError = { rawMessage: message.errorMessage, willRetry: true }
			}
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
			// Preserve the raw error BEFORE sanitizing so upstream's compaction
			// recovery (`_checkCompaction` → `isContextOverflow`, which matches
			// provider-specific overflow patterns) can still classify it after
			// the display text is replaced. Without this the raw `"context window
			// exceeded"` text is lost and overflow recovery silently never fires.
			preserveRawErrorMessage(message)
			// Non-retryable: sanitize in place. No pending state is created —
			// the error is fully handled here and agent_end must not re-render.
			message.errorMessage = formatSanitizedErrorMessage(message.errorMessage, "interactive", {
				exhausted: true,
			})
		}
	})

	pi.on("agent_end", (event, ctx) => {
		const rawWillRetry = (event as { willRetry?: boolean }).willRetry
		const willRetry = rawWillRetry === true
		// The extension channel now carries the same willRetry the listener
		// The extension channel now carries the same willRetry the listener
		// channel gets (installed by agent-end-will-retry). True → the upstream
		// retry loop is still going to fire; keep the pending entry and render
		// nothing. False/undefined (retries disabled, exhausted, or a replay
		// where the wrapper did not run) → the turn is over: render the
		// sanitized exhaustion message now.
		if (!willRetry && lastPendingProviderError) {
			// Retries exhausted (or never enabled) — render the sanitized message
			// directly. We can't rely on the upstream auto_retry_end → showError
			// path because the finalError may have been mutated to the placeholder.
			// Rendering here ensures the sanitized message reaches the user.
			const sanitized = formatSanitizedErrorMessage(lastPendingProviderError.rawMessage, "interactive", {
				exhausted: true,
			})
			ctx?.ui?.notify?.(sanitized, "error")
			// Keep the raw error until the next non-error message_end: the
			// imminent auto_retry_end → showError interception (Esc-cancel and
			// exhausted paths) needs pending.rawMessage for the correct reason
			// label, and the notified flag suppresses that duplicate render.
			lastPendingProviderError.notified = true
		} else if (lastPendingProviderError && willRetry) {
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
