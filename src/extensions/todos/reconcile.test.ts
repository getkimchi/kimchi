import type { AssistantMessage } from "@earendil-works/pi-ai"
import { completeSimple } from "@earendil-works/pi-ai/compat"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { createModel, createModelRegistry } from "../__mocks__/model-registry.js"
import { FERMENT_V2_CUSTOM_ENTRY_TYPE } from "../ferment-v2/constants.js"
import { clearFermentV2Entry, createFermentV2, putFermentV2Entry } from "../ferment-v2/reducer.js"
import { TODO_CUSTOM_ENTRY_TYPE } from "./constants.js"
import { registerTodoReconciliation } from "./reconcile.js"
import { getWriteTodosDetails } from "./session.js"
import {
	__resetTodoStore,
	applyWriteTodos,
	GLOBAL_TODO_SCOPE,
	getTodosForScope,
	registerActiveTodoScopeProvider,
	restoreTodoStoreFromDetails,
} from "./store.js"

vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: vi.fn() }))
vi.mock("../pii-redaction/config.js", () => ({ getRedactionConfig: () => ({ enabled: false }) }))

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "fake",
		model: "basic",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	}
}

function harness() {
	const api = createExtensionApi()
	const ctx = createContext()
	const manager = SessionManager.inMemory("/tmp")
	Object.assign(ctx, {
		sessionManager: manager,
		model: createModel("basic"),
		modelRegistry: createModelRegistry(),
		isIdle: () => true,
		hasPendingMessages: () => false,
	})
	api.appendEntry.mockImplementation((type, data) => {
		manager.appendCustomEntry(type, data)
	})
	registerTodoReconciliation(api.api)
	const sessionId = manager.getSessionId()
	manager.appendMessage({
		role: "user",
		content: "Read inputs and compare the results. Defer publishing.",
		timestamp: 1,
	})
	const evidenceId = manager.appendMessage({
		role: "toolResult",
		toolCallId: "read",
		toolName: "read",
		content: [{ type: "text", text: "Input A: 2. Input B: 3." }],
		isError: false,
		timestamp: 2,
	})
	const final = assistant("Comparison: B exceeds A by 1. Publishing is deferred.")
	manager.appendMessage(final)
	applyWriteTodos(
		{
			todos: [
				{ id: 1, content: "Read inputs", status: "in_progress", activeForm: "Reading inputs" },
				{ id: 2, content: "Compare inputs", status: "completed" },
				{ id: 3, content: "Publish results", status: "pending", note: "Deferred by user" },
				{ id: 4, content: "Get approval", status: "blocked" },
			],
		},
		sessionId,
	)
	const fire = async (event: string, payload: unknown = {}) => {
		for (const handler of api.getHandlers(event)) await handler(payload, ctx)
	}
	const end = () => fire("agent_end", { type: "agent_end", messages: [final] })
	const settle = () => fire("agent_settled")
	const result = (completed = [{ id: 1, evidence: [evidenceId] }]) =>
		assistant(
			JSON.stringify({
				updates: completed.map((item) => ({ ...item, status: "completed", reason: "Input verified" })),
			}),
		)
	vi.mocked(completeSimple).mockResolvedValue(result())
	return {
		...api,
		ctx,
		manager,
		sessionId,
		fire,
		end,
		settle,
		result,
		todos: () => getTodosForScope(GLOBAL_TODO_SCOPE, sessionId),
	}
}

