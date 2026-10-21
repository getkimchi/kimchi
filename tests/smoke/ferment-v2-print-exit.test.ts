import { execFileSync, spawn } from "node:child_process"
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

async function withFermentV2PrintFixture(
	options: Parameters<typeof startFakeOpenAiServer>[0],
	run: (fixture: { fake: FakeOpenAiServer; homeDir: string; workDir: string; sessionPath: string }) => Promise<void>,
): Promise<void> {
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-ferment-v2-print-exit-"))
	let fake: FakeOpenAiServer | undefined
	try {
		fake = await startFakeOpenAiServer(options)
		const homeDir = join(tempRoot, "home")
		const workDir = join(tempRoot, "work")
		const sessionPath = join(tempRoot, "main.jsonl")
		mkdirSync(homeDir, { recursive: true })
		mkdirSync(workDir, { recursive: true })
		writeKimchiConfig(homeDir, fake.baseUrl, options.models)
		await run({ fake, homeDir, workDir, sessionPath })
	} finally {
		await fake?.stop().catch(() => {})
		rmSync(tempRoot, { recursive: true, force: true })
	}
}

it("recovers from malformed evaluation, completes headless, and delivers the evaluated draft exactly", {
	timeout: 25_000,
}, async () => {
	await withFermentV2PrintFixture(
		{
			responses: [
				{
					stream: ["Creating the Todo."],
					toolCalls: [
						{
							id: "create-no-todo-draft-todos",
							function: {
								name: "create_todos",
								arguments: JSON.stringify({
									todos: [
										{
											content: "Reply with exactly NO_TODO_DRAFT",
											status: "completed",
											note: "Evidence: scripted reply drafted",
										},
									],
								}),
							},
						},
					],
				},
				{ stream: ["NO_TODO_DRAFT"] },
				{
					toolCalls: [
						{
							id: "claim-no-todo-draft-complete",
							function: {
								name: "update_ferment_v2",
								arguments: JSON.stringify({ status: "complete", completion_confidence: "proven" }),
							},
						},
					],
				},
				verifierBashCheck("verifier-no-todo-draft-check"),
				verifierResponse('{"verdict":"met","checks":[{"failureMode":"quoted "text" breaks JSON"}]}'),
				verifierResponse(
					'{"verdict":"met","checks":[{"kind":"final_answer","requirement":"reply exactly NO_TODO_DRAFT","status":"pass","failureMode":"the answer could contain extra text","candidateRef":"last_assistant","observedAnswer":"NO_TODO_DRAFT","expectedAnswer":"NO_TODO_DRAFT","evidence":[]}],"reason":"ready"}',
				),
				{ stream: ["\n\nNO_TODO_DRAFT\n"] },
			],
		},
		async ({ fake, homeDir, workDir, sessionPath }) => {
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
			const chatRequests = fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
			expect(chatRequests, failure).toHaveLength(7)
			expect(chatRequests.filter(isFermentV2VerifierRequest), failure).toHaveLength(3)
			expect(JSON.stringify(chatRequests.at(-2)?.body), failure).toContain("no valid JSON verdict was returned")
			expect(JSON.stringify(chatRequests.at(-1)?.body), failure).toContain(
				'Return this evaluated draft verbatim: \\"NO_TODO_DRAFT\\"',
			)
		},
	)
})

it("keeps --print alive across continue and exits only after Ferment V2 evaluates met", {
	timeout: 25_000,
}, async () => {
	await withFermentV2PrintFixture(
		{ responses: fermentV2Responses() },
		async ({ fake, homeDir, workDir, sessionPath }) => {
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
			expect(result.stdout, failure).toBe("VERIFIED_FINAL_AFTER_EVALUATION\n")
			const chatRequests = fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
			const verifierRequests = chatRequests.filter(isFermentV2VerifierRequest)
			expect(verifierRequests, failure).toHaveLength(4)
			// The verifier is transcript-free: the hidden claim candidate never reaches it.
			expect(JSON.stringify(verifierRequests.at(-1)?.body), failure).not.toContain(
				"UNVERIFIED_CANDIDATE_MUST_STAY_HIDDEN",
			)
			expect(JSON.stringify(chatRequests.at(-1)?.body), failure).not.toContain("Return this evaluated draft verbatim")
			expect(chatRequests, failure).toHaveLength(9)
		},
	)
})

