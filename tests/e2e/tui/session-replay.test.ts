import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { expect, test } from "@microsoft/tui-test"
import { viewText, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { toolResultText } from "./support/mcp-model-script.js"

interface ExportedRecording {
	metadata: { sessionId: string; part: number; rawBytes: number }
	gzip: string
	traceDetailsGzip?: string
	traceDetails?: Record<string, { fields: Record<string, string>; content?: string; diagnostics?: string }>
}

function recordingPayload(path: string): ExportedRecording[] {
	const html = readFileSync(path, "utf8")
	const document = html.match(/id="terminal-replay-document" type="application\/json">([^<]+)/)?.[1]
	if (!document) throw new Error("Export did not contain a terminal replay")
	const player = JSON.parse(document)
	const payload = player.match(/id="recordings" type="application\/json">([^<]+)/)?.[1]
	if (!payload) throw new Error("Recording payload missing")
	return JSON.parse(payload).map((recording: ExportedRecording) => ({
		...recording,
		traceDetails: recording.traceDetailsGzip
			? JSON.parse(gunzipSync(Buffer.from(recording.traceDetailsGzip, "base64")).toString("utf8"))
			: recording.traceDetails,
	}))
}

function decodedCast(recording: { gzip: string }): string {
	return gunzipSync(Buffer.from(recording.gzip, "base64")).toString("utf8")
}

function recordedSteps(recording: { gzip: string }): {
	step: number
	kind: string
	title: string
	detail: string
	error?: boolean
	toolCallId?: string
	messageTimestamp?: number
	responseId?: string
	frame: boolean
	delayMs: number
}[] {
	return decodedCast(recording)
		.trim()
		.split("\n")
		.slice(1)
		.map((line) => JSON.parse(line))
		.filter((event) => event[1] === "m")
		.map((event) => JSON.parse(event[2]))
		.filter((event) => event.type === "kimchi.trace" && event.version === 1)
}

test.use(TUI_TEST_CONFIG)

test("exports recorded terminal output only after choosing replay", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "session-terminal-replay",
			responses: [
				{ stream: ["The visible output is ", "REPLAY_STREAM_COMPLETE."], textDelayMs: 150 },
				{ stream: ["SECOND_SESSION_REPLAY_READY."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Show the replay marker")
			await waitForText(terminal, "REPLAY_STREAM_COMPLETE.")
			await waitForTurnToSettle(fixture.fake.requests)
			terminal.resize(100, 35)
			const htmlPath = join(fixture.workDir, "with-replay.html")
			terminal.submit(`/export ${htmlPath}`)
			await waitForText(terminal, "Include terminal replay?", { full: false })
			trace.step("explicit raw-recording choice")
			terminal.keyDown()
			terminal.submit("")
			await waitForText(terminal, /Session exported to:\s+\S*with-replay\.html/)
			const recordings = recordingPayload(htmlPath)
			const cast = decodedCast(recordings[recordings.length - 1])
			expect(cast).toContain("REPLAY_STREAM_COMPLETE")
			expect(cast).toContain('"r","100x35"')
			expect(cast).toContain("\\u001b[")
			const steps = recordings.flatMap(recordedSteps)
			expect(steps.some((step) => step.kind === "prompt" && step.detail.includes("Show the replay marker"))).toBe(true)
			expect(steps.some((step) => step.kind === "response" && step.detail.includes("REPLAY_STREAM_COMPLETE."))).toBe(
				true,
			)
			trace.step("HTML contains actual output, resize and linked prompt/response steps")

			const transcriptPath = join(fixture.workDir, "transcript-only.html")
			terminal.submit(`/export ${transcriptPath}`)
			await waitForText(terminal, "Include terminal replay?", { full: false })
			terminal.submit("")
			await waitForText(terminal, /Session exported to:\s+\S*transcript-only\.html/)
			expect(readFileSync(transcriptPath, "utf8")).not.toContain('id="terminal-replay-document"')
			trace.step("default transcript-only choice excludes raw output")

			terminal.submit("/new")
			await waitForText(terminal, "New session started", { full: false })
			terminal.submit("Show the second session marker")
			await waitForText(terminal, "SECOND_SESSION_REPLAY_READY.")
			await waitForTurnToSettle(fixture.fake.requests)
			const nextPath = join(fixture.workDir, "next-session.html")
			terminal.submit(`/export ${nextPath}`)
			await waitForText(terminal, "Include terminal replay?", { full: false })
			terminal.keyDown()
			terminal.submit("")
			await waitForText(terminal, /Session exported to:\s+\S*next-session\.html/)
			const next = recordingPayload(nextPath)
			expect(next).toHaveLength(1)
			expect(next[0].metadata.sessionId).not.toBe(recordings[0].metadata.sessionId)
			const nextCast = decodedCast(next[0])
			expect(nextCast).toContain("SECOND_SESSION_REPLAY_READY")
			expect(nextCast).not.toContain("REPLAY_STREAM_COMPLETE")
			const nextSteps = next.flatMap(recordedSteps)
			expect(
				nextSteps.some((step) => step.kind === "response" && step.detail.includes("SECOND_SESSION_REPLAY_READY.")),
			).toBe(true)
			expect(nextSteps.some((step) => step.detail.includes("Show the replay marker"))).toBe(false)
			trace.step("session replacement starts a fresh recording without old output or trace steps")
		},
	)
})

test("links a failed tool and recovery to the recorded terminal frames", async ({ terminal }) => {
	const failedId = "replay-failed-tool"
	const recoveredId = "replay-recovered-tool"
	await runKimchiSession(
		terminal,
		{
			artifactName: "session-replay-failed-tool",
			seedHome: (_home, workDir) => writeFileSync(join(workDir, "existing-demo.txt"), "REPLAY_EXISTING_FILE_OK\n"),
			responses: [
				{
					toolCalls: [
						{ id: failedId, function: { name: "read", arguments: JSON.stringify({ path: "missing-demo.txt" }) } },
					],
				},
				{
					toolCalls: [
						{ id: recoveredId, function: { name: "read", arguments: JSON.stringify({ path: "existing-demo.txt" }) } },
					],
				},
				{
					stream: ["REPLAY_RECOVERED: the existing file was read."],
					usage: { prompt_tokens: 128, completion_tokens: 24 },
				},
			],
		},
		async (fixture, trace) => {
			terminal.submit("Read missing-demo.txt, then read existing-demo.txt and recover")
			await waitForText(terminal, "REPLAY_RECOVERED")
			await waitForTurnToSettle(fixture.fake.requests)
			expect(toolResultText(fixture.fake.requests, failedId)).toMatch(/ENOENT|no such file|not found/i)
			expect(toolResultText(fixture.fake.requests, recoveredId)).toContain("REPLAY_EXISTING_FILE_OK")
			trace.step("a real tool failure reached the next model request and the session recovered")
			const path = join(fixture.workDir, "failed-tool-replay.html")
			terminal.submit(`/export ${path}`)
			await waitForText(terminal, "Include terminal replay?", { full: false })
			terminal.keyDown()
			terminal.submit("")
			await waitForText(terminal, /Session exported to:\s+\S*failed-tool-replay\.html/)
			const recordings = recordingPayload(path)
			const steps = recordings.flatMap(recordedSteps)
			const call = steps.find((step) => step.kind === "tool_call" && step.toolCallId === failedId)
			const result = steps.find((step) => step.kind === "tool_result" && step.toolCallId === failedId)
			const recoveredResult = steps.find((step) => step.kind === "tool_result" && step.toolCallId === recoveredId)
			const prompt = steps.find((step) => step.kind === "prompt" && step.detail.includes("Read missing-demo.txt"))
			const recovery = steps.find((step) => step.kind === "response" && step.detail.includes("REPLAY_RECOVERED"))
			expect(prompt).toBeDefined()
			expect(call).toBeDefined()
			expect(result).toBeDefined()
			expect(recoveredResult).toBeDefined()
			expect(recovery).toBeDefined()
			if (!prompt || !call || !result || !recoveredResult || !recovery)
				throw new Error("Expected prompt, tool call, failure and recovery steps")
			expect({ toolCallId: result.toolCallId, error: result.error }).toEqual({ toolCallId: failedId, error: true })
			expect(result.detail).toMatch(/ENOENT|no such file|not found/i)
			expect(recoveredResult.error).toBe(false)
			expect(recoveredResult.detail).toContain("REPLAY_EXISTING_FILE_OK")
			expect(prompt.step).toBeLessThan(call.step)
			expect(call.step).toBeLessThan(result.step)
			expect(result.step).toBeLessThan(recoveredResult.step)
			expect(recoveredResult.step).toBeLessThan(recovery.step)
			expect(new Set(steps.map((step) => step.step)).size).toBe(steps.length)
			expect(prompt.messageTimestamp).toBeGreaterThan(0)
			expect(recovery.messageTimestamp).toBeGreaterThan(0)
			expect(recovery.responseId).toBe("chatcmpl_fake")
			const savedDetails = new Map(recordings.flatMap((recording) => Object.entries(recording.traceDetails ?? {})))
			const savedRecovery = savedDetails.get(String(recovery.step))
			expect(savedRecovery).toBeDefined()
			expect(savedRecovery?.fields).toEqual(
				expect.objectContaining({
					Model: "basic",
					Provider: "fake",
					"Stop reason": "stop",
					"Input tokens": "128",
					"Output tokens": "24",
					"Response ID": "chatcmpl_fake",
				}),
			)
			expect(savedRecovery?.content).toContain("REPLAY_RECOVERED")
			expect(savedRecovery?.diagnostics).toContain("request_diagnostics")
			expect(savedDetails.get(String(result.step))?.content).toMatch(/ENOENT|no such file|not found/i)
			for (const step of [prompt, call, result, recoveredResult, recovery]) {
				expect({ step: step.step, kind: step.kind, frame: step.frame }).toEqual({
					step: step.step,
					kind: step.kind,
					frame: true,
				})
				expect(step.delayMs).toBeGreaterThanOrEqual(0)
			}
			trace.step("export links ordered steps to frames and keeps the failed tool call ID and error detail")
		},
	)
})

test("keeps recording after a full part and exports the continued screen", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "session-replay-parts",
			responses: [{ stream: ["BEFORE_ROTATION_VISIBLE."] }, { stream: ["AFTER_ROTATION_TRACE_READY."] }],
			trustWorkDir: true,
			seedHome: (_home, workDir) => {
				const extensions = join(workDir, ".config/kimchi/harness/extensions")
				mkdirSync(extensions, { recursive: true })
				writeFileSync(
					join(extensions, "replay-part-burst.js"),
					readFileSync(new URL("./support/fixtures/replay-part-burst.js", import.meta.url)),
				)
			},
		},
		async (fixture, trace) => {
			terminal.submit("Show the marker before recording continues")
			await waitForText(terminal, "BEFORE_ROTATION_VISIBLE.")
			await waitForTurnToSettle(fixture.fake.requests)
			terminal.submit("/replay-part-burst")
			await waitForText(terminal, "REPLAY_PART_TWO_READY", { timeoutMs: 35000 })
			trace.step("recording continued after the default 32 MiB part filled")
			terminal.submit("Show the marker after recording continues")
			await waitForText(terminal, "AFTER_ROTATION_TRACE_READY.")
			await waitForTurnToSettle(fixture.fake.requests)
			const htmlPath = join(fixture.workDir, "continued-replay.html")
			terminal.submit(`/export ${htmlPath}`)
			await waitForText(terminal, "Include terminal replay?", { full: false })
			terminal.keyDown()
			terminal.submit("")
			await waitForText(terminal, /Session exported to:\s+\S*continued-replay\.html/)
			const parts = recordingPayload(htmlPath)
			expect(parts).toHaveLength(2)
			expect(parts[0].metadata.rawBytes).toBeGreaterThan(31 * 1024 * 1024)
			expect(parts[1].metadata.part).toBe(2)
			expect(decodedCast(parts[1])).toContain("BEFORE_ROTATION_VISIBLE")
			expect(decodedCast(parts[1])).toContain("REPLAY_PART_TWO_READY")
			const firstSteps = recordedSteps(parts[0])
			const continuedSteps = recordedSteps(parts[1])
			expect(firstSteps.some((step) => step.detail.includes("BEFORE_ROTATION_VISIBLE."))).toBe(true)
			expect(continuedSteps.some((step) => step.detail.includes("AFTER_ROTATION_TRACE_READY."))).toBe(true)
			expect(continuedSteps.some((step) => step.detail.includes("BEFORE_ROTATION_VISIBLE."))).toBe(false)
			expect(Math.min(...continuedSteps.map((step) => step.step))).toBeGreaterThan(
				Math.max(...firstSteps.map((step) => step.step)),
			)
			trace.step("later part retains the preceding screen and carries only its own linked trace steps")
		},
	)
})

