/**
 * Print-process mid-turn compaction regression.
 *
 * A non-ferment --print tool chain crosses the context-compaction threshold
 * mid-run: model-guard must compact inside the awaited turn_end handler and
 * the SAME run must continue — the original prompt stays pending through the
 * summarization call, remaining tool turns run exactly once without another
 * user prompt, the next request carries the summary instead of the old
 * transcript, and print exits 0 with the final answer.
 *
 * Lifecycle contract (see compaction-fix.md): the old detached ctx.compact()
 * path aborted the run, print mode read the aborted status and disposed the
 * runtime, and the compaction only started after disposal — exit 1, no
 * continuation. This test witnesses that failure before the fix and pins the
 * awaited inlineCompact contract after it.
 */

import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"
import {
	type FakeModel,
	type FakeOpenAiServer,
	type FakeResponseScript,
	startFakeOpenAiServer,
} from "../e2e/tui/support/fake-openai-server.js"
import { writeKimchiConfig } from "./print-config.js"

const BINARY_PATH = resolve("dist/bin/kimchi")
const PACKAGE_DIR = resolve("dist/share/kimchi")
const PROCESS_KILL_TIMEOUT_MS = 60_000

/** Must stay in sync with upstream DEFAULT_COMPACTION_SETTINGS.reserveTokens
 *  (src/extensions/compaction-thresholds.ts COMPACTION_RESERVE_TOKENS). */
const COMPACTION_RESERVE_TOKENS = 16_384

/** The provider fake's default model window (8,192) is below the reserve, so
 *  the trigger threshold would be negative. Register a custom window instead:
 *  large enough for a real compaction cut (upstream keepRecentTokens defaults
 *  to 20,000), small enough to cross quickly with scripted usage. */
const CONTEXT_WINDOW = 100_000
const THRESHOLD = CONTEXT_WINDOW - COMPACTION_RESERVE_TOKENS // 83,616

const MODEL: FakeModel = {
	slug: "compact-window",
	displayName: "Fake Compact Window",
	provider: "openai",
	reasoning: false,
	input: ["text"],
	contextWindow: CONTEXT_WINDOW,
	maxTokens: 8_192,
}

const FILLER_TOKEN = "PR1NT_F1LLER_UN1QUE_5e"
/** Lives in the summarized region: small, but uniquely identifiable so its
 *  disappearance from post-compaction requests proves the cut happened. */
const FILLER_TEXT = `${FILLER_TOKEN} turn-one working notes.`
/** The kept tail must exceed upstream's default keepRecentTokens (20,000) so
 *  the compaction cut lands at this turn, not inside the filler turn. */
const RECENT_TEXT = `recent-context turn-two notes. ${"kept note ".repeat(21_000)}`
const SUMMARY_MARKER = "PR1NT_SUMMARY_MARKER_7c"
const FINAL_ANSWER = "PR1NT_FINAL_ANSWER_3b: all work complete"

/** Upstream's compaction makes two kinds of summarization LLM calls: the
 *  regular history summary ("structured context checkpoint summary") and,
 *  when the cut lands mid-turn (single-turn tool chains — the cut point is an
 *  assistant message), the split-turn prefix summary. Both are "the summary
 *  request" for routing and assertion purposes. */
function isSummarizationRequest(body: unknown): boolean {
	const text = JSON.stringify(body ?? "")
	return (
		text.includes("structured context checkpoint summary") ||
		text.includes("PREFIX of a turn that was too large to keep")
	)
}

/** OpenAI-wire pairing check: every tool message must reference a tool_call
 *  id present in an earlier assistant message. Compaction must never leave an
 *  orphaned tool result on the wire. */
function orphanedToolResultIds(body: unknown): string[] {
	const messages = (body as { messages?: Array<Record<string, unknown>> }).messages ?? []
	const callIds = new Set<string>()
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue
		for (const call of message.tool_calls as Array<{ id?: unknown }>) {
			if (typeof call.id === "string") callIds.add(call.id)
		}
	}
	const orphans: string[] = []
	for (const message of messages) {
		if (message.role !== "tool") continue
		const toolCallId = message.tool_call_id
		if (typeof toolCallId === "string" && !callIds.has(toolCallId)) orphans.push(toolCallId)
	}
	return orphans
}

function bashToolCall(command: string) {
	return { function: { name: "bash", arguments: JSON.stringify({ command }) } }
}

interface PrintRun {
	stdout(): string
	stderr(): string
	isExited(): boolean
	didTimeOut(): boolean
	exitCode: Promise<number | null>
	kill(signal: NodeJS.Signals): void
}

