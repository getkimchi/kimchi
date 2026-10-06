import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { expect, it } from "vitest"
import { STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitFor, waitForSessionUpdate } from "./support/scenarios.js"

// The file gate lets the test choose the exit boundary after the handoff.
// Splitting the marker in the command proves it arrived as output, rather
// than matching the command already present in the model's transcript.
const COMMAND = 'while [ ! -f exit-now ]; do sleep 0.05; done; echo ACP-EXIT-"RESULT-7f31"; touch exited'
const MARKER = "ACP-EXIT-RESULT-7f31"

it(
	"yields a requested wait to a queued automatic exit while another process remains alive",
	async () => {
		const fixture = await startAcpFixture({
			artifactName: "bash-background-delivery-yields-wait",
			responses: [
				{
					toolCalls: [
						{ id: "spawn_exit", index: 0, function: { name: "bash", arguments: JSON.stringify({ command: COMMAND }) } },
						{
							id: "spawn_survivor",
							index: 1,
							function: { name: "bash", arguments: JSON.stringify({ command: "echo survivor-alive && sleep 90" }) },
						},
					],
				},
				{
					stream: ["Preparing the group wait. ", ...Array.from({ length: 7 }, () => "Still preparing. ")],
					textDelayMs: 500,
					toolCalls: [
						{
							id: "wait",
							function: { name: "bash_control", arguments: JSON.stringify({ wait: true, waitSeconds: 300 }) },
						},
					],
				},
				{
					toolCalls: [
						{
							id: "stop_survivor",
							function: {
								name: "bash_control",
								arguments: JSON.stringify({ wait: false, stop_handles: ["__BASH_HANDLE__"] }),
							},
						},
					],
				},
				{ stream: ["The exit arrived promptly and the survivor was stopped."] },
			],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			const pending = prompt(fixture, sessionId, "Start both commands, then wait for changes and stop the survivor")
			await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text" &&
					update.content.text.includes("Preparing the group wait"),
			)
			writeFileSync(join(fixture.workDir, "exit-now"), "")
			const waitResult = await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "tool_call_update" &&
					(JSON.stringify(update.rawOutput) ?? "").includes('"pendingHandles":["'),
				10_000,
			)
			expect(waitResult).toMatchObject({
				sessionUpdate: "tool_call_update",
				status: "completed",
				rawOutput: {
					details: {
						event: "inspection",
						exitedHandles: [],
						pendingHandles: [expect.any(String)],
						runningHandles: [expect.any(String)],
					},
				},
			})
			// The wait reports pending status without stealing the automatic
			// payload. A live survivor must not hold delivery behind its timer.
			expect(JSON.stringify(waitResult)).not.toContain(MARKER)
			expect(JSON.stringify(waitResult)).not.toContain("Wait checkpoint")
			expect((await pending).stopReason).toBe("end_turn")
			const finalHistory = JSON.stringify(fixture.fake.requests.at(-1)?.body)
			expect(finalHistory).toContain(MARKER)
			// One automatically delivered exit plus the explicitly stopped survivor.
			expect(finalHistory.split("[Background bash process ended")).toHaveLength(3)
			expect(finalHistory.split(MARKER)).toHaveLength(2)
			expect(finalHistory).not.toContain("Task completion requires a disposition")
			expect(fixture.client.agentTextBySession().get(sessionId)).toContain("survivor was stopped")
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"delivers an exit exactly once at the next tool boundary while independent work continues",
	async () => {
		const fixture = await startAcpFixture({
			artifactName: "bash-background-delivery-boundary",
			responses: [
				{ toolCalls: [{ id: "spawn", function: { name: "bash", arguments: JSON.stringify({ command: COMMAND }) } }] },
				{
					stream: ["Reading independently. ", "Still reading. ", "Read complete. "],
					textDelayMs: 500,
					toolCalls: [
						{ id: "read", function: { name: "read", arguments: JSON.stringify({ path: "independent.txt" }) } },
					],
				},
				{ stream: ["The background exit arrived while I was reading."] },
			],
		})
		try {
			writeFileSync(join(fixture.workDir, "independent.txt"), "independent read succeeded")
			const sessionId = await newSession(fixture, fixture.workDir)
			const pending = prompt(fixture, sessionId, "Start the command and keep reading independently")
			await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text" &&
					update.content.text.includes("Reading independently"),
			)
			writeFileSync(join(fixture.workDir, "exit-now"), "")
			expect((await pending).stopReason).toBe("end_turn")
			const requests = fixture.fake.requests.filter(
				(request) =>
					request.url.endsWith("/chat/completions") &&
					request.body !== null &&
					typeof request.body === "object" &&
					"tools" in request.body,
			)
			const finalHistory = JSON.stringify(requests.at(-1)?.body)
			expect(finalHistory).toContain(MARKER)
			expect(finalHistory).toContain("independent read succeeded")
			expect(finalHistory.split("[Background bash process ended")).toHaveLength(2)
			expect(finalHistory).not.toContain("Task completion requires a disposition")
			expect(JSON.stringify(requests[1]?.body)).not.toContain(MARKER)
			expect(requests).toHaveLength(3)
			expect(fixture.client.agentTextBySession().get(sessionId)).toContain("Read complete. The background exit arrived")
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"recovers a queued exit after cancellation through inspection without repeating its payload",
	async () => {
		const fixture = await startAcpFixture({
			artifactName: "bash-background-delivery-cancel-recover",
			responses: [
				{ toolCalls: [{ id: "spawn", function: { name: "bash", arguments: JSON.stringify({ command: COMMAND }) } }] },
				{
					stream: ["Drafting while the command runs. ", ...Array.from({ length: 40 }, () => "More drafting. ")],
					textDelayMs: 250,
				},
				{
					toolCalls: [
						{ id: "inspect", function: { name: "bash_control", arguments: JSON.stringify({ wait: false }) } },
					],
				},
				{
					toolCalls: [
						{ id: "inspect_again", function: { name: "bash_control", arguments: JSON.stringify({ wait: false }) } },
					],
				},
				{ stream: ["Recovered the exit; no work remains."] },
			],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			const pending = fixture.conn.prompt({
				sessionId,
				prompt: [{ type: "text", text: "Start the command and draft while it runs" }],
			})
			await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text" &&
					update.content.text.includes("Drafting while"),
			)
			writeFileSync(join(fixture.workDir, "exit-now"), "")
			await waitFor(() => existsSync(join(fixture.workDir, "exited")), Boolean)
			// Allow the subprocess exit callback to enqueue its notification while
			// the deterministic long stream keeps it outside conversation history.
			await delay(300)
			await fixture.conn.cancel({ sessionId })
			expect((await pending).stopReason).toBe("cancelled")
			expect(
				(await prompt(fixture, sessionId, "Inspect the command's result and confirm nothing remains")).stopReason,
			).toBe("end_turn")
			const updates = fixture.client.sessionUpdates.map(({ update }) => update)
			expect(updates).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						sessionUpdate: "tool_call_update",
						status: "completed",
						rawOutput: expect.objectContaining({
							details: expect.objectContaining({ exitedHandles: [expect.any(String)] }),
						}),
					}),
					expect.objectContaining({
						sessionUpdate: "tool_call_update",
						status: "completed",
						rawOutput: expect.objectContaining({
							details: expect.objectContaining({ exitedHandles: [], runningHandles: [] }),
						}),
					}),
				]),
			)
			const finalHistory = JSON.stringify(fixture.fake.requests.at(-1)?.body)
			expect(finalHistory).toContain(MARKER)
			expect(finalHistory.split("[Background bash process ended")).toHaveLength(2)
			expect(finalHistory).not.toContain("Task completion requires a disposition")
			expect(fixture.client.agentTextBySession().get(sessionId)).toContain("Recovered the exit; no work remains")
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)
