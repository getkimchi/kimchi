import { expect, it } from "vitest"
import { STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitFor, waitForSessionUpdate } from "./support/scenarios.js"

const RUN_START_METHOD = "_kimchi.dev/background_run_start"
const RUN_END_METHOD = "_kimchi.dev/background_run_end"

/** Quiet window with no new boundary notifications, to prove no extra wake. */
const QUIET_MS = 2_000

function runBoundaries(fixture: Awaited<ReturnType<typeof startAcpFixture>>) {
	return {
		starts: () => fixture.client.extNotifications.filter((n) => n.method === RUN_START_METHOD),
		ends: () => fixture.client.extNotifications.filter((n) => n.method === RUN_END_METHOD),
	}
}

// An agent-initiated run (a background-bash exit waking the idle
// agent) announces its boundary over ACP — background_run_start with the wake reason
// BEFORE the run's streamed output, background_run_end with the stopReason AFTER it —
// while prompt-owned turns emit neither.
it(
	"background-task completion wake emits background_run_start (reason) and background_run_end (stopReason) around its streamed output",
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
			// background_run_end lands after the run's last chunk.
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
			expect(runEnds[0].params).toMatchObject({ sessionId, state: "idle", stopReason: "end_turn" })

			// Ordering on the wire: background_run_start opens before any of the run's
			// streamed chunks, background_run_end closes after its last one. The scripted
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
		// The fixture's client opts into background runs by default (it
		// mimics Studio); a prompt-owned turn must still emit no boundary.
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

it(
	"a restored session's background completion still wakes with run boundaries",
	async () => {
		const fixture = await startAcpFixture({
			artifactName: "run-boundary-restored-wake",
			responses: [
				{
					toolCalls: [
						{
							id: "spawn",
							function: { name: "bash", arguments: JSON.stringify({ command: 'sleep 3 && echo "RB-RESTORE-7c2e"' }) },
						},
					],
				},
				{ stream: ["Background watcher started. "] },
				{ stream: ["Restored wake fired. "] },
			],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			expect((await prompt(fixture, sessionId, "Start a background watcher")).stopReason).toBe("end_turn")

			// Restore the session mid-run (session/load) BEFORE the exit: the
			// replay emits no boundary, and the live process's exit must still
			// wake the agent with its own bracketed run.
			await fixture.conn.loadSession({ sessionId, cwd: fixture.workDir, mcpServers: [] })

			await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text" &&
					update.content.text.includes("Restored wake fired"),
				45_000,
			)
			await waitFor(
				() => runBoundaries(fixture).ends(),
				(ends) => ends.length > 0,
				45_000,
			)

			const { starts, ends } = runBoundaries(fixture)
			expect(starts()).toHaveLength(1)
			expect(ends()).toHaveLength(1)
			expect(starts()[0].params).toMatchObject({ sessionId, reason: "background-task-complete" })
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"a cancelled wake ends the run (cancelled) and does not re-wake",
	async () => {
		const fixture = await startAcpFixture({
			artifactName: "run-boundary-cancelled-wake",
			responses: [
				{
					toolCalls: [
						{
							id: "spawn",
							function: { name: "bash", arguments: JSON.stringify({ command: 'sleep 2 && echo "RB-CANCEL-3f9a"' }) },
						},
					],
				},
				{ stream: ["Background watcher started. "] },
				// Slow wake stream so the cancel lands mid-run.
				{ stream: Array.from({ length: 40 }, (_, i) => `wake-chunk-${i} `), delayMs: 150 },
			],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			expect((await prompt(fixture, sessionId, "Start a background watcher")).stopReason).toBe("end_turn")

			await waitFor(
				() => runBoundaries(fixture).starts(),
				(starts) => starts.length > 0,
				45_000,
			)
			await fixture.conn.cancel({ sessionId })
			await waitFor(
				() => runBoundaries(fixture).ends(),
				(ends) => ends.length > 0,
				45_000,
			)

			const { starts, ends } = runBoundaries(fixture)
			expect(ends()[0].params).toMatchObject({ sessionId, stopReason: "cancelled" })
			// No re-wake after the cancel (a suppression regression would fire
			// another run_start once the scripted response exhausted).
			await new Promise((resolve) => setTimeout(resolve, QUIET_MS))
			expect(starts()).toHaveLength(1)
			expect(ends()).toHaveLength(1)
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)

it("a background exit during an in-flight prompt is steered into that turn, not a wake", async () => {
	const fixture = await startAcpFixture({
		artifactName: "run-boundary-wake-after-prompt",
		responses: [
			{
				toolCalls: [
					{
						id: "spawn",
						function: { name: "bash", arguments: JSON.stringify({ command: 'sleep 2 && echo "RB-MIDPROMPT-5d1b"' }) },
					},
				],
			},
			{ stream: ["Background watcher started. "] },
			// Second prompt: 20 chunks x 200 ms ≈ 4 s — the exit at ~2 s
			// lands squarely inside this turn. Its completion notification
			// is delivered as a steer INTO the running turn (deliverAs:
			// "steer" continues the run the exit landed in), so no
			// agent-initiated wake — and no run boundary — may appear.
			{ stream: Array.from({ length: 20 }, (_, i) => `prompt-chunk-${i} `), delayMs: 200 },
		],
	})
	try {
		const sessionId = await newSession(fixture, fixture.workDir)
		expect((await prompt(fixture, sessionId, "Start a background watcher")).stopReason).toBe("end_turn")
		expect((await prompt(fixture, sessionId, "Talk to me for a while")).stopReason).toBe("end_turn")

		// Past the exit window: the settle updated its held tool call,
		// but no wake run was announced (the steer rode the prompt turn).
		await new Promise((resolve) => setTimeout(resolve, QUIET_MS))
		const { starts, ends } = runBoundaries(fixture)
		expect(starts()).toHaveLength(0)
		expect(ends()).toHaveLength(0)
	} finally {
		await fixture.stop()
	}
}, 90_000)

it("batched background exits produce a single wake", async () => {
	const fixture = await startAcpFixture({
		artifactName: "run-boundary-batched-exits",
		responses: [
			// Sequential tool rounds of one prompt: both watchers spawn at
			// ~the same time, so their exits land in one batch window.
			{
				toolCalls: [
					{
						id: "spawn-a",
						function: { name: "bash", arguments: JSON.stringify({ command: 'sleep 3 && echo "RB-BATCH-A"' }) },
					},
				],
			},
			{
				toolCalls: [
					{
						id: "spawn-b",
						function: { name: "bash", arguments: JSON.stringify({ command: 'sleep 3 && echo "RB-BATCH-B"' }) },
					},
				],
			},
			{ stream: ["Two watchers started. "] },
			{ stream: ["Both watchers finished. "] },
		],
	})
	try {
		const sessionId = await newSession(fixture, fixture.workDir)
		expect((await prompt(fixture, sessionId, "Start two background watchers")).stopReason).toBe("end_turn")

		await waitForSessionUpdate(
			fixture,
			sessionId,
			(update) =>
				update.sessionUpdate === "agent_message_chunk" &&
				update.content.type === "text" &&
				update.content.text.includes("Both watchers finished"),
			45_000,
		)
		await waitFor(
			() => runBoundaries(fixture).ends(),
			(ends) => ends.length > 0,
			45_000,
		)

		// Two exits inside the batch window → exactly one wake, no runaway.
		await new Promise((resolve) => setTimeout(resolve, QUIET_MS))
		const { starts, ends } = runBoundaries(fixture)
		expect(starts()).toHaveLength(1)
		expect(ends()).toHaveLength(1)
	} finally {
		await fixture.stop()
	}
}, 90_000)
