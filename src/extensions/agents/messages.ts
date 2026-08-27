import { Type } from "typebox"
import { Value } from "typebox/value"
import type { AgentCommunicationScope, AgentOutcome } from "./personas/types.js"

// ponytail: fixed in-memory caps; add durable quotas only with session rehydration.
export const AGENT_MESSAGE_LIMITS = {
	maxPayloadBytes: 16 * 1024,
	maxMessagesPerAttempt: 32,
	maxOpenQuestionsPerAgent: 8,
	maxPendingMessagesPerTarget: 32,
	maxMessagesPerThread: 16,
	maxReceiptsPerAgent: 64,
	maxThreadsPerAgent: 16,
	maxMetadataRecords: 1024,
	maxPendingPayloadBytes: 2 * 1024 * 1024,
	maxHandoffEvidence: 16,
	maxQuestionOptions: 8,
	maxQuestionOptionLength: 256,
	/** Send-side loop guard: identical source-to-recipient payloads inside this
	 *  window are dropped as accidental model send-loops. */
	duplicateMessageWindowMs: 120_000,
} as const

export const ParentAgentMessageRecipientSchema = Type.Object(
	{ type: Type.Literal("parent") },
	{ additionalProperties: false },
)

export const UserAgentMessageRecipientSchema = Type.Object(
	{ type: Type.Literal("user") },
	{ additionalProperties: false },
)

export const PeerAgentMessageRecipientSchema = Type.Object(
	{ type: Type.Literal("agent"), agentId: Type.String() },
	{ additionalProperties: false },
)

export const AgentMessageRecipientSchema = Type.Union([
	ParentAgentMessageRecipientSchema,
	UserAgentMessageRecipientSchema,
	PeerAgentMessageRecipientSchema,
])

export const AgentQuestionPayloadSchema = Type.Object(
	{
		kind: Type.Literal("question"),
		question: Type.String(),
		impact: Type.String(),
		options: Type.Optional(
			Type.Array(Type.String({ maxLength: AGENT_MESSAGE_LIMITS.maxQuestionOptionLength }), {
				maxItems: AGENT_MESSAGE_LIMITS.maxQuestionOptions,
			}),
		),
		recommendedDefault: Type.Optional(Type.String()),
		canContinue: Type.Boolean(),
	},
	{ additionalProperties: false },
)

