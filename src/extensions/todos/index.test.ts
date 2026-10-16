import type { ExtensionAPI, ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { isResourceEnabled } from "../../resources/store.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { __resetCheckinGate, getPendingCheckins, hasEffectivePendingCheckin } from "./checkin-gate.js"
import { TODO_CUSTOM_ENTRY_TYPE } from "./constants.js"
import todosExtension from "./index.js"
import { __resetReconciliationBookkeeping } from "./reconciliation.js"
import {
	__resetTodoStore,
	applyWriteTodos,
	GLOBAL_TODO_SCOPE,
	getTodosForScope,
	hasEverHadTodos,
	registerActiveTodoScopeProvider,
} from "./store.js"
import { TODO_TOOL_NAMES, UPDATE_TODOS_TOOL_NAME } from "./tool.js"
import { TODO_TOOL_RESULT_SCHEMA_VERSION, type TodoScope, type TodoStatus } from "./types.js"

vi.mock("../../resources/store.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../resources/store.js")>()
	return {
		...actual,
		isResourceEnabled: vi.fn(() => true),
	}
})

const isResourceEnabledMock = vi.mocked(isResourceEnabled)

const STEP_SCOPE: TodoScope = { kind: "ferment-step", phaseId: "p1", stepId: "s1" }

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme

function createTodosHarness(activeTools: string[] = [...TODO_TOOL_NAMES, "confirm_todos"]) {
	const mock = createExtensionApi()
	mock.setActiveTools(activeTools)
	todosExtension(mock.api)

	return {
		/** Invoke every handler registered for `event`, returning the last
		 * handler's result (the todos extension is the only registrant). */
		async fire(event: string, payload: unknown, ctx: ExtensionContext) {
			const results = await mock.emit(event, payload, ctx)
			return results.at(-1)
		},
		appendEntry: mock.appendEntry,
		sendMessage: mock.sendMessage,
		setActiveTools: mock.setActiveTools,
		events: mock.api.events,
		/** Registered tool definition, typed as the real ToolDefinition. */
		registeredTool: mock.getRegisteredTool,
	}
}

/** sendMessage calls that are NOT persisted todo-state blocks. Reconciliation
 *  semantics under test: state_sync blocks persist on every store change, so
 *  they must be filtered out before asserting "no follow-ups were sent". */
function nonStateSyncCalls(sendMessage: unknown): unknown[][] {
	return vi
		.mocked(sendMessage as ExtensionAPI["sendMessage"])
		.mock.calls.filter(([message]) => (message as { details?: { reason?: string } }).details?.reason !== "state_sync")
}

function steerCallsByReason(sendMessage: unknown, reason: string): unknown[][] {
	return vi
		.mocked(sendMessage as ExtensionAPI["sendMessage"])
		.mock.calls.filter(([message]) => (message as { details?: { reason?: string } }).details?.reason === reason)
}

function createContext(
	sessionId: string,
	branch: SessionEntry[],
	options: { hasPendingMessages?: boolean; hasUI?: boolean; ui?: ExtensionContext["ui"] } = {},
): ExtensionContext {
	return {
		hasUI: options.hasUI ?? false,
		cwd: "/test",
		ui: options.ui,
		hasPendingMessages: () => options.hasPendingMessages ?? false,
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
		},
	} as unknown as ExtensionContext
}

function terminalTurn(stopReason = "end_turn"): unknown {
	return { message: { role: "assistant", content: [], stopReason }, toolResults: [] }
}

function terminalTurnWithText(text = "Done."): unknown {
	return { message: { role: "assistant", content: [{ type: "text", text }], stopReason: "end_turn" }, toolResults: [] }
}

function toolCall(toolName: string): unknown {
	return {
		type: "tool_call",
		toolCallId: `call-${toolName}`,
		toolName,
		input: toolName === "bash" ? { command: "ls" } : {},
	}
}

function writeTodosEntry(
	id: string,
	content: string,
	status: TodoStatus = "pending",
	toolName: string = UPDATE_TODOS_TOOL_NAME,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId: `tool-${id}`,
			toolName,
			content: [{ type: "text", text: "Updated 1 todos." }],
			details: {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope: { kind: "global" },
				todos: [{ id: 1, content, status }],
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		},
	} as unknown as SessionEntry
}

function customTodosEntry(id: string, content: string, status: TodoStatus = "pending"): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		customType: TODO_CUSTOM_ENTRY_TYPE,
		data: {
			schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
			scope: { kind: "global" },
			todos: [{ id: 1, content, status }],
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
	} as unknown as SessionEntry
}

