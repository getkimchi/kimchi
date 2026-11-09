import { expect, Key, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, viewText, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import type { FakeResponseScript } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const tool = (name: string, args: Record<string, unknown>): FakeResponseScript => ({
	toolCalls: [{ id: `call-${name}`, function: { name, arguments: JSON.stringify(args) } }],
})

const bash = (index: number): FakeResponseScript => tool("bash", { command: `printf 'input ${index} verified\\n'` })

for (const scenario of ["completed", "deferred", "ignored"] as const) {
	const deferred = scenario === "deferred"
	test(`one cleanup reminder handles ${scenario} work without looping`, async ({ terminal }) => {
		await runKimchiSession(
			terminal,
			{
				artifactName: `todo-cleanup-${scenario}`,
				models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 1_000_000, maxTokens: 4096 }],
				responses: [
					tool("todos", {
						todos: [
							{
								content: deferred ? "Publish after approval" : "Verify input",
								status: deferred ? "pending" : "in_progress",
							},
							{ content: "Collect results", status: "pending" },
							{ content: "Compare results", status: "pending" },
						],
					}),
					...Array.from({ length: 5 }, (_, index) => bash(index)),
					// The turn ends with a text-only answer while the list is
					// unreconciled: the bounded cleanup check fires once.
					{ stream: ["Comparison complete."] },
					...(scenario === "ignored"
						? [{ stream: ["Cleanup check finished."] } satisfies FakeResponseScript]
						: [
								tool("todos", {
									todos: [
										{
											id: 1,
											content: deferred ? "Publish after approval" : "Verify input",
											status: deferred ? "pending" : "in_progress",
										},
										{ id: 2, content: "Collect results", status: "completed" },
										{ id: 3, content: "Compare results", status: "pending" },
									],
								}),
								tool("todos", {
									todos: [
										{
											id: 1,
											content: deferred ? "Publish after approval" : "Verify input",
											status: deferred ? "pending" : "in_progress",
										},
										{ id: 2, content: "Collect results", status: "completed" },
										{ id: 3, content: "Compare results", status: "completed" },
									],
								}),
								tool("todos", {
									todos: [
										{
											id: 1,
											content: deferred ? "Publish after approval" : "Verify input",
											status: deferred ? "pending" : "completed",
											...(deferred ? { note: "Deferred until explicit approval" } : {}),
										},
										{ id: 2, content: "Collect results", status: "completed" },
										{ id: 3, content: "Compare results", status: "completed" },
									],
								}),
								{ stream: ["Cleanup check finished."] },
							]),
				],
			},
			async (fixture, trace) => {
				terminal.submit(
					deferred
						? "Compare the input; publishing is deferred until approval."
						: "Verify the input and compare results.",
				)
				await waitForText(terminal, "Cleanup check finished.", { timeoutMs: STREAM_TIMEOUT_MS })
				if (scenario === "completed") {
					const deadline = Date.now() + STREAM_TIMEOUT_MS
					// Ambient strip auto-hides when nothing is active; header ends with (F7 to …).
					while (viewText(terminal).includes("(F7 to ") && Date.now() < deadline)
						await new Promise((resolve) => setTimeout(resolve, 100))
					expect(viewText(terminal)).not.toContain("(F7 to ")
					terminal.submit("/todos")
					await waitForText(terminal, "3/3 ✓", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
				} else if (deferred) {
					// Deferred todo stays pending: no running segment, but the strip
					// stays open with the pending row.
					await waitForText(terminal, "Publish after approval", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
					expect(viewText(terminal)).toContain("2/3")
				} else {
					// Ignored dangling in_progress row stays visible — the agent loop
					// is done, so it renders as a static "in progress" segment rather
					// than a live "running" spinner.
					await waitForText(terminal, "1 in progress", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
					expect(viewText(terminal)).toContain("0/3")
				}
				const chat = fixture.fake.requests.filter((request) => request.url === "/openai/v1/chat/completions")
				// completed/deferred: create + 5 works + answer + 3 cleanup marks
				// + final answer = 11. ignored: no marks at all = 8.
				expect(chat).toHaveLength(scenario === "ignored" ? 8 : 11)
				expect(JSON.stringify(chat)).not.toContain("changes since last update")
				const body = chat[7].body as { messages: { role: string; content: unknown }[] }
				expect(JSON.stringify(body.messages)).toContain("The turn ended with unfinished todos")
				expect(JSON.stringify(body.messages)).toContain("Preserve deferred")
				trace.step("five work calls without stale reminders; one bounded cleanup at wrap-up")
			},
		)
	})
}

test("check-in gate: changed-direction input reconciles the list before work resumes", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "todo-checkin-direction-change",
			models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 1_000_000, maxTokens: 4096 }],
			responses: [
				// Turn 1: plan only. The todos write reconciles, so the
				// text-only answer needs no cleanup continuation.
				tool("todos", { todos: [{ content: "Publish after approval", status: "pending" }] }),
				{ stream: ["Publishing is deferred."] },
				// Turn 2 (new direction): reconcile first, then work, then ask.
				tool("todos", {
					todos: [
						{ id: 1, content: "Publish after approval", status: "in_progress", note: "Verifying before publish" },
					],
				}),
				tool("bash", { command: "printf '42\\n'" }),
				{ stream: ["Verified 42. Should I publish?"] },
				// Turn 3: text-only reply with the check still pending — the
				// bounded closure check (no work tools in this request) fires.
				{ stream: ["The total is 42."] },
				tool("todos", {
					todos: [
						{ id: 1, content: "Publish after approval", status: "pending", note: "Deferred until explicit approval" },
					],
				}),
				{ stream: ["Cleanup check finished."] },
				// No work tool ran in this run, so the general continuation nudge
				// still applies to the final text-only reply.
				{ stream: ["<done>"] },
			],
		},
		async (fixture, trace) => {
			const chat = () => fixture.fake.requests.filter((request) => request.url === "/openai/v1/chat/completions")
			terminal.submit("Create a pending todo to publish after approval. Do no task work.")
			await waitForText(terminal, "Publishing is deferred.")
			await waitForTurnToSettle(fixture.fake.requests)
			expect(chat()).toHaveLength(2)
			// The create write reconciled the list for this input: no cleanup.
			expect(JSON.stringify(chat())).not.toContain("The turn ended with unfinished todos")
			trace.step("todo-only planning settles without cleanup")

			terminal.submit("Verify the total with printf and ask before publishing.")
			await waitForText(terminal, "Verified 42. Should I publish?")
			await waitForTurnToSettle(fixture.fake.requests)
			expect(chat()).toHaveLength(5)
			// The gate arms silently at receipt: the turn's first request
			// carries the user's direction with no harness reminder riding it
			// (the reminder used to be delivered ahead of the very message it
			// referred to). Reconciliation-before-work is enforced by the gate:
			// the list was reconciled (mark) before the work tool ran.
			expect(JSON.stringify(chat()[2].body)).toContain("Verify the total with printf")
			expect(JSON.stringify(chat()[2].body)).not.toContain("Todo check-in")
			trace.step("changed-direction input: mark → work → ask")

			terminal.submit("Just repeat the total; do not call tools or publish.")
			await waitForText(terminal, "The total is 42.")
			await waitForText(terminal, "Cleanup check finished.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			// The whole request contained no work tools — the once-per-request
			// closure check still fires for old unfinished todos, and the general
			// continuation nudge applies to the final text-only reply.
			expect(chat()).toHaveLength(9)
			const closureTurn = chat()[6].body as { messages: { role: string; content: unknown }[] }
			expect(JSON.stringify(closureTurn.messages)).toContain("The turn ended with unfinished todos")
			expect(JSON.stringify(closureTurn.messages)).toContain("Preserve deferred")
			expect(viewText(terminal)).toContain("Publish after approval")
			expect(viewText(terminal)).toContain("0/1")
			trace.step("conversational follow-up gets one bounded cleanup; deferred work preserved")
		},
	)
})

