import { describe, expect, it } from "vitest"
import { ProposeScopingParams } from "./tool-schemas.js"

describe("Ferment scoping benchmark cases", () => {
	it("schema guidance nudges one-phase simple plans and discourages artificial phase splitting", () => {
		const schemaText = JSON.stringify(ProposeScopingParams)

		expect(schemaText).toContain('"minItems":1')
		expect(schemaText).toContain("Default to ONE phase for simple tasks")
		expect(schemaText).toContain("decision-blocking uncertainty")
		expect(schemaText).toContain("be thorough in assumptions, success criteria, constraints, and verification steps")
		expect(schemaText).toContain("Do not ask about defaults you can safely choose")
		expect(schemaText).toContain("Hard limits: at most 3 questions")
		expect(schemaText).toContain("single/multi questions need 2-5 options")
		expect(schemaText).toContain("'single' (one choice, default)")
		expect(schemaText).toContain("'multi' (multiple choices)")
		expect(schemaText).toContain("'text' (enter-your-own answer only)")
		expect(schemaText).toContain("outcome boundary")
		expect(schemaText).toContain("risk/tradeoff")
		expect(schemaText).toContain("verification standard")
		expect(schemaText).toContain("feature-shopping questions")
		expect(schemaText).toContain("tech stack, platform, persistence, or extra features")
		expect(schemaText).toContain("vertical slice/tracer bullet")
		expect(schemaText).toContain("Do not create phases just for setup")
		expect(schemaText).toContain("asking/reading scoping answers")
		expect(schemaText).toContain("creating a design note")
		expect(schemaText).toContain("If questions is non-empty, keep phases answer-agnostic and provisional")
		expect(schemaText).toContain("CRUD vs polish")
		expect(schemaText).not.toContain('"minItems":3')
		expect(schemaText).not.toContain("3-7 ordered phase")
		expect(schemaText).not.toContain("at least 3 phases")
	})
})
