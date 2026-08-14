import { describe, expect, it } from "vitest"
import type { TodoItem, WriteTodosDetails } from "../../extensions/todos/types.js"
import { buildPlanEntries, buildPlanUpdate } from "./plan-mapper.js"

describe("buildPlanEntries", () => {
	it("maps pending todos to pending entries", () => {
		const todos: TodoItem[] = [{ id: 1, content: "write tests", status: "pending" }]
		expect(buildPlanEntries(todos)).toEqual([{ content: "write tests", priority: "medium", status: "pending" }])
	})

	it("maps in_progress todos preferring activeForm over content", () => {
		const todos: TodoItem[] = [{ id: 1, content: "write tests", status: "in_progress", activeForm: "writing tests" }]
		expect(buildPlanEntries(todos)).toEqual([{ content: "writing tests", priority: "medium", status: "in_progress" }])
	})

	it("falls back to content for in_progress todos without activeForm", () => {
		const todos: TodoItem[] = [{ id: 1, content: "write tests", status: "in_progress" }]
		expect(buildPlanEntries(todos)).toEqual([{ content: "write tests", priority: "medium", status: "in_progress" }])
	})

	it("maps completed todos to completed entries", () => {
		const todos: TodoItem[] = [{ id: 1, content: "write tests", status: "completed" }]
		expect(buildPlanEntries(todos)).toEqual([{ content: "write tests", priority: "medium", status: "completed" }])
	})

	it("maps blocked todos to pending entries with the [blocked] marker", () => {
		const todos: TodoItem[] = [{ id: 1, content: "deploy", status: "blocked" }]
		expect(buildPlanEntries(todos)).toEqual([{ content: "[blocked] deploy", priority: "medium", status: "pending" }])
	})

	it("appends the note to blocked todos after an em dash", () => {
		const todos: TodoItem[] = [{ id: 1, content: "deploy", status: "blocked", note: "waiting on ops" }]
		expect(buildPlanEntries(todos)).toEqual([
			{ content: "[blocked] deploy — waiting on ops", priority: "medium", status: "pending" },
		])
	})

	it("strips internal fields like _syncKey from entries", () => {
		const todos: TodoItem[] = [{ id: 1, content: "synced", status: "pending", _syncKey: "phase:1" }]
		expect(buildPlanEntries(todos)).toEqual([{ content: "synced", priority: "medium", status: "pending" }])
	})

	it("returns empty entries for an empty todo list", () => {
		expect(buildPlanEntries([])).toEqual([])
	})

	it("preserves todo order across mixed statuses", () => {
		const todos: TodoItem[] = [
			{ id: 1, content: "done", status: "completed" },
			{ id: 2, content: "doing", status: "in_progress", activeForm: "doing it" },
			{ id: 3, content: "stuck", status: "blocked", note: "nope" },
			{ id: 4, content: "later", status: "pending" },
		]
		expect(buildPlanEntries(todos)).toEqual([
			{ content: "done", priority: "medium", status: "completed" },
			{ content: "doing it", priority: "medium", status: "in_progress" },
			{ content: "[blocked] stuck — nope", priority: "medium", status: "pending" },
			{ content: "later", priority: "medium", status: "pending" },
		])
	})
})

describe("buildPlanUpdate", () => {
	it("builds a plan session update with entries and scope _meta", () => {
		const details: WriteTodosDetails = {
			schemaVersion: 1,
			scope: { kind: "global" },
			todos: [{ id: 1, content: "write tests", status: "pending" }],
			updatedAt: "2026-08-14T00:00:00.000Z",
		}
		expect(buildPlanUpdate(details)).toEqual({
			sessionUpdate: "plan",
			entries: [{ content: "write tests", priority: "medium", status: "pending" }],
			_meta: { "kimchi.dev": { scope: { kind: "global" } } },
		})
	})

	it("carries ferment scope fields in _meta", () => {
		const details: WriteTodosDetails = {
			schemaVersion: 1,
			scope: { kind: "ferment", phaseId: "phase-1" },
			todos: [],
			updatedAt: "2026-08-14T00:00:00.000Z",
		}
		expect(buildPlanUpdate(details)).toEqual({
			sessionUpdate: "plan",
			entries: [],
			_meta: { "kimchi.dev": { scope: { kind: "ferment", phaseId: "phase-1" } } },
		})
	})

	it("carries ferment-step scope fields in _meta", () => {
		const details: WriteTodosDetails = {
			schemaVersion: 1,
			scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-2" },
			todos: [{ id: 1, content: "step work", status: "in_progress", activeForm: "working the step" }],
			updatedAt: "2026-08-14T00:00:00.000Z",
		}
		expect(buildPlanUpdate(details)).toEqual({
			sessionUpdate: "plan",
			entries: [{ content: "working the step", priority: "medium", status: "in_progress" }],
			_meta: { "kimchi.dev": { scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-2" } } },
		})
	})

	it("emits empty entries for an empty todo list", () => {
		const details: WriteTodosDetails = {
			schemaVersion: 1,
			scope: { kind: "global" },
			todos: [],
			updatedAt: "2026-08-14T00:00:00.000Z",
		}
		expect(buildPlanUpdate(details)).toEqual({
			sessionUpdate: "plan",
			entries: [],
			_meta: { "kimchi.dev": { scope: { kind: "global" } } },
		})
	})
})
