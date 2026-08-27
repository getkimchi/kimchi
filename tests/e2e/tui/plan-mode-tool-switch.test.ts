import { expect, Key, test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

function toolNames(body: unknown): string[] {
	if (!body || typeof body !== "object") return []
	const tools = (body as { tools?: unknown }).tools
	if (!Array.isArray(tools)) return []
	return tools.flatMap((tool) => {
		if (!tool || typeof tool !== "object") return []
		const fn = (tool as { function?: unknown }).function
		if (!fn || typeof fn !== "object") return []
		const name = (fn as { name?: unknown }).name
		return typeof name === "string" ? [name] : []
	})
}

test("plan-mode tool switch: approved ExitPlanMode restores the pre-plan tools", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "plan-mode-tool-switch",
			gitInit: true,
			extraArgs: ["--plan=true"],
			responses: [
				{
					stream: ["## Goal\nAdd a new feature.\n\n", "## Chunks\n\n### Chunk 1: Implement the feature\n"],
					toolCalls: [
						{
							function: {
								name: "ExitPlanMode",
								arguments: JSON.stringify({
									plan: "## Goal\nAdd a new feature.\n\n## Chunks\n\n### Chunk 1: Implement the feature\n",
								}),
							},
						},
					],
				},
				{ stream: ["Plan approved; execution has started.\n"] },
			],
		},
		async (fixture, trace) => {
			await waitForText(terminal, /plan(?: → shift\+tab)? · basic\b/, { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("plan mode active")

			terminal.submit("Plan out how to add a new feature")
			trace.step("submitted planning request")
			await waitForText(terminal, "Add a new feature.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Execute the plan", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("ExitPlanMode approval UI rendered")

			terminal.keyPress(Key.Enter)
			trace.step("approved plan")
			await waitForText(terminal, "Plan approved; execution has started.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)

			const requests = fixture.fake.requests.map((request) => toolNames(request.body))
			const planRequestIndex = requests.findIndex((names) => names.includes("ExitPlanMode"))
			expect(planRequestIndex >= 0).toBe(true)
			const restricted = requests[planRequestIndex] ?? []
			expect(restricted).not.toContain("write")
			expect(restricted).not.toContain("edit")
			expect(restricted).not.toContain("Agent")

			const restored = requests.slice(planRequestIndex + 1).find((names) => names.includes("write"))
			expect(restored).toBeDefined()
			expect(restored).toEqual(expect.arrayContaining(["write", "edit", "Agent"]))
			trace.step("pre-plan write tools restored after approval")
		},
	)
})
