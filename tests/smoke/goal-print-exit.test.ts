import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"
import {
	DEFAULT_MODEL,
	type FakeOpenAiServer,
	resolveModels,
	startFakeOpenAiServer,
} from "../e2e/tui/support/fake-openai-server.js"

const BINARY_PATH = resolve("dist/bin/kimchi")
const PACKAGE_DIR = resolve("dist/share/kimchi")
const PROCESS_EXIT_TIMEOUT_MS = 12_000

it("keeps --print alive across continue and exits only after Goal evaluates met", { timeout: 25_000 }, async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-goal-print-exit-"))
	let fake: FakeOpenAiServer | undefined
	try {
		fake = await startFakeOpenAiServer({ responses: goalResponses() })
		const homeDir = join(tempRoot, "home")
		const workDir = join(tempRoot, "work")
		const sessionPath = join(tempRoot, "main.jsonl")
		mkdirSync(homeDir, { recursive: true })
		mkdirSync(workDir, { recursive: true })
		writeKimchiConfig(homeDir, fake.baseUrl)

		const result = await runGoalPrint(homeDir, workDir, sessionPath)
		const goals = readGoalJournal(sessionPath)
		const failure = `timedOut=${result.timedOut} code=${result.code} sessionExists=${existsSync(sessionPath)}\nstdout=${result.stdout}\nstderr=${result.stderr}`

		expect(result.timedOut, failure).toBe(false)
		expect(result.code, failure).toBe(0)
		expect(
			goals.some((goal) => goal.lastEvaluation?.verdict === "continue"),
			failure,
		).toBe(true)
		expect(goals.at(-1)?.status, failure).toBe("complete")
		expect(fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))).toHaveLength(6)
	} finally {
		await fake?.stop().catch(() => {})
		rmSync(tempRoot, { recursive: true, force: true })
	}
})

it("exits --print with code 0 when the evaluator returns no parseable verdict, instead of hanging", {
	timeout: 25_000,
}, async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-goal-print-exit-"))
	let fake: FakeOpenAiServer | undefined
	try {
		fake = await startFakeOpenAiServer({ responses: unparseableEvaluatorResponses() })
		const homeDir = join(tempRoot, "home")
		const workDir = join(tempRoot, "work")
		const sessionPath = join(tempRoot, "main.jsonl")
		mkdirSync(homeDir, { recursive: true })
		mkdirSync(workDir, { recursive: true })
		writeKimchiConfig(homeDir, fake.baseUrl)

		const result = await runGoalPrint(homeDir, workDir, sessionPath)
		const goals = readGoalJournal(sessionPath)
		const failure = `timedOut=${result.timedOut} code=${result.code} sessionExists=${existsSync(sessionPath)}\nstdout=${result.stdout}\nstderr=${result.stderr}`

		// This is the assertion the whole test exists for: a run that lands on
		// an unparseable evaluator reply must still reach a terminal status and
		// release the headless waiter, not hang until PROCESS_EXIT_TIMEOUT_MS.
		expect(result.timedOut, failure).toBe(false)
		expect(result.code, failure).toBe(0)
		expect(goals.at(-1)?.status, failure).toBe("paused")
		expect(goals.at(-1)?.lastEvaluation?.verdict, failure).toBe("unavailable")
		// Two agent completions plus one evaluator call precede the unavailable verdict.
		expect(
			fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions")),
			failure,
		).toHaveLength(3)
	} finally {
		await fake?.stop().catch(() => {})
		rmSync(tempRoot, { recursive: true, force: true })
	}
})

