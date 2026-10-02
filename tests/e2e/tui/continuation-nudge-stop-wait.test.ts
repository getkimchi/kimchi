/**
 * TUI e2e: continuation-nudge stop/wait semantics (issue_1).
 *
 * The nudge state machine, response blanking, and pending-state cleanup are
 * exhaustively unit-tested in `src/extensions/orchestration/continuation-nudge.test.ts`
 * and `src/extensions/prompt-construction/prompt-enrichment.test.ts`. These
 * workflows prove the user-visible behavior end-to-end through the real
 * harness binary:
 *
 *  1. A mid-text blocking question after a tool cycle does not trigger the
 *     continuation nudge — the assistant waits for the user instead of
 *     continuing to work over its own judgment (issue_1 entries 2022-2028).
 *  2. An explicit user stop answered with a waiting statement ("until you
 *     say so") does not trigger the nudge either (issue_1 entries 2040-2051).
 *  3. A real drift turn triggers the nudge; the token-only `<done>`
 *     acknowledgement stays hidden, no second or empty-turn nudge follows, and
 *     a later extension-triggered turn (injected by the nudge-waiter fixture
 *     extension, with no intervening user input or tool call) streams
 *     normally — the exact path stale recovery state used to blank.
 *
 * Every scenario first runs a real tool cycle so the session-level tool latch
 * is armed — without it, fresh-session suppression would mask the bug these
 * tests exist to catch.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import type { KimchiFixture } from "./support/kimchi-fixture.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/** Nudge phrases emitted by the orchestrator nudges when they fire. */
const CONTINUATION_NUDGE_PHRASE = "You ended your turn without calling a tool" // CONTINUATION_NUDGE_TEXT
const SECOND_NUDGE_PHRASE = "MUST call the required tool immediately" // SECOND_NUDGE_TEXT
const EMPTY_TURN_NUDGE_PHRASE = "If you have finished, please summarize the result for the user" // EMPTY_TURN_NUDGE_TEXT

/** A `followUp` nudge is injected into the conversation and shows up in every
 *  subsequent request's messages array, so scanning recorded request bodies is
 *  the robust way to assert whether a nudge fired. */
function countRequestsContaining(fixture: KimchiFixture, phrase: string): number {
	return fixture.fake.requests.filter((request) => JSON.stringify(request.body ?? "").includes(phrase)).length
}

function anyRequestContains(fixture: KimchiFixture, phrase: string): boolean {
	return countRequestsContaining(fixture, phrase) > 0
}

async function waitForRequestContaining(fixture: KimchiFixture, phrase: string, timeoutMs = 10_000): Promise<void> {
	const startedAt = Date.now()
	while (Date.now() - startedAt < timeoutMs) {
		if (anyRequestContains(fixture, phrase)) return
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	throw new Error(`Timed out waiting for a provider request containing "${phrase}".`)
}

/** A read tool call that arms the session-level tool latch, so a later
 *  text-only turn in the same session is not suppressed by the fresh-session
 *  guard and can actually trigger (or suppress) the continuation nudge. */
const READ_TOOL_CALL = {
	toolCalls: [
		{
			id: "call_read_notes",
			function: { name: "read", arguments: JSON.stringify({ path: "notes.txt" }) },
		},
	],
}

function seedNotesFile(_homeDir: string, workDir: string): void {
	writeFileSync(join(workDir, "notes.txt"), "- task one\n- task two\n- task three\n")
}

/** Seeds the notes file plus the nudge-waiter fixture extension into the
 *  project-scope extensions dir (`.config/kimchi/harness/extensions/`) that
 *  pi discovers automatically.
 *
 *  Must be paired with `trustWorkDir: true`: the fixture's upstream trust
 *  detector resolves the config dir as `.pi` under pnpm's realpath layout, so
 *  it does not see the seeded directory and skips recording trust — while the
 *  kimchi binary does detect it and would block on the trust prompt. */
function seedNotesAndWaiterExtension(_homeDir: string, workDir: string): void {
	seedNotesFile(_homeDir, workDir)
	const extensionsDir = join(workDir, ".config", "kimchi", "harness", "extensions")
	mkdirSync(extensionsDir, { recursive: true })
	writeFileSync(
		join(extensionsDir, "nudge-waiter.js"),
		readFileSync(new URL("./support/fixtures/nudge-waiter.js", import.meta.url), "utf-8"),
	)
}

test("a mid-text blocking question after a tool cycle leaves the assistant idle", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "continuation-nudge-midtext-question",
			seedHome: seedNotesFile,
			responses: [
				READ_TOOL_CALL,
				{ stream: ["The notes list three tasks for today."] },
				{
					stream: [
						"I checked the working tree. Did you intentionally delete happy-path.spec.ts? ",
						"Everything else matches the plan, so I will hold off.",
					],
				},
			],
		},
		async (fixture, trace) => {
			// First user-input cycle contains a real tool call, so the session
			// latch is armed and the next text-only cycle is nudge-eligible.
			terminal.submit("read notes.txt")
			await waitForText(terminal, "three tasks", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("tool cycle completed, session latch armed")

			// The model asks a blocking question mid-text and keeps talking
			// after it (issue_1 entry 2022) — no trailing question mark.
			terminal.submit("what is missing?")
			await waitForText(terminal, "happy-path.spec.ts?", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("mid-text blocking question visible")

			await waitForTurnToSettle(fixture.fake.requests)
			// The turn is waiting on the user: no nudge may be injected into
			// any provider request, and no follow-up turn may run.
			expect(anyRequestContains(fixture, CONTINUATION_NUDGE_PHRASE)).toBe(false)
			expect(anyRequestContains(fixture, SECOND_NUDGE_PHRASE)).toBe(false)
			trace.step("assistant idle without a continuation nudge")
		},
	)
})

