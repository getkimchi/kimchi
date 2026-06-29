import { describe, expect, it } from "vitest"
import planModeSupplement from "./plan-mode-supplement.js"

describe("plan-mode-supplement", () => {
	describe("shared process steps", () => {
		it("contains all five planning step headers", () => {
			expect(planModeSupplement).toContain("STEP 1")
			expect(planModeSupplement).toContain("ORIENT")
			expect(planModeSupplement).toContain("STEP 2")
			expect(planModeSupplement).toContain("INTERVIEW")
			expect(planModeSupplement).toContain("STEP 3")
			expect(planModeSupplement).toContain("COMPLETION CRITERIA")
			expect(planModeSupplement).toContain("STEP 4")
			expect(planModeSupplement).toContain("DEEP EXPLORATION")
			expect(planModeSupplement).toContain("STEP 5")
			expect(planModeSupplement).toContain("PLAN")
		})

		it("contains shared process core behaviour", () => {
			expect(planModeSupplement).toContain("iterative rounds")
			expect(planModeSupplement).toContain("REFLECT before continuing")
			expect(planModeSupplement).toContain("MAX 2 TURNS")
			expect(planModeSupplement).toContain("Prefer targeted search over reading entire files line by line")
		})
	})

	describe("plan-mode-specific content", () => {
		it("references questionnaire tool for questions", () => {
			expect(planModeSupplement).toContain("questionnaire")
		})

		it("contains plan completion marker", () => {
			expect(planModeSupplement).toContain("PLAN_COMPLETE")
		})

		it("declares read-only nature", () => {
			expect(planModeSupplement).toContain("read-only")
		})

		it("includes plan template structure", () => {
			expect(planModeSupplement).toContain("## Goal")
			expect(planModeSupplement).toContain("## Chunks")
		})
	})

	describe("no ferment-specific content", () => {
		it("does not reference ask_user tool", () => {
			expect(planModeSupplement).not.toContain("ask_user")
		})

		it("does not reference propose_ferment_scoping", () => {
			expect(planModeSupplement).not.toContain("propose_ferment_scoping")
		})

		it("does not reference confirm_ferment_completion_criteria", () => {
			expect(planModeSupplement).not.toContain("confirm_ferment_completion_criteria")
		})
	})
})
