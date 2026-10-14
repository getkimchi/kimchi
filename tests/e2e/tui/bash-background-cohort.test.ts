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

test("background bash cohort: filtered inspection returns only the selected handle; a stop-only call needs no wait", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-background-cohort-filtered-inspection-stop-only",
			responses: [
				// Turn 1: two long commands with distinct echo output (both hand
				// off after ~2s).
				{
					stream: ["Starting two long commands."],
					toolCalls: [
						{
							id: "call_bash_a",
							index: 0,
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "sleep 3 && echo one-alive && sleep 90" }),
							},
						},
						{
							id: "call_bash_b",
							index: 1,
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "sleep 3 && echo two-alive && sleep 90" }),
							},
						},
					],
				},
				// Turn 2: a filtered inspection of ONE handle (the most recent = b).
				{
					stream: ["Inspecting just the second command.", "Reading its fresh output."],
					textDelayMs: 1200,
					toolCalls: [
						{
							id: "call_inspect_one",
							function: {
								name: "bash_control",
								arguments: JSON.stringify({ handles: ["__BASH_HANDLE__"] }),
							},
						},
					],
				},
				// Turn 3: the whole cohort (omission keeps cohort-wide inspection).
				{
					stream: ["Now inspecting the whole cohort."],
					toolCalls: [
						{
							id: "call_inspect_all",
							function: { name: "bash_control", arguments: JSON.stringify({ wait: false }) },
						},
					],
				},
				// Turn 4: a stop-only call for BOTH handles — no `wait` needed.
				{
					stream: ["Stopping both commands."],
					toolCalls: [
						{
							id: "call_stop",
							function: {
								name: "bash_control",
								arguments: JSON.stringify({
									stop_handles: ["__BASH_HANDLE__", "__BASH_HANDLE_2__"],
								}),
							},
						},
					],
				},
				// Turn 5: finish.
				{
					stream: ["Done — both commands reported and stopped."],
				},
			],
		},
		async (fixture, trace) => {
			terminal.submit("Start two long commands, inspect just the second, then the whole cohort, then stop both")

			await waitForText(terminal, "Stopping both commands", { timeoutMs: STREAM_TIMEOUT_MS * 3 })
			trace.step("filtered + cohort inspections done; stopping both")
			await waitForText(terminal, "both commands reported and stopped", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("session completed")

			await waitForTurnToSettle(fixture.fake.requests)
			// Isolate each tool result from the FINAL request's history by
			// tool_call_id (earlier requests repeat the same messages).
			const lastMessages =
				(
					fixture.fake.requests
						.filter((request) =>
							(request.body as { messages?: Array<{ tool_call_id?: string }> } | undefined)?.messages?.some(
								(message) => message.tool_call_id === "call_stop",
							),
						)
						.at(-1)?.body as { messages?: Array<Record<string, unknown>> } | undefined
				)?.messages ?? []
			const toolText = (id: string): string => {
				const message = lastMessages.find((m) => m.role === "tool" && m.tool_call_id === id)
				return typeof message?.content === "string" ? message.content : JSON.stringify(message?.content ?? "")
			}
			// The filtered inspection reported ONLY the selected handle: its
			// fresh output arrived, the unselected command's cursor was preserved
			// (its output stayed unseen).
			expect(toolText("call_inspect_one")).toContain("two-alive")
			expect(toolText("call_inspect_one")).not.toContain("one-alive")
			expect(toolText("call_inspect_one")).toContain("Inspection of 1 background bash process")
			// The cohort-wide inspection (omission) then delivered the unselected
			// command's still-unseen output.
			expect(toolText("call_inspect_all")).toContain("one-alive")
			expect(toolText("call_inspect_all")).toContain("Inspection of 2 background bash processes")
			// The stop-only call (no `wait`) stopped both without a schema error;
			// neither command's already-delivered output was repeated (both say
			// "no further output" — the echo texts appear only in the command
			// summaries, never as repeated output).
			expect(toolText("call_stop").match(/stopped on request/g)?.length).toBe(2)
			expect(toolText("call_stop").match(/The process produced no further output\./g)?.length).toBe(2)
			expect(toolText("call_stop")).not.toContain("Final output:")
			expect(toolText("call_stop")).not.toContain("Error:")
			// Nothing unresolved remained: no completion demand fired.
			expect(JSON.stringify(lastMessages)).not.toContain("Task completion requires a disposition")
			trace.step("filtered inspection preserved cursors; stop-only needed no wait")
		},
	)
})

