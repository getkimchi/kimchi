import { describe, expect, it } from "vitest"
import { DEFAULT_MODEL_ROLES } from "./model-roles.js"
import {
	orchestratorShouldReceivePhaseGuidelines,
	resolveModelRoleNames,
	shouldDelegatePlanning,
	shouldDelegateReview,
} from "./orchestrator-roles.js"

describe("resolveModelRoleNames", () => {
	it("returns every default orchestration role for auto", () => {
		expect(resolveModelRoleNames("auto", DEFAULT_MODEL_ROLES)).toEqual([
			"orchestrator",
			"planner",
			"builder",
			"reviewer",
			"explorer",
			"researcher",
		])
	})
})

describe("orchestratorShouldReceivePhaseGuidelines", () => {
	it("never includes build worker guidelines", () => {
		expect(orchestratorShouldReceivePhaseGuidelines("build", "auto", DEFAULT_MODEL_ROLES)).toBe(false)
	})

	it("includes review guidelines when orchestrator owns reviewer", () => {
		expect(orchestratorShouldReceivePhaseGuidelines("review", "auto", DEFAULT_MODEL_ROLES)).toBe(true)
	})

	it("omits review guidelines when orchestrator lacks reviewer", () => {
		const roles = { ...DEFAULT_MODEL_ROLES, reviewer: "anthropic/claude-opus-4-7" }
		expect(orchestratorShouldReceivePhaseGuidelines("review", "auto", roles)).toBe(false)
	})

	it("includes plan guidelines when orchestrator owns planner", () => {
		expect(orchestratorShouldReceivePhaseGuidelines("plan", "auto", DEFAULT_MODEL_ROLES)).toBe(true)
	})

	it("includes explore guidelines when orchestrator owns explorer", () => {
		expect(orchestratorShouldReceivePhaseGuidelines("explore", "auto", DEFAULT_MODEL_ROLES)).toBe(true)
	})

	it("omits guidelines when roles are missing", () => {
		expect(orchestratorShouldReceivePhaseGuidelines("plan", "kimi-k2.7", undefined)).toBe(false)
	})
})

describe("shouldDelegatePlanning", () => {
	it("returns false when orchestrator is the planner model", () => {
		expect(shouldDelegatePlanning("auto", DEFAULT_MODEL_ROLES)).toBe(false)
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

describe("shouldDelegateReview", () => {
	it("returns false when orchestrator is the reviewer model", () => {
		expect(shouldDelegateReview("auto", DEFAULT_MODEL_ROLES)).toBe(false)
	})

	it("returns true when orchestrator is not the reviewer model", () => {
		const roles = { ...DEFAULT_MODEL_ROLES, reviewer: "anthropic/claude-opus-4-7" }
		expect(shouldDelegateReview("kimi-k2.6", roles)).toBe(true)
	})

	it("returns false when roles are missing", () => {
		expect(shouldDelegateReview("kimi-k2.7", undefined)).toBe(false)
	})

	it("returns false when currentModelId is missing", () => {
		expect(shouldDelegateReview(undefined, DEFAULT_MODEL_ROLES)).toBe(false)
	})

	it("returns false when orchestrator is one of multiple reviewer models", () => {
		const roles = { ...DEFAULT_MODEL_ROLES, reviewer: ["kimchi-dev/kimi-k2.7", "anthropic/claude-opus-4-7"] }
		expect(shouldDelegateReview("kimi-k2.7", roles)).toBe(false)
	})

	it("returns true when orchestrator is not among multiple reviewer models", () => {
		const roles = { ...DEFAULT_MODEL_ROLES, reviewer: ["anthropic/claude-opus-4-7", "openai/gpt-4o"] }
		expect(shouldDelegateReview("kimi-k2.7", roles)).toBe(true)
	})
})