describe("todos extension session state", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("restores todos from the active session branch instead of the previous store", async () => {
		const harness = createTodosHarness()
		applyWriteTodos({ todos: [{ content: "stale previous session", status: "pending" }] }, "previous-session")

		await harness.fire(
			"session_start",
			{ reason: "resume" },
			createContext("resumed-session", [
				writeTodosEntry("a", "superseded resumed todo"),
				writeTodosEntry("b", "current resumed todo", "in_progress"),
			]),
		)

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "resumed-session").map((todo) => todo.content)).toEqual([
			"current resumed todo",
		])
	})

	it("clears stale todos when the replacement session has no todo history", async () => {
		const harness = createTodosHarness()
		applyWriteTodos({ todos: [{ content: "stale previous session", status: "pending" }] }, "previous-session")

		await harness.fire("session_start", { reason: "fork" }, createContext("forked-session", []))

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "forked-session")).toEqual([])
	})

	it("replays todos when the active session tree branch changes", async () => {
		const harness = createTodosHarness()
		await harness.fire(
			"session_start",
			{ reason: "resume" },
			createContext("session", [writeTodosEntry("a", "root todo")]),
		)

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").map((todo) => todo.content)).toEqual(["root todo"])

		await harness.fire(
			"session_tree",
			{ oldLeafId: "a", newLeafId: "b" },
			createContext("session", [writeTodosEntry("b", "branch todo", "in_progress")]),
		)

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").map((todo) => todo.content)).toEqual(["branch todo"])
	})

	it("restores slash-command todo edits from custom entries", async () => {
		const harness = createTodosHarness()

		await harness.fire(
			"session_start",
			{ reason: "resume" },
			createContext("session", [customTodosEntry("c", "command todo")]),
		)

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").map((todo) => todo.content)).toEqual(["command todo"])
	})

	it("restores todos from every todo tool result", async () => {
		for (const toolName of TODO_TOOL_NAMES) {
			__resetTodoStore()
			const harness = createTodosHarness()

			await harness.fire(
				"session_start",
				{ reason: "resume" },
				createContext("session", [writeTodosEntry("u", `${toolName} todo`, "completed", toolName)]),
			)

			expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").map((todo) => todo.content)).toEqual([`${toolName} todo`])
			expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session")[0]?.status).toBe("completed")
		}
	})

	it("restores todos from legacy write_todos tool results", async () => {
		const harness = createTodosHarness()

		await harness.fire(
			"session_start",
			{ reason: "resume" },
			createContext("session", [writeTodosEntry("legacy", "legacy todo", "in_progress", "write_todos")]),
		)

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").map((todo) => todo.content)).toEqual(["legacy todo"])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session")[0]?.status).toBe("in_progress")
	})

	it("does not inject hidden todo steers for non-todo tool calls", async () => {
		const harness = createTodosHarness()
		const result = await harness.fire("tool_call", toolCall("bash"), createContext("session", []))

		expect(result).toEqual({ block: false })
		expect(harness.appendEntry).not.toHaveBeenCalled()
		expect(harness.sendMessage).not.toHaveBeenCalled()
	})
})

