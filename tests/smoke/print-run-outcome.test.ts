import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { CLASSIFIER_NOT_CONFIGURED_BLOCK_REASON } from "../../src/extensions/permissions/classifier-health.js"
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
const RECALL_MODULE_URL = pathToFileURL(resolve("src/extensions/memory/recall.ts")).href

interface RunResult {
	code: number | null
	stdout: string
	stderr: string
	timedOut: boolean
	failure: string
}

interface SharedFixture {
	tempRoot: string
	fake: FakeOpenAiServer
}

interface RunOptions {
	args: string[]
	responses?: FakeResponseScript[]
	stdin?: string
	/** "none" passes --no-session; otherwise a session file is passed. */
	session?: "file" | "none"
	prepare?: (workDir: string, homeDir: string) => void
	permissions?: string
	/** Reuse one fake server and session directory across independent processes. */
	fixture?: SharedFixture
}

interface Harness {
	result: RunResult
	sessionPath: string
	workDir: string
	requests: FakeOpenAiServer["requests"]
	sessionText?: string
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
	const tempRoot = options.fixture?.tempRoot ?? mkdtempSync(join(tmpdir(), "kimchi-print-outcome-"))
	let fake = options.fixture?.fake
	try {
		fake ??= await startFakeOpenAiServer({ responses: options.responses ?? [] })
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
		const sessionText = existsSync(sessionPath) ? readFileSync(sessionPath, "utf-8") : undefined
		return { result, sessionPath, workDir, requests: fake.requests, ...(sessionText ? { sessionText } : {}) }
	} finally {
		if (!options.fixture) {
			await fake?.stop().catch(() => {})
			rmSync(tempRoot, { recursive: true, force: true })
		}
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

function createTodosThenScript(final: FakeResponseScript): FakeResponseScript[] {
	return [
		{
			toolCalls: [
				{
					id: "call_create_todos",
					type: "function",
					function: {
						name: "create_todos",
						arguments: JSON.stringify({ todos: [{ content: "Verify the answer", status: "pending" }] }),
					},
				},
			],
		},
		final,
	]
}

function prepareAbortAfterPartialAnswer(workDir: string, homeDir: string): void {
	const harnessSettings = join(homeDir, ".config", "kimchi", "harness", "settings.json")
	const settings = JSON.parse(readFileSync(harnessSettings, "utf-8")) as Record<string, unknown>
	const extensionDir = join(workDir, ".kimchi", "extensions")
	const extensionPath = join(extensionDir, "abort-after-partial-answer.ts")
	mkdirSync(extensionDir, { recursive: true })
	writeFileSync(
		harnessSettings,
		JSON.stringify({ ...settings, defaultProjectTrust: "always", extensions: [extensionPath] }),
	)
	writeFileSync(
		extensionPath,
		`export default function abortAfterPartialAnswer(pi) {
  let todosCreated = false
  pi.on("tool_result", (event) => {
    if (event.toolName === "create_todos") todosCreated = true
  })
  pi.on("message_update", (_event, ctx) => {
    if (todosCreated) ctx.abort()
  })
}
`,
	)
}

function writeProbeExtension(workDir: string, homeDir: string, name: string, source: string): void {
	const harnessSettings = join(homeDir, ".config", "kimchi", "harness", "settings.json")
	const settings = JSON.parse(readFileSync(harnessSettings, "utf-8")) as Record<string, unknown>
	const extensionDir = join(workDir, ".kimchi", "extensions")
	const extensionPath = join(extensionDir, name)
	mkdirSync(extensionDir, { recursive: true })
	writeFileSync(
		harnessSettings,
		JSON.stringify({ ...settings, defaultProjectTrust: "always", extensions: [extensionPath] }),
	)
	writeFileSync(extensionPath, source)
}

function prepareRecallProbe(
	timing: "immediate" | "final-message" | "first-error",
	fact: string,
): NonNullable<RunOptions["prepare"]> {
	return (workDir, homeDir) => {
		writeProbeExtension(
			workDir,
			homeDir,
			"recall-probe.ts",
			`import { runRecall } from ${JSON.stringify(RECALL_MODULE_URL)}
export default function recallProbe(pi) {
  let releaseSearch
  const searchGate = new Promise((resolve) => { releaseSearch = resolve })
  let recallPromise
  pi.on("agent_start", (_event, ctx) => {
    if (recallPromise) return
    recallPromise = (async () => {
      const originalInfo = console.info
      console.info = (...args) => {
        if (typeof args[0] === "string" && args[0].startsWith("[memory]")) return
        originalInfo(...args)
      }
      try {
      return await runRecall({
      trigger: "user-turn",
      query: "uncovered recall smoke query",
      pi,
      ctx,
      search: async () => {
        if (${JSON.stringify(timing)} !== "immediate") await searchGate
        return [{ id: "smoke-fact", memory: ${JSON.stringify(fact)}, score: 0.95 }]
      },
      decideGate: null,
      deliveredFacts: [],
      deliveredKeys: new Set(),
      emit: () => {},
      })
      } finally {
        console.info = originalInfo
      }
    })().then((outcome) => {
      console.error("RECALL_PROBE_OUTCOME:" + outcome)
    })
  })
  pi.on("message_end", (event) => {
    const releaseStopReason = ${JSON.stringify(timing === "final-message" ? "stop" : timing === "first-error" ? "error" : "")}
    if (event.message.role === "assistant" && event.message.stopReason === releaseStopReason) releaseSearch()
  })
  pi.on("agent_settled", async () => {
    if (recallPromise) await recallPromise
  })
}
`,
		)
	}
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.flatMap((part) => {
			if (typeof part !== "object" || part === null || !("text" in part) || typeof part.text !== "string") return []
			return [part.text]
		})
		.join("\n")
}

function parseJsonLines(stdout: string): { type?: string }[] {
	return stdout
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as { type?: string })
}

const TIMEOUT = { timeout: 45_000 }
const PRINT_MODES = [
	["text", []],
	["json", ["--mode", "json"]],
] as const

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
		expect(result.stderr, result.failure).toContain(CLASSIFIER_NOT_CONFIGURED_BLOCK_REASON)
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

