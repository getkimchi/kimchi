import { beforeEach, describe, expect, it } from "vitest"
import {
	__getBudgetCorrectionStateForTests,
	__resetBudgetCorrectionStoreForTests,
	clearBudgetCorrectionState,
	clearPendingCorrection,
	getBudgetRetryVerdict,
	isEligibleBudgetRejection,
	peekPendingCorrection,
	recordBudgetRetryVerdict,
	recordOutgoingBudget,
	scheduleCorrection,
} from "./budget-correction-store.js"

const RAW_REJECTION =
	"litellm.BadRequestError: OpenAIException - max_completion_tokens is too large: 512000.This model supports at most 262144 completion tokens."

beforeEach(() => {
	__resetBudgetCorrectionStoreForTests()
})

describe("eligibility", () => {
	it("is eligible when the outgoing request carried the rejected budget uncorrected", () => {
		recordOutgoingBudget("s1", "auto", 512_000, false)
		expect(isEligibleBudgetRejection("s1", "auto", RAW_REJECTION)).toEqual({
			requestedBudget: 512_000,
			limit: 262_144,
		})
	})

	it("is not eligible for an already-corrected attempt (one corrective try per request)", () => {
		recordOutgoingBudget("s1", "auto", 262_144, true)
		expect(
			isEligibleBudgetRejection(
				"s1",
				"auto",
				"max_completion_tokens is too large: 262144.This model supports at most 131072 completion tokens.",
			),
		).toBeUndefined()
	})

	it("is not eligible when the outgoing budget does not match the rejection", () => {
		recordOutgoingBudget("s1", "auto", 131_072, false)
		expect(isEligibleBudgetRejection("s1", "auto", RAW_REJECTION)).toBeUndefined()
	})

	it("is not eligible for a different model's request", () => {
		recordOutgoingBudget("s1", "kimi-k3", 512_000, false)
		expect(isEligibleBudgetRejection("s1", "auto", RAW_REJECTION)).toBeUndefined()
	})

	it("is not eligible without any outgoing record (no request ever went out)", () => {
		expect(isEligibleBudgetRejection("s1", "auto", RAW_REJECTION)).toBeUndefined()
	})

	it("is not eligible for non-budget errors", () => {
		recordOutgoingBudget("s1", "auto", 512_000, false)
		expect(isEligibleBudgetRejection("s1", "auto", "rate limited until tomorrow")).toBeUndefined()
	})
})

describe("pending corrections", () => {
	it("peeks without consuming: retries of the same request keep the correction", () => {
		scheduleCorrection("s1", "auto", 512_000, 262_144)
		expect(peekPendingCorrection("s1", "kimi-k3", 512_000)).toBeUndefined()
		expect(peekPendingCorrection("s1", "auto", 131_072)).toBeUndefined()
		expect(peekPendingCorrection("s1", "auto", undefined)).toBeUndefined()
		expect(__getBudgetCorrectionStateForTests("s1")?.pending).toBeDefined()

		// A transient failure on the corrected attempt triggers upstream's retry —
		// every matching outgoing attempt must be lowered, not just the first.
		expect(peekPendingCorrection("s1", "auto", 512_000)).toBe(262_144)
		expect(peekPendingCorrection("s1", "auto", 512_000)).toBe(262_144)
		expect(__getBudgetCorrectionStateForTests("s1")?.pending).toBeDefined()
	})

	it("never raises: corrected budget is the minimum of requested and limit", () => {
		scheduleCorrection("s1", "auto", 512_000, 262_144)
		expect(peekPendingCorrection("s1", "auto", 512_000)).toBe(262_144)

		scheduleCorrection("s2", "auto", 200_000, 262_144)
		expect(peekPendingCorrection("s2", "auto", 200_000)).toBe(200_000)
	})

	it("clearPendingCorrection drops only the pending correction", () => {
		recordOutgoingBudget("s1", "auto", 512_000, false)
		scheduleCorrection("s1", "auto", 512_000, 262_144)
		clearPendingCorrection("s1")
		expect(__getBudgetCorrectionStateForTests("s1")?.pending).toBeUndefined()
		expect(__getBudgetCorrectionStateForTests("s1")?.lastOutgoing).toBeDefined()
	})

	it("clearBudgetCorrectionState drops everything for the session", () => {
		recordOutgoingBudget("s1", "auto", 512_000, false)
		scheduleCorrection("s1", "auto", 512_000, 262_144)
		clearBudgetCorrectionState("s1")
		expect(__getBudgetCorrectionStateForTests("s1")).toBeUndefined()
	})

	describe("budget retry verdicts", () => {
		it("records and matches the classifier verdict per rejection", () => {
			recordBudgetRetryVerdict("s1", "auto", RAW_REJECTION, true)
			expect(getBudgetRetryVerdict("s1", "auto", RAW_REJECTION)).toBe(true)
			expect(getBudgetRetryVerdict("s1", "auto", "some other error")).toBeUndefined()
			expect(getBudgetRetryVerdict("s1", "kimi-k3", RAW_REJECTION)).toBeUndefined()
			expect(getBudgetRetryVerdict("s2", "auto", RAW_REJECTION)).toBeUndefined()
		})

		it("keeps only the latest verdict and clears with the session state", () => {
			recordBudgetRetryVerdict("s1", "auto", RAW_REJECTION, true)
			recordBudgetRetryVerdict("s1", "auto", "second raw", false)
			expect(getBudgetRetryVerdict("s1", "auto", RAW_REJECTION)).toBeUndefined()
			expect(getBudgetRetryVerdict("s1", "auto", "second raw")).toBe(false)

			clearBudgetCorrectionState("s1")
			expect(getBudgetRetryVerdict("s1", "auto", "second raw")).toBeUndefined()
		})

		it("a new outgoing request invalidates the verdict (no stale refusals)", () => {
			// An earlier refusal (e.g. attempts exhausted mid-turn) must not
			// decide a later identical rejection: once a new request goes out,
			// the verdict is gone and the next evaluation records a fresh one.
			recordBudgetRetryVerdict("s1", "auto", RAW_REJECTION, false)
			expect(getBudgetRetryVerdict("s1", "auto", RAW_REJECTION)).toBe(false)

			recordOutgoingBudget("s1", "auto", 512_000, false)
			expect(getBudgetRetryVerdict("s1", "auto", RAW_REJECTION)).toBeUndefined()

			// The same holds for an earlier eligible verdict.
			recordBudgetRetryVerdict("s1", "auto", RAW_REJECTION, true)
			recordOutgoingBudget("s1", "auto", 262_144, true)
			expect(getBudgetRetryVerdict("s1", "auto", RAW_REJECTION)).toBeUndefined()
		})
	})
})
