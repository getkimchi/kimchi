import { expect, it } from "vitest"
import { STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitFor, waitForSessionUpdate } from "./support/scenarios.js"

const RUN_START_METHOD = "_kimchi.dev/run_start"
const RUN_END_METHOD = "_kimchi.dev/run_end"

// LLM-4486: an agent-initiated run (a background-bash exit waking the idle
// agent) announces its boundary over ACP — run_start with the wake reason
// BEFORE the run's streamed output, run_end with the outcome AFTER it —
// while prompt-owned turns emit neither.
it(
	"background-task completion wake emits run_start (reason) and run_end (outcome) around its streamed output",
	async () => {
		const fixture = await startAcpFixture({
			artifactName: "run-boundary-wake",
			responses: [
				// Turn 1: background a command that exits once the session is idle.
				{
					toolCalls: [
						{
							id: "spawn",
							// Outlives the scripted prompt turn, settles fast enough for a
							// loaded runner (batching window is 50 ms).
							function: { name: "bash", arguments: JSON.stringify({ command: 'sleep 3 && echo "RB-WAKE-42a1"' }) },
						},
					],
				},
				// Turn 1 continued: one streamed chunk, then the prompt resolves.
				{ stream: ["Background watcher started. "] },
				// Wake run (exit notification woke the idle agent): one chunk.
				{ stream: ["The watcher finished. "] },
			],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			const pending = prompt(fixture, sessionId, "Start a background watcher")
			expect((await pending).stopReason).toBe("end_turn")

			// The wake run's text arrives with no prompt in flight.
			await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text" &&
					update.content.text.includes("The watcher finished"),
				45_000,
			)
			// run_end lands after the run's last chunk.
			await waitFor(
				() => fixture.client.extNotifications,
				(notifications) => notifications.some((n) => n.method === RUN_END_METHOD),
				45_000,
			)

			const runStarts = fixture.client.extNotifications.filter((n) => n.method === RUN_START_METHOD)
			const runEnds = fixture.client.extNotifications.filter((n) => n.method === RUN_END_METHOD)
			// Exactly one run boundary: the prompt-owned turn emitted neither.
			expect(runStarts).toHaveLength(1)
			expect(runEnds).toHaveLength(1)
			expect(runStarts[0].params).toMatchObject({
				sessionId,
				state: "running",
				reason: "background-task-complete",
			})
			expect(runEnds[0].params).toMatchObject({ sessionId, state: "idle", outcome: "end_turn" })

			// Ordering on the wire: run_start opens before any of the run's
			// streamed chunks, run_end closes after its last one. The scripted
			// turn-1 chunk is the only chunk before the boundary; the wake chunk
			// is the only one inside it.
			const order = fixture.client.wireArrivalOrder
			const startIdx = order.indexOf(`ext-notification:${RUN_START_METHOD}`)
			const endIdx = order.indexOf(`ext-notification:${RUN_END_METHOD}`)
			expect(startIdx).toBeGreaterThanOrEqual(0)
			expect(endIdx).toBeGreaterThan(startIdx)
			const chunkIndices = order.map((label, i) => (label === "session-update:agent_message_chunk" ? i : -1))
			const firstChunkIdx = chunkIndices.find((i) => i >= 0)
			const lastChunkIdx = Math.max(...chunkIndices)
			expect(firstChunkIdx).toBeLessThan(startIdx)
			expect(chunkIndices.some((i) => i > startIdx && i < endIdx)).toBe(true)
			expect(lastChunkIdx).toBeLessThan(endIdx)

			expect(fixture.client.agentTextBySession().get(sessionId)).toContain("The watcher finished.")
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"prompt-owned turns emit no run-boundary notification",
	async () => {
		const fixture = await startAcpFixture({
			artifactName: "run-boundary-prompt-owned",
			responses: [{ stream: ["Plain answer. "] }],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			expect((await prompt(fixture, sessionId, "Say something plain")).stopReason).toBe("end_turn")
			expect(fixture.client.extNotifications.some((n) => n.method === RUN_START_METHOD)).toBe(false)
			expect(fixture.client.extNotifications.some((n) => n.method === RUN_END_METHOD)).toBe(false)
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)
