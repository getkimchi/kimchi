/**
 * Print-mode E2E for the thinking-budget guard's mid-stream preempt
 * (trigger B, KIMCHI_THINKING_PREEMPT).
 *
 * The preempt is on by default in headless mode — this test deliberately
 * does NOT set KIMCHI_THINKING_PREEMPT, proving the default-on behaviour.
 *
 * The fake provider's first response streams ~45K thinking chars over ~2s.
 * With KIMCHI_THINKING_BUDGET_CHARS=20000 the guard must abort the in-flight
 * request once accumulated thinking crosses 20K chars (~chunk 47, ~1s in),
 * queue the "cut off" steer from agent_end, and let the session continue:
 * the steered continuation emits a bash tool call (auto-executed under
 * KIMCHI_PERMISSIONS=yolo) and the final turn prints "Task complete.".
 */

import { type ChildProcess, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { type FakeModel, resolveModels, startFakeOpenAiServer } from "../tui/support/fake-openai-server.js"

const REPO_ROOT = process.env.KIMCHI_REPO_ROOT
	? resolve(process.env.KIMCHI_REPO_ROOT)
	: fileURLToPath(new URL("../../../", import.meta.url))
const BINARY_PATH = resolve(REPO_ROOT, "dist/bin/kimchi")
const PACKAGE_DIR = resolve(REPO_ROOT, "dist/share/kimchi")

const INITIAL_SURVEY_ID = "019e87cc-5033-0000-d9bd-5e6501640b6e"
const BUDGET_CHARS = 20_000
const PROMPT = "solve the task"
/** Hard kill switch so a regression hangs the suite for at most one minute. */
const EXIT_DEADLINE_MS = 60_000

const MODELS: FakeModel[] = [
	{
		slug: "thinking-model",
		displayName: "Fake Thinking",
		reasoning: true,
		contextWindow: 8_000_000,
		maxTokens: 64_000,
	},
]

/** Seed the temp HOME so the binary skips onboarding and resolves the fake provider. */
function writeHome(homeDir: string, baseUrl: string): void {
	const configDir = join(homeDir, ".config", "kimchi")
	const agentDir = join(configDir, "harness")
	mkdirSync(agentDir, { recursive: true })
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({
			apiKey: "fake",
			llmEndpoint: baseUrl,
			migrationState: "done",
			onboarding: { hideSessionModeDialog: true },
			surveys: { [INITIAL_SURVEY_ID]: { seenAt: "2026-01-01T00:00:00.000Z" } },
		}),
	)
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ statusLine: { pinned: [] }, hideThinkingBlock: true }),
	)
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				fake: {
					baseUrl: `${baseUrl}/openai/v1`,
					apiKey: "fake",
					api: "openai-completions",
					authHeader: true,
					headers: { "User-Agent": "kimchi/e2e" },
					models: resolveModels(MODELS).map((model) => ({
						id: model.slug,
						name: model.displayName,
						reasoning: model.reasoning,
						input: model.input,
						contextWindow: model.contextWindow,
						maxTokens: model.maxTokens,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						provider: model.provider,
					})),
				},
			},
		}),
	)
}

interface PrintRun {
	exitCode: number | null
	signal: NodeJS.Signals | null
	stdout: string
	stderr: string
	timedOut: boolean
}

function runKimchiPrint(homeDir: string, workDir: string): Promise<PrintRun> {
	return new Promise((resolveRun, rejectRun) => {
		const child: ChildProcess = spawn(BINARY_PATH, ["--print", "--provider", "fake", "--model", "thinking-model"], {
			cwd: workDir,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: homeDir,
				PI_PACKAGE_DIR: PACKAGE_DIR,
				KIMCHI_PERMISSIONS: "yolo",
				TERM: "xterm-256color",
				KIMCHI_THINKING_BUDGET_CHARS: String(BUDGET_CHARS),
			},
			stdio: ["pipe", "pipe", "pipe"],
		})
		let stdout = ""
		let stderr = ""
		let timedOut = false
		child.stdout?.setEncoding("utf-8")
		child.stderr?.setEncoding("utf-8")
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk
		})
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk
		})
		const killTimer = setTimeout(() => {
			timedOut = true
			child.kill("SIGKILL")
		}, EXIT_DEADLINE_MS)
		child.on("error", (error) => {
			clearTimeout(killTimer)
			rejectRun(error)
		})
		child.on("exit", (code, signal) => {
			clearTimeout(killTimer)
			resolveRun({ exitCode: code, signal, stdout, stderr, timedOut })
		})
		child.stdin?.write(PROMPT)
		child.stdin?.end()
	})
}

describe("thinking budget preempt (print mode)", () => {
	it("aborts a runaway thinking stream mid-flight and steers the session to completion", async () => {
		const server = await startFakeOpenAiServer({
			models: MODELS,
			responses: [
				{
					// 100 chunks x ~417 chars ≈ 45K chars total. The guard must cut the
					// stream at ~20K chars (~chunk 47, ~1s in), well before the natural
					// completion (~2s) would even arrive.
					thinking: Array.from({ length: 100 }, (_, i) => `thinking chunk ${i} ${"x".repeat(400)}`),
					thinkingDelayMs: 20,
				},
				{
					toolCalls: [{ function: { name: "bash", arguments: JSON.stringify({ command: "echo GUARD_PREEMPT_OK" }) } }],
				},
				{ stream: ["Task complete."] },
			],
		})
		const homeDir = mkdtempSync(join(tmpdir(), "kimchi-print-home-"))
		const workDir = mkdtempSync(join(tmpdir(), "kimchi-print-work-"))
		try {
			writeHome(homeDir, server.baseUrl)
			const run = await runKimchiPrint(homeDir, workDir)

			expect(run.timedOut, "kimchi --print did not exit within 60s").toBe(false)
			expect(run.exitCode, `exit code (stderr below)\n${run.stderr}`).toBe(0)

			// The binary also issues startup GETs (model metadata, credits,
			// budget) plus one off-route probe to /chat/completions; only the
			// openai-completions provider calls matter here — exactly three:
			// the runaway stream, the steered continuation (tool call), and the
			// post-tool final answer.
			const chatRequests = server.requests.filter((req) => req.url.startsWith("/openai/v1/chat/completions"))
			expect(chatRequests).toHaveLength(3)
			// The preempt cancelled the in-flight request mid-stream.
			expect(chatRequests[0]?.aborted).toBe(true)
			// The steer queued at agent_end made it into the continuation prompt.
			expect(JSON.stringify(chatRequests[1]?.body)).toContain("Thinking budget guard")
			// The yolo-executed bash tool result made it back to the provider.
			expect(JSON.stringify(chatRequests[2]?.body)).toContain("GUARD_PREEMPT_OK")
			expect(run.stdout).toContain("Task complete.")
		} finally {
			await server.stop()
			rmSync(homeDir, { recursive: true, force: true })
			rmSync(workDir, { recursive: true, force: true })
		}
	})
})
