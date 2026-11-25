import { beforeEach, describe, expect, it, vi } from "vitest"
import { createCommandContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { registerTodosCommand } from "./command.js"
import { TODO_CUSTOM_ENTRY_TYPE } from "./constants.js"
import { __resetTodoStore, applyWriteTodos, GLOBAL_TODO_SCOPE, getTodosForScope } from "./store.js"

const TEST_SESSION_ID = "test-session"

async function executeTodosCommand(input: string) {
	const { api, getRegisteredCommand } = createExtensionApi()
	registerTodosCommand(api)
	const context = createCommandContext()
	const notify = vi.fn()
	context.ui.notify = notify
	await getRegisteredCommand("todos").handler(input, context)
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
		const { api, getRegisteredCommand, getAppendedEntries } = createExtensionApi()
		registerTodosCommand(api)
		const context = createCommandContext()
		context.hasUI = false
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		try {
			await getRegisteredCommand("todos").handler("add persisted task", context)
		} finally {
			log.mockRestore()
		}

		expect(getAppendedEntries(TODO_CUSTOM_ENTRY_TYPE)).toEqual([
			expect.objectContaining({
				schemaVersion: 1,
				scope: { kind: "global" },
				todos: [{ id: 1, content: "persisted task", status: "pending" }],
			}),
		])
	})

	it("registers the /todos command", async () => {
		const { api, getRegisteredCommand } = createExtensionApi()
		registerTodosCommand(api)
		expect(() => getRegisteredCommand("todo")).toThrow("Command todo was not registered")
		const completions = await getRegisteredCommand("todos").getArgumentCompletions?.("show")
		expect(completions?.map((entry) => entry.value)).toEqual(["show all"])
	})
})
