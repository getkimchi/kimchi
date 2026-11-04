/**
 * Headless repro for the background-bash runaway: a `--print` session whose
 * `--tools` allowlist names `bash` but not `bash_control` must never hold
 * background processes the model cannot disposition.
 *
 * Scenario A (allowlist coupling): `--tools read,bash,write,grep,find,ls`
 * gets `bash_control` appended, so the model can wait on the cohort and the
 * run terminates once the command finishes.
 *
 * Scenario B (the repro): excluding `bash_control` removes the whole bash
 * tool — they are one unit — so the model cannot even start a command it
 * could never stop, and the run terminates instead of looping on the
 * completion guard. Pre-fix, the same invocation handed `sleep 600` to the
 * background with no control tool and ran away (hundreds of turns polling
 * a process it cannot stop); the test timeout is the only thing that ended
 * it.
 */
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"
import {
	DEFAULT_MODEL,
	type FakeOpenAiServer,
	type FakeResponseScript,
	startFakeOpenAiServer,
} from "../e2e/tui/support/fake-openai-server.js"
import { writeKimchiConfig } from "./print-config.js"

const BINARY_PATH = resolve("dist/bin/kimchi")
const PACKAGE_DIR = resolve("dist/share/kimchi")
const PROCESS_EXIT_TIMEOUT_MS = 30_000

interface RunResult {
	code: number | null
	stdout: string
	stderr: string
	timedOut: boolean
}

function runPrint(opts: {
	homeDir: string
	workDir: string
	sessionPath: string
	prompt: string
	args: string[]
	env: Record<string, string>
}): Promise<RunResult> {
	return new Promise<RunResult>((resolvePromise) => {
		const child = spawn(
			BINARY_PATH,
			["--print", "--provider", "fake", "--model", DEFAULT_MODEL.slug, "--session", opts.sessionPath, ...opts.args],
			{
				cwd: opts.workDir,
				env: {
					PATH: process.env.PATH ?? "",
					HOME: opts.homeDir,
					PI_PACKAGE_DIR: PACKAGE_DIR,
					KIMCHI_API_KEY: "fake",
					KIMCHI_PERMISSIONS: "yolo",
					KIMCHI_TELEMETRY_ENABLED: "0",
					// Forward vitest's marker so KIMCHI_E2E_* seams fire in the
					// spawned binary (src/extensions/e2e-seam.ts gates them to
					// test harnesses only).
					...(process.env.VITEST !== undefined ? { VITEST: process.env.VITEST } : {}),
					...opts.env,
				},
			},
		)
		let stdout = ""
		let stderr = ""
		let timedOut = false
		child.stdout.setEncoding("utf-8").on("data", (chunk) => (stdout += chunk))
		child.stderr.setEncoding("utf-8").on("data", (chunk) => (stderr += chunk))
		child.stdin.end(opts.prompt)
		const timeout = setTimeout(() => {
			timedOut = true
			child.kill("SIGKILL")
		}, PROCESS_EXIT_TIMEOUT_MS)
		child.once("exit", (code) => {
			clearTimeout(timeout)
			resolvePromise({ code, stdout, stderr, timedOut })
		})
	})
}

function bashCall(command: string): FakeResponseScript {
	return {
		toolCalls: [{ function: { name: "bash", arguments: JSON.stringify({ command }) } }],
	}
}

function toolCall(name: string, args: Record<string, unknown>): FakeResponseScript {
	return {
		toolCalls: [{ function: { name, arguments: JSON.stringify(args) } }],
	}
}

function finalAnswer(text: string): FakeResponseScript {
	return { stream: [text] }
}

interface ChatToolEntry {
	function?: { name?: string }
}

function chatRequests(fake: FakeOpenAiServer): Array<{ body: { tools?: ChatToolEntry[] } & Record<string, unknown> }> {
	return fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions")) as Array<{
		body: { tools?: ChatToolEntry[] } & Record<string, unknown>
	}>
}

function manifestNames(request: { body: { tools?: ChatToolEntry[] } & Record<string, unknown> }): string[] {
	return (request.body.tools ?? []).map((tool) => tool.function?.name ?? "")
}

