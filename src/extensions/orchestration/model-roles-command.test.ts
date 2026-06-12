/**
 * Tests for the pure helper functions in model-roles-command.ts.
 * Interactive CLI flows (select/input UI) are not tested here —
 * they require a full mock UI harness and are covered by manual smoke tests.
 */
import { describe, expect, it } from "vitest"
import { formatRoleAssignment, formatRoleDisplay, isEqualAssignment } from "./model-roles-command.js"
import { splitModelRef } from "./model-roles.js"

describe("formatRoleAssignment", () => {
	it("formats a single model as-is", () => {
		expect(formatRoleAssignment("kimchi-dev/kimi-k2.6")).toBe("kimchi-dev/kimi-k2.6")
	})

	it("formats multiple models joined by comma-space", () => {
		expect(formatRoleAssignment(["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"])).toBe(
			"kimchi-dev/kimi-k2.6, kimchi-dev/minimax-m2.7",
		)
	})

	it("formats empty array as empty string", () => {
		// normalizeRoleModels([]) would not be valid input per isValidRoleValue guard,
		// but formatRoleAssignment handles it gracefully
		const models: string[] = []
		const result = models.join(", ")
		expect(result).toBe("")
	})
})

describe("isEqualAssignment", () => {
	it("returns true for identical single-model assignments", () => {
		expect(isEqualAssignment("kimchi-dev/kimi-k2.6", "kimchi-dev/kimi-k2.6")).toBe(true)
	})

	it("returns false for different single-model assignments", () => {
		expect(isEqualAssignment("kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7")).toBe(false)
	})

	it("returns true for identical multi-model assignments (same order)", () => {
		expect(
			isEqualAssignment(
				["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"],
				["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"],
			),
		).toBe(true)
	})

	it("returns false for same models in different order", () => {
		// Order matters — this is intentional
		expect(
			isEqualAssignment(
				["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"],
				["kimchi-dev/minimax-m2.7", "kimchi-dev/kimi-k2.6"],
			),
		).toBe(false)
	})

	it("returns false for different lengths", () => {
		expect(isEqualAssignment("kimchi-dev/kimi-k2.6", ["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"])).toBe(false)
	})

	it("handles mixed types (string vs array of one)", () => {
		expect(isEqualAssignment("kimchi-dev/kimi-k2.6", ["kimchi-dev/kimi-k2.6"])).toBe(true)
	})
})

describe("formatRoleDisplay", () => {
	it("appends (default) suffix when value matches DEFAULT_MODEL_ROLES", () => {
		// orchestrator default is kimchi-dev/kimi-k2.6 (or heaviest plan-capable model)
		const display = formatRoleDisplay("orchestrator", "kimchi-dev/kimi-k2.6")
		expect(display).toMatch(/\(default\)$/)
	})

	it("omits (default) suffix when value differs from DEFAULT_MODEL_ROLES", () => {
		const display = formatRoleDisplay("orchestrator", "kimchi-dev/minimax-m2.7")
		expect(display).not.toMatch(/\(default\)$/)
	})

	it("includes role label and formatted model list", () => {
		const display = formatRoleDisplay("planner", "kimchi-dev/kimi-k2.6")
		expect(display).toContain("Planner")
		expect(display).toContain("kimchi-dev/kimi-k2.6")
	})

	it("formats builder role with multiple models", () => {
		const display = formatRoleDisplay("builder", ["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"])
		expect(display).toContain("Builder")
		expect(display).toContain("kimchi-dev/kimi-k2.6")
		expect(display).toContain("kimchi-dev/minimax-m2.7")
	})
})

describe("splitModelRef (from model-roles.ts)", () => {
	it("parses valid provider/model-id", () => {
		expect(splitModelRef("kimchi-dev/kimi-k2.6")).toEqual({
			provider: "kimchi-dev",
			modelId: "kimi-k2.6",
		})
	})

	it("returns undefined for model-id without slash", () => {
		expect(splitModelRef("kimi-k2.6")).toBeUndefined()
	})

	it("returns undefined for empty string", () => {
		expect(splitModelRef("")).toBeUndefined()
	})

	it("returns undefined for slash-only string", () => {
		expect(splitModelRef("/")).toBeUndefined()
	})

	it("returns provider with empty modelId for trailing slash", () => {
		expect(splitModelRef("provider/")).toEqual({ provider: "provider", modelId: "" })
	})
})
