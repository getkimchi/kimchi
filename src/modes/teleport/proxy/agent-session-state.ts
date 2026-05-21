import type { RpcAgentEventLike } from "../ws/events.js"

/** Mutable session state tracked from RPC events. */
export interface SessionState {
	messages: Array<Record<string, unknown>>
	isStreaming: boolean
	steering: string[]
	followUp: string[]
	model?: Record<string, unknown>
	thinkingLevel: string
	isCompacting: boolean
	isRetrying: boolean
	isBashRunning: boolean
	totalInput: number
	totalOutput: number
	totalCacheRead: number
	totalCacheWrite: number
}

export function createInitialState(): SessionState {
	return {
		messages: [],
		isStreaming: false,
		steering: [],
		followUp: [],
		model: undefined,
		thinkingLevel: "disabled",
		isCompacting: false,
		isRetrying: false,
		isBashRunning: false,
		totalInput: 0,
		totalOutput: 0,
		totalCacheRead: 0,
		totalCacheWrite: 0,
	}
}

/**
 * Pure reducer: applies an RPC event to session state.
 * Returns the message from message_end events so the caller can persist it.
 */
export function applyEvent(state: SessionState, event: RpcAgentEventLike): { newMessage?: Record<string, unknown> } {
	switch (event.type) {
		case "agent_start":
			state.isStreaming = true
			state.steering = []
			state.followUp = []
			return {}
		case "agent_end":
			state.isStreaming = false
			if (event.messages) {
				state.messages = event.messages as Array<Record<string, unknown>>
			}
			return {}
		case "message_end": {
			const msg = event.message as Record<string, unknown> | undefined
			if (msg) {
				state.messages = [...state.messages, msg]
			}
			const role = (msg as { role?: unknown } | undefined)?.role
			const usage = (msg as { usage?: Record<string, number> } | undefined)?.usage
			if (role === "assistant" && usage) {
				state.totalInput += usage.input ?? 0
				state.totalOutput += usage.output ?? 0
				state.totalCacheRead += usage.cacheRead ?? 0
				state.totalCacheWrite += usage.cacheWrite ?? 0
			}
			return { newMessage: msg }
		}
		case "model_selected":
			state.model = { id: event.modelId, provider: event.provider }
			return {}
		case "thinking_level_changed":
			state.thinkingLevel = (event.level as string) ?? "disabled"
			return {}
		case "compaction_start":
			state.isCompacting = true
			return {}
		case "compaction_end":
			state.isCompacting = false
			return {}
		case "auto_retry_start":
			state.isRetrying = true
			return {}
		case "auto_retry_end":
			state.isRetrying = false
			return {}
		case "tool_execution_start":
			if ((event as { toolName?: unknown }).toolName === "bash") {
				state.isBashRunning = true
			}
			return {}
		case "tool_execution_end":
			if ((event as { toolName?: unknown }).toolName === "bash") {
				state.isBashRunning = false
			}
			return {}
		default:
			return {}
	}
}
