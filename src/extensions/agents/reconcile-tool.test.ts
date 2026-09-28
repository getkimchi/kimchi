import { SessionManager } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { runAsAgentWorker } from "../agent-worker-context.js"
import { getWriteTodosDetails, isTodoWriteToolName } from "../todos/session.js"
import {
	__resetTodoStore,
	applyWriteTodos,
	GLOBAL_TODO_SCOPE,
	getTodosForScope,
	restoreTodoStoreFromDetails,
} from "../todos/store.js"
import type { AgentRecord } from "./personas/types.js"
import { RECONCILE_AGENT_RESULT_TOOL_NAME, registerReconcileAgentResultTool } from "./reconcile-tool.js"

function setup() {
	const session = SessionManager.inMemory("/tmp")
	const api = createExtensionApi()
	const ctx = createContext({
		sessionManager: { getSessionId: () => session.getSessionId(), getBranch: () => session.getBranch() },
	})
	const record: AgentRecord = {
		id: "worker-1",
		type: "General-Purpose",
		description: "Fix parser",
		visibility: "user",
		communication: "group",
		communicationScope: { rootSessionId: session.getSessionId(), sourceAgentId: "worker-1", taskId: "task-1" },
		status: "completed",
		currentAttemptId: 1,
		toolUses: 1,
		startedAt: 10,
		completedAt: 100,
		result: "Parser fixed",
		compactionCount: 0,
		lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}
	applyWriteTodos(
		{
			todos: [
				{ content: "Fix parser", status: "in_progress" },
				{ content: "Update docs", status: "pending" },
			],
		},
		session.getSessionId(),
	)
	const closeQuestions = vi.fn().mockReturnValue(["question-1"])
	const hasBlockingQuestion = vi.fn().mockReturnValue(false)
	registerReconcileAgentResultTool(api.api, {
		getRecord: vi.fn((id: string) => (id === record.id ? record : undefined)),
		closeOpenParentThreadsForAgent: closeQuestions,
		hasOpenBlockingParentQuestion: hasBlockingQuestion,
	})
	const tool = api.getRegisteredTool(RECONCILE_AGENT_RESULT_TOOL_NAME)
	const run = (params: Record<string, unknown> = {}) =>
		tool.execute(
			"review",
			{
				agent_id: record.id,
				todo_id: 1,
				note: "Parser regression tests pass",
				...params,
			},
			undefined,
			undefined,
			ctx,
		)
	return {
		session,
		api,
		record,
		run,
		closeQuestions,
		hasBlockingQuestion,
		todos: () => getTodosForScope(GLOBAL_TODO_SCOPE, session.getSessionId()),
	}
}

function appendCheck(
	session: SessionManager,
	{ id = "check-1", name = "bash", isError = false, timestamp = 200 } = {},
) {
	session.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: { command: "pnpm test parser" } }],
		api: "openai-completions",
		provider: "test",
		model: "test",
		stopReason: "toolUse",
		timestamp,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	})
	session.appendMessage({
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: isError ? "Tests failed" : "3 tests passed" }],
		isError,
		timestamp: timestamp + 1,
	})
}

