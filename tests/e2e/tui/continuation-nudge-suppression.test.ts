import { expect, test } from "@microsoft/tui-test"
import type { KimchiFixture } from "./support/kimchi-fixture.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/** Nudge phrases emitted by the orchestrator nudges when they fire. */
const CONTINUATION_NUDGE_PHRASE = "You ended your turn without calling a tool" // CONTINUATION_NUDGE_TEXT
const SECOND_NUDGE_PHRASE = "You MUST call a tool immediately" // SECOND_NUDGE_TEXT
const EMPTY_TURN_NUDGE_PHRASE =
	"If you have finished, please summarize the result for the user" // EMPTY_TURN_NUDGE_TEXT

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
 *
 * Terminal-marker waits ("Worked for", etc.) were tried and dropped:
 * they were unreliable across empty-turn and aborted scenarios where
 * the marker never renders, and added wall time without accelerating
 * the happy path.
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

/**
 * Waits until at least one completion request has reached the fake server.
 * Used by the abort test to prove the stream actually started before
 * issuing Ctrl+C — otherwise a slow CI runner could send Ctrl+C while
 * the harness is still booting the request, which would dismiss the
 * input rather than abort an in-flight turn.
 */
async function waitForFirstRequest(fixture: KimchiFixture, timeoutMs = 10_000) {
	const startedAt = Date.now()
	while (Date.now() - startedAt < timeoutMs) {
		if (fixture.fake.requests.length >= 1) return
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	throw new Error("No completion request reached the fake server before timeout")
}

/**
 * Behavioural coverage for the orchestrator's continuation and empty-turn
 * nudges, complementing the unit tests in `continuation-nudge.test.ts`:
 *
 *   - "stays silent" cases pin down the suppression conditions (fresh
 *     session, user abort, post-tool empty response).
 *   - "fires" cases pin down that the nudge wiring still works after the
 *     fix — a regression that disables the nudge entirely would pass the
 *     suppression tests but fail these.
 *
 * Each scenario is one user input, with the orchestrator returning either
 * text-only, empty content, or a tool call followed by one of the above.
 * Bookkeeping requests (title gen, context summary) consume the fake's
 * default fallback and don't influence the assertions.
 */

test("continuation nudge stays silent on a text-only response in a fresh session", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "nudge-silent-fresh-session",
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

test("continuation nudge stays silent after the user aborts an in-flight turn", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "nudge-silent-user-abort",
			// Stream chunks spaced so the harness enters streaming state and
			// the test has time to issue Ctrl+C mid-stream. The harness wires
			// the keyboard signal to the provider's AbortSignal, which
			// surfaces as a turn_end with `stopReason: "aborted"`.
			responses: [{ stream: ["aaa", "bbb", "ccc"], delayMs: 400 }],
		},
		async (fixture, trace) => {
			terminal.submit("go")
			trace.step("submitted prompt")
			// Wait for the harness to actually start streaming before aborting.
			// Without this gate, a slow CI runner could process Ctrl+C while
			// the harness is still booting the completion request, which
			// would dismiss the input instead of triggering a real abort.
			await waitForFirstRequest(fixture)
			trace.step("first completion request observed")
			// Sleep long enough for the first chunk (delayMs=400) to land but
			// well before the final chunk.
			await new Promise((resolve) => setTimeout(resolve, 500))
			terminal.keyCtrlC()
			trace.step("pressed Ctrl+C during streaming")
			await waitForTurnToSettle(fixture)
			trace.step("settled")
			// Assert against ALL nudges (continuation + empty-turn) so this
			// test catches either nudge firing on top of an abort.
			expect(anyRequestContainsAnyNudge(fixture)).toBe(false)
		},
	)
})

test("empty-turn nudge fires when the orchestrator returns empty content", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "nudge-fires-empty-turn",
			// Empty stream -> the orchestrator's assistant message has no
			// text and no tool calls. EmptyTurnNudge should fire.
			responses: [{ stream: [] }],
		},
		async (fixture, trace) => {
			terminal.submit("go")
			trace.step("submitted prompt")
			await waitForTurnToSettle(fixture)
			trace.step("settled")
			expect(anyRequestContainsAnyNudge(fixture)).toBe(true)
		},
	)
})

test("empty-turn nudge stays silent when a tool was called earlier in the run", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "nudge-silent-empty-turn-after-tool",
			responses: [
				// First orchestrator call returns a tool call -> tool executes,
				// `toolsCalledThisAgentRun` flips on.
				{
					stream: ["Reading the file."],
					toolCalls: [
						{ function: { name: "read", arguments: JSON.stringify({ path: "/dev/null" }) } },
					],
				},
				// Post-tool response is empty. Without the per-run guard this
				// would fire the empty-turn nudge ("summarize or continue");
				// with the guard, a legitimately-empty post-tool response is
				// left alone. (The continuation nudge may still fire in this
				// scenario because the tool result is delivered as a new
				// "input" event that resets `toolsCalledSinceLastUserInput`;
				// that's existing harness behavior unrelated to this test.)
				{ stream: [] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("show me /dev/null")
			trace.step("submitted prompt")
			await waitForTurnToSettle(fixture)
			trace.step("settled")
			// Assert against ONLY the empty-turn nudge phrase — this test
			// pins the per-run guard at prompt-enrichment.ts. Asserting
			// `anyRequestContainsAnyNudge` would conflate this with the
			// unrelated continuation nudge behaviour.
			expect(anyRequestContainsNudgePhrase(fixture, EMPTY_TURN_NUDGE_PHRASE)).toBe(false)
		},
	)
})

test("continuation nudge fires when the orchestrator returns text-only after a tool was called", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "nudge-fires-continuation-after-tool",
			responses: [
				// First orchestrator call returns a tool call -> tool executes,
				// session-lifetime `toolsCalledThisSession` flips on.
				{
					stream: ["Reading the file."],
					toolCalls: [
						{ function: { name: "read", arguments: JSON.stringify({ path: "/dev/null" }) } },
					],
				},
				// Post-tool response is text-only (legitimate end-of-task
				// summary). With the fresh-session suppression now behind us,
				// the continuation nudge must fire.
				{ stream: ["Task complete."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("show me /dev/null")
			trace.step("submitted prompt")
			await waitForTurnToSettle(fixture)
			trace.step("settled")
			expect(anyRequestContainsAnyNudge(fixture)).toBe(true)
		},
	)
})
