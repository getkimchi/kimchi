import type { Theme } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { formatCount } from "../format.js"
import { getTimeRange } from "./api.js"
import { formatAnalyticsSummary } from "./display.js"
import { parseStatsArgs } from "./index.js"
import type { GenerateAnalyticsResponse } from "./types.js"
import {
	type SortBy,
	aggregateTokens,
	formatAnalyticsVisual,
	formatCurrency,
	getProviderDisplayName,
	getSourceName,
	sortFn,
} from "./visual.js"

// Simple pass-through mock for testing output shape without ANSI codes
const mockTheme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as unknown as Theme

describe("getTimeRange", () => {
	it("returns correct time range for 30 days", () => {
		const { startTime, endTime } = getTimeRange(30)
		const diffMs = endTime.getTime() - startTime.getTime()
		const diffDays = diffMs / (1000 * 60 * 60 * 24)
		expect(diffDays).toBeCloseTo(30, 0)
	})

	it("returns correct time range for 7 days", () => {
		const { startTime, endTime } = getTimeRange(7)
		const diffMs = endTime.getTime() - startTime.getTime()
		const diffDays = diffMs / (1000 * 60 * 60 * 24)
		expect(diffDays).toBeCloseTo(7, 0)
	})

	it("returns correct time range for 1 day", () => {
		const { startTime, endTime } = getTimeRange(1)
		const diffMs = endTime.getTime() - startTime.getTime()
		const diffDays = diffMs / (1000 * 60 * 60 * 24)
		expect(diffDays).toBeCloseTo(1, 0)
	})
})

describe("formatCount", () => {
	it("formats thousands with k suffix", () => {
		expect(formatCount(1500)).toBe("1.5k")
		expect(formatCount(10000)).toBe("10k")
	})

	it("formats millions with M suffix", () => {
		expect(formatCount(1500000)).toBe("1.5M")
		expect(formatCount(10000000)).toBe("10M")
	})

	it("returns plain number for small values", () => {
		expect(formatCount(500)).toBe("500")
		expect(formatCount(999)).toBe("999")
	})
})

describe("formatCurrency", () => {
	it("formats number with dollar sign and 2 decimals", () => {
		expect(formatCurrency(1500.5)).toBe("$1500.50")
		expect(formatCurrency(0)).toBe("$0.00")
	})

	it("formats string amount", () => {
		expect(formatCurrency("1234.56")).toBe("$1234.56")
	})

	it("handles invalid input", () => {
		expect(formatCurrency("invalid")).toBe("$0.00")
		expect(formatCurrency(Number.NaN)).toBe("$0.00")
	})
})

describe("getProviderDisplayName", () => {
	it("maps cloud-code-otel to Claude Code", () => {
		expect(getProviderDisplayName("cloud-code-otel")).toBe("Claude Code")
	})

	it("maps opencode-otel to OpenCode", () => {
		expect(getProviderDisplayName("opencode-otel")).toBe("OpenCode")
	})

	it("maps pi-otel to Kimchi", () => {
		expect(getProviderDisplayName("pi-otel")).toBe("Kimchi")
	})

	it("returns original name for unknown providers", () => {
		expect(getProviderDisplayName("unknown-provider")).toBe("unknown-provider")
	})

	it("handles empty string", () => {
		expect(getProviderDisplayName("")).toBe("")
	})
})

describe("getSourceName", () => {
	it("maps cloud-code-otel to Claude Code", () => {
		expect(getSourceName("cloud-code-otel")).toBe("Claude Code")
	})

	it("maps opencode-otel to OpenCode", () => {
		expect(getSourceName("opencode-otel")).toBe("OpenCode")
	})

	it("maps pi-otel to Kimchi", () => {
		expect(getSourceName("pi-otel")).toBe("Kimchi")
	})

	it("maps unknown providers to Proxy", () => {
		expect(getSourceName("unknown-provider")).toBe("Proxy")
	})

	it("maps empty string to Proxy", () => {
		expect(getSourceName("")).toBe("Proxy")
	})
})

