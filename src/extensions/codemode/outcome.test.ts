import type {
	AgentToolResult,
	ExtensionContext,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createCodemodeOutcomeTracker, readCodemodeContextReduction } from "./outcome.js"

function context(sessionId: string): ExtensionContext {
	return createContext({ sessionManager: { getSessionId: () => sessionId } })
}

function nestedStart(toolCallId: string, parentToolCallId?: string): ToolExecutionStartEvent {
	return { type: "tool_execution_start", toolCallId, toolName: "read", args: {}, parentToolCallId }
}

function result(text: string, details: unknown = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details }
}

function nestedEnd(
	toolCallId: string,
	text: string,
	parentToolCallId?: string,
	content: AgentToolResult<unknown>["content"] = [{ type: "text", text }],
): ToolExecutionEndEvent {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName: "read",
		result: { content, details: {} },
		isError: false,
		parentToolCallId,
	}
}

describe("readCodemodeContextReduction", () => {
	it("returns the persisted counters and completeness", () => {
		expect(
			readCodemodeContextReduction({
				contextReduction: { intermediateTextChars: 3500, returnedTextChars: 222, complete: true },
			}),
		).toEqual({ intermediateTextChars: 3500, returnedTextChars: 222, complete: true })
	})

	it("accepts complete=false", () => {
		expect(
			readCodemodeContextReduction({
				contextReduction: { intermediateTextChars: 0, returnedTextChars: 419, complete: false },
			}),
		).toEqual({ intermediateTextChars: 0, returnedTextChars: 419, complete: false })
	})
})

describe("readCodemodeContextReduction invalid records", () => {
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

describe("createCodemodeOutcomeTracker", () => {
	it("counts only results the script received directly, not grandchild results", () => {
		const tracker = createCodemodeOutcomeTracker()
		const ctx = context("session")
		tracker.begin(ctx, "root")
		tracker.nestedStart(ctx, nestedStart("root/child", "root"))
		tracker.nestedStart(ctx, nestedStart("root/child/grandchild", "root/child"))
		tracker.nestedEnd(ctx, nestedEnd("root/child/grandchild", "12345", "root/child"))
		tracker.nestedEnd(ctx, nestedEnd("root/child", "abc", "root"))
		expect(tracker.complete(ctx, "root", result("x"))).toEqual({
			intermediateTextChars: 3,
			returnedTextChars: 1,
			complete: true,
		})
	})

	// Pi hands a script `structuredContent` instead of the text whenever the tool
	// declares an outputSchema (bash, read), so that is what reached the script.
	it("counts the structured value the script received, not the shorter display text", () => {
		const tracker = createCodemodeOutcomeTracker()
		const ctx = context("session")
		tracker.begin(ctx, "root")
		tracker.nestedStart(ctx, nestedStart("root/bash", "root"))
		tracker.nestedStart(ctx, nestedStart("root/read", "root"))
		const structured = { text: "x".repeat(10_000) }
		tracker.nestedEnd(ctx, {
			...nestedEnd("root/bash", "short", "root"),
			result: { content: [{ type: "text", text: "short" }], details: {}, structuredContent: structured },
		})
		tracker.nestedEnd(ctx, {
			...nestedEnd("root/read", "abc", "root"),
			result: { content: [{ type: "text", text: "abc" }], details: {}, structuredContent: "abcdef" },
		})
		expect(tracker.complete(ctx, "root", result("x"))).toEqual({
			intermediateTextChars: JSON.stringify(structured).length + "abcdef".length,
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

describe("createCodemodeOutcomeTracker incomplete accounting", () => {
	it("marks accounting incomplete when a nested call has no completion", () => {
		const tracker = createCodemodeOutcomeTracker()
		const ctx = context("session")
		tracker.begin(ctx, "root")
		tracker.nestedStart(ctx, nestedStart("root/child", "root"))
		expect(tracker.complete(ctx, "root", result("x")).complete).toBe(false)
	})

	it("marks accounting incomplete when a root result arrives after its tracker was cleared", () => {
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
		expect(tracker.complete(ctx, "root", result("x")).complete).toBe(false)
	})

	it("marks accounting incomplete when the script made models.* calls, whose results emit no tool events", () => {
		const tracker = createCodemodeOutcomeTracker()
		const ctx = context("session")
		tracker.begin(ctx, "root")
		const details = { calls: [{ id: "root/models.classify/1", name: "models.classify", args: "p/m", status: "ok" }] }
		expect(tracker.complete(ctx, "root", result("x", details)).complete).toBe(false)
	})

	it("marks accounting incomplete when the returned result carries non-text blocks", () => {
		const tracker = createCodemodeOutcomeTracker()
		const ctx = context("session")
		tracker.begin(ctx, "root")
		const returned: AgentToolResult<unknown> = {
			content: [
				{ type: "text", text: "x" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
			details: {},
		}
		expect(tracker.complete(ctx, "root", returned)).toEqual({
			intermediateTextChars: 0,
			returnedTextChars: 1,
			complete: false,
		})
	})

	it("marks accounting incomplete when a nested result carries non-text blocks", () => {
		const tracker = createCodemodeOutcomeTracker()
		const ctx = context("session")
		tracker.begin(ctx, "root")
		tracker.nestedStart(ctx, nestedStart("root/child", "root"))
		tracker.nestedEnd(
			ctx,
			nestedEnd("root/child", "", "root", [
				{ type: "text", text: "abc" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			]),
		)
		expect(tracker.complete(ctx, "root", result("x"))).toEqual({
			intermediateTextChars: 3,
			returnedTextChars: 1,
			complete: false,
		})
	})
})
