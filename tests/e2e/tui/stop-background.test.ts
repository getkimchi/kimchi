// Esc never stops background work by itself. When Esc finds work still
// running, Kimchi asks, and only a deliberate "Stop all" ends it.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, Key, test } from "@microsoft/tui-test"
import {
	INPUT_TIMEOUT_MS,
	STREAM_TIMEOUT_MS,
	viewText,
	waitForText,
	waitForTurnToSettle,
} from "./support/assertions.js"
import type { FakeResponseRequest } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const DIALOG_TITLE = "Background work is still running"
const UNEXPECTED = "UNEXPECTED: the model was woken"

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms))
}

async function readPid(path: string, timeoutMs = STREAM_TIMEOUT_MS): Promise<number> {
	const startedAt = Date.now()
	while (Date.now() - startedAt < timeoutMs) {
		if (existsSync(path)) {
			const text = readFileSync(path, "utf8").trim()
			if (text) return Number(text)
		}
		await sleep(100)
	}
	throw new Error(`Timed out waiting for ${path}`)
}

async function waitUntilGone(pids: number[], timeoutMs = STREAM_TIMEOUT_MS): Promise<void> {
	const startedAt = Date.now()
	while (Date.now() - startedAt < timeoutMs) {
		if (pids.every((pid) => !isAlive(pid))) return
		await sleep(100)
	}
	throw new Error(`Processes still alive: ${pids.filter(isAlive).join(", ")}`)
}

function killAll(pids: number[]): void {
	for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL")
}

// Main-agent turns carry tools; session captions and other side calls do not.
function agentTurnCount(requests: readonly FakeResponseRequest[]): number {
	return requests.filter(
		(request) =>
			request.url.endsWith("/chat/completions") &&
			request.body !== null &&
			typeof request.body === "object" &&
			"tools" in request.body &&
			Array.isArray(request.body.tools),
	).length
}

const BASH_COMMAND = 'echo "$$" > shell.pid; sleep 300 & echo "$!" > child.pid; wait'

const waitOnBackgroundCommand = [
	{ toolCalls: [{ id: "spawn", function: { name: "bash", arguments: JSON.stringify({ command: BASH_COMMAND }) } }] },
	{
		stream: ["Waiting for the sleep."],
		toolCalls: [{ id: "wait", function: { name: "bash_control", arguments: JSON.stringify({ wait: true }) } }],
	},
	{ stream: [UNEXPECTED] },
]

test("Esc during a wait on a background command asks, and Stop all ends it", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{ artifactName: "stop-background-command", responses: waitOnBackgroundCommand },
		async (fixture, trace) => {
			const pids: number[] = []
			try {
				terminal.submit("Run a long sleep and wait for it")
				pids.push(await readPid(join(fixture.workDir, "shell.pid")))
				pids.push(await readPid(join(fixture.workDir, "child.pid")))
				await waitForText(terminal, "Bash Control", { timeoutMs: STREAM_TIMEOUT_MS })
				terminal.keyPress(Key.Escape)
				await waitForText(terminal, DIALOG_TITLE, { timeoutMs: STREAM_TIMEOUT_MS })
				await waitForText(terminal, "1 command", { timeoutMs: INPUT_TIMEOUT_MS })
				trace.step("Esc ends the wait and asks about the running command")
				const turnsBefore = agentTurnCount(fixture.fake.requests)
				terminal.write("2")
				await waitUntilGone(pids)
				await waitForText(terminal, "Stopped 1 command", { timeoutMs: STREAM_TIMEOUT_MS })
				await waitForText(terminal, "Stopped ·", { timeoutMs: STREAM_TIMEOUT_MS })
				trace.step("Stop all ends the command and shows its final state")
				await waitForTurnToSettle(fixture.fake.requests)
				expect(agentTurnCount(fixture.fake.requests)).toBe(turnsBefore)
				expect(viewText(terminal)).not.toContain(UNEXPECTED)
				trace.step("stopping does not wake the model")
			} finally {
				killAll(pids)
			}
		},
	)
})

