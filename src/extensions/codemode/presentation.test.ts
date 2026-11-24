import type { AgentToolResult } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import {
	codemodeActionSummary,
	codemodeFailureReason,
	estimatedTokens,
	formatEstimatedTokenCount,
	truncateForDisplay,
} from "./presentation.js"

function call(name: string, status: "running" | "ok" | "error" | "cancelled" = "ok", args: unknown = {}) {
	return { id: `root/${name}`, name, args: JSON.stringify(args), status }
}

function failed(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: {} }
}

describe("codemodeActionSummary", () => {
	it("groups successful calls by action", () => {
		expect(
			codemodeActionSummary({
				calls: [
					call("grep", "ok", { pattern: "a" }),
					call("find", "ok", { pattern: "*.ts" }),
					call("read", "ok", { path: "a.ts" }),
					call("read", "ok", { path: "b.ts" }),
					call("bash", "ok", { command: "ls" }),
				],
			}),
		).toBe("searched for 2 patterns, read 2 files, ran 1 command")
	})

	it("counts distinct files and patterns, not calls", () => {
		expect(
			codemodeActionSummary({
				calls: [
					call("read", "ok", { path: "a.ts" }),
					call("read", "ok", { path: "a.ts", offset: 100 }),
					call("read", "ok", { path: "a.ts" }),
					call("grep", "ok", { pattern: "x" }),
					call("grep", "ok", { pattern: "x" }),
				],
			}),
		).toBe("read 1 file, searched for 1 pattern")
	})

	it("counts calls apart when Pi cut their args preview", () => {
		// Pi keeps 200 characters of the args JSON; both previews below are the same text.
		const dir = "d".repeat(200)
		const cut = (name: string, id: string, args: unknown) => ({
			id,
			name,
			args: `${JSON.stringify(args).slice(0, 197)}...`,
			status: "ok" as const,
		})
		expect(
			codemodeActionSummary({
				calls: [
					cut("read", "root/1", { path: `${dir}/one.txt` }),
					cut("read", "root/2", { path: `${dir}/two.txt` }),
					call("read", "ok", { path: "a.ts" }),
					call("read", "ok", { path: "a.ts" }),
					cut("grep", "root/5", { pattern: `${dir}one` }),
					cut("grep", "root/6", { pattern: `${dir}two` }),
				],
			}),
		).toBe("read 3 files, searched for 2 patterns")
	})

	it("names the tool when every other call is the same tool", () => {
		expect(codemodeActionSummary({ calls: [call("search_issues"), call("search_issues")] })).toBe(
			"called search_issues ×2",
		)
		expect(codemodeActionSummary({ calls: [call("search_issues")] })).toBe("called search_issues")
	})

	it("counts operations when other calls span several tools", () => {
		expect(codemodeActionSummary({ calls: [call("search_issues"), call("get_issue"), call("get_issue")] })).toBe(
			"3 operations",
		)
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

describe("codemodeFailureReason", () => {
	it("returns the first line of the script error", () => {
		expect(
			codemodeFailureReason(
				failed(
					"Script failed\nWall time 0.0 seconds\nOutput:\n\nScript error:\nTypeError: cannot read property 'items' of undefined\n    at <anonymous> (codemode.js:3:8)",
				),
			),
		).toBe("TypeError: cannot read property 'items' of undefined")
	})

	it("ignores the marker in the script's own output", () => {
		expect(
			codemodeFailureReason(
				failed(
					"Script failed\nWall time 0.0 seconds\nOutput:\napp.log:17: Script error: disk full\nScript error:\nnot the reason\nScript error:\nTypeError: cannot read property 'items' of undefined\n    at <anonymous> (codemode.js:3:8)\n\nNo tool calls were made.",
				),
			),
		).toBe("TypeError: cannot read property 'items' of undefined")
	})

	it("keeps an error message that contains the marker whole", () => {
		expect(
			codemodeFailureReason(
				failed(
					"Script failed\nWall time 0.0 seconds\nOutput:\n\nScript error:\nError: upstream said: Script error: disk full\n    at <anonymous> (codemode.js:1:7)\n\nNo tool calls were made.",
				),
			),
		).toBe("Error: upstream said: Script error: disk full")
	})

	it("returns the first line of an error thrown before the script ran", () => {
		expect(
			codemodeFailureReason(failed("@options only supports `max_output_tokens` and `timeout_ms`; got `timeout`")),
		).toBe("@options only supports `max_output_tokens` and `timeout_ms`; got `timeout`")
	})

	it("cuts a long reason to one display line", () => {
		const reason = codemodeFailureReason(failed(`Script error:\nError: ${"x".repeat(300)}`))
		expect(reason).toHaveLength(120)
		expect(reason?.endsWith("…")).toBe(true)
	})

	it("returns undefined when the result carries no text", () => {
		expect(codemodeFailureReason({ content: [], details: {} })).toBeUndefined()
		expect(codemodeFailureReason(failed("Script failed\nWall time 0.0 seconds\nOutput:\n"))).toBeUndefined()
	})
})

describe("truncateForDisplay", () => {
	it("keeps text within the limit unchanged", () => {
		expect(truncateForDisplay("abc", 3)).toBe("abc")
	})

	it("counts code points, so emoji are not split or double counted", () => {
		const emoji = "😀".repeat(5)
		expect(truncateForDisplay(emoji, 5)).toBe(emoji)
		expect(truncateForDisplay(`${emoji}😀`, 5)).toBe(`${"😀".repeat(4)}…`)
	})
})