	it.each(PRINT_MODES)(
		"todo changes do not displace the final assistant answer in %s mode",
		TIMEOUT,
		async (mode, modeArgs) => {
			const { result } = await runKimchi({
				args: ["--print", ...modeArgs, ...MODEL_ARGS, "track work and answer"],
				responses: createTodosThenScript({ stream: ["ANSWER AFTER TODO STATE"] }),
			})

			expect(result.timedOut, result.failure).toBe(false)
			expect(result.code, result.failure).toBe(0)
			expectNoGuardMarker(result)
			if (mode === "text") {
				expect(result.stdout, result.failure).toBe("ANSWER AFTER TODO STATE\n")
				expectTextOutcomeEquivalence(result)
			} else {
				expect(result.stdout, result.failure).toContain("ANSWER AFTER TODO STATE")
				expect(result.stdout, result.failure).not.toContain('"customType":"todo-state"')
			}
		},
	)

	it.each(PRINT_MODES)(
		"persists a cleared todo state across fresh processes after a %s answer",
		TIMEOUT,
		async (mode, modeArgs) => {
			const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-print-clear-resume-"))
			const fake = await startFakeOpenAiServer({
				responses: [
					...createTodosThenScript({ stream: ["PENDING STATE ANSWER"] }),
					{
						toolCalls: [
							{
								id: "call_clear_todos",
								type: "function",
								function: { name: "clear_todos", arguments: "{}" },
							},
						],
					},
					{ stream: ["CLEARED STATE ANSWER"] },
					{ stream: ["RESUMED CLEARED ANSWER"] },
				],
			})
			const fixture = { tempRoot, fake }
			const expectAnswer = ({ result }: Harness, answer: string) => {
				expect(result.timedOut, result.failure).toBe(false)
				expect(result.code, result.failure).toBe(0)
				expectNoGuardMarker(result)
				if (mode === "text") {
					expect(result.stdout, result.failure).toBe(`${answer}\n`)
				} else {
					expect(result.stdout, result.failure).toContain(answer)
					expect(result.stdout, result.failure).not.toContain('"customType":"todo-state"')
				}
			}
			try {
				const seeded = await runKimchi({
					fixture,
					args: ["--print", ...modeArgs, ...MODEL_ARGS, "create a pending todo"],
				})
				const cleared = await runKimchi({
					fixture,
					args: ["--print", ...modeArgs, ...MODEL_ARGS, "clear the todo"],
				})
				const resumed = await runKimchi({
					fixture,
					args: ["--print", ...modeArgs, ...MODEL_ARGS, "continue after a fresh-process resume"],
				})

				expectAnswer(seeded, "PENDING STATE ANSWER")
				expectAnswer(cleared, "CLEARED STATE ANSWER")
				expectAnswer(resumed, "RESUMED CLEARED ANSWER")

				const chatRequests = resumed.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
				const lastRequest = chatRequests.at(-1)
				if (!lastRequest) throw new Error(`No resumed chat request. ${resumed.result.failure}`)
				const messages = (lastRequest.body as { messages?: { role?: string; content?: unknown }[] }).messages ?? []
				const stateBlocks = messages
					.filter((message) => message.role === "user")
					.map((message) => messageText(message.content))
					.filter((text) => text.includes("## Current Todos"))
				expect(stateBlocks, resumed.result.failure).toHaveLength(1)
				expect(stateBlocks[0], resumed.result.failure).toContain("The todo list was cleared.")
				expect(stateBlocks[0], resumed.result.failure).not.toContain("Verify the answer")
				expect(cleared.sessionText, cleared.result.failure).toContain("The todo list was cleared.")
			} finally {
				await fake.stop().catch(() => {})
				rmSync(tempRoot, { recursive: true, force: true })
			}
		},
	)

