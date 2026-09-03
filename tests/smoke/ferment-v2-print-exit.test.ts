import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"
import {
	DEFAULT_MODEL,
	type FakeOpenAiServer,
	type FakeResponseRequest,
	type FakeResponseScript,
	resolveModels,
	startFakeOpenAiServer,
} from "../e2e/tui/support/fake-openai-server.js"

const BINARY_PATH = resolve("dist/bin/kimchi")
const PACKAGE_DIR = resolve("dist/share/kimchi")
const PROCESS_EXIT_TIMEOUT_MS = 12_000

it("recovers from malformed evaluation, completes headless, and delivers the evaluated draft exactly", {
	timeout: 25_000,
}, async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-ferment-v2-print-exit-"))
	let fake: FakeOpenAiServer | undefined
	try {
		fake = await startFakeOpenAiServer({
			responses: [
				{ stream: ["NO_TODO_DRAFT"] },
				{
					match: isFermentV2EvaluatorRequest,
					stream: ['{"verdict":"met","checks":[{"failureMode":"quoted "text" breaks JSON"}]}'],
				},
				{
					match: isFermentV2EvaluatorRequest,
					stream: [
						'{"verdict":"met","checks":[{"kind":"final_answer","requirement":"reply exactly NO_TODO_DRAFT","met":true,"failureMode":"the answer could contain extra text","candidateRef":"last_assistant","evidence":[]}],"reason":"ready"}',
					],
				},
				{ stream: ["\n\nNO_TODO_DRAFT\n"] },
			],
		})
		const homeDir = join(tempRoot, "home")
		const workDir = join(tempRoot, "work")
		const sessionPath = join(tempRoot, "main.jsonl")
		mkdirSync(homeDir, { recursive: true })
		mkdirSync(workDir, { recursive: true })
		writeKimchiConfig(homeDir, fake.baseUrl)

		const result = await runFermentV2Print(
			homeDir,
			workDir,
			sessionPath,
			"/ferment-v2 Reply with exactly NO_TODO_DRAFT and no other characters.",
		)
		const failure = `timedOut=${result.timedOut} code=${result.code}\nstdout=${result.stdout}\nstderr=${result.stderr}`

		expect(result.timedOut, failure).toBe(false)
		expect(result.code, failure).toBe(0)
		expect(result.stdout, failure).toBe("NO_TODO_DRAFT\n")
		expect(readFermentV2Journal(sessionPath).at(-1)?.status, failure).toBe("complete")
		expect(fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))).toHaveLength(4)
		expect(JSON.stringify(fake.requests.at(-2)?.body), failure).toContain("previous response was not valid JSON")
		expect(JSON.stringify(fake.requests.at(-1)?.body), failure).toContain(
			'Return this evaluated draft verbatim: \\"NO_TODO_DRAFT\\"',
		)
	} finally {
		await fake?.stop().catch(() => {})
		rmSync(tempRoot, { recursive: true, force: true })
	}
})

it("keeps --print alive across continue and exits only after Ferment V2 evaluates met", {
	timeout: 25_000,
}, async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-ferment-v2-print-exit-"))
	let fake: FakeOpenAiServer | undefined
	try {
		fake = await startFakeOpenAiServer({ responses: fermentV2Responses() })
		const homeDir = join(tempRoot, "home")
		const workDir = join(tempRoot, "work")
		const sessionPath = join(tempRoot, "main.jsonl")
		mkdirSync(homeDir, { recursive: true })
		mkdirSync(workDir, { recursive: true })
		writeKimchiConfig(homeDir, fake.baseUrl)

		const result = await runFermentV2Print(homeDir, workDir, sessionPath)
		const fermentV2Runs = readFermentV2Journal(sessionPath)
		const failure = `timedOut=${result.timedOut} code=${result.code} sessionExists=${existsSync(sessionPath)}\nstdout=${result.stdout}\nstderr=${result.stderr}`

		expect(result.timedOut, failure).toBe(false)
		expect(result.code, failure).toBe(0)
		expect(
			fermentV2Runs.some((fermentV2) => fermentV2.lastEvaluation?.verdict === "continue"),
			failure,
		).toBe(true)
		expect(fermentV2Runs.at(-1)?.status, failure).toBe("complete")
		expect(result.stdout, failure).not.toContain("UNVERIFIED_CANDIDATE_MUST_STAY_HIDDEN")
		expect(readFileSync(sessionPath, "utf-8"), failure).not.toContain("UNVERIFIED_CANDIDATE_MUST_STAY_HIDDEN")
		expect(result.stdout.trim(), failure).toBe("VERIFIED_FINAL_AFTER_EVALUATION")
		expect(
			JSON.stringify(
				fake.requests
					.filter(
						(request) => request.url.startsWith("/openai/v1/chat/completions") && isFermentV2EvaluatorRequest(request),
					)
					.at(-1)?.body,
			),
			failure,
		).toContain("UNVERIFIED_CANDIDATE_MUST_STAY_HIDDEN")
		expect(
			JSON.stringify(
				fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions")).at(-1)?.body,
			),
			failure,
		).toContain(
			"If the original objective requires exact output, return exactly that output with no preface or summary.",
		)
		expect(fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))).toHaveLength(7)
	} finally {
		await fake?.stop().catch(() => {})
		rmSync(tempRoot, { recursive: true, force: true })
	}
})

