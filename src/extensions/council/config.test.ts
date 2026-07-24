import { describe, expect, it } from "vitest"
import { applyCouncilPreset, DEFAULT_COUNCIL_CONFIG, readCouncilConfig, validateCouncilConfig } from "./config.js"
import type { CouncilConfig } from "./types.js"

describe("readCouncilConfig", () => {
	it("is enabled by default and supports an explicit opt-out", () => {
		expect(readCouncilConfig({}).enabled).toBe(true)
		expect(readCouncilConfig({ KIMCHI_COUNCIL_ENABLED: "true" }).enabled).toBe(true)
		expect(readCouncilConfig({ KIMCHI_COUNCIL_ENABLED: "false" }).enabled).toBe(false)
		expect(readCouncilConfig({ KIMCHI_COUNCIL_ENABLED: "sometimes" }).enabled).toBe(true)
	})

	it("maps named primaries and ordered fallback pools", () => {
		const config = readCouncilConfig({
			KIMCHI_COUNCIL_LEAD_MODEL: " physical/lead ",
			KIMCHI_COUNCIL_LEAD_FALLBACK_MODELS: "physical/a, physical/b, physical/a",
			KIMCHI_COUNCIL_INDEPENDENT_MODEL: "physical/independent",
			KIMCHI_COUNCIL_CRITIC_MODEL: "physical/critic",
			KIMCHI_COUNCIL_CHECKER_MODEL: "physical/checker",
			KIMCHI_COUNCIL_JUDGE_MODEL: "physical/judge",
			KIMCHI_COUNCIL_JUDGE_FALLBACK_MODELS: "physical/judge, physical/backup",
		})

		expect(config.lead).toEqual({
			primary: "physical/lead",
			fallbacks: ["physical/a", "physical/b"],
		})
		expect(config.reviewers.independent.primary).toBe("physical/independent")
		expect(config.reviewers.critic.primary).toBe("physical/critic")
		expect(config.reviewers.checker.primary).toBe("physical/checker")
		expect(config.reviewers.checker.fallbacks).toEqual(["kimchi-dev/glm-5.2-fp8", "kimchi-dev/deepseek-v4-flash"])
		expect(config.judge).toEqual({ primary: "physical/judge", fallbacks: ["physical/backup"] })
	})

	it("keeps the legacy positional reviewer override", () => {
		const config = readCouncilConfig({
			KIMCHI_COUNCIL_REVIEWER_MODELS: "physical/independent, physical/critic",
		})

		expect(config.reviewers.independent.primary).toBe("physical/independent")
		expect(config.reviewers.critic.primary).toBe("physical/critic")
		expect(config.reviewers.checker.primary).toBe("physical/independent")
	})

	it("parses and bounds aggregate budgets", () => {
		const config = readCouncilConfig({
			KIMCHI_COUNCIL_MAX_LOGICAL_CALLS: "6",
			KIMCHI_COUNCIL_MAX_PHYSICAL_ATTEMPTS: "9",
			KIMCHI_COUNCIL_MAX_CONCURRENT_CALLS: "2",
			KIMCHI_COUNCIL_MAX_AGGREGATE_INPUT_TOKENS: "200000",
			KIMCHI_COUNCIL_MAX_AGGREGATE_OUTPUT_TOKENS: "50000",
			KIMCHI_COUNCIL_MAX_ESTIMATED_COST_USD: "3.25",
			KIMCHI_COUNCIL_MAX_RETRIES_PER_CALL: "0",
		})

		expect(config.maxCalls).toBe(6)
		expect(config.budget).toEqual({
			maxLogicalCalls: 6,
			maxPhysicalAttempts: 9,
			maxConcurrentCalls: 2,
			maxAggregateInputTokens: 200_000,
			maxAggregateOutputTokens: 50_000,
			maxEstimatedCostUsd: 3.25,
			maxRetriesPerCall: 0,
		})
	})

	it("falls back for malformed values and caps oversized values", () => {
		const malformed = readCouncilConfig({
			KIMCHI_COUNCIL_MAX_LOGICAL_CALLS: "1.5",
			KIMCHI_COUNCIL_MAX_PHYSICAL_ATTEMPTS: "-1",
			KIMCHI_COUNCIL_MAX_CONCURRENT_CALLS: "2e3",
			KIMCHI_COUNCIL_MAX_AGGREGATE_INPUT_TOKENS: "NaN",
			KIMCHI_COUNCIL_MAX_AGGREGATE_OUTPUT_TOKENS: "0",
			KIMCHI_COUNCIL_MAX_ESTIMATED_COST_USD: "1.23456",
			KIMCHI_COUNCIL_MAX_RETRIES_PER_CALL: "-1",
		})
		expect(malformed.budget).toEqual(DEFAULT_COUNCIL_CONFIG.budget)

		const capped = readCouncilConfig({
			KIMCHI_COUNCIL_MAX_LOGICAL_CALLS: "999",
			KIMCHI_COUNCIL_MAX_PHYSICAL_ATTEMPTS: "999",
			KIMCHI_COUNCIL_MAX_CONCURRENT_CALLS: "999",
			KIMCHI_COUNCIL_MAX_AGGREGATE_INPUT_TOKENS: "999999999",
			KIMCHI_COUNCIL_MAX_AGGREGATE_OUTPUT_TOKENS: "999999999",
			KIMCHI_COUNCIL_MAX_ESTIMATED_COST_USD: "999",
			KIMCHI_COUNCIL_MAX_RETRIES_PER_CALL: "999",
		})
		expect(capped.budget).toEqual(DEFAULT_COUNCIL_CONFIG.budget)
	})

	it("rejects recursive virtual models", () => {
		expect(() => readCouncilConfig({ KIMCHI_COUNCIL_LEAD_MODEL: "kimchi/council-fast" })).toThrow(
			"cannot reference virtual model",
		)
	})
})