it("pauses --print and exits nonzero when final-answer delivery fails", {
	timeout: 25_000,
}, async () => {
	await withFermentV2PrintFixture(
		{ responses: fermentV2Responses({ streamError: "scripted final delivery failure" }) },
		async ({ homeDir, workDir, sessionPath }) => {
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
		},
	)
})

it("exits --print with code 0 when the verifier returns no parseable verdict, instead of hanging", {
	timeout: 25_000,
}, async () => {
	await withFermentV2PrintFixture(
		{ responses: unparseableEvaluatorResponses() },
		async ({ fake, homeDir, workDir, sessionPath }) => {
			const result = await runFermentV2Print(homeDir, workDir, sessionPath)
			const fermentV2Runs = readFermentV2Journal(sessionPath)
			const failure = `timedOut=${result.timedOut} code=${result.code} sessionExists=${existsSync(sessionPath)}\nstdout=${result.stdout}\nstderr=${result.stderr}`

			expect(result.timedOut, failure).toBe(false)
			expect(result.code, failure).toBe(0)
			expect(fermentV2Runs.at(-1)?.status, failure).toBe("paused")
			expect(fermentV2Runs.at(-1)?.lastEvaluation?.verdict, failure).toBe("unavailable")
			// Todo setup, claim, then the verifier's bash check and two unparseable
			// verdicts (the original plus the one correction prompt).
			expect(
				fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions")),
				failure,
			).toHaveLength(5)
		},
	)
})

it("answers a resumed --print prompt instead of crashing on the session_start resume kick", {
	timeout: 25_000,
}, async () => {
	await withFermentV2PrintFixture(
		{ responses: resumedActiveFermentV2Responses() },
		async ({ fake, homeDir, workDir, sessionPath }) => {
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
			// Print mode emits only the final message, which here is the blocked
			// tool result; the answered prose stays visible in the session journal.
			expect(readFileSync(sessionPath, "utf-8").match(/Still working on it\./g), failure).toHaveLength(1)
			expect(
				JSON.stringify(fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))),
				failure,
			).not.toContain("The user resumed the Kimchi session Ferment V2.")
			expect(fermentV2Runs.at(-1)?.status, failure).toBe("blocked")
		},
	)
})

it("delivers an evaluated final answer after resuming an active --print session", {
	timeout: 25_000,
}, async () => {
	await withFermentV2PrintFixture(
		{ responses: resumedActiveFermentV2CompletionResponses() },
		async ({ fake, homeDir, workDir, sessionPath }) => {
			writeSeededActiveFermentV2Session(sessionPath, workDir, true)

			const result = await runFermentV2Print(homeDir, workDir, sessionPath, "Continue the active objective.")
			const fermentV2Runs = readFermentV2Journal(sessionPath)
			const failure = `timedOut=${result.timedOut} code=${result.code}\nstdout=${result.stdout}\nstderr=${result.stderr}`

			expect(result.timedOut, failure).toBe(false)
			expect(result.code, failure).toBe(0)
			expect(result.stdout.trim(), failure).toBe("RESUMED_FINAL_AFTER_EVALUATION")
			expect(`${result.stdout}\n${result.stderr}`, failure).not.toContain("This extension ctx is stale")
			expect(fermentV2Runs.at(-1)?.status, failure).toBe("complete")
			// Resumed turn (no claim, deterministic continuation), claim turn, verifier
			// (bash check + verdict), final-answer delivery, plus possible extra provider turns.
			expect(
				fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions")).length,
				failure,
			).toBeGreaterThanOrEqual(4)
		},
	)
})

