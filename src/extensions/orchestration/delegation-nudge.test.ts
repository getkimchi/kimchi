import { describe, expect, it } from "vitest"
import { DelegationNudge, type OrchestratorMessages, stripDelegationNudges } from "./continuation-nudge.js"

describe("DelegationNudge", () => {
	it("does not nudge when context percent is below threshold", () => {
		const nudge = new DelegationNudge()
		// Simulate 20 tool calls (above minimum) but low context usage
		for (let i = 0; i < 20; i++) nudge.recordToolCall()
		expect(nudge.shouldNudge(40)).toBe(false)
		expect(nudge.shouldNudge(49)).toBe(false)
	})

	it("does not nudge when tool call count is below threshold", () => {
		const nudge = new DelegationNudge()
		// High context usage but only 5 tool calls
		for (let i = 0; i < 5; i++) nudge.recordToolCall()
		expect(nudge.shouldNudge(60)).toBe(false)
		expect(nudge.shouldNudge(80)).toBe(false)
	})

	it("nudges when both context percent and tool calls exceed thresholds", () => {
		const nudge = new DelegationNudge()
		for (let i = 0; i < 20; i++) nudge.recordToolCall()
		expect(nudge.shouldNudge(50)).toBe(true)
		// Already fired — won't fire again until reset
		expect(nudge.shouldNudge(75)).toBe(false)
	})

	it("does not nudge when context percent is null", () => {
		const nudge = new DelegationNudge()
		for (let i = 0; i < 20; i++) nudge.recordToolCall()
		expect(nudge.shouldNudge(null)).toBe(false)
	})

	it("fires only once until reset", () => {
		const nudge = new DelegationNudge()
		for (let i = 0; i < 20; i++) nudge.recordToolCall()
		expect(nudge.shouldNudge(60)).toBe(true)
		// Second call should not fire again
		expect(nudge.shouldNudge(70)).toBe(false)
	})

	it("fires again after resetForNewUserInput", () => {
		const nudge = new DelegationNudge()
		for (let i = 0; i < 20; i++) nudge.recordToolCall()
		expect(nudge.shouldNudge(60)).toBe(true)
		nudge.resetForNewUserInput()
		expect(nudge.shouldNudge(60)).toBe(true)
	})

	it("does not nudge while delegation is pending", () => {
		const nudge = new DelegationNudge()
		for (let i = 0; i < 20; i++) nudge.recordToolCall()
		nudge.markDelegationCall()
		expect(nudge.shouldNudge(80)).toBe(false)
	})

	it("nudges again after delegation result arrives", () => {
		const nudge = new DelegationNudge()
		for (let i = 0; i < 20; i++) nudge.recordToolCall()
		expect(nudge.shouldNudge(60)).toBe(true)
		// Agent result arrives — clears pending and allows re-arming
		nudge.clearDelegationPending()
		// Need new tool calls to exceed threshold again (markDelegationCall reset counter)
		for (let i = 0; i < 20; i++) nudge.recordToolCall()
		expect(nudge.shouldNudge(60)).toBe(true)
	})

	it("markDelegationCall resets tool call counter", () => {
		const nudge = new DelegationNudge()
		for (let i = 0; i < 20; i++) nudge.recordToolCall()
		nudge.markDelegationCall()
		// After delegation, tool counter is reset — need 15 more calls before nudge
		for (let i = 0; i < 14; i++) nudge.recordToolCall()
		expect(nudge.shouldNudge(80)).toBe(false)
		for (let i = 0; i < 2; i++) nudge.recordToolCall()
		// But pending delegation still blocks
		expect(nudge.shouldNudge(80)).toBe(false)
		// Clear pending
		nudge.clearDelegationPending()
		expect(nudge.shouldNudge(80)).toBe(true)
	})

	it("buildNudgeText includes percent and token info", () => {
		const nudge = new DelegationNudge()
		for (let i = 0; i < 18; i++) nudge.recordToolCall()
		const text = nudge.buildNudgeText(52, 104000, 200000)
		expect(text).toContain("52%")
		expect(text).toContain("104k/200k tokens")
		expect(text).toContain("18")
		expect(text).toContain("delegate")
	})

	it("buildNudgeText handles null tokens", () => {
		const nudge = new DelegationNudge()
		for (let i = 0; i < 16; i++) nudge.recordToolCall()
		const text = nudge.buildNudgeText(60, null, null)
		expect(text).toContain("60%")
		expect(text).toContain("16")
		expect(text).toContain("delegate")
	})

	it("buildNudgeText handles null percent", () => {
		const nudge = new DelegationNudge()
		for (let i = 0; i < 16; i++) nudge.recordToolCall()
		const text = nudge.buildNudgeText(null, null, null)
		expect(text).toContain("a high level")
		expect(text).toContain("16")
	})
})

describe("stripDelegationNudges", () => {
	const makeMessages = (): OrchestratorMessages => [
		{ role: "user", content: "do the thing" } as OrchestratorMessages[number],
		{ role: "assistant", content: [{ type: "text", text: "ok" }] } as OrchestratorMessages[number],
	]

	it("removes delegation nudge custom messages", () => {
		const messages = makeMessages()
		const withNudge = [
			...messages,
			{ role: "custom", customType: "delegation_nudge", content: "alert" } as OrchestratorMessages[number],
		]
		const stripped = stripDelegationNudges(withNudge)
		expect(stripped).toEqual(messages)
	})

	it("removes multiple delegation nudges", () => {
		const messages = makeMessages()
		const withNudges = [
			...messages,
			{ role: "custom", customType: "delegation_nudge", content: "alert 1" } as OrchestratorMessages[number],
			{ role: "assistant", content: [{ type: "text", text: "working" }] } as OrchestratorMessages[number],
			{ role: "custom", customType: "delegation_nudge", content: "alert 2" } as OrchestratorMessages[number],
		]
		const stripped = stripDelegationNudges(withNudges)
		expect(stripped).toHaveLength(3) // user, assistant ok, assistant working
		expect(stripped.filter((m) => "customType" in m && m.customType === "delegation_nudge")).toHaveLength(0)
	})

	it("preserves other custom messages", () => {
		const messages = makeMessages()
		const withOther = [
			...messages,
			{ role: "custom", customType: "nudge", content: "call a tool" } as OrchestratorMessages[number],
			{ role: "custom", customType: "delegation_nudge", content: "alert" } as OrchestratorMessages[number],
		]
		const stripped = stripDelegationNudges(withOther)
		expect(stripped).toHaveLength(3) // user, assistant ok, nudge preserved
		expect(stripped.filter((m) => "customType" in m && m.customType === "nudge")).toHaveLength(1)
	})

	it("returns same reference when nothing to strip", () => {
		const messages = makeMessages()
		expect(stripDelegationNudges(messages)).toBe(messages)
	})
})