it("pauses --print and exits nonzero when final-answer delivery fails", {
	timeout: 25_000,
}, async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-ferment-v2-print-exit-"))
	let fake: FakeOpenAiServer | undefined
	try {
		fake = await startFakeOpenAiServer({
			responses: fermentV2Responses({ streamError: "scripted final delivery failure" }),
		})
		const homeDir = join(tempRoot, "home")
		const workDir = join(tempRoot, "work")
		const sessionPath = join(tempRoot, "main.jsonl")
		mkdirSync(homeDir, { recursive: true })
		mkdirSync(workDir, { recursive: true })
		writeKimchiConfig(homeDir, fake.baseUrl)

		const result = await runFermentV2Print(homeDir, workDir, sessionPath)
		const fermentV2Runs = readFermentV2Journal(sessionPath)
		const failure = `timedOut=${result.timedOut} code=${result.code} sessionExists=${existsSync(sessionPath)}\nstdout=${result.stdout}\nstderr=${result.stderr}`

		expect(result.timedOut, failure).toBe(false)
		expect(result.code, failure).toBe(1)
		expect(fermentV2Runs.at(-1), failure).toMatchObject({
			status: "paused",
			lastEvaluation: { verdict: "met" },
		})
		expect(result.stdout, failure).not.toContain("VERIFIED_FINAL_AFTER_EVALUATION")
		expect(result.stdout, failure).not.toContain("Ferment V2 complete.")
		expect(readFileSync(sessionPath, "utf-8"), failure).not.toContain("UNVERIFIED_CANDIDATE_MUST_STAY_HIDDEN")
	} finally {
		await fake?.stop().catch(() => {})
		rmSync(tempRoot, { recursive: true, force: true })
	}
})

it("exits --print with code 0 when the evaluator returns no parseable verdict, instead of hanging", {
	timeout: 25_000,
}, async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-ferment-v2-print-exit-"))
	let fake: FakeOpenAiServer | undefined
	try {
		fake = await startFakeOpenAiServer({ responses: unparseableEvaluatorResponses() })
		const homeDir = join(tempRoot, "home")
		const workDir = join(tempRoot, "work")
		const sessionPath = join(tempRoot, "main.jsonl")
		mkdirSync(homeDir, { recursive: true })
		mkdirSync(workDir, { recursive: true })
		writeKimchiConfig(homeDir, fake.baseUrl)

		const result = await runFermentV2Print(homeDir, workDir, sessionPath)
		const fermentV2Runs = readFermentV2Journal(sessionPath)
		const failure = `timedOut=${result.timedOut} code=${result.code} sessionExists=${existsSync(sessionPath)}\nstdout=${result.stdout}\nstderr=${result.stderr}`

		expect(result.timedOut, failure).toBe(false)
		expect(result.code, failure).toBe(0)
		expect(fermentV2Runs.at(-1)?.status, failure).toBe("paused")
		expect(fermentV2Runs.at(-1)?.lastEvaluation?.verdict, failure).toBe("unavailable")
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
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-ferment-v2-print-exit-"))
	let fake: FakeOpenAiServer | undefined
	try {
		fake = await startFakeOpenAiServer({ responses: resumedActiveFermentV2Responses() })
		const homeDir = join(tempRoot, "home")
		const workDir = join(tempRoot, "work")
		const sessionPath = join(tempRoot, "main.jsonl")
		mkdirSync(homeDir, { recursive: true })
		mkdirSync(workDir, { recursive: true })
		writeKimchiConfig(homeDir, fake.baseUrl)

		writeSeededActiveFermentV2Session(sessionPath, workDir)

		const prompt = "Check on progress please."
		const result = await runFermentV2Print(homeDir, workDir, sessionPath, prompt)
		const fermentV2Runs = readFermentV2Journal(sessionPath)
		const failure = `timedOut=${result.timedOut} code=${result.code} sessionExists=${existsSync(sessionPath)}\nstdout=${result.stdout}\nstderr=${result.stderr}`

		expect(result.timedOut, failure).toBe(false)
		expect(result.code, failure).toBe(0)
		expect(result.stderr, failure).not.toMatch(/Agent is already processing/)
		expect(
			fake.requests.some(
				(request) =>
					request.url.startsWith("/openai/v1/chat/completions") && JSON.stringify(request.body).includes(prompt),
			),
			failure,
		).toBe(true)
		expect(result.stdout.match(/Still working on it\./g), failure).toHaveLength(1)
		expect(readFileSync(sessionPath, "utf-8").match(/Still working on it\./g), failure).toHaveLength(1)
		expect(
			JSON.stringify(fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))),
			failure,
		).not.toContain("The user resumed the Kimchi session Ferment V2.")
		expect(fermentV2Runs.at(-1)?.status, failure).toBe("blocked")
	} finally {
		await fake?.stop().catch(() => {})
		rmSync(tempRoot, { recursive: true, force: true })
	}
})

