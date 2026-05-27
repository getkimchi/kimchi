import { afterEach, describe, expect, it } from "vitest"
import { buildDispatchOnlyBlock, buildFullOrchestratorBlock } from "./orchestrator-block.js"

type P = NodeJS.Process & { __kimchiMultiModelEnabled?: boolean; __kimchiCurrentModelRef?: string }

afterEach(() => {
	;(process as P).__kimchiMultiModelEnabled = undefined
	;(process as P).__kimchiCurrentModelRef = undefined
})

describe("buildFullOrchestratorBlock", () => {
	it("contains Your Team section with default persona names", () => {
		const result = buildFullOrchestratorBlock({ permissionMode: "default" })
		expect(result).toContain("## Your Team")
		expect(result).toContain("Builder")
		expect(result).toContain("Reviewer")
		expect(result).toContain("Explorer")
	})

	it("contains plan-build-review pipeline prose in default mode", () => {
		const result = buildFullOrchestratorBlock({ permissionMode: "default" })
		expect(result).toContain("Plan phase")
		expect(result).toContain("Build phase")
		expect(result).toContain("Review phase")
		expect(result).toContain("Token budgets")
	})

	it("contains dispatch mechanics (no model parameter)", () => {
		const result = buildFullOrchestratorBlock({ permissionMode: "default" })
		expect(result).toContain("Do NOT pass a `model` parameter")
		expect(result).toContain('subagent_type: "Builder"')
	})

	it("contains self-serve plan rule when multi-model is off", () => {
		;(process as P).__kimchiMultiModelEnabled = false
		const result = buildFullOrchestratorBlock({ permissionMode: "default" })
		expect(result).toContain("always write the plan yourself")
		expect(result).not.toContain("delegate to the **Planner** model")
	})

	it("plan mode contains classify → plan → STOP prose", () => {
		const result = buildFullOrchestratorBlock({ permissionMode: "plan" })
		expect(result).toContain("Plan mode")
		expect(result).toContain("STOP")
		expect(result).toContain("Do not proceed to implementation")
	})

	it("plan mode still contains Your Team and dispatch mechanics", () => {
		const result = buildFullOrchestratorBlock({ permissionMode: "plan" })
		expect(result).toContain("## Your Team")
		expect(result).toContain("Do NOT pass a `model` parameter")
	})

	it("does not contain model IDs or provider strings", () => {
		const result = buildFullOrchestratorBlock({ permissionMode: "default" })
		expect(result).not.toContain("kimchi-dev/kimi-k2.6")
		expect(result).not.toContain("kimchi-dev/minimax-m2.7")
	})
})

describe("buildDispatchOnlyBlock", () => {
	it("contains Your Team section", () => {
		const result = buildDispatchOnlyBlock()
		expect(result).toContain("## Your Team")
		expect(result).toContain("Builder")
		expect(result).toContain("Reviewer")
	})

	it("contains intent-to-persona mapping", () => {
		const result = buildDispatchOnlyBlock()
		expect(result).toContain("Matching intent to persona")
	})

	it("contains dispatch mechanics", () => {
		const result = buildDispatchOnlyBlock()
		expect(result).toContain("Do NOT pass a `model` parameter")
		expect(result).toContain('subagent_type: "Builder"')
	})

	it("does NOT contain plan-build-review pipeline prose", () => {
		const result = buildDispatchOnlyBlock()
		expect(result).not.toContain("Mandatory pipeline for complex tasks")
		expect(result).not.toContain("Token budgets")
		expect(result).not.toContain("Plan self-validation")
	})

	it("does NOT contain plan-mode STOP instructions", () => {
		const result = buildDispatchOnlyBlock()
		expect(result).not.toContain("Do not proceed to implementation")
	})
})
