import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	__resetReconciliationBookkeeping,
	recordAdmittedInputRevision,
	takeAdmittedInputRevision,
} from "./reconciliation.js"
import { __resetTodoStore, GLOBAL_TODO_SCOPE, getTodosForScope, subscribeTodoStore } from "./store.js"
import { isTodoConfirmInput, isTodoConfirmResult, registerTodosTool, TODO_TOOL_NAMES, TODOS_TOOL_NAME } from "./tool.js"

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

const RETIRED_TODO_VERBS = [
	"create_todos",
	"update_todos",
	"add_todo",
	"mark_todo",
	"clear_todos",
	"write_todos",
	"confirm_todos",
]

describe("todos tool registration", () => {
	it("registers exactly the one todos tool — confirm_todos is gone too", () => {
		const registerTool = vi.fn()
		registerTodosTool({ registerTool } as never)

		expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([TODOS_TOOL_NAME])
		expect([...TODO_TOOL_NAMES]).toEqual([TODOS_TOOL_NAME])
	})

	it("describes the edit / full-list / confirm contract without naming retired verbs", () => {
		const tool = registeredTools()[TODOS_TOOL_NAME]

		expect(tool.description).toContain("`update`")
		expect(tool.description).toContain("`add`")
		expect(tool.description).toContain("`remove`")
		expect(tool.description).toContain("`todos`")
		expect(tool.description).toContain("`confirm`")
		expect(tool.description).toContain("omitted items are deleted")

		for (const retired of RETIRED_TODO_VERBS) {
			expect(tool.description).not.toContain(retired)
			expect(tool.promptSnippet).not.toContain(retired)
		}
	})
})

