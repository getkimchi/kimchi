import { expect, test } from "@microsoft/tui-test"
import { fullText, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

for (const [command, question] of [
	["setup", "An API key is already configured. Keep it?"],
	["setup-tools", "Which tools should be configured?"],
]) {
	test(`${command} shows a styled key mismatch warning above the first question`, async ({ terminal }) => {
		await runKimchiSession(
			terminal,
			{
				artifactName: `${command}-key-warning`,
				initialModel: false,
				extraArgs: [command],
				startupText: question,
				responses: [],
				seedHome() {
					return { env: { KIMCHI_API_KEY: "different-environment-key" } }
				},
			},
			async (_fixture, trace) => {
				const output = fullText(terminal)
				const warning = "KIMCHI_API_KEY differs from your saved key. Using the environment key."
				expect(output).toContain(warning)
				expect(output).not.toContain(`Warning: ${warning}`)
				expect(output.split(warning)).toHaveLength(2)
				expect(output.indexOf(warning)).toBeLessThan(output.indexOf(question))
				trace.step("styled key mismatch warning appears once above the first question")
				terminal.keyEscape()
				await waitForText(terminal, "Cancelled.")
			},
		)
	})
}
