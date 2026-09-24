/**
 * E2E TUI test for the pi-coding-agent user-message pre-render patch
 * (patches/@earendil-works__pi-coding-agent@0.85.1.patch): the submitted
 * prompt must render WHILE before_agent_start hooks are still running —
 * not only after they resolve — and exactly once, with the response
 * arriving after the hooks.
 *
 * The workdir is seeded with a slow project extension (a 2s
 * before_agent_start sleep) standing in for the memory retrieval's
 * gateway round-trips. An unpatched build cannot show the prompt before
 * the hooks resolve, so the pre-render budget is the regression signal.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { viewText, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/** The slow hook's sleep — comfortably above the unpatched render floor. */
const SLOW_HOOK_MS = 2_000
/**
 * The prompt must appear within this window: far above the patched build's
 * ~100ms render, far below the 2s+ an unpatched build needs (hooks block
 * the render entirely until they resolve).
 */
const PRERENDER_BUDGET_MS = 1_500
const PROMPT = "prerender probe: make tea, not war"
const REPLY = "Slow hook finished; reply served."

/** A pi extension whose before_agent_start sleeps, standing in for the
 * memory lookup's sequential gateway embedding round-trips. */
const SLOW_HOOK_EXTENSION = `export default function slowBeforeAgentStart(pi) {
	pi.on("before_agent_start", async () => {
		await new Promise((resolve) => setTimeout(resolve, ${SLOW_HOOK_MS}))
		return undefined
	})
}
`

test("the submitted prompt renders while before_agent_start hooks are still running", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "prompt-renders-during-slow-hooks",
			responses: [{ stream: [REPLY] }],
			trustWorkDir: true,
			seedHome(_homeDir, workDir) {
				const extDir = join(workDir, ".kimchi", "extensions")
				mkdirSync(extDir, { recursive: true })
				writeFileSync(join(extDir, "slow-before-agent-start.js"), SLOW_HOOK_EXTENSION)
			},
		},
		async (fixture, trace) => {
			terminal.submit(PROMPT)

			// The hook sleeps 2s from the moment the prompt is submitted; the
			// prompt must already be on screen during that window. Without the
			// pre-render patch this wait times out at 1.5s.
			await waitForText(terminal, PROMPT, { timeoutMs: PRERENDER_BUDGET_MS, full: false })
			trace.step("prompt rendered while the before_agent_start hook was still running")

			// The response can only arrive after the hook resolves.
			await waitForText(terminal, REPLY)
			trace.step("response arrived after the slow hook completed")
			await waitForTurnToSettle(fixture.fake.requests)

			// The prompt rendered exactly once in the current view — the
			// loop's duplicate message_start must stay suppressed. (The
			// earlier wait already proves presence; scrolling the bubble out
			// of view is not a failure, duplication to 2+ is.)
			const occurrences = viewText(terminal).split(PROMPT).length - 1
			expect(occurrences).toBeLessThanOrEqual(1)
			trace.step("prompt rendered exactly once")
		},
	)
})
