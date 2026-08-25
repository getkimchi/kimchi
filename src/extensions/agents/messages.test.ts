import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import {
	AGENT_MESSAGE_LIMITS,
	AgentHandoffPayloadSchema,
	AgentMessageInputSchema,
	createAgentMessage,
	createAgentMessageThread,
	createChildIdempotencyKey,
	createParentReplyIdempotencyKey,
	findOldestClosedThread,
	serializedAgentMessageBytes,
	validateAgentMessageInput,
} from "./messages.js"

const scope = { rootSessionId: "root-1", sourceAgentId: "agent-1", taskId: "agent-task:agent-1" }
const reservation = { idempotencyKey: createChildIdempotencyKey(scope, 2, "call-1"), scope, sourceAttemptId: 2 }

describe("agent message contract", () => {
	it("accepts allowed child recipient and payload combinations", () => {
		expect(
			Value.Check(AgentMessageInputSchema, {
				recipient: { type: "user" },
				payload: { kind: "question", question: "Which API?", impact: "Blocks implementation", canContinue: false },
			}),
		).toBe(true)
		expect(
			Value.Check(AgentMessageInputSchema, {
				recipient: { type: "agent", agentId: "agent-2" },
				payload: { kind: "answer", answer: "Use the existing API." },
				reply_to: "question-1",
			}),
		).toBe(true)
	})

	it("rejects parent or user answers, question replies, and child-supplied host fields", () => {
		expect(
			Value.Check(AgentMessageInputSchema, {
				recipient: { type: "parent" },
				payload: { kind: "answer", answer: "No." },
				reply_to: "question-1",
			}),
		).toBe(false)
		expect(
			Value.Check(AgentMessageInputSchema, {
				recipient: { type: "user" },
				payload: { kind: "answer", answer: "No." },
				reply_to: "question-1",
			}),
		).toBe(false)
		expect(
			Value.Check(AgentMessageInputSchema, {
				recipient: { type: "parent" },
				payload: { kind: "question", question: "Which API?", impact: "Blocks implementation", canContinue: false },
				reply_to: "question-1",
			}),
		).toBe(false)
		expect(
			Value.Check(AgentMessageInputSchema, {
				recipient: { type: "parent" },
				payload: {
					kind: "handoff",
					action: "Inspect",
					state: "done",
					sourceTaskId: "forged",
					evidence: [],
					nextAction: "Review",
				},
			}),
		).toBe(false)
	})

	it("fills handoff task identity from the host reservation", () => {
		const message = createAgentMessage(
			reservation,
			"message-1",
			{ type: "parent" },
			{ kind: "handoff", action: "Inspect", state: "done", evidence: [], nextAction: "Review" },
			{ createdAt: 1 },
		)

		expect(message).toMatchObject({
			rootSessionId: "root-1",
			sourceAgentId: "agent-1",
			sourceTaskId: "agent-task:agent-1",
			sourceAttemptId: 2,
			threadId: "message-1",
		})
		expect(Value.Check(AgentHandoffPayloadSchema, message.payload)).toBe(true)
	})

	it("enforces serialized-size, evidence, and question-option limits before a route is attempted", () => {
		const tooManyOptions = {
			recipient: { type: "parent" },
			payload: {
				kind: "question",
				question: "Choose",
				impact: "Blocks",
				options: Array.from({ length: AGENT_MESSAGE_LIMITS.maxQuestionOptions + 1 }, () => "option"),
				canContinue: false,
			},
		}
		expect(Value.Check(AgentMessageInputSchema, tooManyOptions)).toBe(false)
		expect(
			Value.Check(AgentMessageInputSchema, {
				recipient: { type: "parent" },
				payload: {
					kind: "question",
					question: "Choose",
					impact: "Blocks",
					options: ["x".repeat(AGENT_MESSAGE_LIMITS.maxQuestionOptionLength + 1)],
					canContinue: false,
				},
			}),
		).toBe(false)
		expect(
			Value.Check(AgentMessageInputSchema, {
				recipient: { type: "parent" },
				payload: {
					kind: "handoff",
					action: "Inspect",
					state: "done",
					evidence: Array.from({ length: AGENT_MESSAGE_LIMITS.maxHandoffEvidence + 1 }, () => ({
						label: "proof",
						reference: "src/file.ts:1",
					})),
					nextAction: "Review",
				},
			}),
		).toBe(false)

		const exactLimit = {
			recipient: { type: "parent" },
			payload: { kind: "status", summary: "" },
		}
		const exactBytes = serializedAgentMessageBytes(exactLimit)
		exactLimit.payload.summary = "x".repeat(AGENT_MESSAGE_LIMITS.maxPayloadBytes - exactBytes)
		expect(validateAgentMessageInput(exactLimit)).toMatchObject({ valid: true })
		const oversized = {
			recipient: { type: "parent" },
			payload: {
				kind: "status",
				summary: "x".repeat(AGENT_MESSAGE_LIMITS.maxPayloadBytes),
			},
		}
		expect(validateAgentMessageInput(oversized)).toEqual(
			expect.objectContaining({ valid: false, reason: expect.stringContaining("exceeds") }),
		)
		expect(serializedAgentMessageBytes(oversized)).toBeGreaterThan(AGENT_MESSAGE_LIMITS.maxPayloadBytes)
	})

	it("selects the oldest closed thread and never selects an open one for eviction", () => {
		const closed = { state: "closed" as const, createdAt: 2 }
		expect(
			findOldestClosedThread([
				{ state: "open" as const, createdAt: 1 },
				closed,
				{ state: "closed" as const, createdAt: 3 },
			]),
		).toBe(closed)
		expect(
			findOldestClosedThread(
				Array.from({ length: AGENT_MESSAGE_LIMITS.maxThreadsPerAgent }, (_, createdAt) => ({
					state: "open" as const,
					createdAt,
				})),
			),
		).toBeUndefined()
	})

	it("partitions child idempotency by live attempt and keeps receipt language truthful", () => {
		expect(createChildIdempotencyKey(scope, 2, "call-1")).toBe("root-1:agent-1:2:call-1")
		expect(createChildIdempotencyKey(scope, 3, "call-1")).not.toBe(reservation.idempotencyKey)
		expect(createParentReplyIdempotencyKey("root-1", "message-1", "call-2")).toBe("root-1:parent:message-1:call-2")

		const accepted = createAgentMessage(
			reservation,
			"message-1",
			{ type: "parent" },
			{ kind: "question", question: "Proceed?", impact: "Blocks", canContinue: false },
			{ createdAt: 1 },
		)
		expect(createAgentMessageThread(accepted)).toMatchObject({ state: "open", expectedResponder: "parent" })
		expect(["queued_for_parent", "queued_before_session", "queued_for_running_session"]).not.toContain("delivered")
	})
})