describe("passive staleness counter", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("persists the todo state block as a hidden steer on todo writes", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		applyWriteTodos({ todos: [{ content: "check work", status: "in_progress" }] }, "session")

		const stateSync = steerCallsByReason(harness.sendMessage, "state_sync")
		expect(stateSync).toHaveLength(1)
		const [message, options] = stateSync[0] as [
			{ customType?: string; display?: boolean; content?: string },
			{ deliverAs?: string },
		]
		expect(message.customType).toBe("todo-state")
		expect(message.display).toBe(false)
		expect(options.deliverAs).toBe("steer")
		expect(message.content).toMatch(/^<system-reminder>\n/)
		expect(message.content).toMatch(/\n<\/system-reminder>$/)
		expect(message.content).toContain("## Current Todos")
		expect(message.content).toContain("check work")

		// Two no-op turns must not persist additional blocks.
		await harness.fire("turn_end", terminalTurn(), ctx)
		await harness.fire("turn_end", terminalTurnWithText(), ctx)
		expect(steerCallsByReason(harness.sendMessage, "state_sync")).toHaveLength(1)
	})

	it("does not inject todo state inside the context event (no tail push)", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		applyWriteTodos({ todos: [{ content: "check work", status: "in_progress" }] }, "session")

		const result = (await harness.fire("context", { messages: [] }, ctx)) as
			| { messages: Array<{ role?: string; content?: string }> }
			| undefined
		expect(result).toBeUndefined()
	})

	it("does not send reconciliation follow-ups after terminal turns", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		applyWriteTodos({ todos: [{ content: "still active", status: "in_progress" }] }, "session")
		await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
		await harness.fire("turn_end", terminalTurnWithText(), ctx)

		// No reconciliation follow-up should be sent — the old forced-turn
		// mechanism has been removed. Only the persisted state block is sent.
		expect(nonStateSyncCalls(harness.sendMessage)).toHaveLength(0)
	})

	it("does not send reconciliation follow-ups even after multiple terminal stops", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		applyWriteTodos({ todos: [{ content: "still active", status: "in_progress" }] }, "session")
		await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
		await harness.fire("turn_end", terminalTurnWithText(), ctx)
		await harness.fire("turn_end", terminalTurnWithText(), ctx)
		await harness.fire("turn_end", terminalTurnWithText(), ctx)

		expect(nonStateSyncCalls(harness.sendMessage)).toHaveLength(0)
	})

	it("does not reconcile immediately after only writing todos", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		applyWriteTodos({ todos: [{ content: "new plan", status: "pending" }] }, "session")
		await harness.fire("turn_end", terminalTurn(), ctx)

		expect(nonStateSyncCalls(harness.sendMessage)).toHaveLength(0)
	})

	it("resyncs the active todo widget on terminal turns after the TUI clears widgets", async () => {
		const harness = createTodosHarness()
		const setWidget = vi.fn()
		const ctx = createContext("session", [], {
			hasUI: true,
			ui: { theme, setWidget, setStatus: vi.fn() } as unknown as ExtensionContext["ui"],
		})
		await harness.fire("session_start", { reason: "new" }, ctx)

		applyWriteTodos({ todos: [{ content: "visible active todo", status: "in_progress" }] }, "session")
		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		instance.dispose()

		await harness.fire("turn_end", terminalTurn(), ctx)

		expect(setWidget).toHaveBeenCalledTimes(2)
		expect(nonStateSyncCalls(harness.sendMessage)).toHaveLength(0)
	})

	it("does not reconcile on non-terminal turns", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)
		applyWriteTodos({ todos: [{ content: "still active", status: "in_progress" }] }, "session")
		await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)

		await harness.fire("turn_end", { message: { role: "assistant", stopReason: "aborted" }, toolResults: [] }, ctx)
		await harness.fire("turn_end", { message: { role: "assistant" }, toolResults: [{}] }, ctx)
		await harness.fire("turn_end", terminalTurn(), createContext("session", [], { hasPendingMessages: true }))

		expect(nonStateSyncCalls(harness.sendMessage)).toHaveLength(0)
	})

	it("isolates todos between concurrent sessions", async () => {
		const harness = createTodosHarness()
		const ctxA = createContext("session-a", [writeTodosEntry("a1", "alpha for A", "in_progress")])
		const ctxB = createContext("session-b", [])

		await harness.fire("session_start", { reason: "new" }, ctxA)
		await harness.fire("session_start", { reason: "new" }, ctxB)

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-a").map((todo) => todo.content)).toEqual(["alpha for A"])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-b")).toEqual([])

		// Writes targeted at session-b must not bleed into session-a.
		applyWriteTodos({ todos: [{ content: "beta for B", status: "pending" }] }, "session-b")
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-a").map((todo) => todo.content)).toEqual(["alpha for A"])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-b").map((todo) => todo.content)).toEqual(["beta for B"])
	})
})

