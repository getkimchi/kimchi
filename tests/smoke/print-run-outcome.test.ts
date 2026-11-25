import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { KIMCHI_INFRA_ERROR_EXIT_CODE } from "../../src/infrastructure-error.js"
import { KIMCHI_NO_PROMPT_EXIT_CODE, KIMCHI_NO_RESULT_EXIT_CODE } from "../../src/run-outcome.js"
import {
	DEFAULT_MODEL,
	type FakeOpenAiServer,
	type FakeResponseScript,
	startFakeOpenAiServer,
} from "../e2e/tui/support/fake-openai-server.js"
import { writeKimchiConfig } from "./print-config.js"

const BINARY_PATH = resolve("dist/bin/kimchi")
const PACKAGE_DIR = resolve("dist/share/kimchi")
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const MODEL_ARGS = ["--provider", "fake", "--model", DEFAULT_MODEL.slug]

interface RunResult {
	code: number | null
	stdout: string
	stderr: string
	timedOut: boolean
	failure: string
}

interface RunOptions {
	args: string[]
	responses?: FakeResponseScript[]
	stdin?: string
	/** "none" passes --no-session; otherwise a session file is passed. */
	session?: "file" | "none"
	prepare?: (workDir: string, homeDir: string) => void
	permissions?: string
}

interface Harness {
	result: RunResult
	sessionPath: string
	workDir: string
}

function spawnKimchi(
	homeDir: string,
	workDir: string,
	args: string[],
	stdin: string | undefined,
	permissions: string,
): Promise<RunResult> {
	return new Promise((resolvePromise) => {
		const child = spawn(BINARY_PATH, args, {
			cwd: workDir,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: homeDir,
				PI_PACKAGE_DIR: PACKAGE_DIR,
				KIMCHI_API_KEY: "fake",
				KIMCHI_PERMISSIONS: permissions,
				KIMCHI_TELEMETRY_ENABLED: "0",
			},
		})
		let stdout = ""
		let stderr = ""
		let timedOut = false
		child.stdout.setEncoding("utf-8").on("data", (chunk) => (stdout += chunk))
		child.stderr.setEncoding("utf-8").on("data", (chunk) => (stderr += chunk))
		child.stdin.end(stdin ?? "")
		const timeout = setTimeout(() => {
			timedOut = true
			child.kill("SIGKILL")
		}, PROCESS_EXIT_TIMEOUT_MS)
		child.once("exit", (code) => {
			clearTimeout(timeout)
			resolvePromise({
				code,
				stdout,
				stderr,
				timedOut,
				failure: `timedOut=${timedOut} code=${code}\nstdout=${stdout}\nstderr=${stderr}`,
			})
		})
	})
}

async function runKimchi(options: RunOptions): Promise<Harness> {
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-print-outcome-"))
	let fake: FakeOpenAiServer | undefined
	try {
		fake = await startFakeOpenAiServer({ responses: options.responses ?? [] })
		const homeDir = join(tempRoot, "home")
		const workDir = join(tempRoot, "work")
		const sessionPath = join(tempRoot, "main.jsonl")
		mkdirSync(homeDir, { recursive: true })
		mkdirSync(workDir, { recursive: true })
		writeKimchiConfig(homeDir, fake.baseUrl)
		options.prepare?.(workDir, homeDir)
		const sessionArgs = options.session === "none" ? ["--no-session"] : ["--session", sessionPath]
		const result = await spawnKimchi(
			homeDir,
			workDir,
			[...options.args, ...sessionArgs],
			options.stdin,
			options.permissions ?? "yolo",
		)
		return { result, sessionPath, workDir }
	} finally {
		await fake?.stop().catch(() => {})
		rmSync(tempRoot, { recursive: true, force: true })
	}
}

const NO_PROMPT_MARKER = "KIMCHI_NO_PROMPT:"
const NO_RESULT_MARKER = "KIMCHI_NO_RESULT:"

