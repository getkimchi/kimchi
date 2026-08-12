import type { TurnEndEvent } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import thinkingBudgetGuardExtension, {
	DEFAULT_STREAK_MIN_THINKING_CHARS,
	DEFAULT_STREAK_THRESHOLD,
	DEFAULT_THINKING_BUDGET_CHARS,
	STEER_MESSAGE_TYPE,
	ThinkingBudgetGuard,
} from "./thinking-budget-guard.js"

type AssistantMsg = TurnEndEvent["message"]

function assistantMessage(opts: {
	thinkingChars?: number
	toolCalls?: string[]
	stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted"
	text?: string
}): AssistantMsg {
	const content: unknown[] = []
	if (opts.thinkingChars) {
		content.push({ type: "thinking", thinking: "x".repeat(opts.thinkingChars) })
	}
	if (opts.text) content.push({ type: "text", text: opts.text })
	for (const name of opts.toolCalls ?? []) {
		content.push({ type: "toolCall", id: `t-${name}-${content.length}`, name, arguments: {} })
	}
	return {
		role: "assistant",
		content,
		stopReason: opts.stopReason ?? "stop",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
		timestamp: 0,
	} as unknown as AssistantMsg
}

const HEAVY = DEFAULT_STREAK_MIN_THINKING_CHARS + 1

describe("ThinkingBudgetGuard — talk-only triggers", () => {
	it("steers when a turn is length-truncated with zero tool calls", () => {
		const guard = new ThinkingBudgetGuard()
		const steer = guard.observeTurn(assistantMessage({ thinkingChars: 50_000, stopReason: "length" }))
		expect(steer?.trigger).toBe("length_truncation")
		expect(steer?.text).toContain("output token limit")
	})

	it("steers when thinking exceeds the per-turn budget with zero tool calls", () => {
		const guard = new ThinkingBudgetGuard()
		const chars = DEFAULT_THINKING_BUDGET_CHARS + 1
		const steer = guard.observeTurn(assistantMessage({ thinkingChars: chars }))
		expect(steer?.trigger).toBe("thinking_overrun")
		expect(steer?.text).toContain(String(chars))
	})

	it("does not steer when thinking stays under budget and no tool calls are made", () => {
		const guard = new ThinkingBudgetGuard()
		expect(guard.observeTurn(assistantMessage({ thinkingChars: DEFAULT_THINKING_BUDGET_CHARS }))).toBeUndefined()
	})

	it("does not steer when the length-truncated turn contained tool calls", () => {
		const guard = new ThinkingBudgetGuard()
		expect(
			guard.observeTurn(assistantMessage({ thinkingChars: 90_000, stopReason: "length", toolCalls: ["edit"] })),
		).toBeUndefined()
	})

	it("does not steer on error or aborted turns — the model never got to finish", () => {
		const guard = new ThinkingBudgetGuard()
		expect(guard.observeTurn(assistantMessage({ thinkingChars: 200_000, stopReason: "error" }))).toBeUndefined()
		expect(guard.observeTurn(assistantMessage({ thinkingChars: 200_000, stopReason: "aborted" }))).toBeUndefined()
	})

	it("ignores non-assistant messages", () => {
		const guard = new ThinkingBudgetGuard()
		const user = { role: "user", content: "hello", timestamp: 0 } as unknown as AssistantMsg
		expect(guard.observeTurn(user)).toBeUndefined()
	})
})

