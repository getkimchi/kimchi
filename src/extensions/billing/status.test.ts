import { beforeEach, describe, expect, it } from "vitest"

const {
	BILLING_EXHAUSTED_MESSAGE,
	COMMUNITY_TIER_HEADER_NOTICE,
	configureBillingCreditsApi,
	creditsEndpointFromLlmEndpoint,
	getBillingStatus,
	getBillingStatusLine,
	getBillingWarning,
	getCommunityTierHeaderNotice,
	observeCreditsPayload,
	refreshBillingStatus,
	refreshBillingStatusFromConfig,
	setBillingStatusForTest,
	subscribeBillingStatus,
} = await import("./status.js")

describe("billing status", () => {
	beforeEach(() => {
		configureBillingCreditsApi({})
		setBillingStatusForTest(undefined)
	})

	it("derives the credits endpoint from root and OpenAI-compatible LLM endpoints", () => {
		expect(creditsEndpointFromLlmEndpoint("https://llm.kimchi.dev")).toBe("https://llm.kimchi.dev/v1/credits")
		expect(creditsEndpointFromLlmEndpoint("https://llm.kimchi.dev/openai/v1")).toBe("https://llm.kimchi.dev/v1/credits")
		expect(creditsEndpointFromLlmEndpoint("https://llm.kimchi.dev/openai/v1/")).toBe(
			"https://llm.kimchi.dev/v1/credits",
		)
	})

	it("maps the proxy Community tier to header upsell without paid warnings", () => {
		observeCreditsPayload({
			serverless: true,
			tier: "community",
			is_paid_tier: false,
			billing_status: "depleted",
			has_credits: false,
			remaining: 0,
		})

		expect(getBillingStatus()).toMatchObject({
			serverless: true,
			plan: "community",
			isPaidTier: false,
			creditStatus: "exhausted",
			remainingCredits: 0,
		})
		expect(getCommunityTierHeaderNotice()).toBe(COMMUNITY_TIER_HEADER_NOTICE)
		expect(getBillingWarning()).toBeUndefined()
		expect(getBillingStatusLine()).toEqual({ text: "Community: €0", tone: "dim" })
	})

	it("still accepts internal free/free-slow tiers if proxy mapping is not deployed yet", () => {
		observeCreditsPayload({
			serverless: true,
			tier: "free-slow",
			is_paid_tier: false,
			billing_status: "free_tier",
			has_credits: true,
			remaining: "2",
		})

		expect(getBillingStatus()).toMatchObject({
			plan: "community",
			isPaidTier: false,
			creditStatus: "ok",
			remainingCredits: 2,
		})
		expect(getCommunityTierHeaderNotice()).toBe(COMMUNITY_TIER_HEADER_NOTICE)
		expect(getBillingWarning()).toBeUndefined()
		expect(getBillingStatusLine()).toEqual({ text: "Community: €2", tone: "dim" })
	})

	it("maps legacy paid tier names to Coder and uses billing_status for warnings", () => {
		observeCreditsPayload({
			serverless: true,
			tier: "starter",
			is_paid_tier: true,
			billing_status: "low_balance",
			remaining: "4.5",
		})

		expect(getBillingStatus()).toMatchObject({
			plan: "coder",
			isPaidTier: true,
			creditStatus: "low",
			remainingCredits: 4.5,
		})
		expect(getCommunityTierHeaderNotice()).toBeUndefined()
		expect(getBillingWarning()?.message).toContain("€4.5 remaining")
		expect(getBillingStatusLine()).toEqual({ text: "Coder: €4.5", tone: "accent" })
	})

	it("shows a low-credit warning for paid users when billing_status is low_balance", () => {
		observeCreditsPayload({
			serverless: true,
			tier: "coder",
			is_paid_tier: true,
			billing_status: "low_balance",
			has_credits: true,
			remaining: "5",
		})

		expect(getBillingWarning()).toEqual({
			kind: "low",
			message:
				"Heads up: your credits are running low (€5 remaining). Top up now to avoid slowdowns and rate limits: app.kimchi.dev/billing",
		})
	})

	it("shows a generic low-credit warning when billing_status is low_balance without a balance", () => {
		observeCreditsPayload({
			serverless: true,
			tier: "coder",
			is_paid_tier: true,
			billing_status: "low_balance",
		})

		expect(getBillingWarning()).toEqual({
			kind: "low",
			message:
				"Heads up: your credits are running low. Top up now to avoid slowdowns and rate limits: app.kimchi.dev/billing",
		})
		expect(getBillingStatusLine()).toEqual({ text: "Coder", tone: "accent" })
	})

	it("accepts backend-style credit fields during rollout", () => {
		observeCreditsPayload({
			serverless: true,
			tierName: "starter",
			isPaidTier: true,
			billingStatus: "BILLING_STATUS_LOW_BALANCE",
			hasCredits: true,
			remaining: "4",
			creditsResetAt: "2026-08-01T00:00:00Z",
		})

		expect(getBillingStatus()).toMatchObject({
			plan: "coder",
			isPaidTier: true,
			creditStatus: "low",
			restrictedMode: false,
			remainingCredits: 4,
		})
		expect(getBillingWarning()?.message).toContain("€4 remaining")
		expect(getBillingStatusLine()).toEqual({ text: "Coder: €4", tone: "accent" })
	})

	it("does not warn on low remaining credits when billing_status is ok", () => {
		observeCreditsPayload({
			serverless: true,
			tier: "coder",
			is_paid_tier: true,
			billing_status: "ok",
			remaining: "4",
		})

		expect(getBillingStatus()).toMatchObject({ plan: "coder", isPaidTier: true, creditStatus: "ok" })
		expect(getBillingWarning()).toBeUndefined()
		expect(getBillingStatusLine()).toEqual({ text: "Coder: €4", tone: "accent" })
	})

	it("shows exhausted warning for paid credits API depletion", () => {
		observeCreditsPayload({
			serverless: true,
			tier: "teams",
			is_paid_tier: true,
			billing_status: "depleted",
			has_credits: false,
			remaining: "0",
		})

		expect(getBillingWarning()).toEqual({
			kind: "exhausted",
			message: BILLING_EXHAUSTED_MESSAGE,
		})
		expect(getBillingStatusLine()).toEqual({ text: "Teams: €0", tone: "accent" })
	})

	it("treats old-mothership snapshots with omitted tier as paid/unknown display, not Community", () => {
		observeCreditsPayload({
			serverless: true,
			has_credits: true,
			remaining: "12.5",
			included: "50",
			additional_credits: "0",
		})

		expect(getBillingStatus()).toMatchObject({
			serverless: true,
			remainingCredits: 12.5,
			restrictedMode: false,
		})
		expect(getBillingStatus()?.plan).toBeUndefined()
		expect(getBillingStatus()?.isPaidTier).toBeUndefined()
		expect(getCommunityTierHeaderNotice()).toBeUndefined()
		expect(getBillingWarning()).toBeUndefined()
		expect(getBillingStatusLine()).toEqual({ text: "Credits: €12.5", tone: "accent" })
	})

	it("does not show Community upsell when credits API omits tier during rollout", () => {
		observeCreditsPayload({
			serverless: true,
			is_paid_tier: true,
			billing_status: "low_balance",
			remaining: "5",
		})

		expect(getBillingStatus()).toMatchObject({ isPaidTier: true, creditStatus: "low", remainingCredits: 5 })
		expect(getCommunityTierHeaderNotice()).toBeUndefined()
		expect(getBillingWarning()?.kind).toBe("low")
		expect(getBillingStatusLine()).toEqual({ text: "Credits: €5", tone: "accent" })
	})

	it("matches backend low-balance fallback threshold when billing_status is absent", () => {
		observeCreditsPayload({
			serverless: true,
			tier: "coder",
			is_paid_tier: true,
			remaining: "5",
		})

		expect(getBillingWarning()).toBeUndefined()

		observeCreditsPayload({
			serverless: true,
			tier: "coder",
			is_paid_tier: true,
			remaining: "4.99",
		})

		expect(getBillingWarning()?.kind).toBe("low")
	})

	it("clears billing UI state for BYO-only credits API payloads", () => {
		observeCreditsPayload({
			serverless: true,
			tier: "coder",
			is_paid_tier: true,
			billing_status: "depleted",
			remaining: "0",
		})
		expect(getBillingWarning()?.kind).toBe("exhausted")

		observeCreditsPayload({ serverless: false })

		expect(getBillingStatus()).toMatchObject({ serverless: false })
		expect(getBillingStatus()?.plan).toBeUndefined()
		expect(getBillingWarning()).toBeUndefined()
	})

	it("clears stale paid warning fields when a full API snapshot reports recovery", () => {
		observeCreditsPayload({
			serverless: true,
			tier: "coder",
			is_paid_tier: true,
			billing_status: "depleted",
			has_credits: false,
			remaining: "0",
		})
		expect(getBillingWarning()?.kind).toBe("exhausted")

		observeCreditsPayload({
			serverless: true,
			tier: "coder",
			is_paid_tier: true,
			billing_status: "ok",
			has_credits: true,
			remaining: "10",
		})

		expect(getBillingStatus()).toMatchObject({
			plan: "coder",
			isPaidTier: true,
			creditStatus: "ok",
			restrictedMode: false,
			remainingCredits: 10,
		})
		expect(getBillingWarning()).toBeUndefined()
		expect(getBillingStatusLine()).toEqual({ text: "Coder: €10", tone: "accent" })
	})

	it("clears stale billing state when credentials change", () => {
		configureBillingCreditsApi({ apiKey: "old-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
		observeCreditsPayload({
			serverless: true,
			tier: "coder",
			is_paid_tier: true,
			billing_status: "low_balance",
			remaining: "5",
		})
		expect(getBillingWarning()?.kind).toBe("low")

		configureBillingCreditsApi({ apiKey: "new-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })

		expect(getBillingStatus()).toBeUndefined()
		expect(getBillingWarning()).toBeUndefined()
	})

	it("discards stale in-flight refreshes after credentials change", async () => {
		configureBillingCreditsApi({ apiKey: "old-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
		let resolveResponse!: (response: Response) => void
		const response = new Promise<Response>((resolve) => {
			resolveResponse = resolve
		})
		const fetchImpl = ((input: RequestInfo | URL) => {
			expect(String(input)).toBe("https://llm.kimchi.dev/v1/credits")
			return response
		}) as typeof fetch

		const refresh = refreshBillingStatus({ fetch: fetchImpl })

		configureBillingCreditsApi({ apiKey: "new-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
		resolveResponse(
			new Response(
				JSON.stringify({
					serverless: true,
					tier: "community",
					is_paid_tier: false,
					billing_status: "free_tier",
					has_credits: true,
					remaining: "2",
				}),
				{ status: 200 },
			),
		)

		await expect(refresh).resolves.toBeUndefined()
		expect(getBillingStatus()).toBeUndefined()
		expect(getCommunityTierHeaderNotice()).toBeUndefined()
	})

	it("discards older overlapping refreshes for the same credentials", async () => {
		configureBillingCreditsApi({ apiKey: "api-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
		let resolveFirstResponse!: (response: Response) => void
		let resolveSecondResponse!: (response: Response) => void
		const firstResponse = new Promise<Response>((resolve) => {
			resolveFirstResponse = resolve
		})
		const secondResponse = new Promise<Response>((resolve) => {
			resolveSecondResponse = resolve
		})
		const responses = [firstResponse, secondResponse]
		const fetchImpl = ((input: RequestInfo | URL) => {
			expect(String(input)).toBe("https://llm.kimchi.dev/v1/credits")
			const response = responses.shift()
			if (!response) throw new Error("unexpected billing refresh")
			return response
		}) as typeof fetch

		const olderRefresh = refreshBillingStatus({ fetch: fetchImpl })
		const newerRefresh = refreshBillingStatus({ fetch: fetchImpl })

		resolveSecondResponse(
			new Response(
				JSON.stringify({
					serverless: true,
					tier: "coder",
					is_paid_tier: true,
					billing_status: "low_balance",
					has_credits: true,
					remaining: "5",
				}),
				{ status: 200 },
			),
		)

		await expect(newerRefresh).resolves.toMatchObject({ creditStatus: "low", remainingCredits: 5 })
		expect(getBillingWarning()?.kind).toBe("low")

		resolveFirstResponse(
			new Response(
				JSON.stringify({
					serverless: true,
					tier: "coder",
					is_paid_tier: true,
					billing_status: "ok",
					has_credits: true,
					remaining: "10",
				}),
				{ status: 200 },
			),
		)

		await expect(olderRefresh).resolves.toBeUndefined()
		expect(getBillingStatus()).toMatchObject({ creditStatus: "low", remainingCredits: 5 })
	})

	it("times out a credits response body that never finishes", async () => {
		configureBillingCreditsApi({ apiKey: "api-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
		const fetchImpl = (() =>
			Promise.resolve({
				ok: true,
				json: () => new Promise<unknown>(() => {}),
			} as Response)) as typeof fetch

		await expect(refreshBillingStatus({ fetch: fetchImpl, jsonTimeoutMs: 1 })).resolves.toBeUndefined()
		expect(getBillingStatus()).toBeUndefined()
	})

	it("treats config load failures as a missing billing refresh", async () => {
		await expect(
			refreshBillingStatusFromConfig({
				loadConfig: () => {
					throw new Error("bad config")
				},
			}),
		).resolves.toBeUndefined()
		expect(getBillingStatus()).toBeUndefined()
	})

	it("clears stale paid warning fields when a full API snapshot omits them", () => {
		observeCreditsPayload({
			serverless: true,
			tier: "coder",
			is_paid_tier: true,
			billing_status: "depleted",
			has_credits: false,
			remaining: "0",
		})
		expect(getBillingWarning()?.kind).toBe("exhausted")

		observeCreditsPayload({
			serverless: true,
			tier: "coder",
			is_paid_tier: true,
			remaining: "10",
		})

		expect(getBillingStatus()).toMatchObject({ plan: "coder", remainingCredits: 10 })
		expect(getBillingStatus()?.creditStatus).toBeUndefined()
		expect(getBillingStatus()?.restrictedMode).toBeUndefined()
		expect(getBillingWarning()).toBeUndefined()
	})

	it("clears a stale Community plan when a rollout snapshot omits tier", () => {
		observeCreditsPayload({
			serverless: true,
			tier: "community",
			is_paid_tier: false,
			billing_status: "free_tier",
			has_credits: true,
			remaining: "3",
		})
		expect(getCommunityTierHeaderNotice()).toBe(COMMUNITY_TIER_HEADER_NOTICE)

		observeCreditsPayload({
			serverless: true,
			has_credits: true,
			remaining: "10",
		})

		expect(getBillingStatus()?.plan).toBeUndefined()
		expect(getBillingStatus()?.isPaidTier).toBeUndefined()
		expect(getCommunityTierHeaderNotice()).toBeUndefined()
		expect(getBillingStatusLine()).toEqual({ text: "Credits: €10", tone: "accent" })
	})

	it("ignores absent and malformed credits payloads without changing state", () => {
		const calls: Array<unknown> = []
		const unsubscribe = subscribeBillingStatus((status) => calls.push(status))
		try {
			expect(observeCreditsPayload({ other: "value" })).toBeUndefined()
			expect(observeCreditsPayload(null)).toBeUndefined()
			expect(getBillingStatus()).toBeUndefined()
			expect(calls).toEqual([])
		} finally {
			unsubscribe()
		}
	})
})