describe("todos full-list mode", () => {
	beforeEach(() => {
		__resetTodoStore()
		__resetReconciliationBookkeeping()
	})

	it("runs the whole lifecycle through one write: create, flip, append, clear", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")

		const created = await tools.todos.execute(
			"w-1",
			{
				todos: [
					{ content: "alpha", status: "in_progress" },
					{ content: "bravo", status: "pending" },
				],
			},
			undefined,
			undefined,
			ctx,
		)
		expect(created.content).toEqual([{ type: "text", text: "Updated 2 todos in global." }])

		await tools.todos.execute(
			"w-2",
			{
				todos: [
					{ id: 1, content: "alpha", status: "completed" },
					{ id: 2, content: "bravo", status: "in_progress" },
					{ content: "charlie", status: "pending" },
				],
			},
			undefined,
			undefined,
			ctx,
		)
		const afterFlip = getTodosForScope(GLOBAL_TODO_SCOPE, "session")
		expect(afterFlip.map((todo) => todo.id)).toEqual([1, 2, 3])
		expect(afterFlip.find((todo) => todo.id === 1)?.status).toBe("completed")
		expect(afterFlip.find((todo) => todo.id === 2)?.status).toBe("in_progress")
		expect(afterFlip.find((todo) => todo.id === 3)?.content).toBe("charlie")

		const cleared = await tools.todos.execute("w-3", { todos: [] }, undefined, undefined, ctx)
		expect(cleared.content).toEqual([{ type: "text", text: "Cleared todos in global." }])
		expect(cleared.details.todos).toEqual([])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session")).toEqual([])
	})

	it("names items a rewrite drops — an omitted item is a deletion and gets said", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")
		await tools.todos.execute(
			"w-1",
			{
				todos: [
					{ content: "alpha", status: "pending" },
					{ content: "bravo", status: "pending" },
				],
			},
			undefined,
			undefined,
			ctx,
		)

		const result = await tools.todos.execute(
			"w-2",
			{ todos: [{ id: 1, content: "alpha", status: "pending" }] },
			undefined,
			undefined,
			ctx,
		)

		expect(result.content[0].text).toBe('Updated 1 todos in global. Removed: #2 "bravo".')
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session")).toHaveLength(1)
	})

	it("rewriting the list unchanged is a no-op that does not notify subscribers", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")
		await tools.todos.execute(
			"w-1",
			{
				todos: [
					{ content: "alpha", status: "pending", note: "note" },
					{ content: "bravo", status: "in_progress", activeForm: "doing bravo" },
				],
			},
			undefined,
			undefined,
			ctx,
		)
		const before = getTodosForScope(GLOBAL_TODO_SCOPE, "session")
		const listener = vi.fn()
		const unsubscribe = subscribeTodoStore(listener)

		const result = await tools.todos.execute(
			"w-2",
			{
				// Same ids, content, statuses, and optional fields — nothing changes.
				todos: [
					{ id: 2, content: "  bravo  ", status: "in_progress", activeForm: "doing bravo" },
					{ id: 1, content: "alpha", status: "pending", note: "note" },
				],
			},
			undefined,
			undefined,
			ctx,
		)

		expect(result.details).toBeNull()
		expect(result.content[0].text).toContain("already matches — no change made")
		expect(result.content[0].text).toContain("{confirm")
		expect(listener).not.toHaveBeenCalled()
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session")).toEqual(before)
		unsubscribe()
	})

	it("merges back invisible fields on id-matched rewrites: activeForm, note, _syncKey survive status flips", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")
		await tools.todos.execute(
			"w-1",
			{
				todos: [
					{
						content: "alpha",
						status: "in_progress",
						activeForm: "doing alpha",
						note: "first note",
						_syncKey: "anchor",
					},
					{ content: "bravo", status: "pending", note: "second note" },
				],
			},
			undefined,
			undefined,
			ctx,
		)

		await tools.todos.execute(
			"w-2",
			{
				// Routine flip: statuses change, invisible fields omitted.
				todos: [
					{ id: 1, content: "alpha", status: "completed" },
					{ id: 2, content: "bravo", status: "in_progress" },
				],
			},
			undefined,
			undefined,
			ctx,
		)

		const after = getTodosForScope(GLOBAL_TODO_SCOPE, "session")
		expect(after.find((todo) => todo.id === 1)).toMatchObject({
			status: "completed",
			activeForm: "doing alpha",
			note: "first note",
			_syncKey: "anchor",
		})
		expect(after.find((todo) => todo.id === 2)).toMatchObject({ status: "in_progress", note: "second note" })

		// An explicitly supplied value (including "") replaces the stored one.
		await tools.todos.execute(
			"w-3",
			{
				todos: [
					{ id: 1, content: "alpha", status: "completed", note: "" },
					{ id: 2, content: "bravo", status: "in_progress" },
				],
			},
			undefined,
			undefined,
			ctx,
		)
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").find((todo) => todo.id === 1)?.note).toBeUndefined()
	})

	it("a verbatim rewrite that omits ids is a no-op, not an id-churning write", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")
		await tools.todos.execute(
			"w-1",
			{
				todos: [
					{ content: "alpha", status: "in_progress", note: "keep me" },
					{ content: "bravo", status: "pending" },
				],
			},
			undefined,
			undefined,
			ctx,
		)
		const before = getTodosForScope(GLOBAL_TODO_SCOPE, "session")

		// The model re-sends the same list it sees: same order, same content and
		// statuses, ids and note omitted (it cannot see them).
		const result = await tools.todos.execute(
			"w-2",
			{
				todos: [
					{ content: "alpha", status: "in_progress" },
					{ content: "bravo", status: "pending" },
				],
			},
			undefined,
			undefined,
			ctx,
		)

		expect(result.details).toBeNull()
		expect(result.content[0].text).toContain("already matches — no change made")
		// Ids and the invisible note survive exactly.
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session")).toEqual(before)
	})

	it("a no-op rewrite consumes the admitted input revision bookkeeping", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")
		await tools.todos.execute("w-1", { todos: [{ content: "alpha", status: "pending" }] }, undefined, undefined, ctx)
		recordAdmittedInputRevision("session", "w-2", 7)

		const result = await tools.todos.execute(
			"w-2",
			{ todos: [{ id: 1, content: "alpha", status: "pending" }] },
			undefined,
			undefined,
			ctx,
		)

		expect(result.details).toBeNull()
		expect(takeAdmittedInputRevision("session", "w-2")).toBeUndefined()
	})

	it("returns a structured error when reducer validation fails", async () => {
		const tool = registeredTools()[TODOS_TOOL_NAME]
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
			const result = await tools[TODOS_TOOL_NAME].execute(
				"w-1",
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

		await tools.todos.execute(
			"w-a",
			{ todos: [{ content: "alpha", status: "in_progress" }] },
			undefined,
			undefined,
			ctxA,
		)
		await tools.todos.execute("w-b", { todos: [{ content: "beta", status: "pending" }] }, undefined, undefined, ctxB)

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-a").map((todo) => todo.content)).toEqual(["alpha"])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-b").map((todo) => todo.content)).toEqual(["beta"])
	})
})

