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
export interface SubagentCancellation {
	/** Synchronously claims a real manager-backed abort; false remains a no-op. */
	accepted: boolean
	/** Settles only after the manager's native run has finished stopping. */
	stopped: Promise<void>
}

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
	/** A resumed native session carries a new prompt onto its existing route. */
	phase?: "created" | "resumed"
	/** Existing runtime carried on the owning parent's in-process event bus. */
	agentSession?: AgentSession
	/** Bound in the parent's own manager extension, never resolved globally. */
	abort?: () => SubagentCancellation
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
	const prompt = typeof data.prompt === "string" ? data.prompt : undefined
	const description = stringField(data, "description")
	const cwd = stringField(data, "cwd")
	const visibility = stringField(data, "visibility")
	const status = stringField(data, "status")
	if (!agentId || !sessionId || !parentSessionId || !toolCallId || prompt === undefined) return undefined
	if (!description || !cwd || !visibility || !status) return undefined
	if (typeof data.remote !== "boolean" || typeof data.background !== "boolean") return undefined
	if (data.phase !== undefined && data.phase !== "created" && data.phase !== "resumed") return undefined
	if (data.abort !== undefined && typeof data.abort !== "function") return undefined
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
		phase: data.phase,
		agentSession: data.agentSession as AgentSession | undefined,
		abort: data.abort as (() => SubagentCancellation) | undefined,
	}
}

/** `{}` advertises support; omission, null, and malformed values do not. */
export function clientSupportsSubagents(capabilities: ClientCapabilities | undefined): boolean {
	const subagents = (capabilities as { subagents?: unknown } | undefined)?.subagents
	return typeof subagents === "object" && subagents !== null
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
		...(enabled ? { name: "subagent", kind: "other" } : {}),
	} as T
}

/** Durable identity for the directed initial task on replay. Live messages
 * retain unique ids; replayed views reproduce those ids instead of allocating
 * fresh links each time a parent is loaded. */
function replayMessageId(kind: "ksp" | "ksc", parentSessionId: string, event: SubagentSessionCreatedPayload): string {
	return `${kind}.${parentSessionId}.${event.sessionId}.${event.agentId}`
}

export function subagentReplayPromptMessages(
	parentSessionId: string,
	event: SubagentSessionCreatedPayload,
): SessionNotification[] {
	const parentMessageId = replayMessageId("ksp", parentSessionId, event)
	const childMessageId = replayMessageId("ksc", parentSessionId, event)
	return directedSubagentPromptMessages(parentSessionId, event, parentMessageId, childMessageId)
}

/** Session links are native ACP content, not an invented ACP variant. They
 * are added only after the child announcement and preserved on every later
 * Agent content replacement. */
export function withSubagentSessionLink(
	content: ToolCallContent[] | undefined,
	childSessionId: string | undefined,
): ToolCallContent[] | undefined {
	if (!childSessionId) return content
	const existing = content ?? []
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
			capabilities: event.abort ? { cancel: {} } : {},
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

/** Start both views with distinct ids. The child receives its initial content
 * exactly once in the following chunk; the parent retains its full-prompt view. */
export function subagentPromptMessages(
	parentSessionId: string,
	event: Pick<SubagentSessionCreatedPayload, "sessionId" | "prompt">,
	prompt = event.prompt,
): SessionNotification[] {
	return directedSubagentPromptMessages(parentSessionId, event, `ksp.${randomUUID()}`, `ksc.${randomUUID()}`, prompt)
}

function directedSubagentPromptMessages(
	parentSessionId: string,
	event: Pick<SubagentSessionCreatedPayload, "sessionId" | "prompt">,
	parentMessageId: string,
	childMessageId: string,
	prompt = event.prompt,
): SessionNotification[] {
	return [
		{
			sessionId: parentSessionId,
			update: {
				sessionUpdate: "session_message",
				messageId: parentMessageId,
				senderSessionId: parentSessionId,
				recipientSessionId: event.sessionId,
				recipientMessageId: childMessageId,
				content: [{ type: "text", text: prompt }],
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
				content: [],
			},
		},
		{
			sessionId: event.sessionId,
			update: {
				sessionUpdate: "session_message_chunk",
				messageId: childMessageId,
				content: { type: "text", text: prompt },
			},
		},
	]
}
