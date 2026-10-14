// e2e: pre-compaction history stays visible
// in the TUI after a compaction fires. Deterministic trigger: tiny turns keep
// the estimate below the threshold; the final turn's huge user message pushes
// it over, so auto-compaction fires exactly once, before the final model call.

import { writeFileSync } from "node:fs"
import { test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import {
	createKimchiFixture,
	launchKimchi,
	PROMPT_READY,
	stopKimchi,
	TUI_TEST_CONFIG,
} from "./support/kimchi-fixture.js"

const outputLog = "/tmp/memd1-out.log"
const log = (s: string) => writeFileSync(outputLog, `${s}\n`, { flag: "a" })

test.use(TUI_TEST_CONFIG)

test("memd1: history visible after compaction", async ({ terminal }) => {
	writeFileSync(outputLog, "")
	// NOTE: session-title generation goes to /chat/completions, which the fake
	// 404s WITHOUT consuming the response queue — no title response scripted.
	const responses = [
		{ stream: ["MARKER_TURN_ONE alpha"] },
		{ stream: ["MARKER_TURN_TWO bravo"] },
		{ stream: ["MARKER_TURN_THREE charlie"] },
		// The big turn's model response (compaction fires AFTER it, at turn end).
		{ stream: ["BIG_TURN_RESPONSE echo"] },
		// The compaction summarization call (exactly one LLM request).
		{ stream: ["SUMMARY_OF_EARLIER_CONVERSATION gamma"] },
		// A post-compaction turn, duplicated in case the compaction phase ever
		// consumes an extra response (the duplicate doubles as that buffer —
		// scripting a spare SUMMARY instead would desync the queue when
		// compaction makes exactly one call).
		{ stream: ["MARKER_AFTER_COMPACTION delta"] },
		{ stream: ["MARKER_AFTER_COMPACTION delta"] },
	]

	const fixture = await createKimchiFixture({
		responses,
		// contextWindow 30k, reserve 16.4k → compaction threshold 13.6k tokens.
		models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 30_000, maxTokens: 1024 }],
	})
	try {
		launchKimchi(terminal, fixture, [], {
			...fixture.seedEnv,
			KIMCHI_MEMORY_CAPTURE: "off",
		})
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS })

		// Tiny turns: ~30 tokens each — estimate stays far below 13.6k.
		for (const [i, marker] of ["MARKER_TURN_ONE", "MARKER_TURN_TWO", "MARKER_TURN_THREE"].entries()) {
			terminal.submit(`turn ${i + 1}`)
			await waitForText(terminal, marker, { timeoutMs: 90_000, full: true })
		}

		// Huge user message: ~25k tokens → the estimate crosses the threshold;
		// compaction fires at THIS turn's end (after the model response).
		terminal.submit(`final big turn ${"z".repeat(100_000)}`)
		await waitForText(terminal, "BIG_TURN_RESPONSE echo", { timeoutMs: 150_000, full: true })
		// Compaction completes (summary renders collapsed behind the indicator).
		await waitForText(terminal, "Compacted from", { timeoutMs: 120_000, full: true })

		// A post-compaction turn must work normally.
		terminal.submit("post compaction turn")
		await waitForText(terminal, "MARKER_AFTER_COMPACTION delta", { timeoutMs: 150_000, full: true })

		// Acceptance: pre-compaction history still visible in the full buffer.
		await waitForText(terminal, "MARKER_TURN_ONE alpha", { timeoutMs: 10_000, full: true })
		log("PASS: pre-compaction history visible in full buffer after compaction")
	} finally {
		await stopKimchi(terminal).catch(() => {})
		await fixture.stop().catch(() => {})
	}
})