test("check-in gate: unchanged plan confirms without a write, then work proceeds", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "todo-checkin-confirm",
			models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 1_000_000, maxTokens: 4096 }],
			responses: [
				tool("todos", { todos: [{ content: "Publish after approval", status: "pending" }] }),
				{ stream: ["Publishing is deferred."] },
				// Turn 2: the plan still fits — confirm the unchanged list at
				// input revision 2 instead of writing, then work.
				tool("todos", { confirm: 2 }),
				tool("bash", { command: "printf '42\\n'" }),
				{ stream: ["Verified 42. Publishing still waits for approval."] },
				// Work completed after the confirmation, so the bounded terminal
				// closure check stays eligible: one cleanup continuation.
				tool("todos", {
					todos: [{ id: 1, content: "Publish after approval", status: "pending", note: "Deferred until approval" }],
				}),
				{ stream: ["Cleanup check finished."] },
			],
		},
		async (fixture, trace) => {
			const chat = () => fixture.fake.requests.filter((request) => request.url === "/openai/v1/chat/completions")
			terminal.submit("Create a pending todo to publish after approval. Do no task work.")
			await waitForText(terminal, "Publishing is deferred.")
			await waitForTurnToSettle(fixture.fake.requests)

			terminal.submit("Check the total, but the publishing plan is unchanged.")
			await waitForText(terminal, "Cleanup check finished.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			// The gate arms silently at receipt: the turn's first request
			// carries the user's direction with no harness reminder riding it.
			// The scripted confirm (revision 2) released the work tools
			// without a store write.
			expect(chat()).toHaveLength(7)
			const confirmTurn = chat()[2].body as { messages: { role: string; content: unknown }[] }
			expect(JSON.stringify(confirmTurn.messages)).toContain("the publishing plan is unchanged")
			expect(JSON.stringify(confirmTurn.messages)).not.toContain("Todo check-in")
			const closureTurn = chat()[5].body as { messages: { role: string; content: unknown }[] }
			expect(JSON.stringify(closureTurn.messages)).toContain("The turn ended with unfinished todos")
			expect(viewText(terminal)).toContain("Publish after approval")
			expect(viewText(terminal)).toContain("0/1")
			trace.step("unchanged-plan input: confirm → work; bounded closure after work")
		},
	)
})

