import { describe, expect, it } from "vitest"
import { DEFAULT_MODEL_ROLES } from "./model-roles.js"
import {
	orchestratorShouldReceivePhaseGuidelines,
	resolveModelRoleNames,
	shouldDelegatePlanning,
} from "./orchestrator-roles.js"

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

describe("shouldDelegatePlanning", () => {
	it("returns false when orchestrator is the planner model", () => {
		expect(shouldDelegatePlanning("kimi-k2.7", DEFAULT_MODEL_ROLES)).toBe(false)
	})

	it("returns true when orchestrator is not the planner model", () => {
		const roles = { ...DEFAULT_MODEL_ROLES, planner: "anthropic/claude-opus-4-7" }
		expect(shouldDelegatePlanning("kimi-k2.6", roles)).toBe(true)
	})

	it("returns false when roles are missing", () => {
		expect(shouldDelegatePlanning("kimi-k2.7", undefined)).toBe(false)
	})

	it("returns false when currentModelId is missing", () => {
		expect(shouldDelegatePlanning(undefined, DEFAULT_MODEL_ROLES)).toBe(false)
	})

	it("returns false when orchestrator is one of multiple planner models", () => {
		const roles = { ...DEFAULT_MODEL_ROLES, planner: ["kimchi-dev/kimi-k2.7", "anthropic/claude-opus-4-7"] }
		expect(shouldDelegatePlanning("kimi-k2.7", roles)).toBe(false)
	})

	it("returns true when orchestrator is not among multiple planner models", () => {
		const roles = { ...DEFAULT_MODEL_ROLES, planner: ["anthropic/claude-opus-4-7", "openai/gpt-4o"] }
		expect(shouldDelegatePlanning("kimi-k2.7", roles)).toBe(true)
	})
})
