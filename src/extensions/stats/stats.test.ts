import { describe, expect, it } from "vitest"
import { formatCount } from "../format.js"
import { getTimeRange } from "./api.js"
import { parseStatsArgs } from "./index.js"
import { type SortBy, formatCurrency, getProviderDisplayName, getSourceName, sortFn } from "./visual.js"

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