describe("ThinkingBudgetGuard — failure-state streak", () => {
	it("fires exactly one steer across a 4-round heavy-think no-action streak", () => {
		const guard = new ThinkingBudgetGuard()
		const results = []
		for (let round = 0; round < 4; round++) {
			results.push(guard.observeTurn(assistantMessage({ thinkingChars: HEAVY })))
		}
		expect(results[0]).toBeUndefined()
		expect(results[1]).toBeUndefined()
		expect(results[2]?.trigger).toBe("think_only_streak")
		expect(results[2]?.text).toContain("failure output is information")
		// Streak reset after the steer — round 4 starts a fresh window.
		expect(results[3]).toBeUndefined()
		expect(guard.getConsecutiveThinkOnlyRounds()).toBe(1)
	})

	it("resets the streak on a mutating tool call", () => {
		const guard = new ThinkingBudgetGuard()
		guard.observeTurn(assistantMessage({ thinkingChars: HEAVY }))
		guard.observeTurn(assistantMessage({ thinkingChars: HEAVY }))
		guard.observeTurn(assistantMessage({ thinkingChars: HEAVY, toolCalls: ["bash"] }))
		guard.observeTurn(assistantMessage({ thinkingChars: HEAVY }))
		expect(guard.observeTurn(assistantMessage({ thinkingChars: HEAVY }))).toBeUndefined()
		expect(guard.getConsecutiveThinkOnlyRounds()).toBe(2)
	})

	it("read-only tool calls do not break the streak", () => {
		const guard = new ThinkingBudgetGuard()
		guard.observeTurn(assistantMessage({ thinkingChars: HEAVY, toolCalls: ["read"] }))
		guard.observeTurn(assistantMessage({ thinkingChars: HEAVY, toolCalls: ["grep", "ls"] }))
		const steer = guard.observeTurn(assistantMessage({ thinkingChars: HEAVY, toolCalls: ["read"] }))
		expect(steer?.trigger).toBe("think_only_streak")
	})

	it("light-thinking rounds reset the streak", () => {
		const guard = new ThinkingBudgetGuard()
		guard.observeTurn(assistantMessage({ thinkingChars: HEAVY }))
		guard.observeTurn(assistantMessage({ thinkingChars: HEAVY }))
		guard.observeTurn(assistantMessage({ thinkingChars: DEFAULT_STREAK_MIN_THINKING_CHARS }))
		guard.observeTurn(assistantMessage({ thinkingChars: HEAVY }))
		expect(guard.observeTurn(assistantMessage({ thinkingChars: HEAVY }))).toBeUndefined()
	})

	it("edit and write calls count as mutating action", () => {
		const guard = new ThinkingBudgetGuard()
		guard.observeTurn(assistantMessage({ thinkingChars: HEAVY }))
		guard.observeTurn(assistantMessage({ thinkingChars: HEAVY }))
		guard.observeTurn(assistantMessage({ thinkingChars: HEAVY, toolCalls: ["write"] }))
		expect(guard.getConsecutiveThinkOnlyRounds()).toBe(0)
	})

	it("replays a passing-trial shape with zero interventions", () => {
		const guard = new ThinkingBudgetGuard()
		const rounds: AssistantMsg[] = [
			// Deep read-thinking, then act — the productive interleave of a real pass.
			assistantMessage({ thinkingChars: 30_000, toolCalls: ["read", "grep"] }),
			assistantMessage({ thinkingChars: 25_000, toolCalls: ["bash"] }),
			assistantMessage({ thinkingChars: 10_000, toolCalls: ["edit"] }),
			assistantMessage({ thinkingChars: 30_000, toolCalls: ["read"] }),
			assistantMessage({ thinkingChars: 2_000 }),
			assistantMessage({ thinkingChars: 12_000, toolCalls: ["write"], stopReason: "toolUse" }),
		]
		for (const round of rounds) {
			expect(guard.observeTurn(round)).toBeUndefined()
		}
	})

	it("respects custom thresholds", () => {
		const guard = new ThinkingBudgetGuard({
			thinkingBudgetChars: 100,
			streakMinThinkingChars: 50,
			streakThreshold: 2,
		})
		expect(guard.observeTurn(assistantMessage({ thinkingChars: 101 }))?.trigger).toBe("thinking_overrun")

		const streakGuard = new ThinkingBudgetGuard({ streakMinThinkingChars: 50, streakThreshold: 2 })
		streakGuard.observeTurn(assistantMessage({ thinkingChars: 60, toolCalls: ["bash_proxy"] }))
		expect(streakGuard.observeTurn(assistantMessage({ thinkingChars: 60 }))?.trigger).toBe("think_only_streak")
	})

	it("reset() clears the streak", () => {
		const guard = new ThinkingBudgetGuard()
		guard.observeTurn(assistantMessage({ thinkingChars: HEAVY }))
		guard.observeTurn(assistantMessage({ thinkingChars: HEAVY }))
		guard.reset()
		expect(guard.getConsecutiveThinkOnlyRounds()).toBe(0)
		expect(guard.observeTurn(assistantMessage({ thinkingChars: HEAVY }))).toBeUndefined()
	})

	it("streak steer text names the configured threshold", () => {
		const guard = new ThinkingBudgetGuard({ streakMinThinkingChars: 10, streakThreshold: 3 })
		guard.observeTurn(assistantMessage({ thinkingChars: 20 }))
		guard.observeTurn(assistantMessage({ thinkingChars: 20 }))
		expect(guard.observeTurn(assistantMessage({ thinkingChars: 20 }))?.text).toContain("3 consecutive rounds")
		expect(DEFAULT_STREAK_THRESHOLD).toBe(3)
	})
})