it("answers a resumed --print prompt instead of crashing on the session_start resume kick", {
	timeout: 25_000,
}, async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-goal-print-exit-"))
	let fake: FakeOpenAiServer | undefined
	try {
		fake = await startFakeOpenAiServer({ responses: resumedActiveGoalResponses() })
		const homeDir = join(tempRoot, "home")
		const workDir = join(tempRoot, "work")
		const sessionPath = join(tempRoot, "main.jsonl")
		mkdirSync(homeDir, { recursive: true })
		mkdirSync(workDir, { recursive: true })
		writeKimchiConfig(homeDir, fake.baseUrl)

		// Seed a valid ACTIVE journal entry directly; killing a real run risks a torn write.
		writeSeededActiveGoalSession(sessionPath, workDir)

		const prompt = "Check on progress please."
		const result = await runGoalPrint(homeDir, workDir, sessionPath, prompt)
		const goals = readGoalJournal(sessionPath)
		const failure = `timedOut=${result.timedOut} code=${result.code} sessionExists=${existsSync(sessionPath)}\nstdout=${result.stdout}\nstderr=${result.stderr}`

		expect(result.timedOut, failure).toBe(false)
		expect(result.code, failure).toBe(0)
		expect(result.stderr, failure).not.toMatch(/Agent is already processing/)
		// The resumed session's own turn actually ran: the fake server saw the
		// user's prompt on the first request, and the reply that request
		// scripted reached stdout.
		expect(
			fake.requests.some(
				(request) =>
					request.url.startsWith("/openai/v1/chat/completions") && JSON.stringify(request.body).includes(prompt),
			),
			failure,
		).toBe(true)
		expect(result.stdout, failure).toContain("Still working on it.")
		// One turn plus one evaluator confirms the deferred resume kick stood down.
		expect(
			fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions")),
			failure,
		).toHaveLength(2)
		expect(goals.at(-1)?.status, failure).toBe("blocked")
	} finally {
		await fake?.stop().catch(() => {})
		rmSync(tempRoot, { recursive: true, force: true })
	}
})

it("exits --print after update_goal blocked persists final turn usage", { timeout: 25_000 }, async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-goal-print-exit-"))
	let fake: FakeOpenAiServer | undefined
	try {
		fake = await startFakeOpenAiServer({ responses: blockedGoalResponses() })
		const homeDir = join(tempRoot, "home")
		const workDir = join(tempRoot, "work")
		const sessionPath = join(tempRoot, "main.jsonl")
		mkdirSync(homeDir, { recursive: true })
		mkdirSync(workDir, { recursive: true })
		writeKimchiConfig(homeDir, fake.baseUrl)

		const result = await runGoalPrint(homeDir, workDir, sessionPath)
		const goals = readGoalJournal(sessionPath)
		const failure = `timedOut=${result.timedOut} code=${result.code} sessionExists=${existsSync(sessionPath)}\nstdout=${result.stdout}\nstderr=${result.stderr}`

		expect(result.timedOut, failure).toBe(false)
		expect(result.code, failure).toBe(0)
		expect(goals.at(-1)?.status, failure).toBe("blocked")
		expect(goals.at(-1)?.tokensUsed, failure).toBe(10)
		expect(fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))).toHaveLength(1)
	} finally {
		await fake?.stop().catch(() => {})
		rmSync(tempRoot, { recursive: true, force: true })
	}
})

function resumedActiveGoalResponses() {
	return [
		{ stream: ["Still working on it."] },
		{ stream: ['{"verdict":"impossible","reason":"Blocked on missing external approval."}'] },
	]
}

function blockedGoalResponses() {
	return [
		{
			toolCalls: [
				{
					id: "block-goal",
					function: {
						name: "update_goal",
						arguments: JSON.stringify({ status: "blocked", reason: "needs user input" }),
					},
				},
			],
			usage: { prompt_tokens: 7, completion_tokens: 3 },
		},
	]
}

/** Write a valid session header plus an ACTIVE `kimchi_goal_state` entry for resume. */
function writeSeededActiveGoalSession(sessionPath: string, workDir: string): void {
	const now = new Date().toISOString()
	const header = { type: "session", version: 3, id: "resume-race-session", timestamp: now, cwd: workDir }
	const goalEntry = {
		type: "custom",
		customType: "kimchi_goal_state",
		data: {
			schemaVersion: 1,
			op: "put",
			goal: {
				schemaVersion: 1,
				id: "resume-race-goal",
				revision: 1,
				objective: "Implement feature A",
				status: "active",
				tokensUsed: 0,
				timeUsedMs: 0,
				createdAt: now,
				updatedAt: now,
			},
		},
		id: "seed-goal-entry",
		parentId: null,
		timestamp: now,
	}
	writeFileSync(sessionPath, `${JSON.stringify(header)}\n${JSON.stringify(goalEntry)}\n`)
}

interface GoalJournalGoal {
	status?: string
	tokensUsed?: number
	lastEvaluation?: { verdict?: string }
}

