import { expect, test } from "@microsoft/tui-test"
import type { KimchiFixture } from "./support/kimchi-fixture.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * Behavioural state machine for the continuation / empty-turn nudges is
 * exhaustively covered by:
 *
 *   - `src/extensions/orchestration/continuation-nudge.test.ts` — every
 *     suppression and firing branch of `ContinuationNudge` and
 *     `EmptyTurnNudge`, including fresh-session, post-tool same-cycle,
 *     post-tool new-cycle, abort, DONE signal, delegation-pending, and
 *     budget-exhaustion.
 *   - `src/extensions/prompt-construction/prompt-enrichment.test.ts` —
 *     event wiring: `input` -> `resetForNewUserInput`,
 *     `tool_execution_start` -> `recordToolCall`, `turn_end` -> nudge
 *     dispatch.
 *
 * The E2E layer here only needs to prove the wiring is alive end-to-end
 * through the real harness: the followUp message actually reaches the
 * next provider request, and no unrelated code path injects a nudge
 * phrase when none of the nudge conditions are met. Two scenarios are
 * sufficient and avoid the flaky multi-cycle / compaction-timing paths
 * that the previous suite relied on.
 */

/** Nudge phrases emitted by the orchestrator nudges when they fire. */
const CONTINUATION_NUDGE_PHRASE = "You ended your turn without calling a tool" // CONTINUATION_NUDGE_TEXT
const SECOND_NUDGE_PHRASE = "You MUST call a tool immediately" // SECOND_NUDGE_TEXT
const EMPTY_TURN_NUDGE_PHRASE = "If you have finished, please summarize the result for the user" // EMPTY_TURN_NUDGE_TEXT

/**
 * The harness makes several session-bookkeeping completion requests per user
 * input (title generation, context summary, …), so counting requests is not
 * a meaningful signal. The robust assertion is: the nudge text must not
 * (or must) appear in any request body after the turn completes — a
 * `followUp` nudge is injected into the conversation and shows up in every
 * subsequent request's messages array.
 */
function anyRequestContainsNudgePhrase(fixture: KimchiFixture, phrase: string): boolean {
	for (const request of fixture.fake.requests) {
		const bodyText = JSON.stringify(request.body ?? "")
		if (bodyText.includes(phrase)) return true
	}
	return false
}

function anyRequestContainsAnyNudge(fixture: KimchiFixture): boolean {
	return (
		anyRequestContainsNudgePhrase(fixture, CONTINUATION_NUDGE_PHRASE) ||
		anyRequestContainsNudgePhrase(fixture, SECOND_NUDGE_PHRASE) ||
		anyRequestContainsNudgePhrase(fixture, EMPTY_TURN_NUDGE_PHRASE)
	)
}

/**
 * Waits for the harness to finish processing the orchestrator's main turn
 * AND any nudge-driven followUp turn.
 *
 * Polls `fixture.fake.requests.length` until no new completion requests
 * have arrived for `settleForMs`. This is the authoritative "all nudges
 * have either fired or been suppressed" signal — stable for the full
 * window means the harness is idle and ready to assert.
 */
async function waitForTurnToSettle(fixture: KimchiFixture) {
	const settleForMs = 1_200
	const timeoutMs = 30_000
	const startedAt = Date.now()
	let lastCount = fixture.fake.requests.length
	let stableSince = Date.now()
	while (Date.now() - startedAt < timeoutMs) {
		await new Promise((resolve) => setTimeout(resolve, 100))
		const currentCount = fixture.fake.requests.length
		if (currentCount !== lastCount) {
			lastCount = currentCount
			stableSince = Date.now()
		} else if (Date.now() - stableSince >= settleForMs) {
			return
		}
	}
	throw new Error("Request count did not settle")
}

test("nudge wiring stays silent on a text-only response in a fresh session", async ({ terminal }) => {
	// Wiring smoke: when none of the nudge conditions are met, no
	// component of the harness should inject a nudge phrase into any
	// subsequent provider request. Catches regressions where an
	// unrelated code path leaks the nudge text into the conversation.
	await runKimchiSession(
		terminal,
		{
			artifactName: "nudge-wiring-silent",
			responses: [{ stream: ["Hello there."] }],
		},
		async (fixture, trace) => {
			terminal.submit("hello")
			trace.step("submitted prompt")
			await waitForTurnToSettle(fixture)
			trace.step("settled")
			expect(anyRequestContainsAnyNudge(fixture)).toBe(false)
		},
	)
})

test("nudge wiring fires the empty-turn nudge when the orchestrator returns empty content", async ({ terminal }) => {
	// Wiring smoke: when the orchestrator returns a completely empty
	// turn (no text, no tool calls), the empty-turn nudge must be
	// injected into the next provider request. Asserts that
	// turn_end -> EmptyTurnNudge.evaluateTurn -> sendMessage(followUp)
	// is alive end-to-end. The same-cycle continuation-nudge path is
	// covered by unit tests in continuation-nudge.test.ts; running it
	// here too added a compaction-timing race without unique coverage.
	await runKimchiSession(
		terminal,
		{
			artifactName: "nudge-wiring-empty-turn",
			responses: [{ stream: [] }],
		},
		async (fixture, trace) => {
			terminal.submit("go")
			trace.step("submitted prompt")
			await waitForTurnToSettle(fixture)
			trace.step("settled")
			expect(anyRequestContainsNudgePhrase(fixture, EMPTY_TURN_NUDGE_PHRASE)).toBe(true)
		},
	)
})