test("an explicit user stop answered with a waiting statement leaves the assistant idle", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "continuation-nudge-user-stop",
			seedHome: seedNotesFile,
			responses: [
				READ_TOOL_CALL,
				{ stream: ["The notes list three tasks for today."] },
				{ stream: ["Stopped. No further action until you say so."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("read notes.txt")
			await waitForText(terminal, "three tasks", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("tool cycle completed, session latch armed")

			// The user explicitly stops the agent mid-task (issue_1 entry 2040).
			// The model correctly answers with a text-only waiting statement
			// (entry 2044) — no question mark anywhere.
			terminal.submit("wait stop working I did not say anything")
			await waitForText(terminal, "until you say so", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("stopping response visible")

			await waitForTurnToSettle(fixture.fake.requests)
			// Nudging after an explicit stop previously pushed the model into
			// "safest: abort the rebase?" work right after the user said stop
			// (issue_1 entries 2047-2051).
			expect(anyRequestContains(fixture, CONTINUATION_NUDGE_PHRASE)).toBe(false)
			expect(anyRequestContains(fixture, SECOND_NUDGE_PHRASE)).toBe(false)
			trace.step("assistant idle without a continuation nudge")
		},
	)
})

test("a token-only done acknowledgement ends recovery silently and later extension turns stream normally", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "continuation-nudge-done-signal",
			seedHome: seedNotesAndWaiterExtension,
			trustWorkDir: true,
			responses: [
				READ_TOOL_CALL,
				{ stream: ["The notes list three tasks for today."] },
				// Text-only drift in a fresh user-input cycle: statement-only,
				// no question, no waiting phrase — this must trigger the nudge.
				{ stream: ["I will delegate the implementation to a builder agent next."] },
				// The token-only acknowledgement, split across two streamed
				// deltas: every delta must be blanked.
				{ stream: ["<do", "ne>"] },
				// The extension-triggered turn's response. The trailing hand-back
				// phrase keeps it from being drift-nudged itself.
				{ stream: ["The background watcher finished: build passed. Let me know if you want the full log."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("read notes.txt")
			await waitForText(terminal, "three tasks", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("tool cycle completed, session latch armed")

			// Text-only drift triggers the real continuation nudge as a followUp.
			terminal.submit("continue with the implementation")
			await waitForText(terminal, "delegate the implementation", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForRequestContaining(fixture, CONTINUATION_NUDGE_PHRASE)
			trace.step("drift response visible, continuation nudge delivered")

			await waitForTurnToSettle(fixture.fake.requests)
			// The token-only acknowledgement is a silent end-of-turn: the token
			// is never displayed (not even a partial delta), and no second or
			// empty-turn nudge follows it.
			const text = fullText(terminal)
			expect(text).not.toContain("<done>")
			expect(text).not.toContain("ne>")
			expect(anyRequestContains(fixture, SECOND_NUDGE_PHRASE)).toBe(false)
			expect(anyRequestContains(fixture, EMPTY_TURN_NUDGE_PHRASE)).toBe(false)
			trace.step("token acknowledgement hidden, recovery ended")

			// Inject the background-agent-style result with NO intervening user
			// input or tool call: the nudge-waiter fixture extension's alt+q
			// shortcut delivers an extension-sourced turn — the exact path stale
			// recovery state used to blank (neither the input handler's reset
			// nor recordToolCall runs to clear it).
			const nudgeRequestCount = countRequestsContaining(fixture, CONTINUATION_NUDGE_PHRASE)
			terminal.keyPress("q", { alt: true })
			await waitForText(terminal, "build passed", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			// The extension-triggered response streams visibly and is not
			// drift-nudged itself.
			expect(countRequestsContaining(fixture, CONTINUATION_NUDGE_PHRASE)).toBe(nudgeRequestCount)
			trace.step("extension-triggered turn streams visibly without a new nudge")
		},
	)
})
