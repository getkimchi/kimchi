import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const MODELS = [
	{ slug: "basic", displayName: "Fake Basic", contextWindow: 1_000_000, maxTokens: 4096 },
	{ slug: "heavy", displayName: "Fake Heavy", contextWindow: 1_000_000, maxTokens: 4096 },
] as const

test("/model picker omits the removed multi-model entry", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "model-picker-without-multi-model",
			models: [...MODELS],
			responses: [],
		},
		async (_fixture, trace) => {
			terminal.write("/model")
			await waitForText(terminal, "/model", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			await waitForText(terminal, "Only showing models from configured providers", {
				timeoutMs: INPUT_TIMEOUT_MS,
				full: false,
			})
			const view = viewText(terminal)
			expect(view).not.toContain("multi-model")
			expect(view).not.toContain("[orchestration]")
			trace.step("model picker contains concrete models only")

			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("model picker closed")
		},
	)
})
