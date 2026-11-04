import { expect, test } from "@microsoft/tui-test"
import { fullText, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import type { FakeModel } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const REASONING_MODELS: FakeModel[] = [
	{
		slug: "reasoner",
		displayName: "Fake Reasoner",
		provider: "ai-enabler",
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
]

// Distinctive reasoning text: anything that leaks the raw body into the
// transcript means thinking rendered expanded, which must not be the default.
const THINKING_TEXT = ["First I parse the config for the E2E-TRACE-STEP-ONE marker."]
const SUMMARY_HEADER = "Thinking Steps · Summary"

/**
 * The default settings pin `hideThinkingBlock: true`, so out of the box a
 * settled thinking block renders as a collapsed marker ("Thought for <1s" /
 * "Thinking…") — never the raw reasoning body and never the removed
 * "Thinking Steps · Summary" view.
 */
test("default thinking view is a collapsed marker, not the summary or expanded view", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "thinking-steps-default-collapsed",
			providerId: "kimchi-dev",
			initialModel: "reasoner",
			models: REASONING_MODELS,
			responses: [{ thinking: THINKING_TEXT, stream: ["Delivered."] }],
		},
		async (_fixture, trace) => {
			trace.step("reply with a thinking payload")
			terminal.submit("say hi")
			await waitForText(terminal, "Delivered.", { timeoutMs: STREAM_TIMEOUT_MS })

			trace.step("settled transcript shows the collapsed marker only")
			const text = fullText(terminal)
			expect(text).toContain("Delivered.")
			expect(text).toMatch(/Thought for|Thinking…/)
			expect(text).not.toContain("E2E-TRACE-STEP-ONE")
			expect(text).not.toContain(SUMMARY_HEADER)
		},
	)
})