describe("thinkingBudgetGuardExtension", () => {
	const ctx = createContext()

	function turnEnd(message: AssistantMsg) {
		return { type: "turn_end", turnIndex: 0, message, toolResults: [] }
	}

	it("sends a steering message on a length-truncated no-tool turn", () => {
		const { api, getHandler, sendMessage } = createExtensionApi()
		thinkingBudgetGuardExtension(api)

		getHandler("turn_end")(turnEnd(assistantMessage({ thinkingChars: 50_000, stopReason: "length" })), ctx)

		expect(sendMessage).toHaveBeenCalledTimes(1)
		const [message, options] = sendMessage.mock.calls[0] as unknown as [
			{ customType: string; display: boolean; content: Array<{ type: "text"; text: string }> },
			{ deliverAs: string },
		]
		expect(message.customType).toBe(STEER_MESSAGE_TYPE)
		expect(message.display).toBe(false)
		expect(options.deliverAs).toBe("steer")
		expect(message.content[0]?.text).toContain("output token limit")
	})

	it("sends nothing on a normal productive turn", () => {
		const { api, getHandler, sendMessage } = createExtensionApi()
		thinkingBudgetGuardExtension(api)

		getHandler("turn_end")(turnEnd(assistantMessage({ thinkingChars: 40_000, toolCalls: ["read"] })), ctx)

		expect(sendMessage).not.toHaveBeenCalled()
	})

	it("user input resets the streak", () => {
		const { api, getHandler, sendMessage } = createExtensionApi()
		thinkingBudgetGuardExtension(api)

		const handler = getHandler("turn_end")
		handler(turnEnd(assistantMessage({ thinkingChars: HEAVY })), ctx)
		handler(turnEnd(assistantMessage({ thinkingChars: HEAVY })), ctx)
		getHandler("input")({ source: "user" }, ctx)
		handler(turnEnd(assistantMessage({ thinkingChars: HEAVY })), ctx)

		expect(sendMessage).not.toHaveBeenCalled()
	})

	it("extension-sourced input does not reset the streak", () => {
		const { api, getHandlers, sendMessage } = createExtensionApi()
		thinkingBudgetGuardExtension(api)

		const handler = getHandlers("turn_end")[0]!
		handler(turnEnd(assistantMessage({ thinkingChars: HEAVY })), ctx)
		handler(turnEnd(assistantMessage({ thinkingChars: HEAVY })), ctx)
		getHandlers("input")[0]!({ source: "extension" }, ctx)
		handler(turnEnd(assistantMessage({ thinkingChars: HEAVY })), ctx)

		expect(sendMessage).toHaveBeenCalledTimes(1)
	})
})
