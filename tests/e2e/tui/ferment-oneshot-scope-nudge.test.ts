/**
 * E2E TUI test: --ferment-oneshot does not die on a text-only stop during
 * draft scoping.
 *
 * Before the fix, `shouldSuppressHiddenNudge` returned `true` for any
 * `action.kind === "scope"` regardless of continuation policy. In one-shot
 * (automated) mode the reactive continuation nudge is the only thing keeping
 * the session alive when the model emits a text-only stop during draft
 * scoping — suppressing it ended the run with the ferment never scoped. This
 * test reproduces that exact stall and asserts the harness injects a
 * `ferment_continuation_nudge` (visible as the scope action line) and
 * continues into a follow-up turn instead of terminating.
 */

import { expect, test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("--ferment-oneshot injects a scope continuation nudge after a text-only stop during draft scoping", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-oneshot-scope-nudge",
			gitInit: true,
			extraArgs: ["--ferment-oneshot=true"],
			// Response 1: text-only stop (no tool calls) — the exact stall pattern.
			// Response 2: a benign follow-up so the continuation turn has content.
			responses: [
				{ stream: ["I'll start by gathering the requirements for this task.\n"] },
				{ stream: ["Calling propose_ferment_scoping now.\n"] },
			],
		},
		async (fixture, trace) => {
			// Stage 1: ready prompt.
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			// Stage 2: submit a request — this bootstraps a draft ferment under
			// automated policy in oneshot mode.
			terminal.submit("Build a hello-world CLI")
			trace.step("submitted oneshot request — draft ferment bootstrapped")

			// Stage 3: the first (text-only) response streams out.
			await waitForText(terminal, "gathering the requirements", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("text-only stop response streamed")

			// Stage 4: the reactive continuation nudge has display:false, so it is
			// not visible in the terminal — but it triggers a follow-up turn. The
			// proof of continuation is the second (scripted) response streaming
			// into the terminal. Before the fix, the scope nudge was suppressed and
			// the session terminated after the first text-only stop, so this text
			// would never appear.
			await waitForText(terminal, "propose_ferment_scoping now", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("follow-up turn executed — scope nudge was not suppressed")

			// Stage 5: assert the fake server received at least two POST completion
			// requests — the initial turn plus the nudge-triggered follow-up.
			// (Before the fix, suppression ended the run after one request.)
			// We count POSTs to /chat/completions specifically, since the fake also
			// records the model-metadata GET and the title-generation POST.
			const chatPosts = fixture.fake.requests.filter((r) => r.method === "POST" && r.url.includes("/chat/completions"))
			expect(chatPosts.length).toBeGreaterThanOrEqual(2)
			trace.step("two chat-completion POSTs recorded — continuation confirmed")
		},
	)
})
