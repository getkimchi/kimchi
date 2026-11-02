import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SessionUpdate } from "@agentclientprotocol/sdk"
import { expect, it } from "vitest"
import { STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitForSessionUpdate } from "./support/scenarios.js"

const STEER_METHOD = "_kimchi.dev/steering"

it(
	"filtered inspection reports a queued exit as pending until its notice is consumed",
	async () => {
		const fixture = await startAcpFixture({
			artifactName: "bash-background-filtered-pending-exit",
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
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			const pending = fixture.conn.prompt({
				sessionId,
				prompt: [{ type: "text", text: "Run a command and draft while it finishes" }],
			})
			await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text" &&
					update.content.text.includes("Drafting section 1"),
			)
			expect(
				await fixture.conn.extMethod(STEER_METHOD, { sessionId, prompt: "Inspect just the command before continuing" }),
			).toMatchObject({ status: "injected" })
			expect((await pending).stopReason).toBe("end_turn")
			const messages =
				(fixture.fake.requests.at(-1)?.body as { messages?: Array<Record<string, unknown>> } | undefined)?.messages ??
				[]
			const inspection = messages.find((message) => message.role === "tool" && message.tool_call_id === "inspect")
			expect(String(inspection?.content)).toContain("not yet acknowledged")
			expect(String(inspection?.content)).not.toContain("Unknown handle")
			expect(JSON.stringify(messages).split("[Background bash process ended").length - 1).toBe(1)
			expect(fixture.client.sessionUpdates.map(({ update }) => update)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						sessionUpdate: "tool_call_update",
						rawOutput: expect.objectContaining({
							details: expect.objectContaining({ pendingHandles: [expect.any(String)] }),
						}),
					}),
				]),
			)
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"runs independent work during background Bash, checkpoints the group, and stops selected processes",
	async () => {
		const stopSurvivor = { id: "stop_survivor", function: { name: "bash_control", arguments: "" } }
		const fixture = await startAcpFixture({
			artifactName: "bash-background-control",
			responses: [
				{
					toolCalls: [
						{
							id: "spawn_first",
							index: 0,
							function: { name: "bash", arguments: JSON.stringify({ command: "echo first-alive && sleep 90" }) },
						},
						{
							id: "spawn_second",
							index: 1,
							function: { name: "bash", arguments: JSON.stringify({ command: "echo second-alive && sleep 90" }) },
						},
					],
				},
				{
					toolCalls: [
						{ id: "read", function: { name: "read", arguments: JSON.stringify({ path: "independent.txt" }) } },
					],
				},
				{
					toolCalls: [
						{
							id: "wait",
							function: { name: "bash_control", arguments: JSON.stringify({ wait: true, waitSeconds: 1 }) },
						},
					],
				},
				{
					toolCalls: [
						{
							id: "stop",
							function: {
								name: "bash_control",
								arguments: JSON.stringify({ wait: false, stop_handles: ["__BASH_HANDLE__"] }),
							},
						},
					],
				},
				{
					match: (request) => {
						if (
							request.body === null ||
							typeof request.body !== "object" ||
							!("messages" in request.body) ||
							!Array.isArray(request.body.messages)
						)
							return false
						const last = request.body.messages.findLast((message) => message.role === "tool")
						if (last?.tool_call_id !== "stop") return false
						// Use the running inspection row; the ordinary placeholder
						// finds the terminal header and would stop the same process twice.
						const survivor = String(last.content).match(/\n([0-9a-fA-F-]{36}): .*\nRunning:/)?.[1]
						stopSurvivor.function.arguments = JSON.stringify({ wait: false, stop_handles: [survivor] })
						return true
					},
					toolCalls: [stopSurvivor],
				},
				{ stream: ["Independent work completed and the command was stopped."] },
			],
		})
		try {
			writeFileSync(join(fixture.workDir, "independent.txt"), "independent file contents")
			const sessionId = await newSession(fixture, fixture.workDir)
			expect(
				(await prompt(fixture, sessionId, "Run a long command, read the file, wait briefly, then stop it")).stopReason,
			).toBe("end_turn")
			const updates = fixture.client.sessionUpdates.map(({ update }) => update)
			expect(updates).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						sessionUpdate: "tool_call_update",
						status: "completed",
						rawOutput: expect.objectContaining({ details: expect.objectContaining({ handoff: true, exited: false }) }),
					}),
					expect.objectContaining({
						sessionUpdate: "tool_call_update",
						status: "completed",
						rawOutput: expect.objectContaining({
							details: expect.objectContaining({
								event: "checkpoint",
								effectiveWaitSeconds: 1,
								runningHandles: [expect.any(String), expect.any(String)],
							}),
						}),
					}),
					expect.objectContaining({
						sessionUpdate: "tool_call_update",
						status: "completed",
						rawOutput: expect.objectContaining({
							details: expect.objectContaining({
								exitedHandles: [expect.any(String)],
								runningHandles: [expect.any(String)],
							}),
						}),
					}),
					expect.objectContaining({
						sessionUpdate: "tool_call_update",
						status: "completed",
						rawOutput: expect.objectContaining({
							details: expect.objectContaining({
								exitedHandles: expect.arrayContaining([expect.any(String)]),
								runningHandles: [],
							}),
						}),
					}),
				]),
			)
			// The actual read result must reach the model while the process lives;
			// a scripted final sentence alone would not prove the tool was allowed.
			const requests = fixture.fake.requests.filter(
				(request) =>
					request.url.endsWith("/chat/completions") &&
					request.body !== null &&
					typeof request.body === "object" &&
					"tools" in request.body,
			)
			expect(JSON.stringify(requests[2]?.body)).toContain("independent file contents")
			expect(JSON.stringify(requests[3]?.body)).toContain("Wait checkpoint: requested 1s")
			expect(JSON.stringify(requests.at(-1)?.body)).toContain("stopped on request")
			expect(fixture.client.agentTextBySession().get(sessionId)).toContain("Independent work completed")
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"cancelling a group wait leaves the process alive for inspection and explicit stop",
	async () => {
		const fixture = await startAcpFixture({
			artifactName: "bash-background-cancel-wait",
			responses: [
				{
					toolCalls: [
						{
							id: "spawn",
							function: { name: "bash", arguments: JSON.stringify({ command: "echo alive && sleep 90" }) },
						},
					],
				},
				{ toolCalls: [{ id: "wait", function: { name: "bash_control", arguments: JSON.stringify({ wait: true }) } }] },
				{
					toolCalls: [
						{ id: "inspect", function: { name: "bash_control", arguments: JSON.stringify({ wait: false }) } },
					],
				},
				{
					toolCalls: [
						{
							id: "stop",
							function: {
								name: "bash_control",
								arguments: JSON.stringify({ wait: false, stop_handles: ["__BASH_HANDLE__"] }),
							},
						},
					],
				},
				{ stream: ["The cancelled wait left the command alive; it is now stopped."] },
			],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			const pending = fixture.conn.prompt({
				sessionId,
				prompt: [{ type: "text", text: "Start a command and wait for it" }],
			})
			await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "tool_call" && JSON.stringify(update.rawInput) === JSON.stringify({ wait: true }),
			)
			await fixture.conn.cancel({ sessionId })
			expect((await pending).stopReason).toBe("cancelled")
			expect((await prompt(fixture, sessionId, "Inspect the command, then stop it")).stopReason).toBe("end_turn")
			expect(fixture.client.sessionUpdates.map(({ update }) => update)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						sessionUpdate: "tool_call_update",
						status: "completed",
						rawOutput: expect.objectContaining({
							details: expect.objectContaining({ event: "inspection", runningHandles: [expect.any(String)] }),
						}),
					}),
					expect.objectContaining({
						sessionUpdate: "tool_call_update",
						rawOutput: expect.objectContaining({
							details: expect.objectContaining({ exitedHandles: [expect.any(String)], runningHandles: [] }),
						}),
					}),
				]),
			)
			expect(fixture.client.agentTextBySession().get(sessionId)).toContain("it is now stopped")
			// The handoff and inspection results name the live log over ACP too.
			const updatesText = JSON.stringify(fixture.client.sessionUpdates)
			expect(updatesText).toContain(" full log: ")
			expect(updatesText).toContain("until grep -qE")
			expect(updatesText).toContain("Full log: ")
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"filtered Bash group inspection returns only the selected handle; a stop-only call needs no wait",
	async () => {
		const fixture = await startAcpFixture({
			artifactName: "bash-background-filtered-inspection",
			responses: [
				{
					toolCalls: [
						{
							id: "spawn_first",
							index: 0,
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "sleep 3 && echo one-alive && sleep 90" }),
							},
						},
						{
							id: "spawn_second",
							index: 1,
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "sleep 3 && echo two-alive && sleep 90" }),
							},
						},
					],
				},
				// A filtered inspection of ONE handle (the most recent = the second
				// command): only its output and evidence return; the other's cursor
				// is preserved. The slow stream keeps the turn open long enough for
				// both commands' output to land after the handoff.
				{
					stream: ["Inspecting the second command alone. ", "Reading its fresh output. "],
					textDelayMs: 1200,
					toolCalls: [
						{
							id: "inspect_one",
							function: {
								name: "bash_control",
								arguments: JSON.stringify({ handles: ["__BASH_HANDLE__"] }),
							},
						},
					],
				},
				// A stop-only call for BOTH handles — `wait` is omitted.
				{
					toolCalls: [
						{
							id: "stop",
							function: {
								name: "bash_control",
								arguments: JSON.stringify({
									stop_handles: ["__BASH_HANDLE__", "__BASH_HANDLE_2__"],
								}),
							},
						},
					],
				},
				{ stream: ["The selected command was inspected alone; both are now stopped."] },
			],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			expect(
				(await prompt(fixture, sessionId, "Start two long commands, inspect just the second, then stop both"))
					.stopReason,
			).toBe("end_turn")
			const updates = fixture.client.sessionUpdates.map(({ update }) => update)
			// The filtered inspection reported exactly ONE running handle (the
			// selected one)…
			expect(updates).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						sessionUpdate: "tool_call_update",
						status: "completed",
						rawOutput: expect.objectContaining({
							details: expect.objectContaining({ event: "inspection", runningHandles: [expect.any(String)] }),
						}),
					}),
					// …and the stop-only call (no wait) stopped both without a schema error.
					expect.objectContaining({
						sessionUpdate: "tool_call_update",
						status: "completed",
						rawOutput: expect.objectContaining({
							details: expect.objectContaining({
								exitedHandles: [expect.any(String), expect.any(String)],
								runningHandles: [],
							}),
						}),
					}),
				]),
			)
			// Isolate each tool result from the FINAL request's history by
			// tool_call_id (earlier requests repeat the same messages).
			const lastMessages =
				(fixture.fake.requests.at(-1)?.body as { messages?: Array<Record<string, unknown>> } | undefined)?.messages ??
				[]
			const toolText = (id: string): string => {
				const message = lastMessages.find((m) => m.role === "tool" && m.tool_call_id === id)
				return typeof message?.content === "string" ? message.content : JSON.stringify(message?.content ?? "")
			}
			// The selected command's fresh output was delivered by the filtered
			// inspection; the unselected command's stayed unseen (cursor
			// preserved) until its stop result delivered it — with no repetition
			// (the echo texts also appear in command summaries, so assert on the
			// output sections instead).
			expect(toolText("inspect_one")).toContain("two-alive")
			expect(toolText("inspect_one")).not.toContain("one-alive")
			expect(toolText("stop")).toMatch(/Final output:\n?one-alive/)
			expect(toolText("stop").match(/The process produced no further output\./g)?.length).toBe(1)
			expect(toolText("stop")).not.toContain("Error:")
			expect(JSON.stringify(lastMessages)).not.toContain("Task completion requires a disposition")
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"stopping with unresolved work never queues a forced reminder (user-facing session)",
	async () => {
		// The ACP session is user-facing: a stop with a live process queues NO
		// completion reminder at all — the injected steer drives the next turn,
		// the steer-driven stop resolves the work, and the provider never sees
		// a disposition demand (nor a suppression note — nothing was queued).
		const fixture = await startAcpFixture({
			artifactName: "bash-background-reminder-backlog",
			responses: [
				{
					toolCalls: [{ function: { name: "bash", arguments: JSON.stringify({ command: "sleep 120" }) } }],
				},
				// A slow stream keeps the turn live while the steer is injected.
				{
					stream: ["I believe the work is complete. ", "Nothing further is needed from my side. "],
					textDelayMs: 700,
				},
				{
					stream: ["Right, stopping the background command instead."],
					toolCalls: [
						{
							id: "stop",
							function: {
								name: "bash_control",
								arguments: JSON.stringify({ stop_handles: ["__BASH_HANDLE__"] }),
							},
						},
					],
				},
				{ stream: ["The command is stopped; the task is complete."] },
			],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			const pending = fixture.conn.prompt({
				sessionId,
				prompt: [{ type: "text", text: "Start a long command, then finish the task" }],
			})
			// While the finishing attempt is streaming, inject the steer (the
			// loop consumes it at the next boundary; no reminder competes with it).
			await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text" &&
					update.content.text.includes("I believe the work is complete"),
			)
			const steerResult = (await fixture.conn.extMethod(STEER_METHOD, {
				sessionId,
				prompt: "Actually, stop the background command",
			})) as { status: string }
			expect(steerResult.status).toBe("injected")

			expect((await pending).stopReason).toBe("end_turn")

			const requests = fixture.fake.requests.filter((r) =>
				JSON.stringify((r.body as { messages?: unknown[] } | null)?.messages ?? []).includes(
					"Start a long command, then finish the task",
				),
			)
			const conversation = JSON.stringify(
				requests.flatMap((request) => (request.body as { messages?: unknown[] } | null)?.messages ?? []),
			)
			// No forced reminder was ever queued: no disposition demand, and no
			// suppression note either — the user-facing session never queues one.
			expect(conversation).not.toContain("Task completion requires a disposition")
			expect(conversation).not.toContain("completion reminder was suppressed")
			expect(conversation).toContain("stopped on request")
			// The run settled on its own turns (at least: spawn, stop attempt,
			// steer-driven stop, final — plus any stop-nudge acknowledgement;
			// side traffic shares the prompt text, so this is a floor).
			expect(requests.length).toBeGreaterThanOrEqual(4)
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)

// Steering during an active wait (user-facing ACP session): the wait
// releases with the distinct user-input result, the agent answers and the
// prompt completes with the Bash process still alive — no forced wait/stop
// reminder — and the later completion notification wakes the idle agent
// with no prompt in flight. The unsolicited wake run is fully visible:
// its streamed text AND its tool calls are forwarded; steering DURING the
// wake injects into it (not promptRequired), and a prompt sent while the
// wake still streams waits it out instead of failing with pi's
// "Agent is already processing".
it(
	"steering during a wait releases it; the turn settles alive and the exit wakes the idle agent",
	async () => {
		// Split in the command so the joined marker proves the DELIVERED EXIT
		// OUTPUT arrived, not the echoed command text.
		const MARKER = "ACP-STEER-DONE-9b2e"
		const fixture = await startAcpFixture({
			artifactName: "bash-background-control-steer-releases-wait",
			responses: [
				// Turn 1: start a command that outlives the whole exchange.
				{
					toolCalls: [
						{
							id: "spawn",
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: 'sleep 25 && echo "ACP-STEER-"DONE-9b2e' }),
							},
						},
					],
				},
				// Turn 2: enter a long bounded wait — only steering releases it early.
				{
					stream: ["Nothing else to do; waiting. ", ...Array.from({ length: 5 }, () => "Still waiting. ")],
					textDelayMs: 300,
					toolCalls: [
						{
							id: "wait",
							function: {
								name: "bash_control",
								arguments: JSON.stringify({ wait: true, waitSeconds: 120 }),
							},
						},
					],
				},
				// Turn 3 (the wait released by the steered question): answer it and end
				// the turn — the command keeps running.
				{ stream: ["2+2 is 4."] },
				// Wake run (the exit notification woke the idle agent): slow-streamed
				// text plus a TOOL CALL, so the test can steer and prompt while it
				// runs and assert the unsolicited run's tool activity is forwarded.
				{
					stream: ["The background command finished. ", ...Array.from({ length: 5 }, () => "Wrapping up. ")],
					textDelayMs: 300,
					toolCalls: [
						{
							id: "wake_read",
							function: { name: "read", arguments: JSON.stringify({ path: "independent.txt" }) },
						},
					],
				},
				// Wake continuation (the steer sent mid-run is consumed at the tool
				// boundary): answer it, still inside the unsolicited run.
				{
					stream: ["Also, 6+6 is 12. ", ...Array.from({ length: 3 }, () => "Finishing up. ")],
					textDelayMs: 300,
				},
				// The prompt sent while the wake still streamed waited the run out and
				// now runs as its own turn.
				{ stream: ["No — nothing is left running."] },
			],
		})
		try {
			writeFileSync(join(fixture.workDir, "independent.txt"), "wake read contents")
			const sessionId = await newSession(fixture, fixture.workDir)
			const pending = fixture.conn.prompt({
				sessionId,
				prompt: [{ type: "text", text: "Run a long command, then wait for it to finish" }],
			})
			await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text" &&
					update.content.text.includes("Nothing else to do; waiting"),
			)
			// Steer DURING the active wait — the wait must release so the answer
			// arrives long before the command ends.
			expect(
				await fixture.conn.extMethod(STEER_METHOD, { sessionId, prompt: "Quick question: what is 2+2?" }),
			).toMatchObject({ status: "injected" })
			expect((await pending).stopReason).toBe("end_turn")

			// The wait released with the distinct user-input result and the
			// command kept running through the settled prompt.
			const updates = fixture.client.sessionUpdates.map(({ update }) => update)
			expect(updates).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						sessionUpdate: "tool_call_update",
						status: "completed",
						rawOutput: expect.objectContaining({
							details: expect.objectContaining({
								event: "user-input",
								runningHandles: [expect.any(String)],
							}),
						}),
					}),
				]),
			)
			expect(fixture.client.agentTextBySession().get(sessionId)).toContain("2+2 is 4")
			const bodyOf = (r: { body?: unknown }) => JSON.stringify(r.body ?? {})
			// The answer request (the one carrying the wait-release tool result and
			// the steered question) is located by content — side traffic shares
			// the prompt text, so indices are not stable.
			const answerRequest = fixture.fake.requests.find((r) =>
				bodyOf(r).includes("Wait released: a message from the user is waiting."),
			)
			expect(answerRequest).toBeTruthy()
			const answerBody = bodyOf(answerRequest as { body?: unknown })
			expect(answerBody).toContain("what is 2+2")
			expect(answerBody).not.toContain(MARKER)
			// User-facing session: no forced wait/stop reminder anywhere.
			expect(fixture.fake.requests.map(bodyOf).join("\n")).not.toContain("Task completion requires a disposition")

			// The completion notification wakes the idle agent without an active
			// prompt, and the unsolicited run's response is FORWARDED to the client:
			// the wake text arrives as an agent_message_chunk even though no prompt
			// is in flight.
			await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text" &&
					update.content.text.includes("The background command finished"),
				45_000,
			)
			// Steer DURING the wake run: the run counts as active, so the steer
			// injects into it (not promptRequired) and is answered inside the run.
			expect(
				await fixture.conn.extMethod(STEER_METHOD, { sessionId, prompt: "While it wraps up: what is 6+6?" }),
			).toMatchObject({ status: "injected" })
			await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text" &&
					update.content.text.includes("6+6 is 12"),
				45_000,
			)
			// The wake run's TOOL CALL is forwarded too: the read it made reaches
			// the client as a tool_call_update (in flight, then completed).
			const wakeToolUpdates = fixture.client.sessionUpdates
				.map(({ update }) => update as SessionUpdate)
				.filter(
					(update): update is Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }> =>
						update.sessionUpdate === "tool_call_update" &&
						JSON.stringify(update.rawInput ?? update.rawOutput ?? {}).includes("independent.txt"),
				)
			expect(wakeToolUpdates.length).toBeGreaterThanOrEqual(1)
			expect(wakeToolUpdates.some((update) => update.status === "completed" || update.status === "in_progress")).toBe(
				true,
			)
			expect(fixture.client.agentTextBySession().get(sessionId)).toContain("The background command finished")
			// A prompt sent while the wake still streamed waits the run out and
			// then runs as its own turn — pi never sees a mid-run prompt, so no
			// "Agent is already processing" failure.
			const followUp = await fixture.conn.prompt({
				sessionId,
				prompt: [{ type: "text", text: "Is anything still running?" }],
			})
			expect(followUp.stopReason).toBe("end_turn")
			expect(fixture.client.agentTextBySession().get(sessionId)).toContain("No — nothing is left running.")
			// The wake run also issued its provider request, carrying the exit
			// result exactly once through the steering notification.
			const wakeRequest = fixture.fake.requests.find((r) => bodyOf(r).includes("[Background bash process ended"))
			expect(wakeRequest).toBeTruthy()
			const wakeBody = bodyOf(wakeRequest as { body?: unknown })
			expect(wakeBody).toContain(MARKER)
			expect(wakeBody.split("[Background bash process ended").length - 1).toBe(1)
			expect(wakeBody).not.toContain("Task completion requires a disposition")
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)
