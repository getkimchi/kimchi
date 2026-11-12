import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SessionUpdate } from "@agentclientprotocol/sdk"
import { expect, it } from "vitest"
import { STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitForSessionUpdate } from "./support/scenarios.js"

// A backgrounded bash tool call (its recorded result is the pre-exit
// handoff, details.handoff === true + a live handle) stays
// `in_progress` on the ACP wire until the process exits, then flips to a
// FINAL status carrying the exit outcome — completed on exit 0, failed
// otherwise. The hold is session-scoped, so it survives across turns; a
// client reload in the same harness process replays the still-running call
// under the SAME ACP id. Each file gate lets the test pick the exact exit
// boundary; markers are split in the command so a match proves output
// delivery, not command echo.

/** All tool_call_updates for one ACP toolCallId, in arrival order. */
function toolCallUpdatesFor(
	updates: Array<{ sessionId: string; update: SessionUpdate }>,
	sessionId: string,
	toolCallId: string,
): Array<Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>> {
	return updates
		.filter(
			(u): u is { sessionId: string; update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }> } =>
				u.sessionId === sessionId &&
				u.update.sessionUpdate === "tool_call_update" &&
				u.update.toolCallId === toolCallId,
		)
		.map((u) => u.update)
}

/** True once any terminal update has gone out for the given ACP toolCallId. */
function hasTerminalUpdate(
	updates: Array<{ sessionId: string; update: SessionUpdate }>,
	sessionId: string,
	toolCallId: string,
): boolean {
	return toolCallUpdatesFor(updates, sessionId, toolCallId).some(
		(u) => u.status === "completed" || u.status === "failed",
	)
}

