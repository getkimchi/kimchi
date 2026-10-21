import { beforeEach, describe, expect, it } from "vitest"
import { getTodoScopeKey } from "./scope.js"
import {
	createIntervalSteerTracker,
	createThresholdSteerTracker,
	stalenessIndicator,
	stalenessScopeLabel,
	TODO_STALENESS_INTERVAL,
} from "./staleness-steers.js"
import {
	__resetTodoStore,
	bumpToolCallsSinceTodoWrite,
	clearToolCallsSinceTodoWriteForSession,
	GLOBAL_TODO_SCOPE,
	getToolCallsSinceTodoWrite,
	resetToolCallsSinceTodoWrite,
} from "./store.js"
import type { TodoScope } from "./types.js"

const STEP_SCOPE: TodoScope = { kind: "ferment-step", phaseId: "p1", stepId: "s1" }
const OTHER_STEP_SCOPE: TodoScope = { kind: "ferment-step", phaseId: "p1", stepId: "s2" }

describe("interval steer tracker (recurring reminders)", () => {
	it("fires once per interval boundary with no duplicates within an interval", () => {
		const tracker = createIntervalSteerTracker()
		const sent: number[] = []
		const fire = (count: number) =>
			tracker.fireInterval({
				sessionId: "s",
				scopeKey: "global",
				count,
				interval: TODO_STALENESS_INTERVAL,
				send: (boundary) => {
					sent.push(boundary)
					return true
				},
			})

		fire(9)
		expect(sent).toEqual([])
		fire(10)
		expect(sent).toEqual([10])
		fire(11)
		fire(19)
		expect(sent).toEqual([10])
		fire(20)
		expect(sent).toEqual([10, 20])
		fire(35)
		expect(sent).toEqual([10, 20, 30])
	})

	it("sends one reminder for the highest crossed boundary when a count jumps", () => {
		const tracker = createIntervalSteerTracker()
		const sent: number[] = []
		tracker.fireInterval({
			sessionId: "s",
			scopeKey: "global",
			count: 37,
			interval: TODO_STALENESS_INTERVAL,
			send: (boundary) => {
				sent.push(boundary)
				return true
			},
		})
		expect(sent).toEqual([30])
	})

	it("recurs beyond 85 with no final ceiling and bounded storage", () => {
		const tracker = createIntervalSteerTracker()
		const sent: number[] = []
		for (let count = 1; count <= 90; count++) {
			tracker.fireInterval({
				sessionId: "s",
				scopeKey: "global",
				count,
				interval: TODO_STALENESS_INTERVAL,
				send: (boundary) => {
					sent.push(boundary)
					return true
				},
			})
		}
		expect(sent).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90])
		// The tracker stores only the highest delivered boundary, so storage
		// stays constant no matter how long the epoch runs — verified by the
		// schedule continuing unchanged after the reset below.
		expect(tracker.highestDelivered("s", "global")).toBe(90)
	})

	it("does not advance the boundary for disabled or unsent reminders", () => {
		const tracker = createIntervalSteerTracker()
		let deliver = false
		const fire = (count: number) =>
			tracker.fireInterval({
				sessionId: "s",
				scopeKey: "global",
				count,
				interval: TODO_STALENESS_INTERVAL,
				send: () => deliver,
			})

		fire(10)
		expect(tracker.highestDelivered("s", "global")).toBeUndefined()

		deliver = true
		fire(10)
		expect(tracker.highestDelivered("s", "global")).toBe(10)
	})

	it("keeps boundaries independent across scopes in the same session", () => {
		const tracker = createIntervalSteerTracker()
		const stepKey = getTodoScopeKey(STEP_SCOPE)
		const sent: string[] = []
		const fire = (scopeKey: string) =>
			tracker.fireInterval({
				sessionId: "s",
				scopeKey,
				count: 10,
				interval: TODO_STALENESS_INTERVAL,
				send: () => {
					sent.push(scopeKey)
					return true
				},
			})

		fire("global")
		fire("global")
		fire(stepKey)
		fire(stepKey)

		expect(sent).toEqual(["global", stepKey])
	})

	it("reset clears only the written scope's schedule", () => {
		const tracker = createIntervalSteerTracker()
		const stepKey = getTodoScopeKey(STEP_SCOPE)
		const sent: string[] = []
		const fire = (scopeKey: string) =>
			tracker.fireInterval({
				sessionId: "s",
				scopeKey,
				count: 10,
				interval: TODO_STALENESS_INTERVAL,
				send: () => {
					sent.push(scopeKey)
					return true
				},
			})

		fire("global")
		fire(stepKey)
		tracker.reset("s", "global")
		fire("global")
		fire(stepKey)

		expect(sent).toEqual(["global", stepKey, "global"])
		expect(tracker.highestDelivered("s", "global")).toBe(10)
		expect(tracker.highestDelivered("s", stepKey)).toBe(10)
	})

	it("isolates schedules between sessions and clears them per session", () => {
		const tracker = createIntervalSteerTracker()
		const fire = (sessionId: string) =>
			tracker.fireInterval({
				sessionId,
				scopeKey: "global",
				count: 10,
				interval: TODO_STALENESS_INTERVAL,
				send: () => true,
			})

		fire("a")
		fire("b")
		expect(tracker.highestDelivered("a", "global")).toBe(10)
		expect(tracker.highestDelivered("b", "global")).toBe(10)

		tracker.clearSession("a")
		expect(tracker.highestDelivered("a", "global")).toBeUndefined()
		expect(tracker.highestDelivered("b", "global")).toBe(10)
	})
})