describe("parseStatsArgs", () => {
	it("returns defaults for empty string", () => {
		const result = parseStatsArgs("")
		expect(result.days).toBe(30)
		expect(result.sortBy).toBe("cost")
	})

	it("parses days only", () => {
		const result = parseStatsArgs("7")
		expect(result.days).toBe(7)
		expect(result.sortBy).toBe("cost")
	})

	it("parses sortBy only", () => {
		const result = parseStatsArgs("tokens")
		expect(result.days).toBe(30)
		expect(result.sortBy).toBe("tokens")
	})

	it("parses days and sortBy combined", () => {
		const result = parseStatsArgs("7 model")
		expect(result.days).toBe(7)
		expect(result.sortBy).toBe("model")
	})

	it("handles reversed order", () => {
		const result = parseStatsArgs("tokens 7")
		expect(result.days).toBe(7)
		expect(result.sortBy).toBe("tokens")
	})

	it("ignores invalid tokens", () => {
		const result = parseStatsArgs("7 foo model")
		expect(result.days).toBe(7)
		expect(result.sortBy).toBe("model")
	})

	it("ignores day 0", () => {
		const result = parseStatsArgs("0")
		expect(result.days).toBe(30)
	})

	it("ignores day over 365", () => {
		const result = parseStatsArgs("366")
		expect(result.days).toBe(30)
	})

	it("handles all sort values", () => {
		const sortValues: SortBy[] = ["cost", "tokens", "model", "source"]
		for (const sortBy of sortValues) {
			const result = parseStatsArgs(sortBy)
			expect(result.sortBy).toBe(sortBy)
		}
	})
})

describe("sortFn", () => {
	const fixtures = [
		{ modelName: "gpt-4", source: "Proxy", cost: 10, inputTokens: 1000, outputTokens: 500 },
		{ modelName: "claude-3", source: "Claude Code", cost: 5, inputTokens: 2000, outputTokens: 1000 },
		{ modelName: "gpt-4", source: "Kimchi", cost: 8, inputTokens: 800, outputTokens: 400 },
	]

	describe("sort by cost", () => {
		it("sorts by cost descending", () => {
			const sorted = [...fixtures].sort((a, b) => sortFn(a, b, "cost"))
			expect(sorted[0].modelName).toBe("gpt-4")
			expect(sorted[0].source).toBe("Proxy")
			expect(sorted[1].cost).toBe(8)
			expect(sorted[2].cost).toBe(5)
		})

		it("uses modelName then source as tiebreaker", () => {
			const tied = [
				{ modelName: "gpt-4", source: "Proxy", cost: 10, inputTokens: 100, outputTokens: 100 },
				{ modelName: "gpt-4", source: "Kimchi", cost: 10, inputTokens: 200, outputTokens: 200 },
				{ modelName: "claude-3", source: "Proxy", cost: 10, inputTokens: 300, outputTokens: 300 },
			]
			const sorted = [...tied].sort((a, b) => sortFn(a, b, "cost"))
			expect(sorted[0].modelName).toBe("claude-3")
			expect(sorted[1].modelName).toBe("gpt-4")
			expect(sorted[1].source).toBe("Kimchi")
			expect(sorted[2].source).toBe("Proxy")
		})
	})

	describe("sort by tokens", () => {
		it("sorts by total tokens descending", () => {
			const sorted = [...fixtures].sort((a, b) => sortFn(a, b, "tokens"))
			expect(sorted[0].modelName).toBe("claude-3")
			expect(sorted[0].inputTokens + sorted[0].outputTokens).toBe(3000)
		})

		it("uses modelName then source as tiebreaker", () => {
			const tied = [
				{ modelName: "gpt-4", source: "Proxy", cost: 1, inputTokens: 1000, outputTokens: 1000 },
				{ modelName: "gpt-4", source: "Kimchi", cost: 2, inputTokens: 1000, outputTokens: 1000 },
			]
			const sorted = [...tied].sort((a, b) => sortFn(a, b, "tokens"))
			expect(sorted[0].source).toBe("Kimchi")
			expect(sorted[1].source).toBe("Proxy")
		})
	})

	describe("sort by model", () => {
		it("sorts by modelName ascending", () => {
			const sorted = [...fixtures].sort((a, b) => sortFn(a, b, "model"))
			expect(sorted[0].modelName).toBe("claude-3")
			expect(sorted[1].modelName).toBe("gpt-4")
			expect(sorted[2].modelName).toBe("gpt-4")
		})

		it("uses source as tiebreaker for same model", () => {
			const sorted = [...fixtures].sort((a, b) => sortFn(a, b, "model"))
			const gpt4Entries = sorted.filter((x) => x.modelName === "gpt-4")
			expect(gpt4Entries[0].source).toBe("Kimchi")
			expect(gpt4Entries[1].source).toBe("Proxy")
		})
	})

	describe("sort by source", () => {
		it("sorts by source ascending", () => {
			const sorted = [...fixtures].sort((a, b) => sortFn(a, b, "source"))
			expect(sorted[0].source).toBe("Claude Code")
			expect(sorted[1].source).toBe("Kimchi")
			expect(sorted[2].source).toBe("Proxy")
		})

		it("uses modelName as tiebreaker for same source", () => {
			const withSameSource = [
				{ modelName: "gpt-4", source: "Proxy", cost: 10, inputTokens: 100, outputTokens: 100 },
				{ modelName: "claude-3", source: "Proxy", cost: 5, inputTokens: 200, outputTokens: 200 },
			]
			const sorted = [...withSameSource].sort((a, b) => sortFn(a, b, "source"))
			expect(sorted[0].modelName).toBe("claude-3")
			expect(sorted[1].modelName).toBe("gpt-4")
		})
	})
})

