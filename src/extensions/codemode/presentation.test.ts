import { describe, expect, it } from "vitest"
import { codemodeActionSummary, estimatedTokens, formatEstimatedTokenCount } from "./presentation.js"

function call(name: string, status: "running" | "ok" | "error" | "cancelled" = "ok") {
	return { id: `root/${name}`, name, args: "{}", status }
}

describe("codemodeActionSummary", () => {
	it("groups successful calls by action", () => {
		expect(
			codemodeActionSummary({ calls: [call("grep"), call("find"), call("read"), call("read"), call("bash")] }),
		).toBe("searched for 2 patterns, read 2 files, ran 1 command")
	})

	it("counts failed and cancelled calls separately from completed actions", () => {
		expect(
			codemodeActionSummary({
				calls: [call("read"), call("read", "error"), call("read", "error"), call("grep", "cancelled")],
			}),
		).toBe("read 1 file, 2 failed, 1 cancelled")
	})

	it("names models.* calls as model calls", () => {
		expect(codemodeActionSummary({ calls: [call("models.classify"), call("models.generateImages")] })).toBe(
			"made 2 model calls",
		)
	})

	it("returns empty text when no call has finished", () => {
		expect(codemodeActionSummary({ calls: [call("read", "running")] })).toBe("")
		expect(codemodeActionSummary({})).toBe("")
	})
})

describe("estimatedTokens", () => {
	it.each([
		[0, 0],
		[1, 1],
		[4, 1],
		[5, 2],
	])("rounds %s chars up to %s tokens like Pi", (chars, tokens) => {
		expect(estimatedTokens(chars)).toBe(tokens)
	})
})

describe("formatEstimatedTokenCount", () => {
	it.each([
		[999, "999"],
		[9994, "10k"],
		[10_000, "10k"],
		[999_499, "999k"],
		[999_500, "1m"],
		[9_999_499, "10m"],
	])("formats %s as %s", (tokens, expected) => {
		expect(formatEstimatedTokenCount(tokens)).toBe(expected)
	})
})
