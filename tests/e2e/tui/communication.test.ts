import { expect, test } from "@microsoft/tui-test"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("a fresh conversation sends default communication guidance on successive turns", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "communication",
			responses: [{ stream: ["First response received."] }, { stream: ['{"ready":true}'] }],
		},
		async (fixture, trace) => {
			terminal.submit("Explain how to check a change.")
			await expect(terminal.getByText("First response received.", { full: true })).toBeVisible()
			trace.step("first response rendered without setup")

			terminal.submit("Reply with only a JSON object whose ready field is true.")
			await expect(terminal.getByText('{"ready":true}', { full: true })).toBeVisible()
			trace.step("explicit output format rendered")

			const requests = fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
			expect(requests).toHaveLength(2)
			const prompts = requests.map((request) => {
				const body = request.body as { messages: { role: string; content: string }[] }
				return body.messages.find((message) => message.role === "system")?.content
			})
			for (const prompt of prompts) {
				expect(prompt).toContain("## Communication")
				expect(prompt).toContain("Explicit output formats, including code-only or structured data, take precedence")
				expect(prompt).toContain("A clarification-only reply is at most two short sentences")
			}
			expect(prompts[1]).toBe(prompts[0])
			trace.step("default system guidance is stable across turns")
		},
	)
})
