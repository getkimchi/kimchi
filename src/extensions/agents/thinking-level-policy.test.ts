import { describe, expect, it } from "vitest"
import {
	bumpThinkingLevel,
	renderDelegationThinkingLevelTable,
	resolveDelegationThinkingLevel,
	thinkingScopeForSubagentType,
} from "./thinking-level-policy.js"

describe("resolveDelegationThinkingLevel", () => {
	it("maps explore simple to minimal and complex to low", () => {
		expect(resolveDelegationThinkingLevel("explore", "simple")).toBe("minimal")
		expect(resolveDelegationThinkingLevel("explore", "complex")).toBe("low")
	})

	it("maps build complex to high", () => {
		expect(resolveDelegationThinkingLevel("build", "complex")).toBe("high")
	})

	it("bumps one tier on retry for build complex up to xhigh", () => {
		expect(resolveDelegationThinkingLevel("build", "complex", 1)).toBe("xhigh")
	})

	it("bumps explore complex to medium on retry and caps there", () => {
		expect(resolveDelegationThinkingLevel("explore", "complex", 1)).toBe("medium")
		expect(resolveDelegationThinkingLevel("explore", "complex", 2)).toBe("medium")
	})

	it("keeps plan at high even on retry", () => {
		expect(resolveDelegationThinkingLevel("plan", "simple", 1)).toBe("high")
	})
})

describe("bumpThinkingLevel", () => {
	it("respects ceiling", () => {
		expect(bumpThinkingLevel("high", 2, "high")).toBe("high")
	})
})

describe("thinkingScopeForSubagentType", () => {
	it("maps Builder to build scope", () => {
		expect(thinkingScopeForSubagentType("Builder")).toBe("build")
	})

	it("returns undefined for unknown types", () => {
		expect(thinkingScopeForSubagentType("General-Purpose")).toBeUndefined()
	})
})

describe("renderDelegationThinkingLevelTable", () => {
	it("includes agent types and thinking levels", () => {
		const table = renderDelegationThinkingLevelTable()
		expect(table).toContain("| Build chunk | Builder |")
		expect(table).toContain("complex chunk")
	})
})
