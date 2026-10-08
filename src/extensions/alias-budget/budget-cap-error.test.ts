import { describe, expect, it } from "vitest"
import { parseBudgetCapRejection } from "./budget-cap-error.js"

describe("parseBudgetCapRejection", () => {
	it("parses the incident rejection verbatim", () => {
		const rejection = parseBudgetCapRejection(
			"max_completion_tokens is too large: 512000.This model supports at most 262144 completion tokens.",
		)
		expect(rejection).toEqual({ requestedBudget: 512_000, limit: 262_144 })
	})

	it("parses the rejection inside a LiteLLM-wrapped verdict", () => {
		const rejection = parseBudgetCapRejection(
			"litellm.BadRequestError: LLM Provider NOT provided. OpenAIException - max_tokens is too large: 512000. This model supports at most 262144 completion tokens.",
		)
		expect(rejection).toEqual({ requestedBudget: 512_000, limit: 262_144 })
	})

	it("parses the legacy max_tokens field", () => {
		const rejection = parseBudgetCapRejection(
			"max_tokens is too large: 100000.This model supports at most 32768 completion tokens.",
		)
		expect(rejection).toEqual({ requestedBudget: 100_000, limit: 32_768 })
	})

	it("rejects non-matching provider errors", () => {
		expect(parseBudgetCapRejection("context window exceeded")).toBeUndefined()
		expect(parseBudgetCapRejection("rate limited until 2026-10-07T00:00:00Z")).toBeUndefined()
		expect(parseBudgetCapRejection(undefined)).toBeUndefined()
		expect(parseBudgetCapRejection("")).toBeUndefined()
	})

	it("rejects verdicts whose budget does not exceed the stated ceiling", () => {
		expect(
			parseBudgetCapRejection(
				"max_completion_tokens is too large: 262144.This model supports at most 262144 completion tokens.",
			),
		).toBeUndefined()
		expect(
			parseBudgetCapRejection(
				"max_completion_tokens is too large: 8192.This model supports at most 262144 completion tokens.",
			),
		).toBeUndefined()
	})
})