it("delivers an evaluated final answer after resuming an active --print session", {
	timeout: 25_000,
}, async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-ferment-v2-print-exit-"))
	let fake: FakeOpenAiServer | undefined
	try {
		fake = await startFakeOpenAiServer({ responses: resumedActiveFermentV2CompletionResponses() })
		const homeDir = join(tempRoot, "home")
		const workDir = join(tempRoot, "work")
		const sessionPath = join(tempRoot, "main.jsonl")
		mkdirSync(homeDir, { recursive: true })
		mkdirSync(workDir, { recursive: true })
		writeKimchiConfig(homeDir, fake.baseUrl)
		writeSeededActiveFermentV2Session(sessionPath, workDir, true)

		const result = await runFermentV2Print(homeDir, workDir, sessionPath, "Continue the active objective.")
		const fermentV2Runs = readFermentV2Journal(sessionPath)
		const failure = `timedOut=${result.timedOut} code=${result.code}\nstdout=${result.stdout}\nstderr=${result.stderr}`

		expect(result.timedOut, failure).toBe(false)
		expect(result.code, failure).toBe(0)
		expect(result.stdout.trim(), failure).toBe("RESUMED_FINAL_AFTER_EVALUATION")
		expect(`${result.stdout}\n${result.stderr}`, failure).not.toContain("This extension ctx is stale")
		expect(fermentV2Runs.at(-1)?.status, failure).toBe("complete")
		expect(fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))).toHaveLength(6)
	} finally {
		await fake?.stop().catch(() => {})
		rmSync(tempRoot, { recursive: true, force: true })
	}
})

it("exits --print after update_ferment_v2 blocked persists final turn usage", { timeout: 25_000 }, async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-ferment-v2-print-exit-"))
	let fake: FakeOpenAiServer | undefined
	try {
		fake = await startFakeOpenAiServer({ responses: blockedFermentV2Responses() })
		const homeDir = join(tempRoot, "home")
		const workDir = join(tempRoot, "work")
		const sessionPath = join(tempRoot, "main.jsonl")
		mkdirSync(homeDir, { recursive: true })
		mkdirSync(workDir, { recursive: true })
		writeKimchiConfig(homeDir, fake.baseUrl)

		const result = await runFermentV2Print(homeDir, workDir, sessionPath)
		const fermentV2Runs = readFermentV2Journal(sessionPath)
		const failure = `timedOut=${result.timedOut} code=${result.code} sessionExists=${existsSync(sessionPath)}\nstdout=${result.stdout}\nstderr=${result.stderr}`

		expect(result.timedOut, failure).toBe(false)
		expect(result.code, failure).toBe(0)
		expect(fermentV2Runs.at(-1)?.status, failure).toBe("blocked")
		expect(fermentV2Runs.at(-1)?.tokensUsed, failure).toBe(10)
		expect(fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))).toHaveLength(1)
	} finally {
		await fake?.stop().catch(() => {})
		rmSync(tempRoot, { recursive: true, force: true })
	}
})

