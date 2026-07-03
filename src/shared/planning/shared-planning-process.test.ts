import { describe, expect, it } from "vitest"
import { SCOPING_DISCOVERY_GUIDANCE } from "../../extensions/ferment/constants.js"
import { SHARED_PLANNING_PROCESS } from "./shared-planning-process.js"

describe("SHARED_PLANNING_PROCESS", () => {
	it("exports a non-empty string constant", () => {
		expect(SHARED_PLANNING_PROCESS).toBeDefined()
		expect(typeof SHARED_PLANNING_PROCESS).toBe("string")
		expect(SHARED_PLANNING_PROCESS.length).toBeGreaterThan(0)
	})

	it("contains all four planning steps in order", () => {
		const steps = ["STEP 1 — INVESTIGATE", "STEP 2 — INTERVIEW", "STEP 3 — COMPLETION CRITERIA", "STEP 4 — PLAN"]

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
		const fermentTools = ["propose_ferment_scoping", "confirm_ferment_completion_criteria", "ask_user"]

		for (const tool of fermentTools) {
			expect(SHARED_PLANNING_PROCESS).not.toContain(tool)
		}
	})

	it("is mode-agnostic and contains no plan-mode-specific tool references", () => {
		const planModeSpecifics = ["PLAN_COMPLETE", "questionnaire", "<done>", "<!-- PLAN_COMPLETE -->"]

		for (const specific of planModeSpecifics) {
			expect(SHARED_PLANNING_PROCESS).not.toContain(specific)
		}
	})

	it("uses generic placeholders for mode-specific tooling", () => {
		expect(SHARED_PLANNING_PROCESS).toContain("your mode's")
	})

	it("includes INVESTIGATE step guidance", () => {
		expect(SHARED_PLANNING_PROCESS).toContain("scan + explore the codebase")
		expect(SHARED_PLANNING_PROCESS).toContain("MAX 4 TURNS")
		expect(SHARED_PLANNING_PROCESS).toContain("answer every question you possibly can yourself")
		expect(SHARED_PLANNING_PROCESS).toContain("project scan")
		expect(SHARED_PLANNING_PROCESS).toContain("README")
		expect(SHARED_PLANNING_PROCESS).toContain("mental model")
		expect(SHARED_PLANNING_PROCESS).toContain("greenfield")
		expect(SHARED_PLANNING_PROCESS).toContain("Explore subagents")
		expect(SHARED_PLANNING_PROCESS).toContain("package.json")
		expect(SHARED_PLANNING_PROCESS).toContain("Don't Hand-Roll")
		expect(SHARED_PLANNING_PROCESS).toContain("Common Pitfalls")
		expect(SHARED_PLANNING_PROCESS).toContain("This step is about YOUR understanding")
		expect(SHARED_PLANNING_PROCESS).toContain("Do not ask questions yet")
	})

	it("includes INTERVIEW step guidance", () => {
		expect(SHARED_PLANNING_PROCESS).toContain("only ask what the code couldn't answer")
		expect(SHARED_PLANNING_PROCESS).toContain("Round structure")
		expect(SHARED_PLANNING_PROCESS).toContain("1-3 focused questions")
		expect(SHARED_PLANNING_PROCESS).toContain("REFLECT")
		expect(SHARED_PLANNING_PROCESS).toContain("When to ask")
		expect(SHARED_PLANNING_PROCESS).toContain("When NOT to ask")
		expect(SHARED_PLANNING_PROCESS).toContain("Exit criteria")
		expect(SHARED_PLANNING_PROCESS).toContain("assumption that could be wrong")
		expect(SHARED_PLANNING_PROCESS).toContain("safe, reversible default")
		expect(SHARED_PLANNING_PROCESS).toContain("don't manufacture questions")
		expect(SHARED_PLANNING_PROCESS).toContain("Could I answer this by reading the code?")
		expect(SHARED_PLANNING_PROCESS).toContain("Go read the code instead")
	})

	it("includes COMPLETION CRITERIA step guidance", () => {
		expect(SHARED_PLANNING_PROCESS).toContain("Draft concrete completion criteria")
		expect(SHARED_PLANNING_PROCESS).toContain('what "done" looks like')
		expect(SHARED_PLANNING_PROCESS).toContain("specific, testable terms")
		expect(SHARED_PLANNING_PROCESS).toContain("verification method")
		expect(SHARED_PLANNING_PROCESS).toContain("test command")
		expect(SHARED_PLANNING_PROCESS).toContain("manual check")
		expect(SHARED_PLANNING_PROCESS).toContain("linter")
		expect(SHARED_PLANNING_PROCESS).toContain("confirm with the user")
		expect(SHARED_PLANNING_PROCESS).toContain("mode's confirmation mechanism")
		expect(SHARED_PLANNING_PROCESS).toContain("Proceed only when user confirms")
	})

	it("includes PLAN step guidance", () => {
		const planSection = SHARED_PLANNING_PROCESS.slice(SHARED_PLANNING_PROCESS.indexOf("STEP 4 — PLAN"))

		expect(planSection).toContain("Synthesize everything")
		expect(planSection).toContain("investigation findings")
		expect(planSection).toContain("interview answers")
		expect(planSection).toContain("confirmed criteria")
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
		expect(planSection).toContain("Ensure completion criteria were confirmed")
		expect(planSection).toContain("before finalizing")
	})

	it("emphasizes workflow discipline and anti-patterns", () => {
		expect(SHARED_PLANNING_PROCESS).toContain("IN ORDER")
		expect(SHARED_PLANNING_PROCESS).toContain("Do NOT get stuck")
		expect(SHARED_PLANNING_PROCESS).toContain("don't manufacture questions")
		expect(SHARED_PLANNING_PROCESS).toContain("Do not ask questions yet")
		// New anti-pattern: don't ask what you can read yourself
		expect(SHARED_PLANNING_PROCESS).toContain(
			"always investigate first, interview only about what the code can't tell you",
		)
	})

	it("provides concrete budget and scope guidance", () => {
		expect(SHARED_PLANNING_PROCESS).toContain("MAX 4 TURNS")
		expect(SHARED_PLANNING_PROCESS).toContain("3-5 turns")
		expect(SHARED_PLANNING_PROCESS).toContain("5-8 targeted files")
		expect(SHARED_PLANNING_PROCESS).toContain("1-3 focused questions")
	})

	it("addresses both code and non-code scenarios", () => {
		expect(SHARED_PLANNING_PROCESS).toContain("greenfield")
		expect(SHARED_PLANNING_PROCESS).toContain("non-code")
		expect(SHARED_PLANNING_PROCESS).toContain("writing, strategy, general planning")
	})

	it("requires criteria confirmation before finalizing plan", () => {
		const planSection = SHARED_PLANNING_PROCESS.slice(SHARED_PLANNING_PROCESS.indexOf("STEP 4 — PLAN"))

		expect(planSection).toContain("Ensure completion criteria were confirmed")
		expect(planSection).toContain("before finalizing")
	})

	it("includes step-sizing guidance so each step fits within a single context window", () => {
		expect(SHARED_PLANNING_PROCESS).toContain(
			"every step should fit within ~25% of the active model's context window when implemented",
		)
		expect(SHARED_PLANNING_PROCESS).toContain(
			"If you cannot see how to fit a step within that budget, split it into smaller steps",
		)
	})

	it("flows the step-sizing guidance into the ferment scoping prompt", () => {
		expect(SCOPING_DISCOVERY_GUIDANCE).toContain(
			"every step should fit within ~25% of the active model's context window when implemented",
		)
	})

	it("includes must-haves and boundary map fields in the plan template", () => {
		expect(SHARED_PLANNING_PROCESS).toContain("**Produces**")
		expect(SHARED_PLANNING_PROCESS).toContain("**Consumes**")
		expect(SHARED_PLANNING_PROCESS).toContain("**Demo**")
		expect(SHARED_PLANNING_PROCESS).toContain("**Must-Haves**")
		expect(SHARED_PLANNING_PROCESS).toContain("**Truths**")
		expect(SHARED_PLANNING_PROCESS).toContain("**Artifacts**")
		expect(SHARED_PLANNING_PROCESS).toContain("**Key Links**")
	})

	it("includes don't-hand-roll and common pitfalls guidance in investigation", () => {
		expect(SHARED_PLANNING_PROCESS).toContain("Don't Hand-Roll")
		expect(SHARED_PLANNING_PROCESS).toContain("Common Pitfalls")
		expect(SHARED_PLANNING_PROCESS).toContain("Risks section, not as implementation chunks")
	})

	it("can be imported and used in other modules", () => {
		const imported = SHARED_PLANNING_PROCESS
		expect(imported).toBeDefined()
		expect(imported.length).toBeGreaterThan(1000)
	})
})