describe("parent result reconciliation", () => {
	beforeEach(__resetTodoStore)

	it("preserves an unanswered blocking question even when a parent command exits successfully", async () => {
		const h = setup()
		appendCheck(h.session)
		h.hasBlockingQuestion.mockReturnValue(true)
		await expect(h.run()).rejects.toThrow(
			"Answer or decline the worker's blocking question before reconciling its task.",
		)
		expect(h.todos()[0].status).toBe("in_progress")
		expect(h.closeQuestions).not.toHaveBeenCalled()
	})

	it.each([
		"completed",
		"steered",
	] as const)("reconciles a %s worker and persists parent verification provenance", async (status) => {
		const h = setup()
		h.record.status = status
		appendCheck(h.session)
		const result = await h.run()
		expect(result.details).toMatchObject({ schemaVersion: 1 })
		expect(h.todos()[0]).toMatchObject({
			status: "completed",
			note: "Evidence: Parser regression tests pass [agent worker-1, attempt 1; parent bash check-1]",
		})
		expect(h.todos()[1]).toMatchObject({ content: "Update docs", status: "pending" })
		expect(h.closeQuestions).toHaveBeenCalledWith(h.record.id, "parent_verified_completion")
		expect(result.content).toContainEqual({
			type: "text",
			text: expect.stringContaining("Closed questions: question-1. No reply or resume is needed."),
		})
		expect(isTodoWriteToolName(RECONCILE_AGENT_RESULT_TOOL_NAME)).toBe(true)
		h.session.appendMessage({
			role: "toolResult",
			toolCallId: "review",
			toolName: RECONCILE_AGENT_RESULT_TOOL_NAME,
			content: result.content,
			details: result.details,
			isError: false,
			timestamp: 300,
		})
		const writes = h.session
			.getBranch()
			.map(getWriteTodosDetails)
			.filter((d) => d !== undefined)
		restoreTodoStoreFromDetails(writes, "restored")
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "restored")).toEqual(h.todos())
	})

	it.each([
		"running",
		"queued",
		"aborted",
		"error",
		"stopped",
		"reconnecting",
	] as const)("rejects a %s worker", async (status) => {
		const h = setup()
		h.record.status = status
		appendCheck(h.session)
		await expect(h.run()).rejects.toThrow(
			"The subagent has not completed successfully. Wait, resume it, or record the remaining work as blocked.",
		)
		expect(h.todos()[0].status).toBe("in_progress")
		expect(h.closeQuestions).not.toHaveBeenCalled()
		expect(h.api.appendEntry).not.toHaveBeenCalled()
	})

	it.each(["completed", "steered"] as const)("requires a completion timestamp for a %s worker", async (status) => {
		const h = setup()
		h.record.status = status
		h.record.completedAt = undefined
		appendCheck(h.session)
		await expect(h.run()).rejects.toThrow(
			"The subagent has not completed successfully. Wait, resume it, or record the remaining work as blocked.",
		)
		expect(h.todos()[0].status).toBe("in_progress")
	})

	it("rejects workers from another parent session", async () => {
		const h = setup()
		h.record.communicationScope = { rootSessionId: "other", sourceAgentId: h.record.id, taskId: "task-1" }
		appendCheck(h.session)
		await expect(h.run()).rejects.toThrow(
			"Only the owning parent can reconcile a communicating subagent from this session.",
		)
		expect(h.closeQuestions).not.toHaveBeenCalled()
	})

	it("rejects a worker invoking the parent tool even with matching records", async () => {
		const h = setup()
		appendCheck(h.session)
		await expect(runAsAgentWorker(() => h.run())).rejects.toThrow(
			"Only the owning parent can reconcile a communicating subagent from this session.",
		)
		expect(h.todos()[0].status).toBe("in_progress")
	})

	it("rejects unknown workers without changing the task list", async () => {
		const h = setup()
		appendCheck(h.session)
		await expect(h.run({ agent_id: "missing-worker" })).rejects.toThrow(
			"Only the owning parent can reconcile a communicating subagent from this session.",
		)
		expect(h.todos()[0].status).toBe("in_progress")
	})

	it("accepts an explicitly selected artifact read without using a later unrelated check", async () => {
		const h = setup()
		appendCheck(h.session, { id: "artifact-read", name: "read" })
		appendCheck(h.session, { id: "unrelated-check", isError: true, timestamp: 300 })
		expect((await h.run({ verification_tool_call_id: "artifact-read" })).details).toMatchObject({ schemaVersion: 1 })
		expect(h.todos()[0].note).toContain("parent read artifact-read")
	})

	it("rejects verification on a discarded branch and accepts a new check on the current branch", async () => {
		const h = setup()
		const anchor = h.session.appendCustomEntry("branch-anchor", {})
		appendCheck(h.session)
		h.session.branch(anchor)
		await expect(h.run({ verification_tool_call_id: "check-1" })).rejects.toThrow(
			"No parent bash/read result matches verification_tool_call_id on the current branch. Omit this field to use the latest parent bash/read result, or supply the exact ID of the relevant check.",
		)
		appendCheck(h.session, { id: "branch-check", name: "read", timestamp: 300 })
		expect((await h.run()).details).toMatchObject({ schemaVersion: 1 })
		expect(h.todos()[0].note).toContain("parent read branch-check")
	})

	it.each([
		"get_subagent_result",
		"read_agent_board",
		"reconcile_agent_result",
		"write",
	])("rejects %s as verification", async (name) => {
		const h = setup()
		appendCheck(h.session, { name })
		await expect(h.run({ verification_tool_call_id: "check-1" })).rejects.toThrow(
			"No parent bash/read result matches verification_tool_call_id on the current branch. Omit this field to use the latest parent bash/read result, or supply the exact ID of the relevant check.",
		)
	})

	it.each([
		"completed",
		"steered",
	] as const)("rejects failed checks for a %s worker without falling back to an older pass", async (status) => {
		const h = setup()
		h.record.status = status
		appendCheck(h.session)
		appendCheck(h.session, { id: "check-2", isError: true, timestamp: 300 })
		await expect(h.run()).rejects.toThrow(
			"Run a successful parent bash check or read the resulting artifact after this worker finishes. Reports and board posts do not qualify.",
		)
		expect(h.closeQuestions).not.toHaveBeenCalled()
	})

	it("rejects an old verification after a worker resumes and finishes again", async () => {
		const h = setup()
		appendCheck(h.session)
		h.record.currentAttemptId = 2
		h.record.completedAt = 300
		await expect(h.run()).rejects.toThrow(
			"Run a successful parent bash check or read the resulting artifact after this worker finishes. Reports and board posts do not qualify.",
		)
		appendCheck(h.session, { id: "check-2", timestamp: 400 })
		expect((await h.run()).details).toMatchObject({ schemaVersion: 1 })
		expect(h.todos()[0].note).toContain("attempt 2; parent bash check-2")
	})

	it("rejects a result without a matching parent tool call", async () => {
		const h = setup()
		h.session.appendMessage({
			role: "toolResult",
			toolName: "bash",
			toolCallId: "invented",
			content: [{ type: "text", text: "passed" }],
			isError: false,
			timestamp: 200,
		})
		await expect(h.run()).rejects.toThrow(
			"Run a successful parent bash check or read the resulting artifact after this worker finishes. Reports and board posts do not qualify.",
		)
	})

	it("rejects a check started before the worker completed even if its result arrived later", async () => {
		const h = setup()
		appendCheck(h.session, { timestamp: 99 })
		await expect(h.run()).rejects.toThrow(
			"Run a successful parent bash check or read the resulting artifact after this worker finishes. Reports and board posts do not qualify.",
		)
	})

	it("rejects unknown evidence and TODO references without mutation", async () => {
		const h = setup()
		appendCheck(h.session)
		await expect(h.run({ verification_tool_call_id: "missing" })).rejects.toThrow(
			"No parent bash/read result matches verification_tool_call_id on the current branch. Omit this field to use the latest parent bash/read result, or supply the exact ID of the relevant check.",
		)
		await expect(h.run({ todo_id: 99 })).rejects.toThrow("The TODO does not exist in the current task list.")
		expect(h.todos()[0].status).toBe("in_progress")
	})

	it("recovers from an unknown ID only when the parent makes a new call with valid evidence", async () => {
		const h = setup()
		appendCheck(h.session, { name: "read", id: "actual-read-id" })
		await expect(h.run({ verification_tool_call_id: "read-INPUT.txt-after-worker" })).rejects.toThrow(
			"No parent bash/read result matches verification_tool_call_id on the current branch.",
		)
		expect(h.todos()[0].status).toBe("in_progress")
		expect((await h.run()).details).toMatchObject({ schemaVersion: 1 })
		expect(h.todos()[0].note).toContain("parent read actual-read-id")
	})

	it.each([
		{ isError: true, timestamp: 200 },
		{ isError: false, timestamp: 50 },
	])("does not call an existing failed or stale reference unknown: %j", async (check) => {
		const h = setup()
		appendCheck(h.session, check)
		await expect(h.run({ verification_tool_call_id: "check-1" })).rejects.toThrow(
			"Run a successful parent bash check or read the resulting artifact after this worker finishes.",
		)
		await expect(h.run()).rejects.toThrow(
			"Run a successful parent bash check or read the resulting artifact after this worker finishes.",
		)
		expect(h.todos()[0].status).toBe("in_progress")
	})

	it.each([
		"completed",
		"steered",
	] as const)("rejects a %s worker whose report still has remaining work", async (status) => {
		const h = setup()
		h.record.status = status
		h.record.agentReport = {
			attempt_id: 1,
			status: "partial",
			summary: "Needs integration check",
			steps_completed: [],
			remaining_steps: ["Fix integration"],
			submitted_at: 100,
		}
		appendCheck(h.session)
		await expect(h.run()).rejects.toThrow(
			"The subagent report still contains unfinished work. Resolve it before completing the TODO.",
		)
	})
})
