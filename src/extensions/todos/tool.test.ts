import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { __resetReconciliationBookkeeping } from "./reconciliation.js"
import { __resetTodoStore, GLOBAL_TODO_SCOPE, getTodosForScope, subscribeTodoStore } from "./store.js"
import {
	CONFIRM_TODOS_TOOL_NAME,
	CREATE_TODOS_TOOL_NAME,
	registerTodosTool,
	TODO_TOOL_NAMES,
	UPDATE_TODOS_TOOL_NAME,
} from "./tool.js"

function fakeCtx(sessionId: string): ExtensionContext {
	return {
		hasUI: false,
		cwd: "/test",
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => [],
		},
	} as unknown as ExtensionContext
}

function registeredTools() {
	const registerTool = vi.fn()
	registerTodosTool({ registerTool } as never)
	return Object.fromEntries(registerTool.mock.calls.map(([tool]) => [tool.name, tool]))
}

describe("confirm_todos", () => {
	beforeEach(() => {
		__resetTodoStore()
		__resetReconciliationBookkeeping()
	})

	it("confirms an unchanged plan without writing and records reconciliation", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")
		await tools.add_todo.execute("add-1", { content: "alpha", status: "in_progress" }, undefined, undefined, ctx)
		await tools.add_todo.execute("add-2", { content: "bravo", status: "pending" }, undefined, undefined, ctx)
		const listener = vi.fn()
		const unsubscribe = subscribeTodoStore(listener)

		const result = await tools.confirm_todos.execute(
			"confirm-1",
			{
				inputRevision: 0,
				expected: [
					{ id: 1, status: "in_progress" },
					{ id: 2, status: "pending" },
				],
			},
			undefined,
			undefined,
			ctx,
		)

		expect(result.content).toEqual([
			{ type: "text", text: "Confirmed 2 todos in global match the current plan (input revision 0)." },
		])
		expect(result.details).toMatchObject({ scope: { kind: "global" }, inputRevision: 0 })
		// No synthetic store write: subscribers are not notified.
		expect(listener).not.toHaveBeenCalled()
		unsubscribe()
	})

	it("rejects a stale input revision with the actual state and current revision", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")
		await tools.add_todo.execute("add-1", { content: "alpha", status: "pending" }, undefined, undefined, ctx)

		const result = await tools.confirm_todos.execute(
			"confirm-1",
			{ inputRevision: 3, expected: [{ id: 1, status: "pending" }] },
			undefined,
			undefined,
			ctx,
		)

		expect(result.details).toBeNull()
		expect(result.content[0].text).toContain("accepted input revision is now 0")
		expect(result.content[0].text).toContain("[pending] #1 alpha")
	})

	it("rejects wrong expected sets: missing, extra, duplicate, and mismatched statuses", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")
		await tools.add_todo.execute("add-1", { content: "alpha", status: "pending" }, undefined, undefined, ctx)
		await tools.add_todo.execute("add-2", { content: "bravo", status: "completed" }, undefined, undefined, ctx)

		const wrongStatus = await tools.confirm_todos.execute(
			"confirm-1",
			{
				inputRevision: 0,
				expected: [
					{ id: 1, status: "pending" },
					{ id: 2, status: "in_progress" },
				],
			},
			undefined,
			undefined,
			ctx,
		)
		expect(wrongStatus.details).toBeNull()
		expect(wrongStatus.content[0].text).toContain("status mismatches")
		expect(wrongStatus.content[0].text).toContain("[completed] #2 bravo")

		const missingId = await tools.confirm_todos.execute(
			"confirm-2",
			{ inputRevision: 0, expected: [{ id: 1, status: "pending" }] },
			undefined,
			undefined,
			ctx,
		)
		expect(missingId.content[0].text).toContain("missing id 2")

		const extraId = await tools.confirm_todos.execute(
			"confirm-3",
			{
				inputRevision: 0,
				expected: [
					{ id: 1, status: "pending" },
					{ id: 2, status: "completed" },
					{ id: 3, status: "pending" },
				],
			},
			undefined,
			undefined,
			ctx,
		)
		expect(extraId.content[0].text).toContain("unknown id 3")

		const duplicateId = await tools.confirm_todos.execute(
			"confirm-4",
			{
				inputRevision: 0,
				expected: [
					{ id: 1, status: "pending" },
					{ id: 1, status: "pending" },
					{ id: 2, status: "completed" },
				],
			},
			undefined,
			undefined,
			ctx,
		)
		expect(duplicateId.content[0].text).toContain("duplicate id 1")
	})

	it("confirms an explicit scope outside auto-scope and rejects the ferment phase scope", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")
		await tools.update_todos.execute(
			"u-1",
			{
				scope: { kind: "ferment-step", phaseId: "p", stepId: "s" },
				todos: [{ content: "step task", status: "in_progress" }],
			},
			undefined,
			undefined,
			ctx,
		)

		const ok = await tools.confirm_todos.execute(
			"confirm-1",
			{
				scope: { kind: "ferment-step", phaseId: "p", stepId: "s" },
				inputRevision: 0,
				expected: [{ id: 1, status: "in_progress" }],
			},
			undefined,
			undefined,
			ctx,
		)
		expect(ok.content[0].text).toContain("Confirmed 1 todos in step p/s")

		const phaseScope = await tools.confirm_todos.execute(
			"confirm-2",
			{
				scope: { kind: "ferment", phaseId: "p" },
				inputRevision: 0,
				expected: [],
			},
			undefined,
			undefined,
			ctx,
		)
		expect(phaseScope.content[0].text).toContain("managed by the ferment lifecycle")
	})
})

