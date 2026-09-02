import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// Human-designed workflow spec for the cohort-based background bash monitor
// (plan chunk 8). One workflow per test:
//   1. unattended exit wakes an idle agent; the survivor is stopped in one call
//   2. an exit landing mid-stream queues at a safe boundary — no interleaved
//      output, no duplicate turn, no orphaned result
//   3. a due cohort review resolves an active bash_control(wait: true) instead
//      of spawning a separate review turn
// Abort-vs-shutdown semantics ("aborting a batch wait leaves the cohort alive;
// session shutdown kills it") are covered at unit level in
// src/extensions/bash-background/bash-control-tool.test.ts and
// process-registry.test.ts, where abort signals and registry shutdown are
// directly controllable.

test("background bash cohort: unattended exit wakes the agent; survivor stopped in one call", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-background-cohort-exit-wakes-agent",
			responses: [
				// Turn 1: the model starts two commands — one short-lived past the
				// handoff (exit notification expected), one long-lived survivor.
				{
					stream: ["Starting two background commands."],
					toolCalls: [
						{
							id: "call_bash_exit",
							index: 0,
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "echo quick-done && sleep 18" }),
							},
						},
						{
							id: "call_bash_stay",
							index: 1,
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "echo staying-alive && sleep 90" }),
							},
						},
					],
				},
				// Turn 2 (triggered by the unattended-exit notification while the
				// agent is idle): the model stops the surviving process.
				{
					stream: ["The quick command exited; stopping the survivor."],
					toolCalls: [
						{
							id: "call_stop",
							function: {
								name: "bash_control",
								arguments: JSON.stringify({
									stop_handles: ["__BASH_HANDLE__"],
									wait: false,
								}),
							},
						},
					],
				},
				// Turn 3: the model finishes with both processes resolved.
				{ stream: ["Cohort fully resolved."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Start two long commands; let one exit and stop the other")

			// Both initial handoffs arrive (~15s).
			await waitForText(terminal, "continues by default", { timeoutMs: STREAM_TIMEOUT_MS * 2 })
			trace.step("initial background handoffs visible")

			// The quick command exits at ~18s: its exit notification must wake the
			// idle agent into a new turn (the scripted stop call appears).
			await waitForText(terminal, "stopping the survivor", { timeoutMs: STREAM_TIMEOUT_MS * 2 })
			trace.step("unattended exit woke the idle agent")

			// The survivor was stopped; the session completes with everything resolved.
			await waitForText(terminal, "Cohort fully resolved", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("session completed with cohort resolved")

			// 3+ LLM requests: dual spawn, exit-notification turn, final.
			expect(fixture.fake.requests.length).toBeGreaterThanOrEqual(3)
		},
	)
})

// The quick command exits WHILE the follow-up response is still streaming.
// The exit notification must queue at a safe boundary: it must not clobber or
// interleave the in-flight stream, must not be delivered twice, and must not
// be orphaned (an orphaned result would leave the handle tracked and fire the
// completion guard, producing an extra request).
test("background bash cohort: exit during streaming queues at a safe boundary, delivered exactly once", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-background-cohort-exit-while-streaming",
			responses: [
				// Turn 1: start a command that exits at ~21s, a few seconds past
				// the ~15s initial handoff.
				{
					stream: ["Starting a short-lived command."],
					toolCalls: [
						{
							id: "call_bash_quick",
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "echo quick-done && sleep 21" }),
							},
						},
					],
				},
				// Turn 2: a long slow stream (~8s). The process exits mid-stream;
				// its notification must queue for the next safe boundary rather
				// than interrupting this stream.
				{
					stream: Array.from({ length: 40 }, (_, i) => `draft segment ${i + 1} of 40. `),
					textDelayMs: 200,
				},
				// Turn 3: driven by the queued exit notification.
				{ stream: ["The quick command exited while I was drafting."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Run a short command, keep talking while it exits")

			// The initial handoff arrives (~15s); the long stream starts after.
			await waitForText(terminal, "continues by default", { timeoutMs: STREAM_TIMEOUT_MS * 2 })
			trace.step("initial background handoff visible")

			// The slow stream completes intact — the exit notification queued
			// behind it instead of interleaving.
			await waitForText(terminal, "segment 40 of 40", { timeoutMs: STREAM_TIMEOUT_MS * 3 })
			trace.step("long stream completed intact")

			// The queued notification drives the next turn.
			await waitForText(terminal, "exited while I was drafting", { timeoutMs: STREAM_TIMEOUT_MS * 2 })
			trace.step("queued exit notification delivered after the safe boundary")

			// Exactly-once: the final accumulated history carries the exit
			// notification exactly once, and no completion-guard fired (an
			// orphaned result would leave the handle tracked). The recorded
			// request count includes title generation and retries, so assert
			// on message content instead of totals.
			await waitForTurnToSettle(fixture.fake.requests)
			const history = JSON.stringify(fixture.fake.requests.at(-1))
			expect(history.split("[Background bash process ended").length - 1).toBe(1)
			expect(history).not.toContain("Before finishing, resolve the background bash process")
			trace.step("exactly-once delivery confirmed")
		},
	)
})