function expectNoGuardMarker(result: RunResult) {
	expect(result.stderr, result.failure).not.toContain(NO_PROMPT_MARKER)
	expect(result.stderr, result.failure).not.toContain(NO_RESULT_MARKER)
}

/** Text mode: exit 0 without a guard marker if and only if stdout has real text. */
function expectTextOutcomeEquivalence(result: RunResult) {
	const hasText = result.stdout.trim().length > 0
	const guardFired = result.stderr.includes(NO_PROMPT_MARKER) || result.stderr.includes(NO_RESULT_MARKER)
	expect(result.code === 0 && !guardFired, result.failure).toBe(hasText)
}

// The empty-turn nudge re-prompts the model, so a persistently empty model
// needs several identical scripts or the fake server falls back to text.
function repeated(script: FakeResponseScript, times = 6): FakeResponseScript[] {
	return Array.from({ length: times }, () => ({ ...script }))
}

function denyWriteThenScript(final: FakeResponseScript, times = 1): FakeResponseScript[] {
	return [
		{
			toolCalls: [
				{
					id: "call_write_1",
					type: "function",
					function: { name: "write", arguments: JSON.stringify({ path: "out.txt", content: "x" }) },
				},
			],
		},
		...repeated(final, times),
	]
}

function parseJsonLines(stdout: string): { type?: string }[] {
	return stdout
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as { type?: string })
}

const TIMEOUT = { timeout: 45_000 }