	it.each(PRINT_MODES)(
		"memory recall resolving at the final message stays out of the %s answer tail",
		TIMEOUT,
		async (mode, modeArgs) => {
			const { result } = await runKimchi({
				args: ["--print", ...modeArgs, ...MODEL_ARGS, "answer normally"],
				responses: [{ stream: ["ANSWER BEFORE LATE RECALL"] }],
				prepare: prepareRecallProbe("final-message", "DELAYED MEMORY FACT"),
			})

			expect(result.timedOut, result.failure).toBe(false)
			expect(result.code, result.failure).toBe(0)
			expect(result.stderr, result.failure).toContain("RECALL_PROBE_OUTCOME:injected")
			expectNoGuardMarker(result)
			if (mode === "text") {
				expect(result.stdout, result.failure).toBe("ANSWER BEFORE LATE RECALL\n")
				expectTextOutcomeEquivalence(result)
			} else {
				expect(result.stdout, result.failure).toContain("ANSWER BEFORE LATE RECALL")
				expect(result.stdout, result.failure).not.toContain('"customType":"memory-recall"')
			}
		},
	)

	it.each(PRINT_MODES)(
		"retry replays first-error memory context into the next %s request",
		TIMEOUT,
		async (mode, modeArgs) => {
			const fact = "RETRY MEMORY CONTEXT"
			const { result, requests, sessionText } = await runKimchi({
				args: ["--print", ...modeArgs, ...MODEL_ARGS, "retry with memory"],
				responses: [{ status: 503, body: { error: "Service Unavailable" } }, { stream: ["RETRY ANSWER"] }],
				prepare: prepareRecallProbe("first-error", fact),
			})

			expect(result.timedOut, result.failure).toBe(false)
			expect(result.code, result.failure).toBe(0)
			expect(result.stderr, result.failure).toContain("RECALL_PROBE_OUTCOME:injected")
			expectNoGuardMarker(result)
			if (mode === "text") {
				expect(result.stdout, result.failure).toBe("RETRY ANSWER\n")
				expectTextOutcomeEquivalence(result)
			} else {
				expect(result.stdout, result.failure).toContain("RETRY ANSWER")
				expect(result.stdout, result.failure).toContain('"customType":"memory-recall"')
			}
			expect(sessionText, result.failure).toContain(fact)
			const chatRequests = requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
			expect(chatRequests.length, result.failure).toBeGreaterThan(1)
			expect(JSON.stringify(chatRequests[1]?.body), result.failure).toContain(fact)
		},
	)

	it.each(PRINT_MODES)(
		"replays hidden context into a second request in the same %s run",
		TIMEOUT,
		async (mode, modeArgs) => {
			const fact = "BUFFERED CONTINUATION FACT"
			const steer = "CONTINUE WITH THE FACT"
			const { result, requests, sessionText } = await runKimchi({
				args: ["--print", ...modeArgs, ...MODEL_ARGS, "answer and continue"],
				responses: [{ stream: ["FIRST ANSWER"] }, { stream: ["CONTINUATION ANSWER"] }],
				prepare: (workDir, homeDir) =>
					writeProbeExtension(
						workDir,
						homeDir,
						"continue-after-answer.ts",
						`export default function continueAfterAnswer(pi) {
  let sent = false
  pi.on("turn_end", (event) => {
    if (sent || event.message.stopReason !== "stop") return
    sent = true
    pi.sendMessage(
      { customType: "buffered-context", content: ${JSON.stringify(fact)}, display: false },
      { deliverAs: "steer", triggerTurn: false },
    )
    pi.sendMessage(
      { customType: "continuation-steer", content: ${JSON.stringify(steer)}, display: false },
      { deliverAs: "steer" },
    )
  })
}
`,
					),
			})
			expect(result.code, result.failure).toBe(0)
			expectNoGuardMarker(result)
			if (mode === "text") {
				expect(result.stdout, result.failure).toBe("CONTINUATION ANSWER\n")
			} else {
				expect(result.stdout, result.failure).toContain("CONTINUATION ANSWER")
			}
			const chatRequests = requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
			expect(chatRequests, result.failure).toHaveLength(2)
			const nextRequest = JSON.stringify(chatRequests[1]?.body)
			const factPosition = nextRequest.indexOf(fact)
			expect(factPosition, "buffered fact is missing from the second request").toBeGreaterThanOrEqual(0)
			expect(nextRequest.indexOf(steer)).toBeGreaterThan(factPosition)
			const journalFactPosition = sessionText?.indexOf(fact) ?? -1
			expect(journalFactPosition).toBeGreaterThanOrEqual(0)
			expect(sessionText?.indexOf(steer)).toBeGreaterThan(journalFactPosition)
		},
	)

