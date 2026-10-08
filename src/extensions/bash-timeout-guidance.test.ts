import { describe, expect, it } from "vitest"
import { isBashLimitResult } from "./bash-timeout-guidance.js"

function makeToolResult(
	overrides: Partial<{
		toolName: string
		isError: boolean
		content: Array<{ type: "text"; text: string }>
	}>,
): {
	type: "tool_result"
	toolCallId: string
	toolName: string
	input: Record<string, unknown>
	content: Array<{ type: "text"; text: string }>
	isError: boolean
	details: unknown
} {
	return {
		type: "tool_result",
		toolCallId: "call-1",
		toolName: "bash",
		input: {},
		content: [{ type: "text", text: "" }],
		isError: true,
		details: undefined,
		...overrides,
	}
}

describe("isBashLimitResult", () => {
	it("returns true for a bash result containing a harness safety-limit error", () => {
		const event = makeToolResult({
			toolName: "bash",
			isError: true,
			content: [{ type: "text", text: "Progress: 50%\n\nProcess killed by the harness safety limit (3600s)" }],
		})
		expect(isBashLimitResult(event)).toBe(true)
	})

	it("returns true for a legacy timeout error (subagent clamps)", () => {
		const event = makeToolResult({
			toolName: "bash",
			isError: true,
			content: [{ type: "text", text: "Progress: 50%\n\nCommand timed out after 600 seconds" }],
		})
		expect(isBashLimitResult(event)).toBe(true)
	})

	it("returns false when the result is not an error", () => {
		const event = makeToolResult({
			toolName: "bash",
			isError: false,
			content: [{ type: "text", text: "Process killed by the harness safety limit (3600s)" }],
		})
		expect(isBashLimitResult(event)).toBe(false)
	})

	it("returns false for a non-timeout error", () => {
		const event = makeToolResult({
			toolName: "bash",
			isError: true,
			content: [{ type: "text", text: "Command exited with code 1" }],
		})
		expect(isBashLimitResult(event)).toBe(false)
	})

	it("returns false for non-bash tool results", () => {
		const event = makeToolResult({
			toolName: "read",
			isError: true,
			content: [{ type: "text", text: "Command timed out after 600 seconds" }],
		})
		expect(isBashLimitResult(event)).toBe(false)
	})
})