describe("early todo nudge", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("fires when the model does multi-step work without ever creating a todo list", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		// Ten successful non-todo tool calls, no list ever created. The one-shot
		// nudge threshold is 5, so it should have fired.
		for (let i = 0; i < 10; i++) {
			await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
		}

		expect(harness.sendMessage).toHaveBeenCalledTimes(1)
		expect(vi.mocked(harness.sendMessage).mock.calls[0]?.[0]).toMatchObject({
			details: { reason: "early_nudge" },
		})
	})

	it("does not fire when the session already has a todo list", async () => {
		const harness = createTodosHarness()
		// Resumed session: the branch already contains a todo list.
		const ctx = createContext("session", [writeTodosEntry("a", "restored work", "in_progress")])
		await harness.fire("session_start", { reason: "resume" }, ctx)
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session")).toHaveLength(1)

		for (let i = 0; i < 10; i++) {
			await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
		}

		expect(steerCallsByReason(harness.sendMessage, "early_nudge")).toHaveLength(0)
	})

	it("fires only once even if the model continues without creating a list", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		for (let i = 0; i < 20; i++) {
			await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
		}

		expect(harness.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("delivers the nudge as a steer, never a follow-up", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		for (let i = 0; i < 10; i++) {
			await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
		}

		expect(vi.mocked(harness.sendMessage).mock.calls[0]?.[1]).toEqual({ deliverAs: "steer" })
	})

	it("does not fire when the model creates a todo list before the threshold", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		// Three tool calls, then create a todo list (below threshold of 5).
		for (let i = 0; i < 3; i++) {
			await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
		}
		applyWriteTodos({ todos: [{ content: "work", status: "in_progress" }] }, "session")
		expect(hasEverHadTodos("session")).toBe(true)

		// More tool calls — nudge should not fire because the session has had todos.
		for (let i = 0; i < 10; i++) {
			await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
		}

		expect(steerCallsByReason(harness.sendMessage, "early_nudge")).toHaveLength(0)
	})

	it("emits steer:fired with kind todo_early_nudge when the nudge fires", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		for (let i = 0; i < 10; i++) {
			await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
		}

		const fired = vi.mocked(harness.events.emit).mock.calls.filter(([channel]) => channel === "steer:fired")
		expect(fired).toHaveLength(1)
		expect(fired[0]?.[1]).toMatchObject({ kind: "todo_early_nudge", reason: "early_nudge" })
	})

	it("kill switch: KIMCHI_DISABLE_NUDGE_TODO_EARLY=1 suppresses the steer and the event", async () => {
		process.env.KIMCHI_DISABLE_NUDGE_TODO_EARLY = "1"
		try {
			const harness = createTodosHarness()
			const ctx = createContext("session", [])
			await harness.fire("session_start", { reason: "new" }, ctx)

			for (let i = 0; i < 10; i++) {
				await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
			}

			expect(steerCallsByReason(harness.sendMessage, "early_nudge")).toHaveLength(0)
			expect(vi.mocked(harness.events.emit).mock.calls.filter(([channel]) => channel === "steer:fired")).toHaveLength(0)
		} finally {
			delete process.env.KIMCHI_DISABLE_NUDGE_TODO_EARLY
		}
	})

	describe("early nudge outcome events", () => {
		it("todo write within the outcome window after the nudge → steer:outcome complied", async () => {
			const harness = createTodosHarness()
			const ctx = createContext("session", [])
			await harness.fire("session_start", { reason: "new" }, ctx)

			// Fire the nudge (threshold 5).
			for (let i = 0; i < 6; i++) {
				await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
			}
			// Adopt within the window (3): a todo write counts as compliance.
			applyWriteTodos({ todos: [{ content: "work", status: "in_progress" }] }, "session")
			await harness.fire("tool_execution_end", { toolName: "create_todos", isError: false }, ctx)

			const outcomes = vi.mocked(harness.events.emit).mock.calls.filter(([channel]) => channel === "steer:outcome")
			expect(outcomes).toHaveLength(1)
			expect(outcomes[0]?.[1]).toMatchObject({ kind: "todo_early_nudge", outcome: "complied" })
		})

		it("window expiry with no todo write → steer:outcome repeated (once)", async () => {
			const harness = createTodosHarness()
			const ctx = createContext("session", [])
			await harness.fire("session_start", { reason: "new" }, ctx)

			for (let i = 0; i < 12; i++) {
				await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
			}

			const outcomes = vi.mocked(harness.events.emit).mock.calls.filter(([channel]) => channel === "steer:outcome")
			expect(outcomes).toHaveLength(1)
			expect(outcomes[0]?.[1]).toMatchObject({ kind: "todo_early_nudge", outcome: "repeated" })
		})
	})

	describe("staleness threshold steers", () => {
		it("fires recurring reminders every 10 successful work calls with no ceiling, resetting on todo write", async () => {
			const harness = createTodosHarness()
			const ctx = createContext("session", [])
			await harness.fire("session_start", { reason: "new" }, ctx)
			applyWriteTodos({ todos: [{ content: "long task", status: "in_progress" }] }, "session")

			const stalenessCalls = () => steerCallsByReason(harness.sendMessage, "staleness")
			for (let count = 1; count <= 30; count++) {
				await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
				expect(stalenessCalls()).toHaveLength(Math.floor(count / 10))
			}
			for (const [index, boundary] of [10, 20, 30].entries()) {
				const message = stalenessCalls()[index]?.[0] as { content: string }
				expect(message.content).toContain(`${boundary} changes`)
				expect(message.content).toMatch(/^<system-reminder>\n/)
				expect(stalenessCalls()[index]?.[1]).toEqual({ deliverAs: "steer" })
			}
			// Wording strengthens from the third boundary (30) onward.
			expect((stalenessCalls()[2]?.[0] as { content: string }).content).toContain("remove obsolete items")

			// A todo write resets the schedule: the next reminder needs 10
			// additional successful work calls.
			applyWriteTodos(
				{ todos: [{ id: 1, content: "long task", status: "in_progress", note: "Progress recorded" }] },
				"session",
			)
			for (let count = 1; count <= 9; count++) {
				await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
				expect(stalenessCalls()).toHaveLength(3)
			}
			await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
			expect(stalenessCalls()).toHaveLength(4)
		})

		it("keeps reminding at every multiple of 10 beyond 85 with no final ceiling", async () => {
			const harness = createTodosHarness()
			const ctx = createContext("session", [])
			await harness.fire("session_start", { reason: "new" }, ctx)
			applyWriteTodos({ todos: [{ content: "long task", status: "in_progress" }] }, "session")

			for (let count = 1; count <= 83; count++) {
				await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
			}
			let stalenessCalls = steerCallsByReason(harness.sendMessage, "staleness")
			expect(stalenessCalls).toHaveLength(8)

			for (let count = 84; count <= 90; count++) {
				await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
			}
			stalenessCalls = steerCallsByReason(harness.sendMessage, "staleness")
			expect(stalenessCalls).toHaveLength(9)
			const last = stalenessCalls[8]?.[0] as { content: string; details?: { threshold?: number } }
			expect(last.content).toContain("90 changes")
		})

		it("does not fire when the current scope has no todos", async () => {
			const harness = createTodosHarness()
			const ctx = createContext("session", [])
			await harness.fire("session_start", { reason: "new" }, ctx)

			// No list ever created: work calls only trigger the early nudge.
			for (let i = 0; i < 12; i++) {
				await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
			}
			expect(steerCallsByReason(harness.sendMessage, "staleness")).toHaveLength(0)
		})

		it("ages the global list while a step is active and regularly updated", async () => {
			const harness = createTodosHarness()
			const ctx = createContext("session", [])
			await harness.fire("session_start", { reason: "new" }, ctx)
			applyWriteTodos({ todos: [{ content: "global task", status: "pending" }] }, "session")
			const unregister = registerActiveTodoScopeProvider(() => STEP_SCOPE)
			try {
				applyWriteTodos({ scope: STEP_SCOPE, todos: [{ content: "step task", status: "in_progress" }] }, "session")

				// Both lists have unfinished items, so both age together: one
				// scope-labelled reminder each at boundary 10.
				for (let i = 0; i < 10; i++) {
					await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
				}
				let steers = steerCallsByReason(harness.sendMessage, "staleness") as Array<
					[{ details?: { scope?: TodoScope } }]
				>
				expect(steers).toHaveLength(2)
				expect(steers.map(([message]) => message.details?.scope)).toEqual([{ kind: "global" }, STEP_SCOPE])

				// A step-scope write resets only the step epoch. Completing the
				// step list stops its pressure; the global list keeps aging and
				// its delivered boundary is not re-armed by the step write.
				applyWriteTodos({ scope: STEP_SCOPE, todos: [{ content: "step task", status: "completed" }] }, "session")
				for (let i = 0; i < 10; i++) {
					await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
				}
				steers = steerCallsByReason(harness.sendMessage, "staleness") as Array<[{ details?: { scope?: TodoScope } }]>
				expect(steers).toHaveLength(3)
				expect(steers[2]?.[0].details?.scope).toEqual({ kind: "global" })
				expect((steers[2]?.[0] as { content: string }).content).toContain("20 changes")
			} finally {
				unregister()
			}
		})

		it("does not age inactive historical step lists", async () => {
			const harness = createTodosHarness()
			const ctx = createContext("session", [])
			await harness.fire("session_start", { reason: "new" }, ctx)
			applyWriteTodos({ todos: [{ content: "global task", status: "pending" }] }, "session")
			// A leftover step list from an earlier step: not active, so it
			// never ages and never steers.
			applyWriteTodos({ scope: STEP_SCOPE, todos: [{ content: "old step task", status: "in_progress" }] }, "session")

			for (let i = 0; i < 10; i++) {
				await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
			}
			const steers = steerCallsByReason(harness.sendMessage, "staleness") as Array<
				[{ details?: { scope?: TodoScope } }]
			>
			expect(steers).toHaveLength(1)
			expect(steers[0]?.[0].details?.scope).toEqual({ kind: "global" })
		})

		it("replay resets every scope's counters and bands for the current session", async () => {
			const harness = createTodosHarness()
			const branch = [writeTodosEntry("t1", "global task", "in_progress")]
			const ctx = createContext("session", branch)
			await harness.fire("session_start", { reason: "new" }, ctx)

			for (let i = 0; i < 10; i++) {
				await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
			}
			expect(steerCallsByReason(harness.sendMessage, "staleness")).toHaveLength(1)

			// Branch switch / replay: the restored list starts a fresh epoch.
			await harness.fire("session_tree", {}, ctx)
			for (let i = 0; i < 10; i++) {
				await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
			}
			expect(steerCallsByReason(harness.sendMessage, "staleness")).toHaveLength(2)
		})

		it("keeps staleness pressure isolated between concurrent sessions", async () => {
			const harness = createTodosHarness()
			const ctxA = createContext("session-a", [writeTodosEntry("a", "task A", "in_progress")])
			const ctxB = createContext("session-b", [writeTodosEntry("b", "task B", "in_progress")])
			await harness.fire("session_start", { reason: "new" }, ctxA)
			await harness.fire("session_start", { reason: "new" }, ctxB)

			for (let i = 0; i < 10; i++) {
				await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctxA)
			}
			expect(steerCallsByReason(harness.sendMessage, "staleness")).toHaveLength(1)

			// The same work in session B steers only session B's list.
			for (let i = 0; i < 10; i++) {
				await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctxB)
			}
			expect(steerCallsByReason(harness.sendMessage, "staleness")).toHaveLength(2)
		})
	})
})

