import { randomUUID } from "node:crypto"
import { isAbsolute, resolve } from "node:path"
import type {
	ClientCapabilities,
	SessionNotification,
	SessionUpdate,
	ToolCallContent,
} from "@agentclientprotocol/sdk/unstable"
import type { AgentSession, InlineExtension } from "@earendil-works/pi-coding-agent"
import { truncate } from "./utils.js"

export const SUBAGENT_SESSION_CREATED_EVENT = "subagents:session_created"

/** Transport payload emitted by the agents extension on its parent's event bus. */
export interface SubagentSessionCreatedPayload {
	agentId: string
	sessionId: string
	parentSessionId: string
	toolCallId: string
	prompt: string
	description: string
	cwd: string
	visibility: string
	remote: boolean
	status: string
	background: boolean
	/** Existing runtime carried on the owning parent's in-process event bus. */
	agentSession?: AgentSession
}

export type SubagentSessionCreatedEvent = SubagentSessionCreatedPayload

function stringField(value: Record<string, unknown>, key: string): string | undefined {
	const field = value[key]
	return typeof field === "string" && field.length > 0 ? field : undefined
}

/** Small version-neutral parser: the partner event is extension data, not an
 * ACP SDK schema. Invalid data must not tear down the parent extension bus. */
export function parseSubagentSessionCreated(value: unknown): SubagentSessionCreatedEvent | undefined {
	if (!value || typeof value !== "object") return undefined
	const data = value as Record<string, unknown>
	const agentId = stringField(data, "agentId")
	const sessionId = stringField(data, "sessionId")
	const parentSessionId = stringField(data, "parentSessionId")
	const toolCallId = stringField(data, "toolCallId")
	const prompt = stringField(data, "prompt")
	const description = stringField(data, "description")
	const cwd = stringField(data, "cwd")
	const visibility = stringField(data, "visibility")
	const status = stringField(data, "status")
	if (!agentId || !sessionId || !parentSessionId || !toolCallId || prompt === undefined) return undefined
	if (!description || !cwd || !visibility || !status) return undefined
	if (typeof data.remote !== "boolean" || typeof data.background !== "boolean") return undefined
	return {
		agentId,
		sessionId,
		parentSessionId,
		toolCallId,
		prompt,
		description,
		cwd,
		visibility,
		remote: data.remote,
		status,
		background: data.background,
		agentSession: data.agentSession as AgentSession | undefined,
	}
}

/** Presence is the opt-in. `{}` means supported; undefined and null do not. */
export function clientSupportsSubagents(capabilities: ClientCapabilities | undefined): boolean {
	return (capabilities as { subagents?: unknown } | undefined)?.subagents != null
}

/** Add the observer to the SAME DefaultResourceLoader extension set as the
 * parent. No manager lookup and no second extension/runtime binding. */
export function subagentSessionCreatedExtension(
	onCreated: (event: SubagentSessionCreatedEvent) => void,
): InlineExtension {
	return (pi) => {
		pi.events.on(SUBAGENT_SESSION_CREATED_EVENT, (value: unknown) => {
			const event = parseSubagentSessionCreated(value)
			if (event) onCreated(event)
		})
	}
}

export function absoluteSubagentCwd(cwd: string, parentCwd: string): string {
	return isAbsolute(cwd) ? resolve(cwd) : resolve(parentCwd, cwd)
}

export function subagentTitle(description: string): string {
	return truncate(description, 80) || "Agent"
}

/** Agent calls keep their original rawInput/toolCallId. Only the new ACP
 * presentation fields change for clients that announced subagent support. */
export function presentAgentToolCall<T extends SessionUpdate>(update: T, toolName: string, enabled: boolean): T {
	if (toolName !== "Agent" || (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update")) {
		return update
	}
	return {
		...update,
		...(enabled ? { name: "subagent", kind: "other" } : { kind: "think" }),
	} as T
}

/** Session links are native ACP content, not an invented ACP variant. They
 * are added only after the child announcement and preserved on every later
 * Agent content replacement. */
export function withSubagentSessionLink(
	content: ToolCallContent[] | undefined,
	childSessionId: string | undefined,
): ToolCallContent[] {
	const existing = content ?? []
	if (!childSessionId) return existing
	const withoutDuplicate = existing.filter((item) => !(item.type === "session" && item.sessionId === childSessionId))
	return [...withoutDuplicate, { type: "session", sessionId: childSessionId }] as ToolCallContent[]
}

export function subagentAnnouncement(
	parentSessionId: string,
	event: SubagentSessionCreatedPayload,
	cwd: string,
): SessionNotification {
	return {
		sessionId: parentSessionId,
		update: {
			sessionUpdate: "subagent_update",
			sessionId: event.sessionId,
			title: subagentTitle(event.description),
			description: event.description,
			cwd,
			additionalDirectories: [],
			capabilities: {},
			state: { state: "running" },
		},
	}
}

export function subagentStateUpdate(
	parentSessionId: string,
	childSessionId: string,
	state: "running" | "idle",
	stopReason?: string,
): SessionNotification {
	return {
		sessionId: parentSessionId,
		update: {
			sessionUpdate: "subagent_update",
			sessionId: childSessionId,
			state: state === "running" ? { state } : { state, stopReason: stopReason ?? "end_turn" },
		},
	}
}

/** Announce first, then send the full original prompt with unique ids. Both
 * views live in their own transcript envelope; neither uses the agent run id. */
export function subagentPromptMessages(
	parentSessionId: string,
	event: SubagentSessionCreatedPayload,
): SessionNotification[] {
	const parentMessageId = `ksp.${randomUUID()}`
	const childMessageId = `ksc.${randomUUID()}`
	return [
		{
			sessionId: parentSessionId,
			update: {
				sessionUpdate: "session_message",
				messageId: parentMessageId,
				senderSessionId: parentSessionId,
				recipientSessionId: event.sessionId,
				recipientMessageId: childMessageId,
				content: [{ type: "text", text: event.prompt }],
			},
		},
		{
			sessionId: event.sessionId,
			update: {
				sessionUpdate: "session_message",
				messageId: childMessageId,
				senderSessionId: parentSessionId,
				senderMessageId: parentMessageId,
				recipientSessionId: event.sessionId,
				content: [{ type: "text", text: event.prompt }],
			},
		},
		{
			sessionId: event.sessionId,
			update: {
				sessionUpdate: "session_message_chunk",
				messageId: childMessageId,
				content: { type: "text", text: event.prompt },
			},
		},
	]
}
