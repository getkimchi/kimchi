import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
	DEFAULT_MODEL,
	type FakeOpenAiServer,
	type FakeResponseScript,
	type RecordedRequest,
	resolveModels,
	startFakeOpenAiServer,
} from "../e2e/tui/support/fake-openai-server.js"

const BINARY_PATH = resolve("dist/bin/kimchi")
const PACKAGE_DIR = resolve("dist/share/kimchi")
const FAKE_PROVIDER = "fake"
const FINAL_TEXT = "One-shot process lifecycle complete."
const PROCESS_EXIT_TIMEOUT_MS = 12_000

interface ProcessResult {
	code: number | null
	signal: NodeJS.Signals | null
	stdout: string
	stderr: string
	timedOut: boolean
}

interface JsonlEntry {
	type?: string
	customType?: string
	raw?: string
	message?: {
		role?: string
		toolName?: string
		content?: Array<{ type?: string; text?: string; name?: string }>
	}
}

describe("--ferment-oneshot process lifecycle", () => {
	// LLM-2404: the benchmark observed `agent_end` after Ferment completion, but
	// the kimchi process stayed alive until Harbor killed it. This reproduces the
	// real linked-worker one-shot path and asserts the CLI process exits cleanly.
	it("exits after ferment completion, final assistant message, and agent_end", async () => {
		await expectOneshotLifecycleToExit()
	}, 25_000)
})

async function expectOneshotLifecycleToExit(): Promise<void> {
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-ferment-oneshot-exit-"))
	let fake: FakeOpenAiServer | undefined

	try {
		fake = await startFakeOpenAiServer({ responses: oneShotCompletionScript() })
		const homeDir = join(tempRoot, "home")
		const workDir = join(tempRoot, "work")
		const sessionDir = join(tempRoot, "sessions")
		const fermentsDir = join(tempRoot, "ferments")
		mkdirSync(homeDir, { recursive: true })
		mkdirSync(workDir, { recursive: true })
		mkdirSync(sessionDir, { recursive: true })
		mkdirSync(fermentsDir, { recursive: true })
		writeKimchiConfig(homeDir, fake.baseUrl)

		const sessionPath = join(sessionDir, "main.jsonl")
		const result = await runOneshot({
			homeDir,
			workDir,
			sessionPath,
			fermentsDir,
			prompt: "Exercise the one-shot ferment process lifecycle and then finish.",
		})
		const sessionEntries = readJsonl(sessionPath)
		const failure = formatFailure(result, sessionEntries, fermentsDir, fake?.requests ?? [])

		expect(hasFermentCompleted(fermentsDir), failure).toBe(true)
		expect(
			sessionEntries.some((entry) => entry.customType === "agent_end"),
			failure,
		).toBe(true)
		expect(
			sessionEntries.some(
				(entry) =>
					entry.type === "message" &&
					entry.message?.role === "assistant" &&
					entry.message.content?.some((part) => part.type === "text" && part.text?.includes(FINAL_TEXT)),
			),
			failure,
		).toBe(true)
		expect(result.timedOut, failure).toBe(false)
		expect(result.code, failure).toBe(0)
	} finally {
		await fake?.stop().catch(() => {})
		rmSync(tempRoot, { recursive: true, force: true })
	}
}

