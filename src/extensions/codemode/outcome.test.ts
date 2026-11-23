import type {
	AgentToolResult,
	ExtensionContext,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { createContext } from "../__mocks__/context.js"
import {
	codemodePurpose,
	createCodemodeOutcomeTracker,
	formatEstimatedTokenCount,
	readCodemodeContextReduction,
} from "./outcome.js"

function context(sessionId: string): ExtensionContext {
	return createContext({ sessionManager: { getSessionId: () => sessionId } })
}

function nestedStart(toolCallId: string, parentToolCallId?: string): ToolExecutionStartEvent {
	return { type: "tool_execution_start", toolCallId, toolName: "read", args: {}, parentToolCallId }
}

function result(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: {} }
}

function nestedEnd(toolCallId: string, text: string, parentToolCallId?: string): ToolExecutionEndEvent {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName: "read",
		result: result(text),
		isError: false,
		parentToolCallId,
	}
}

describe("codemodePurpose", () => {
	it("reads and normalizes a first-line purpose", () => {
		expect(codemodePurpose({ code: "// @description:  Filter   files   by name \nreturn 'ok';" })).toBe(
			"Filter files by name",
		)
	})

	it("reads purpose immediately after @options", () => {
		expect(
			codemodePurpose({ code: '// @options: {"max_output_tokens": 40}\n// @description: Filter files\nreturn "ok";' }),
		).toBe("Filter files")
	})

	it("accepts exactly 120 characters", () => {
		expect(codemodePurpose({ code: `// @description: ${"x".repeat(120)}` })).toHaveLength(120)
	})

	it.each([
		"// @description: Filter files\n// @options: {}",
		"const x = 1;\n// @description: Late purpose",
		`// @description: ${"x".repeat(121)}`,
		"// @description:    \nreturn 1",
	])("returns the fallback for invalid purpose metadata: %j", (code) => {
		expect(codemodePurpose({ code })).toBeUndefined()
	})

	it("handles a CRLF @options line", () => {
		expect(codemodePurpose({ code: "// @options: {}\r\n// @description: Filter files\r\nreturn 1" })).toBe(
			"Filter files",
		)
	})
})

