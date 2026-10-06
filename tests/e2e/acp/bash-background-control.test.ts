import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitForSessionUpdate } from "./support/scenarios.js"

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