it("exits --print cleanly after the Ferment V2 token budget is reached", { timeout: 25_000 }, async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-ferment-v2-print-exit-"))
	let fake: FakeOpenAiServer | undefined
	try {
		const models = resolveModels([{ ...DEFAULT_MODEL, contextWindow: 262_144, maxTokens: 16_384 }])
		fake = await startFakeOpenAiServer({
			models,
			responses: [
				{
					toolCalls: [
						{
							id: "work-before-budget",
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "pwd" }),
							},
						},
					],
					usage: { prompt_tokens: 7, completion_tokens: 3 },
				},
				{ stream: ["UNVERIFIED_POST_BUDGET_OUTPUT"] },
			],
		})
		const homeDir = join(tempRoot, "home")
		const workDir = join(tempRoot, "work")
		const sessionPath = join(tempRoot, "main.jsonl")
		mkdirSync(homeDir, { recursive: true })
		mkdirSync(workDir, { recursive: true })
		writeKimchiConfig(homeDir, fake.baseUrl, models)

		const result = await runFermentV2Print(homeDir, workDir, sessionPath, "/ferment-v2 --tokens 10 implement feature A")
		const fermentV2Runs = readFermentV2Journal(sessionPath)
		const failure = `timedOut=${result.timedOut} code=${result.code} sessionExists=${existsSync(sessionPath)}\nstdout=${result.stdout}\nstderr=${result.stderr}`

		expect(result.timedOut, failure).toBe(false)
		expect(result.code, failure).toBe(0)
		expect(fermentV2Runs.at(-1), failure).toMatchObject({ status: "budget_limited", tokensUsed: 10 })
		expect(result.stdout, failure).not.toContain("UNVERIFIED_POST_BUDGET_OUTPUT")
		expect(readFileSync(sessionPath, "utf-8"), failure).not.toContain("UNVERIFIED_POST_BUDGET_OUTPUT")
		expect(fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))).toHaveLength(2)
		expect(`${result.stdout}\n${result.stderr}`, failure).not.toContain("This extension ctx is stale")
		expect(`${result.stdout}\n${result.stderr}`, failure).not.toContain("Extension error")
	} finally {
		await fake?.stop().catch(() => {})
		rmSync(tempRoot, { recursive: true, force: true })
	}
})

function resumedActiveFermentV2Responses() {
	return [
		{ stream: ["Still working on it."] },
		{
			match: isFermentV2EvaluatorRequest,
			stream: ['{"verdict":"impossible","reason":"Blocked on missing external approval."}'],
		},
	]
}

function resumedActiveFermentV2CompletionResponses(): FakeResponseScript[] {
	return [
		{ stream: ["RESUMED_PROGRESS_MUST_STAY_HIDDEN"] },
		{
			match: isFermentV2EvaluatorRequest,
			stream: ['{"verdict":"continue","reason":"Run one final verification before delivery."}'],
		},
		{
			stream: ["UNVERIFIED_RESUMED_CANDIDATE"],
			toolCalls: [
				{
					id: "claim-resumed-ferment-v2-complete",
					function: {
						name: "update_ferment_v2",
						arguments: JSON.stringify({ status: "complete", completion_confidence: "proven" }),
					},
				},
			],
		},
		{ stream: ["UNVERIFIED_RESUMED_CANDIDATE_AFTER_CLAIM"] },
		{
			match: isFermentV2EvaluatorRequest,
			stream: [
				'{"verdict":"met","checks":[{"requirement":"feature A is complete","met":true,"failureMode":"the feature could be unverified; l1 records verification","evidence":["l1"],"todoIds":[1]}],"reason":"The completed Todo and retained evidence record verification."}',
			],
		},
		{ stream: ["RESUMED_FINAL_AFTER_EVALUATION"] },
	]
}

function blockedFermentV2Responses() {
	return [
		{
			toolCalls: [
				{
					id: "block-ferment-v2",
					function: {
						name: "update_ferment_v2",
						arguments: JSON.stringify({ status: "blocked", reason: "needs user input" }),
					},
				},
			],
			usage: { prompt_tokens: 7, completion_tokens: 3 },
		},
	]
}

