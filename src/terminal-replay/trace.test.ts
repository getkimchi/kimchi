import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { boundedTraceStep, type TraceStep, traceStepForEvent } from "./trace.js"

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "test",
		model: "test",
		timestamp: 1,
		content: [{ type: "text", text: "Done" }],
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		...overrides,
	}
}

describe("readable replay trace", () => {
	it("records displayed prompt and final response text without images or thinking", () => {
		expect(
			traceStepForEvent({
				type: "message_start",
				message: {
					role: "user",
					timestamp: 1,
					content: [
						{ type: "text", text: "Check the build" },
						{ type: "image", data: "private-base64", mimeType: "image/png" },
					],
				},
			}),
		).toEqual({ kind: "prompt", title: "Prompt", detail: "Check the build", messageTimestamp: 1 })
		expect(
			traceStepForEvent({
				type: "message_end",
				message: assistant({
					content: [
						{ type: "thinking", thinking: "hidden reasoning" },
						{ type: "text", text: "Build passed" },
					],
				}),
			}),
		).toEqual({ kind: "response", title: "Model response", detail: "Build passed", messageTimestamp: 1 })
		expect(traceStepForEvent({ type: "message_start", message: assistant() })).toBeUndefined()
		expect(
			traceStepForEvent({ type: "message_end", message: { role: "user", content: "Check the build", timestamp: 1 } }),
		).toBeUndefined()
	})

	it("carries only bounded original message identity for export-time matching", () => {
		for (const stopReason of ["stop", "error", "aborted"] as const) {
			const step = traceStepForEvent({
				type: "message_end",
				message: assistant({ timestamp: 123.456, responseId: "response-a", stopReason }),
			})
			expect(step).toMatchObject({ messageTimestamp: 123.456, responseId: "response-a" })
		}
		const bounded = boundedTraceStep({
			kind: "response",
			title: "Response",
			detail: "Done",
			messageTimestamp: Number.NaN,
			responseId: "a".repeat(100_000),
		})
		expect(bounded.messageTimestamp).toBeUndefined()
		expect(bounded.responseId?.length).toBeLessThanOrEqual(1024)
	})

	it("keeps tool call IDs and the displayed result without recording partial output", () => {
		const call = traceStepForEvent({
			type: "tool_execution_start",
			toolCallId: "call-b",
			toolName: "bash",
			args: { command: "pnpm test" },
		})
		expect(call).toMatchObject({ kind: "tool_call", title: "Tool call: bash", toolCallId: "call-b" })
		expect(call?.detail).toContain("pnpm test")
		const result = traceStepForEvent({
			type: "tool_execution_end",
			toolCallId: "call-b",
			toolName: "bash",
			result: {
				content: [
					{ type: "text", text: "Tests failed" },
					{ type: "image", data: "private-base64", mimeType: "image/png" },
				],
				details: { huge: "not included" },
			},
			isError: true,
		})
		expect(result).toEqual({
			kind: "tool_result",
			title: "bash failed",
			toolCallId: "call-b",
			detail: "Tests failed",
			error: true,
		})
		expect(
			traceStepForEvent({
				type: "tool_execution_update",
				toolCallId: "call-b",
				toolName: "bash",
				args: {},
				partialResult: "token",
			}),
		).toBeUndefined()
	})

	it("records a fast failure before its slow sibling and ignores later source-ordered messages", () => {
		const steps: TraceStep[] = []
		const observe = (event: AgentSessionEvent) => {
			const step = traceStepForEvent(event)
			if (step) steps.push(step)
		}
		observe({
			type: "tool_execution_end",
			toolCallId: "second-fast",
			toolName: "fast",
			result: { content: [{ type: "text", text: "Visible failure" }] },
			isError: true,
		})
		// The failure must be available for the next frame while the first tool is still running.
		expect(steps).toEqual([
			{ kind: "tool_result", title: "fast failed", detail: "Visible failure", toolCallId: "second-fast", error: true },
		])
		observe({
			type: "tool_execution_end",
			toolCallId: "first-slow",
			toolName: "slow",
			result: { content: [{ type: "text", text: "Finished later" }] },
			isError: false,
		})
		for (const toolCallId of ["first-slow", "second-fast"]) {
			observe({
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId,
					toolName: toolCallId,
					content: [{ type: "text", text: "Later transcript replacement" }],
					isError: false,
					timestamp: 30_000,
				},
			})
		}
		expect(steps.map(({ toolCallId, error, detail }) => ({ toolCallId, error, detail }))).toEqual([
			{ toolCallId: "second-fast", error: true, detail: "Visible failure" },
			{ toolCallId: "first-slow", error: false, detail: "Finished later" },
		])
	})

	it("distinguishes cancellation, provider failures, and output limits", () => {
		expect(
			traceStepForEvent({
				type: "message_end",
				message: assistant({ stopReason: "aborted", errorMessage: "Operation aborted" }),
			}),
		).toMatchObject({ kind: "error", title: "Response cancelled", error: true, detail: "Operation aborted" })
		expect(
			traceStepForEvent({
				type: "message_end",
				message: assistant({ stopReason: "error", errorMessage: "Provider unavailable" }),
			}),
		).toMatchObject({ kind: "error", title: "Model request failed", error: true, detail: "Provider unavailable" })
		expect(traceStepForEvent({ type: "message_end", message: assistant({ stopReason: "length" }) })).toMatchObject({
			kind: "response",
			title: "Response reached output limit",
		})
	})

	it("bounds traversal and strings instead of serializing whole tool objects", () => {
		const circular: Record<string, unknown> = {
			command: "x".repeat(100_000),
			image: { type: "image", data: "private-base64" },
			toJSON: () => {
				throw new Error("must not call toJSON")
			},
		}
		circular.self = circular
		const call = traceStepForEvent({
			type: "tool_execution_start",
			toolCallId: "call",
			toolName: "bash",
			args: circular,
		})
		expect(call?.detail.length).toBeLessThanOrEqual(8192)
		expect(call?.detail).toContain("…")
		expect(call?.detail).not.toContain("private-base64")
		const withImage = traceStepForEvent({
			type: "tool_execution_start",
			toolCallId: "call",
			toolName: "image_tool",
			args: { source: { type: "image", data: "private-base64" }, path: "screenshot.png" },
		})
		expect(withImage?.detail).toContain("screenshot.png")
		expect(withImage?.detail).not.toContain("private-base64")
	})
})