function spawnPrintRun(homeDir: string, workDir: string, sessionPath: string, prompt: string): PrintRun {
	let stdout = ""
	let stderr = ""
	let timedOut = false
	let exited = false
	const child = spawn(BINARY_PATH, ["--print", "--provider", "fake", "--model", MODEL.slug, "--session", sessionPath], {
		cwd: workDir,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: homeDir,
			PI_PACKAGE_DIR: PACKAGE_DIR,
			KIMCHI_API_KEY: "fake",
			KIMCHI_PERMISSIONS: "yolo",
			KIMCHI_TELEMETRY_ENABLED: "0",
		},
	})
	child.stdout.setEncoding("utf-8").on("data", (chunk) => (stdout += chunk))
	child.stderr.setEncoding("utf-8").on("data", (chunk) => (stderr += chunk))
	child.stdin.end(prompt)
	const timeout = setTimeout(() => {
		timedOut = true
		child.kill("SIGKILL")
	}, PROCESS_KILL_TIMEOUT_MS)
	const exitCode = new Promise<number | null>((resolveExit) => {
		child.once("exit", (code) => {
			exited = true
			clearTimeout(timeout)
			resolveExit(code)
		})
	})
	return {
		stdout: () => stdout,
		stderr: () => stderr,
		isExited: () => exited,
		didTimeOut: () => timedOut,
		exitCode,
		kill: (signal) => child.kill(signal),
	}
}

function makeCompactionResponses(summaryGate: Promise<void>): FakeResponseScript[] {
	return [
		// Task turn 1: filler + first tool call. Usage below threshold — no trigger.
		{
			stream: [FILLER_TEXT],
			toolCalls: [bashToolCall("echo print-smoke-turn-one")],
			usage: { prompt_tokens: 30_000, completion_tokens: 500 },
		},
		// Task turn 2: large kept-tail content + second tool call. Usage crosses
		// the threshold — the turn_end guard fires here.
		{
			stream: [RECENT_TEXT],
			toolCalls: [bashToolCall("echo print-smoke-turn-two")],
			usage: { prompt_tokens: THRESHOLD + 600, completion_tokens: 100 },
		},
		// The compaction summarization call — held by the test so it can assert
		// the CLI stays alive and unfinished mid-summarization.
		{
			match: (request) => isSummarizationRequest(request.body),
			holdUntil: summaryGate,
			stream: [`${SUMMARY_MARKER}: the tool task is mid-flight; turn two completed, work continues.`],
			usage: { prompt_tokens: 1_000, completion_tokens: 200 },
		},
		// Task turn 3 (post-compaction): below threshold, no further compaction.
		{
			stream: ["Continuing after compaction."],
			toolCalls: [bashToolCall("echo print-smoke-turn-three")],
			usage: { prompt_tokens: 20_000, completion_tokens: 200 },
		},
		// Final answer.
		{
			stream: [FINAL_ANSWER],
			usage: { prompt_tokens: 21_000, completion_tokens: 100 },
		},
	]
}

