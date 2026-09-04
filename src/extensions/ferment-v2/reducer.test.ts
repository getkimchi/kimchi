import { describe, expect, it } from "vitest"
import {
	addFermentV2Accounting,
	clearFermentV2,
	clearFermentV2Entry,
	createFermentV2,
	editFermentV2,
	putFermentV2Entry,
	recordFermentV2Evaluation,
	replaceFermentV2,
	restoreFermentV2,
	setFermentV2ConsecutiveErrorTurns,
	setFermentV2Status,
	setFermentV2UnchangedContinuationTurns,
} from "./reducer.js"

const T1 = "2026-07-16T10:00:00.000Z"
const T2 = "2026-07-16T10:01:00.000Z"

describe("Ferment V2 reducer", () => {
	it("creates revision one and preserves meaningful internal whitespace", () => {
		const fermentV2 = createFermentV2(undefined, "  first line\n\n  second line  ", "ferment-v2-a", T1)

		expect(fermentV2).toEqual({
			schemaVersion: 1,
			id: "ferment-v2-a",
			revision: 1,
			objective: "first line\n\n  second line",
			status: "active",
			tokensUsed: 0,
			timeUsedMs: 0,
			createdAt: T1,
			updatedAt: T1,
		})
	})

	it("rejects empty objectives and preserves objectives longer than 4,000 characters", () => {
		expect(() => createFermentV2(undefined, " \n ", "ferment-v2-a", T1)).toThrow("Ferment V2 objective cannot be empty")
		expect(createFermentV2(undefined, "x".repeat(4_001), "ferment-v2-a", T1).objective).toHaveLength(4_001)
		expect(
			editFermentV2(createFermentV2(undefined, "old", "ferment-v2-a", T1), "ferment-v2-a", 1, "x".repeat(4_001), T2)
				.objective,
		).toHaveLength(4_001)
	})

	it("edits in place by incrementing revision and preserving status", () => {
		const paused = setFermentV2Status(
			createFermentV2(undefined, "old", "ferment-v2-a", T1),
			"ferment-v2-a",
			1,
			"paused",
			T2,
		)
		const evaluated = recordFermentV2Evaluation(
			paused,
			"ferment-v2-a",
			1,
			{ verdict: "met", reason: "Old objective met", evaluatedAt: T2 },
			T2,
		)
		const edited = editFermentV2({ ...evaluated, completionConfidence: "tested" }, "ferment-v2-a", 1, "new", T2)

		expect(edited).toMatchObject({ id: "ferment-v2-a", revision: 2, objective: "new", status: "paused" })
		expect(edited.createdAt).toBe(T1)
		expect(edited).not.toHaveProperty("lastEvaluation")
		expect(edited).not.toHaveProperty("completionConfidence")
	})

	it("replaces with a new ID, revision one, and active status", () => {
		const replacement = replaceFermentV2("new", "ferment-v2-b", T2)

		expect(replacement).toMatchObject({ id: "ferment-v2-b", revision: 1, objective: "new", status: "active" })
	})

	it("rejects stale IDs and revisions", () => {
		const fermentV2 = createFermentV2(undefined, "old", "ferment-v2-a", T1)

		expect(() => editFermentV2(fermentV2, "ferment-v2-b", 1, "new", T2)).toThrow(
			/current Ferment V2 is ferment-v2-a revision 1/,
		)
		expect(() => setFermentV2Status(fermentV2, "ferment-v2-a", 2, "complete", T2)).toThrow(
			/current Ferment V2 is ferment-v2-a revision 1/,
		)
		expect(() => clearFermentV2(undefined, "ferment-v2-a", 1)).toThrow("no current Ferment V2 exists")
	})

	it("accumulates Ferment V2 time and tokens while rejecting another Ferment V2 ID", () => {
		const fermentV2 = createFermentV2(undefined, "old", "ferment-v2-a", T1, 1_500)
		const active = addFermentV2Accounting(fermentV2, "ferment-v2-a", 1_499, 2_000, T2)
		const accounted = addFermentV2Accounting(active, "ferment-v2-a", 1, 500, T2)

		expect(active).toMatchObject({ status: "active", tokenBudget: 1_500 })
		expect(accounted).toMatchObject({
			status: "budget_limited",
			tokenBudget: 1_500,
			tokensUsed: 1_500,
			timeUsedMs: 2_500,
			updatedAt: T2,
		})
		expect(() => addFermentV2Accounting(accounted, "ferment-v2-b", 1, 1, T2)).toThrow(
			/current Ferment V2 is ferment-v2-a/,
		)
	})

	it("re-applies the budget check when resuming a Ferment V2 that is already over budget", () => {
		const fermentV2 = createFermentV2(undefined, "old", "ferment-v2-a", T1, 1_500)
		const overBudget = addFermentV2Accounting(fermentV2, "ferment-v2-a", 1_500, 1_000, T2)
		expect(overBudget).toMatchObject({ status: "budget_limited" })

		const resumed = setFermentV2Status(overBudget, "ferment-v2-a", 1, "active", T2)

		expect(resumed).toMatchObject({ status: "budget_limited", tokenBudget: 1_500, tokensUsed: 1_500 })
	})

	it("normalizes and persists blocked reasons, then clears them on resume", () => {
		const fermentV2 = createFermentV2(undefined, "old", "ferment-v2-a", T1)
		const blocked = setFermentV2Status(fermentV2, "ferment-v2-a", 1, "blocked", T2, "  needs user input  ")

		expect(blocked).toMatchObject({ status: "blocked", blockedReason: "needs user input" })
		expect(restoreFermentV2([putFermentV2Entry(blocked)])).toEqual(blocked)

		const resumed = setFermentV2Status(blocked, "ferment-v2-a", 1, "active", T2)
		expect(resumed).not.toHaveProperty("blockedReason")
	})

	it("defaults and bounds blocked reasons while ignoring them for other statuses", () => {
		const fermentV2 = createFermentV2(undefined, "old", "ferment-v2-a", T1)

		expect(setFermentV2Status(fermentV2, "ferment-v2-a", 1, "blocked", T2, "  ")).toMatchObject({
			blockedReason: "Ferment V2 marked blocked.",
		})
		expect(
			setFermentV2Status(fermentV2, "ferment-v2-a", 1, "blocked", T2, "x".repeat(1_001)).blockedReason,
		).toHaveLength(1_000)

		const entry = {
			...putFermentV2Entry(fermentV2),
			fermentV2: { ...fermentV2, blockedReason: "stale reason" },
		}
		expect(restoreFermentV2([entry])).not.toHaveProperty("blockedReason")
	})

	it("strips completionConfidence when restoring a Ferment V2 that is not complete", () => {
		const fermentV2 = createFermentV2(undefined, "old", "ferment-v2-a", T1)
		const entry = {
			...putFermentV2Entry(fermentV2),
			fermentV2: { ...fermentV2, status: "active", completionConfidence: "proven" },
		}

		const restored = restoreFermentV2([entry])

		expect(restored).not.toHaveProperty("completionConfidence")
	})

	it("replays puts and matching clear tombstones in branch order", () => {
		const revision1 = createFermentV2(undefined, "one", "ferment-v2-a", T1)
		const revision2 = {
			...editFermentV2(revision1, "ferment-v2-a", 1, "two", T2),
			status: "complete" as const,
			completionConfidence: "proven" as const,
		}
		const unrelatedClear = clearFermentV2Entry({ ...revision2, id: "other" }, T2)

		expect(
			restoreFermentV2([{ bad: true }, putFermentV2Entry(revision1), putFermentV2Entry(revision2), unrelatedClear]),
		).toEqual(revision2)
		expect(
			restoreFermentV2([
				putFermentV2Entry(revision1),
				putFermentV2Entry(revision2),
				clearFermentV2Entry(revision2, T2),
			]),
		).toBeUndefined()
		expect(restoreFermentV2([putFermentV2Entry(revision2)], revision1)).toEqual(revision2)
		expect(restoreFermentV2([clearFermentV2Entry(revision2, T2)], revision2)).toBeUndefined()
	})

	it("restores persisted objectives longer than 4,000 characters", () => {
		const persisted = { ...createFermentV2(undefined, "old", "ferment-v2-a", T1), objective: "x".repeat(4_001) }
		expect(restoreFermentV2([putFermentV2Entry(persisted)])?.objective).toHaveLength(4_001)
	})

	it("records guarded evaluations and round-trips them", () => {
		const fermentV2 = createFermentV2(undefined, "ship", "ferment-v2-a", T1)
		const first = recordFermentV2Evaluation(
			fermentV2,
			"ferment-v2-a",
			1,
			{ verdict: "continue", reason: "missing smoke", model: "test/judge", evaluatedAt: T2 },
			T2,
		)
		const second = recordFermentV2Evaluation(
			first,
			"ferment-v2-a",
			1,
			{ verdict: "met", reason: "all checks pass", model: "test/judge", evaluatedAt: T2 },
			T2,
		)

		expect(restoreFermentV2([putFermentV2Entry(second)])).toEqual(second)
		expect(second).toMatchObject({
			evaluationCount: 2,
			lastEvaluation: { verdict: "met", reason: "all checks pass" },
		})
		expect(() =>
			recordFermentV2Evaluation(
				fermentV2,
				"ferment-v2-a",
				2,
				{ verdict: "met", reason: "all checks pass", evaluatedAt: T2 },
				T2,
			),
		).toThrow(/current Ferment V2 is ferment-v2-a revision 1/)
	})

	it.each([
		{
			name: "consecutive-error",
			field: "consecutiveErrorTurns",
			value: 2,
			set: setFermentV2ConsecutiveErrorTurns,
			invalidId: "ferment-v2-b",
			invalidRevision: 1,
			error: /current Ferment V2 is ferment-v2-a/,
		},
		{
			name: "unchanged-continuation",
			field: "unchangedContinuationTurns",
			value: 3,
			set: setFermentV2UnchangedContinuationTurns,
			invalidId: "ferment-v2-a",
			invalidRevision: 2,
			error: /current Ferment V2 is ferment-v2-a revision 1/,
		},
	] as const)("sets and clears the $name counter, omitting it at zero", ({
		field,
		value,
		set,
		invalidId,
		invalidRevision,
		error,
	}) => {
		const fermentV2 = createFermentV2(undefined, "ship", "ferment-v2-a", T1)
		const withValue = set(fermentV2, "ferment-v2-a", 1, value, T2)

		expect(withValue).toMatchObject({ [field]: value, updatedAt: T2 })
		expect(set(withValue, "ferment-v2-a", 1, 0, T2)).not.toHaveProperty(field)
		expect(set(fermentV2, "ferment-v2-a", 1, 0, T2)).toBe(fermentV2)
		expect(() => set(fermentV2, invalidId, invalidRevision, 1, T2)).toThrow(error)
	})

	it("round-trips the stall-guard counters through put and restore", () => {
		const fermentV2 = {
			...createFermentV2(undefined, "ship", "ferment-v2-a", T1),
			consecutiveErrorTurns: 2,
			unchangedContinuationTurns: 1,
		}

		expect(restoreFermentV2([putFermentV2Entry(fermentV2)])).toEqual(fermentV2)
	})

	it("rejects the whole restored Ferment V2 when a stall-guard counter is malformed", () => {
		const fermentV2 = createFermentV2(undefined, "ship", "ferment-v2-a", T1)
		const negativeEntry = { ...putFermentV2Entry(fermentV2), fermentV2: { ...fermentV2, consecutiveErrorTurns: -1 } }
		expect(restoreFermentV2([negativeEntry])).toBeUndefined()

		const fractionalEntry = {
			...putFermentV2Entry(fermentV2),
			fermentV2: { ...fermentV2, unchangedContinuationTurns: 1.5 },
		}
		expect(restoreFermentV2([fractionalEntry])).toBeUndefined()

		const withUnchanged = setFermentV2UnchangedContinuationTurns(fermentV2, "ferment-v2-a", 1, 1, T2)
		expect(
			restoreFermentV2([
				putFermentV2Entry(withUnchanged),
				{ ...putFermentV2Entry(withUnchanged), fermentV2: { ...withUnchanged, consecutiveErrorTurns: Number.NaN } },
			]),
		).toEqual(withUnchanged)
	})
})