test("check-in gate: ignoring staleness reminders escalates, a wrong confirm is rejected, the right one resumes work", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "todo-checkin-staleness-escalation",
			models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 1_000_000, maxTokens: 4096 }],
			responses: [
				tool("todos", { todos: [{ content: "Long task", status: "in_progress" }] }),
				// Fifty successful work calls without touching the list:
				// reminders at 10/20/30/40/50, then the gate opens.
				...Array.from({ length: 50 }, (_, index) => bash(index)),
				// This call is blocked by the gate…
				tool("bash", { command: "printf 'never runs\\n'" }),
				// …the first confirmation carries the wrong revision (rejected)…
				tool("todos", { confirm: 2 }),
				// …the second carries the pending revision and resumes work.
				tool("todos", { confirm: 1 }),
				tool("bash", { command: "printf 'resumed\\n'" }),
				{ stream: ["All checked in and verified."] },
			],
		},
		async (fixture, trace) => {
			const chat = () => fixture.fake.requests.filter((request) => request.url === "/openai/v1/chat/completions")
			terminal.submit("Do the long task. Keep the todo list accurate as you go.")
			await waitForText(terminal, "All checked in and verified.", { timeoutMs: 120_000 })

			const history = JSON.stringify(chat())
			// Scope-labelled reminders recurred at every multiple of 10.
			expect(history).toContain("10 changes since the global todo list was last updated")
			expect(history).toContain("50 changes since the global todo list was last updated")
			// The gate blocked the 51st work call with the check-in reason.
			expect(history).toContain("check-in pending (input revision 1)")
			// The wrong confirmation was rejected with the actual state…
			expect(history).toContain("accepted input revision is now 1")
			expect(history).toContain("[in_progress] #1 Long task")
			// …and work resumed after the matching confirmation.
			expect(viewText(terminal)).toContain("All checked in and verified.")
			expect(viewText(terminal)).toContain("0/1")
			trace.step("ignored reminders → gate → stale revision → confirm → work")
		},
	)
})