function makeModelTokenStat(
	overrides: Partial<import("./types.js").ModelTokenStat> = {},
): import("./types.js").ModelTokenStat {
	return {
		model: "gpt-4",
		provider: "openai",
		castaiApiKey: "key-1",
		providerName: "pi-otel",
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		castaiApiKeyMetadata: { id: "1", name: "", ownerType: "", ownerId: "", ownerEmail: "" },
		...overrides,
	}
}

function makeModelCost(overrides: Partial<import("./types.js").ModelCost> = {}): import("./types.js").ModelCost {
	return {
		model: "gpt-4",
		provider: "openai",
		castaiApiKey: "key-1",
		providerName: "pi-otel",
		totalCost: "0",
		totalCostPerMillionTokens: "0",
		castaiApiKeyMetadata: { id: "1", name: "", ownerType: "", ownerId: "", ownerEmail: "" },
		inputTokenCost: "0",
		outputTokenCost: "0",
		...overrides,
	}
}

describe("formatAnalyticsVisual", () => {
	it("uses new tokens field when present", () => {
		const data: GenerateAnalyticsResponse = {
			stepDuration: "0s",
			tokens: {
				items: [
					{
						executionTime: "2026-06-09T09:00:00Z",
						models: [
							makeModelTokenStat({
								model: "gpt-4",
								providerName: "pi-otel",
								inputTokens: 1000,
								outputTokens: 500,
							}),
							makeModelTokenStat({
								model: "gpt-4",
								providerName: "cloud-code-otel",
								inputTokens: 2000,
								outputTokens: 1000,
							}),
						],
					},
				],
			},
		}

		const lines = formatAnalyticsVisual(data, mockTheme)
		const joined = lines.join("\n")

		// Should show gpt-4 aggregated by source
		expect(joined).toContain("gpt-4")
		expect(joined).toContain("Kimchi")
		expect(joined).toContain("Claude Code")
		// Total input = 3000, output = 1500
		expect(joined).toContain("3.0k")
		expect(joined).toContain("1.5k")
	})

	it("sums token counts across multiple execution times for same model+source", () => {
		const data: GenerateAnalyticsResponse = {
			stepDuration: "0s",
			tokens: {
				items: [
					{
						executionTime: "2026-06-09T09:00:00Z",
						models: [
							makeModelTokenStat({
								model: "gpt-4",
								providerName: "pi-otel",
								inputTokens: 1000,
								outputTokens: 500,
							}),
						],
					},
					{
						executionTime: "2026-06-09T10:00:00Z",
						models: [
							makeModelTokenStat({
								model: "gpt-4",
								providerName: "pi-otel",
								inputTokens: 2000,
								outputTokens: 1000,
							}),
						],
					},
				],
			},
		}

		const lines = formatAnalyticsVisual(data, mockTheme)
		const joined = lines.join("\n")

		// Input = 1000 + 2000 = 3000, Output = 500 + 1000 = 1500
		expect(joined).toContain("3.0k")
		expect(joined).toContain("1.5k")
	})

	it("coalesces undefined token values to 0", () => {
		const data: GenerateAnalyticsResponse = {
			stepDuration: "0s",
			tokens: {
				items: [
					{
						executionTime: "2026-06-09T09:00:00Z",
						models: [
							{
								model: "gpt-4",
								provider: "openai",
								castaiApiKey: "key-1",
								providerName: "pi-otel",
								inputTokens: undefined as unknown as number,
								outputTokens: 500,
								totalTokens: 500,
								cacheReadTokens: 0,
								cacheWriteTokens: 0,
								castaiApiKeyMetadata: { id: "1", name: "", ownerType: "", ownerId: "", ownerEmail: "" },
							},
						],
					},
				],
			},
		}

		const lines = formatAnalyticsVisual(data, mockTheme)
		const joined = lines.join("\n")

		expect(joined).toContain("500")
	})

	it("coerces string int64 token values from protobuf JSON encoding", () => {
		// Protobuf JSON encodes int64 as strings (e.g. "9007199254740991",
		// i.e. Number.MAX_SAFE_INTEGER) because JavaScript Number can't safely
		// represent integers > 2^53. The formatter must parse these strings
		// before aggregating.
		const data: GenerateAnalyticsResponse = {
			stepDuration: "0s",
			tokens: {
				items: [
					{
						executionTime: "2026-06-09T09:00:00Z",
						models: [
							makeModelTokenStat({
								model: "gpt-4",
								providerName: "pi-otel",
								inputTokens: "1000",
								outputTokens: "500",
							}),
							makeModelTokenStat({
								model: "claude-3",
								providerName: "pi-otel",
								inputTokens: "2000",
								outputTokens: "1000",
							}),
						],
					},
				],
			},
		}

		const lines = formatAnalyticsVisual(data, mockTheme)
		const joined = lines.join("\n")

		// Total input across all models: 3000, output: 1500
		expect(joined).toContain("4.5k")
		expect(joined).toContain("3.0k")
		expect(joined).toContain("1.5k")

		// Pin down the numeric aggregation directly so a regression that
		// breaks per-row totals (but still renders valid k/M suffixes) is
		// caught here too, not just the totals row.
		const aggregated = aggregateTokens(data)
		expect(aggregated.totals.totalInput).toBe(3000)
		expect(aggregated.totals.totalOutput).toBe(1500)
		expect(aggregated.perModel.get("gpt-4\tKimchi")?.inputTokens).toBe(1000)
		expect(aggregated.perModel.get("gpt-4\tKimchi")?.outputTokens).toBe(500)
		expect(aggregated.perModel.get("claude-3\tKimchi")?.inputTokens).toBe(2000)
		expect(aggregated.perModel.get("claude-3\tKimchi")?.outputTokens).toBe(1000)
	})
})

