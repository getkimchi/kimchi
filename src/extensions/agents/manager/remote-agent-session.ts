/**
 * RemoteAgentSession — adapter that presents a remote ACP session as a
 * partial AgentSession.
 *
 * Created before `runRemoteAgent` calls `prompt()`. Receives the
 * `AcpSessionClient` via `bindClient()` once `runRemoteAgent` fires its
 * `onReady` callback (after `acpClient.initialize()`, before `prompt()`).
 *
 * Stored on `record.session` so that `steer_subagent`, `get_subagent_result`,
 * and the Ctrl+B detach handler can access the remote session through the same
 * interface they use for local agents.
 *
 * Lifecycle:
 * - `bindClient()` is called by `_runRemote()` via `runRemoteAgent`'s `onReady`
 *   callback, after the ACP client is initialized.
 * - `dispose()` is a no-op — the real cleanup (WebSocket close + session
 *   deletion) happens in `runRemoteAgent`'s `finally` block. This class must
 *   NOT call `acpClient.close()` because `cleanupRecordRuntime` in
 *   agent-manager.ts calls `record.session?.dispose?.()` on completion, and
 *   double-closing would error.
 *
 * Steering is not supported — ACP has no dedicated steering primitive. The
 * `steer()` method throws a clear error. This will be implemented later once
 * the ACP server supports it.
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import type { AcpSessionClient } from "../../../sandbox/worker/acp-client.js"
import type { RemoteSessionMeta } from "./remote-agent-runner.js"
import type { LifetimeUsage, SessionStatsLike } from "./usage.js"

/**
 * Minimal event shape emitted by RemoteAgentSession.
 *
 * ConversationViewer and other subscribers only use events as a re-render
 * trigger — they read session.messages directly, not event payloads. The full
 * AgentSessionEvent requires fields (api, provider, model, usage, timestamp)
 * that ACP doesn't provide, so we cast through this minimal shape.
 */
type RemoteSessionEvent = { type: string; [k: string]: unknown }

export class RemoteAgentSession {
	private acpClient: AcpSessionClient | undefined
	private meta: RemoteSessionMeta | undefined
	private listeners: ((event: AgentSessionEvent) => void)[] = []
	private _messages: Record<string, unknown>[] = []
	private _usage: LifetimeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
	private _isStreaming = false
	private _turnCount = 0
	/** Monotonic counter for toolCall IDs — mirrors how local agents assign IDs. */
	private _toolCallSeq = 0
	/** Tracks toolCallId → toolName so recordToolCallEnd can set toolName on the result. */
	private _pendingToolCalls = new Map<string, string>()
	/** Pending ACP toolCallIds for dedup — prevents duplicate in_progress dispatches. */
	private _pendingToolCallIds = new Set<string>()
	/** Maps ACP toolCallId → local toolCallId (tc-N) for end-event matching. */
	private _acpToLocalId = new Map<string, string>()
	/** Length of the full accumulated text at the time of the last appendAssistantText call.
	 *  Used by recordToolCallEnd to set _textOffset. */
	private _lastFullTextLength = 0
	/** Length of text already consumed by previous assistant messages.
	 *  ACP's onTextDelta sends the full accumulated text for the entire turn —
	 *  after a tool call, new assistant messages should only get text that came
	 *  after the tool call, not the full accumulated text. */
	private _textOffset = 0

	/** Called by _runRemote() via runRemoteAgent's onReady callback. */
	bindClient(acpClient: AcpSessionClient, meta: RemoteSessionMeta): void {
		this.acpClient = acpClient
		this.meta = meta
	}

	/** Record the user prompt as the first message in the transcript.
	 *  Called by _runRemote before the ACP prompt is sent. */
	setUserPrompt(text: string): void {
		// Only add if there are no messages yet (avoid duplicates on re-prompt).
		if (this._messages.length === 0) {
			this._messages.push({ role: "user", content: text })
			this.emit({ type: "message_start", message: { role: "user", content: text } })
		}
	}

	get sessionId(): string {
		return this.meta?.sessionName ?? ""
	}

	get model() {
		return undefined
	}

	get isStreaming(): boolean {
		return this._isStreaming
	}

	get messages(): Record<string, unknown>[] {
		return this._messages
	}

	getSessionStats(): SessionStatsLike {
		return {
			tokens: { ...this._usage },
			contextUsage: { percent: null },
		}
	}