describe("todos edit mode (update/add/remove)", () => {
	beforeEach(() => {
		__resetTodoStore()
		__resetReconciliationBookkeeping()
	})

	async function seed(ctx: ExtensionContext) {
		const tools = registeredTools()
		await tools.todos.execute(
			"seed",
			{
				todos: [
					{ content: "alpha", status: "in_progress", activeForm: "doing alpha", note: "a", _syncKey: "anchor" },
					{ content: "bravo", status: "pending" },
					{ content: "charlie", status: "pending" },
				],
			},
			undefined,
			undefined,
			ctx,
		)
		return tools
	}

	it("update re-statuses one item cheaply and leaves everything else, including invisible fields, intact", async () => {
		const ctx = fakeCtx("session")
		const tools = await seed(ctx)

		const result = await tools.todos.execute(
			"e-1",
			{
				update: [
					{ id: 1, status: "completed" },
					{ id: 2, status: "in_progress" },
				],
			},
			undefined,
			undefined,
			ctx,
		)

		expect(result.content[0].text).toBe("Applied todo edits in global: updated #1, #2.")
		const after = getTodosForScope(GLOBAL_TODO_SCOPE, "session")
		expect(after).toHaveLength(3)
		expect(after.find((todo) => todo.id === 1)).toMatchObject({
			status: "completed",
			activeForm: "doing alpha",
			note: "a",
			_syncKey: "anchor",
		})
		expect(after.find((todo) => todo.id === 2)?.status).toBe("in_progress")
		expect(after.find((todo) => todo.id === 3)?.status).toBe("pending")
	})

	it("add and remove compose with update in one call; adds get fresh ids", async () => {
		const ctx = fakeCtx("session")
		const tools = await seed(ctx)

		const result = await tools.todos.execute(
			"e-1",
			{
				remove: [3],
				update: [{ id: 1, status: "completed" }],
				add: [{ content: "delta", status: "in_progress" }],
			},
			undefined,
			undefined,
			ctx,
		)

		expect(result.content[0].text).toBe("Applied todo edits in global: removed #3, updated #1, added 1 item(s).")
		const after = getTodosForScope(GLOBAL_TODO_SCOPE, "session")
		expect(after.map((todo) => todo.id)).toEqual([1, 2, 4])
		expect(after.find((todo) => todo.id === 4)).toMatchObject({ content: "delta", status: "in_progress" })
		expect(after.find((todo) => todo.id === 1)?.status).toBe("completed")
	})

	it("an unknown id rejects the whole call with the current list; nothing is halfway applied", async () => {
		const ctx = fakeCtx("session")
		const tools = await seed(ctx)
		const before = getTodosForScope(GLOBAL_TODO_SCOPE, "session")

		const result = await tools.todos.execute(
			"e-1",
			{
				update: [
					{ id: 1, status: "completed" },
					{ id: 9, status: "completed" },
				],
			},
			undefined,
			undefined,
			ctx,
		)

		expect(result.details).toBeNull()
		expect(result.content[0].text).toContain("Unknown todo id(s): 9")
		expect(result.content[0].text).toContain("Current ids: #1, #2, #3")
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session")).toEqual(before)
	})

	it("two sequential edit calls in one turn both land", async () => {
		const ctx = fakeCtx("session")
		const tools = await seed(ctx)

		await tools.todos.execute("e-1", { update: [{ id: 1, status: "completed" }] }, undefined, undefined, ctx)
		await tools.todos.execute("e-2", { add: [{ content: "delta", status: "pending" }] }, undefined, undefined, ctx)

		const after = getTodosForScope(GLOBAL_TODO_SCOPE, "session")
		expect(after.find((todo) => todo.id === 1)?.status).toBe("completed")
		expect(after.map((todo) => todo.id)).toEqual([1, 2, 3, 4])
	})

	it("an edit that changes nothing is a no-op without a store write", async () => {
		const ctx = fakeCtx("session")
		const tools = await seed(ctx)
		const listener = vi.fn()
		const unsubscribe = subscribeTodoStore(listener)
		recordAdmittedInputRevision("session", "e-1", 3)

		const result = await tools.todos.execute(
			"e-1",
			{ update: [{ id: 1, status: "in_progress" }] },
			undefined,
			undefined,
			ctx,
		)

		expect(result.details).toBeNull()
		expect(result.content[0].text).toContain("already matches")
		expect(listener).not.toHaveBeenCalled()
		expect(takeAdmittedInputRevision("session", "e-1")).toBeUndefined()
		unsubscribe()
	})

	it("update without status edits content; explicit empty clears note and activeForm", async () => {
		const ctx = fakeCtx("session")
		const tools = await seed(ctx)

		await tools.todos.execute(
			"e-1",
			{ update: [{ id: 1, content: "renamed", note: "", activeForm: "" }] },
			undefined,
			undefined,
			ctx,
		)

		const renamed = getTodosForScope(GLOBAL_TODO_SCOPE, "session").find((todo) => todo.id === 1)
		expect(renamed?.content).toBe("renamed")
		expect(renamed?.note).toBeUndefined()
		expect(renamed?.activeForm).toBeUndefined()
	})

	it("rejects add and update with empty or whitespace-only content — nothing applied", async () => {
		const ctx = fakeCtx("session")
		const tools = await seed(ctx)
		const before = getTodosForScope(GLOBAL_TODO_SCOPE, "session")

		const badAdd = await tools.todos.execute("e-1", { add: [{ content: "  " }] }, undefined, undefined, ctx)
		expect(badAdd.details).toBeNull()
		expect(badAdd.content[0].text).toContain("1 add(s) with empty content")

		const badEdit = await tools.todos.execute("e-2", { update: [{ id: 2, content: "" }] }, undefined, undefined, ctx)
		expect(badEdit.details).toBeNull()
		expect(badEdit.content[0].text).toContain("update(s) with empty content: #2")

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session")).toEqual(before)
	})

	it("a mixed id/id-less rewrite that would actually drop an item is not judged a no-op", async () => {
		// Two stored duplicates, same content: an id-bearing draft plus a
		// positional draft must not both match the SAME stored item — the
		// real write drops one duplicate and recreates it under a fresh id.
		const tools = registeredTools()
		const ctx = fakeCtx("session")
		await tools.todos.execute(
			"w-1",
			{
				todos: [
					{ content: "same", status: "pending" },
					{ content: "same", status: "pending" },
				],
			},
			undefined,
			undefined,
			ctx,
		)

		const result = await tools.todos.execute(
			"w-2",
			{
				todos: [
					{ id: 2, content: "same", status: "pending" },
					{ content: "same", status: "pending" },
				],
			},
			undefined,
			undefined,
			ctx,
		)

		expect(result.details).not.toBeNull()
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").map((todo) => todo.id)).toEqual([2, 3])
	})
})