describe("formatAnalyticsSummary", () => {
	it("uses new tokens field when present", () => {
		const data: GenerateAnalyticsResponse = {
			stepDuration: "0s",
			tokens: {
				items: [
					{
						executionTime: "2026-06-09T09:00:00Z",
						models: [makeModelTokenStat({ inputTokens: 3000, outputTokens: 1500 })],
					},
				],
			},
		}

		const lines = formatAnalyticsSummary(data, mockTheme)
		const joined = lines.join("\n")

		expect(joined).toContain("4.5k")
		expect(joined).toContain("3.0k")
		expect(joined).toContain("1.5k")
	})

	it("aggregates model and source correctly", () => {
		const data: GenerateAnalyticsResponse = {
			stepDuration: "0s",
			tokens: {
				items: [
					{
						executionTime: "2026-06-09T09:00:00Z",
						models: [
							makeModelTokenStat({
								model: "gpt-4",
								providerName: "pi-otel",
								inputTokens: 3000,
								outputTokens: 1500,
							}),
						],
					},
				],
			},
		}

		const lines = formatAnalyticsSummary(data, mockTheme)
		const joined = lines.join("\n")

		expect(joined).toContain("4.5k")
		expect(joined).toContain("3.0k")
		expect(joined).toContain("1.5k")
	})

	it("coerces string int64 token values from protobuf JSON encoding", () => {
		// Protobuf JSON encodes int64 as strings (e.g. "9007199254740991",
		// i.e. Number.MAX_SAFE_INTEGER) because JavaScript Number can't safely
		// represent integers > 2^53. The formatter must parse these strings
		// before aggregating.
		const data: GenerateAnalyticsResponse = {
			stepDuration: "0s",
			tokens: {
				items: [
					{
						executionTime: "2026-06-09T09:00:00Z",
						models: [
							makeModelTokenStat({
								model: "gpt-4",
								providerName: "pi-otel",
								inputTokens: "3000",
								outputTokens: "1500",
							}),
						],
					},
				],
			},
		}

		const lines = formatAnalyticsSummary(data, mockTheme)
		const joined = lines.join("\n")

		expect(joined).toContain("4.5k")
		expect(joined).toContain("3.0k")
		expect(joined).toContain("1.5k")

		// Pin down the numeric aggregation directly so a regression in the
		// aggregation loop is caught by the helper, not just the rendered row.
		const aggregated = aggregateTokens(data)
		expect(aggregated.totals.totalInput).toBe(3000)
		expect(aggregated.totals.totalOutput).toBe(1500)
		expect(aggregated.perModel.get("gpt-4\tKimchi")?.inputTokens).toBe(3000)
		expect(aggregated.perModel.get("gpt-4\tKimchi")?.outputTokens).toBe(1500)
	})
})