	getContextUsage() {
		return undefined
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.push(listener)
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener)
		}
	}

	/** Forward an event to all subscribers.
	 *  The payload is cast to AgentSessionEvent — subscribers (ConversationViewer,
	 *  transcript writer) only use it as a re-render signal and read from
	 *  session.messages directly. */
	emit(event: RemoteSessionEvent): void {
		for (const l of this.listeners) l(event as AgentSessionEvent)
	}

	/** Accumulate usage from ACP onAssistantUsage. */
	addUsage(delta: LifetimeUsage): void {
		this._usage.input += delta.input
		this._usage.output += delta.output
		this._usage.cacheRead += delta.cacheRead
		this._usage.cacheWrite += delta.cacheWrite
	}

	/** Track streaming state. */
	setStreaming(v: boolean): void {
		this._isStreaming = v
	}

	/** Accumulate assistant text into the conversation transcript.
	 *  ACP's onTextDelta provides the full accumulated text for the entire turn,
	 *  not a per-segment delta. After a tool call, only the text that came after
	 *  the tool call should appear in the new assistant message — so we slice
	 *  from _textOffset (set when the tool call ended).
	 *  Trims leading newlines that LLMs frequently emit before their first actual
	 *  content, which would render as a blank line.
	 *  Emits events so subscribers (e.g. ConversationViewer) re-render live. */
	appendAssistantText(text: string): void {
		const trimmed = text.replace(/^\n+/, "")
		this._lastFullTextLength = trimmed.length
		const relevantText = this._textOffset > 0 ? trimmed.slice(this._textOffset) : trimmed

		const last = this._messages[this._messages.length - 1]
		if (last?.role === "assistant") {
			const parts = last.content as Array<{ type: string; text?: string; [k: string]: unknown }>
			const textPart = parts.find((p) => p.type === "text")
			if (textPart) {
				textPart.text = relevantText
			} else {
				parts.unshift({ type: "text", text: relevantText })
			}
		} else {
			this._messages.push({ role: "assistant", content: [{ type: "text", text: relevantText }] })
		}
		this.emit({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: relevantText }] },
			assistantMessageEvent: { type: "text_delta", delta: relevantText },
		})
	}

	get turnCount(): number {
		return this._turnCount
	}

	incrementTurnCount(): void {
		this._turnCount++
		// Reset text tracking for the next turn — ACP resets _accumulatedText
		// in prompt(), so the next onTextDelta starts fresh.
		this._textOffset = 0
		this._lastFullTextLength = 0
		this.emit({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] })
	}

	/** Track the tool name we're currently waiting on so we can deduplicate
	 *  repeated in_progress notifications — ACP sends multiple tool_call /
	 *  tool_call_update events with status "in_progress" before "completed".
	 *  Fallback used only when toolCallId is unavailable. */
	private _pendingToolName: string | undefined

	/** Record a tool call start in the transcript.
	 *  Appends a toolCall content part to the last assistant message (creating
	 *  one if needed) — matching how local agents structure AssistantMessage.
	 *  Uses a unique toolCallId so the same tool can run multiple times.
	 *  Deduplicates repeated in_progress notifications for the same toolCallId. */
	recordToolCallStart(toolName: string, toolCallId?: string): void {
		if (toolCallId) {
			if (this._pendingToolCallIds.has(toolCallId)) return
			this._pendingToolCallIds.add(toolCallId)
		} else {
			if (this._pendingToolName === toolName) return
			this._pendingToolName = toolName
		}

		const localId = `tc-${++this._toolCallSeq}`
		this._pendingToolCalls.set(localId, toolName)
		if (toolCallId) this._acpToLocalId.set(toolCallId, localId)

		const last = this._messages[this._messages.length - 1]
		if (last?.role === "assistant") {
			const parts = last.content as Array<{ type: string; [k: string]: unknown }>
			parts.push({ type: "toolCall", id: localId, name: toolName, arguments: {} })
		} else {
			this._messages.push({
				role: "assistant",
				content: [{ type: "toolCall", id: localId, name: toolName, arguments: {} }],
			})
		}
		this.emit({
			type: "tool_execution_start",
			toolCallId: localId,
			toolName,
			args: {},
		})
	}

	/** Record a tool call completion in the transcript.
	 *  Adds a toolResult message matching the local agent ToolResultMessage shape:
	 *  `{ role: "toolResult", toolCallId, toolName, content, isError, timestamp }`.
	 *  Clears the pending-tool dedup so the same tool name can start again.
	 *  Saves the current accumulated text length so the next assistant message
	 *  only includes text that came after this tool call. */
	recordToolCallEnd(toolName: string, toolCallId?: string, isError = false): void {
		this._textOffset = this._lastFullTextLength
		let localId: string | undefined
		if (toolCallId) {
			localId = this._acpToLocalId.get(toolCallId)
			this._pendingToolCallIds.delete(toolCallId)
			this._acpToLocalId.delete(toolCallId)
		} else {
			this._pendingToolName = undefined
			for (const [id, name] of this._pendingToolCalls) {
				if (name === toolName) {
					localId = id
					break
				}
			}
		}
		if (localId) this._pendingToolCalls.delete(localId)
		this._messages.push({
			role: "toolResult",
			toolCallId: localId ?? toolName,
			toolName,
			content: [{ type: "text", text: isError ? "(tool failed)" : "(completed)" }],
			isError,
			timestamp: Date.now(),
		})
		this.emit({
			type: "tool_execution_end",
			toolCallId: localId ?? toolName,
			toolName,
			result: isError ? "(tool failed)" : "(completed)",
			isError,
		})
	}

	/**
	 * Steering is not supported for remote agents — ACP has no dedicated
	 * steering primitive. This will be implemented later once the ACP
	 * server supports it.
	 */
	async steer(_text: string): Promise<void> {
		throw new Error("Steering is not supported for remote agents")
	}

	/** Abort = cancel the in-progress remote turn. */
	async abort(): Promise<void> {
		await this.acpClient?.cancel()
	}

	/** Idempotent no-op — real cleanup happens in runRemoteAgent's finally. */
	dispose(): void {}
}
