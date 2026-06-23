import { describe, expect, it } from "vitest"
import { SHARED_PLANNING_PROCESS } from "./shared-planning-process.js"

describe("SHARED_PLANNING_PROCESS", () => {
	it("exports a non-empty string constant", () => {
		expect(SHARED_PLANNING_PROCESS).toBeDefined()
		expect(typeof SHARED_PLANNING_PROCESS).toBe("string")
		expect(SHARED_PLANNING_PROCESS.length).toBeGreaterThan(0)
	})

	it("contains all five planning steps in order", () => {
		const steps = [
			"STEP 1 — ORIENT",
			"STEP 2 — INTERVIEW",
			"STEP 3 — COMPLETION CRITERIA",
			"STEP 4 — DEEP EXPLORATION",
			"STEP 5 — PLAN",
		]

		for (const step of steps) {
			expect(SHARED_PLANNING_PROCESS).toContain(step)
		}

		// Verify steps appear in the correct order
		const positions = steps.map((step) => SHARED_PLANNING_PROCESS.indexOf(step))
		for (let i = 1; i < positions.length; i++) {
			expect(positions[i]).toBeGreaterThan(positions[i - 1])
		}
	})

	it("is mode-agnostic and contains no ferment-specific tool references", () => {
		// Should NOT reference ferment-specific tools
		const fermentTools = ["propose_ferment_scoping", "confirm_ferment_completion_criteria", "ask_user"]

		for (const tool of fermentTools) {
			expect(SHARED_PLANNING_PROCESS).not.toContain(tool)
		}
	})

	it("is mode-agnostic and contains no plan-mode-specific tool references", () => {
		// Should NOT reference plan-mode-specific markers or tools
		const planModeSpecifics = ["PLAN_COMPLETE", "questionnaire", "<done>", "<!-- PLAN_COMPLETE -->"]

		for (const specific of planModeSpecifics) {
			expect(SHARED_PLANNING_PROCESS).not.toContain(specific)
		}
	})

	it("uses generic placeholders for mode-specific tooling", () => {
		// Should use generic language that can be substituted by each mode
		expect(SHARED_PLANNING_PROCESS).toContain("your mode's")
	})

	it("includes ORIENT step guidance", () => {
		const orientSection = SHARED_PLANNING_PROCESS

		// Key ORIENT concepts
		expect(orientSection).toContain("lightweight research")
		expect(orientSection).toContain("MAX 2 TURNS")
		expect(orientSection).toContain("quick project scan")
		expect(orientSection).toContain("file listing")
		expect(orientSection).toContain("README")
		expect(orientSection).toContain("mental model")
		expect(orientSection).toContain("Identify your unknowns")
		expect(orientSection).toContain("greenfield")
		expect(orientSection).toContain("non-code")
		expect(orientSection).toContain("1-2 turns")
		expect(orientSection).toContain("3-5 targeted files")
		expect(orientSection).toContain("Do NOT read")
		expect(orientSection).toContain("implementation files line by line")
		expect(orientSection).toContain("This step is about YOUR understanding")
	})

	it("includes INTERVIEW step guidance", () => {
		const interviewSection = SHARED_PLANNING_PROCESS

		// Key INTERVIEW concepts
		expect(interviewSection).toContain("iterative rounds")
		expect(interviewSection).toContain("Round structure")
		expect(interviewSection).toContain("1-3 focused questions")
		expect(interviewSection).toContain("REFLECT")
		expect(interviewSection).toContain("When to ask")
		expect(interviewSection).toContain("When NOT to ask")
		expect(interviewSection).toContain("Exit criteria")
		expect(interviewSection).toContain("assumption that could be wrong")
		expect(interviewSection).toContain("safe, reversible default")
		expect(interviewSection).toContain("don't manufacture questions")
	})

	it("includes COMPLETION CRITERIA step guidance", () => {
		const criteriaSection = SHARED_PLANNING_PROCESS

		// Key COMPLETION CRITERIA concepts
		expect(criteriaSection).toContain("Draft concrete completion criteria")
		expect(criteriaSection).toContain('what "done" looks like')
		expect(criteriaSection).toContain("specific, testable terms")
		expect(criteriaSection).toContain("verification method")
		expect(criteriaSection).toContain("test command")
		expect(criteriaSection).toContain("manual check")
		expect(criteriaSection).toContain("linter")
		expect(criteriaSection).toContain("confirm with the user")
		expect(criteriaSection).toContain("mode's confirmation mechanism")
		expect(criteriaSection).toContain("Proceed only when user confirms")
		expect(criteriaSection).toContain("BEFORE proceeding to exploration")
	})

	it("includes DEEP EXPLORATION step guidance", () => {
		const explorationSection = SHARED_PLANNING_PROCESS

		// Key DEEP EXPLORATION concepts
		expect(explorationSection).toContain("targeted, not broad")
		expect(explorationSection).toContain("MAX 2 TURNS of direct reads")
		expect(explorationSection).toContain("Focus ONLY on unknowns")
		expect(explorationSection).toContain("after the interview")
		expect(explorationSection).toContain("targeted search")
		expect(explorationSection).toContain("line by line")
		expect(explorationSection).toContain("Skip this step for greenfield")
		expect(explorationSection).toContain("Skip entirely if you have enough context")
		expect(explorationSection).toContain("verify your understanding")
		expect(explorationSection).toContain("look for gaps")
	})

	it("includes PLAN step guidance", () => {
		const planSection = SHARED_PLANNING_PROCESS

		// Key PLAN concepts
		expect(planSection).toContain("Synthesize everything")
		expect(planSection).toContain("orient findings")
		expect(planSection).toContain("interview answers")
		expect(planSection).toContain("confirmed criteria")
		expect(planSection).toContain("exploration results")
		expect(planSection).toContain("structured plan")
		expect(planSection).toContain("## Goal")
		expect(planSection).toContain("One-sentence statement")
		expect(planSection).toContain("## Constraints")
		expect(planSection).toContain("non-negotiable")
		expect(planSection).toContain("## Chunks")
		expect(planSection).toContain("Accept When")
		expect(planSection).toContain("## Verification Strategy")
		expect(planSection).toContain("## Decision Log")
		expect(planSection).toContain("rationale")
		expect(planSection).toContain("rejected alternatives")
		expect(planSection).toContain("## Risks")
		expect(planSection).toContain("likelihood")
		expect(planSection).toContain("mitigation")
		expect(planSection).toContain("Open Question remains unresolved")
		expect(planSection).toContain("mode's completion mechanism")
	})

	it("emphasizes workflow discipline and anti-patterns", () => {
		// Process discipline
		expect(SHARED_PLANNING_PROCESS).toContain("IN ORDER")
		expect(SHARED_PLANNING_PROCESS).toContain("Do NOT get stuck")

		// Anti-patterns
		expect(SHARED_PLANNING_PROCESS).toContain("don't manufacture questions")
		expect(SHARED_PLANNING_PROCESS).toContain("don't re-explore")
		expect(SHARED_PLANNING_PROCESS).toContain("Do not ask questions yet")
	})

	it("provides concrete budget and scope guidance", () => {
		// Time/turn budgets
		expect(SHARED_PLANNING_PROCESS).toContain("MAX 2 TURNS")
		expect(SHARED_PLANNING_PROCESS).toContain("1-2 turns")
		expect(SHARED_PLANNING_PROCESS).toContain("3-5 targeted files")
		expect(SHARED_PLANNING_PROCESS).toContain("1-3 focused questions")
		expect(SHARED_PLANNING_PROCESS).toContain("at most 2 turns")
	})

	it("addresses both code and non-code scenarios", () => {
		expect(SHARED_PLANNING_PROCESS).toContain("greenfield")
		expect(SHARED_PLANNING_PROCESS).toContain("non-code")
		expect(SHARED_PLANNING_PROCESS).toContain("writing, strategy, general planning")
	})

	it("requires criteria confirmation before exploration", () => {
		const text = SHARED_PLANNING_PROCESS
		const criteriaIndex = text.indexOf("STEP 3 — COMPLETION CRITERIA")
		const explorationIndex = text.indexOf("STEP 4 — DEEP EXPLORATION")

		// Find the "BEFORE proceeding to exploration" text in the criteria section
		const beforeText = text.slice(criteriaIndex, explorationIndex)
		expect(beforeText).toContain("BEFORE proceeding to exploration")
	})

	it("requires criteria confirmation before finalizing plan", () => {
		const planSection = SHARED_PLANNING_PROCESS.slice(SHARED_PLANNING_PROCESS.indexOf("STEP 5 — PLAN"))

		expect(planSection).toContain("Ensure completion criteria were confirmed")
		expect(planSection).toContain("before finalizing")
	})

	it("is under 7000 characters — process guidance plus shared plan template", () => {
		// The shared module now includes both the five-step process guidance and the
		// canonical plan template (Goal/Constraints/Chunks/etc.), so the budget is
		// larger than the process-only version.
		expect(SHARED_PLANNING_PROCESS.length).toBeLessThan(7000)
	})

	it("can be imported and used in other modules", () => {
		// This is a smoke test to ensure the export works correctly
		const imported = SHARED_PLANNING_PROCESS
		expect(imported).toBeDefined()
		expect(imported.length).toBeGreaterThan(1000)
	})
})