export const AgentAnswerPayloadSchema = Type.Object(
	{
		kind: Type.Literal("answer"),
		answer: Type.String(),
		evidence: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
)

export const AgentDeclinePayloadSchema = Type.Object(
	{
		kind: Type.Literal("decline"),
		reason: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
)

export const AgentStatusPayloadSchema = Type.Object(
	{
		kind: Type.Literal("status"),
		summary: Type.String(),
		nextAction: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
)

export const AgentHandoffPayloadSchema = Type.Object(
	{
		kind: Type.Literal("handoff"),
		action: Type.String(),
		state: Type.String(),
		result: Type.Optional(Type.String()),
		sourceTaskId: Type.String(),
		evidence: Type.Array(
			Type.Object({ label: Type.String(), reference: Type.String() }, { additionalProperties: false }),
			{ maxItems: AGENT_MESSAGE_LIMITS.maxHandoffEvidence },
		),
		nextAction: Type.String(),
	},
	{ additionalProperties: false },
)

const AgentHandoffInputPayloadSchema = Type.Object(
	{
		kind: Type.Literal("handoff"),
		action: Type.String(),
		state: Type.String(),
		result: Type.Optional(Type.String()),
		evidence: Type.Array(
			Type.Object({ label: Type.String(), reference: Type.String() }, { additionalProperties: false }),
			{ maxItems: AGENT_MESSAGE_LIMITS.maxHandoffEvidence },
		),
		nextAction: Type.String(),
	},
	{ additionalProperties: false },
)

export const AgentMessagePayloadSchema = Type.Union([
	AgentQuestionPayloadSchema,
	AgentAnswerPayloadSchema,
	AgentDeclinePayloadSchema,
	AgentStatusPayloadSchema,
	AgentHandoffPayloadSchema,
])

const ChildQuestionParamsSchema = Type.Object(
	{
		recipient: AgentMessageRecipientSchema,
		payload: AgentQuestionPayloadSchema,
	},
	{ additionalProperties: false },
)

const ChildAnswerParamsSchema = Type.Object(
	{
		recipient: PeerAgentMessageRecipientSchema,
		payload: Type.Union([AgentAnswerPayloadSchema, AgentDeclinePayloadSchema]),
		reply_to: Type.String(),
	},
	{ additionalProperties: false },
)

const ChildUpdateParamsSchema = Type.Object(
	{
		recipient: Type.Union([ParentAgentMessageRecipientSchema, PeerAgentMessageRecipientSchema]),
		payload: Type.Union([AgentStatusPayloadSchema, AgentHandoffInputPayloadSchema]),
	},
	{ additionalProperties: false },
)

/** Input exposed to a child tool. Host-owned scope and IDs are intentionally absent. */
export const AgentMessageInputSchema = Type.Union([
	ChildQuestionParamsSchema,
	ChildAnswerParamsSchema,
	ChildUpdateParamsSchema,
])

export type AgentMessageRecipient = { type: "parent" } | { type: "user" } | { type: "agent"; agentId: string }

export type AgentQuestionPayload = {
	kind: "question"
	question: string
	impact: string
	options?: string[]
	recommendedDefault?: string
	canContinue: boolean
}

export type AgentAnswerPayload = { kind: "answer"; answer: string; evidence?: string[] }
export type AgentDeclinePayload = { kind: "decline"; reason?: string }
export type AgentStatusPayload = { kind: "status"; summary: string; nextAction?: string }
export type AgentHandoffPayload = {
	kind: "handoff"
	action: string
	state: string
	result?: string
	/** Filled by the host; child input cannot choose this value. */
	sourceTaskId: string
	evidence: Array<{ label: string; reference: string }>
	nextAction: string
}
export type AgentHandoffInputPayload = Omit<AgentHandoffPayload, "sourceTaskId">
export type AgentMessagePayload =
	| AgentQuestionPayload
	| AgentAnswerPayload
	| AgentDeclinePayload
	| AgentStatusPayload
	| AgentHandoffPayload

export type AgentMessageInput =
	| { recipient: AgentMessageRecipient; payload: AgentQuestionPayload }
	| {
			recipient: Extract<AgentMessageRecipient, { type: "agent" }>
			payload: AgentAnswerPayload | AgentDeclinePayload
			reply_to: string
	  }
	| {
			recipient: Exclude<AgentMessageRecipient, { type: "user" }>
			payload: AgentStatusPayload | AgentHandoffInputPayload
	  }

/** Canonical JSON with recursively sorted keys, so the duplicate guard
 *  cannot be defeated by model key ordering. */
function canonicalForDuplicateGuard(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalForDuplicateGuard).join(",")}]`
	if (value && typeof value === "object") {
		return `{${Object.keys(value as Record<string, unknown>)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalForDuplicateGuard((value as Record<string, unknown>)[key])}`)
			.join(",")}}`
	}
	return JSON.stringify(value) ?? "null"
}

/** Identity of one send attempt for the loop guard: same source, same
 *  recipient, same semantic payload. Tool-call/idempotency identity is
 *  deliberately absent — retried tool calls are already deduped by receipt
 *  reservations; this catches identical NEW calls (model send-loops). */
export function createDuplicateMessageKey<T extends AgentMessagePayload | AgentMessageInput["payload"]>(
	sourceAgentId: string,
	recipient: AgentMessageRecipient,
	payload: T,
): string {
	return `${sourceAgentId}|${canonicalForDuplicateGuard(recipient)}|${canonicalForDuplicateGuard(payload)}`
}

export interface AgentMessage {
	id: string
	idempotencyKey: string
	threadId: string
	replyTo?: string
	rootSessionId: string
	sourceAgentId: string
	sourceTaskId: string
	sourceAttemptId: number
	recipient: AgentMessageRecipient
	payload: AgentMessagePayload
	createdAt: number
}