describe("non-interactive run outcome guard (compiled binary)", () => {
	it("denied write then empty answer exits 3 in text mode", TIMEOUT, async () => {
		const { result, sessionPath } = await runKimchi({
			args: ["--print", ...MODEL_ARGS, "write a file"],
			responses: denyWriteThenScript({ stream: [] }, 6),
			permissions: "default",
		})
		expect(result.timedOut, result.failure).toBe(false)
		expect(result.code, result.failure).toBe(KIMCHI_NO_RESULT_EXIT_CODE)
		expect(result.stdout, result.failure).toBe("")
		expect(result.stderr, result.failure).toContain(NO_RESULT_MARKER)
		expect(result.stderr, result.failure).toContain("write")
		expect(result.stderr, result.failure).toContain("Classifier: no model available for classifier")
		expect(result.stderr, result.failure).toContain("Rerun with --mode json")
		expect(result.stderr, result.failure).toContain(`Session: ${sessionPath}`)
		expectTextOutcomeEquivalence(result)
	})

	it("denied write then empty answer exits 3 in JSON mode without changing events", TIMEOUT, async () => {
		const { result } = await runKimchi({
			args: ["--print", "--mode", "json", ...MODEL_ARGS, "write a file"],
			responses: denyWriteThenScript({ stream: [] }, 6),
			permissions: "default",
		})
		expect(result.timedOut, result.failure).toBe(false)
		expect(result.code, result.failure).toBe(KIMCHI_NO_RESULT_EXIT_CODE)
		expect(result.stderr, result.failure).toContain(NO_RESULT_MARKER)
		const types = parseJsonLines(result.stdout).map((event) => event.type)
		expect(types, result.failure).toContain("session")
		expect(types, result.failure).toContain("agent_start")
		expect(types, result.failure).toContain("tool_execution_end")
		expect(types, result.failure).toContain("agent_end")
		expect(result.stdout, result.failure).not.toContain(NO_RESULT_MARKER)
	})

	it("denied write then text answer succeeds in text mode", TIMEOUT, async () => {
		const { result } = await runKimchi({
			args: ["--print", ...MODEL_ARGS, "write a file"],
			responses: denyWriteThenScript({ stream: ["AFTER DENIAL"] }),
			permissions: "default",
		})
		expect(result.timedOut, result.failure).toBe(false)
		expect(result.code, result.failure).toBe(0)
		expect(result.stdout, result.failure).toContain("AFTER DENIAL")
		expectNoGuardMarker(result)
		expectTextOutcomeEquivalence(result)
	})

	it("plain text answer succeeds without a guard message", TIMEOUT, async () => {
		const { result } = await runKimchi({
			args: ["--print", ...MODEL_ARGS, "hello"],
			responses: [{ stream: ["The answer."] }],
		})
		expect(result.timedOut, result.failure).toBe(false)
		expect(result.code, result.failure).toBe(0)
		expect(result.stdout, result.failure).toBe("The answer.\n")
		expectNoGuardMarker(result)
		expectTextOutcomeEquivalence(result)
	})

	it("print with no prompt exits 2 with actionable stderr", TIMEOUT, async () => {
		const { result } = await runKimchi({ args: ["--print", ...MODEL_ARGS] })
		expect(result.timedOut, result.failure).toBe(false)
		expect(result.code, result.failure).toBe(KIMCHI_NO_PROMPT_EXIT_CODE)
		expect(result.stdout, result.failure).toBe("")
		expect(result.stderr, result.failure).toContain(NO_PROMPT_MARKER)
		expect(result.stderr, result.failure).toContain("A flag such as --auto may have taken the prompt as its value.")
		expect(result.stderr, result.failure).toContain(
			"Put the prompt before the flags, or write the flag as --auto=true.",
		)
		expectTextOutcomeEquivalence(result)
	})

	it("JSON print with no prompt exits 2 and emits only the header", TIMEOUT, async () => {
		const { result } = await runKimchi({ args: ["--print", "--mode", "json", ...MODEL_ARGS] })
		expect(result.timedOut, result.failure).toBe(false)
		expect(result.code, result.failure).toBe(KIMCHI_NO_PROMPT_EXIT_CODE)
		const lines = result.stdout.split("\n").filter((line) => line.trim().length > 0)
		expect(lines, result.failure).toHaveLength(1)
		expect(JSON.parse(lines[0] ?? "").type, result.failure).toBe("session")
		expect(result.stderr, result.failure).toContain(NO_PROMPT_MARKER)
		expect(result.stderr, result.failure).toContain(
			"Put the prompt before the flags, or write the flag as --auto=true.",
		)
	})

	it("empty positional prompt exits 2 in text mode", TIMEOUT, async () => {
		const { result } = await runKimchi({ args: ["--print", ...MODEL_ARGS, ""] })
		expect(result.timedOut, result.failure).toBe(false)
		expect(result.code, result.failure).toBe(KIMCHI_NO_PROMPT_EXIT_CODE)
		expect(result.stdout, result.failure).toBe("")
		expect(result.stderr, result.failure).toContain(NO_PROMPT_MARKER)
		expect(result.stderr, result.failure).toContain("An empty prompt or an empty @file does not count as a prompt.")
		expectTextOutcomeEquivalence(result)
	})

	it("empty positional prompt exits 2 in JSON mode and emits only the header", TIMEOUT, async () => {
		const { result } = await runKimchi({ args: ["--print", "--mode", "json", ...MODEL_ARGS, ""] })
		expect(result.timedOut, result.failure).toBe(false)
		expect(result.code, result.failure).toBe(KIMCHI_NO_PROMPT_EXIT_CODE)
		const lines = result.stdout.split("\n").filter((line) => line.trim().length > 0)
		expect(lines, result.failure).toHaveLength(1)
		expect(JSON.parse(lines[0] ?? "").type, result.failure).toBe("session")
		expect(result.stderr, result.failure).toContain(NO_PROMPT_MARKER)
		expect(result.stderr, result.failure).toContain("An empty prompt or an empty @file does not count as a prompt.")
	})

	it("empty at-file prompt exits 2 in text mode", TIMEOUT, async () => {
		const { result } = await runKimchi({
			args: ["--print", ...MODEL_ARGS, "@empty.md"],
			prepare: (workDir) => writeFileSync(join(workDir, "empty.md"), ""),
		})
		expect(result.timedOut, result.failure).toBe(false)
		expect(result.code, result.failure).toBe(KIMCHI_NO_PROMPT_EXIT_CODE)
		expect(result.stdout, result.failure).toBe("")
		expect(result.stderr, result.failure).toContain(NO_PROMPT_MARKER)
		expect(result.stderr, result.failure).toContain("An empty prompt or an empty @file does not count as a prompt.")
		expectTextOutcomeEquivalence(result)
	})

	it("empty at-file prompt exits 2 in JSON mode and emits only the header", TIMEOUT, async () => {
		const { result } = await runKimchi({
			args: ["--print", "--mode", "json", ...MODEL_ARGS, "@empty.md"],
			prepare: (workDir) => writeFileSync(join(workDir, "empty.md"), ""),
		})
		expect(result.timedOut, result.failure).toBe(false)
		expect(result.code, result.failure).toBe(KIMCHI_NO_PROMPT_EXIT_CODE)
		const lines = result.stdout.split("\n").filter((line) => line.trim().length > 0)
		expect(lines, result.failure).toHaveLength(1)
		expect(JSON.parse(lines[0] ?? "").type, result.failure).toBe("session")
		expect(result.stderr, result.failure).toContain(NO_PROMPT_MARKER)
		expect(result.stderr, result.failure).toContain("An empty prompt or an empty @file does not count as a prompt.")
	})

	it("prompt only from piped stdin succeeds", TIMEOUT, async () => {
		const { result } = await runKimchi({
			args: ["--print", ...MODEL_ARGS],
			stdin: "hello from stdin",
			responses: [{ stream: ["Stdin answer."] }],
		})
		expect(result.timedOut, result.failure).toBe(false)
		expect(result.code, result.failure).toBe(0)
		expect(result.stdout, result.failure).toContain("Stdin answer.")
		expectNoGuardMarker(result)
		expectTextOutcomeEquivalence(result)
	})

	it("slash command only from piped stdin is not a missing prompt", TIMEOUT, async () => {
		// pi runs a stdin `/command` before any extension event, so no `input` is ever seen.
		const { result } = await runKimchi({
			args: ["--print", ...MODEL_ARGS],
			stdin: "/language",
		})
		expect(result.timedOut, result.failure).toBe(false)
		expect(result.code, result.failure).toBe(0)
		expectNoGuardMarker(result)
	})

	it("prompt blocked by a UserPromptSubmit hook exits 3 instead of a silent 0", TIMEOUT, async () => {
		const { result } = await runKimchi({
			args: ["--print", ...MODEL_ARGS, "hello"],
			prepare: (_workDir, homeDir) => {
				const hookScript = join(homeDir, "block-prompt.cjs")
				writeFileSync(hookScript, 'console.error("prompt blocked by hook")\nprocess.exit(2)\n')
				const harnessSettings = join(homeDir, ".config", "kimchi", "harness", "settings.json")
				const settings = JSON.parse(readFileSync(harnessSettings, "utf-8"))
				settings.resources = { "extensions.claude-code-hook-adapter": true }
				writeFileSync(harnessSettings, JSON.stringify(settings))
				mkdirSync(join(homeDir, ".claude"), { recursive: true })
				writeFileSync(
					join(homeDir, ".claude", "settings.json"),
					JSON.stringify({
						hooks: {
							UserPromptSubmit: [{ hooks: [{ type: "command", command: `node ${JSON.stringify(hookScript)}` }] }],
						},
					}),
				)
			},
			responses: [{ stream: ["Should not run."] }],
		})
		expect(result.timedOut, result.failure).toBe(false)
		expect(result.code, result.failure).toBe(KIMCHI_NO_RESULT_EXIT_CODE)
		expect(result.stdout, result.failure).not.toContain("Should not run.")
		expect(result.stderr, result.failure).toContain(NO_RESULT_MARKER)
		expect(result.stderr, result.failure).toContain("An extension handled the prompt")
		expect(result.stderr, result.failure).not.toContain(NO_PROMPT_MARKER)
	})

	it("prompt only from at-file succeeds", TIMEOUT, async () => {
		const { result } = await runKimchi({
			args: ["--print", ...MODEL_ARGS, "@prompt.md"],
			prepare: (workDir) => writeFileSync(join(workDir, "prompt.md"), "Please answer from the file."),
			responses: [{ stream: ["File answer."] }],
		})
		expect(result.timedOut, result.failure).toBe(false)
		expect(result.code, result.failure).toBe(0)
		expect(result.stdout, result.failure).toContain("File answer.")
		expectNoGuardMarker(result)
		expectTextOutcomeEquivalence(result)
	})

	it("empty answer with no-session reports that no session was saved", TIMEOUT, async () => {
		const { result } = await runKimchi({
			args: ["--print", ...MODEL_ARGS, "hello"],
			session: "none",
			responses: repeated({ stream: [] }),
		})
		expect(result.timedOut, result.failure).toBe(false)
		expect(result.code, result.failure).toBe(KIMCHI_NO_RESULT_EXIT_CODE)
		expect(result.stdout, result.failure).toBe("")
		expect(result.stderr, result.failure).toContain(NO_RESULT_MARKER)
		expect(result.stderr, result.failure).toMatch(/no session was saved/i)
		expectTextOutcomeEquivalence(result)
	})

	it("provider failure remains infrastructure exit 74 without a guard message", TIMEOUT, async () => {
		const failure = (): FakeResponseScript => ({ status: 503, body: { error: "Service Unavailable" } })
		const { result } = await runKimchi({
			args: ["--print", ...MODEL_ARGS, "hello"],
			responses: [failure(), failure(), failure()],
		})
		expect(result.timedOut, result.failure).toBe(false)
		expect(result.code, result.failure).toBe(KIMCHI_INFRA_ERROR_EXIT_CODE)
		expect(result.stderr, result.failure).toContain("KIMCHI_INFRA_ERROR:")
		expectNoGuardMarker(result)
		expectTextOutcomeEquivalence(result)
	})

	it("whitespace-only final answer exits 3 in text mode", TIMEOUT, async () => {
		const { result } = await runKimchi({
			args: ["--print", ...MODEL_ARGS, "hello"],
			responses: repeated({ stream: ["   "] }),
		})
		expect(result.timedOut, result.failure).toBe(false)
		expect(result.code, result.failure).toBe(KIMCHI_NO_RESULT_EXIT_CODE)
		expect(result.stdout.trim(), result.failure).toBe("")
		expect(result.stderr, result.failure).toContain(NO_RESULT_MARKER)
		expectTextOutcomeEquivalence(result)
	})

	it("thinking-only final answer exits 3 in text mode", TIMEOUT, async () => {
		const { result } = await runKimchi({
			args: ["--print", ...MODEL_ARGS, "hello"],
			responses: repeated({ thinking: ["Let me think about this."], stream: [] }),
		})
		expect(result.timedOut, result.failure).toBe(false)
		expect(result.code, result.failure).toBe(KIMCHI_NO_RESULT_EXIT_CODE)
		expect(result.stdout, result.failure).toBe("")
		expect(result.stderr, result.failure).toContain(NO_RESULT_MARKER)
		expectTextOutcomeEquivalence(result)
	})

	it("list-models exits 0 without activating the guard", TIMEOUT, async () => {
		const { result } = await runKimchi({ args: ["--list-models"] })
		expect(result.timedOut, result.failure).toBe(false)
		expect(result.code, result.failure).toBe(0)
		expect(result.stdout, result.failure).toContain(DEFAULT_MODEL.slug)
		expectNoGuardMarker(result)
		expectTextOutcomeEquivalence(result)
	})
})