	it("memory recall resolving during a tool turn reaches the next model request", TIMEOUT, async () => {
		const fact = "RECALL DURING ACTIVE TURN"
		const { result, requests } = await runKimchi({
			args: ["--print", ...MODEL_ARGS, "use memory while answering"],
			responses: createTodosThenScript({ stream: ["ANSWER WITH ACTIVE RECALL"] }),
			prepare: prepareRecallProbe("immediate", fact),
		})

		expect(result.timedOut, result.failure).toBe(false)
		expect(result.code, result.failure).toBe(0)
		expect(result.stdout, result.failure).toBe("ANSWER WITH ACTIVE RECALL\n")
		expect(result.stderr, result.failure).toContain("RECALL_PROBE_OUTCOME:injected")
		const chatRequests = requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
		expect(chatRequests.length, result.failure).toBeGreaterThan(1)
		expect(
			chatRequests.slice(1).some((request) => JSON.stringify(request.body).includes(fact)),
			result.failure,
		).toBe(true)
	})

	for (const scenario of [
		{
			name: "length",
			stopReason: "length",
			response: { stream: ["PARTIAL ANSWER"], finishReason: "length" },
			diagnostic: "Response was truncated: the model reached its output token limit.",
		},
		{
			name: "stream error",
			stopReason: "error",
			response: { streamError: "SCRIPTED STREAM FAILURE" },
			diagnostic: "Provider finish_reason: error",
			eventText: "SCRIPTED STREAM FAILURE",
		},
	] satisfies Array<{
		name: string
		stopReason: "length" | "error"
		response: FakeResponseScript
		diagnostic: string
		eventText?: string
	}>) {
		it.each(PRINT_MODES)(`${scenario.name} after todo changes exits 1 in %s mode`, TIMEOUT, async (mode, modeArgs) => {
			const { result } = await runKimchi({
				args: ["--print", ...modeArgs, ...MODEL_ARGS, "track work and answer"],
				responses: createTodosThenScript(scenario.response),
			})

			expect(result.timedOut, result.failure).toBe(false)
			expect(result.code, result.failure).toBe(1)
			expect(result.stderr, result.failure).toContain(scenario.diagnostic)
			expectNoGuardMarker(result)
			if (mode === "json") {
				expect(result.stdout, result.failure).toContain(`"stopReason":"${scenario.stopReason}"`)
				expect(result.stdout, result.failure).not.toContain('"customType":"todo-state"')
				if (scenario.eventText) expect(result.stdout, result.failure).toContain(scenario.eventText)
			}
		})
	}

	it.each(PRINT_MODES)("aborted answer after todo changes exits 1 in %s mode", TIMEOUT, async (mode, modeArgs) => {
		const { result } = await runKimchi({
			args: ["--print", ...modeArgs, ...MODEL_ARGS, "track work and answer"],
			responses: createTodosThenScript({ stream: ["ABORT DURING ANSWER"] }),
			prepare: prepareAbortAfterPartialAnswer,
		})

		expect(result.timedOut, result.failure).toBe(false)
		expect(result.code, result.failure).toBe(1)
		expect(result.stderr, result.failure).toContain("Request was aborted")
		expectNoGuardMarker(result)
		if (mode === "json") {
			expect(result.stdout, result.failure).toContain('"stopReason":"aborted"')
			expect(result.stdout, result.failure).not.toContain('"customType":"todo-state"')
		}
	})

	it("print with no prompt exits 2 with actionable stderr", TIMEOUT, async () => {
		const { result } = await runKimchi({ args: ["--print", ...MODEL_ARGS] })
		expect(result.timedOut, result.failure).toBe(false)
		expect(result.code, result.failure).toBe(KIMCHI_NO_PROMPT_EXIT_CODE)
		expect(result.stdout, result.failure).toBe("")
		expect(result.stderr, result.failure).toContain(NO_PROMPT_MARKER)
		expect(result.stderr, result.failure).toContain(
			"A flag that needs a value, such as --model, may have taken the prompt as its value.",
		)
		expect(result.stderr, result.failure).toContain(
			"Give each such flag its own value, or put the prompt before the flags.",
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
			"Give each such flag its own value, or put the prompt before the flags.",
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
