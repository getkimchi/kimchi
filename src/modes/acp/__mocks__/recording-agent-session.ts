import type { AgentSessionEvent, AgentSessionEventListener } from "@earendil-works/pi-coding-agent"
import { BaseFakeAgentSession } from "./fake-agent-session.js"

/** Minimal live-event fake shared by ACP projection and replay tests. */
export class RecordingFakeAgentSession extends BaseFakeAgentSession {
	private listeners = new Set<AgentSessionEventListener>()

	constructor(sessionId: string, cwd = "/tmp") {
		super(sessionId)
		this.sessionManager.getCwd = () => cwd
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
}
