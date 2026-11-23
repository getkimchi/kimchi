import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import {
	fullText,
	STARTUP_TIMEOUT_MS,
	STREAM_TIMEOUT_MS,
	waitForText,
	waitForTurnToSettle,
} from "./support/assertions.js"
import { launchKimchi, PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const DATETIME_UTC = /20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GMT\+0/
const DATETIME_ANY_OFFSET = /20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GMT[+-]\d+/
const HISTORICAL_MS = Date.parse("2020-01-02T03:04:05.000Z")
const HISTORICAL_ISO = "2020-01-02T03:04:05.000Z"
const HISTORICAL_LABEL = "2020-01-02 03:04:05 GMT+0"
const EXIT_MARKER = "__TIMESTAMPS_EXITED__"

function enableUtcTimestamps(homeDir: string, workDir: string): void {
	const configPath = join(homeDir, ".config", "kimchi", "config.json")
	const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>
	config.tui = { timestamps: true, timezone: "UTC" }
	writeFileSync(configPath, JSON.stringify(config, null, "\t"))
	writeFileSync(join(workDir, "timestamp-target.txt"), "timestamp fixture")
}

function persistHistoricalTimes(agentDir: string): void {
	const sessionsRoot = join(agentDir, "sessions")
	const sessionFiles = readdirSync(sessionsRoot, { recursive: true }).filter(
		(entry): entry is string => typeof entry === "string" && entry.endsWith(".jsonl"),
	)
	expect(sessionFiles).toHaveLength(1)
	const sessionPath = join(sessionsRoot, sessionFiles[0])
	const entries = readFileSync(sessionPath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>)
	for (const entry of entries) {
		entry.timestamp = HISTORICAL_ISO
		const message = entry.message as { role?: string; timestamp?: number } | undefined
		if (message && ["user", "assistant", "toolResult", "bashExecution"].includes(message.role ?? "")) {
			message.timestamp = HISTORICAL_MS
		}
	}
	writeFileSync(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`)
}

test("transcript timestamps are absent by default", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "timestamps-default-off",
			responses: [{ stream: ["Response without timestamps."] }],
		},
		async () => {
			terminal.submit("Show the default")
			await waitForText(terminal, "Response without timestamps.", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(fullText(terminal)).not.toMatch(DATETIME_UTC)
		},
	)
})

test("UTC timestamps surround live activity and preserve historical time on replay", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "timestamps-live-and-replay",
			exitMarker: EXIT_MARKER,
			seedHome: enableUtcTimestamps,
			responses: [
				{
					toolCalls: [
						{
							id: "call_timestamp_read",
							function: { name: "read", arguments: JSON.stringify({ path: "timestamp-target.txt" }) },
						},
					],
				},
				{ stream: ["Timestamped response."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Read the timestamp fixture")
			await waitForText(terminal, "Timestamped response.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			const live = fullText(terminal)
			expect(live).toMatch(DATETIME_UTC)
			expect(live.split(DATETIME_UTC).length - 1).toBeGreaterThanOrEqual(3)
			expect(live.indexOf("Read the timestamp fixture")).toBeGreaterThan(-1)
			expect(live.indexOf("timestamp-target.txt")).toBeGreaterThan(-1)
			trace.step("live prompt, completed tool, and response render with UTC datetime labels")

			terminal.submit("!printf replay-bash-output")
			await waitForText(terminal, (text) => text.split("replay-bash-output").length - 1 >= 2, {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			trace.step("bash execution completed and was persisted for replay")

			terminal.submit("/quit")
			await waitForText(terminal, EXIT_MARKER, { timeoutMs: STARTUP_TIMEOUT_MS })
			persistHistoricalTimes(fixture.agentDir)
			launchKimchi(terminal, fixture, ["--continue"])
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
			await waitForText(terminal, "Timestamped response.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, HISTORICAL_LABEL, { timeoutMs: STREAM_TIMEOUT_MS })
			const replayed = fullText(terminal)
			expect(replayed).toContain(HISTORICAL_LABEL)
			expect(replayed).toContain("Timestamped response.")
			expect(replayed).toContain("timestamp-target.txt")
			expect(replayed).toContain("replay-bash-output")
			expect(replayed).toContain("bash completed ·")
			trace.step("--continue replays stored message, tool-result, and bash times rather than resume time")
		},
	)
})

test("/timestamps redraws the current transcript and persists without restart", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "timestamps-slash-command",
			responses: [{ stream: ["First plain response."] }, { stream: ["Second plain response."] }],
		},
		async (fixture, trace) => {
			terminal.submit("Start without timestamps")
			await waitForText(terminal, "First plain response.", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(fullText(terminal)).not.toMatch(DATETIME_ANY_OFFSET)

			terminal.submit("/timestamps on")
			await waitForText(terminal, "Transcript timestamps: on", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, DATETIME_ANY_OFFSET, { timeoutMs: STREAM_TIMEOUT_MS })
			expect(fullText(terminal).split(DATETIME_ANY_OFFSET).length - 1).toBeGreaterThanOrEqual(2)
			trace.step("slash command enables labels on the existing prompt and response")

			terminal.submit("/timestamps timezone UTC")
			await waitForText(terminal, "timezone: UTC", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, DATETIME_UTC, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("timezone change redraws existing labels in UTC")

			terminal.submit("/timestamps off")
			await waitForText(terminal, "Transcript timestamps: off", { timeoutMs: STREAM_TIMEOUT_MS })
			const labelsBeforeSecondTurn = fullText(terminal).split(DATETIME_UTC).length - 1
			terminal.submit("Second turn stays plain")
			await waitForText(terminal, "Second plain response.", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(fullText(terminal).split(DATETIME_UTC).length - 1).toBe(labelsBeforeSecondTurn)
			trace.step("slash command disables labels for subsequent activity")

			const config = JSON.parse(readFileSync(join(fixture.homeDir, ".config", "kimchi", "config.json"), "utf8")) as {
				tui?: { timestamps?: boolean; timezone?: string }
			}
			expect(config.tui).toMatchObject({ timestamps: false, timezone: "UTC" })
		},
	)
})
