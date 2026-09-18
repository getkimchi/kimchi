import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { __resetTodoStore, GLOBAL_TODO_SCOPE, getTodosForScope, subscribeTodoStore } from "./store.js"
import { registerTodosTool, TODO_TOOL_NAMES, TODOS_TOOL_NAME } from "./tool.js"

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

function registeredTool() {
	const registerTool = vi.fn()
	registerTodosTool({ registerTool } as never)
	return registerTool.mock.calls[0][0]
}

describe("todos tool", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("registers exactly the consolidated action tool", () => {
		const registerTool = vi.fn()
		registerTodosTool({ registerTool } as never)

		expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([...TODO_TOOL_NAMES])
		expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([TODOS_TOOL_NAME])
	})

	it("describes all five actions and the pairing rule", () => {
		const tool = registeredTool()

		for (const action of ["create", "update", "add", "mark", "clear"]) {
			expect(tool.description).toContain(`'${action}'`)
		}
		expect(tool.description).toContain("pair a todos call with the next work tool call in the same turn")
		expect(tool.promptSnippet).toBe("manage the session todo list (create/update/add/mark/clear)")
	})

	it("returns a structured error when reducer validation fails", async () => {
		const tool = registeredTool()
		const result = await tool.execute(
			"call-1",
			{
				action: "update",
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

	it("create/update require the todos array", async () => {
		const tool = registeredTool()
		const result = await tool.execute("c-1", { action: "create" }, undefined, undefined, fakeCtx("session"))
		expect(result.content[0].text).toContain("requires the `todos` array")
		expect(result.details).toBeNull()
	})

	it("add requires content", async () => {
		const tool = registeredTool()
		const result = await tool.execute("a-1", { action: "add" }, undefined, undefined, fakeCtx("session"))
		expect(result.content[0].text).toContain("requires `content`")
	})

	it("mark requires id and status", async () => {
		const tool = registeredTool()
		const ctx = fakeCtx("session")
		const noId = await tool.execute("m-1", { action: "mark", status: "completed" }, undefined, undefined, ctx)
		expect(noId.content[0].text).toContain("requires `id`")
		const noStatus = await tool.execute("m-2", { action: "mark", id: 1 }, undefined, undefined, ctx)
		expect(noStatus.content[0].text).toContain("requires `status`")
	})

	it("unknown action is a soft error", async () => {
		const tool = registeredTool()
		const result = await tool.execute("x-1", { action: "nope" }, undefined, undefined, fakeCtx("session"))
		expect(result.content[0].text).toContain("Unknown todos action")
	})

	it("executes create as the initial planning path", async () => {
		const tool = registeredTool()

		const result = await tool.execute(
			"create-1",
			{ action: "create", todos: [{ content: "inspect trace", status: "in_progress" }] },
			undefined,
			undefined,
			fakeCtx("session"),
		)

		expect(result.content).toEqual([{ type: "text", text: "Updated 1 todos in global." }])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").map((todo) => todo.content)).toEqual(["inspect trace"])
	})

	it("marking an unchanged status is a no-op with a corrective notice", async () => {
		const tool = registeredTool()
		const ctx = fakeCtx("session")

		await tool.execute("add-1", { action: "add", content: "alpha", status: "pending" }, undefined, undefined, ctx)
		const before = getTodosForScope(GLOBAL_TODO_SCOPE, "session")

		const result = await tool.execute("mark-1", { action: "mark", id: 1, status: "pending" }, undefined, undefined, ctx)

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
		const tool = registeredTool()
		const ctx = fakeCtx("session")

		await tool.execute("add-1", { action: "add", content: "alpha" }, undefined, undefined, ctx)
		const result = await tool.execute(
			"mark-1",
			{ action: "mark", id: 1, status: "pending", note: "blocked on fixture" },
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
		const tool = registeredTool()
		const result = await tool.execute(
			"mark-1",
			{ action: "mark", id: 42, status: "completed" },
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
		const tool = registeredTool()
		const ctx = fakeCtx("session")

		await tool.execute("add-1", { action: "add", content: "alpha" }, undefined, undefined, ctx)
		await tool.execute("add-2", { action: "add", content: "bravo" }, undefined, undefined, ctx)

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").map((todo) => todo.content)).toEqual(["alpha", "bravo"])

		await tool.execute("mark-1", { action: "mark", id: 1, status: "completed" }, undefined, undefined, ctx)
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").find((todo) => todo.id === 1)?.status).toBe("completed")

		const clearResult = await tool.execute("clear-1", { action: "clear" }, undefined, undefined, ctx)
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
			const tool = registeredTool()
			const result = await tool.execute(
				"create-1",
				{
					action: "create",
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
		const tool = registeredTool()
		const ctxA = fakeCtx("session-a")
		const ctxB = fakeCtx("session-b")

		await tool.execute(
			"u-a",
			{ action: "update", todos: [{ content: "alpha", status: "in_progress" }] },
			undefined,
			undefined,
			ctxA,
		)
		await tool.execute(
			"u-b",
			{ action: "update", todos: [{ content: "beta", status: "pending" }] },
			undefined,
			undefined,
			ctxB,
		)

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-a").map((todo) => todo.content)).toEqual(["alpha"])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-b").map((todo) => todo.content)).toEqual(["beta"])
	})
})
