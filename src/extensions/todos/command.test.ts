import { beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { registerTodosCommand } from "./command.js"
import { TODO_CUSTOM_ENTRY_TYPE } from "./constants.js"
import { __resetTodoStore, applyWriteTodos, GLOBAL_TODO_SCOPE, getTodosForScope } from "./store.js"

const TEST_SESSION_ID = "test-session"

async function executeTodosCommand(input: string) {
	const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> | void }>()
	registerTodosCommand({
		appendEntry: vi.fn(),
		registerCommand: (name: string, config: { handler: (args: string, ctx: never) => Promise<void> | void }) => {
			commands.set(name, config)
		},
	} as never)
	const handler = commands.get("todos")?.handler
	if (!handler) throw new Error("todos command was not registered")
	const notify = vi.fn()
	await handler(
		input,
		createContext({
			hasUI: true,
			sessionManager: { getSessionId: () => TEST_SESSION_ID },
			ui: { notify },
		}) as never,
	)
	return notify
}

describe("/todos command helpers", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("handles supported subcommands through the registered command", async () => {
		expect((await executeTodosCommand("add ship it")).mock.calls[0]?.[0]).toBe("Added todo: ship it")
		await executeTodosCommand("start 1")
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)[0]).toMatchObject({ status: "in_progress" })
		await executeTodosCommand("block 1")
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)[0]).toMatchObject({ status: "blocked" })
		await executeTodosCommand("done 1")
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)[0]).toMatchObject({ status: "completed" })
		await executeTodosCommand("remove 1")
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)).toEqual([])
	})

	it("adds and updates todos through store writes", async () => {
		const addResult = await executeTodosCommand("add first task")
		expect(addResult.mock.calls[0]).toEqual(["Added todo: first task", "info"])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)).toEqual([
			{ id: 1, content: "first task", status: "pending" },
		])

		await executeTodosCommand("start 1")
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)[0]).toMatchObject({ status: "in_progress" })

		await executeTodosCommand("block 1")
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)[0]).toMatchObject({ status: "blocked" })

		await executeTodosCommand("done 1")
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)[0]).toMatchObject({ status: "completed" })
	})

	it("removes and clears todos", async () => {
		applyWriteTodos(
			{
				todos: [
					{ content: "one", status: "pending" },
					{ content: "two", status: "pending" },
				],
			},
			TEST_SESSION_ID,
		)

		await executeTodosCommand("remove 1")
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID).map((todo) => todo.content)).toEqual(["two"])

		await executeTodosCommand("clear")
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)).toEqual([])
	})

	it("persists slash-command edits as custom session entries", async () => {
		const registered = new Map<string, { handler: (args: string, ctx: never) => Promise<void> | void }>()
		const appendEntry = vi.fn()
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		registerTodosCommand({
			registerCommand: (name: string, config: { handler: (args: string, ctx: never) => Promise<void> | void }) => {
				registered.set(name, config)
			},
			appendEntry,
		} as never)

		try {
			await registered.get("todos")?.handler("add persisted task", {
				hasUI: false,
				sessionManager: { getSessionId: () => TEST_SESSION_ID, getBranch: () => [] },
			} as never)
		} finally {
			log.mockRestore()
		}

		expect(appendEntry).toHaveBeenCalledOnce()
		expect(appendEntry).toHaveBeenCalledWith(
			TODO_CUSTOM_ENTRY_TYPE,
			expect.objectContaining({
				schemaVersion: 1,
				scope: { kind: "global" },
				todos: [{ id: 1, content: "persisted task", status: "pending" }],
			}),
		)
	})

	it("registers the /todos command", () => {
		const registered = new Map<string, { getArgumentCompletions: (prefix: string) => Array<{ value: string }> }>()
		registerTodosCommand({
			registerCommand: (
				name: string,
				config: { getArgumentCompletions: (prefix: string) => Array<{ value: string }> },
			) => {
				registered.set(name, config)
			},
		} as never)

		expect(registered.has("todos")).toBe(true)
		expect(registered.has("todo")).toBe(false)
		expect(
			registered
				.get("todos")
				?.getArgumentCompletions("show")
				.map((entry) => entry.value),
		).toEqual(["show all"])
	})
})
