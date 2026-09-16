import { describe, expect, it, type vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import {
	buildRemotePlanPrompt,
	buildRemotePlanPromptWithIntent,
	buildRemoteSteerPrompt,
	type RemotePlanOrigin,
} from "./prompt-builder.js"

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

	describe("git workflow section", () => {
		const gitWorkflow = { branch: "kimchi/add-feature", baseBranch: "main" }

		it("names the branch and provenance when gitWorkflow is set", () => {
			const prompt = buildRemotePlanPrompt(samplePlan, { origin: "plan-mode", gitWorkflow })
			expect(prompt).toContain("[Git workflow — PR-first execution]")
			expect(prompt).toContain("`kimchi/add-feature`")
			expect(prompt).toContain("(created from `main` at provisioning)")
		})

		it("instructs the agent to never push and to commit only its own changes", () => {
			const prompt = buildRemotePlanPrompt(samplePlan, { origin: "plan-mode", gitWorkflow })
			expect(prompt).toContain("Never push — the harness pushes after user review.")
			expect(prompt).toContain("Commit only files you changed for this task")
			expect(prompt).toContain("user's pre-existing uncommitted files; never add those.")
		})

		it("includes the verify/create fallback line and clean-worktree + commit summary discipline", () => {
			const prompt = buildRemotePlanPrompt(samplePlan, { origin: "ferment", gitWorkflow })
			expect(prompt).toContain("git branch --show-current")
			expect(prompt).toContain("create and switch to `kimchi/add-feature` from the current HEAD")
			expect(prompt).toContain("Leave the worktree clean when done")
			expect(prompt).toContain("short summary of the commits you made")
		})

		it("omits the created-from clause when baseBranch is undefined", () => {
			const prompt = buildRemotePlanPrompt(samplePlan, {
				origin: "plan-mode",
				gitWorkflow: { branch: "kimchi/add-feature", baseBranch: undefined },
			})
			expect(prompt).toContain("You are on branch `kimchi/add-feature`, already checked out")
			expect(prompt).not.toContain("created from")
			expect(prompt).toContain("git branch --show-current")
		})

		it("places the section before the plan separator", () => {
			const prompt = buildRemotePlanPrompt(samplePlan, { origin: "plan-mode", gitWorkflow })
			expect(prompt.indexOf("[Git workflow")).toBeLessThan(prompt.indexOf("---"))
			expect(prompt.indexOf("---")).toBeLessThan(prompt.indexOf(samplePlan))
		})

		it("yields exactly today's prompt when gitWorkflow is absent or undefined", () => {
			const plain = buildRemotePlanPrompt(samplePlan, { origin: "plan-mode" })
			expect(plain).not.toContain("Git workflow")
			expect(plain).not.toContain("Never push")
			for (const origin of ["plan-mode", "ferment"] as const) {
				expect(buildRemotePlanPrompt(samplePlan, { origin, gitWorkflow: undefined })).toBe(
					buildRemotePlanPrompt(samplePlan, { origin }),
				)
			}
		})
	})

	describe("buildRemotePlanPromptWithIntent", () => {
		it("captures a branch and embeds the git workflow section", async () => {
			const ctx = createContext()
			;(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValue("kimchi/my-branch")
			const { prompt, gitWorkflow } = await buildRemotePlanPromptWithIntent(ctx, samplePlan, { origin: "plan-mode" })
			expect(gitWorkflow?.branch).toBe("kimchi/my-branch")
			// /tmp (mock cwd) has no origin symref — resolved honestly as undefined.
			expect(gitWorkflow?.baseBranch).toBeUndefined()
			expect(prompt).toContain("[Git workflow — PR-first execution]")
			expect(prompt).toContain("`kimchi/my-branch`")
		})

		it("suggests the slug derived from the plan Goal", async () => {
			const ctx = createContext()
			;(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
			await buildRemotePlanPromptWithIntent(ctx, samplePlan, { origin: "plan-mode" })
			expect(ctx.ui.input).toHaveBeenCalledWith(expect.any(String), "kimchi/build-a-feature")
		})

		it("returns a plain prompt with no intent on Escape", async () => {
			const ctx = createContext()
			;(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
			const { prompt, gitWorkflow } = await buildRemotePlanPromptWithIntent(ctx, samplePlan, { origin: "ferment" })
			expect(gitWorkflow).toBeUndefined()
			expect(prompt).toBe(buildRemotePlanPrompt(samplePlan, { origin: "ferment" }))
		})

		it("defaults to plain run in headless mode without prompting", async () => {
			const ctx = createContext({ mode: "print" })
			const { prompt, gitWorkflow } = await buildRemotePlanPromptWithIntent(ctx, samplePlan, { origin: "ferment" })
			expect(gitWorkflow).toBeUndefined()
			expect(ctx.ui.input).not.toHaveBeenCalled()
			expect(prompt).toBe(buildRemotePlanPrompt(samplePlan, { origin: "ferment" }))
		})
	})
})

describe("buildRemoteSteerPrompt", () => {
	it("wraps the feedback with the stay-on-branch + commit + no-push reminder", () => {
		const prompt = buildRemoteSteerPrompt({
			feedback: "Rename the button to Save",
			gitWorkflow: { branch: "kimchi/fix-login", baseBranch: "main" },
		})

		expect(prompt).toContain("Rename the button to Save")
		expect(prompt).toContain("`kimchi/fix-login`")
		expect(prompt).toContain("git branch --show-current")
		expect(prompt).toContain("Do NOT push")
		expect(prompt).toContain("Commit every change")
		expect(prompt.startsWith("The user reviewed the diff")).toBe(true)
	})

	it("falls back to a generic commit note without git intent", () => {
		const prompt = buildRemoteSteerPrompt({ feedback: "fix the import" })

		expect(prompt).toContain("fix the import")
		expect(prompt).not.toContain("git branch --show-current")
		expect(prompt).not.toContain("Do NOT push")
	})
})
