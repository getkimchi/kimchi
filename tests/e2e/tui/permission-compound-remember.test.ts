/**
 * E2E TUI regression: compound-bash "don't ask again" must stick across
 * argument variants — reproduces the colleague-reported "it asked me several
 * times for permission to cd to <project>" from the exported session
 * kimchi-session-2026-09-10…01a08aac (default mode, `cd <project> && helm …
 * 2>&1 | tail -N` compounds).
 *
 * Pre-fix (dfbba7d6^): remembering a compound stored only the FIRST segment's
 * scope (`cd src:*`), which matchBashRule's single-segment canonical gate can
 * never match against the two-segment command — so every helm compound
 * re-prompted, forever. b0dbd1a4 additionally makes the output-filter pipe
 * (`2>&1 | tail -N`) normalizable, so remembered head scopes match piped
 * reruns.
 *
 * Assertion design notes: the compound card is transient UI that the TUI
 * overdraws once an option is picked, so assertions on it must read the
 * screen WHILE the card is visible — counting header text in the final
 * buffer is unreliable by construction. The "no second prompt" half relies
 * on sequence reachability: the model's follow-up text cannot render while
 * a permission prompt would be blocking the tool call.
 */

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const MAIN_MODEL = {
	slug: "basic",
	displayName: "Fake Basic",
	provider: "ai-enabler",
	contextWindow: 200_000,
	maxTokens: 8192,
}

// Actual card copy from prompts.ts (promptForCompoundApproval).
const COMPOUND_CARD_HEADER = "The assistant wants to run a compound command with 2 subcommand(s):"
const COMPOUND_CARD_QUESTION = "Allow the assistant to run this?"
const REMEMBER_OPTION = "Allow all from now on"
const UNREMEMBERABLE_WARNING = "Can't remember some subcommands"

function bashToolCall(command: string) {
	return { function: { name: "bash", arguments: JSON.stringify({ command }) } }
}

test("default mode: remembered compound is not re-asked for arg variants (colleague repro)", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "permission-compound-remember",
			providerId: "kimchi-dev",
			models: [MAIN_MODEL],
			// `env` chain: later assignments win, so this overrides the fixture's
			// hardcoded KIMCHI_PERMISSIONS=yolo and lands the session in default mode.
			env: { KIMCHI_PERMISSIONS: "default" },
			seedHome(_homeDir, workDir) {
				mkdirSync(join(workDir, "src"), { recursive: true })
			},
			responses: [
				// Turn 1: main model issues the transcript-shaped compound.
				{
					stream: ["Checking helm history."],
					toolCalls: [bashToolCall("cd src && helm history postgresql -n console 2>&1 | tail -40")],
				},
				// Tool result returns (helm is not installed in the fixture, that is
				// fine — the permission decision happens before execution); the
				// model acknowledges.
				{ stream: ["History checked."] },
				// Turn 2: the SAME programs with different arguments — the shape the
				// colleague ran repeatedly (`helm history …`, args varying).
				{
					stream: ["Now the same query with different args."],
					toolCalls: [bashToolCall("cd src && helm history postgresql -n console --max 10 2>&1 | tail -25")],
				},
				{ stream: ["Variant done."] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Show helm history for postgresql")
			trace.step("submitted first prompt")

			await waitForText(terminal, REMEMBER_OPTION, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("compound permission card visible")

			// Card shape, read WHILE the card is on screen:
			// the compound header, the allow question, and — for a piped
			// compound — NO "can't remember" warning (tail filters normalize).
			const cardView = viewText(terminal)
			expect(cardView).toContain(COMPOUND_CARD_HEADER)
			expect(cardView).toContain(COMPOUND_CARD_QUESTION)
			expect(cardView).not.toContain(UNREMEMBERABLE_WARNING)
			trace.step("card header + question visible, no unrememberable warning")

			// Choose "Allow all from now on" (second option of the compound card).
			terminal.keyDown()
			terminal.submit("")
			trace.step("picked 'Allow all from now on'")

			// Follow-up text after the (expected 127) tool result — reachable ONLY
			// because the card was answered. This is the sequencing proof.
			await waitForText(terminal, "History checked.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("first compound executed")

			// Second turn: same programs, different args. The follow-up text
			// "Variant done." can only render if NO prompt blocked the tool call.
			terminal.submit("Same again, but limit output")
			trace.step("submitted second prompt")
			await waitForText(terminal, "Variant done.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("second compound executed without another prompt")

			// No compound card is on screen right now (the variant ran silently).
			expect(viewText(terminal)).not.toContain("The assistant wants to run a compound command")
			trace.step("no compound card visible after the arg variant")
		},
	)
})