describe("todo check-in gate", () => {
	const fireWork = (harness: ReturnType<typeof createTodosHarness>, ctx: ExtensionContext, toolCallId: string) =>
		harness.fire("tool_call", { type: "tool_call", toolCallId, toolName: "bash", input: {} }, ctx)

	const fireInput = (
		harness: ReturnType<typeof createTodosHarness>,
		ctx: ExtensionContext,
		text = "Now do it differently",
	) => harness.fire("input", { type: "input", text, source: "interactive" }, ctx)

	beforeEach(() => {
		__resetTodoStore()
		__resetCheckinGate()
		__resetReconciliationBookkeeping()
		isResourceEnabledMock.mockReturnValue(true)
	})

	it("requires reconciliation after user input before admitting work tools", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)
		// The list exists from an earlier assistant write (reconciled at
		// revision 0), so pre-input work flows.
		applyWriteTodos({ todos: [{ content: "task", status: "in_progress" }] }, "session", {
			origin: "tool",
			inputRevision: 0,
		})

		expect(await fireWork(harness, ctx, "w0")).toEqual({ block: false })

		await fireInput(harness, ctx)
		const result = await fireWork(harness, ctx, "w1")
		expect(result).toMatchObject({ block: true })
		expect((result as { reason?: string }).reason).toContain("check-in pending (input revision 1)")
		expect((result as { reason?: string }).reason).toContain("[in_progress] #1 task")

		// One hidden instruction per accepted input revision.
		expect(steerCallsByReason(harness.sendMessage, "user_input")).toHaveLength(1)

		// Repeated blocked calls return current instructions without new steers.
		await fireWork(harness, ctx, "w2")
		expect(steerCallsByReason(harness.sendMessage, "user_input")).toHaveLength(1)

		// Reconciliation tools pass through while the gate is open.
		expect(
			await harness.fire("tool_call", { type: "tool_call", toolCallId: "m1", toolName: "mark_todo", input: {} }, ctx),
		).toEqual({ block: false })
		expect(
			await harness.fire(
				"tool_call",
				{ type: "tool_call", toolCallId: "c1", toolName: "confirm_todos", input: {} },
				ctx,
			),
		).toEqual({ block: false })
	})

	it("releases work after a real write and after a successful confirmation", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)
		applyWriteTodos({ todos: [{ content: "task", status: "in_progress" }] }, "session")
		await fireInput(harness, ctx)
		expect(await fireWork(harness, ctx, "w1")).toMatchObject({ block: true })

		// A real assistant write against the admitted revision reconciles.
		applyWriteTodos({ todos: [{ id: 1, content: "task", status: "pending" }] }, "session", {
			origin: "tool",
			inputRevision: 1,
		})
		expect(await fireWork(harness, ctx, "w2")).toEqual({ block: false })

		// Newer input re-arms the check; a matching confirmation releases it.
		await fireInput(harness, ctx, "Second thought")
		expect(await fireWork(harness, ctx, "w3")).toMatchObject({ block: true })
		await harness
			.registeredTool("confirm_todos")
			.execute("c1", { inputRevision: 2, expected: [{ id: 1, status: "pending" }] }, undefined, undefined, ctx)
		expect(await fireWork(harness, ctx, "w4")).toEqual({ block: false })
	})

	it("a mismatched or stale-revision confirmation keeps work blocked", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)
		applyWriteTodos({ todos: [{ content: "task", status: "in_progress" }] }, "session")
		await fireInput(harness, ctx)
		expect(await fireWork(harness, ctx, "w1")).toMatchObject({ block: true })

		await harness
			.registeredTool("confirm_todos")
			.execute("c1", { inputRevision: 1, expected: [{ id: 1, status: "completed" }] }, undefined, undefined, ctx)
		expect(await fireWork(harness, ctx, "w2")).toMatchObject({ block: true })

		await harness
			.registeredTool("confirm_todos")
			.execute("c2", { inputRevision: 0, expected: [{ id: 1, status: "in_progress" }] }, undefined, undefined, ctx)
		expect(await fireWork(harness, ctx, "w3")).toMatchObject({ block: true })
	})

	it("a write admitted before newer user input cannot satisfy the newer check", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)
		applyWriteTodos({ todos: [{ content: "task", status: "in_progress" }] }, "session")
		await fireInput(harness, ctx)

		// Admit a mark_todo call under revision 1…
		await harness.fire("tool_call", { type: "tool_call", toolCallId: "m1", toolName: "mark_todo", input: {} }, ctx)
		// …then newer input arrives before the write executes.
		await fireInput(harness, ctx, "Changed my mind")
		await harness.registeredTool("mark_todo").execute("m1", { id: 1, status: "pending" }, undefined, undefined, ctx)

		// The write acknowledged revision 1 only; the revision-2 check stays pending.
		expect(getPendingCheckins("session")).toHaveLength(1)
		expect(await fireWork(harness, ctx, "w1")).toMatchObject({ block: true })
	})

	it("escalates after 50 ignored work calls, bounded to two openings per request", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)
		applyWriteTodos({ todos: [{ content: "task", status: "in_progress" }] }, "session")
		await fireInput(harness, ctx)
		// Reconcile first so work can proceed, then neglect the list.
		applyWriteTodos({ todos: [{ id: 1, content: "task", status: "in_progress" }] }, "session", {
			origin: "tool",
			inputRevision: 1,
		})

		const workAndExecute = async (id: string) => {
			expect(await fireWork(harness, ctx, id)).toEqual({ block: false })
			await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
		}

		// First epoch: the gate opens at call 50 (staleness ≥ 50 with a
		// delivered boundary-50 reminder).
		for (let i = 0; i < 50; i++) await workAndExecute(`a${i}`)
		expect(getPendingCheckins("session")[0]?.reasons.has("staleness")).toBe(true)
		expect(await fireWork(harness, ctx, "a50")).toMatchObject({ block: true })

		// Reconcile, neglect again: second opening.
		applyWriteTodos(
			{
				todos: [
					{ id: 1, content: "task", status: "completed" },
					{ id: 2, content: "next", status: "in_progress" },
				],
			},
			"session",
			{ origin: "tool", inputRevision: 1 },
		)
		expect(await fireWork(harness, ctx, "b0")).toEqual({ block: false })
		for (let i = 0; i < 50; i++) await workAndExecute(`b${i}`)
		expect(getPendingCheckins("session").some((check) => check.reasons.has("staleness"))).toBe(true)
		// Keep an unfinished item so the third epoch still ages.
		applyWriteTodos({ todos: [{ id: 2, content: "next", status: "in_progress", note: "epoch 3" }] }, "session", {
			origin: "tool",
			inputRevision: 1,
		})

		// Third epoch: the two-opening budget for this request is spent — no
		// third escalation, work flows, and reminders keep recurring.
		for (let i = 0; i < 50; i++) await workAndExecute(`c${i}`)
		expect(getPendingCheckins("session")).toHaveLength(0)
		// 5 reminders per 50-call epoch: 15 total, no final ceiling.
		expect(steerCallsByReason(harness.sendMessage, "staleness")).toHaveLength(15)

		// The routine user-input check is never budget-limited: new input with
		// a still-unfinished list re-arms the gate.
		applyWriteTodos({ todos: [{ id: 3, content: "more", status: "pending" }] }, "session", {
			origin: "tool",
			inputRevision: 1,
		})
		await fireInput(harness, ctx, "One more thing")
		expect(await fireWork(harness, ctx, "z1")).toMatchObject({ block: true })
	})

	it("releases enforcement when prerequisites are unavailable", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)
		applyWriteTodos({ todos: [{ content: "task", status: "in_progress" }] }, "session")
		await fireInput(harness, ctx)
		expect(await fireWork(harness, ctx, "w1")).toMatchObject({ block: true })

		// Kill switch on → released.
		process.env.KIMCHI_DISABLE_NUDGE_TODO_CHECKIN = "1"
		try {
			expect(await fireWork(harness, ctx, "w2")).toEqual({ block: false })
		} finally {
			delete process.env.KIMCHI_DISABLE_NUDGE_TODO_CHECKIN
		}

		// Resource disabled → released; re-enabled → restored.
		isResourceEnabledMock.mockReturnValue(false)
		expect(await fireWork(harness, ctx, "w3")).toEqual({ block: false })
		isResourceEnabledMock.mockReturnValue(true)
		expect(await fireWork(harness, ctx, "w4")).toMatchObject({ block: true })

		// No reconciliation tools active → released.
		harness.setActiveTools(["bash"])
		expect(await fireWork(harness, ctx, "w5")).toEqual({ block: false })
	})

	it("checks a list that becomes relevant mid-request before admitting work", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)
		// No todos at input time: nothing pending.
		await fireInput(harness, ctx)
		expect(await fireWork(harness, ctx, "w1")).toEqual({ block: false })

		// A step activates and its list is seeded by the background bridge.
		const unregister = registerActiveTodoScopeProvider(() => STEP_SCOPE)
		try {
			applyWriteTodos({ scope: STEP_SCOPE, todos: [{ content: "step task", status: "in_progress" }] }, "session") // bridge origin: does not reconcile
			const result = await fireWork(harness, ctx, "w2")
			expect(result).toMatchObject({ block: true })
			expect((result as { reason?: string }).reason).toContain("step p1/s1")

			// A real write to the step list reconciles it.
			applyWriteTodos(
				{ scope: STEP_SCOPE, todos: [{ id: 1, content: "step task", status: "in_progress", note: "reviewed" }] },
				"session",
				{ origin: "tool", inputRevision: 1 },
			)
			expect(await fireWork(harness, ctx, "w3")).toEqual({ block: false })
		} finally {
			unregister()
		}
	})

	it("completed and empty lists do not gate work; blocked lists do", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)
		applyWriteTodos({ todos: [{ content: "done", status: "completed" }] }, "session")
		await fireInput(harness, ctx, "Anything left?")
		expect(await fireWork(harness, ctx, "w1")).toEqual({ block: false })

		applyWriteTodos({ todos: [] }, "session")
		expect(await fireWork(harness, ctx, "w2")).toEqual({ block: false })

		applyWriteTodos({ todos: [{ content: "waiting", status: "blocked" }] }, "session")
		const result = await fireWork(harness, ctx, "w3")
		expect(result).toMatchObject({ block: true })
		expect((result as { reason?: string }).reason).toContain("[blocked] #1 waiting")
	})

	it("replay requires reconciliation of restored unfinished lists", async () => {
		const harness = createTodosHarness()
		const branch = [writeTodosEntry("t1", "restored task", "in_progress")]
		const ctx = createContext("session", branch)
		await harness.fire("session_start", { reason: "new" }, ctx)
		// The restored list is unfinished and unproven: work is gated until a
		// real reconciliation (the branch content is not fresh input, so the
		// revision stays 0).
		expect(await fireWork(harness, ctx, "w1")).toMatchObject({ block: true })
		applyWriteTodos({ todos: [{ id: 1, content: "restored task", status: "in_progress" }] }, "session", {
			origin: "tool",
			inputRevision: 0,
		})
		expect(await fireWork(harness, ctx, "w2")).toEqual({ block: false })
	})

	it("does not escalate when staleness reminders are kill-switch disabled", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)
		applyWriteTodos({ todos: [{ id: 1, content: "task", status: "in_progress" }] }, "session", {
			origin: "tool",
			inputRevision: 0,
		})

		process.env.KIMCHI_DISABLE_NUDGE_STALENESS = "1"
		try {
			for (let i = 0; i < 55; i++) {
				expect(await fireWork(harness, ctx, `w${i}`)).toEqual({ block: false })
				await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
			}
			// No reminder was ever delivered (the kill switch suppressed every
			// send), so no delivered boundary qualifies the escalation: the gate
			// never opens and work keeps flowing.
			expect(steerCallsByReason(harness.sendMessage, "staleness")).toHaveLength(0)
			expect(getPendingCheckins("session")).toHaveLength(0)
		} finally {
			delete process.env.KIMCHI_DISABLE_NUDGE_STALENESS
		}
	})

	it("a successful confirmation without a pending check still resets the reminder schedule", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)
		applyWriteTodos({ todos: [{ content: "task", status: "pending" }] }, "session", {
			origin: "tool",
			inputRevision: 0,
		})

		const reminders = () => steerCallsByReason(harness.sendMessage, "staleness")
		const workOnce = async (id: string) => {
			expect(await fireWork(harness, ctx, id)).toEqual({ block: false })
			await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
		}

		// 23 calls age the list: reminders at boundaries 10 and 20.
		for (let i = 0; i < 23; i++) await workOnce(`w${i}`)
		expect(reminders()).toHaveLength(2)

		// Confirm the accurate list with no check pending.
		await harness
			.registeredTool("confirm_todos")
			.execute("c1", { inputRevision: 0, expected: [{ id: 1, status: "pending" }] }, undefined, undefined, ctx)

		// The confirmation restarted the schedule: nine more calls stay quiet…
		for (let i = 23; i < 32; i++) await workOnce(`w${i}`)
		expect(reminders()).toHaveLength(2)
		// …the tenth call after the confirmation reminds again.
		await workOnce("w32")
		expect(reminders()).toHaveLength(3)
	})

	it("disabled enforcement releases work and stops publishing a pause, preserving the checks", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)
		applyWriteTodos({ todos: [{ content: "task", status: "in_progress" }] }, "session", {
			origin: "tool",
			inputRevision: 0,
		})
		await fireInput(harness, ctx, "New direction")
		expect(await fireWork(harness, ctx, "w1")).toMatchObject({ block: true })
		expect(hasEffectivePendingCheckin("session")).toBe(true)

		// Resource disabled: work flows and the pause is no longer published —
		// but the unreconciled check is preserved for re-enablement.
		isResourceEnabledMock.mockReturnValue(false)
		expect(await fireWork(harness, ctx, "w2")).toEqual({ block: false })
		expect(hasEffectivePendingCheckin("session")).toBe(false)
		expect(getPendingCheckins("session")).toHaveLength(1)

		// Re-enabled: the unreconciled input re-surfaces.
		isResourceEnabledMock.mockReturnValue(true)
		expect(await fireWork(harness, ctx, "w3")).toMatchObject({ block: true })
		expect(hasEffectivePendingCheckin("session")).toBe(true)
	})

	it("a background write that completes a pending list clears its check immediately", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)
		applyWriteTodos({ todos: [{ content: "task", status: "in_progress" }] }, "session")
		await fireInput(harness, ctx, "New direction")
		expect(await fireWork(harness, ctx, "w1")).toMatchObject({ block: true })

		// A background (bridge-style) write completes the list: the check drops
		// at the write itself, not at the next work call's relevance cleanup.
		applyWriteTodos({ todos: [{ id: 1, content: "task", status: "completed" }] }, "session")
		expect(getPendingCheckins("session")).toHaveLength(0)
		expect(await fireWork(harness, ctx, "w2")).toEqual({ block: false })
	})
})
