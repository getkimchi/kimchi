import type { SessionNotification } from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetTodoStore, applyWriteTodos, restoreTodoStoreFromDetails } from "../../extensions/todos/store.js"
import { TODO_TOOL_RESULT_SCHEMA_VERSION, type TodoItem } from "../../extensions/todos/types.js"
import { AcpPlanTracker, buildPlanEntries, buildPlanUpdate } from "./plans.js"

function planUpdates(notifications: SessionNotification[]) {
	return notifications.map((notification) => notification.update)
}

describe("ACP plan mapping", () => {
	it("maps the complete Todo list without leaking internal fields", () => {
		const todos: TodoItem[] = [
			{ id: 1, content: "later", status: "pending", _syncKey: "private" },
			{ id: 2, content: "write tests", status: "in_progress", activeForm: "writing tests" },
			{ id: 3, content: "deploy", status: "blocked", note: "waiting on ops" },
			{ id: 4, content: "done", status: "completed" },
		]

		expect(buildPlanEntries(todos)).toEqual([
			{ content: "later", priority: "medium", status: "pending" },
			{ content: "writing tests", priority: "medium", status: "in_progress" },
			{
				content: "deploy",
				priority: "medium",
				status: "pending",
				_meta: { "kimchi.dev": { todoStatus: "blocked", note: "waiting on ops" } },
			},
			{ content: "done", priority: "medium", status: "completed" },
		])
	})

	it("falls back to content and omits an absent blocked note", () => {
		expect(
			buildPlanEntries([
				{ id: 1, content: "active", status: "in_progress" },
				{ id: 2, content: "blocked", status: "blocked" },
			]),
		).toEqual([
			{ content: "active", priority: "medium", status: "in_progress" },
			{
				content: "blocked",
				priority: "medium",
				status: "pending",
				_meta: { "kimchi.dev": { todoStatus: "blocked" } },
			},
		])
	})

	it("builds a full replacement with Todo scope metadata", () => {
		expect(
			buildPlanUpdate({
				scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-2" },
				todos: [{ id: 1, content: "step work", status: "pending" }],
			}),
		).toEqual({
			sessionUpdate: "plan",
			entries: [{ content: "step work", priority: "medium", status: "pending" }],
			_meta: {
				"kimchi.dev": {
					scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-2" },
				},
			},
		})
	})

	it("maps a cleared Todo list to an empty replacement", () => {
		expect(buildPlanUpdate({ scope: { kind: "global" }, todos: [] })).toEqual({
			sessionUpdate: "plan",
			entries: [],
			_meta: { "kimchi.dev": { scope: { kind: "global" } } },
		})
	})
})

describe("AcpPlanTracker", () => {
	const trackers: AcpPlanTracker[] = []

	beforeEach(() => __resetTodoStore())
	afterEach(() => {
		for (const tracker of trackers) tracker.stop()
		trackers.length = 0
		__resetTodoStore()
	})

	function makeTracker(sessionId = "session-a") {
		const notifications: SessionNotification[] = []
		const tracker = new AcpPlanTracker({ sessionId, send: (notification) => notifications.push(notification) })
		trackers.push(tracker)
		return { notifications, tracker }
	}

	it("emits every Todo write for its session regardless of scope", () => {
		const { notifications, tracker } = makeTracker()
		tracker.start()

		applyWriteTodos({ todos: [{ content: "regular Todo", status: "pending" }] }, "session-a")
		applyWriteTodos(
			{
				scope: { kind: "ferment", phaseId: "phase-1" },
				todos: [{ content: "Ferment Todo", status: "in_progress", activeForm: "running Ferment Todo" }],
			},
			"session-a",
		)

		expect(planUpdates(notifications)).toEqual([
			{
				sessionUpdate: "plan",
				entries: [{ content: "regular Todo", priority: "medium", status: "pending" }],
				_meta: { "kimchi.dev": { scope: { kind: "global" } } },
			},
			{
				sessionUpdate: "plan",
				entries: [{ content: "running Ferment Todo", priority: "medium", status: "in_progress" }],
				_meta: { "kimchi.dev": { scope: { kind: "ferment", phaseId: "phase-1" } } },
			},
		])
	})

	it("dedupes consecutive writes that produce the same visible plan", () => {
		const { notifications, tracker } = makeTracker()
		tracker.start()
		tracker.start()
		const write = { todos: [{ content: "same Todo", status: "pending" as const }] }

		applyWriteTodos(write, "session-a")
		applyWriteTodos(write, "session-a")

		expect(notifications).toHaveLength(1)
	})

	it("falls back to a populated broader scope when a step scope clears", () => {
		const { notifications, tracker } = makeTracker()
		tracker.start()

		applyWriteTodos(
			{
				scope: { kind: "ferment", phaseId: "phase-1" },
				todos: [{ content: "phase work", status: "pending" }],
			},
			"session-a",
		)
		applyWriteTodos(
			{
				scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" },
				todos: [{ content: "step work", status: "in_progress" }],
			},
			"session-a",
		)
		applyWriteTodos({ scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" }, todos: [] }, "session-a")

		expect(planUpdates(notifications).at(-1)).toEqual({
			sessionUpdate: "plan",
			entries: [{ content: "phase work", priority: "medium", status: "pending" }],
			_meta: { "kimchi.dev": { scope: { kind: "ferment", phaseId: "phase-1" } } },
		})
	})

	it("ignores other sessions and unsubscribes on stop", () => {
		const { notifications, tracker } = makeTracker()
		tracker.start()

		applyWriteTodos({ todos: [{ content: "foreign", status: "pending" }] }, "session-b")
		tracker.stop()
		applyWriteTodos({ todos: [{ content: "late", status: "pending" }] }, "session-a")

		expect(notifications).toHaveLength(0)
	})

	it("keeps a restored specific scope visible across broader-scope writes", () => {
		restoreTodoStoreFromDetails(
			[
				{
					schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
					scope: { kind: "global" },
					todos: [{ id: 1, content: "global", status: "pending" }],
					updatedAt: "2026-09-04T00:00:00.000Z",
				},
				{
					schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
					scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" },
					todos: [{ id: 1, content: "step", status: "in_progress" }],
					updatedAt: "2026-09-04T00:00:01.000Z",
				},
			],
			"session-a",
		)
		const { notifications, tracker } = makeTracker()
		tracker.start()

		tracker.emitRestoredSnapshot()
		applyWriteTodos(
			{ scope: { kind: "global" }, todos: [{ content: "new global", status: "in_progress" }] },
			"session-a",
		)

		expect(planUpdates(notifications)).toEqual([
			{
				sessionUpdate: "plan",
				entries: [{ content: "step", priority: "medium", status: "in_progress" }],
				_meta: {
					"kimchi.dev": {
						scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" },
					},
				},
			},
		])
	})

	it("emits nothing when a restored session has no Todos", () => {
		const { notifications, tracker } = makeTracker()
		tracker.start()
		tracker.emitRestoredSnapshot()
		expect(notifications).toHaveLength(0)
	})

	it("does not let a synchronous ACP send failure break the Todo store", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		const tracker = new AcpPlanTracker({
			sessionId: "session-a",
			send: () => {
				throw new Error("send failed")
			},
		})
		trackers.push(tracker)
		tracker.start()

		expect(() => applyWriteTodos({ todos: [{ content: "safe", status: "pending" }] }, "session-a")).not.toThrow()
		expect(error).toHaveBeenCalledOnce()
	})
})
