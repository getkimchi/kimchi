import { afterEach, describe, expect, it } from "vitest"
import {
	__resetPlanReviewTokensForTest,
	issuePlanReviewToken,
	verifyPlanReviewToken,
} from "./plan-review-provenance.js"

describe("plan-review provenance tokens", () => {
	afterEach(() => {
		__resetPlanReviewTokensForTest()
	})

	it("verifies a token it just issued", () => {
		const token = issuePlanReviewToken()
		expect(verifyPlanReviewToken(token)).toBe(true)
	})

	it("issues distinct tokens", () => {
		expect(issuePlanReviewToken()).not.toBe(issuePlanReviewToken())
	})

	it("rejects tokens that were never issued", () => {
		expect(verifyPlanReviewToken("not-a-real-token")).toBe(false)
	})

	it("rejects non-string values", () => {
		expect(verifyPlanReviewToken(undefined)).toBe(false)
		expect(verifyPlanReviewToken(null)).toBe(false)
		expect(verifyPlanReviewToken(42)).toBe(false)
		expect(verifyPlanReviewToken({})).toBe(false)
	})

	it("keeps tokens valid for reuse (verify does not consume)", () => {
		const token = issuePlanReviewToken()
		expect(verifyPlanReviewToken(token)).toBe(true)
		expect(verifyPlanReviewToken(token)).toBe(true)
	})
})