it("exits --print after update_ferment_v2 blocked persists final turn usage", { timeout: 25_000 }, async () => {
	await withFermentV2PrintFixture(
		{ responses: blockedFermentV2Responses() },
		async ({ fake, homeDir, workDir, sessionPath }) => {
			const result = await runFermentV2Print(homeDir, workDir, sessionPath)
			const fermentV2Runs = readFermentV2Journal(sessionPath)
			const failure = `timedOut=${result.timedOut} code=${result.code} sessionExists=${existsSync(sessionPath)}\nstdout=${result.stdout}\nstderr=${result.stderr}`

			expect(result.timedOut, failure).toBe(false)
			expect(result.code, failure).toBe(0)
			expect(fermentV2Runs.at(-1)?.status, failure).toBe("blocked")
			expect(fermentV2Runs.at(-1)?.tokensUsed, failure).toBe(10)
			expect(fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))).toHaveLength(1)
		},
	)
})

it("exits --print cleanly after the Ferment V2 token budget is reached", { timeout: 25_000 }, async () => {
	const models = resolveModels([{ ...DEFAULT_MODEL, contextWindow: 262_144, maxTokens: 16_384 }])
	await withFermentV2PrintFixture(
		{
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
		},
		async ({ fake, homeDir, workDir, sessionPath }) => {
			const result = await runFermentV2Print(
				homeDir,
				workDir,
				sessionPath,
				"/ferment-v2 --tokens 10 implement feature A",
			)
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
		},
	)
})

it("verifies an objective file headlessly with --print and writes the JSON report", { timeout: 25_000 }, async () => {
	await withFermentV2PrintFixture(
		{
			responses: [
				verifierBashCheck("verify-entry-check"),
				verifierResponse(
					'{"verdict":"met","reason":"The README exists.","checks":[{"kind":"work","method":"command","requirement":"the README exists","status":"pass","failureMode":"the README could be missing","evidence":["e1"]}]}',
				),
			],
		},
		async ({ fake, homeDir, workDir, sessionPath }) => {
			const git = (...args: string[]) => execFileSync("git", args, { cwd: workDir, encoding: "utf-8" }).trim()
			git("init", "-q")
			git("config", "user.email", "test@example.com")
			git("config", "user.name", "Test")
			writeFileSync(join(workDir, "README.md"), "# Project\n")
			git("add", "-A")
			git("commit", "-q", "-m", "initial")
			const head = git("rev-parse", "HEAD")
			writeFileSync(join(workDir, "objective.md"), "The README must exist.\n")

			const result = await runFermentV2Print(
				homeDir,
				workDir,
				sessionPath,
				"/ferment-v2 --verify --objective-file objective.md --out reports/verify.json",
			)
			const failure = `timedOut=${result.timedOut} code=${result.code}\nstdout=${result.stdout}\nstderr=${result.stderr}`

			expect(result.timedOut, failure).toBe(false)
			expect(result.code, failure).toBe(0)
			const report = JSON.parse(readFileSync(join(workDir, "reports", "verify.json"), "utf-8"))
			expect(report, failure).toMatchObject({
				schemaVersion: 1,
				baseline: head,
				verdict: "met",
				reason: "The README exists.",
				checks: [{ requirement: "the README exists", status: "pass", evidence: ["e1"] }],
				facts: { basis: "baseline", workspace: { changedFiles: [{ status: "A", path: "objective.md" }] } },
				integrity: { violated: false },
			})
			// Headless and stateless: no ferment was created and only the verifier talked to the model.
			expect(readFermentV2Journal(sessionPath), failure).toEqual([])
			const chatRequests = fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
			expect(chatRequests, failure).toHaveLength(2)
			expect(chatRequests.every(isFermentV2VerifierRequest), failure).toBe(true)
		},
	)
})

