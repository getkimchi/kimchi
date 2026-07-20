import { describe, expect, it } from "vitest"
import { applyCouncilPreset, readCouncilConfig } from "./config.js"
import { type CouncilConfig, DEFAULT_COUNCIL_CONFIG } from "./runtime.js"

describe("readCouncilConfig", () => {
	it("uses the Council runtime defaults when no overrides are set", () => {
		expect(readCouncilConfig({})).toEqual(DEFAULT_COUNCIL_CONFIG)
		expect(DEFAULT_COUNCIL_CONFIG.internalMaxTokens).toBe(8_192)
		expect(DEFAULT_COUNCIL_CONFIG.maxCalls).toBe(8)
		expect(DEFAULT_COUNCIL_CONFIG.judgeModel).toBe("kimchi-dev/deepseek-v4-flash")
	})

	it("applies supported environment overrides", () => {
		expect(
			readCouncilConfig({
				KIMCHI_COUNCIL_ENABLED: "false",
				KIMCHI_COUNCIL_LEAD_MODEL: " kimchi-dev/lead ",
				KIMCHI_COUNCIL_REVIEWER_MODELS: "kimchi-dev/a, kimchi-dev/b, kimchi-dev/c, kimchi-dev/ignored",
				KIMCHI_COUNCIL_JUDGE_MODEL: " kimchi-dev/judge ",
				KIMCHI_COUNCIL_TIMEOUT_MS: "90000",
				KIMCHI_COUNCIL_STAGE_TIMEOUT_MS: "30000",
				KIMCHI_COUNCIL_MAX_PARALLEL_REVIEWERS: "2",
				KIMCHI_COUNCIL_LEAD_MAX_TOKENS: "2048",
				KIMCHI_COUNCIL_INTERNAL_MAX_TOKENS: "512",
				KIMCHI_COUNCIL_MAX_EVIDENCE_BYTES: "16384",
				KIMCHI_COUNCIL_MAX_STRUCTURED_BYTES: "8192",
				KIMCHI_COUNCIL_MAX_CALLS: "6",
			}),
		).toEqual({
			...DEFAULT_COUNCIL_CONFIG,
			enabled: false,
			leadModel: "kimchi-dev/lead",
			reviewerModels: ["kimchi-dev/a", "kimchi-dev/b", "kimchi-dev/c"],
			judgeModel: "kimchi-dev/judge",
			stageTimeoutMs: 30_000,
			overallTimeoutMs: 90_000,
			maxParallelReviewers: 2,
			leadMaxTokens: 2_048,
			internalMaxTokens: 512,
			maxEvidenceBytes: 16_384,
			maxStructuredBytes: 8_192,
			maxCalls: 6,
		})
	})

	it("falls back for invalid booleans, numbers, and empty model lists", () => {
		expect(
			readCouncilConfig({
				KIMCHI_COUNCIL_ENABLED: "sometimes",
				KIMCHI_COUNCIL_LEAD_MODEL: " ",
				KIMCHI_COUNCIL_REVIEWER_MODELS: " , ",
				KIMCHI_COUNCIL_JUDGE_MODEL: " ",
				KIMCHI_COUNCIL_TIMEOUT_MS: "0",
				KIMCHI_COUNCIL_STAGE_TIMEOUT_MS: "-1",
				KIMCHI_COUNCIL_MAX_PARALLEL_REVIEWERS: "1.5",
				KIMCHI_COUNCIL_LEAD_MAX_TOKENS: "2e3",
				KIMCHI_COUNCIL_INTERNAL_MAX_TOKENS: "NaN",
				KIMCHI_COUNCIL_MAX_EVIDENCE_BYTES: "9007199254740992",
				KIMCHI_COUNCIL_MAX_STRUCTURED_BYTES: "0",
				KIMCHI_COUNCIL_MAX_CALLS: "-7",
			}),
		).toEqual(DEFAULT_COUNCIL_CONFIG)
	})

	it("keeps the physical-call, concurrency, output, and packet hard caps", () => {
		const config = readCouncilConfig({
			KIMCHI_COUNCIL_REVIEWER_MODELS: "kimchi-dev/only-one",
			KIMCHI_COUNCIL_TIMEOUT_MS: "9999999",
			KIMCHI_COUNCIL_STAGE_TIMEOUT_MS: "999999",
			KIMCHI_COUNCIL_MAX_PARALLEL_REVIEWERS: "99",
			KIMCHI_COUNCIL_LEAD_MAX_TOKENS: "999999",
			KIMCHI_COUNCIL_INTERNAL_MAX_TOKENS: "999999",
			KIMCHI_COUNCIL_MAX_EVIDENCE_BYTES: "999999",
			KIMCHI_COUNCIL_MAX_STRUCTURED_BYTES: "999999",
			KIMCHI_COUNCIL_MAX_CALLS: "99",
		})

		expect(config).toEqual(DEFAULT_COUNCIL_CONFIG)
	})
})