describe("settled todo reconciliation", () => {
	beforeEach(() => {
		__resetTodoStore()
		vi.clearAllMocks()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("closes the evidenced forgotten item, persists it for resume, and never resumes the main agent", async () => {
		const h = harness()
		await h.end()
		expect(completeSimple).not.toHaveBeenCalled()
		await h.settle()
		expect(h.todos().map((todo) => todo.status)).toEqual(["completed", "completed", "pending", "blocked"])
		expect(h.todos()[0].activeForm).toBe("Reading inputs")
		expect(h.todos()[2].note).toBe("Deferred by user")
		expect(h.sendMessage).not.toHaveBeenCalled()
		expect(h.appendEntry).toHaveBeenCalledWith(
			"todo-reconciliation",
			expect.objectContaining({ usage: expect.objectContaining({ totalTokens: 15 }) }),
		)
		const writes = h.manager.getBranch().flatMap((entry) => {
			const details = getWriteTodosDetails(entry)
			return details ? [details] : []
		})
		restoreTodoStoreFromDetails(writes, h.sessionId)
		expect(h.todos().map((todo) => todo.status)).toEqual(["completed", "completed", "pending", "blocked"])
		await h.settle()
		expect(completeSimple).toHaveBeenCalledTimes(1)
	})

	it.each([
		"new input",
		"new run",
		"tree switch",
		"shutdown",
		"clear",
		"replace",
		"branch change",
	])("discards a late result after %s", async (change) => {
		const h = harness()
		let finish!: (message: AssistantMessage) => void
		vi.mocked(completeSimple).mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve
				}),
		)
		await h.end()
		const settling = h.settle()
		await vi.waitFor(() => expect(completeSimple).toHaveBeenCalled())
		if (change === "clear") applyWriteTodos({ todos: [] }, h.sessionId)
		else if (change === "replace")
			applyWriteTodos({ todos: [{ id: 1, content: "Different task", status: "pending" }] }, h.sessionId)
		else if (change === "branch change")
			h.manager.appendMessage({ role: "user", content: "Actually wait", timestamp: 3 })
		else
			await h.fire(
				{ "new input": "input", "new run": "agent_start", "tree switch": "session_tree", shutdown: "session_shutdown" }[
					change
				] ?? "input",
			)
		finish(h.result())
		await settling
		expect(h.appendEntry).not.toHaveBeenCalled()
		expect(h.todos().some((todo) => todo.id === 1 && todo.status === "completed")).toBe(false)
	})

	it.each([
		"unknown entry",
		"user claim",
		"blocked item",
		"unknown todo",
	])("rejects %s as completion evidence", async (kind) => {
		const h = harness()
		const parsed = JSON.parse(
			h
				.result()
				.content.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join(""),
		)
		const item = parsed.updates[0]
		if (kind === "unknown entry") item.evidence[0] = "missing"
		if (kind === "user claim") {
			item.evidence[0] = h.manager.getBranch()[0].id
		}
		if (kind === "blocked item") item.id = 4
		if (kind === "unknown todo") item.id = 999
		vi.mocked(completeSimple).mockResolvedValue(assistant(JSON.stringify(parsed)))
		await h.end()
		await h.settle()
		expect(h.todos()[0].status).toBe("in_progress")
		expect(h.appendEntry).not.toHaveBeenCalledWith(TODO_CUSTOM_ENTRY_TYPE, expect.anything())
	})

	it.each([
		"invalid JSON",
		"invalid schema",
		"provider error",
		"truncated",
		"no auth",
		"no model",
	])("preserves all items on %s", async (failure) => {
		const h = harness()
		if (failure === "invalid JSON") vi.mocked(completeSimple).mockResolvedValue(assistant("not json"))
		if (failure === "invalid schema") vi.mocked(completeSimple).mockResolvedValue(assistant('{"completed":[1]}'))
		if (failure === "provider error") vi.mocked(completeSimple).mockRejectedValue(new Error("offline"))
		if (failure === "truncated") vi.mocked(completeSimple).mockResolvedValue({ ...h.result(), stopReason: "length" })
		if (failure === "no auth")
			vi.mocked(h.ctx.modelRegistry.getApiKeyAndHeaders).mockResolvedValue({ ok: false, error: "missing" })
		if (failure === "no model") h.ctx.model = undefined
		const before = h.todos()
		await h.end()
		await h.settle()
		expect(h.todos()).toBe(before)
		expect(h.sendMessage).not.toHaveBeenCalled()
	})

	it("retains superseded work as cancelled with its reason and supports replay", async () => {
		const h = harness()
		const result = JSON.parse(
			h
				.result()
				.content.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join(""),
		)
		result.updates[0].status = "cancelled"
		result.updates[0].reason = "Replaced by the requested automatic model run"
		vi.mocked(completeSimple).mockResolvedValue(assistant(JSON.stringify(result)))
		await h.end()
		await h.settle()
		expect(h.todos()[0]).toMatchObject({
			id: 1,
			content: "Read inputs",
			status: "cancelled",
			note: "Replaced by the requested automatic model run",
		})
		const details = h.manager.getBranch().flatMap((entry) => {
			const value = getWriteTodosDetails(entry)
			return value ? [value] : []
		})
		restoreTodoStoreFromDetails(details, h.sessionId)
		expect(h.todos()[0].status).toBe("cancelled")
	})

	it("does not change the store when the journal write fails", async () => {
		const h = harness()
		h.appendEntry.mockImplementation((type, data) => {
			if (type === TODO_CUSTOM_ENTRY_TYPE) throw new Error("disk full")
			h.manager.appendCustomEntry(type, data)
		})
		await h.end()
		await h.settle()
		expect(h.todos()[0].status).toBe("in_progress")
	})

	it("rejects a failed tool result as the only proof", async () => {
		const h = harness()
		const id = h.manager.appendMessage({
			role: "toolResult",
			toolCallId: "failure",
			toolName: "bash",
			content: [{ type: "text", text: "Permission denied" }],
			isError: true,
			timestamp: 10,
		})
		vi.mocked(completeSimple).mockResolvedValue(h.result([{ id: 1, evidence: [id] }]))
		await h.end()
		await h.settle()
		expect(h.todos()[0].status).toBe("in_progress")
	})

	it("ignores unrelated journal writes during reconciliation", async () => {
		const h = harness()
		vi.mocked(completeSimple).mockImplementation(async () => {
			h.manager.appendCustomEntry("prompt-summary", { duration: 1 })
			return h.result()
		})
		await h.end()
		await h.settle()
		expect(h.todos()[0].status).toBe("completed")
	})

	it("cannot cite an earlier request to complete a repeated task", async () => {
		const h = harness()
		h.manager.appendMessage({ role: "user", content: "Verify the input again", timestamp: 5 })
		h.manager.appendMessage(assistant("I have not verified the new input yet."))
		await h.end()
		await h.settle()
		expect(h.todos()[0].status).toBe("in_progress")
	})

	it("makes no request for an empty or completed list", async () => {
		const h = harness()
		applyWriteTodos({ todos: [] }, h.sessionId)
		await h.end()
		await h.settle()
		applyWriteTodos({ todos: [{ content: "finished", status: "completed" }] }, h.sessionId)
		await h.end()
		await h.settle()
		expect(completeSimple).not.toHaveBeenCalled()
	})

	it("bounds even stalled authentication and ignores its late completion", async () => {
		vi.useFakeTimers()
		const h = harness()
		vi.mocked(h.ctx.modelRegistry.getApiKeyAndHeaders).mockImplementation(() => new Promise(() => {}))
		await h.end()
		const settling = h.settle()
		await vi.advanceTimersByTimeAsync(30_000)
		await settling
		expect(h.todos()[0].status).toBe("in_progress")
		expect(completeSimple).not.toHaveBeenCalled()
	})

	it("leaves the global list to Ferment V2 until its journal is cleared", async () => {
		const h = harness()
		const run = createFermentV2(undefined, "Read inputs", "run", new Date().toISOString())
		h.manager.appendCustomEntry(FERMENT_V2_CUSTOM_ENTRY_TYPE, putFermentV2Entry(run))
		await h.end()
		await h.settle()
		expect(completeSimple).not.toHaveBeenCalled()
		h.manager.appendCustomEntry(FERMENT_V2_CUSTOM_ENTRY_TYPE, clearFermentV2Entry(run, new Date().toISOString()))
		await h.end()
		await h.settle()
		expect(h.todos()[0].status).toBe("completed")
	})

	it("skips aborted runs, queued input, and Ferment scopes", async () => {
		const h = harness()
		await h.fire("agent_end", { messages: [{ ...assistant("Interrupted"), stopReason: "aborted" }] })
		await h.settle()
		await h.end()
		h.ctx.hasPendingMessages = () => true
		await h.settle()
		h.ctx.hasPendingMessages = () => false
		const unregister = registerActiveTodoScopeProvider(() => ({ kind: "ferment-step", phaseId: "p", stepId: "s" }))
		await h.end()
		await h.settle()
		unregister()
		expect(completeSimple).not.toHaveBeenCalled()
	})
})