function readGoalJournal(sessionPath: string): GoalJournalGoal[] {
	const entries = (existsSync(sessionPath) ? readFileSync(sessionPath, "utf-8") : "")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
	return entries
		.filter((entry) => entry.type === "custom" && entry.customType === "kimchi_goal_state")
		.map((entry) => (entry.data as { goal?: GoalJournalGoal }).goal)
		.filter((goal): goal is GoalJournalGoal => goal !== undefined)
}

function goalResponses() {
	return [
		{
			stream: ["Creating the Todo."],
			toolCalls: [
				{
					id: "create-goal-todo",
					function: {
						name: "create_todos",
						arguments: JSON.stringify({ todos: [{ content: "Finish feature A", status: "in_progress" }] }),
					},
				},
			],
		},
		{ stream: ["Planning ended before implementation."] },
		{ stream: ['{"verdict":"continue","reason":"Implementation is not evidenced yet."}'] },
		{
			stream: ["Implementing and verifying."],
			toolCalls: [
				{
					id: "finish-goal-todo",
					function: { name: "mark_todo", arguments: JSON.stringify({ id: 1, status: "completed" }) },
				},
			],
		},
		{
			toolCalls: [
				{
					id: "claim-goal-complete",
					function: {
						name: "update_goal",
						arguments: JSON.stringify({ status: "complete", completion_confidence: "proven" }),
					},
				},
			],
		},
		{ stream: ['{"verdict":"met","reason":"The completed Todo and verification are evidenced."}'] },
	]
}

function unparseableEvaluatorResponses() {
	return [
		{
			stream: ["Creating the Todo."],
			toolCalls: [
				{
					id: "create-goal-todo",
					function: {
						name: "create_todos",
						arguments: JSON.stringify({ todos: [{ content: "Finish feature A", status: "in_progress" }] }),
					},
				},
			],
		},
		{ stream: ["Planning ended before implementation."] },
		{
			// Plain prose with no JSON object anywhere in it — no `{`...`}` run at
			// all — so parseGoalEvaluatorOutput finds nothing and the evaluator
			// call resolves as an "unavailable" verdict rather than a parsed one.
			stream: [
				"Looking over the todo list and the recent changes, the work looks finished and every planning step appears satisfied to me.",
			],
		},
	]
}

function writeKimchiConfig(homeDir: string, fakeBaseUrl: string): void {
	const configDir = join(homeDir, ".config", "kimchi")
	const harnessDir = join(configDir, "harness")
	mkdirSync(harnessDir, { recursive: true })
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({ apiKey: "fake", llmEndpoint: fakeBaseUrl, skillPaths: [], migrationState: "done" }),
	)
	writeFileSync(
		join(harnessDir, "settings.json"),
		JSON.stringify({ multiModel: false, resources: { "extensions.goal": true } }),
	)
	writeFileSync(
		join(harnessDir, "models.json"),
		JSON.stringify({
			providers: {
				fake: {
					baseUrl: `${fakeBaseUrl}/openai/v1`,
					apiKey: "fake",
					api: "openai-completions",
					authHeader: true,
					models: resolveModels(undefined).map((model) => ({
						id: model.slug,
						name: model.displayName,
						reasoning: model.reasoning,
						input: model.input,
						contextWindow: model.contextWindow,
						maxTokens: model.maxTokens,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					})),
				},
			},
		}),
	)
}

function runGoalPrint(homeDir: string, workDir: string, sessionPath: string, prompt = "/goal implement feature A") {
	return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolvePromise) => {
		const child = spawn(
			BINARY_PATH,
			["--print", "--provider", "fake", "--model", DEFAULT_MODEL.slug, "--session", sessionPath],
			{
				cwd: workDir,
				env: {
					PATH: process.env.PATH ?? "",
					HOME: homeDir,
					PI_PACKAGE_DIR: PACKAGE_DIR,
					KIMCHI_API_KEY: "fake",
					KIMCHI_PERMISSIONS: "yolo",
					KIMCHI_TELEMETRY_ENABLED: "0",
				},
			},
		)
		let stdout = ""
		let stderr = ""
		let timedOut = false
		child.stdout.setEncoding("utf-8").on("data", (chunk) => (stdout += chunk))
		child.stderr.setEncoding("utf-8").on("data", (chunk) => (stderr += chunk))
		child.stdin.end(prompt)
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