describe("readCodemodeContextReduction", () => {
	it("returns the persisted counters and completeness, ignoring a legacy combined estimate", () => {
		expect(
			readCodemodeContextReduction({
				contextReduction: {
					intermediateTextChars: 3500,
					returnedTextChars: 222,
					estimatedTokensKeptOut: 820,
					complete: true,
				},
			}),
		).toEqual({ intermediateTextChars: 3500, returnedTextChars: 222, complete: true })
	})

	it("accepts complete=false without a derived estimate", () => {
		expect(
			readCodemodeContextReduction({
				contextReduction: { intermediateTextChars: 0, returnedTextChars: 419, complete: false },
			}),
		).toEqual({
			intermediateTextChars: 0,
			returnedTextChars: 419,
			complete: false,
		})
	})

	it.each([
		{ intermediateTextChars: -1, returnedTextChars: 1, complete: true },
		{ intermediateTextChars: 1.5, returnedTextChars: 1, complete: true },
		{ intermediateTextChars: Number.POSITIVE_INFINITY, returnedTextChars: 1, complete: true },
		{ intermediateTextChars: 5, returnedTextChars: "5", complete: true },
		{ intermediateTextChars: 5, returnedTextChars: 1, complete: "true" },
	])("rejects invalid persisted counters: %j", (contextReduction) => {
		expect(readCodemodeContextReduction({ contextReduction })).toBeUndefined()
	})

	it("rejects a missing contextReduction", () => {
		expect(readCodemodeContextReduction({ calls: [] })).toBeUndefined()
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

describe("createCodemodeOutcomeTracker", () => {
	it("includes direct and descendant results in first-end ordering", () => {
		const tracker = createCodemodeOutcomeTracker()
		const ctx = context("session")
		tracker.begin(ctx, "root")
		tracker.nestedStart(ctx, nestedStart("root/child", "root"))
		tracker.nestedStart(ctx, nestedStart("root/child/grandchild", "root/child"))
		tracker.nestedEnd(ctx, nestedEnd("root/child/grandchild", "12345", "root/child"))
		tracker.nestedEnd(ctx, nestedEnd("root/child", "abc", "root"))
		expect(tracker.complete(ctx, "root", result("x"))).toEqual({
			intermediateTextChars: 8,
			returnedTextChars: 1,
			complete: true,
		})
	})

	it("ignores unknown-parent events instead of counting or contaminating them", () => {
		const tracker = createCodemodeOutcomeTracker()
		const ctx = context("session")
		tracker.begin(ctx, "root")
		tracker.nestedEnd(ctx, nestedEnd("other/child", "long output", "unknown-parent"))
		expect(tracker.complete(ctx, "root", result("x"))).toEqual({
			intermediateTextChars: 0,
			returnedTextChars: 1,
			complete: true,
		})
	})

	it("counts duplicate nested completion only once", () => {
		const tracker = createCodemodeOutcomeTracker()
		const ctx = context("session")
		tracker.begin(ctx, "root")
		tracker.nestedStart(ctx, nestedStart("root/child", "root"))
		tracker.nestedEnd(ctx, nestedEnd("root/child", "abc", "root"))
		tracker.nestedEnd(ctx, nestedEnd("root/child", "abc", "root"))
		expect(tracker.complete(ctx, "root", result("x"))).toEqual({
			intermediateTextChars: 3,
			returnedTextChars: 1,
			complete: true,
		})
	})

	it("marks accounting incomplete when a nested call has no completion", () => {
		const tracker = createCodemodeOutcomeTracker()
		const ctx = context("session")
		tracker.begin(ctx, "root")
		tracker.nestedStart(ctx, nestedStart("root/child", "root"))
		expect(tracker.complete(ctx, "root", result("x"))).toEqual({
			intermediateTextChars: 0,
			returnedTextChars: 1,
			complete: false,
		})
	})

	it("completes without begin when a root result arrives after its tracker was cleared", () => {
		const tracker = createCodemodeOutcomeTracker()
		const ctx = context("session")
		expect(tracker.complete(ctx, "missing", result("x"))).toEqual({
			intermediateTextChars: 0,
			returnedTextChars: 1,
			complete: false,
		})
	})

	it("discards per-call state and ignores subsequent nested completion", () => {
		const tracker = createCodemodeOutcomeTracker()
		const ctx = context("session")
		tracker.begin(ctx, "root")
		tracker.nestedStart(ctx, nestedStart("root/child", "root"))
		tracker.discard(ctx, "root")
		tracker.nestedEnd(ctx, nestedEnd("root/child", "abc", "root"))
		expect(tracker.complete(ctx, "root", result("x"))).toEqual({
			intermediateTextChars: 0,
			returnedTextChars: 1,
			complete: false,
		})
	})

	it("clears only the discarded session with identical tool-call ids", () => {
		const tracker = createCodemodeOutcomeTracker()
		const first = context("first")
		const second = context("second")
		for (const ctx of [first, second]) {
			tracker.begin(ctx, "root")
			tracker.nestedStart(ctx, nestedStart("root/child", "root"))
		}
		tracker.discard(first)
		tracker.nestedEnd(first, nestedEnd("root/child", "ignored", "root"))
		tracker.nestedEnd(second, nestedEnd("root/child", "kept", "root"))
		expect(tracker.complete(first, "root", result("x"))).toEqual({
			intermediateTextChars: 0,
			returnedTextChars: 1,
			complete: false,
		})
		expect(tracker.complete(second, "root", result("x"))).toEqual({
			intermediateTextChars: 4,
			returnedTextChars: 1,
			complete: true,
		})
	})
})