describe("applyCouncilPreset", () => {
	it("applies the fast, normal, and deep call budgets", () => {
		expect(applyCouncilPreset(DEFAULT_COUNCIL_CONFIG, "fast")).toEqual({
			...DEFAULT_COUNCIL_CONFIG,
			reviewerModels: [DEFAULT_COUNCIL_CONFIG.reviewerModels[1]],
			reviewerRoles: ["critic"],
			maxParallelReviewers: 1,
			overallTimeoutMs: 240_000,
			stageTimeoutMs: 60_000,
			leadMaxTokens: 8_192,
			internalMaxTokens: 2_048,
			maxEvidenceBytes: 32_768,
			maxStructuredBytes: 8_192,
			maxCalls: 5,
			useJudge: false,
			revisionPolicy: "on-issues",
		})
		expect(applyCouncilPreset(DEFAULT_COUNCIL_CONFIG, "normal")).toEqual({
			...DEFAULT_COUNCIL_CONFIG,
			reviewerModels: DEFAULT_COUNCIL_CONFIG.reviewerModels.slice(1, 3),
			reviewerRoles: ["critic", "checker"],
			maxParallelReviewers: 2,
			overallTimeoutMs: 720_000,
			stageTimeoutMs: 180_000,
			leadMaxTokens: 16_384,
			internalMaxTokens: 4_096,
			maxEvidenceBytes: 65_536,
			maxStructuredBytes: 16_384,
			maxCalls: 7,
			useJudge: true,
			revisionPolicy: "on-issues",
		})
		expect(applyCouncilPreset(DEFAULT_COUNCIL_CONFIG, "deep")).toEqual({
			...DEFAULT_COUNCIL_CONFIG,
			maxCalls: 8,
			useJudge: true,
			revisionPolicy: "always",
		})
	})

	it("keeps lower base limits below preset caps", () => {
		const lower = {
			...DEFAULT_COUNCIL_CONFIG,
			maxParallelReviewers: 1,
			overallTimeoutMs: 120_000,
			stageTimeoutMs: 30_000,
			leadMaxTokens: 4_096,
			internalMaxTokens: 1_024,
			maxEvidenceBytes: 16_384,
			maxStructuredBytes: 4_096,
			maxCalls: 3,
		}

		for (const preset of ["fast", "normal", "deep"] as const) {
			expect(applyCouncilPreset(lower, preset)).toMatchObject({
				maxParallelReviewers: 1,
				overallTimeoutMs: 120_000,
				stageTimeoutMs: 30_000,
				leadMaxTokens: 4_096,
				internalMaxTokens: 1_024,
				maxEvidenceBytes: 16_384,
				maxStructuredBytes: 4_096,
				maxCalls: 3,
			})
		}
	})

	it("preserves preset roles with a two-model override", () => {
		const twoModels = {
			...DEFAULT_COUNCIL_CONFIG,
			reviewerModels: ["kimchi-dev/independent", "kimchi-dev/critic"],
			reviewerRoles: ["independent", "critic"] as CouncilConfig["reviewerRoles"],
		}

		expect(applyCouncilPreset(twoModels, "normal")).toMatchObject({
			reviewerModels: ["kimchi-dev/critic", "kimchi-dev/independent"],
			reviewerRoles: ["critic", "checker"],
		})
		expect(applyCouncilPreset(twoModels, "deep")).toMatchObject({
			reviewerModels: ["kimchi-dev/independent", "kimchi-dev/critic", "kimchi-dev/independent"],
			reviewerRoles: ["independent", "critic", "checker"],
		})
	})
})