// The due cohort review (60s after the first handoff) resolves the active
// `bash_control(wait: true)` with one consolidated snapshot — it must NOT also
// spawn a separate review turn.
test("background bash cohort: a due review resolves an active batch wait", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-background-cohort-review-resolves-wait",
			responses: [
				// Turn 1: start a long-running command (~15s handoff; first cohort
				// review lands ~60s later, so ~75s after spawn).
				{
					stream: ["Starting a long command."],
					toolCalls: [
						{
							id: "call_bash_waited",
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "echo waiting-room && sleep 180" }),
							},
						},
					],
				},
				// Turn 2: the model has no other work and blocks on one cohort wait.
				{
					stream: ["Nothing else to do; waiting for the next cohort event."],
					toolCalls: [
						{
							id: "call_wait",
							function: {
								name: "bash_control",
								arguments: JSON.stringify({ wait: true }),
							},
						},
					],
				},
				// Turn 3 (after the due review resolves the wait): stop the process.
				{
					stream: ["The scheduled review arrived in the batch wait; stopping it."],
					toolCalls: [
						{
							id: "call_stop",
							function: {
								name: "bash_control",
								arguments: JSON.stringify({
									stop_handles: ["__BASH_HANDLE__"],
									wait: false,
								}),
							},
						},
					],
				},
				// Turn 4: the model finishes with everything resolved.
				{ stream: ["Done after the scheduled review."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Run a long command, wait for a cohort event, then stop it")

			// The initial handoff arrives (~15s).
			await waitForText(terminal, "continues by default", { timeoutMs: STREAM_TIMEOUT_MS * 2 })
			trace.step("initial background handoff visible")

			// The batch wait blocks until the due cohort review (~75s) resolves
			// it; the scripted stop call proves the wait returned with a due review.
			await waitForText(terminal, "scheduled review arrived", { timeoutMs: STREAM_TIMEOUT_MS * 8 })
			trace.step("due review resolved the active batch wait")

			// The model finishes after stopping the process.
			await waitForText(terminal, "Done after the scheduled review", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("session completed")

			// Channel-aware delivery assertions: the review must arrive INSIDE
			// the wait's tool result (role tool), not as a standalone extension
			// message (role user) — the standalone wording is "review of 1
			// background bash process". No exit notification either: the stop
			// was owned by the control call, so the "[Background bash process
			// ended]" terminal text legitimately lives in its tool result but
			// must never surface as a notification message. Nothing stayed
			// tracked, so no completion-guard fired.
			await waitForTurnToSettle(fixture.fake.requests)
			const messages = fixture.fake.requests.flatMap(
				(r) => (r.body as { messages?: { role?: string; content?: unknown }[] } | undefined)?.messages ?? [],
			)
			const textOf = (content: unknown): string => (typeof content === "string" ? content : JSON.stringify(content))
			const contains = (needle: string, role?: string) =>
				messages.some((m) => textOf(m.content).includes(needle) && (role === undefined || m.role === role))
			expect(contains("Scheduled cohort review of all running background processes", "tool")).toBe(true)
			expect(contains("Scheduled cohort review of 1 background bash process", "user")).toBe(false)
			expect(contains("[Background bash process ended", "user")).toBe(false)
			expect(contains("Before finishing, resolve the background bash process")).toBe(false)
			trace.step("review came through the wait, not a dedicated turn")
		},
	)
})
