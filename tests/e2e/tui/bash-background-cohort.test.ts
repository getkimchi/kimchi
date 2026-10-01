import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// Human-designed workflow spec for the bounded background bash control.
// One workflow per test:
//   1. unattended exit wakes an idle agent; the survivor is stopped in one call
//   2. an exit landing mid-stream queues at a safe boundary — no interleaved
//      output, no duplicate turn, no orphaned result
//   3. an explicit bounded wait returns a checkpoint with evidence; the
//      silent command is then stopped
//   4. cancelling a wait (Escape) leaves the command alive — an inspection
//      confirms it, then it is stopped
// Abort-vs-shutdown semantics are covered at unit level in
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
								arguments: JSON.stringify({ command: "echo quick-done && sleep 6" }),
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

			// Both initial handoffs arrive (~2s): the bash calls resolve at the
			// bounded handoff window instead of blocking for the full runtimes.
			await waitForText(terminal, /Took 2\.\d+s/, { timeoutMs: STREAM_TIMEOUT_MS * 2 })
			trace.step("initial background handoffs visible")

			// The quick command exits at ~6s: its exit notification must wake the
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
// completion continuation, producing an extra request).
test("background bash cohort: exit during streaming queues at a safe boundary, delivered exactly once", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-background-cohort-exit-while-streaming",
			responses: [
				// Turn 1: start a command that exits at ~5s, a few seconds past
				// the ~2s initial handoff.
				{
					stream: ["Starting a short-lived command."],
					toolCalls: [
						{
							id: "call_bash_quick",
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "echo quick-done && sleep 5" }),
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

			// The initial handoff arrives (~2s); the long stream starts after.
			await waitForText(terminal, /Took 2\.\d+s/, { timeoutMs: STREAM_TIMEOUT_MS * 2 })
			trace.step("initial background handoff visible")

			// The slow stream completes intact — the exit notification queued
			// behind it instead of interleaving.
			await waitForText(terminal, "segment 40 of 40", { timeoutMs: STREAM_TIMEOUT_MS * 3 })
			trace.step("long stream completed intact")

			// The queued notification drives the next turn.
			await waitForText(terminal, "exited while I was drafting", { timeoutMs: STREAM_TIMEOUT_MS * 2 })
			trace.step("queued exit notification delivered after the safe boundary")

			// Exactly-once: the final accumulated history carries the exit
			// notification exactly once, and no completion continuation fired
			// (an orphaned result would leave the handle tracked). The recorded
			// request count includes retries, so assert on message content
			// instead of totals.
			await waitForTurnToSettle(fixture.fake.requests)
			const history = JSON.stringify(
				fixture.fake.requests.flatMap((r) => (r.body as { messages?: unknown[] } | undefined)?.messages ?? []),
			)
			expect(history.split("[Background bash process ended").length - 1).toBe(1)
			expect(history).not.toContain("Task completion requires a disposition")
			trace.step("exactly-once delivery confirmed")
		},
	)
})

// An explicit bounded wait with a short requested duration returns a
// checkpoint with evidence (requested vs waited time, runtime, output age,
// checkpoint streak, remaining safety budget) — the wait does not stop the
// process; the model decides to stop it after reassessing.
test("background bash cohort: a short bounded wait checkpoints with evidence, then the command is stopped", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-background-cohort-short-checkpoint",
			responses: [
				// Turn 1: start a long, silent command (~2s handoff; with the
				// requested 5s wait the first checkpoint lands ~7s after spawn).
				{
					stream: ["Starting a long silent command."],
					toolCalls: [
						{
							id: "call_bash_waited",
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "sleep 120" }),
							},
						},
					],
				},
				// Turn 2: the model has no other work and blocks with a short
				// bounded wait.
				{
					stream: ["Nothing else to do; waiting briefly."],
					toolCalls: [
						{
							id: "call_wait",
							function: {
								name: "bash_control",
								arguments: JSON.stringify({
									wait: true,
									waitSeconds: 5,
								}),
							},
						},
					],
				},
				// Turn 3 (after the checkpoint): reassess and stop the command.
				{
					stream: ["The checkpoint arrived; stopping the silent command."],
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
				{ stream: ["Done after the checkpoint."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Run a long silent command, wait briefly, then stop it")

			// The initial handoff arrives (~2s).
			await waitForText(terminal, /Took 2\.\d+s/, { timeoutMs: STREAM_TIMEOUT_MS * 2 })
			trace.step("initial background handoff visible")

			// The bounded wait returns at its 5s checkpoint (not the 300s
			// default); the scripted stop call proves the wait returned.
			await waitForText(terminal, "checkpoint arrived", { timeoutMs: STREAM_TIMEOUT_MS * 2 })
			trace.step("short bounded wait checkpointed")

			// The model finishes after stopping the process.
			await waitForText(terminal, "Done after the checkpoint", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("session completed")

			// Channel-aware delivery assertions: the checkpoint evidence came
			// INSIDE the wait's tool result (role tool) — requested vs waited
			// time, the checkpoint streak, and reassessment guidance. The
			// command stayed alive through the checkpoint (the stop, not the
			// checkpoint, ended it), and nothing stayed tracked, so no
			// completion continuation fired.
			await waitForTurnToSettle(fixture.fake.requests)
			const messages = fixture.fake.requests.flatMap(
				(r) => (r.body as { messages?: { role?: string; content?: unknown }[] } | undefined)?.messages ?? [],
			)
			const textOf = (content: unknown): string => (typeof content === "string" ? content : JSON.stringify(content))
			const contains = (needle: string, role?: string) =>
				messages.some((m) => textOf(m.content).includes(needle) && (role === undefined || m.role === role))
			expect(contains("Wait checkpoint: requested 5s", "tool")).toBe(true)
			expect(contains("Consecutive wait checkpoints: 1", "tool")).toBe(true)
			expect(contains("Reassess the runtime against the expected duration", "tool")).toBe(true)
			// The stop (not the checkpoint) ended the process: the terminal
			// result says "stopped on request".
			expect(contains("stopped on request", "tool")).toBe(true)
			expect(contains("Task completion requires a disposition")).toBe(false)
			trace.step("checkpoint evidence came through the wait, command stopped explicitly")
		},
	)
})

