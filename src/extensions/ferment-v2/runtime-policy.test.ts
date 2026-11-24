import { describe, expect, it } from "vitest"
import type { TodoItem } from "../todos/types.js"
import type { FermentV2Lesson } from "./lessons.js"
import {
	deriveContinuationDecision,
	deriveHostContinuationDecision,
	deriveSettledStatus,
	type FermentV2TodoState,
	fermentV2ProgressFingerprint,
} from "./runtime-policy.js"
import type { SessionFermentV2 } from "./types.js"

const fermentV2 = (overrides: Partial<SessionFermentV2> = {}): SessionFermentV2 => ({
	schemaVersion: 1,
	id: "ferment-v2-1",
	revision: 1,
	objective: "ship the parser",
	status: "active",
	tokensUsed: 0,
	timeUsedMs: 0,
	createdAt: "2026-10-01T10:00:00.000Z",
	updatedAt: "2026-10-01T10:00:00.000Z",
	...overrides,
})

const todos = (...items: Partial<TodoItem>[]): TodoItem[] =>
	items.map((item, index) => ({
		id: item.id ?? index + 1,
		content: item.content ?? "Finish the Ferment V2",
		status: item.status ?? "completed",
		...(item.activeForm ? { activeForm: item.activeForm } : {}),
		...(item.note ? { note: item.note } : {}),
	}))

const todoState = (items: TodoItem[]): FermentV2TodoState => {
	const counts = { total: items.length, blocked: 0, completed: 0 }
	for (const item of items) {
		if (item.status === "blocked") counts.blocked += 1
		else if (item.status === "completed") counts.completed += 1
	}
	return {
		sessionId: "session-a",
		fermentV2Id: "ferment-v2-1",
		revision: 1,
		todos: items,
		...counts,
		settledStatus: deriveSettledStatus(counts, undefined),
	}
}

const noLessons: FermentV2Lesson[] = []

function fingerprintOf(
	state: SessionFermentV2,
	items: TodoItem[] = [],
	lessons: readonly FermentV2Lesson[] = noLessons,
): string {
	return fermentV2ProgressFingerprint(state, items.length ? todoState(items) : undefined, lessons)
}

describe("deriveContinuationDecision (evaluator verdicts)", () => {
	it("counts an unchanged fingerprint without substantive tool use as unchanged", () => {
		const state = fermentV2()
		const state2 = { ...state, unchangedContinuationTurns: 1 }
		const decision = deriveContinuationDecision({
			verdict: "continue",
			reason: "More work is required.",
			evaluated: state2,
			previousEvaluation: undefined,
			todoState: todoState(todos({ status: "in_progress" })),
			lessons: noLessons,
			startFingerprint: fingerprintOf(state2, todos({ status: "in_progress" })),
			hadSubstantiveToolUse: false,
		})
		expect(decision).toEqual({ reason: "More work is required.", unchanged: 2 })
	})

	it("resets the counter when substantive tool use ran", () => {
		const state = { ...fermentV2(), unchangedContinuationTurns: 2 }
		const decision = deriveContinuationDecision({
			verdict: "continue",
			reason: "More work is required.",
			evaluated: state,
			previousEvaluation: undefined,
			todoState: todoState(todos({ status: "in_progress" })),
			lessons: noLessons,
			startFingerprint: fingerprintOf(state, todos({ status: "in_progress" })),
			hadSubstantiveToolUse: true,
		})
		expect(decision.unchanged).toBe(0)
	})

	it("resets the counter when the fingerprint changed despite no tool use", () => {
		const state = { ...fermentV2(), unchangedContinuationTurns: 2 }
		const decision = deriveContinuationDecision({
			verdict: "continue",
			reason: "More work is required.",
			evaluated: state,
			previousEvaluation: undefined,
			todoState: todoState(todos({ status: "in_progress" })),
			lessons: noLessons,
			startFingerprint: "a-different-fingerprint",
			hadSubstantiveToolUse: false,
		})
		expect(decision.unchanged).toBe(0)
	})

	it("applies repeatedGap only to evaluator continue verdicts on an unchanged fingerprint", () => {
		const state = { ...fermentV2(), unchangedContinuationTurns: 0 }
		const items = todos({ status: "in_progress" })
		const startFingerprint = fingerprintOf(state, items)
		const decision = deriveContinuationDecision({
			verdict: "continue",
			reason: "Same gap.",
			evaluated: state,
			previousEvaluation: { verdict: "continue", reason: "Same gap.", evaluatedAt: "2026-10-01T10:00:01.000Z" },
			todoState: todoState(items),
			lessons: noLessons,
			startFingerprint,
			hadSubstantiveToolUse: true,
		})
		// Substantive tool use ran, but the same evaluator gap repeated on an unchanged fingerprint.
		expect(decision.unchanged).toBe(1)
	})

	it("does not count a repeated gap whose reason changed", () => {
		const state = { ...fermentV2(), unchangedContinuationTurns: 1 }
		const decision = deriveContinuationDecision({
			verdict: "continue",
			reason: "A new gap.",
			evaluated: state,
			previousEvaluation: { verdict: "continue", reason: "An older gap.", evaluatedAt: "2026-10-01T10:00:01.000Z" },
			todoState: todoState(todos({ status: "in_progress" })),
			lessons: noLessons,
			startFingerprint: fingerprintOf(state, todos({ status: "in_progress" })),
			hadSubstantiveToolUse: true,
		})
		expect(decision.unchanged).toBe(0)
	})

	it("does not count a met verdict without todos as a repeated evaluator gap", () => {
		const state = { ...fermentV2(), unchangedContinuationTurns: 0 }
		const decision = deriveContinuationDecision({
			verdict: "met",
			reason: "All requirements are evidenced.",
			evaluated: state,
			previousEvaluation: {
				verdict: "continue",
				reason: "All requirements are evidenced.",
				evaluatedAt: "2026-10-01T10:00:01.000Z",
			},
			todoState: undefined,
			lessons: noLessons,
			startFingerprint: fingerprintOf(state),
			hadSubstantiveToolUse: false,
		})
		// met without a visible Todo list nudges Todo creation and counts as unchanged, but not via repeatedGap.
		expect(decision.reason).toContain("Create a visible Todo list now")
		expect(decision.unchanged).toBe(1)
	})

	it("keeps a met verdict with a visible but unsettled Todo list task-facing", () => {
		const state = { ...fermentV2(), unchangedContinuationTurns: 2 }
		const items = todos({ status: "in_progress" })
		const decision = deriveContinuationDecision({
			verdict: "met",
			reason: "All requirements are evidenced.",
			evaluated: state,
			previousEvaluation: undefined,
			todoState: todoState(items),
			lessons: noLessons,
			startFingerprint: fingerprintOf(state, items),
			hadSubstantiveToolUse: false,
		})
		expect(decision.reason).toBe("Keep a visible, fully completed Todo list before finishing.")
		expect(decision.unchanged).toBe(3)
	})
})