test("plan submission: stale final list arms the check-in gate for the approval turn", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "todo-checkin-plan-submission",
			gitInit: true,
			extraArgs: ["--plan=true"],
			models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 200_000, maxTokens: 8192 }],
			responses: [
				// Turn 1: create the planning todo (the write reconciles).
				tool("todos", { todos: [{ content: "Write the plan", status: "in_progress" }] }),
				// Work completed while finalizing the plan, without a reflecting
				// todo write — the list goes structurally stale.
				bash(1),
				bash(2),
				// The plan is submitted for review; the turn ends in the review
				// menu (stopReason toolUse — no closure steer, and below the
				// staleness interval: only the submission boundary can catch the
				// stale list).
				tool("submit_plan", { plan: "# Plan\n\n## Goal\n\nVerify the plan-submission check-in gate.\n" }),
				// Approval turn: the first work tool is blocked by the armed gate…
				tool("bash", { command: "printf 'never runs\n'" }),
				// …the model reconciles (the plan was written and submitted)…
				tool("todos", { todos: [{ id: 1, content: "Write the plan", status: "completed" }] }),
				// …and execution work proceeds.
				tool("bash", { command: "printf 'executed\n'" }),
				{ stream: ["Plan executed. Ready for the next task."] },
			],
		},
		async (fixture, trace) => {
			const chat = () => fixture.fake.requests.filter((request) => request.url === "/openai/v1/chat/completions")
			terminal.submit("Plan how to add a new feature.")

			// The TUI plan-review menu opens at the submission boundary.
			await waitForText(terminal, "Plan complete. How would you like to proceed?", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("plan submitted; review menu open")

			// Approve locally: the first option is "Execute the plan locally".
			terminal.keyPress(Key.Enter)
			await waitForText(terminal, "Plan executed. Ready for the next task.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("approved locally; execution finished")

			const history = JSON.stringify(chat())
			// The blocked work call carried the plan-submission check-in reason.
			expect(history).toContain("check-in pending (input revision 1)")
			// The plan-submission instruction rode the first request after the
			// submission boundary — the same request that carries the submit_plan
			// tool result — so the model knew why the gate was open before its
			// work tool ran, and the block followed the instruction.
			const bodies = chat().map((request) => JSON.stringify(request.body))
			const submissionTurn = bodies.findIndex((body) => body.includes("The plan was submitted for review"))
			expect(submissionTurn).toBeGreaterThanOrEqual(0)
			expect(bodies[submissionTurn]).toContain("Plan submitted")
			expect(bodies.findIndex((body) => body.includes("check-in pending (input revision 1)"))).toBeGreaterThan(
				submissionTurn,
			)
			// The approval turn still ran after the gate-forced reconciliation.
			expect(bodies.some((body) => body.includes("The user approved the plan"))).toBe(true)
			// The reconciliation the gate forced is visible in the final state.
			terminal.submit("/todos")
			await waitForText(terminal, "1/1 ✓", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			trace.step("stale submission → armed gate → blocked work → reconcile → execute")
		},
	)
})

test("check-in gate: input while gated requires reconciliation against the latest direction", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "todo-checkin-superseded-revision",
			models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 1_000_000, maxTokens: 4096 }],
			responses: [
				// Turn 1: create the list, then answer. The create reconciles for
				// revision 1, so the text-only answer needs no cleanup continuation.
				tool("todos", { todos: [{ content: "Verify the input", status: "pending" }] }),
				{ stream: ["Tracking the task now."] },
				// Turn 2 (input revision 2 — changed direction): work tools are
				// blocked while the check is pending; a repeated attempt returns
				// the current instructions without new steers.
				tool("bash", { command: "printf 'first attempt\\n'" }),
				tool("bash", { command: "printf 'second attempt\\n'" }),
				// A question to the user ends the turn — awaiting an answer, so
				// neither the closure check nor the continuation nudge fires; the
				// check stays pending across the turn boundary.
				{ stream: ["Both attempts are blocked by the check-in. Should I proceed with the current direction?"] },
				// Turn 3 (input revision 3 — the latest direction): the model still
				// holds revision 2 from the block reason it saw, so its
				// confirmation is stale — rejected with the current revision and
				// the check stays pending.
				tool("todos", { confirm: 2 }),
				// Reconciling against the latest direction (revision 3) is what
				// unlocks the work tools.
				tool("todos", { confirm: 3 }),
				tool("bash", { command: "printf 'resumed with the new direction\\n'" }),
				{ stream: ["All done with the new direction."] },
				// Keepalive for the bounded closure/continuation turn after the
				// final text-only reply, if one fires.
				{ stream: ["<done>"] },
			],
		},
		async (fixture, trace) => {
			const chat = () => fixture.fake.requests.filter((request) => request.url === "/openai/v1/chat/completions")
			terminal.submit("Verify the input and keep the list accurate.")
			await waitForText(terminal, "Tracking the task now.")

			terminal.submit("Now do it differently.")
			await waitForText(terminal, "Should I proceed with the current direction?", { timeoutMs: STREAM_TIMEOUT_MS })

			terminal.submit("Actually, redo it the new way instead.")
			await waitForText(terminal, "All done with the new direction.", { timeoutMs: STREAM_TIMEOUT_MS })

			const history = JSON.stringify(chat())
			// The gate blocked work against revision 2 and carried its instructions.
			expect(history).toContain("check-in pending (input revision 2)")
			// The newer direction superseded the pending check: the model's
			// revision-2 confirmation was rejected as stale…
			expect(history).toContain("The accepted input revision is now 3 (you confirmed 2)")
			// …and only reconciliation against revision 3 released the work
			// tools — no block ever carried revision 3, and work resumed.
			expect(history).toContain("Confirmed 1 todos")
			expect(history).not.toContain("check-in pending (input revision 3)")
			expect(history).toContain("resumed with the new direction")
			trace.step("superseded input: stale revision rejected, latest direction unlocks work")
		},
	)
})

