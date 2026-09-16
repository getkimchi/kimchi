import { describe, expect, it } from "vitest"
import { checkLaunch, stripGuidance, unavailableTool } from "./experiment.js"

describe("communication comparison protocol", () => {
	it("distinguishes delegation, messages and board access", () => {
		expect(unavailableTool("Agent", "solo")).toBe(true)
		expect(unavailableTool("Agent", "workers")).toBe(false)
		expect(unavailableTool("send_agent_message", "workers")).toBe(true)
		expect(unavailableTool("send_agent_message", "messages")).toBe(false)
		expect(unavailableTool("read_agent_board", "messages")).toBe(true)
		expect(unavailableTool("post_agent_note", "board")).toBe(false)
		for (const arm of ["solo", "workers", "messages", "board"] as const) {
			expect(unavailableTool("read", arm)).toBe(false)
			expect(unavailableTool("resume_subagent", arm)).toBe(true)
		}
	})

	it("removes unavailable guidance while preserving neighboring instructions", () => {
		const prompt = "Identity\n## Communication\nAsk peers.\n## Coordination board\nRead notes.\n## Checks\nRun tests."
		expect(stripGuidance(prompt, "board")).toBe(prompt)
		expect(stripGuidance(prompt, "messages")).toBe("Identity\n## Communication\nAsk peers.\n## Checks\nRun tests.")
		expect(stripGuidance(prompt, "workers")).toBe("Identity\n## Checks\nRun tests.")
		expect(stripGuidance("Identity\n## Coordination board\nRead notes.", "messages")).toBe("Identity\n")
	})

	it("enforces the same role budget and model across team arms", () => {
		const input = {
			description: "Implementation owner",
			subagent_type: "General-Purpose",
			model: "glm-5.3-flash",
			thinking: "low",
			run_in_background: true,
			max_turns: 70,
			max_duration: 900,
			token_budget: 20000,
		}
		expect(checkLaunch(input, "workers", new Set())).toBeUndefined()
		expect(checkLaunch({ ...input, communication: "group" }, "messages", new Set())).toBeUndefined()
		expect(checkLaunch({ ...input, communication: "group" }, "board", new Set())).toBeUndefined()
		expect(checkLaunch({ ...input, model: "other" }, "workers", new Set())).toContain("model")
		expect(checkLaunch({ ...input, ferment_v2: true }, "workers", new Set())).toContain("ferment_v2")
		expect(checkLaunch(input, "workers", new Set(["Implementation owner"]))).toContain("already started")
		expect(checkLaunch(input, "solo", new Set())).toContain("solo arm")
		const repair = { ...input, description: "Repair owner" }
		for (const arm of ["workers", "messages", "board"] as const) {
			const launch = arm === "workers" ? repair : { ...repair, communication: "group" }
			expect(checkLaunch(launch, arm, new Set())).toBeUndefined()
			expect(checkLaunch({ ...launch, token_budget: 10000 }, arm, new Set())).toContain("token_budget")
		}
	})
})
