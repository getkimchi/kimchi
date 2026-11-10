import type { AssistantMessage } from "@earendil-works/pi-ai"
import { AgentSession } from "@earendil-works/pi-coding-agent"

/**
 * Forward `agent_end.willRetry` to the extension-visible event.
 *
 * Pi computes the retry decision once per `agent_end` — but attaches it ONLY
 * to the listener channel (`_emit({ ...event, willRetry }))` — the extension
 * channel (`_emitExtensionEvent` → `_extensionRunner.emit({ type: "agent_end", messages })`)
 * receives the raw event without it. Extensions that react to a failed turn
 * therefore cannot tell "pi will auto-retry this in 2–8 s" from "pi has given
 * up", so they either preempt the retry or render premature exhaustion UI
 * (the interactive-error-surface showed "retries were exhausted" on the FIRST
 * provider error while retries were still in flight).
 *
 * The decision is NOT taken from pi's own `_willRetryAfterAgentEnd(event)`:
 * that scans `event.messages`, and those entries can be copies that lose the
 * preserved raw provider error (error-preservation stores it as a
 * non-enumerable symbol on the live message object). With the display
 * placeholder ("Retrying…") in place of the raw text the classifier says
 * "not retryable" and the retry looks exhausted while it is about to fire.
 * Instead we compute from the SAME source the retry loop uses —
 * `_lastAssistantMessage` (the object message_end handed to
 * `_handlePostAgentRun` → `_prepareRetry`) — so the extension channel agrees
 * with what will actually happen.
 *
 * Mirrors upstream earendil-works/pi#6827 (forward willRetry to extensions).
 * REMOVAL: drop this wrap once a pi release includes #6827 AND its willRetry
 * accounts for message-copy identity (or the copies stop losing the preserved
 * raw error); the suppress-retried-errors e2e gates the visible regression.
 * If pi renames/moves the targets, this silently no-ops — the extension's
 * `undefined` default keeps the old behavior rather than breaking.
 */
export function installAgentEndWillRetryPatch(
	sessionClass: PatchableAgentSession = AgentSession as unknown as PatchableAgentSession,
): void {
	const proto = sessionClass.prototype
	if (proto._kimchiAgentEndWillRetryPatch) return
	const originalEmitExtensionEvent = proto._emitExtensionEvent
	if (!originalEmitExtensionEvent) return

	proto._emitExtensionEvent = async function patchedEmitExtensionEvent(
		this: unknown,
		event: ExtensionEvent,
	): Promise<void> {
		// Pi reconstructs each extension event per type inside the original
		// (agent_end becomes `{ type: "agent_end", messages }`), so spreading
		// extra fields onto the input event would be discarded. For agent_end we
		// replicate that reconstruction with the retry decision added.
		if (event.type === "agent_end") {
			const willRetry = computeAgentEndWillRetry.call(this)
			const runner = (this as unknown as { _extensionRunner?: { emit: (e: unknown) => Promise<void> } })
				._extensionRunner
			if (runner?.emit) {
				return runner.emit({ type: "agent_end", messages: event.messages, willRetry })
			}
		}
		return originalEmitExtensionEvent.call(this, event)
	}

	proto._kimchiAgentEndWillRetryPatch = true
}

/** Mirror of pi's `_willRetryAfterAgentEnd`, but from session state the retry loop actually uses. */
function computeAgentEndWillRetry(this: unknown): boolean {
	const session = this as AgentEndWillRetrySession
	if (session._agentRunAbortRequested) return false
	const settings = session.settingsManager?.getRetrySettings?.()
	if (!settings?.enabled) return false
	if ((session._retryAttempt ?? 0) >= settings.maxRetries) return false
	const message = session._lastAssistantMessage
	if (!message || message.role !== "assistant") return false
	const classifier = session._isRetryableError
	if (typeof classifier !== "function") return false
	return classifier.call(session, message) === true
}

/** Session state pi's retry loop reads to decide a retry. */
type AgentEndWillRetrySession = {
	_agentRunAbortRequested?: boolean
	settingsManager?: { getRetrySettings?: () => { enabled: boolean; maxRetries: number } }
	_retryAttempt?: number
	_lastAssistantMessage?: Pick<AssistantMessage, "role"> | undefined
	_isRetryableError?: (message: unknown) => boolean
}

/** A session event as delivered to `_emitExtensionEvent`. */
type ExtensionEvent = {
	type: string
	/** Agent-end only: messages produced by the low-level run. */
	messages?: readonly unknown[]
} & Record<string, unknown>

type PatchableAgentSession = {
	prototype: {
		_emitExtensionEvent?: (event: ExtensionEvent) => Promise<void>
		_kimchiAgentEndWillRetryPatch?: boolean
	}
}