describe("atomic add/mark mutations", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("preserves both changes from concurrent marks on different ids", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")
		await tools.add_todo.execute("add-1", { content: "alpha" }, undefined, undefined, ctx)
		await tools.add_todo.execute("add-2", { content: "bravo" }, undefined, undefined, ctx)

		const [, second] = await Promise.all([
			tools.mark_todo.execute("m1", { id: 1, status: "completed" }, undefined, undefined, ctx),
			tools.mark_todo.execute("m2", { id: 2, status: "in_progress" }, undefined, undefined, ctx),
		])

		expect(second.content).toEqual([{ type: "text", text: "Marked todo #2 in_progress in global." }])
		const todos = getTodosForScope(GLOBAL_TODO_SCOPE, "session")
		expect(todos.find((todo) => todo.id === 1)?.status).toBe("completed")
		expect(todos.find((todo) => todo.id === 2)?.status).toBe("in_progress")
	})

	it("preserves concurrent adds without dropping items", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")

		const results = await Promise.all([
			tools.add_todo.execute("a1", { content: "alpha" }, undefined, undefined, ctx),
			tools.add_todo.execute("a2", { content: "bravo" }, undefined, undefined, ctx),
			tools.add_todo.execute("a3", { content: "charlie" }, undefined, undefined, ctx),
		])

		expect(results.map((result) => result.content[0]?.type === "text" && result.content[0].text)).toEqual([
			"Added todo #1 in global.",
			"Added todo #2 in global.",
			"Added todo #3 in global.",
		])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").map((todo) => todo.content)).toEqual([
			"alpha",
			"bravo",
			"charlie",
		])
	})

	it("unknown-id and no-op marks do not notify store subscribers", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")
		await tools.add_todo.execute("add-1", { content: "alpha", status: "pending" }, undefined, undefined, ctx)
		const listener = vi.fn()
		const unsubscribe = subscribeTodoStore(listener)

		await tools.mark_todo.execute("m-unknown", { id: 42, status: "completed" }, undefined, undefined, ctx)
		await tools.mark_todo.execute("m-noop", { id: 1, status: "pending" }, undefined, undefined, ctx)

		expect(listener).not.toHaveBeenCalled()
		unsubscribe()
	})
})