function writeSeededActiveFermentV2Session(sessionPath: string, workDir: string, withCompletedTodo = false): void {
	const now = new Date().toISOString()
	const header = { type: "session", version: 3, id: "resume-race-session", timestamp: now, cwd: workDir }
	const fermentV2Entry = {
		type: "custom",
		customType: "kimchi_ferment_v2_state",
		data: {
			schemaVersion: 1,
			op: "put",
			fermentV2: {
				schemaVersion: 1,
				id: "resume-race-ferment-v2",
				revision: 1,
				objective: "Implement feature A",
				status: "active",
				tokensUsed: 0,
				timeUsedMs: 0,
				createdAt: now,
				updatedAt: now,
			},
		},
		id: "seed-ferment-v2-entry",
		parentId: null,
		timestamp: now,
	}
	const entries = [header, fermentV2Entry]
	if (withCompletedTodo) {
		entries.push({
			type: "custom",
			customType: "kimchi.todos",
			data: {
				schemaVersion: 1,
				scope: { kind: "global" },
				todos: [
					{
						id: 1,
						content: "Finish feature A",
						status: "completed",
						note: "Evidence: scripted verification completed",
					},
				],
				updatedAt: now,
			},
			id: "seed-ferment-v2-todo",
			parentId: "seed-ferment-v2-entry",
			timestamp: now,
		})
	}
	writeFileSync(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`)
}

interface FermentV2JournalState {
	status?: string
	tokensUsed?: number
	lastEvaluation?: { verdict?: string }
}

function readFermentV2Journal(sessionPath: string): FermentV2JournalState[] {
	const entries = (existsSync(sessionPath) ? readFileSync(sessionPath, "utf-8") : "")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
	return entries
		.filter((entry) => entry.type === "custom" && entry.customType === "kimchi_ferment_v2_state")
		.map((entry) => (entry.data as { fermentV2?: FermentV2JournalState }).fermentV2)
		.filter((fermentV2): fermentV2 is FermentV2JournalState => fermentV2 !== undefined)
}

function fermentV2Responses(
	finalAnswer: FakeResponseScript = { stream: ["VERIFIED_FINAL_AFTER_EVALUATION"] },
): FakeResponseScript[] {
	return [
		{
			stream: ["Creating the Todo."],
			toolCalls: [
				{
					id: "create-ferment-v2-todo",
					function: {
						name: "create_todos",
						arguments: JSON.stringify({ todos: [{ content: "Finish feature A", status: "in_progress" }] }),
					},
				},
			],
		},
		{ stream: ["Planning ended before implementation."] },
		{
			match: isFermentV2EvaluatorRequest,
			stream: ['{"verdict":"continue","reason":"Implementation is not evidenced yet."}'],
		},
		{
			stream: ["Implementing and verifying."],
			toolCalls: [
				{
					id: "finish-ferment-v2-todo",
					function: {
						name: "mark_todo",
						arguments: JSON.stringify({
							id: 1,
							status: "completed",
							note: "Evidence: scripted verification completed",
						}),
					},
				},
			],
		},
		{
			stream: ["UNVERIFIED_CANDIDATE_MUST_STAY_HIDDEN"],
			toolCalls: [
				{
					id: "claim-ferment-v2-complete",
					function: {
						name: "update_ferment_v2",
						arguments: JSON.stringify({ status: "complete", completion_confidence: "proven" }),
					},
				},
			],
		},
		{
			match: isFermentV2EvaluatorRequest,
			stream: [
				'{"verdict":"met","checks":[{"requirement":"feature A is complete","met":true,"failureMode":"the feature could be unverified; l1 records verification","evidence":["l1"],"todoIds":[1]}],"reason":"The completed Todo and retained evidence record verification."}',
			],
		},
		finalAnswer,
	]
}

function isFermentV2EvaluatorRequest(request: FakeResponseRequest): boolean {
	return JSON.stringify(request.body).includes("<ferment_v2_evaluator>")
}

function unparseableEvaluatorResponses() {
	return [
		{
			stream: ["Creating the Todo."],
			toolCalls: [
				{
					id: "create-ferment-v2-todo",
					function: {
						name: "create_todos",
						arguments: JSON.stringify({ todos: [{ content: "Finish feature A", status: "in_progress" }] }),
					},
				},
			],
		},
		{ stream: ["Planning ended before implementation."] },
		{
			stream: [
				"Looking over the todo list and the recent changes, the work looks finished and every planning step appears satisfied to me.",
			],
		},
	]
}

function writeKimchiConfig(homeDir: string, fakeBaseUrl: string, models = resolveModels(undefined)): void {
	const configDir = join(homeDir, ".config", "kimchi")
	const harnessDir = join(configDir, "harness")
	mkdirSync(harnessDir, { recursive: true })
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({ apiKey: "fake", llmEndpoint: fakeBaseUrl, skillPaths: [], migrationState: "done" }),
	)
	writeFileSync(
		join(harnessDir, "settings.json"),
		JSON.stringify({ multiModel: false, resources: { "extensions.ferment-v2": true } }),
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
					models: models.map((model) => ({
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

function runFermentV2Print(
	homeDir: string,
	workDir: string,
	sessionPath: string,
	prompt = "/ferment-v2 implement feature A",
) {
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
