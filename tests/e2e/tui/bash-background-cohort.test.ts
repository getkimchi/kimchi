import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// Group control workflows. Automatic exit delivery is covered in the stacked delivery MR.

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
