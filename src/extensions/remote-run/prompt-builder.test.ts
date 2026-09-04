import { describe, expect, it } from "vitest"
import { buildRemotePlanPrompt, type RemotePlanOrigin } from "./prompt-builder.js"

describe("buildRemotePlanPrompt", () => {
	const samplePlan = "## Goal\nBuild a feature\n\n## Chunks\n### Chunk 1\nDo something"

	describe("origin-specific instructions", () => {
		it("includes plain execution instruction for plan-mode origin", () => {
			const prompt = buildRemotePlanPrompt(samplePlan, { origin: "plan-mode" })
			expect(prompt).toContain("The user approved the following plan. Execute it now")
		})

		it("includes ferment execution instruction for ferment origin", () => {
			const prompt = buildRemotePlanPrompt(samplePlan, { origin: "ferment" })
			expect(prompt).toContain("wants it executed as a ferment")
			expect(prompt).toContain("Start a ferment with this plan")
		})

		it("includes different instructions for each origin", () => {
			const planPrompt = buildRemotePlanPrompt(samplePlan, { origin: "plan-mode" })
			const fermentPrompt = buildRemotePlanPrompt(samplePlan, { origin: "ferment" })
			expect(planPrompt).not.toBe(fermentPrompt)
		})
	})

	describe("handoff note", () => {
		it("includes remote Linux sandbox note", () => {
			const prompt = buildRemotePlanPrompt(samplePlan, { origin: "plan-mode" })
			expect(prompt).toContain("[Remote execution] You are running on a remote Linux sandbox.")
		})

		it("includes repository clone + sync note", () => {
			const prompt = buildRemotePlanPrompt(samplePlan, { origin: "plan-mode" })
			expect(prompt).toContain("The repository was cloned from the local machine's git origin")
			expect(prompt).toContain("uncommitted changes were synced to the sandbox")
		})

		it("includes devkit skill reference for missing tools", () => {
			const prompt = buildRemotePlanPrompt(samplePlan, { origin: "plan-mode" })
			expect(prompt).toContain("command -v <tool>")
			expect(prompt).toContain("devkit skill")
		})

		it("includes the handoff note for ferment origin too", () => {
			const prompt = buildRemotePlanPrompt(samplePlan, { origin: "ferment" })
			expect(prompt).toContain("[Remote execution] You are running on a remote Linux sandbox.")
		})
	})

	describe("plan text", () => {
		it("includes the plan text after the separator", () => {
			const prompt = buildRemotePlanPrompt(samplePlan, { origin: "plan-mode" })
			expect(prompt).toContain("---")
			expect(prompt).toContain(samplePlan)
			// Plan text should be after the separator
			const separatorIndex = prompt.indexOf("---")
			const planIndex = prompt.indexOf(samplePlan)
			expect(planIndex).toBeGreaterThan(separatorIndex)
		})
	})

	describe("both origins include all parts", () => {
		const origins: RemotePlanOrigin[] = ["plan-mode", "ferment"]
		for (const origin of origins) {
			it(`includes handoff note, separator, and plan text for ${origin} origin`, () => {
				const prompt = buildRemotePlanPrompt(samplePlan, { origin })
				expect(prompt).toContain("[Remote execution]")
				expect(prompt).toContain("---")
				expect(prompt).toContain(samplePlan)
			})
		}
	})
})
