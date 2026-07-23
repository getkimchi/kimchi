import type { AssistantMessage, Context, ToolCall } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { shouldReviewCouncilTurn } from "./review-policy.js"

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function toolCall(name: string, args: Record<string, unknown> = {}): AssistantMessage {
	const call: ToolCall = { type: "toolCall", id: `${name}-1`, name, arguments: args }
	return {
		role: "assistant",
		content: [call],
		api: "openai-completions",
		provider: "physical",
		model: "model",
		usage,
		stopReason: "toolUse",
		timestamp: 2,
	}
}

function answer(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "physical",
		model: "model",
		usage,
		stopReason: "stop",
		timestamp: 2,
	}
}

function context(...messages: Context["messages"]): Context {
	return { messages }
}

describe("shouldReviewCouncilTurn", () => {
	it("skips direct and read-only tool turns", () => {
		expect(shouldReviewCouncilTurn(context({ role: "user", content: "Explain this", timestamp: 1 }), "changes")).toBe(
			false,
		)
		expect(
			shouldReviewCouncilTurn(
				context(
					{ role: "user", content: "Read three files", timestamp: 1 },
					toolCall("find", { pattern: "src/**/*.ts" }),
					toolCall("read", { path: "src/a.ts" }),
					toolCall("bash", { command: "python3 -c 'print(open(\"src/a.ts\").read())'" }),
				),
				"changes",
			),
		).toBe(false)
	})

	it.each([
		["edit tool", toolCall("edit", { path: "src/a.ts" })],
		["write tool", toolCall("write", { path: "src/a.ts" })],
		["shell edit", toolCall("bash", { command: "sed -i 's/a/b/' src/a.ts" })],
		["shell write", toolCall("bash", { command: "echo changed > src/a.ts" })],
	])("reviews a current-turn %s", (_name, mutation) => {
		expect(
			shouldReviewCouncilTurn(context({ role: "user", content: "Change it", timestamp: 1 }, mutation), "changes"),
		).toBe(true)
	})

	it("ignores changes from an earlier user turn", () => {
		expect(
			shouldReviewCouncilTurn(
				context(
					{ role: "user", content: "Change it", timestamp: 1 },
					toolCall("edit", { path: "src/a.ts" }),
					answer("Changed"),
					{ role: "user", content: "Now just explain it", timestamp: 3 },
					toolCall("read", { path: "src/a.ts" }),
				),
				"changes",
			),
		).toBe(false)
	})

	it("recognizes a successful edit result when the tool-call message is absent", () => {
		expect(
			shouldReviewCouncilTurn(
				context(
					{ role: "user", content: "Change it", timestamp: 1 },
					{
						role: "toolResult",
						toolCallId: "edit-1",
						toolName: "edit",
						content: [{ type: "text", text: "updated" }],
						isError: false,
						timestamp: 2,
					},
				),
				"changes",
			),
		).toBe(true)
	})

	it("supports explicit unconditional review", () => {
		expect(shouldReviewCouncilTurn(context({ role: "user", content: "Hello", timestamp: 1 }), "always")).toBe(true)
	})
})