// A bounded wait returns at its checkpoint with the command still alive —
// a user message queued DURING the wait is processed at the next safe
// boundary, an inspection confirms the command is alive with evidence,
// and it is stopped explicitly. (Interrupting a wait mid-call via the
// terminal's interrupt key is not reachable from the tui-test harness in
// this environment — the abort contract, wait cancelled with the cohort
// alive and no streak changes, is covered at unit level in
// bash-control-tool.test.ts and bash-control-extension.test.ts.)
test("background bash cohort: a checkpoint leaves the command alive; queued input is processed, then inspection and stop", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-background-cohort-checkpoint-alive-inspect-stop",
			responses: [
				// Turn 1: start a long-running command.
				{
					stream: ["Starting a long command."],
					toolCalls: [
						{
							id: "call_bash",
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "echo alive && sleep 90" }),
							},
						},
					],
				},
				// Turn 2: the model blocks with a bounded wait — the test queues a
				// user message while it is pending.
				{
					stream: ["Nothing else to do; waiting briefly."],
					toolCalls: [
						{
							id: "call_wait",
							function: {
								name: "bash_control",
								arguments: JSON.stringify({
									wait: true,
									waitSeconds: 10,
								}),
							},
						},
					],
				},
				// Turn 3 (the wait checkpointed with the command still running): the
				// model inspects the cohort.
				{
					stream: ["The checkpoint arrived; inspecting the cohort."],
					toolCalls: [
						{
							id: "call_inspect",
							function: {
								name: "bash_control",
								arguments: JSON.stringify({ wait: false }),
							},
						},
					],
				},
				// Turn 4: the command is alive; stop it.
				{
					stream: ["Still running; stopping it."],
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
				// Turn 5: the model finishes with everything resolved.
				{ stream: ["Done — the command was alive and is now stopped."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Run a long command and wait for it; I will chime in meanwhile")

			// The initial handoff arrives (~2s).
			await waitForText(terminal, /Took 2\.\d+s/, { timeoutMs: STREAM_TIMEOUT_MS * 2 })
			trace.step("initial background handoff visible")

			// While the bounded wait is pending, queue a user message — it must
			// be processed at the next safe boundary, not lost.
			await waitForText(terminal, "Nothing else to do; waiting briefly", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.submit("While it waits: check the command and stop it")
			trace.step("user message queued during the wait")

			// The wait checkpoints (~12s after spawn) with the command alive.
			await waitForText(terminal, "inspecting the cohort", { timeoutMs: STREAM_TIMEOUT_MS * 3 })
			trace.step("checkpoint returned with the command alive")

			// The queued message is processed at the safe boundary; the command
			// is confirmed alive and stopped.
			await waitForText(terminal, "Still running; stopping it", { timeoutMs: STREAM_TIMEOUT_MS * 3 })
			trace.step("command confirmed alive and stopped")
			await waitForText(terminal, "the command was alive and is now stopped", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("session completed")

			// The checkpoint and the inspection both reached the model; the
			// checkpoint did not kill the process (the inspection saw it running)
			// and the stop ended it. The queued user message was delivered
			// exactly once.
			await waitForTurnToSettle(fixture.fake.requests)
			const messages = fixture.fake.requests.flatMap(
				(r) => (r.body as { messages?: { role?: string; content?: unknown }[] } | undefined)?.messages ?? [],
			)
			const textOf = (content: unknown): string => (typeof content === "string" ? content : JSON.stringify(content))
			const contains = (needle: string, role?: string) =>
				messages.some((m) => textOf(m.content).includes(needle) && (role === undefined || m.role === role))
			expect(contains("Wait checkpoint: requested 10s", "tool")).toBe(true)
			expect(contains("Inspection of 1 background bash process", "tool")).toBe(true)
			expect(contains("Running:", "tool")).toBe(true)
			expect(contains("While it waits: check the command and stop it", "user")).toBe(true)
			expect(contains("stopped on request", "tool")).toBe(true)
			expect(contains("Task completion requires a disposition")).toBe(false)
			// 5 LLM requests: spawn, wait, inspection, stop, final.
			expect(fixture.fake.requests.length).toBeGreaterThanOrEqual(5)
		},
	)
})