describe("todo tools", () => {
	beforeEach(() => {
		__resetTodoStore()
		__resetReconciliationBookkeeping()
	})

	it("registers todo tool aliases plus the confirm_todos check-in tool", () => {
		const registerTool = vi.fn()
		registerTodosTool({ registerTool } as never)

		expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([...TODO_TOOL_NAMES, CONFIRM_TODOS_TOOL_NAME])
		expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
			CREATE_TODOS_TOOL_NAME,
			UPDATE_TODOS_TOOL_NAME,
			"add_todo",
			"mark_todo",
			"clear_todos",
			CONFIRM_TODOS_TOOL_NAME,
		])
	})

	it("returns a structured error when reducer validation fails", async () => {
		const tool = registeredTools()[UPDATE_TODOS_TOOL_NAME]
		const result = await tool.execute(
			"call-1",
			{
				todos: [
					{ id: 1, content: "one", status: "pending" },
					{ id: 1, content: "two", status: "pending" },
				],
			},
			undefined,
			undefined,
			fakeCtx("session"),
		)

		expect(result).toEqual({
			content: [{ type: "text", text: "Failed to write todos: Duplicate todo id '1'" }],
			details: null,
		})
	})

	it("describes update_todos as whole-list replacement for plan changes only", () => {
		const tools = registeredTools()
		const tool = tools[UPDATE_TODOS_TOOL_NAME]

		expect(tool.description).toContain("Replace the entire todo list")
		expect(tool.description).toContain("mark_todo instead")
		expect(tool.description).toContain("add_todo instead")
		// Guards against regressing to the "batch progress updates" wording that
		// invited whole-list rewrites for routine status changes.
		expect(tool.promptSnippet).toBe("Replace the whole todo list when the plan changes")
	})

	it("describes add_todo as the preferred single-item append path", () => {
		const tools = registeredTools()
		const tool = tools.add_todo

		expect(tool.promptSnippet).toBe("Add one todo — prefer over rewriting the list")
		expect(tool.description).toContain("Prefer this over rewriting the whole list")
	})

	it("describes and executes create_todos as the initial planning path", async () => {
		const tools = registeredTools()
		const tool = tools[CREATE_TODOS_TOOL_NAME]

		expect(tool.description).toContain("Create the initial todo list")
		expect(tool.description).toContain("before starting multi-step tasks")
		expect(tool.promptSnippet).toBe("Create the initial todo list before multi-step work")

		const result = await tool.execute(
			"create-1",
			{ todos: [{ content: "inspect trace", status: "in_progress" }] },
			undefined,
			undefined,
			fakeCtx("session"),
		)

		expect(result.content).toEqual([{ type: "text", text: "Updated 1 todos in global." }])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").map((todo) => todo.content)).toEqual(["inspect trace"])
	})

	it("marking an unchanged status is a no-op with a corrective notice", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")

		await tools.add_todo.execute("add-1", { content: "alpha", status: "pending" }, undefined, undefined, ctx)
		const before = getTodosForScope(GLOBAL_TODO_SCOPE, "session")

		const result = await tools.mark_todo.execute("mark-1", { id: 1, status: "pending" }, undefined, undefined, ctx)

		expect(result.content).toEqual([
			{
				type: "text",
				text: "Todo #1 is already 'pending' — no change made. Don't re-mark todos whose status hasn't changed.",
			},
		])
		expect(result.details).toBeNull()
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session")).toEqual(before)
	})

	it("marking the same status with a new note still writes", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")

		await tools.add_todo.execute("add-1", { content: "alpha" }, undefined, undefined, ctx)
		const result = await tools.mark_todo.execute(
			"mark-1",
			{ id: 1, status: "pending", note: "blocked on fixture" },
			undefined,
			undefined,
			ctx,
		)

		expect(result.content).toEqual([{ type: "text", text: "Marked todo #1 pending in global." }])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").find((todo) => todo.id === 1)?.note).toBe(
			"blocked on fixture",
		)
	})

	it("marking an unknown id returns a soft steer, not an error", async () => {
		const tools = registeredTools()
		const result = await tools.mark_todo.execute(
			"mark-1",
			{ id: 42, status: "completed" },
			undefined,
			undefined,
			fakeCtx("session"),
		)

		expect(result.details).toBeNull()
		expect(result.content[0].text).toBe(
			"Todo #42 doesn't exist in global — the list may have been replaced. Check the current ids in the todo list before marking again.",
		)
		expect(result.content[0].text).not.toContain("Failed")
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session")).toEqual([])
	})

	it("adds, marks, and clears todos", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")

		await tools.add_todo.execute("add-1", { content: "alpha" }, undefined, undefined, ctx)
		await tools.add_todo.execute("add-2", { content: "bravo" }, undefined, undefined, ctx)

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").map((todo) => todo.content)).toEqual(["alpha", "bravo"])

		await tools.mark_todo.execute("mark-1", { id: 1, status: "completed" }, undefined, undefined, ctx)
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").find((todo) => todo.id === 1)?.status).toBe("completed")

		const clearResult = await tools.clear_todos.execute("clear-1", {}, undefined, undefined, ctx)
		expect(clearResult.details.todos).toEqual([])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session")).toEqual([])
	})

	it("reports success when a disposed session's leaked listener throws during notification", async () => {
		// Regression test for a session observed in the wild: a state-block
		// persistence listener leaked by a disposed session threw pi-mono's
		// stale-ctx error inside applyWriteTodos AFTER the store was written,
		// and the tool reported "Failed to write todos" — so the model abandoned
		// todo updates for the rest of the session. Listener failures must never
		// be reported as write failures.
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		subscribeTodoStore(() => {
			throw new Error(
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
			)
		})
		try {
			const tools = registeredTools()
			const result = await tools[CREATE_TODOS_TOOL_NAME].execute(
				"create-1",
				{
					todos: [
						{ content: "Checking mothership config for per-resource optimization toggles", status: "in_progress" },
						{ content: "Verify how toggles are exposed", status: "pending" },
						{ content: "Correct ADR-0006 context lines", status: "pending" },
					],
				},
				undefined,
				undefined,
				fakeCtx("session"),
			)

			expect(result.content).toEqual([{ type: "text", text: "Updated 3 todos in global." }])
			expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session")).toHaveLength(3)
		} finally {
			errorSpy.mockRestore()
		}
	})

	it("writes through to the session id reported by ctx.sessionManager", async () => {
		const tools = registeredTools()
		const ctxA = fakeCtx("session-a")
		const ctxB = fakeCtx("session-b")

		await tools.update_todos.execute(
			"u-a",
			{ todos: [{ content: "alpha", status: "in_progress" }] },
			undefined,
			undefined,
			ctxA,
		)
		await tools.update_todos.execute(
			"u-b",
			{ todos: [{ content: "beta", status: "pending" }] },
			undefined,
			undefined,
			ctxB,
		)

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-a").map((todo) => todo.content)).toEqual(["alpha"])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-b").map((todo) => todo.content)).toEqual(["beta"])
	})
})
