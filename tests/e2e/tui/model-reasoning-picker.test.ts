import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("model selection opens reasoning on High and preserves it on reselection", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "model-then-reasoning-picker",
			models: [
				{ slug: "basic", displayName: "Fake Basic", reasoning: false },
				{ slug: "thinker", displayName: "Fake Thinker", reasoning: true },
				{ slug: "thinker-two", displayName: "Fake Thinker Two", reasoning: true },
			],
			responses: [],
			seedHome: (homeDir) => {
				writeFileSync(
					join(homeDir, ".config", "kimchi", "harness", "settings.json"),
					JSON.stringify({
						statusLine: { pinned: [] },
						hideThinkingBlock: true,
						defaultThinkingLevel: "medium",
					}),
				)
			},
		},
		async (fixture, trace) => {
			terminal.submit("/model fake/thinker")
			await waitForText(terminal, /→ high[ \t]*$/m, { timeoutMs: STREAM_TIMEOUT_MS })
			expect(viewText(terminal)).not.toMatch(/\b(?:No|Very brief|Light|Moderate|Deep|Extra-high|Maximum) reasoning\b/)
			trace.step("reasoning picker opened after model choice")

			const settings = JSON.parse(readFileSync(join(fixture.agentDir, "settings.json"), "utf-8")) as {
				defaultThinkingLevel?: string
				kimchiHighThinkingDefaultApplied?: boolean
			}
			expect(settings.defaultThinkingLevel).toBe("high")
			expect(settings.kimchiHighThinkingDefaultApplied).toBe(true)

			terminal.keyUp()
			await waitForText(terminal, /→ medium[ \t]*$/m, { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.write("\r")
			await waitForText(terminal, "Model: thinker", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("Normal reasoning selected on the first model")

			terminal.submit("/model fake/thinker-two")
			await waitForText(terminal, /→ high[ \t]*$/m, { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.write("\r")
			await waitForText(terminal, "Model: thinker-two", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("second model reset to default High reasoning")

			terminal.submit("/model")
			await waitForText(terminal, "Model Name: Fake Thinker Two", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.write("\r")
			await waitForText(terminal, /→ high[ \t]*$/m, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("reasoning picker reopened after selecting the active model")
		},
	)
})