describe("confirm-shape discriminators", () => {
	it("isTodoConfirmInput: confirm with empty edit arrays is still confirm-shaped", () => {
		expect(isTodoConfirmInput({ confirm: 0 })).toBe(true)
		expect(isTodoConfirmInput({ confirm: 0, scope: { kind: "global" }, remove: [], update: [] })).toBe(true)
		expect(isTodoConfirmInput({ confirm: 0, remove: [1] })).toBe(false)
		expect(isTodoConfirmInput({ todos: [] })).toBe(false)
	})

	it("isTodoConfirmResult keys on the details marker", () => {
		expect(isTodoConfirmResult({ confirm: true })).toBe(true)
		expect(isTodoConfirmResult({ confirm: false })).toBe(false)
		expect(isTodoConfirmResult(null)).toBe(false)
	})
})

describe("todos mode validation", () => {
	beforeEach(() => {
		__resetTodoStore()
		__resetReconciliationBookkeeping()
	})

	for (const args of [
		{},
		{ todos: [{ content: "x", status: "pending" }], update: [{ id: 1, content: "x" }] },
		{ confirm: 0, add: [{ content: "x" }] },
	]) {
		it(`rejects ambiguous or empty calls: ${JSON.stringify(args).slice(0, 60)}`, async () => {
			const tools = registeredTools()
			const result = await tools.todos.execute("e-1", args, undefined, undefined, fakeCtx("session"))

			expect(result.details).toBeNull()
			expect(result.content[0].text).toContain("Pass exactly one mode")
		})
	}
})

