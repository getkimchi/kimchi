import { describe, expect, it } from "vitest"
import { RATE_LIMIT_MAX_WAIT_MS } from "../upstream-retry-patch.js"
import { rateLimitNotice } from "./rate-limit-notice.js"

describe("rateLimitNotice", () => {
	const NOW = Date.parse("2026-08-05T16:00:00Z")
	const localTime = (epochMs: number) => new Date(epochMs).toLocaleTimeString(undefined, { timeStyle: "short" })

	it("states the deadline without promising a retry", () => {
		const retryAt = NOW + 4 * 60_000

		const notice = rateLimitNotice(retryAt, "kimi-k2.7", NOW)

		expect(notice).toBe(`kimi-k2.7 is rate limited until ${localTime(retryAt)} (4 minutes).`)
		expect(notice).not.toContain("retrying")
	})

	it("names the remedy when the deadline is past the wait bound", () => {
		const retryAt = NOW + RATE_LIMIT_MAX_WAIT_MS + 60_000

		const notice = rateLimitNotice(retryAt, "kimi-k2.7", NOW)

		expect(notice).toContain("not retrying")
		expect(notice).toContain("/model")
		expect(notice).toContain("https://app.kimchi.dev/billing")
	})

	it("falls back to a generic subject when the model is unknown", () => {
		expect(rateLimitNotice(NOW + 30_000, undefined, NOW)).toBe(
			`Requests are rate limited until ${localTime(NOW + 30_000)} (30 seconds).`,
		)
	})

	// Upstream's retry countdown renders bare seconds, so this is the only place the wait appears
	// in readable units.
	it("reports the wait in human units", () => {
		expect(rateLimitNotice(NOW + 90 * 60_000, undefined, NOW)).toContain("(2 hours)")
	})
})