describe("deriveHostContinuationDecision (stop without a claim)", () => {
	it("counts as unchanged only with no substantive tool use and an unchanged fingerprint", () => {
		const state = { ...fermentV2(), unchangedContinuationTurns: 1 }
		const items = todos({ status: "in_progress" })
		const decision = deriveHostContinuationDecision({
			evaluated: state,
			todoState: todoState(items),
			lessons: noLessons,
			startFingerprint: fingerprintOf(state, items),
			hadSubstantiveToolUse: false,
		})
		expect(decision.unchanged).toBe(2)
	})

	it("resets when substantive tool use ran", () => {
		const state = { ...fermentV2(), unchangedContinuationTurns: 2 }
		const decision = deriveHostContinuationDecision({
			evaluated: state,
			todoState: todoState(todos({ status: "in_progress" })),
			lessons: noLessons,
			startFingerprint: fingerprintOf(state, todos({ status: "in_progress" })),
			hadSubstantiveToolUse: true,
		})
		expect(decision.unchanged).toBe(0)
	})

	it("resets when the Todo/lesson fingerprint changed", () => {
		const state = { ...fermentV2(), unchangedContinuationTurns: 2 }
		const items = todos({ status: "in_progress" })
		const decision = deriveHostContinuationDecision({
			evaluated: state,
			todoState: todoState(todos({ status: "completed" })),
			lessons: noLessons,
			startFingerprint: fingerprintOf(state, items),
			hadSubstantiveToolUse: false,
		})
		expect(decision.unchanged).toBe(0)
	})

	it("never applies a repeated evaluator gap, even with an identical prior continue verdict", () => {
		const state = { ...fermentV2(), unchangedContinuationTurns: 0 }
		const items = todos({ status: "in_progress" })
		const startFingerprint = fingerprintOf(state, items)
		// The same evaluator reason recorded earlier must not make a host continuation
		// "unchanged" while substantive tool use ran.
		const withSameReason = deriveHostContinuationDecision({
			evaluated: {
				...state,
				lastEvaluation: { verdict: "continue", reason: "Same gap.", evaluatedAt: "2026-10-01T10:00:01.000Z" },
			},
			todoState: todoState(items),
			lessons: noLessons,
			startFingerprint,
			hadSubstantiveToolUse: true,
		})
		expect(withSameReason.unchanged).toBe(0)
	})

	it("counts durable lesson changes as progress", () => {
		const state = { ...fermentV2(), unchangedContinuationTurns: 2 }
		const items = todos({ status: "completed", note: "Evidence: verified" })
		const lessons: FermentV2Lesson[] = [{ todoId: 1, kind: "evidence", text: "verified" }]
		const decision = deriveHostContinuationDecision({
			evaluated: state,
			todoState: todoState(items),
			lessons,
			startFingerprint: fingerprintOf(state, items),
			hadSubstantiveToolUse: false,
		})
		expect(decision.unchanged).toBe(0)
	})
})
