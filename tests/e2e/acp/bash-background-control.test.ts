import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitForSessionUpdate } from "./support/scenarios.js"

const STEER_METHOD = "_kimchi.dev/steering"

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
	"a queued completion reminder is suppressed when the process is stopped first",
	async () => {
		// Stopping with a reminder backlog: the turn ends with a process
		// running (one completion reminder queues behind an injected steer),
		// the steer-driven turn stops the process, and the stale reminder is
		// REPLACED at consumption — the provider never sees a disposition demand.
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
				{ stream: ["Everything is finished."] },
			],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			const pending = fixture.conn.prompt({
				sessionId,
				prompt: [{ type: "text", text: "Start a long command, then finish the task" }],
			})
			// While the finishing attempt is streaming, queue steering ahead of
			// the completion reminder (the loop consumes steering first).
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

			const conversation = JSON.stringify(
				fixture.fake.requests.flatMap((request) => (request.body as { messages?: unknown[] } | null)?.messages ?? []),
			)
			// The stale reminder never demanded a disposition from the provider…
			expect(conversation).not.toContain("Task completion requires a disposition")
			// …it was replaced at consumption with the suppression note, exactly
			// once, and the stop was delivered.
			expect(conversation.match(/completion reminder was suppressed/g)?.length).toBe(1)
			expect(conversation).toContain("stopped on request")
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)