test("Esc on the dialog keeps the command running", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{ artifactName: "stop-background-keep", responses: waitOnBackgroundCommand },
		async (fixture, trace) => {
			const pids: number[] = []
			try {
				terminal.submit("Run a long sleep and wait for it")
				pids.push(await readPid(join(fixture.workDir, "shell.pid")))
				pids.push(await readPid(join(fixture.workDir, "child.pid")))
				await waitForText(terminal, "Bash Control", { timeoutMs: STREAM_TIMEOUT_MS })
				terminal.keyPress(Key.Escape)
				await waitForText(terminal, DIALOG_TITLE, { timeoutMs: STREAM_TIMEOUT_MS })
				trace.step("Esc ends the wait and asks")
				terminal.keyPress(Key.Escape)
				await waitForText(terminal, (text) => !text.includes(DIALOG_TITLE), {
					timeoutMs: INPUT_TIMEOUT_MS,
					full: false,
				})
				await sleep(1_000)
				for (const pid of pids) expect(isAlive(pid)).toBe(true)
				trace.step("Esc in the dialog keeps the command running")
			} finally {
				killAll(pids)
			}
		},
	)
})

test("Esc while idle with a background agent asks, and Stop all stops it", async ({ terminal }) => {
	const childCommand = 'echo "$$" > sub-shell.pid; sleep 300 & echo "$!" > sub-child.pid; wait'
	await runKimchiSession(
		terminal,
		{
			artifactName: "stop-background-agent",
			responses: [
				{
					toolCalls: [
						{
							id: "spawn-agent",
							function: {
								name: "Agent",
								arguments: JSON.stringify({
									prompt: "Run a long sleep",
									description: "long sleeper",
									subagent_type: "General-Purpose",
									run_in_background: true,
								}),
							},
						},
					],
				},
				{ stream: ["The agent runs in the background."] },
				{ stream: [UNEXPECTED] },
				{
					forSubagent: true,
					toolCalls: [
						{ id: "sub-bash", function: { name: "bash", arguments: JSON.stringify({ command: childCommand }) } },
					],
				},
				{ forSubagent: true, stream: ["child finished"] },
			],
		},
		async (fixture, trace) => {
			const pids: number[] = []
			try {
				terminal.submit("Start a background agent")
				pids.push(await readPid(join(fixture.workDir, "sub-shell.pid")))
				pids.push(await readPid(join(fixture.workDir, "sub-child.pid")))
				await waitForText(terminal, "The agent runs in the background.", { timeoutMs: STREAM_TIMEOUT_MS })
				await waitForTurnToSettle(fixture.fake.requests)
				trace.step("the parent turn ends while the agent runs")
				terminal.keyPress(Key.Escape)
				await waitForText(terminal, DIALOG_TITLE, { timeoutMs: STREAM_TIMEOUT_MS })
				await waitForText(terminal, "long sleeper", { timeoutMs: INPUT_TIMEOUT_MS })
				trace.step("Esc while idle asks about the running agent")
				const turnsBefore = agentTurnCount(fixture.fake.requests)
				terminal.write("2")
				await waitUntilGone(pids)
				await waitForText(terminal, "Stopped 1 agent", { timeoutMs: STREAM_TIMEOUT_MS })
				await waitForText(terminal, /long sleeper stopped/, { timeoutMs: STREAM_TIMEOUT_MS })
				trace.step("Stop all stops the agent and its command")
				await waitForTurnToSettle(fixture.fake.requests)
				expect(agentTurnCount(fixture.fake.requests)).toBe(turnsBefore)
				expect(viewText(terminal)).not.toContain(UNEXPECTED)
				trace.step("stopping does not wake the parent model")
			} finally {
				killAll(pids)
			}
		},
	)
})

test("Esc with nothing running behaves as before", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{ artifactName: "stop-background-nothing", responses: [{ stream: ["Nothing runs in the background."] }] },
		async (fixture, trace) => {
			terminal.submit("Say something")
			await waitForText(terminal, "Nothing runs in the background.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			terminal.keyPress(Key.Escape)
			await sleep(1_500)
			expect(viewText(terminal)).not.toContain(DIALOG_TITLE)
			trace.step("Esc while idle with nothing running opens no dialog")
		},
	)
})
