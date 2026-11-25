import type { AgentSessionEvent, AgentSessionEventListener } from "@earendil-works/pi-coding-agent"
import { BaseFakeAgentSession } from "./fake-agent-session.js"

/** Minimal live-event fake shared by ACP projection and replay tests. */
export class RecordingFakeAgentSession extends BaseFakeAgentSession {
	private listeners = new Set<AgentSessionEventListener>()

	constructor(sessionId: string, cwd = "/tmp") {
		super(sessionId)
		this.sessionManager.getCwd = () => cwd
		Object.assign(this.sessionManager, {
			getSessionFile: () => `/sessions/${sessionId}.jsonl`,
			getHeader: () => ({ cwd, parentSession: undefined }),
		})
	}

	clearQueue = () => ({ steering: [], followUp: [] })
	getContextUsage = () => undefined

	subscribe = (listener?: AgentSessionEventListener): (() => void) => {
		if (listener) this.listeners.add(listener)
		return () => {
			if (listener) this.listeners.delete(listener)
		}
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of [...this.listeners]) listener(event)
	}

	streamAssistantText(text: string): void {
		const message = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "test",
			provider: "test",
			model: "test-model",
			usage: undefined,
			stopReason: "stop",
			timestamp: Date.now(),
		}
		this.emit({ type: "message_start", message } as unknown as AgentSessionEvent)
		this.emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: message },
		} as unknown as AgentSessionEvent)
		this.emit({ type: "message_end", message } as unknown as AgentSessionEvent)
	}
}
