import { expect, test } from "@microsoft/tui-test"
import type { KimchiFixture } from "./support/kimchi-fixture.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"

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
 * AND any nudge-driven followUp turn. The terminal prints a `✻ Worked for`
 * status line after each turn completes; for "stays silent" tests exactly
 * one appears (the orchestrator's turn), for "fires" tests two or more
 * appear (orchestrator + each nudge response). We wait for the orchestrator
 * marker, then poll until no new requests have arrived for 1.5s — that's
 * the deterministic "all nudges have either fired or been suppressed"
 * signal.
 */
async function waitForTurnToSettle(fixture: KimchiFixture, terminal: import("@microsoft/tui-test").Terminal) {
	await waitForText(terminal, "Worked for", { timeoutMs: STREAM_TIMEOUT_MS })
	const settleForMs = 1_500
	const startedAt = Date.now()
	let lastCount = fixture.fake.requests.length
	let stableSince = Date.now()
	while (Date.now() - startedAt < settleForMs * 4) {
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
			await waitForTurnToSettle(fixture, terminal)
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
			// 700ms lands well after the first chunk and well before the final one.
			await new Promise((resolve) => setTimeout(resolve, 700))
			terminal.keyCtrlC()
			trace.step("pressed Ctrl+C during streaming")
			await waitForTurnToSettle(fixture, terminal)
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
			await waitForTurnToSettle(fixture, terminal)
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
			await waitForTurnToSettle(fixture, terminal)
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
			await waitForTurnToSettle(fixture, terminal)
			trace.step("settled")
			expect(anyRequestContainsAnyNudge(fixture)).toBe(true)
		},
	)
})