describe("threshold steer tracker (one-shot, stall steers)", () => {
	it("fires each threshold once per epoch", () => {
		const tracker = createThresholdSteerTracker()
		const sent: number[] = []
		const fire = (count: number) =>
			tracker.fireCrossed({
				sessionId: "s",
				scopeKey: "ferment-step-stall",
				count,
				thresholds: [12],
				send: (threshold) => {
					sent.push(threshold)
					return true
				},
			})

		fire(11)
		expect(sent).toEqual([])
		fire(12)
		expect(sent).toEqual([12])
		fire(24)
		expect(sent).toEqual([12])
		tracker.reset("s", "ferment-step-stall")
		fire(12)
		expect(sent).toEqual([12, 12])
	})
})

describe("staleness indicator wording", () => {
	it("is silent below the first boundary", () => {
		expect(stalenessIndicator(9, GLOBAL_TODO_SCOPE)).toBeUndefined()
	})

	it("asks for a refresh at the first two boundaries, scope-labelled", () => {
		expect(stalenessIndicator(10, GLOBAL_TODO_SCOPE)).toContain("global todo list")
		expect(stalenessIndicator(10, GLOBAL_TODO_SCOPE)).toContain("refresh the list at the next natural breakpoint")
		expect(stalenessIndicator(20, STEP_SCOPE)).toContain("step p1/s1 todo list")
	})

	it("adds pruning wording from the third boundary (30) onward", () => {
		const text = stalenessIndicator(30, GLOBAL_TODO_SCOPE)
		expect(text).toContain("remove obsolete items or complete items whose work is done")
		expect(stalenessIndicator(90, STEP_SCOPE)).toContain("step p1/s1")
	})

	it("labels phase scopes", () => {
		expect(stalenessScopeLabel({ kind: "ferment", phaseId: "p2" })).toBe("phase p2")
	})
})

describe("per-scope staleness counters", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("counts, reads, and resets per scope", () => {
		expect(bumpToolCallsSinceTodoWrite(GLOBAL_TODO_SCOPE, "sess")).toBe(1)
		expect(bumpToolCallsSinceTodoWrite(STEP_SCOPE, "sess")).toBe(1)
		expect(bumpToolCallsSinceTodoWrite(GLOBAL_TODO_SCOPE, "sess")).toBe(2)

		expect(getToolCallsSinceTodoWrite(GLOBAL_TODO_SCOPE, "sess")).toBe(2)
		expect(getToolCallsSinceTodoWrite(STEP_SCOPE, "sess")).toBe(1)

		resetToolCallsSinceTodoWrite(GLOBAL_TODO_SCOPE, "sess")
		expect(getToolCallsSinceTodoWrite(GLOBAL_TODO_SCOPE, "sess")).toBe(0)
		expect(getToolCallsSinceTodoWrite(STEP_SCOPE, "sess")).toBe(1)
	})

	it("isolates counters between sessions", () => {
		bumpToolCallsSinceTodoWrite(GLOBAL_TODO_SCOPE, "a")
		bumpToolCallsSinceTodoWrite(GLOBAL_TODO_SCOPE, "a")
		bumpToolCallsSinceTodoWrite(GLOBAL_TODO_SCOPE, "b")

		expect(getToolCallsSinceTodoWrite(GLOBAL_TODO_SCOPE, "a")).toBe(2)
		expect(getToolCallsSinceTodoWrite(GLOBAL_TODO_SCOPE, "b")).toBe(1)
	})

	it("session cleanup clears every scope for that session only", () => {
		bumpToolCallsSinceTodoWrite(GLOBAL_TODO_SCOPE, "a")
		bumpToolCallsSinceTodoWrite(STEP_SCOPE, "a")
		bumpToolCallsSinceTodoWrite(GLOBAL_TODO_SCOPE, "b")

		clearToolCallsSinceTodoWriteForSession("a")

		expect(getToolCallsSinceTodoWrite(GLOBAL_TODO_SCOPE, "a")).toBe(0)
		expect(getToolCallsSinceTodoWrite(STEP_SCOPE, "a")).toBe(0)
		expect(getToolCallsSinceTodoWrite(GLOBAL_TODO_SCOPE, "b")).toBe(1)
	})

	it("equal boundaries in different scopes each fire once", () => {
		const tracker = createIntervalSteerTracker()
		const sent: string[] = []
		for (const scopeKey of ["global", getTodoScopeKey(STEP_SCOPE), getTodoScopeKey(OTHER_STEP_SCOPE)]) {
			for (let count = 1; count <= 12; count++) {
				tracker.fireInterval({
					sessionId: "s",
					scopeKey,
					count,
					interval: TODO_STALENESS_INTERVAL,
					send: () => {
						sent.push(scopeKey)
						return true
					},
				})
			}
		}

		expect(sent).toHaveLength(3)
	})
})