describe("todos confirm mode (the check-in path)", () => {
	beforeEach(() => {
		__resetTodoStore()
		__resetReconciliationBookkeeping()
	})

	it("confirms an unchanged plan without writing and records reconciliation", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")
		await tools.todos.execute(
			"w-1",
			{
				todos: [
					{ content: "alpha", status: "in_progress" },
					{ content: "bravo", status: "pending" },
				],
			},
			undefined,
			undefined,
			ctx,
		)
		const listener = vi.fn()
		const unsubscribe = subscribeTodoStore(listener)

		const result = await tools.todos.execute("confirm-1", { confirm: 0 }, undefined, undefined, ctx)

		expect(result.content).toEqual([
			{ type: "text", text: "Confirmed 2 todos in global match the current plan (input revision 0)." },
		])
		expect(result.details).toMatchObject({ scope: { kind: "global" }, inputRevision: 0, confirm: true })
		// No synthetic store write: subscribers are not notified.
		expect(listener).not.toHaveBeenCalled()
		unsubscribe()
	})

	it("rejects a stale input revision with the actual state and current revision", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")
		await tools.todos.execute("w-1", { todos: [{ content: "alpha", status: "pending" }] }, undefined, undefined, ctx)

		const result = await tools.todos.execute("confirm-1", { confirm: 3 }, undefined, undefined, ctx)

		// A failed confirm still carries the marker detail: the gate must
		// count it as "neither write nor work", like a successful one.
		expect(result.details).toMatchObject({ confirm: true, failed: true })
		expect(result.content[0].text).toContain("accepted input revision is now 0")
		expect(result.content[0].text).toContain("[pending] #1 alpha")
	})

	it("rejects non-integer or negative confirm revisions as malformed", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")
		await tools.todos.execute("w-1", { todos: [{ content: "alpha", status: "pending" }] }, undefined, undefined, ctx)

		for (const bad of [-1, 1.5]) {
			const result = await tools.todos.execute(`confirm-${bad}`, { confirm: bad }, undefined, undefined, ctx)
			expect(result.details).toMatchObject({ confirm: true, failed: true })
			expect(result.content[0].text).toContain("non-negative integer")
		}
	})

	it("confirms an explicit scope outside auto-scope and rejects the ferment phase scope", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")
		await tools.todos.execute(
			"w-1",
			{
				scope: { kind: "ferment-step", phaseId: "p", stepId: "s" },
				todos: [{ content: "step task", status: "in_progress" }],
			},
			undefined,
			undefined,
			ctx,
		)

		const ok = await tools.todos.execute(
			"confirm-1",
			{ scope: { kind: "ferment-step", phaseId: "p", stepId: "s" }, confirm: 0 },
			undefined,
			undefined,
			ctx,
		)
		expect(ok.content[0].text).toContain("Confirmed 1 todos in step p/s")

		const phaseScope = await tools.todos.execute(
			"confirm-2",
			{ scope: { kind: "ferment", phaseId: "p" }, confirm: 0 },
			undefined,
			undefined,
			ctx,
		)
		expect(phaseScope.content[0].text).toContain("managed by the ferment lifecycle")
	})
})
