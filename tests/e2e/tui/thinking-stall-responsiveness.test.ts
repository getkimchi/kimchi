import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * Regression guard for the long-session terminal freeze: with the default
 * hidden-thinking view, the live "Thinking" preview must not do work
 * proportional to the full accumulated reasoning text on every spinner-driven
 * render frame.
 *
 * The fake provider streams a large reasoning payload and then stalls with the
 * connection held open — the exact user-reported scenario (spinner running,
 * thinking active, no further stream data). While stalled, typed input must
 * echo promptly. Before the tail-render/cache fixes in
 * src/extensions/thinking-steps/, every frame re-wrapped the entire reasoning
 * text (~1s per frame at this payload size), so each keypress waited on a
 * blocked event loop and this test's latency budget fails.
 */

// ~3MB of reasoning split into ~1KB SSE chunks. Paragraph breaks keep the
// step splitter realistic; inline markdown markers (backticks, bold) mirror
// real reasoning output and exercise the inline-markup regexes; the closing
// sentence varies per chunk so the text does not collapse into one line.
const THINKING_CHUNK_COUNT = 3072
const thinkingChunks = Array.from({ length: THINKING_CHUNK_COUNT }, (_, index) => {
	const line = `Considering hypothesis ${index} about \`renderCollapsed\` and comparing **line diff** output against \`previousLines\`.\n`
	return `${line.repeat(9)}\nNow verifying case ${index} before moving on.\n\n`
})

const TYPED_TEXT = "zqxwvu42abcdef"
// Post-fix a char echoes within one 100ms poll (~1.5s for all round-trips);
// pre-fix each round-trip waits on ~1s of blocked render frames (~10s total).
// The bound sits between with ~2x margin to both sides.
const TOTAL_ECHO_BUDGET_MS = 5_000

test("typed input echoes promptly while a large thinking stream is stalled", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "thinking-stall-responsiveness",
			// Reasoning-capable model so reasoning_content maps to thinking events;
			// large context window so the oversized payload doesn't trigger
			// context-overflow handling unrelated to this regression.
			models: [
				{
					slug: "thinking-model",
					displayName: "Fake Thinking",
					reasoning: true,
					contextWindow: 8_000_000,
					maxTokens: 64_000,
				},
			],
			extraArgs: ["--model", "thinking-model"],
			responses: [
				{
					thinking: thinkingChunks,
					stallAfterThinking: true,
				},
			],
		},
		async (_fixture, trace) => {
			terminal.submit("think about it")
			trace.step("submitted prompt")

			// The hidden-thinking live preview header appears once thinking starts.
			await waitForText(terminal, "Thinking", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			trace.step("thinking preview visible")

			// Give the client time to consume the full stalled stream so the
			// latency measurement below isn't dominated by ingest work.
			await new Promise((resolve) => setTimeout(resolve, 3_000))
			trace.step("stream consumed, provider stalled")

			const startedAt = Date.now()
			let typed = ""
			for (const char of TYPED_TEXT) {
				terminal.keyPress(char)
				typed += char
				// Skip short prefixes that could match stray terminal content.
				if (typed.length >= 4) {
					await waitForText(terminal, typed, { timeoutMs: INPUT_TIMEOUT_MS, full: false })
				}
			}
			const elapsedMs = Date.now() - startedAt
			trace.step(`typed ${TYPED_TEXT} in ${elapsedMs}ms during stalled stream`)

			expect(elapsedMs).toBeLessThan(TOTAL_ECHO_BUDGET_MS)
		},
	)
})