test("background bash cohort: a queued completion reminder is suppressed when the process is stopped first", async ({
	terminal,
}) => {
	// Stopping with a reminder backlog: the model ends its turn while a
	// process runs (one completion reminder queues behind the user's
	// steering), the steering-driven turn stops the process, and the stale
	// reminder is REPLACED at consumption — the provider never sees a demand.
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-background-cohort-reminder-backlog",
			responses: [
				// Turn 1: a long silent command.
				{
					stream: ["Starting the long command."],
					toolCalls: [
						{
							id: "call_bash",
							function: { name: "bash", arguments: JSON.stringify({ command: "sleep 120" }) },
						},
					],
				},
				// Turn 2: the model tries to finish with the work unresolved. The
				// slow stream gives the test time to queue steering ahead of the
				// reminder.
				{
					stream: ["I believe the work is complete.", "Nothing further is needed from my side."],
					textDelayMs: 700,
				},
				// Turn 3: responding to the steering — stop the process (stop-only).
				{
					stream: ["Right, stopping the background command instead."],
					toolCalls: [
						{
							id: "call_stop",
							function: {
								name: "bash_control",
								arguments: JSON.stringify({ stop_handles: ["__BASH_HANDLE__"] }),
							},
						},
					],
				},
				// Turn 4: the model finishes — everything is resolved now.
				{
					stream: ["The command is stopped; the task is complete."],
				},
				// Turn 5: the drained (replaced) reminder continues the run once
				// more; nothing remains unresolved, so it settles here.
				{
					stream: ["Everything is finished."],
				},
			],
		},
		async (fixture, trace) => {
			terminal.submit("Start a long command, then finish the task")

			// While turn 2 is streaming, queue steering ahead of the completion
			// reminder (the loop consumes steering before follow-ups).
			await waitForText(terminal, "I believe the work is complete", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.submit("Actually, stop the background command")
			trace.step("steering queued ahead of the completion reminder")

			await waitForText(terminal, "The command is stopped; the task is complete", {
				timeoutMs: STREAM_TIMEOUT_MS * 2,
			})
			trace.step("steering-driven turn stopped the process")
			await waitForText(terminal, "Everything is finished", { timeoutMs: STREAM_TIMEOUT_MS * 3 })
			trace.step("session settled")

			await waitForTurnToSettle(fixture.fake.requests)
			const lastConversation = JSON.stringify(
				(
					fixture.fake.requests
						.filter((request) =>
							(request.body as { messages?: Array<{ tool_call_id?: string }> } | undefined)?.messages?.some(
								(message) => message.tool_call_id === "call_stop",
							),
						)
						.at(-1)?.body as { messages?: unknown[] } | undefined
				)?.messages ?? [],
			)
			const conversation = JSON.stringify(
				fixture.fake.requests.flatMap((r) => (r.body as { messages?: unknown[] } | undefined)?.messages ?? []),
			)
			// The stale reminder never demanded a disposition from the provider…
			expect(conversation).not.toContain("Task completion requires a disposition")
			// …it was replaced at consumption with the suppression note, exactly
			// once (counted in the final request — earlier requests repeat the
			// same history), and the stop was delivered.
			expect(lastConversation.match(/completion reminder was suppressed/g)?.length).toBe(1)
			expect(conversation).toContain("stopped on request")
			trace.step("stale reminder replaced; no disposition demand reached the provider")
		},
	)
})