function oneShotCompletionScript(): FakeResponseScript[] {
	return [
		{
			// Scope a one-phase Ferment. The fake server substitutes the runtime ferment id.
			stream: ["Starting the linked-worker one-shot lifecycle."],
			toolCalls: [
				{
					id: "call_scope",
					function: {
						name: "scope_ferment",
						arguments: JSON.stringify({
							ferment_id: "__FERMENT_ID__",
							title: "One Shot Exit",
							goal: "Complete a minimal one-shot ferment and let the process exit.",
							success_criteria: ["The ferment completes and the CLI process exits."],
							phases: [
								{
									name: "Finish",
									goal: "Complete the lifecycle through a linked worker.",
									steps: [
										{
											description: "Exercise a linked worker before completing the one-shot ferment.",
											verify: "true",
										},
									],
								},
							],
							gates: passingGates(["P1", "P2", "P3"]),
						}),
					},
				},
			],
		},
		{
			// Activate the scoped phase so implementation tools and Agent workers unlock.
			toolCalls: [
				{
					id: "call_activate",
					function: {
						name: "activate_ferment_phase",
						arguments: JSON.stringify({
							ferment_id: "__FERMENT_ID__",
							phase_id: "phase-1",
						}),
					},
				},
			],
		},
		{
			// Start the only step; the tool response instructs the model to spawn a linked Agent.
			toolCalls: [
				{
					id: "call_start_step",
					function: {
						name: "start_ferment_step",
						arguments: JSON.stringify({
							ferment_id: "__FERMENT_ID__",
							phase_id: "phase-1",
							step_id: "step-1",
							budget_tier: "narrow",
						}),
					},
				},
			],
		},
		{
			// Spawn the linked worker with task_ref so complete_ferment_step can validate it.
			toolCalls: [
				{
					id: "call_worker_agent",
					function: {
						name: "Agent",
						arguments: JSON.stringify({
							prompt:
								"Complete the lifecycle smoke-test step without editing files. Submit a completed agent report with remaining_steps: [].",
							description: "Lifecycle worker",
							subagent_type: "Builder",
							max_turns: 10,
							max_duration: 180,
							token_budget: 50_000,
							task_ref: {
								kind: "ferment_step",
								ferment_id: "__FERMENT_ID__",
								phase_id: "phase-1",
								step_id: "step-1",
								budget_tier: "narrow",
							},
						}),
					},
				},
			],
		},
		{
			// Simulate the linked worker reporting success through the extension tool.
			stream: ["Submitting the linked worker report."],
			toolCalls: [
				{
					id: "call_worker_report",
					function: {
						name: "submit_agent_report",
						arguments: JSON.stringify({
							status: "completed",
							summary: "The linked worker lifecycle step completed.",
							steps_completed: ["Submitted the linked worker report required for the parent step."],
							remaining_steps: [],
							files_touched: [],
							verification: ["Parent step verification command is the deterministic smoke-test command: true."],
						}),
					},
				},
			],
		},
		{
			// Give the parent turn one plain assistant response after the worker report.
			stream: ["Linked worker report submitted."],
		},
		{
			// Complete the step using the real Agent id returned by the Agent tool result.
			toolCalls: [
				{
					id: "call_complete_step",
					function: {
						name: "complete_ferment_step",
						arguments: JSON.stringify({
							ferment_id: "__FERMENT_ID__",
							phase_id: "phase-1",
							step_id: "step-1",
							worker_agent_id: "__AGENT_ID__",
							summary: "Linked worker completed and reported successfully.",
							gates: passingGates(["S1", "S2", "S3"]),
						}),
					},
				},
			],
		},
		{
			// Close the active phase after the single step has completed.
			toolCalls: [
				{
					id: "call_complete_phase",
					function: {
						name: "complete_ferment_phase",
						arguments: JSON.stringify({
							ferment_id: "__FERMENT_ID__",
							phase_id: "phase-1",
							summary: "Linked worker lifecycle phase completed.",
							gates: passingGates(["F1", "F2", "F3"]),
						}),
					},
				},
			],
		},
		{
			// Complete the Ferment; the following request is the judge response.
			toolCalls: [
				{
					id: "call_complete_ferment",
					function: {
						name: "complete_ferment",
						arguments: JSON.stringify({
							ferment_id: "__FERMENT_ID__",
							final_summary: "Linked-worker one-shot ferment completed.",
							gates: passingGates(["C1", "C2", "C3"]),
						}),
					},
				},
			],
		},
		{
			// Return the one-shot judge JSON that Ferment expects after completion.
			stream: ['{"grade":"A","rationale":"The linked-worker one-shot lifecycle completed cleanly."}'],
		},
		{
			// Final assistant text must be emitted before agent_end and process exit.
			stream: [FINAL_TEXT],
		},
	]
}

function passingGates(ids: string[]): Array<{ id: string; verdict: "pass"; rationale: string; evidence: string }> {
	return ids.map((id) => ({
		id,
		verdict: "pass",
		rationale: "Covered by this focused process lifecycle regression.",
		evidence: "smoke test scripted one-shot flow",
	}))
}

function writeKimchiConfig(homeDir: string, fakeBaseUrl: string): void {
	const configDir = join(homeDir, ".config", "kimchi")
	const agentDir = join(configDir, "harness")
	mkdirSync(agentDir, { recursive: true })

	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify(
			{
				apiKey: "fake",
				llmEndpoint: fakeBaseUrl,
				skillPaths: [],
				migrationState: "done",
				onboarding: { hideSessionModeDialog: true },
			},
			null,
			"\t",
		),
		"utf-8",
	)

	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					[FAKE_PROVIDER]: {
						baseUrl: `${fakeBaseUrl}/openai/v1`,
						apiKey: "fake",
						api: "openai-completions",
						authHeader: true,
						headers: { "User-Agent": "kimchi/smoke-test" },
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
			},
			null,
			"\t",
		),
		"utf-8",
	)
}

