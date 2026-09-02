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
				id: "billing-low-0",
				tone: "warning",
				showPrefix: false,
			}),
		])
	})

	// A zero balance while the server keeps serving is a steady state for free-tier users, not a
	// failure, so it must not render as an error.
	it("uses warning tone when a zero balance only means reduced rate limits", () => {
		setBillingStatusForTest({
			plan: "community",
			isPaidTier: false,
			creditStatus: "ok",
			restrictedMode: false,
			remainingCredits: 0,
			updatedAt: "2026-08-04T00:00:00.000Z",
		})

		expect(createBillingTipProvider().getTips()).toEqual([
			expect.objectContaining({
				id: "billing-rate-limited-0",
				tone: "warning",
				showPrefix: false,
			}),
		])
	})

	it("uses warning tone when Community inference is blocked", () => {
		setBillingStatusForTest({
			plan: "community",
			isPaidTier: false,
			creditStatus: "ok",
			restrictedMode: true,
			remainingCredits: 0,
			updatedAt: "2026-08-19T00:00:00.000Z",
		})

		expect(createBillingTipProvider().getTips()).toEqual([
			expect.objectContaining({
				id: "billing-community-inference-blocked-0",
				tone: "warning",
				showPrefix: false,
			}),
		])
	})

	// restrictedMode is has_credits=false: the server refuses the request outright, which is the one
	// credit state that is genuinely an error rather than a slowdown.
	it("uses error tone for exhausted-credit warnings", () => {
		setBillingStatusForTest({
			plan: "coder",
			isPaidTier: true,
			creditStatus: "exhausted",
			restrictedMode: true,
			remainingCredits: 0,
			updatedAt: "2026-07-08T00:00:00.000Z",
		})

		expect(createBillingTipProvider().getTips()).toEqual([
			expect.objectContaining({
				id: "billing-exhausted-0",
				tone: "error",
				showPrefix: false,
			}),
		])
	})
})