function resumedActiveFermentV2Responses() {
	return [
		{
			stream: ["Still working on it."],
			toolCalls: [
				{
					id: "block-resumed-ferment-v2",
					function: {
						name: "update_ferment_v2",
						arguments: JSON.stringify({ status: "blocked", reason: "Blocked on missing external approval." }),
					},
				},
			],
		},
	]
}

function resumedActiveFermentV2CompletionResponses(): FakeResponseScript[] {
	return [
		{
			match: (request) => JSON.stringify(request.body).includes("Continue the active objective."),
			stream: ["RESUMED_PROGRESS_BEFORE_CLAIM"],
		},
		{
			// The deterministic host continuation after the no-claim stop: keep working,
			// then settle Todos and submit with update_ferment_v2.
			match: (request) =>
				JSON.stringify(request.body).includes("Progress did not materially change") ||
				JSON.stringify(request.body).includes("Continue working on the active objective"),
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
		verifierBashCheck("verifier-met-check"),
		verifierResponse(
			'{"verdict":"met","reason":"The implemented feature is verified.","checks":[{"kind":"work","method":"command","requirement":"feature A is complete","status":"pass","failureMode":"the feature could be unverified; the executed check records verification","evidence":["e1"]}]}',
		),
		{
			match: (request) => JSON.stringify(request.body).includes("Give the user only the final answer"),
			stream: ["RESUMED_FINAL_AFTER_EVALUATION"],
		},
		// The provider may issue an extra model call after the terminating claim and
		// the exploration guard may steer after delivery; keep those turns harmless.
		{ stream: ["RESUMED_FINAL_AFTER_EVALUATION"] },
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
		verifierBashCheck("verifier-continue-check"),
		verifierResponse(
			'{"verdict":"continue","reason":"Implementation is not evidenced yet.","checks":[{"kind":"work","requirement":"Implement feature A","status":"fail","failureMode":"the implementation is not verified","evidence":["e1"]}]}',
		),
		{
			stream: ["UNVERIFIED_CANDIDATE_MUST_STAY_HIDDEN"],
			toolCalls: [
				{
					id: "reclaim-ferment-v2-complete",
					function: {
						name: "update_ferment_v2",
						arguments: JSON.stringify({ status: "complete", completion_confidence: "proven" }),
					},
				},
			],
		},
		verifierBashCheck("verifier-met-check"),
		verifierResponse(
			'{"verdict":"met","reason":"The implemented feature is verified.","checks":[{"kind":"work","method":"command","requirement":"feature A is complete","status":"pass","failureMode":"the feature could be unverified; the executed check records verification","evidence":["e1"]}]}',
		),
		finalAnswer,
	]
}

function isFermentV2VerifierRequest(request: FakeResponseRequest): boolean {
	return JSON.stringify(request.body).includes("<ferment_v2_verifier>")
}

/** First verifier turn: one executing bash check whose result the guard stamps as [e1]. */
function verifierBashCheck(id: string): FakeResponseScript {
	return {
		match: isFermentV2VerifierRequest,
		stream: ["Running the verification check."],
		toolCalls: [{ id, function: { name: "bash", arguments: JSON.stringify({ command: "pwd" }) } }],
	}
}

/** A verifier turn returning arbitrary text (verdict JSON or an unparseable response). */
function verifierResponse(text: string): FakeResponseScript {
	return { match: isFermentV2VerifierRequest, stream: [text] }
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
						arguments: JSON.stringify({
							todos: [{ content: "Finish feature A", status: "completed", note: "Evidence: done" }],
						}),
					},
				},
			],
		},
		{
			stream: ["Planning ended before implementation."],
			toolCalls: [
				{
					id: "claim-unparseable-complete",
					function: {
						name: "update_ferment_v2",
						arguments: JSON.stringify({ status: "complete", completion_confidence: "tested" }),
					},
				},
			],
		},
		verifierBashCheck("verifier-unparseable-check"),
		verifierResponse(
			"Looking over the todo list and the recent changes, the work looks finished and every planning step appears satisfied to me.",
		),
		verifierResponse("Still looks finished to me; no JSON verdict is needed here."),
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