it(
	"reports a backgrounded tool call as running until its process exits, then settles completed with the exit outcome",
	async () => {
		const COMMAND = 'while [ ! -f acp-bg-settle ]; do sleep 0.05; done; echo ACP-BG-"SETTLED-7f31"'
		const fixture = await startAcpFixture({
			artifactName: "bash-background-tool-calls-settle",
			responses: [
				{ toolCalls: [{ id: "spawn", function: { name: "bash", arguments: JSON.stringify({ command: COMMAND }) } }] },
				{ stream: ["The background command is launched."] },
				// Spare: the exit wakes the idle agent (user-facing session).
				{ stream: ["The background command finished."] },
			],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			const pending = prompt(fixture, sessionId, "Run the gated command in the background")
			// The handoff goes out as in_progress — no terminal status.
			const handoff = await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "tool_call_update" &&
					update.status === "in_progress" &&
					(JSON.stringify(update.rawOutput) ?? "").includes('"handoff":true'),
			)
			const acpToolCallId = handoff.toolCallId
			expect((await pending).stopReason).toBe("end_turn")
			// The turn ended with the process alive and the call still open.
			expect(hasTerminalUpdate(fixture.client.sessionUpdates, sessionId, acpToolCallId)).toBe(false)

			// The process exits → the exit watcher flips the SAME call to its
			// final status with the exit outcome.
			writeFileSync(join(fixture.workDir, "acp-bg-settle"), "")
			const final = await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "tool_call_update" &&
					update.toolCallId === acpToolCallId &&
					update.status === "completed",
			)
			expect(final).toMatchObject({
				sessionUpdate: "tool_call_update",
				toolCallId: acpToolCallId,
				status: "completed",
				rawOutput: {
					details: { handle: expect.any(String), exited: true, exitCode: 0, reason: null },
				},
			})
			expect(JSON.stringify(final.rawOutput)).toContain("ACP-BG-SETTLED-7f31")
			// Exactly one terminal update for the call, no failed update anywhere.
			const terminalStatuses = toolCallUpdatesFor(fixture.client.sessionUpdates, sessionId, acpToolCallId).filter(
				(u) => u.status === "completed" || u.status === "failed",
			)
			expect(terminalStatuses.map((u) => u.status)).toEqual(["completed"])
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"reports a backgrounded tool call as failed with the exit code when its process exits non-zero",
	async () => {
		const COMMAND = 'while [ ! -f acp-bg-fail ]; do sleep 0.05; done; echo ACP-BG-"FAILED-22c1"; exit 3'
		const fixture = await startAcpFixture({
			artifactName: "bash-background-tool-calls-fail",
			responses: [
				{ toolCalls: [{ id: "spawn", function: { name: "bash", arguments: JSON.stringify({ command: COMMAND }) } }] },
				{ stream: ["The background command is launched."] },
				{ stream: ["The background command exited with an error."] },
			],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			const pending = prompt(fixture, sessionId, "Run the gated command in the background")
			const handoff = await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "tool_call_update" &&
					update.status === "in_progress" &&
					(JSON.stringify(update.rawOutput) ?? "").includes('"handoff":true'),
			)
			const acpToolCallId = handoff.toolCallId
			expect((await pending).stopReason).toBe("end_turn")

			writeFileSync(join(fixture.workDir, "acp-bg-fail"), "")
			const final = await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "tool_call_update" &&
					update.toolCallId === acpToolCallId &&
					update.status === "failed",
			)
			expect(final).toMatchObject({
				sessionUpdate: "tool_call_update",
				toolCallId: acpToolCallId,
				status: "failed",
				rawOutput: {
					details: { handle: expect.any(String), exited: true, exitCode: 3 },
				},
			})
			const terminalStatuses = toolCallUpdatesFor(fixture.client.sessionUpdates, sessionId, acpToolCallId).filter(
				(u) => u.status === "completed" || u.status === "failed",
			)
			expect(terminalStatuses.map((u) => u.status)).toEqual(["failed"])
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"replays a still-running background call as running under the same ACP id on reload in the same harness process",
	async () => {
		const COMMAND = 'while [ ! -f acp-bg-reload ]; do sleep 0.05; done; echo ACP-BG-"RELOAD-8e9a"'
		const fixture = await startAcpFixture({
			artifactName: "bash-background-tool-calls-reload",
			responses: [
				{ toolCalls: [{ id: "spawn", function: { name: "bash", arguments: JSON.stringify({ command: COMMAND }) } }] },
				{ stream: ["The background command is launched."] },
				// Spare: the post-reload exit wakes the idle agent.
				{ stream: ["The background command finished after the reload."] },
			],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			const pending = prompt(fixture, sessionId, "Run the gated command in the background")
			const handoff = await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "tool_call_update" &&
					update.status === "in_progress" &&
					(JSON.stringify(update.rawOutput) ?? "").includes('"handoff":true'),
			)
			const liveAcpToolCallId = handoff.toolCallId
			expect((await pending).stopReason).toBe("end_turn")

			// Client reload, SAME harness process: loadSession replays the
			// transcript of the already-loaded session. The recorded result of
			// the call is its pre-exit handoff, but the process is still alive,
			// so the replay overlays the call as STILL RUNNING under the ACP id
			// the client already knows.
			const updatesBeforeReload = fixture.client.sessionUpdates.length
			await fixture.conn.loadSession({ sessionId, cwd: fixture.workDir, mcpServers: [] })
			const replayedToolCalls = fixture.client.sessionUpdates
				.slice(updatesBeforeReload)
				.filter(
					(u): u is { sessionId: string; update: Extract<SessionUpdate, { sessionUpdate: "tool_call" }> } =>
						u.sessionId === sessionId &&
						u.update.sessionUpdate === "tool_call" &&
						JSON.stringify(u.update.rawInput ?? {}).includes("acp-bg-reload"),
				)
			expect(replayedToolCalls).toHaveLength(1)
			expect(replayedToolCalls[0].update.toolCallId).toBe(liveAcpToolCallId)
			expect(replayedToolCalls[0].update.status).toBe("in_progress")
			// No terminal status for the call in the replay: the client never
			// sees a running process flip back and forth across its reload.
			expect(
				toolCallUpdatesFor(fixture.client.sessionUpdates.slice(updatesBeforeReload), sessionId, liveAcpToolCallId).some(
					(u) => u.status === "completed" || u.status === "failed",
				),
			).toBe(false)

			// The exit watcher still owns finality after the reload.
			writeFileSync(join(fixture.workDir, "acp-bg-reload"), "")
			const final = await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "tool_call_update" &&
					update.toolCallId === liveAcpToolCallId &&
					update.status === "completed",
			)
			expect(final.rawOutput).toMatchObject({
				details: { exited: true, exitCode: 0 },
			})
			expect(JSON.stringify(final.rawOutput)).toContain("ACP-BG-RELOAD-8e9a")
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"holds the running call across turns: recycled upstream ids get fresh ACP ids, steering works, and the later exit settles it",
	async () => {
		const COMMAND = 'while [ ! -f acp-bg-hold ]; do sleep 0.05; done; echo ACP-BG-"HELD-3d4f"'
		const STEER_METHOD = "_kimchi.dev/steering"
		const fixture = await startAcpFixture({
			artifactName: "bash-background-tool-calls-cross-turn",
			responses: [
				// Turn 1: launch the gated background command, then end the turn.
				{ toolCalls: [{ id: "spawn", function: { name: "bash", arguments: JSON.stringify({ command: COMMAND }) } }] },
				{ stream: ["The background command is launched."] },
				// Turn 2: slow stream keeps the turn live while a steer lands. The
				// stream carries a tool call — the model reuses the SAME upstream
				// tool call id ("spawn") for an unrelated read — because pi only
				// injects a queued steer at a real turn boundary; a text-only slow
				// stream never yields one and the steer would sit queued past turn
				// end, its answer never streaming.
				{
					stream: ["Reading while it runs. ", ...Array.from({ length: 5 }, () => "Still reading. ")],
					textDelayMs: 300,
					toolCalls: [{ id: "spawn", function: { name: "read", arguments: JSON.stringify({ path: "note.txt" }) } }],
				},
				// The steered question is answered (text-only response) at the
				// injection boundary the recycled-id read created above.
				{ stream: ["2+2 is 4. "] },
				// Consumed by the exit wake run, not turn 2 (the steer answer ends
				// the turn: no tool calls, no queued steers).
				{ stream: ["Reading complete."] },
				// Spare: the exit wakes the idle agent.
				{ stream: ["The background command finished."] },
			],
		})
		try {
			writeFileSync(join(fixture.workDir, "note.txt"), "cross-turn note contents")
			const sessionId = await newSession(fixture, fixture.workDir)
			const first = await prompt(fixture, sessionId, "Run the gated command in the background")
			expect(first.stopReason).toBe("end_turn")
			const handoff = await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "tool_call_update" &&
					update.status === "in_progress" &&
					(JSON.stringify(update.rawOutput) ?? "").includes('"handoff":true'),
			)
			const heldAcpToolCallId = handoff.toolCallId

			// Turn 2 runs with the process alive: steering injects into the
			// active turn unchanged (status: injected, stopReason end_turn).
			const secondPending = fixture.conn.prompt({
				sessionId,
				prompt: [{ type: "text", text: "Read the note while the command keeps running" }],
			})
			await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text" &&
					update.content.text.includes("Reading while it runs"),
			)
			expect(
				await fixture.conn.extMethod(STEER_METHOD, { sessionId, prompt: "Quick question: what is 2+2?" }),
			).toMatchObject({ status: "injected" })
			expect((await secondPending).stopReason).toBe("end_turn")
			expect(fixture.client.agentTextBySession().get(sessionId)).toContain("2+2 is 4")
			// The read really happened with the process still alive.
			const finalHistory = JSON.stringify(
				fixture.fake.requests.filter((request) => request.url.endsWith("/chat/completions")).at(-1)?.body,
			)
			expect(finalHistory).toContain("cross-turn note contents")

			// The recycled upstream id "spawn" produced a FRESH ACP id — no
			// collision with the held background call.
			const readCalls = fixture.client.sessionUpdates.filter(
				(u): u is { sessionId: string; update: Extract<SessionUpdate, { sessionUpdate: "tool_call" }> } =>
					u.sessionId === sessionId &&
					u.update.sessionUpdate === "tool_call" &&
					JSON.stringify(u.update.rawInput ?? {}).includes("note.txt"),
			)
			expect(readCalls).toHaveLength(1)
			expect(readCalls[0].update.toolCallId).not.toBe(heldAcpToolCallId)
			// And the held call rode through the whole exchange untouched.
			expect(hasTerminalUpdate(fixture.client.sessionUpdates, sessionId, heldAcpToolCallId)).toBe(false)

			// The process exits at idle → the held call settles completed.
			writeFileSync(join(fixture.workDir, "acp-bg-hold"), "")
			const final = await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "tool_call_update" &&
					update.toolCallId === heldAcpToolCallId &&
					update.status === "completed",
			)
			expect(final.rawOutput).toMatchObject({
				details: { exited: true, exitCode: 0 },
			})
			expect(JSON.stringify(final.rawOutput)).toContain("ACP-BG-HELD-3d4f")
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)
