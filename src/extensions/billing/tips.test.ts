import { beforeEach, describe, expect, it } from "vitest"
import { setBillingStatusForTest } from "./status.js"
import { createBillingTipProvider } from "./tips.js"

describe("billing tips", () => {
	beforeEach(() => {
		setBillingStatusForTest(undefined)
	})

	it("uses warning tone for low-credit warnings", () => {
		setBillingStatusForTest({
			plan: "coder",
			isPaidTier: true,
			creditStatus: "low",
			remainingCredits: 5,
			updatedAt: "2026-07-08T00:00:00.000Z",
		})

		expect(createBillingTipProvider().getTips()).toEqual([
			expect.objectContaining({
				id: "billing-low",
				tone: "warning",
				showPrefix: false,
			}),
		])
	})

	it("uses error tone for exhausted-credit warnings", () => {
		setBillingStatusForTest({
			plan: "coder",
			isPaidTier: true,
			creditStatus: "exhausted",
			remainingCredits: 0,
			updatedAt: "2026-07-08T00:00:00.000Z",
		})

		expect(createBillingTipProvider().getTips()).toEqual([
			expect.objectContaining({
				id: "billing-exhausted",
				tone: "error",
				showPrefix: false,
			}),
		])
	})
})
