import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("background bash cohort: filtered inspection keeps a queued exit pending until delivery", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-background-cohort-filtered-pending-exit",
			responses: [
				{
					toolCalls: [
						{
							id: "spawn",
							function: { name: "bash", arguments: JSON.stringify({ command: "sleep 6 && echo queued-output" }) },
						},
					],
				},
				{ stream: Array.from({ length: 10 }, (_, i) => `Drafting section ${i + 1}. `), textDelayMs: 800 },
				{
					toolCalls: [
						{
							id: "inspect",
							function: { name: "bash_control", arguments: JSON.stringify({ handles: ["__BASH_HANDLE__"] }) },
						},
					],
				},
				{ stream: ["The inspected exit was pending and has now been delivered."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Run a command and draft while it finishes")
			await waitForText(terminal, "Drafting section 1", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.submit("Inspect just the command before continuing")
			trace.step("inspection steering queued before the exit notice")
			await waitForText(terminal, "has now been delivered", { timeoutMs: STREAM_TIMEOUT_MS * 3 })
			await waitForTurnToSettle(fixture.fake.requests)
			const messages =
				(
					fixture.fake.requests.filter((request) => request.url.endsWith("/chat/completions")).at(-1)?.body as
						| { messages?: Array<Record<string, unknown>> }
						| undefined
				)?.messages ?? []
			const inspection = messages.find((message) => message.role === "tool" && message.tool_call_id === "inspect")
			expect(String(inspection?.content)).toContain("not yet acknowledged")
			expect(String(inspection?.content)).not.toContain("Unknown handle")
			expect(JSON.stringify(messages).split("[Background bash process ended").length - 1).toBe(1)
			trace.step("filtered inspection reported pending; terminal outcome delivered once")
		},
	)
})

// Human-designed workflow spec for the bounded background bash control.
// One workflow per test:
//   1. unattended exit wakes an idle agent; the survivor is stopped in one call
//   2. an exit landing mid-stream queues at a safe boundary — no interleaved
//      output, no duplicate turn, no orphaned result
//   3. an explicit bounded wait returns a checkpoint with evidence; the
//      silent command is then stopped
//   4. cancelling a wait (Escape) leaves the command alive — an inspection
//      confirms it, then it is stopped
//   5. an unattended exit during continued independent tool work reaches the
//      NEXT request without a tool-free stop — the model acts on it and
//      settles
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
				// the initial handoff (2s under the e2e fixture).
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
				// Turn 1: start a long, silent command (2s e2e handoff; with the
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

// A user message queued DURING a bounded wait RELEASES it (user-facing
// session): the wait returns the distinct user-input result with the cohort
// alive, the message reaches the model at the next safe boundary, an
// inspection confirms the command is alive with evidence, and it is stopped
// explicitly. (Interrupting a wait mid-call via the terminal's interrupt key
// is not reachable from the tui-test harness in this environment — the abort
// contract, wait cancelled with the cohort alive and no streak changes, is
// covered at unit level in bash-control-tool.test.ts and
// bash-control-extension.test.ts.)
test("background bash cohort: a user message releases the wait; the command stays alive and is stopped", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-background-cohort-user-input-releases-wait",
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
				// Turn 2: the model blocks with a long bounded wait — only the queued
				// user message can release it this early (60s outlives the scenario).
				{
					stream: ["Nothing else to do; waiting briefly."],
					toolCalls: [
						{
							id: "call_wait",
							function: {
								name: "bash_control",
								arguments: JSON.stringify({
									wait: true,
									waitSeconds: 60,
								}),
							},
						},
					],
				},
				// Turn 3 (the wait was RELEASED by the user's message): the model acts
				// on it and inspects the cohort.
				{
					stream: ["The user asked; inspecting the cohort."],
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
			// release the wait and reach the model, not sit behind the timer.
			await waitForText(terminal, "Nothing else to do; waiting briefly", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.submit("While it waits: check the command and stop it")
			trace.step("user message queued during the wait")

			// The wait was released by the message (far before its 60s checkpoint).
			await waitForText(terminal, "inspecting the cohort", { timeoutMs: STREAM_TIMEOUT_MS * 3 })
			trace.step("wait released by the user message; cohort inspected")

			// The queued message is processed at the safe boundary; the command
			// is confirmed alive and stopped.
			await waitForText(terminal, "Still running; stopping it", { timeoutMs: STREAM_TIMEOUT_MS * 3 })
			trace.step("command confirmed alive and stopped")
			await waitForText(terminal, "the command was alive and is now stopped", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("session completed")

			// The release and the inspection both reached the model; the release
			// did not kill the process (the inspection saw it running) and the
			// stop ended it. The queued user message was delivered exactly once.
			await waitForTurnToSettle(fixture.fake.requests)
			const messages = fixture.fake.requests.flatMap(
				(r) => (r.body as { messages?: { role?: string; content?: unknown }[] } | undefined)?.messages ?? [],
			)
			const textOf = (content: unknown): string => (typeof content === "string" ? content : JSON.stringify(content))
			const contains = (needle: string, role?: string) =>
				messages.some((m) => textOf(m.content).includes(needle) && (role === undefined || m.role === role))
			expect(contains("Wait released: a message from the user is waiting.", "tool")).toBe(true)
			expect(contains("Handle the user's message now", "tool")).toBe(true)
			// The wait ended on the user's message, not its timer: no checkpoint
			// response, no streak increment, no reassessment guidance.
			expect(contains("Wait checkpoint:", "tool")).toBe(false)
			expect(contains("Reassess the runtime", "tool")).toBe(false)
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

// The user-facing nonblocking-bash workflow: a message sent during a long
// control wait reaches the agent immediately (releasing the wait), the agent
// answers and settles with the command still running — no forced re-wait or
// stop reminder — and the later completion notification wakes the idle agent
// and delivers the exit result exactly once. The completion-reminder seam is
// pinned near zero so a regression to forced reminders fires within the
// settle window instead of after 30s.
test("background bash cohort: user message interrupts the wait; the turn settles alive and the exit wakes the agent", async ({
	terminal,
}) => {
	const EXIT_MARKER = "COHORT-WAKE-DONE-8c3f"
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-background-cohort-user-interrupt-settle-wake",
			env: { KIMCHI_E2E_COMPLETION_REMINDER_MS: "1" },
			responses: [
				// Turn 1: start a command that outlives the whole chat exchange.
				{
					stream: ["Starting a long command."],
					toolCalls: [
						{
							id: "call_bash",
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: `sleep 25 && echo "COHORT-WAKE-"DONE-8c3f` }),
							},
						},
					],
				},
				// Turn 2: nothing else to do — enter a long bounded wait (only the
				// user's message releases it early).
				{
					stream: ["Nothing else to do; waiting."],
					toolCalls: [
						{
							id: "call_wait",
							function: {
								name: "bash_control",
								arguments: JSON.stringify({ wait: true, waitSeconds: 120 }),
							},
						},
					],
				},
				// Turn 3 (the wait released by the question; the steering is consumed
				// at the boundary): answer it and end the turn — the command keeps
				// running. The TUI's stop-nudge follows the tool-free answer;
				// acknowledge it with <done> so the run settles cleanly.
				{ stream: ["2+2 is 4."] },
				{ stream: ["<done>"] },
				// The exit notification wakes the idle agent: wrap up (and
				// acknowledge the stop-nudge again).
				{ stream: ["The background command finished."] },
				{ stream: ["<done>"] },
				// Spare acknowledgement in case the exploration guard nudges the
				// tool-free exchange.
				{ stream: ["<done>"] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Run a long command, then wait for it to finish")

			// While the wait is active, ask an unrelated question — the wait
			// must release so the answer arrives long before the command ends.
			await waitForText(terminal, "Nothing else to do; waiting", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.submit("Quick question while it runs: what is 2+2?")
			trace.step("user question queued during the wait")

			await waitForText(terminal, "2+2 is 4", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("wait released; the answer arrived while the command runs")

			// The answering turn settles with the command alive: no forced
			// re-wait, no stop reminder. The answer request (the one carrying the
			// wait-release tool result and the user's steering) saw the question
			// but not the exit output — the command is still running. Located by
			// content: side traffic (titles, classifier probes) shares the prompt
			// text, so indices are not stable.
			await waitForTurnToSettle(fixture.fake.requests)
			const bodyOf = (r: { body?: unknown }) => JSON.stringify(r.body ?? {})
			const conversation = fixture.fake.requests.map(bodyOf).join("\n")
			const answerRequest = fixture.fake.requests.find((r) =>
				bodyOf(r).includes("Wait released: a message from the user is waiting."),
			)
			expect(answerRequest).toBeTruthy()
			const answerBody = bodyOf(answerRequest as unknown as { body?: unknown })
			expect(answerBody).toContain("what is 2+2")
			expect(answerBody).not.toContain(EXIT_MARKER)
			// User-facing session: no forced wait/stop reminder anywhere.
			expect(conversation).not.toContain("Task completion requires a disposition")
			const settledRequestCount = fixture.fake.requests.length
			trace.step("answering turn settled with the command alive")

			// Idle window: with the reminder seam at ~0ms, a regression that
			// forces a wait/stop reminder would issue a new request at once.
			await new Promise((resolve) => setTimeout(resolve, 4000))
			expect(fixture.fake.requests.length).toBe(settledRequestCount)
			trace.step("idle chat without a forced re-wait")

			// The command exits; its notification wakes the idle agent.
			await waitForText(terminal, "The background command finished", { timeoutMs: STREAM_TIMEOUT_MS * 3 })
			trace.step("completion notification woke the agent")

			// Exactly-once delivery: the exit result appears once — in the wake
			// request (the first one carrying the exit notification), after the
			// settled answering turn.
			await waitForTurnToSettle(fixture.fake.requests)
			const allRequests = fixture.fake.requests
			const wakeRequest = allRequests.find((r) => bodyOf(r).includes("[Background bash process ended"))
			expect(wakeRequest).toBeTruthy()
			const wakeBody = bodyOf(wakeRequest as unknown as { body?: unknown })
			expect(wakeBody).toContain(EXIT_MARKER)
			expect(wakeBody.split("[Background bash process ended").length - 1).toBe(1)
			// The wake came after the settled answering turn, and the exit
			// notification is present in the conversation history from the wake
			// on (later requests replay it — the exactly-once check is the
			// per-request count in wakeBody above).
			expect(allRequests.length).toBeGreaterThan(settledRequestCount)
			expect(
				allRequests.filter((r) => bodyOf(r).includes("[Background bash process ended")).length,
			).toBeGreaterThanOrEqual(1)
			expect(allRequests.map(bodyOf).join("\n")).not.toContain("Task completion requires a disposition")
			trace.step("exit delivered once through the completion notification")
		},
	)
})

// The starvation regression as a user workflow: a command exits unattended
// after its handoff while the model keeps doing independent read work. The
// terminal marker is emitted AT exit (well after the handoff window), so the
// initial handoff result cannot already contain it. With steering delivery
// the notification reaches the NEXT request — the model acts on the marker
// and settles WITHOUT a tool-free stop in between. (With the old followUp
// delivery the marker stayed invisible through every tool-bearing request;
// it surfaced only after a tool-free stop, so this workflow could not pass.)
test("background bash cohort: unattended exit during continued tool work reaches the next request and settles", async ({
	terminal,
}) => {
	// The marker is emitted at process exit (~6s), past the 2s e2e handoff — and
	// assembled by the shell at runtime, so no request history can contain
	// it before the exit output is delivered. The wider fake context keeps
	// this multi-turn workflow from tripping the tiny default window's
	// auto-compaction (same pattern as ask-user-form.test.ts).
	const EXIT_MARKER = "COHORT-EXIT-MARKER-4d71"
	const NO_COMPACTION_MODEL = { slug: "basic", displayName: "Fake Basic", contextWindow: 200_000, maxTokens: 8192 }
	await runKimchiSession(
		terminal,
		{
			models: [NO_COMPACTION_MODEL],
			artifactName: "bash-background-cohort-exit-during-tool-work",
			responses: [
				// Turn 1: start a command that exits unattended at ~6s, emitting
				// its unique terminal marker at exit. The echo argument is
				// quote-split so the command text itself NEVER contains the
				// assembled marker — searching request histories for the marker then
				// proves the DELIVERED OUTPUT arrived, not the echoed command.
				{
					stream: ["Starting the marker command."],
					toolCalls: [
						{
							id: "call_bash_marker",
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: `sleep 6 && echo "COHORT-EXIT-"MARKER-4d71` }),
							},
						},
					],
				},
				// Turn 2: independent read work while the command runs (~3s of
				// streamed text keeps this turn alive past the handoff).
				{
					stream: Array.from({ length: 6 }, (_, i) => `independent segment ${i + 1} of 6. `),
					textDelayMs: 500,
					toolCalls: [
						{
							id: "call_read_1",
							function: {
								name: "read",
								arguments: JSON.stringify({ path: "README.md" }),
							},
						},
					],
				},
				// Turn 3: more independent work (~5s) — the command exits unattended
				// during this turn, so its notification queues as steering for the
				// NEXT boundary (no tool-free stop is required).
				{
					stream: Array.from({ length: 8 }, (_, i) => `continued work segment ${i + 1} of 8. `),
					textDelayMs: 600,
					toolCalls: [
						{
							id: "call_read_2",
							function: {
								name: "read",
								arguments: JSON.stringify({ path: "README.md" }),
							},
						},
					],
				},
				// Turn 4: the model has seen the exit notification at the turn
				// boundary and acts on the terminal marker — no further tools.
				{ stream: [`The command finished with ${EXIT_MARKER}; all work is resolved.`] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Run the marker command and keep reading files until it finishes")

			// Independent work continues across the exit. The terminal wraps long
			// streamed paragraphs at arbitrary columns, so the segment waits use
			// newline-tolerant regexes (a wrap point can split any fixed phrase).
			await waitForText(terminal, /independent\s+segment\s+1\s+of\s+6/, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("independent read work started")
			await waitForText(terminal, /continued\s+work\s+segment\s+8\s+of\s+8/, { timeoutMs: STREAM_TIMEOUT_MS * 3 })
			trace.step("independent work continued across the exit")

			// The model acts on the terminal marker and settles.
			await waitForText(terminal, "all work is resolved", { timeoutMs: STREAM_TIMEOUT_MS * 2 })
			trace.step("model acted on the terminal marker and settled")

			// First-request visibility: the marker first appears in the request
			// AFTER the turn during which the exit landed — never in the
			// requests before the exit — and no extra tool-free stop was needed.
			// Only the main conversation's requests count: the fixture also
			// records side-channel completions (e.g. title generation on a
			// different model slug), which would skew request indices.
			await waitForTurnToSettle(fixture.fake.requests)
			const mainRequests = fixture.fake.requests.filter(
				(r) => (r.body as { model?: string } | undefined)?.model === "basic",
			)
			const requests = mainRequests.map((r) =>
				JSON.stringify((r.body as { messages?: unknown[] } | undefined)?.messages ?? []),
			)
			expect(requests.length).toBeGreaterThanOrEqual(4)
			const firstVisible = requests.findIndex((body) => body.includes(EXIT_MARKER))
			// The spawn and the two read turns precede the exit (~6s lands during
			// turn 3): the marker is first visible in the request that follows.
			expect(firstVisible).toBeGreaterThanOrEqual(1)
			expect(firstVisible).toBeLessThanOrEqual(3)
			for (let i = 0; i < firstVisible; i++) {
				expect(requests[i]).not.toContain(EXIT_MARKER)
			}
			// The run settled at the scripted final turn: no extra main-model
			// request followed the stop (a completion continuation or a leaked
			// steer would have produced one during the settle window).
			expect(requests.length).toBe(4)
			// Once-per-history payload presence: in the FINAL request's history
			// the exit notification appears exactly once, and no completion
			// continuation fired (the exit resolved the state by itself).
			const finalHistory = requests[requests.length - 1] ?? ""
			expect(finalHistory.split("[Background bash process ended").length - 1).toBe(1)
			expect(finalHistory).not.toContain("Task completion requires a disposition")
			trace.step("first-request visibility and exactly-once delivery confirmed")
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
				// off after 2s under the e2e fixture).
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

test("background bash cohort: stopping with unresolved work never queues a forced reminder (user-facing session)", async ({
	terminal,
}) => {
	// The TUI is a user-facing session: a stop with a live process queues NO
	// completion reminder at all — steering drives the next turn, the
	// steering-driven stop resolves the work, and the provider never sees a
	// disposition demand (nor a suppression note — nothing was ever queued).
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
				// slow stream gives the test time to queue steering before the
				// turn ends (no reminder queues behind it in a user-facing session).
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
				// Turn 4: the model finishes — everything is resolved now. The TUI's
				// stop-nudge follows the tool-free turn; acknowledge it with <done>.
				{ stream: ["The command is stopped; the task is complete."] },
				{ stream: ["<done>"] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Start a long command, then finish the task")

			// While turn 2 is streaming, queue steering (the loop consumes it at
			// the next boundary; no reminder competes with it).
			await waitForText(terminal, "I believe the work is complete", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.submit("Actually, stop the background command")
			trace.step("steering queued while the turn streams")

			await waitForText(terminal, "The command is stopped; the task is complete", {
				timeoutMs: STREAM_TIMEOUT_MS * 2,
			})
			trace.step("steering-driven turn stopped the process")

			await waitForTurnToSettle(fixture.fake.requests)
			const conversation = JSON.stringify(
				fixture.fake.requests.flatMap((r) => (r.body as { messages?: unknown[] } | undefined)?.messages ?? []),
			)
			// No forced reminder was ever queued: no disposition demand, and no
			// suppression note either — the user-facing session never queues one.
			expect(conversation).not.toContain("Task completion requires a disposition")
			expect(conversation).not.toContain("completion reminder was suppressed")
			expect(conversation).toContain("stopped on request")
			// The steering reached the model and the run settled on its own turns
			// (at least five conversation requests: spawn, stop attempt, steering
			// stop, final, stop-nudge acknowledgement; side traffic — e.g. the
			// title request — also carries the prompt text, so this is a floor).
			expect(
				fixture.fake.requests.filter((r) =>
					JSON.stringify((r.body as { messages?: unknown[] } | undefined)?.messages ?? []).includes(
						"Start a long command, then finish the task",
					),
				).length,
			).toBeGreaterThanOrEqual(5)
			trace.step("no reminder ever queued; the steering stop resolved the work")
		},
	)
})