async function withFakeServer(
	responses: FakeResponseScript[],
	run: (fake: FakeOpenAiServer, dirs: { homeDir: string; workDir: string; sessionPath: string }) => Promise<void>,
): Promise<void> {
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-bash-control-smoke-"))
	let fake: FakeOpenAiServer | undefined
	try {
		fake = await startFakeOpenAiServer({ responses })
		const homeDir = join(tempRoot, "home")
		const workDir = join(tempRoot, "work")
		mkdirSync(homeDir, { recursive: true })
		mkdirSync(workDir, { recursive: true })
		writeKimchiConfig(homeDir, fake.baseUrl)
		await run(fake, { homeDir, workDir, sessionPath: join(tempRoot, "main.jsonl") })
	} finally {
		await fake?.stop().catch(() => {})
		rmSync(tempRoot, { recursive: true, force: true })
	}
}

it("couples an allowlist that names bash with bash_control, so a headless run can disposition a background cohort", {
	timeout: 60_000,
}, async () => {
	await withFakeServer(
		[
			// 1. Start a command that outlasts the (seam-shortened) handoff
			//    deadline: the tool hands off with a live handle.
			bashCall("sleep 3"),
			// 2. The model blocks on the cohort via bash_control — impossible
			//    when the allowlist drops the tool. The wait returns at the
			//    sleep's exit.
			toolCall("bash_control", { wait: true }),
			// 3. Final answer: nothing remains unresolved.
			finalAnswer("Cohort drained; run complete."),
		],
		async (fake, dirs) => {
			const result = await runPrint({
				homeDir: dirs.homeDir,
				workDir: dirs.workDir,
				sessionPath: dirs.sessionPath,
				prompt: "Run the sleep, wait for it, then finish.",
				args: ["--tools", "read,bash,write,grep,find,ls"],
				env: { KIMCHI_E2E_BASH_HANDOFF_SECONDS: "1" },
			})
			const failure = `timedOut=${result.timedOut} code=${result.code}\nstdout=${result.stdout}\nstderr=${result.stderr}`
			const requests = chatRequests(fake)

			// The coupling: bash_control is declared in the manifest despite
			// the allowlist omitting it.
			expect(requests.length, failure).toBeGreaterThanOrEqual(1)
			expect(manifestNames(requests[0] as never), failure).toContain("bash_control")
			// The run terminated in bounded time with the final answer…
			expect(result.timedOut, failure).toBe(false)
			expect(result.code, failure).toBe(0)
			expect(result.stdout, failure).toContain("Cohort drained; run complete.")
			// …and the bash_control wait actually resolved (the model's final
			// request carries the delivered exit result, not a tool error).
			expect(requests.length, failure).toBeGreaterThanOrEqual(3)
			const lastBody = JSON.stringify(requests[requests.length - 1]?.body)
			expect(lastBody, failure).toContain("sleep 3")
		},
	)
})

it("removes the whole bash tool when bash_control is excluded, so a headless run whose command never ends terminates", {
	timeout: 60_000,
}, async () => {
	await withFakeServer(
		[
			// 1. The model tries the never-ending command — but bash is gone
			//    with its control tool, so the call fails outright.
			bashCall("sleep 600"),
			// 2. Final answer after the failed call.
			finalAnswer("Nothing to run; run complete."),
		],
		async (fake, dirs) => {
			const result = await runPrint({
				homeDir: dirs.homeDir,
				workDir: dirs.workDir,
				sessionPath: dirs.sessionPath,
				prompt: "Run the sleep, then finish.",
				args: ["--tools", "read,bash", "--exclude-tools", "bash_control"],
				env: {
					// Pre-fix, the completion guard re-prompts on every stop —
					// shrink its pacing so the runaway is visible inside the
					// test budget instead of hidden behind the 30s default.
					KIMCHI_E2E_COMPLETION_REMINDER_MS: "0",
				},
			})
			const failure = `timedOut=${result.timedOut} code=${result.code}\nstdout=${result.stdout}\nstderr=${result.stderr}`
			const requests = chatRequests(fake)

			// The exclusion removed the WHOLE pair: neither bash nor
			// bash_control is declared to the model.
			expect(requests.length, failure).toBeGreaterThanOrEqual(1)
			const manifest = manifestNames(requests[0] as never)
			expect(manifest, failure).not.toContain("bash")
			expect(manifest, failure).not.toContain("bash_control")
			// The run terminated in bounded time with the final answer…
			expect(result.timedOut, failure).toBe(false)
			expect(result.code, failure).toBe(0)
			expect(result.stdout, failure).toContain("Nothing to run; run complete.")
			// …and the bash call failed as an unavailable tool — no handoff,
			// no handle, nothing left for the completion guard to demand.
			expect(requests.length, failure).toBeGreaterThanOrEqual(2)
			const lastBody = JSON.stringify(requests[requests.length - 1]?.body)
			expect(lastBody, failure).not.toContain("This process now continues by default")
		},
	)
})
