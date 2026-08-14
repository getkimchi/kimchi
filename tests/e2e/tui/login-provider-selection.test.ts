import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("auth menus offer OpenAI Codex and show one Kimchi provider", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "login-provider-selection",
			responses: [],
			seedHome: (homeDir) => {
				writeFileSync(
					join(homeDir, ".config", "kimchi", "harness", "auth.json"),
					JSON.stringify({
						"kimchi-dev": { type: "api_key", key: "test-key" },
						"kimchi-dev/anthropic": { type: "api_key", key: "test-key" },
						"kimchi-dev/openai": { type: "api_key", key: "test-key" },
						"openai-codex": { type: "oauth", access: "test-token", refresh: "", expires: 4_102_444_800_000 },
					}),
				)
			},
		},
		async (_fixture, trace) => {
			terminal.write("/login")
			await waitForText(terminal, "/login", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			await waitForText(terminal, "Use a subscription", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.keyDown(2)
			terminal.submit("")
			await waitForText(terminal, "OpenAI Codex", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("OpenAI Codex subscription provider visible")

			terminal.submit("")
			await waitForText(terminal, "Select OpenAI Codex login method", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("bundled OpenAI Codex OAuth flow loaded")

			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.write("/logout")
			await waitForText(terminal, "/logout", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			await waitForText(terminal, "Select provider to logout", { timeoutMs: INPUT_TIMEOUT_MS })

			const kimchiRows = viewText(terminal)
				.split("\n")
				.filter((line) => line.includes("Kimchi") && line.includes("configured"))
			expect(kimchiRows).toHaveLength(1)
			trace.step("one Kimchi credential row visible")
		},
	)
})
