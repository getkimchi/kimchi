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
import type { LifetimeUsage, SessionStatsLike } from "./usage.js"

export interface RemoteSessionMeta {
	workspaceId: string
	sessionName: string
	wsUrl: string
	host: string
}

export class RemoteAgentSession {
	private acpClient: AcpSessionClient | undefined
	private meta: RemoteSessionMeta | undefined
	private listeners: ((event: AgentSessionEvent) => void)[] = []
	private _messages: { role: string; content: unknown }[] = []
	private _usage: LifetimeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
	private _isStreaming = false
	private _turnCount = 0

	/** Called by _runRemote() via runRemoteAgent's onReady callback. */
	bindClient(acpClient: AcpSessionClient, meta: RemoteSessionMeta): void {
		this.acpClient = acpClient
		this.meta = meta
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

	get messages(): { role: string; content: unknown }[] {
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

	/** Forward an event to all subscribers. */
	emit(event: AgentSessionEvent): void {
		for (const l of this.listeners) l(event)
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
	 *  ACP's onTextDelta provides the full accumulated text, not a delta —
	 *  so we replace the last assistant message instead of appending a new one. */
	appendAssistantText(text: string): void {
		const last = this._messages[this._messages.length - 1]
		if (last?.role === "assistant") {
			last.content = [{ type: "text", text }]
		} else {
			this._messages.push({ role: "assistant", content: [{ type: "text", text }] })
		}
	}

	get turnCount(): number {
		return this._turnCount
	}

	incrementTurnCount(): void {
		this._turnCount++
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