describe("validateCouncilConfig", () => {
	it("requires every active role pool", () => {
		const config = structuredClone(DEFAULT_COUNCIL_CONFIG)
		config.reviewers.critic.primary = ""
		expect(() => validateCouncilConfig(config)).toThrow("Council critic model pool is empty")
	})
})

describe("applyCouncilPreset", () => {
	it.each([
		["fast", ["critic"], 12, 14, 1, false, "on-issues", "changes"],
		["normal", ["independent", "critic", "checker"], 24, 30, 3, true, "on-issues", "always"],
		["deep", ["independent", "critic", "checker"], 24, 30, 3, true, "always", "always"],
	] as const)("applies the %s execution policy", (preset, roles, logical, physical, concurrent, judge, revision, reviewPolicy) => {
		const config = applyCouncilPreset(DEFAULT_COUNCIL_CONFIG, preset)
		expect(config.requiredRoles).toEqual(roles)
		expect(config.maxCalls).toBe(logical)
		expect(config.budget).toMatchObject({
			maxLogicalCalls: logical,
			maxPhysicalAttempts: physical,
			maxConcurrentCalls: concurrent,
		})
		expect(config.useJudge).toBe(judge)
		expect(config.revisionPolicy).toBe(revision)
		expect(config.reviewPolicy).toBe(reviewPolicy)
	})

	it("covers the minimum supported revision call sequence", () => {
		expect(applyCouncilPreset(DEFAULT_COUNCIL_CONFIG, "fast").budget).toMatchObject({
			maxLogicalCalls: 12,
			maxPhysicalAttempts: 14,
		})
		for (const preset of ["normal", "deep"] as const) {
			expect(applyCouncilPreset(DEFAULT_COUNCIL_CONFIG, preset).budget).toMatchObject({
				maxLogicalCalls: 24,
				maxPhysicalAttempts: 30,
			})
		}
	})

	it("keeps lower caller limits below preset caps and preserves model pools", () => {
		const lower: CouncilConfig = {
			...structuredClone(DEFAULT_COUNCIL_CONFIG),
			maxParallelReviewers: 1,
			overallTimeoutMs: 120_000,
			maxCalls: 3,
			budget: {
				...DEFAULT_COUNCIL_CONFIG.budget,
				maxLogicalCalls: 3,
				maxPhysicalAttempts: 4,
				maxConcurrentCalls: 1,
			},
		}

		for (const preset of ["fast", "normal", "deep"] as const) {
			const applied = applyCouncilPreset(lower, preset)
			expect(applied).toMatchObject({
				maxParallelReviewers: 1,
				overallTimeoutMs: preset === "fast" ? 90_000 : 120_000,
				maxCalls: 3,
			})
			expect(applied.budget).toMatchObject({
				maxLogicalCalls: 3,
				maxPhysicalAttempts: 4,
				maxConcurrentCalls: 1,
			})
			expect(applied.lead).toEqual(lower.lead)
			expect(applied.reviewers).toEqual(lower.reviewers)
			expect(applied.judge).toEqual(lower.judge)
		}
	})

	it("keeps enough fast-mode evidence headroom for the real harness prompt plus an exact patch", () => {
		expect(applyCouncilPreset(DEFAULT_COUNCIL_CONFIG, "fast").maxEvidenceBytes).toBe(131_072)
	})

	it.each([
		["normal", 420_000, 160_000, 24_576, 131_072, 524_288, 65_536],
		["deep", 420_000, 160_000, 32_768, 131_072, 786_432, 98_304],
	] as const)("keeps quality headroom in the %s preset", (preset, timeout, stageTimeout, leadTokens, structuredBytes, inputTokens, outputTokens) => {
		const config = applyCouncilPreset(DEFAULT_COUNCIL_CONFIG, preset)

		expect(config).toMatchObject({
			overallTimeoutMs: timeout,
			stageTimeoutMs: stageTimeout,
			leadMaxTokens: leadTokens,
			internalMaxTokens: 16_384,
			maxEvidenceBytes: 131_072,
			maxStructuredBytes: structuredBytes,
			budget: {
				maxAggregateInputTokens: inputTokens,
				maxAggregateOutputTokens: outputTokens,
			},
		})
	})
})