async function waitForSummaryRequest(fake: FakeOpenAiServer): Promise<boolean> {
	const chatRequests = () => fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
	const deadline = Date.now() + 25_000
	while (Date.now() < deadline) {
		if (chatRequests().some((request) => isSummarizationRequest(request.body))) return true
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	return false
}

it("a --print tool run stays alive through mid-turn compaction, shrinks the wire, and exits 0", {
	timeout: 120_000,
}, async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-print-mid-turn-compaction-"))
	let fake: FakeOpenAiServer | undefined
	try {
		let releaseSummary!: () => void
		const summaryGate = new Promise<void>((resolve) => (releaseSummary = resolve))
		fake = await startFakeOpenAiServer({ models: [MODEL], responses: makeCompactionResponses(summaryGate) })
		const homeDir = join(tempRoot, "home")
		const workDir = join(tempRoot, "work")
		const sessionPath = join(tempRoot, "main.jsonl")
		mkdirSync(homeDir, { recursive: true })
		mkdirSync(workDir, { recursive: true })
		writeKimchiConfig(homeDir, fake.baseUrl, [MODEL])

		const run = spawnPrintRun(
			homeDir,
			workDir,
			sessionPath,
			"Run the three bash echo steps in order, then state the final answer.",
		)

		// Held phase: the summarization request arrives and is held open.
		const summaryArrived = await waitForSummaryRequest(fake)
		const debugSummary = `summaryArrived=${summaryArrived} exited=${run.isExited()} requests=${fake.requests.length}\nstdout=${run.stdout()}\nstderr=${run.stderr()}`
		expect(summaryArrived, debugSummary).toBe(true)

		// The CLI must remain alive and unfinished while the summary is held —
		// the original prompt is still pending, the run never aborted.
		await new Promise((resolve) => setTimeout(resolve, 1_000))
		expect(run.isExited(), `CLI must stay alive while the summary response is held\n${debugSummary}`).toBe(false)
		expect(run.stdout(), `no final output while the summary is held\n${debugSummary}`).not.toContain(FINAL_ANSWER)

		// Release the summary and let the run finish.
		releaseSummary()
		const code = await run.exitCode
		const failure = `timedOut=${run.didTimeOut()} code=${code}\nstdout=${run.stdout()}\nstderr=${run.stderr()}`
		expect(run.didTimeOut(), failure).toBe(false)
		expect(code, failure).toBe(0)
		expect(run.stdout(), failure).toContain(FINAL_ANSWER)

		// Request-content regression: exactly one summarization call, exactly
		// four task calls — remaining work ran exactly once, no synthetic turn.
		// Recompute from the live request log: the held-phase snapshot predates
		// the post-compaction turns.
		const chatRequests = fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
		const summaryRequests = chatRequests.filter((request) => isSummarizationRequest(request.body))
		const taskRequests = chatRequests.filter((request) => !isSummarizationRequest(request.body))
		expect(summaryRequests.length, failure).toBe(1)
		expect(taskRequests.length, failure).toBe(4)

		// Sanity: the filler was really on the wire before compaction.
		expect(JSON.stringify(taskRequests[1].body)).toContain(FILLER_TOKEN)

		// Post-compaction task requests carry the summary marker, exclude the
		// summarized filler, and preserve tool-call/result pairing.
		for (const request of taskRequests.slice(2)) {
			const body = JSON.stringify(request.body)
			expect(body, failure).toContain(SUMMARY_MARKER)
			expect(body, failure).not.toContain(FILLER_TOKEN)
			expect(orphanedToolResultIds(request.body), failure).toEqual([])
		}

		// Session history: the compaction entry lands before the remaining work.
		const sessionLines = readFileSync(sessionPath, "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; message?: { role: string; content?: unknown } })
		const compactionIndex = sessionLines.findIndex((entry) => entry.type === "compaction")
		const finalAnswerIndex = sessionLines.findIndex(
			(entry) =>
				entry.type === "message" &&
				entry.message?.role === "assistant" &&
				JSON.stringify(entry.message).includes(FINAL_ANSWER),
		)
		expect(
			compactionIndex,
			`session must record the compaction\n${sessionLines.map((entry) => entry.type).join(",")}`,
		).toBeGreaterThanOrEqual(0)
		expect(
			finalAnswerIndex,
			`session must record the final answer\n${sessionLines.map((entry) => entry.type).join(",")}`,
		).toBeGreaterThan(-1)
		expect(finalAnswerIndex).toBeGreaterThan(compactionIndex)
	} finally {
		await fake?.stop().catch(() => {})
		rmSync(tempRoot, { recursive: true, force: true })
	}
})

it("cancelling during summarization ends the run without scheduling another task request", {
	timeout: 120_000,
}, async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-print-mid-turn-cancel-"))
	let fake: FakeOpenAiServer | undefined
	try {
		// Never resolves: the summarization response must stay held for the
		// entire test — cancellation happens mid-hold and the summary is never
		// delivered.
		const summaryGate = new Promise<void>(() => {})
		fake = await startFakeOpenAiServer({ models: [MODEL], responses: makeCompactionResponses(summaryGate) })
		const homeDir = join(tempRoot, "home")
		const workDir = join(tempRoot, "work")
		const sessionPath = join(tempRoot, "main.jsonl")
		mkdirSync(homeDir, { recursive: true })
		mkdirSync(workDir, { recursive: true })
		writeKimchiConfig(homeDir, fake.baseUrl, [MODEL])

		const run = spawnPrintRun(
			homeDir,
			workDir,
			sessionPath,
			"Run the three bash echo steps in order, then state the final answer.",
		)

		const summaryArrived = await waitForSummaryRequest(fake)
		expect(summaryArrived, `summary request never arrived\nstdout=${run.stdout()}\nstderr=${run.stderr()}`).toBe(true)
		expect(run.isExited(), "CLI must be alive at cancellation time").toBe(false)

		// Cancel mid-summarization. Cancellation must end the run: no further
		// task request is scheduled and no final answer is announced. The held
		// summary stays held — releasing it is what a broken recovery path would
		// need to continue, and it never happens here.
		run.kill("SIGINT")
		const code = await Promise.race([
			run.exitCode,
			new Promise<number | null>((resolve) =>
				setTimeout(() => {
					run.kill("SIGKILL")
					resolve(null)
				}, 15_000),
			),
		])
		const failure = `code=${code}\nstdout=${run.stdout()}\nstderr=${run.stderr()}`
		expect(code, failure).not.toBe(0)
		expect(run.stdout(), failure).not.toContain(FINAL_ANSWER)

		// Grace period after exit: a recovery path scheduled before cancellation
		// would surface as an extra task request now.
		await new Promise((resolve) => setTimeout(resolve, 1_500))
		const chatRequests = fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
		const summaryRequests = chatRequests.filter((request) => isSummarizationRequest(request.body))
		const taskRequests = chatRequests.filter((request) => !isSummarizationRequest(request.body))
		expect(summaryRequests.length, failure).toBe(1)
		expect(taskRequests.length, failure).toBe(2)
	} finally {
		await fake?.stop().catch(() => {})
		rmSync(tempRoot, { recursive: true, force: true })
	}
})
