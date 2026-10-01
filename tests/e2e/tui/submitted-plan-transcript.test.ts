import { expect, Key, test } from "@microsoft/tui-test"
import { fullText, viewText, waitForText } from "./support/assertions.js"
import {
	createKimchiFixture,
	createKimchiSessionController,
	PROMPT_READY,
	runKimchiSession,
	TUI_TEST_CONFIG,
} from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("a tool-only submitted plan stays in chat after cancellation and session restart", async ({ terminal }) => {
	const plan = "# Cache migration\n\n- Preserve the public API.\n- Verify rollback before deployment."
	const fixture = await createKimchiFixture({
		responses: [
			{ stream: [], toolCalls: [{ function: { name: "submit_plan", arguments: JSON.stringify({ plan }) } }] },
		],
	})
	const session = createKimchiSessionController(terminal, fixture, { extraArgs: ["--plan=true", "-c"] })
	try {
		await session.start()
		terminal.submit("Plan a cache migration and wait for approval.")
		await waitForText(terminal, "Execute the plan", { full: false })
		const review = viewText(terminal)
		expect(review).toContain("Cache migration")
		expect(review).toContain("Preserve the public API.")
		expect(review).toContain("Verify rollback before deployment.")
		expect(review.indexOf("Verify rollback before deployment.")).toBeLessThan(review.indexOf("Execute the plan"))
		terminal.keyPress(Key.Escape)
		await waitForText(terminal, PROMPT_READY, { full: false })
		expect(viewText(terminal)).toContain("Verify rollback before deployment.")
		await session.restart()
		await waitForText(terminal, "Verify rollback before deployment.", { full: false })
		expect(viewText(terminal)).toContain("Cache migration")
		expect(viewText(terminal)).not.toContain("Execute the plan")
		expect(
			fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions")),
		).toHaveLength(1)
	} finally {
		await session.quit().catch(() => {})
		await fixture.stop()
	}
})

test("reworking a plan prints the complete revision and approval keeps it in chat", async ({ terminal }) => {
	const original = "# Original plan\n\nKeep the existing cache interface."
	const revised = `# Revised plan\n\n${Array.from({ length: 60 }, (_, index) => `- Revised requirement ${index + 1}.`).join("\n")}`
	await runKimchiSession(
		terminal,
		{
			artifactName: "submitted-plan-rework-transcript",
			extraArgs: ["--plan=true"],
			responses: [
				{
					stream: [],
					toolCalls: [{ function: { name: "submit_plan", arguments: JSON.stringify({ plan: original }) } }],
				},
				{
					stream: [],
					toolCalls: [{ function: { name: "submit_plan", arguments: JSON.stringify({ plan: revised }) } }],
				},
				{ stream: ["APPROVED_PLAN_EXECUTION_STARTED"] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Plan a cache migration and wait for approval.")
			await waitForText(terminal, "Execute the plan", { full: false })
			expect(viewText(terminal)).toContain("Keep the existing cache interface.")
			terminal.keyDown()
			terminal.keyPress(Key.Enter)
			await waitForText(terminal, PROMPT_READY, { full: false })
			expect(fullText(terminal)).toContain("Keep the existing cache interface.")
			trace.step("rework leaves the first submitted plan in the transcript")
			terminal.submit("Revise the plan to include every verification requirement.")
			await waitForText(terminal, "Revised requirement 60.", { full: false })
			await waitForText(terminal, "Execute the plan", { full: false })
			for (let index = 1; index <= 60; index++) expect(fullText(terminal)).toContain(`Revised requirement ${index}.`)
			trace.step("the full tool-only revision is printed before the unchanged approval menu")
			terminal.keyPress(Key.Enter)
			await waitForText(terminal, "APPROVED_PLAN_EXECUTION_STARTED")
			expect(fullText(terminal)).toContain("Keep the existing cache interface.")
			for (let index = 1; index <= 60; index++) expect(fullText(terminal)).toContain(`Revised requirement ${index}.`)
			expect(
				fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions")),
			).toHaveLength(3)
			trace.step("approval retained both plans and only started the requested execution turn")
		},
	)
})