test("toggles terminal recording live from resources and retains earlier visits", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "session-replay-resource-toggle",
			responses: [
				{ stream: ["REPLAY_BEFORE_DISABLE."] },
				{ stream: ["REPLAY_WHILE_DISABLED."] },
				{ stream: ["REPLAY_AFTER_ENABLE."] },
			],
		},
		async (fixture, trace) => {
			const settingsPath = join(fixture.agentDir, "settings.json")
			const recordingRoot = join(fixture.agentDir, "terminal-recordings")
			const openRecordingToggle = async () => {
				terminal.submit("/resources")
				await waitForText(terminal, "Kimchi resources", { full: false })
				terminal.keyRight(3)
				await waitForText(terminal, "Built-in Kimchi feature modules.", { full: false })
				for (let index = 0; index < 30 && !viewText(terminal).includes("extensions.terminal-recording —"); index++) {
					terminal.keyDown()
					await new Promise((resolve) => setTimeout(resolve, 100))
				}
				await waitForText(terminal, "extensions.terminal-recording — Applies immediately.", { full: false })
			}
			terminal.submit("Record the first visible response")
			await waitForText(terminal, "REPLAY_BEFORE_DISABLE.")
			await waitForTurnToSettle(fixture.fake.requests)
			await openRecordingToggle()
			await waitForText(terminal, /Terminal recording\s+enabled/, { full: false })
			terminal.submit("")
			await waitForText(terminal, /Terminal recording\s+disabled/, { full: false })
			expect(JSON.parse(readFileSync(settingsPath, "utf8")).terminalRecording).toBe(false)
			terminal.keyEscape()
			await waitForTurnToSettle(fixture.fake.requests)
			const oldSlots = readdirSync(recordingRoot).filter((name) => name.startsWith("slot-"))
			expect(oldSlots).toHaveLength(1)
			const oldSlot = join(recordingRoot, oldSlots[0])
			expect(JSON.parse(readFileSync(join(oldSlot, "metadata.json"), "utf8")).status).toBe("complete")
			const oldOutput = readFileSync(join(oldSlot, "output.bin"))
			terminal.submit("This prompt must not create a recorded trace step")
			await waitForText(terminal, "REPLAY_WHILE_DISABLED.")
			await waitForTurnToSettle(fixture.fake.requests)
			expect(readFileSync(join(oldSlot, "output.bin")).equals(oldOutput)).toBe(true)
			expect(readdirSync(recordingRoot).filter((name) => name.startsWith("slot-"))).toHaveLength(1)
			trace.step("resources disabled capture immediately; the existing recording stopped growing")
			await openRecordingToggle()
			await waitForText(terminal, /Terminal recording\s+disabled/, { full: false })
			terminal.submit("")
			await waitForText(terminal, /Terminal recording\s+enabled/, { full: false })
			expect(JSON.parse(readFileSync(settingsPath, "utf8")).terminalRecording).toBe(true)
			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { full: false })
			terminal.submit("Record again after enabling")
			await waitForText(terminal, "REPLAY_AFTER_ENABLE.")
			await waitForTurnToSettle(fixture.fake.requests)
			const path = join(fixture.workDir, "toggled-replay.html")
			terminal.submit(`/export ${path}`)
			await waitForText(terminal, "Include terminal replay?", { full: false })
			terminal.keyDown()
			terminal.submit("")
			await waitForText(terminal, /Session exported to:\s+\S*toggled-replay\.html/)
			const visits = recordingPayload(path)
			expect(visits).toHaveLength(2)
			expect(visits[0].metadata.sessionId).toBe(visits[1].metadata.sessionId)
			expect(decodedCast(visits[0])).toContain("REPLAY_BEFORE_DISABLE")
			expect(decodedCast(visits[0])).not.toContain("REPLAY_WHILE_DISABLED")
			const resumedEvents = decodedCast(visits[1])
				.trim()
				.split("\n")
				.slice(1)
				.map((line) => JSON.parse(line))
			const firstOutput = resumedEvents.find((event) => event[1] === "o")?.[2]
			expect(firstOutput).toContain("\u001b[2J")
			expect(
				visits.flatMap(recordedSteps).some((step) => step.detail.includes("must not create a recorded trace step")),
			).toBe(false)
			expect(recordedSteps(visits[1]).some((step) => step.detail.includes("REPLAY_AFTER_ENABLE."))).toBe(true)
			expect(readFileSync(join(oldSlot, "output.bin")).equals(oldOutput)).toBe(true)
			trace.step(
				"resources re-enabled capture with a full frame; export retains both visits and omits disabled trace steps",
			)
		},
	)
})