export type AgentMessageReceiptStatus =
	| "queued_for_parent"
	| "queued_before_session"
	| "queued_for_running_session"
	| "resume_attempt_completed"
	| "rejected"
	| "unavailable"
	| "saturated"

export interface AgentMessageReceipt {
	messageId?: string
	threadId?: string
	status: AgentMessageReceiptStatus
	agentOutcome?: AgentOutcome
	reason?: string
	escapeHatch?: string
}

export interface AgentMessageReservation {
	idempotencyKey: string
	scope: AgentCommunicationScope
	sourceAttemptId: number
}

export interface AgentMessageThread {
	id: string
	rootSessionId: string
	questionMessageId: string
	sourceAgentId: string
	sourceTaskId: string
	recipient: AgentMessageRecipient
	expectedResponder: "parent" | "agent"
	state: "open" | "closed"
	messageCount: number
	createdAt: number
	closedAt?: number
	closeReason?: string
}

/** The broker evicts only closed metadata; unanswered questions are never disposable. */
export function findOldestClosedThread<T extends { state: "open" | "closed"; createdAt: number }>(
	threads: Iterable<T>,
): T | undefined {
	let oldest: T | undefined
	for (const thread of threads) {
		if (thread.state !== "closed" || (oldest && oldest.createdAt <= thread.createdAt)) continue
		oldest = thread
	}
	return oldest
}

export function createChildIdempotencyKey(
	scope: AgentCommunicationScope,
	sourceAttemptId: number,
	toolCallId: string,
): string {
	return `${scope.rootSessionId}:${scope.sourceAgentId}:${sourceAttemptId}:${toolCallId}`
}

export function createParentReplyIdempotencyKey(rootSessionId: string, messageId: string, toolCallId: string): string {
	return `${rootSessionId}:parent:${messageId}:${toolCallId}`
}

export function serializedAgentMessageBytes(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf8")
	} catch {
		return Number.POSITIVE_INFINITY
	}
}

export function validateAgentMessageInput(
	value: unknown,
): { valid: true; value: AgentMessageInput; bytes: number } | { valid: false; reason: string } {
	if (!Value.Check(AgentMessageInputSchema, value)) {
		return { valid: false, reason: "Message must use one supported recipient and payload combination." }
	}
	const bytes = serializedAgentMessageBytes(value)
	if (bytes > AGENT_MESSAGE_LIMITS.maxPayloadBytes) {
		return { valid: false, reason: `Message payload exceeds ${AGENT_MESSAGE_LIMITS.maxPayloadBytes} bytes.` }
	}
	return { valid: true, value: value as AgentMessageInput, bytes }
}

export function createAgentMessage(
	reservation: AgentMessageReservation,
	id: string,
	recipient: AgentMessageRecipient,
	payload: AgentMessageInput["payload"],
	options: { replyTo?: string; threadId?: string; createdAt?: number } = {},
): AgentMessage {
	const threadId = options.threadId ?? id
	return {
		id,
		idempotencyKey: reservation.idempotencyKey,
		threadId,
		replyTo: options.replyTo,
		rootSessionId: reservation.scope.rootSessionId,
		sourceAgentId: reservation.scope.sourceAgentId,
		sourceTaskId: reservation.scope.taskId,
		sourceAttemptId: reservation.sourceAttemptId,
		recipient,
		payload: payload.kind === "handoff" ? { ...payload, sourceTaskId: reservation.scope.taskId } : payload,
		createdAt: options.createdAt ?? Date.now(),
	}
}

export function createAgentMessageThread(message: AgentMessage): AgentMessageThread | undefined {
	if (message.payload.kind !== "question") return undefined
	return {
		id: message.threadId,
		rootSessionId: message.rootSessionId,
		questionMessageId: message.id,
		sourceAgentId: message.sourceAgentId,
		sourceTaskId: message.sourceTaskId,
		recipient: message.recipient,
		expectedResponder: message.recipient.type === "agent" ? "agent" : "parent",
		state: "open",
		messageCount: 1,
		createdAt: message.createdAt,
	}
}
