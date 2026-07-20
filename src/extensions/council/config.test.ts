import { describe, expect, it } from "vitest"
import { readCouncilConfig } from "./config.js"
import { DEFAULT_COUNCIL_CONFIG } from "./runtime.js"

describe("readCouncilConfig", () => {
	it("uses the Council runtime defaults when no overrides are set", () => {
		expect(readCouncilConfig({})).toEqual(DEFAULT_COUNCIL_CONFIG)
		expect(DEFAULT_COUNCIL_CONFIG.internalMaxTokens).toBe(8_192)
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