async function runOneshot(options: {
	homeDir: string
	workDir: string
	sessionPath: string
	fermentsDir: string
	prompt: string
}): Promise<ProcessResult> {
	const child = spawn(
		BINARY_PATH,
		[
			"--print",
			"--provider",
			FAKE_PROVIDER,
			"--model",
			DEFAULT_MODEL.slug,
			"--session",
			options.sessionPath,
			"--dangerously-skip-permissions",
			"--ferment-oneshot",
		],
		{
			cwd: options.workDir,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: options.homeDir,
				PI_PACKAGE_DIR: PACKAGE_DIR,
				KIMCHI_API_KEY: "fake",
				KIMCHI_FERMENTS_DIR: options.fermentsDir,
				KIMCHI_TELEMETRY_ENABLED: "0",
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	)

	let stdout = ""
	let stderr = ""
	let timedOut = false
	let forceKill: NodeJS.Timeout | undefined

	child.stdout.setEncoding("utf-8")
	child.stderr.setEncoding("utf-8")
	child.stdout.on("data", (chunk) => {
		stdout += chunk
	})
	child.stderr.on("data", (chunk) => {
		stderr += chunk
	})
	child.stdin.on("error", () => {})

	const exit = new Promise<ProcessResult>((resolvePromise, rejectPromise) => {
		const timeout = setTimeout(() => {
			timedOut = true
			child.kill("SIGTERM")
			forceKill = setTimeout(() => child.kill("SIGKILL"), 500)
		}, PROCESS_EXIT_TIMEOUT_MS)

		child.once("error", (error) => {
			clearTimeout(timeout)
			if (forceKill) clearTimeout(forceKill)
			rejectPromise(error)
		})
		child.once("exit", (code, signal) => {
			clearTimeout(timeout)
			if (forceKill) clearTimeout(forceKill)
			resolvePromise({ code, signal, stdout, stderr, timedOut })
		})
	})

	child.stdin.end(options.prompt)
	return exit
}

function readJsonl(path: string): JsonlEntry[] {
	if (!existsSync(path)) return []
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			try {
				return JSON.parse(line) as JsonlEntry
			} catch {
				return { type: "parse_error", raw: line }
			}
		})
}

function hasFermentCompleted(fermentsDir: string): boolean {
	if (!existsSync(fermentsDir)) return false
	return readdirSync(fermentsDir)
		.filter((name) => name.endsWith(".events.jsonl"))
		.some((name) => readJsonl(join(fermentsDir, name)).some((entry) => entry.type === "ferment_completed"))
}

function formatFailure(
	result: ProcessResult,
	sessionEntries: JsonlEntry[],
	fermentsDir: string,
	requests: RecordedRequest[],
): string {
	const tail = sessionEntries.slice(-12).map(describeEntry).join(", ")
	const fermentFiles = existsSync(fermentsDir) ? readdirSync(fermentsDir).join(", ") : "(missing)"
	return [
		`process timedOut=${result.timedOut} code=${result.code} signal=${result.signal}`,
		`session tail: ${tail || "(empty)"}`,
		`ferment event tail: ${readFermentEventTail(fermentsDir)}`,
		`ferment files: ${fermentFiles || "(empty)"}`,
		`fake requests:\n${describeRequests(requests)}`,
		`stdout tail: ${result.stdout.slice(-1000) || "(empty)"}`,
		`stderr tail: ${result.stderr.slice(-1000) || "(empty)"}`,
	].join("\n")
}

function describeEntry(entry: JsonlEntry): string {
	if (entry.customType) return entry.customType
	if (entry.type !== "message") return entry.type ?? "unknown"
	const role = entry.message?.role ?? "unknown"
	const toolName = entry.message?.toolName
	const toolCall = entry.message?.content?.find((part) => part.type === "toolCall")?.name
	const text = entry.message?.content?.find((part) => part.type === "text")?.text
	const suffix = toolName ?? toolCall ?? (text ? JSON.stringify(text.slice(0, 40)) : "")
	return suffix ? `message:${role}:${suffix}` : `message:${role}`
}

function readFermentEventTail(fermentsDir: string): string {
	if (!existsSync(fermentsDir)) return "(missing)"
	const eventFiles = readdirSync(fermentsDir).filter((name) => name.endsWith(".events.jsonl"))
	if (eventFiles.length === 0) return "(empty)"
	return eventFiles
		.flatMap((name) => readJsonl(join(fermentsDir, name)))
		.slice(-12)
		.map((entry) => entry.type ?? "unknown")
		.join(", ")
}

function describeRequests(requests: RecordedRequest[]): string {
	if (requests.length === 0) return "(none)"
	const lines = requests.map((request, index) => {
		const body = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {}
		const messages = Array.isArray(body.messages) ? body.messages : []
		const lastMessage = messages.at(-1)
		const lastText =
			lastMessage && typeof lastMessage === "object" ? summarizeMessage(lastMessage as Record<string, unknown>) : ""
		const tools = Array.isArray(body.tools) ? body.tools.length : 0
		const connection = request.headers.connection
		return [
			`${index + 1}. ${request.method} ${request.url}`,
			`model=${String(body.model ?? "")}`,
			`stream=${String(body.stream ?? "")}`,
			`tools=${tools}`,
			connection ? `connection=${String(connection)}` : "",
			lastText ? `last=${lastText}` : "",
		]
			.filter(Boolean)
			.join(" ")
	})
	if (lines.length <= 24) return lines.join("\n")
	return [...lines.slice(0, 12), `... ${lines.length - 24} request(s) omitted ...`, ...lines.slice(-12)].join("\n")
}

function summarizeMessage(message: Record<string, unknown>): string {
	const role = typeof message.role === "string" ? message.role : "unknown"
	const content = message.content
	let text = ""
	if (typeof content === "string") {
		text = content
	} else if (Array.isArray(content)) {
		text = content
			.map((part) => {
				if (part && typeof part === "object" && "text" in part) {
					const value = (part as Record<string, unknown>).text
					return typeof value === "string" ? value : ""
				}
				return ""
			})
			.join("")
	}
	return `${role}:${JSON.stringify(text.slice(0, 80))}`
}
