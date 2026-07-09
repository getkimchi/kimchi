import { describe, expect, it } from "vitest"
import { DEFAULT_MODEL_ROLES } from "./model-roles.js"
import { orchestratorShouldReceivePhaseGuidelines, resolveModelRoleNames } from "./orchestrator-roles.js"

describe("resolveModelRoleNames", () => {
	it("returns orchestrator and planner for default kimi-k2.7 orchestrator", () => {
		expect(resolveModelRoleNames("kimi-k2.7", DEFAULT_MODEL_ROLES)).toEqual(["orchestrator", "planner", "reviewer"])
	})
})

describe("orchestratorShouldReceivePhaseGuidelines", () => {
	it("never includes build or review worker guidelines", () => {
		expect(orchestratorShouldReceivePhaseGuidelines("build", "kimi-k2.7", DEFAULT_MODEL_ROLES)).toBe(false)
		expect(orchestratorShouldReceivePhaseGuidelines("review", "kimi-k2.7", DEFAULT_MODEL_ROLES)).toBe(false)
	})

	it("includes plan guidelines when orchestrator owns planner", () => {
		expect(orchestratorShouldReceivePhaseGuidelines("plan", "kimi-k2.7", DEFAULT_MODEL_ROLES)).toBe(true)
	})

	it("omits explore guidelines when orchestrator lacks explorer", () => {
		expect(orchestratorShouldReceivePhaseGuidelines("explore", "kimi-k2.7", DEFAULT_MODEL_ROLES)).toBe(false)
	})

	it("omits guidelines when roles are missing", () => {
		expect(orchestratorShouldReceivePhaseGuidelines("plan", "kimi-k2.7", undefined)).toBe(false)
	})
})
