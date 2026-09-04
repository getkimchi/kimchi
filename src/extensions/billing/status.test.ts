import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
	AUTOMATIC_REFRESH_MIN_INTERVAL_MS,
	BILLING_EXHAUSTED_MESSAGE,
	BILLING_RATE_LIMITED_MESSAGE,
	COMMUNITY_TIER_MESSAGES,
	budgetEndpointFromLlmEndpoint,
	configureBillingCreditsApi,
	creditsEndpointFromLlmEndpoint,
	formatBudgetAmount,
	formatBudgetLimit,
	getBillingStatus,
	getBillingStatusLine,
	getBillingWarnings,
	getCommunityTierHeaderNotice,
	observeCreditsPayload,
	refreshBillingStatus,
	refreshBillingStatusFromConfig,
	refreshBillingSnapshot,
	refreshBudgetStatus,
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

	it("derives the budget endpoint alongside credits", () => {
		expect(budgetEndpointFromLlmEndpoint("https://llm.kimchi.dev")).toBe("https://llm.kimchi.dev/v1/budget")
		expect(budgetEndpointFromLlmEndpoint("https://llm.kimchi.dev/openai/v1/")).toBe("https://llm.kimchi.dev/v1/budget")
	})

	it("formats budget spending, limits, and compact thousands", () => {
		expect(formatBudgetAmount("274.594050")).toBe("$274.59")
		expect(formatBudgetAmount("1800")).toBe("$1.8k")
		expect(formatBudgetLimit("500.000000")).toBe("$500")
		expect(formatBudgetLimit("2000.000000")).toBe("$2k")
		expect(formatBudgetLimit("0.000000")).toBe("unlimited")
	})

	it("shows BYO guidance as a warning when Community inference is blocked", () => {
		observeCreditsPayload({
			serverless: true,
			tier: "free-slow",
			is_paid_tier: false,
			billing_status: "free_tier",
			has_credits: false,
			remaining: 0,
		})

		expect(getBillingStatus()).toMatchObject({
			serverless: true,
			plan: "community",
			isPaidTier: false,
			creditStatus: "ok",
			restrictedMode: true,
			remainingCredits: 0,
		})
		expect(getCommunityTierHeaderNotice()).toBeUndefined()
		expect(getBillingWarnings()).toEqual([
			{
				kind: "community-inference-blocked",
				message: COMMUNITY_TIER_MESSAGES.inferenceBlocked,
			},
		])
		expect(getBillingStatusLine()).toEqual({ amount: "$0.00" })
	})

	// The reported failure: a Coder subscriber that exhausts its credits is demoted to a free tier for
	// rate limiting, and the server reports that demoted tier as the billing identity. Every field
	// except `remaining` describes a user who never paid.
	it("warns about rate limiting when a demoted paid subscriber reports as free tier", () => {
		observeCreditsPayload({
			serverless: true,
			tier: "community",
			is_paid_tier: false,
			billing_status: "free_tier",
			has_credits: true,
			remaining: "0",
		})

		expect(getBillingStatus()).toMatchObject({
			plan: "community",
			isPaidTier: false,
			creditStatus: "ok",
			restrictedMode: false,
			remainingCredits: 0,
		})
		expect(getBillingWarnings()[0]).toEqual({ kind: "rate-limited", message: BILLING_RATE_LIMITED_MESSAGE })
		expect(getCommunityTierHeaderNotice()).toBeUndefined()
	})

	// The warning kind turns on who said what: an explicit billing_status outranks the balance
	// inference, so a server that declares depletion is never downgraded to the softer variant.
	it("separates a server-declared depletion from an inferred zero balance", () => {
		observeCreditsPayload({
			serverless: true,
			tier: "coder",
			is_paid_tier: true,
			billing_status: "depleted",
			has_credits: false,
			remaining: "0",
		})
		expect(getBillingWarnings()[0]?.kind).toBe("exhausted")

		// Same declaration, but the payload omits has_credits entirely.
		observeCreditsPayload({ serverless: false })
		observeCreditsPayload({
			serverless: true,
			tier: "coder",
			is_paid_tier: true,
			billing_status: "depleted",
			remaining: "0",
		})
		expect(getBillingWarnings()[0]?.kind).toBe("exhausted")

		// Nothing declared: the balance is the only evidence, and the server is still serving.
		observeCreditsPayload({ serverless: false })
		observeCreditsPayload({
			serverless: true,
			tier: "community",
			is_paid_tier: false,
			billing_status: "free_tier",
			has_credits: true,
			remaining: "0",
		})
		expect(getBillingWarnings()[0]?.kind).toBe("rate-limited")
	})

	it("keeps the Community upsell while a free-tier user still has credits", () => {
		observeCreditsPayload({
			serverless: true,
			tier: "community",
			is_paid_tier: false,
			billing_status: "free_tier",
			has_credits: true,
			remaining: "12",
		})

		expect(getCommunityTierHeaderNotice()).toBe(COMMUNITY_TIER_MESSAGES.available)
		expect(getBillingWarnings()[0]).toBeUndefined()
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
		expect(getCommunityTierHeaderNotice()).toBe(COMMUNITY_TIER_MESSAGES.available)
		expect(getBillingWarnings()[0]).toBeUndefined()
		expect(getBillingStatusLine()).toEqual({ amount: "$2.00" })
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
		expect(getBillingWarnings()[0]?.message).toContain("$4.50 remaining")
		expect(getBillingStatusLine()).toEqual({ amount: "$4.50" })
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

		expect(getBillingWarnings()[0]).toEqual({
			kind: "low",
			message:
				"Heads up: your credits are running low ($5.00 remaining). Top up now to avoid slowdowns and rate limits: https://app.kimchi.dev/billing",
		})
	})

	it("shows a generic low-credit warning when billing_status is low_balance without a balance", () => {
		observeCreditsPayload({
			serverless: true,
			tier: "coder",
			is_paid_tier: true,
			billing_status: "low_balance",
		})

		expect(getBillingWarnings()[0]).toEqual({
			kind: "low",
			message:
				"Heads up: your credits are running low. Top up now to avoid slowdowns and rate limits: https://app.kimchi.dev/billing",
		})
		expect(getBillingStatusLine()).toBeUndefined()
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
		expect(getBillingWarnings()[0]?.message).toContain("$4.00 remaining")
		expect(getBillingStatusLine()).toEqual({ amount: "$4.00" })
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
		expect(getBillingWarnings()[0]).toBeUndefined()
		expect(getBillingStatusLine()).toEqual({ amount: "$4.00" })
	})

	it("formats status-line remaining credits as dollars without the plan name", () => {
		observeCreditsPayload({
			serverless: true,
			tier: "coder",
			is_paid_tier: true,
			billing_status: "ok",
			remaining: "0.10",
		})

		expect(getBillingStatusLine()).toEqual({ amount: "$0.10" })
	})

	it("accepts USD-labelled credits and rejects Euro-labelled credits", () => {
		observeCreditsPayload({
			serverless: true,
			tier: "coder",
			is_paid_tier: true,
			billing_status: "ok",
			remaining: "USD 4.5",
		})
		expect(getBillingStatusLine()).toEqual({ amount: "$4.50" })

		observeCreditsPayload({
			serverless: true,
			tier: "coder",
			is_paid_tier: true,
			billing_status: "ok",
			remaining: "4.5 EUR",
		})
		expect(getBillingStatus()?.remainingCredits).toBeUndefined()
		expect(getBillingStatusLine()).toBeUndefined()
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

		expect(getBillingWarnings()[0]).toEqual({
			kind: "exhausted",
			message: BILLING_EXHAUSTED_MESSAGE,
		})
		expect(getBillingStatusLine()).toEqual({ amount: "$0.00" })
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
		expect(getBillingWarnings()[0]).toBeUndefined()
		expect(getBillingStatusLine()).toEqual({ amount: "$12.50" })
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
		expect(getBillingWarnings()[0]?.kind).toBe("low")
		expect(getBillingStatusLine()).toEqual({ amount: "$5.00" })
	})

	it("matches backend low-balance fallback threshold when billing_status is absent", () => {
		observeCreditsPayload({
			serverless: true,
			tier: "coder",
			is_paid_tier: true,
			remaining: "5",
		})

		expect(getBillingWarnings()[0]).toBeUndefined()

		observeCreditsPayload({
			serverless: true,
			tier: "coder",
			is_paid_tier: true,
			remaining: "4.99",
		})

		expect(getBillingWarnings()[0]?.kind).toBe("low")
	})

	it("clears billing UI state for BYO-only credits API payloads", () => {
		observeCreditsPayload({
			serverless: true,
			tier: "coder",
			is_paid_tier: true,
			billing_status: "depleted",
			remaining: "0",
		})
		expect(getBillingWarnings()[0]?.kind).toBe("exhausted")

		observeCreditsPayload({ serverless: false })

		expect(getBillingStatus()).toMatchObject({ serverless: false })
		expect(getBillingStatus()?.plan).toBeUndefined()
		expect(getBillingWarnings()[0]).toBeUndefined()
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
		expect(getBillingWarnings()[0]?.kind).toBe("exhausted")

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
		expect(getBillingWarnings()[0]).toBeUndefined()
		expect(getBillingStatusLine()).toEqual({ amount: "$10.00" })
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
		expect(getBillingWarnings()[0]?.kind).toBe("low")

		configureBillingCreditsApi({ apiKey: "new-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })

		expect(getBillingStatus()).toBeUndefined()
		expect(getBillingWarnings()[0]).toBeUndefined()
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
		expect(getBillingWarnings()[0]?.kind).toBe("low")

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

	it("keeps a successful budget snapshot when the credits request fails", async () => {
		configureBillingCreditsApi({ apiKey: "api-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
		const fetchImpl = ((input: RequestInfo | URL) => {
			if (String(input).endsWith("/credits")) return Promise.resolve(new Response("nope", { status: 500 }))
			return Promise.resolve(
				new Response(
					JSON.stringify(
						budgetPayload({
							budgetType: "BUDGET_TYPE_PER_USER",
							budgetLimitUsd: "2000.000000",
							totalSpendUsd: "1800.000000",
						}),
					),
					{ status: 200 },
				),
			)
		}) as typeof fetch

		await refreshBillingSnapshot({ fetch: fetchImpl })

		expect(getBillingStatus()?.budget?.budgets[0]?.scope).toBe("USER")
		expect(getBillingStatus()?.budget?.budgets[0]?.budgetType).toBe("BUDGET_TYPE_PER_USER")
		expect(getBillingStatusLine()).toEqual({ budget: "90.00% ($1.8k/$2k)" })
	})

	it("does not notify listeners when equivalent budget object keys are reordered", async () => {
		configureBillingCreditsApi({ apiKey: "api-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
		const payload = budgetPayload()
		setBillingStatusForTest({
			budget: { budgets: payload.budgets, period: payload.period },
			updatedAt: "2026-07-01T00:00:00Z",
		})
		const updates: Array<unknown> = []
		const unsubscribe = subscribeBillingStatus((status) => updates.push(status))

		try {
			await refreshBudgetStatus({
				fetch: (() => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))) as typeof fetch,
			})
			expect(updates).toEqual([])
		} finally {
			unsubscribe()
		}
	})

	it("preserves credits and clears only budget state when an older proxy returns 404", async () => {
		configureBillingCreditsApi({ apiKey: "api-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
		observeCreditsPayload({
			serverless: true,
			tier: "coder",
			is_paid_tier: true,
			billing_status: "ok",
			remaining: "18.4",
		})
		await refreshBudgetStatus({
			fetch: (() => Promise.resolve(new Response(JSON.stringify(budgetPayload()), { status: 200 }))) as typeof fetch,
		})

		await refreshBudgetStatus({
			fetch: (() => Promise.resolve(new Response("not found", { status: 404 }))) as typeof fetch,
		})

		expect(getBillingStatus()).toMatchObject({ remainingCredits: 18.4 })
		expect(getBillingStatus()?.budget).toBeUndefined()
	})

	it("discards a stale budget response after credentials change", async () => {
		configureBillingCreditsApi({ apiKey: "old-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
		let resolveResponse!: (response: Response) => void
		const pendingResponse = new Promise<Response>((resolve) => {
			resolveResponse = resolve
		})

		const refresh = refreshBudgetStatus({ fetch: (() => pendingResponse) as typeof fetch })
		configureBillingCreditsApi({ apiKey: "new-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
		resolveResponse(new Response(JSON.stringify(budgetPayload()), { status: 200 }))

		await expect(refresh).resolves.toBeUndefined()
		expect(getBillingStatus()).toBeUndefined()
	})

	it("derives warnings from total usage, not provider usage", async () => {
		configureBillingCreditsApi({ apiKey: "api-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
		await refreshBudgetStatus({
			fetch: (() => Promise.resolve(new Response(JSON.stringify(budgetPayload()), { status: 200 }))) as typeof fetch,
		})

		expect(getBillingWarnings()).toEqual([
			{
				kind: "low",
				message: "Budget warning: Personal budget is 90% used ($1.8k/$2k).",
			},
		])
	})

	it("accepts provider entries whose non-capped limit is omitted by proto JSON", async () => {
		configureBillingCreditsApi({ apiKey: "api-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
		const payload = budgetPayload()
		const provider = payload.budgets[0].providerBudgets[0] as {
			budgetLimitUsd?: string
			limitType: string
			usageUsd: string
		}
		provider.limitType = "PROVIDER_BUDGET_LIMIT_TYPE_UNLIMITED"
		provider.usageUsd = "12.000000"
		provider.budgetLimitUsd = undefined

		await refreshBudgetStatus({
			fetch: (() => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))) as typeof fetch,
		})

		expect(getBillingStatus()?.budget?.budgets[0]?.providerBudgets[0]).toMatchObject({
			budgetLimitUsd: "",
			limitType: "PROVIDER_BUDGET_LIMIT_TYPE_UNLIMITED",
		})
	})

	it("normalizes an omitted provider limit type to disabled", async () => {
		configureBillingCreditsApi({ apiKey: "api-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
		const payload = budgetPayload()
		const provider = payload.budgets[0].providerBudgets[0] as {
			budgetLimitUsd?: string
			limitType?: string
		}
		provider.limitType = undefined
		provider.budgetLimitUsd = undefined

		await refreshBudgetStatus({
			fetch: (() => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))) as typeof fetch,
		})

		expect(getBillingStatus()?.budget?.budgets[0]?.providerBudgets[0]).toMatchObject({
			budgetLimitUsd: "",
			limitType: "DISABLED",
		})
	})

	it("rejects a capped provider whose limit is omitted and preserves the previous snapshot", async () => {
		configureBillingCreditsApi({ apiKey: "api-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
		await refreshBudgetStatus({
			fetch: (() => Promise.resolve(new Response(JSON.stringify(budgetPayload()), { status: 200 }))) as typeof fetch,
		})
		const invalid = budgetPayload({ totalSpendUsd: "1900.000000" })
		;(invalid.budgets[0].providerBudgets[0] as { budgetLimitUsd?: string }).budgetLimitUsd = undefined

		await expect(
			refreshBudgetStatus({
				fetch: (() => Promise.resolve(new Response(JSON.stringify(invalid), { status: 200 }))) as typeof fetch,
			}),
		).resolves.toBeUndefined()
		expect(getBillingStatus()?.budget?.budgets[0]?.totalSpendUsd).toBe("1800.000000")
	})

	it("normalizes repeated budget fields omitted by proto JSON", async () => {
		configureBillingCreditsApi({ apiKey: "api-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
		const noBudgets = budgetPayload()
		;(noBudgets as { budgets?: unknown }).budgets = undefined

		await refreshBudgetStatus({
			fetch: (() => Promise.resolve(new Response(JSON.stringify(noBudgets), { status: 200 }))) as typeof fetch,
		})
		expect(getBillingStatus()?.budget?.budgets).toEqual([])

		const noProviders = budgetPayload()
		;(noProviders.budgets[0] as { providerBudgets?: unknown }).providerBudgets = undefined
		await refreshBudgetStatus({
			fetch: (() => Promise.resolve(new Response(JSON.stringify(noProviders), { status: 200 }))) as typeof fetch,
		})
		expect(getBillingStatus()?.budget?.budgets[0]?.providerBudgets).toEqual([])
	})

	it("does not select an unlimited total budget for the footer", async () => {
		configureBillingCreditsApi({ apiKey: "api-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
		await refreshBudgetStatus({
			fetch: (() =>
				Promise.resolve(
					new Response(JSON.stringify(budgetPayload({ budgetLimitUsd: "0.000000" })), { status: 200 }),
				)) as typeof fetch,
		})

		expect(getBillingStatus()?.budget?.budgets).toHaveLength(1)
		expect(getBillingStatusLine()).toBeUndefined()
	})

	it("preserves the last budget snapshot on a temporary budget failure", async () => {
		configureBillingCreditsApi({ apiKey: "api-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
		await refreshBudgetStatus({
			fetch: (() => Promise.resolve(new Response(JSON.stringify(budgetPayload()), { status: 200 }))) as typeof fetch,
		})

		await expect(
			refreshBudgetStatus({
				fetch: (() => Promise.resolve(new Response("unavailable", { status: 503 }))) as typeof fetch,
			}),
		).resolves.toBeUndefined()
		expect(getBillingStatus()?.budget?.budgets[0]?.totalSpendUsd).toBe("1800.000000")
	})

	it("warns rather than exhausts when an organization soft limit exceeds 100 percent", async () => {
		configureBillingCreditsApi({ apiKey: "api-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
		await refreshBudgetStatus({
			fetch: (() =>
				Promise.resolve(
					new Response(
						JSON.stringify(
							budgetPayload({
								scope: "ORGANIZATION_SOFT",
								budgetLimitUsd: "100.000000",
								totalSpendUsd: "125.000000",
							}),
						),
						{ status: 200 },
					),
				)) as typeof fetch,
		})

		expect(getBillingWarnings()).toEqual([
			{
				kind: "low",
				message: "Budget warning: Organization soft budget is 125% used ($125.00/$100).",
			},
		])
	})

	it("uses highest usage for the footer and worst total status for warnings", async () => {
		configureBillingCreditsApi({ apiKey: "api-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
		const payload = budgetPayload({
			scope: "API_KEY",
			scopeId: "key",
			budgetLimitUsd: "200.000000",
			totalSpendUsd: "100.000000",
		})
		payload.budgets.push(
			{
				...payload.budgets[0],
				scope: "ORGANIZATION_SOFT",
				scopeId: "org",
				budgetType: "BUDGET_TYPE_PER_USER",
				budgetLimitUsd: "25.000000",
				providerBudgets: [],
			},
			{
				...payload.budgets[0],
				scope: "ORGANIZATION_HARD",
				scopeId: "org",
				budgetType: "BUDGET_TYPE_PER_USER",
				budgetLimitUsd: "100.000000",
				providerBudgets: [],
			},
		)

		await refreshBudgetStatus({
			fetch: (() => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))) as typeof fetch,
		})

		expect(getBillingStatusLine()).toEqual({ budget: "400.00% ($100.00/$25)" })
		expect(getBillingWarnings()).toEqual([
			{
				kind: "exhausted",
				message: "Budget exhausted: Organization per-user hard budget is fully used ($100.00/$100).",
			},
		])
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
		expect(getBillingWarnings()[0]?.kind).toBe("exhausted")

		observeCreditsPayload({
			serverless: true,
			tier: "coder",
			is_paid_tier: true,
			remaining: "10",
		})

		expect(getBillingStatus()).toMatchObject({ plan: "coder", remainingCredits: 10 })
		expect(getBillingStatus()?.creditStatus).toBeUndefined()
		expect(getBillingStatus()?.restrictedMode).toBeUndefined()
		expect(getBillingWarnings()[0]).toBeUndefined()
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
		expect(getCommunityTierHeaderNotice()).toBe(COMMUNITY_TIER_MESSAGES.available)

		observeCreditsPayload({
			serverless: true,
			has_credits: true,
			remaining: "10",
		})

		expect(getBillingStatus()?.plan).toBeUndefined()
		expect(getBillingStatus()?.isPaidTier).toBeUndefined()
		expect(getCommunityTierHeaderNotice()).toBeUndefined()
		expect(getBillingStatusLine()).toEqual({ amount: "$10.00" })
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

describe("refreshBillingStatusFromConfig coordinator", () => {
	beforeEach(() => {
		configureBillingCreditsApi({})
		setBillingStatusForTest(undefined)
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	function configureWithKey() {
		configureBillingCreditsApi({ apiKey: "api-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
	}

	/** Mock loadConfig that returns the same credentials configureWithKey sets,
	 * so refreshBillingStatusFromConfig doesn't overwrite them via the real
	 * loadConfig() (which returns empty in CI where no config file exists). */
	const mockLoadConfig = () => ({
		apiKey: "api-key",
		llmEndpoint: "https://llm.kimchi.dev/openai/v1",
	})

	function fetchImplReturning(remaining: string) {
		return ((_input: RequestInfo | URL) =>
			Promise.resolve(
				new Response(
					JSON.stringify({ serverless: true, tier: "coder", is_paid_tier: true, billing_status: "ok", remaining }),
					{ status: 200 },
				),
			)) as typeof fetch
	}

	it("coalesces concurrent automatic refreshes into one request pair", async () => {
		configureWithKey()
		const calls: string[] = []
		// Yield once per fetch so the response settles on a microtask, letting a
		// second refresh call arrive while the first is still in flight.
		const fetchImpl = ((input: RequestInfo | URL) => {
			calls.push(String(input))
			return new Promise<Response>((resolve) =>
				queueMicrotask(() =>
					resolve(
						new Response(JSON.stringify({ serverless: true, is_paid_tier: true, remaining: "5" }), { status: 200 }),
					),
				),
			)
		}) as typeof fetch

		const first = refreshBillingStatusFromConfig({ fetch: fetchImpl, loadConfig: mockLoadConfig, mode: "automatic" })
		// Start a second refresh before the first's fetch microtask runs.
		const second = refreshBillingStatusFromConfig({ fetch: fetchImpl, loadConfig: mockLoadConfig, mode: "automatic" })

		await expect(first).resolves.toMatchObject({ remainingCredits: 5 })
		await expect(second).resolves.toMatchObject({ remainingCredits: 5 })

		expect(calls.filter((url) => url.endsWith("/credits"))).toHaveLength(1)
		expect(calls.filter((url) => url.endsWith("/budget"))).toHaveLength(1)
	})

	it("throttles automatic refreshes inside the TTL to one snapshot", async () => {
		configureWithKey()
		const calls: string[] = []
		const configLoader = vi.fn(() => ({
			apiKey: "api-key",
			llmEndpoint: "https://llm.kimchi.dev/openai/v1",
		}))
		const fetchImpl = ((input: RequestInfo | URL) => {
			calls.push(String(input))
			return Promise.resolve(
				new Response(JSON.stringify({ serverless: true, is_paid_tier: true, remaining: "5" }), { status: 200 }),
			)
		}) as typeof fetch

		await refreshBillingStatusFromConfig({ fetch: fetchImpl, loadConfig: configLoader, mode: "automatic" })
		const firstSnapshot = getBillingStatus()

		// Advance less than the TTL — second automatic refresh must be skipped
		// before performing another synchronous config read.
		vi.advanceTimersByTime(AUTOMATIC_REFRESH_MIN_INTERVAL_MS - 1_000)
		await refreshBillingStatusFromConfig({ fetch: fetchImpl, loadConfig: configLoader, mode: "automatic" })

		expect(configLoader).toHaveBeenCalledOnce()
		expect(calls.filter((url) => url.endsWith("/credits"))).toHaveLength(1)
		expect(getBillingStatus()).toBe(firstSnapshot)
	})

	it("allows a forced refresh to bypass the TTL", async () => {
		configureWithKey()
		const calls: string[] = []
		const fetchImpl = ((input: RequestInfo | URL) => {
			calls.push(String(input))
			return Promise.resolve(
				new Response(JSON.stringify({ serverless: true, is_paid_tier: true, remaining: "5" }), { status: 200 }),
			)
		}) as typeof fetch

		await refreshBillingStatusFromConfig({ fetch: fetchImpl, loadConfig: mockLoadConfig, mode: "automatic" })

		vi.advanceTimersByTime(1_000)
		await refreshBillingStatusFromConfig({ fetch: fetchImpl, loadConfig: mockLoadConfig, mode: "forced" })

		expect(calls.filter((url) => url.endsWith("/credits"))).toHaveLength(2)
	})

	it("runs an automatic refresh again after the TTL elapses", async () => {
		configureWithKey()
		const calls: string[] = []
		const fetchImpl = ((input: RequestInfo | URL) => {
			calls.push(String(input))
			return Promise.resolve(
				new Response(JSON.stringify({ serverless: true, is_paid_tier: true, remaining: "5" }), { status: 200 }),
			)
		}) as typeof fetch

		await refreshBillingStatusFromConfig({ fetch: fetchImpl, loadConfig: mockLoadConfig, mode: "automatic" })

		vi.advanceTimersByTime(AUTOMATIC_REFRESH_MIN_INTERVAL_MS)
		await refreshBillingStatusFromConfig({ fetch: fetchImpl, loadConfig: mockLoadConfig, mode: "automatic" })

		expect(calls.filter((url) => url.endsWith("/credits"))).toHaveLength(2)
	})

	it("does not throttle an automatic refresh after a forced refresh", async () => {
		configureWithKey()
		const calls: string[] = []
		const fetchImpl = ((input: RequestInfo | URL) => {
			calls.push(String(input))
			return Promise.resolve(
				new Response(JSON.stringify({ serverless: true, is_paid_tier: true, remaining: "5" }), { status: 200 }),
			)
		}) as typeof fetch

		// A forced refresh (startup, login) must not set the automatic TTL —
		// otherwise the first post-completion automatic refresh is throttled.
		await refreshBillingStatusFromConfig({ fetch: fetchImpl, loadConfig: mockLoadConfig, mode: "forced" })
		vi.advanceTimersByTime(1_000)
		await refreshBillingStatusFromConfig({ fetch: fetchImpl, loadConfig: mockLoadConfig, mode: "automatic" })

		expect(calls.filter((url) => url.endsWith("/credits"))).toHaveLength(2)
	})

	it("does not retry a failed automatic billing refresh", async () => {
		configureWithKey()
		const fetchImpl = ((_input: RequestInfo | URL) =>
			Promise.resolve(new Response("nope", { status: 500 }))) as typeof fetch

		await expect(
			refreshBillingStatusFromConfig({ fetch: fetchImpl, loadConfig: mockLoadConfig, mode: "automatic" }),
		).resolves.toBeUndefined()
		expect(getBillingStatus()).toBeUndefined()
	})

	it("defaults to forced mode (manual command / login semantics)", async () => {
		configureWithKey()
		const fetchImpl = fetchImplReturning("5")

		await refreshBillingStatusFromConfig({ fetch: fetchImpl, loadConfig: mockLoadConfig })
		expect(getBillingStatus()).toMatchObject({ remainingCredits: 5 })
	})

	it("does not bump the throttle timestamp when credentials invalidate the in-flight refresh", async () => {
		// Stable credentials across both calls so the second refresh's
		// configureBillingCreditsApi is a no-op — otherwise a credential flip
		// would reset lastRefreshAt=0 and mask the stale-timestamp bug.
		const configWith = (apiKey: string) => () => ({
			apiKey,
			llmEndpoint: "https://llm.kimchi.dev/openai/v1",
		})
		// Seed with the old key so the mid-flight credential change is real.
		configureBillingCreditsApi({ apiKey: "old-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })

		let resolveResponse!: (response: Response) => void
		const pendingResponse = new Promise<Response>((resolve) => {
			resolveResponse = resolve
		})
		const fetchImpl = ((_input: RequestInfo | URL) => pendingResponse) as typeof fetch

		const refresh = refreshBillingStatusFromConfig({
			fetch: fetchImpl,
			mode: "automatic",
			loadConfig: configWith("old-key"),
		})
		// Credential change mid-flight invalidates the coalesced refresh and
		// resets the throttle (lastRefreshAt = 0).
		configureBillingCreditsApi({ apiKey: "new-key", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
		resolveResponse(
			new Response(JSON.stringify({ serverless: true, is_paid_tier: true, remaining: "5" }), { status: 200 }),
		)

		await expect(refresh).resolves.toBeUndefined()

		// A subsequent automatic refresh must NOT be throttled by the stale
		// resolution — the credential reset must stand.
		const calls: string[] = []
		const nextFetch = ((input: RequestInfo | URL) => {
			calls.push(String(input))
			return Promise.resolve(
				new Response(JSON.stringify({ serverless: true, is_paid_tier: true, remaining: "5" }), { status: 200 }),
			)
		}) as typeof fetch
		await refreshBillingStatusFromConfig({
			fetch: nextFetch,
			mode: "automatic",
			loadConfig: configWith("new-key"),
		})

		expect(calls.filter((url) => url.endsWith("/credits"))).toHaveLength(1)
	})
})

function budgetPayload(
	options: {
		scope?: "API_KEY" | "USER" | "TEAM_PER_USER" | "TEAM_POOLED" | "ORGANIZATION_SOFT" | "ORGANIZATION_HARD"
		scopeId?: string
		budgetType?: string
		budgetLimitUsd?: string
		totalSpendUsd?: string
	} = {},
) {
	return {
		period: { startTime: "2026-07-01T00:00:00Z", endTime: "2026-08-01T00:00:00Z" },
		budgets: [
			{
				scope: options.scope ?? "USER",
				scopeId: options.scopeId ?? "1",
				...(options.budgetType ? { budgetType: options.budgetType } : {}),
				budgetLimitUsd: options.budgetLimitUsd ?? "2000.000000",
				totalSpendUsd: options.totalSpendUsd ?? "1800.000000",
				providerBudgets: [
					{
						provider: "anthropic",
						limitType: "PROVIDER_BUDGET_LIMIT_TYPE_CAPPED",
						budgetLimitUsd: "400.000000",
						usageUsd: "400.000000",
					},
				],
			},
		],
	}
}
