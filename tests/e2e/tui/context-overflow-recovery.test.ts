/**
 * E2E TUI test: context-window overflow recovery.
 *
 * When a request fails with a 400 context-length error, the error sanitizer
 * used to destroy the raw overflow text before upstream's `_checkCompaction`
 * could classify it. The session then wedged: every subsequent turn sent the
 * same oversized context and got the same 400.
 *
 * This test simulates that path end-to-end:
 *   1. Prime a session with several long prompts (large enough that upstream's
 *      compaction algorithm, which estimates from message content, has a
 *      summarizable prefix).
 *   2. Submit a follow-up that the gateway rejects with a context-length 400.
 *   3. Assert the session auto-compacts and retries instead of wedging.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import {
	STARTUP_TIMEOUT_MS,
	STREAM_TIMEOUT_MS,
	viewText,
	waitForText,
	waitForTurnToSettle,
} from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const LARGE_CONTEXT_MODEL = {
	slug: "basic",
	displayName: "Fake Basic",
	// Large window so proactive threshold compaction (90%) never fires during priming.
	contextWindow: 100_000,
	maxTokens: 4096,
}

const OVERFLOW_ERROR_BODY = {
	error: {
		message: "BadRequestError: The input (104857 tokens) is longer than the model's context length (1048576 tokens).",
		type: "invalid_request_error",
		code: 400,
	},
}

/**
 * Generate a long prompt so the chars÷4 token estimate pushes the session over
 * keepRecentTokens. The compaction algorithm estimates tokens from message
 * content, not from fake usage numbers.
 */
function largePrompt(base: string, tokens: number): string {
	const chunk = "one two three four five six seven eight nine ten "
	const repeats = Math.ceil((tokens * 4) / chunk.length)
	return `${base}: ${chunk.repeat(repeats)}`
}

function seedCompactionSettings(homeDir: string, _workDir: string) {
	const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
	const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
	// Lower keepRecentTokens so a small number of long prompts creates a
	// summarizable prefix without needing tens of thousands of characters.
	settings.compaction = { keepRecentTokens: 1_000 }
	writeFileSync(settingsPath, JSON.stringify(settings, null, "\t"), "utf-8")
	return {}
}

test("context-window 400 is sanitized, auto-compacts, and recovers instead of wedging", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "context-overflow-auto-compaction-recovery",
			gitInit: true,
			models: [LARGE_CONTEXT_MODEL],
			seedHome: seedCompactionSettings,
			responses: [
				// Prime enough history that compaction has something to summarize.
				{ stream: ["Ack 1."], usage: { prompt_tokens: 400, completion_tokens: 1 } },
				{ stream: ["Ack 2."], usage: { prompt_tokens: 400, completion_tokens: 1 } },
				{ stream: ["Ack 3."], usage: { prompt_tokens: 400, completion_tokens: 1 } },
				// The overflow 400.
				{
					status: 400,
					body: OVERFLOW_ERROR_BODY,
				},
				// Compaction summary request.
				{
					stream: ["Summary", " of", " prior", " context."],
					usage: { prompt_tokens: 100, completion_tokens: 4 },
				},
				// Retry after compaction.
				{
					stream: ["Recovered", " after", " compaction."],
					usage: { prompt_tokens: 1000, completion_tokens: 3 },
				},
			],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			terminal.submit(largePrompt("First prompt", 500))
			await waitForText(terminal, "Ack 1.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("turn 1 complete")

			terminal.submit(largePrompt("Second prompt", 500))
			await waitForText(terminal, "Ack 2.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("turn 2 complete")

			terminal.submit(largePrompt("Third prompt", 500))
			await waitForText(terminal, "Ack 3.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("turn 3 complete")

			terminal.submit("Continue the task")
			trace.step("submitted follow-up that will overflow")

			// Wait for the recovered response. This proves the session did not
			// wedge on the 400: _checkCompaction classified the raw overflow,
			// _runAutoCompaction compacted, and the retry completed.
			await waitForText(terminal, "Recovered after compaction.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("recovered response visible — overflow recovery worked")

			const chatRequests = fixture.fake.requests.filter((req) => req.url.startsWith("/openai/v1/chat/completions"))
			expect(chatRequests.length).toBeGreaterThanOrEqual(6)
			trace.step(`${chatRequests.length} chat requests recorded`)

			// The 5th chat request (0-indexed: 4) should be the compaction summary.
			const compactionReq = chatRequests[4]?.body as Record<string, unknown>
			const compactionMessages = JSON.stringify(compactionReq.messages ?? compactionReq)
			expect(compactionMessages).toContain("context summarization assistant")
			trace.step("compaction request present")

			// The 6th chat request (0-indexed: 5) should be the retry after compaction.
			const retryReq = chatRequests[5]?.body as Record<string, unknown>
			expect(retryReq).toBeDefined()
			trace.step("retry request present")

			// The raw provider error must not leak to the terminal.
			expect(viewText(terminal)).not.toContain("longer than the model")
			expect(viewText(terminal)).not.toContain("104857 tokens")
			trace.step("raw overflow error sanitized")
		},
	)
})