// The reported bug this gate was reworked for: a user message arriving while
// the model is parked in a bash_control wait was answered late — the reminder
// was enqueued during the input event, ahead of the message, and with
// one-at-a-time steering delivered alone (the model read it as the announced
// "message from the user").
test("check-in gate: a mid-run message during a bash_control wait is delivered ahead of any reminder", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "todo-checkin-midrun-wait-release",
			models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 1_000_000, maxTokens: 4096 }],
			responses: [
				// Turn 1: list exists; the create write reconciles turn 1's input.
				tool("todos", { todos: [{ content: "Watch the long render", status: "in_progress" }] }),
				{ stream: ["Watching the render."] },
				// Turn 2: the input arms the gate (rev 2), so the model
				// reconciles first (a write closes the check), then spawns a
				// long background command and parks in a bash_control wait.
				tool("todos", {
					todos: [
						{ id: 1, content: "Watch the long render", status: "in_progress", note: "Tracking the render watch" },
					],
				}),
				{
					stream: ["Waiting for the render to finish."],
					toolCalls: [
						{ id: "call-spawn", function: { name: "bash", arguments: JSON.stringify({ command: "sleep 30" }) } },
					],
				},
				tool("bash_control", { wait: true }),
				// Turn 3: answer the mid-run message; the text-only run with
				// an unfinished list gets its one bounded cleanup continuation.
				{ stream: ["Render watch paused — what should change?"] },
				tool("todos", {
					todos: [{ id: 1, content: "Watch the long render", status: "pending", note: "Deferred until approval" }],
				}),
				{ stream: ["Cleanup check finished."] },
				{ stream: ["<done>"] },
			],
		},
		async (fixture, trace) => {
			const chat = () => fixture.fake.requests.filter((request) => request.url === "/openai/v1/chat/completions")
			terminal.submit("Create a todo and watch the long render.")
			await waitForText(terminal, "Watching the render.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)

			terminal.submit("Wait for the render in the background.")
			await waitForText(terminal, "Waiting for the render to finish.", { timeoutMs: STREAM_TIMEOUT_MS })
			// Park detection: turn 2 is three rounds (reconciling write,
			// spawn request, wait request); once the wait request has fired,
			// the tool result is pending and the model is inside bash_control.
			const parked = Date.now() + STREAM_TIMEOUT_MS
			while (chat().length < 5 && Date.now() < parked) await new Promise((resolve) => setTimeout(resolve, 100))
			expect(chat().length).toBe(5)
			trace.step("model parked inside the bash_control wait")

			terminal.submit("Abort the render watch and summarize instead.")
			await waitForText(terminal, "Render watch paused", { timeoutMs: STREAM_TIMEOUT_MS * 2 })
			await waitForTurnToSettle(fixture.fake.requests)

			// The first request after the wait release carries the user's
			// message (and the release tool result) with no todo reminder
			// ahead of it — under the pre-fix ordering the reminder was
			// enqueued during the input event and delivered alone first.
			const bodies = chat().map((request) => JSON.stringify(request.body))
			const releaseIdx = bodies.findIndex((body) => body.includes("Wait released: a message from the user is waiting"))
			expect(releaseIdx).toBeGreaterThan(0)
			expect(bodies[releaseIdx]).toContain("Abort the render watch and summarize")
			expect(bodies[releaseIdx]).not.toContain("Todo check-in")
			expect(bodies.slice(0, releaseIdx).some((body) => body.includes("Todo check-in"))).toBe(false)
			trace.step("mid-run message delivered ahead of any todo reminder")
		},
	)
})
