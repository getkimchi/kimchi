import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, Key, test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { launchKimchi, PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("new session drains cancelled Bash work and resuming the old session starts with an empty cohort", async ({
	terminal,
}) => {
	const exitMarker = "__BASH_LIFECYCLE_EXITED__"
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-session-lifecycle",
			exitMarker,
			responses: [
				{
					toolCalls: [
						{
							id: "spawn",
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: 'echo "$$" > lifecycle.pid; sleep 600 & wait' }),
							},
						},
					],
				},
				{
					stream: ["Waiting for lifecycle work."],
					toolCalls: [{ id: "wait", function: { name: "bash_control", arguments: JSON.stringify({ wait: true }) } }],
				},
				{
					toolCalls: [
						{ id: "read-new", function: { name: "read", arguments: JSON.stringify({ path: "independent.txt" }) } },
					],
				},
				{ stream: ["New session has no Bash cohort."] },
				{
					toolCalls: [
						{ id: "read-resumed", function: { name: "read", arguments: JSON.stringify({ path: "independent.txt" }) } },
					],
				},
				{ stream: ["Resumed session has no Bash cohort."] },
			],
		},
		async (fixture, trace) => {
			writeFileSync(join(fixture.workDir, "independent.txt"), "independent work")
			terminal.submit("Start a long Bash command and wait")
			await waitForText(terminal, "Bash Control", { timeoutMs: STREAM_TIMEOUT_MS })
			const pid = Number(readFileSync(join(fixture.workDir, "lifecycle.pid"), "utf8").trim())
			const sessionsDir = join(fixture.agentDir, "sessions")
			const sessionFile = readdirSync(sessionsDir, { recursive: true }).find(
				(file) => typeof file === "string" && file.endsWith(".jsonl"),
			)
			if (typeof sessionFile !== "string") throw new Error("Missing persisted session")
			const sessionId = JSON.parse(readFileSync(join(sessionsDir, sessionFile), "utf8").split("\n")[0]).id
			if (typeof sessionId !== "string") throw new Error("Missing session id")
			terminal.keyPress(Key.Escape)
			await waitForText(terminal, /[Oo]peration (?:was )?aborted/, { timeoutMs: STREAM_TIMEOUT_MS })
			process.kill(pid, 0)
			trace.step("cancelled wait leaves managed work alive")
			terminal.submit("/new")
			await waitForText(terminal, "New session started", { timeoutMs: STARTUP_TIMEOUT_MS })
			expect(() => process.kill(pid, 0)).toThrow()
			trace.step("new session drains the old cohort")
			terminal.submit("Read independent.txt")
			await waitForText(terminal, "New session has no Bash cohort.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			expect(
				fixture.fake.requests.filter((request) => request.url.endsWith("/chat/completions")).at(-1)?.body,
			).toMatchObject({
				tools: expect.arrayContaining([
					expect.objectContaining({ function: expect.objectContaining({ name: "bash_control" }) }),
				]),
			})
			terminal.submit("/quit")
			await waitForText(terminal, exitMarker, { timeoutMs: STARTUP_TIMEOUT_MS })
			launchKimchi(terminal, fixture, ["-r", sessionId])
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
			terminal.submit("Read independent.txt in the resumed session")
			await waitForText(terminal, "Resumed session has no Bash cohort.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			expect(
				fixture.fake.requests.filter((request) => request.url.endsWith("/chat/completions")).at(-1)?.body,
			).toMatchObject({
				tools: expect.arrayContaining([
					expect.objectContaining({ function: expect.objectContaining({ name: "bash_control" }) }),
				]),
			})
			trace.step("resume has no live handles or stale completion guard")
		},
	)
})
