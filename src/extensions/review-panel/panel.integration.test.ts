import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai"
import { type AgentSessionEventListener, ModelRuntime } from "@earendil-works/pi-coding-agent"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { raceWithTimeout } from "../../shared/race-with-timeout.js"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import type { RunResult } from "../agents/manager/agent-runner.js"
import { registerAgents } from "../agents/personas/agent-types.js"
import { DEFAULT_CONFIG } from "../permissions/constants.js"
import { registerPermissionPolicySource } from "../permissions/policy-source-registry.js"
import { submitFinding, submitReply } from "../review-submit/store.js"
import { parseReviewTargetArgs } from "../review-targets/parser.js"
import { resolveReviewTarget } from "../review-targets/resolve.js"
import type { ExplicitReviewRequest, ResolvedReviewTarget } from "../review-targets/types.js"
import { reviewPanelPaths } from "./output.js"
import { runReviewPanel, wrapUpReviewPanel } from "./panel.js"
import { ReviewPanelStateStore } from "./state.js"
import type { ReviewPanelDroppedUsage, ReviewPanelProgress, RunReviewPanelOptions } from "./types.js"

// Keep the real child loader/session/tool path; only machine-specific prompt
// decoration and services irrelevant to this offline fixture are stubbed.
vi.mock("../env.js", () => ({ detectEnv: vi.fn().mockResolvedValue({ os: "linux", shell: "bash" }) }))
vi.mock("../agents/prompt/prompts.js", () => ({
	buildAgentPrompt: vi.fn().mockReturnValue("System prompt text"),
	formatTokenBudget: vi.fn().mockImplementation((n: number) => String(n)),
}))
vi.mock("../agents/prompt/skill-loader.js", () => ({
	listAvailableSkillNames: vi.fn().mockReturnValue([]),
	preloadSkills: vi.fn().mockReturnValue([]),
}))
vi.mock("../agents/prompt/brief-skill-loader.js", () => ({
	scanBriefSkills: vi.fn().mockResolvedValue({ available: [], matched: [] }),
	renderBriefSkillBlock: vi.fn().mockReturnValue(""),
}))
vi.mock("../agents/prompt/context.js", () => ({
	buildParentContext: vi.fn().mockReturnValue(undefined),
	extractText: vi.fn().mockImplementation((content: unknown) => (typeof content === "string" ? content : "")),
}))
vi.mock("../memory/memory.js", () => ({
	buildMemoryBlock: vi.fn().mockReturnValue(""),
	buildReadOnlyMemoryBlock: vi.fn().mockReturnValue(""),
}))
vi.mock("../prompt-construction/context-files.js", () => ({ loadProjectContextFiles: vi.fn().mockReturnValue([]) }))
vi.mock("../telemetry/index.js", () => ({ default: vi.fn().mockReturnValue(() => {}) }))
vi.mock("../../config.js", () => ({
	readTelemetryConfig: vi.fn().mockReturnValue({ enabled: false }),
	resolveEndpoints: vi.fn(() => ({ platformApiUrl: "https://policy.test" })),
	loadConfig: vi.fn(() => ({})),
}))
vi.mock("../orchestration/model-registry/guidelines/guidelines-resolver.js", () => ({
	buildRoleGuidelinesSection: vi.fn().mockReturnValue(""),
}))
vi.mock("../auto-model/index.js", () => ({ createAutoModelRoutingExtension: vi.fn(() => () => {}) }))

const model: Model<Api> = {
	id: "panel-scripted",
	name: "Panel Scripted",
	api: "openai-completions",
	provider: "panel-scripted-provider",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
}

interface ScriptTurn {
	text?: string
	toolCalls?: Array<{ name: string; arguments: ToolCall["arguments"] }>
	delayMs?: number
}

interface ScriptCall {
	agent: string
	turn: number
	context: TranscriptContext
}

type PanelScript = (call: ScriptCall) => ScriptTurn | Promise<ScriptTurn>

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	}
}

function baseMessage(): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	}
}

function pushResponse(
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	turn: ScriptTurn,
	aborted: boolean,
): void {
	const partial = baseMessage()
	stream.push({ type: "start", partial })
	if (aborted) {
		const error = { ...partial, stopReason: "aborted", errorMessage: "script cancelled" } as AssistantMessage
		stream.push({ type: "error", reason: "aborted", error })
		return
	}
	const content: AssistantMessage["content"] = []
	let contentIndex = 0
	if (turn.text !== undefined && turn.text.length > 0) {
		stream.push({ type: "text_start", contentIndex, partial })
		const withText = { ...partial, content: [{ type: "text", text: turn.text }] } as AssistantMessage
		stream.push({ type: "text_delta", contentIndex, delta: turn.text, partial: withText })
		stream.push({ type: "text_end", contentIndex, content: turn.text, partial: withText })
		content.push({ type: "text", text: turn.text })
		contentIndex += 1
	}
	for (const call of turn.toolCalls ?? []) {
		const toolCall = {
			type: "toolCall" as const,
			id: `script-call-${contentIndex}-${call.name}`,
			name: call.name,
			arguments: call.arguments,
		}
		stream.push({ type: "toolcall_start", contentIndex, partial })
		const withCall = { ...partial, content: [toolCall] } as AssistantMessage
		stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: withCall })
		content.push(toolCall)
		contentIndex += 1
	}
	const final = {
		...partial,
		content,
		stopReason: (turn.toolCalls?.length ? "toolUse" : "stop") as AssistantMessage["stopReason"],
	}
	stream.push({ type: "done", reason: turn.toolCalls?.length ? "toolUse" : "stop", message: final })
}

function pushProviderError(stream: ReturnType<typeof createAssistantMessageEventStream>, error: unknown): void {
	const partial = baseMessage()
	stream.push({ type: "start", partial })
	stream.push({
		type: "error",
		reason: "error",
		error: {
			...partial,
			stopReason: "error",
			errorMessage: error instanceof Error ? error.message : String(error),
		},
	})
}

function waitForDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) return Promise.resolve()
	return new Promise((resolve) => {
		const timer = setTimeout(done, milliseconds)
		function done() {
			clearTimeout(timer)
			signal?.removeEventListener("abort", done)
			resolve()
		}
		signal?.addEventListener("abort", done, { once: true })
	})
}

function agentName(context: TranscriptContext): string {
	const serialized = JSON.stringify(context.messages)
	if (serialized.includes("semantic review reconciler")) return "reconciliation"
	const match = /REVIEW_LENS (spec|standards|operational|adversarial|security)/.exec(serialized)
	if (!match) throw new Error(`Scripted provider could not identify the child prompt: ${serialized.slice(0, 500)}`)
	return match[1]
}

function retainedReconciliation(requestPath: string): ScriptTurn {
	const request = JSON.parse(readFileSync(requestPath, "utf8")) as {
		candidates: Array<{
			id: string
			finding: {
				path: string
				line: number
				severity: string
				type: string
				description: string
				suggestion: string
			}
		}>
	}
	return {
		text: JSON.stringify({
			schema_version: "review-reconciliation/v1",
			findings: request.candidates.map((candidate) => ({
				id: `finding-${candidate.id}`,
				path: candidate.finding.path,
				line: candidate.finding.line,
				severity: candidate.finding.severity,
				type: candidate.finding.type,
				description: candidate.finding.description,
				suggestion: candidate.finding.suggestion,
				candidate_ids: [candidate.id],
			})),
			decisions: request.candidates.map((candidate) => ({
				candidate_id: candidate.id,
				disposition: "retained",
				finding: `finding-${candidate.id}`,
				reason: "Independent candidate in the scripted fixture.",
			})),
			threads: [],
		}),
	}
}

function defaultScript(call: ScriptCall): ScriptTurn {
	if (call.agent === "reconciliation") {
		const match = /Inspect (\S+), the pinned code/.exec(JSON.stringify(call.context.messages))
		if (!match) throw new Error("Missing reconciliation request path in verifier prompt")
		return retainedReconciliation(match[1])
	}
	if (call.turn === 1) {
		return {
			toolCalls: [
				{
					name: "submit_finding",
					arguments: {
						path: "value.ts",
						line: 2,
						severity: "warning",
						type: "bug",
						description: `${call.agent}: revision head; command not needed; code inspection observed a concrete regression.`,
						suggestion: "Add the missing guard and cover the changed path.",
					},
				},
			],
		}
	}
	if (call.turn === 2) {
		return {
			toolCalls: [
				{
					name: "submit_summary",
					arguments: { body: `${call.agent} completed code inspection.`, environment_gaps: [] },
				},
			],
			delayMs: 20,
		}
	}
	return { text: `${call.agent} complete` }
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

function completedRunResult(stopReason: AssistantMessage["stopReason"] = "stop"): RunResult {
	return {
		responseText: "completed",
		session: { messages: [{ role: "assistant", stopReason }] } as unknown as RunResult["session"],
		aborted: false,
		steered: false,
	}
}

function validVerifierResponse(candidateId = "spec-1"): string {
	return JSON.stringify({
		schema_version: "review-reconciliation/v1",
		findings: [
			{
				id: "late-semantic-finding",
				path: "value.ts",
				line: 2,
				severity: "warning",
				type: "bug",
				description: "A valid semantic result that must not arrive after closure.",
				suggestion: "Never publish this late change.",
				candidate_ids: [candidateId],
			},
		],
		decisions: [
			{
				candidate_id: candidateId,
				disposition: "retained",
				finding: "late-semantic-finding",
				reason: "Valid independent candidate.",
			},
		],
		threads: [],
	})
}

function createUsageSession() {
	const listeners = new Set<AgentSessionEventListener>()
	const session = {
		messages: [{ role: "assistant", stopReason: "stop" }],
		subscribe(listener: AgentSessionEventListener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
	} as unknown as RunResult["session"]
	return {
		session,
		get listenerCount() {
			return listeners.size
		},
		emit(input: number, output: number) {
			const message: AssistantMessage = {
				...baseMessage(),
				usage: { ...zeroUsage(), input, output, totalTokens: input + output },
			}
			for (const listener of [...listeners]) listener({ type: "message_end", message })
		},
	}
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
		stdio: ["ignore", "pipe", "pipe"],
	}).trim()
}

describe("review panel with the real runner and scripted model", { timeout: 60_000 }, () => {
	let sandbox: string
	let repo: string
	let outputDir: string
	let contextDir: string
	let savedAgentDir: string | undefined
	let unregisterPolicy: (() => void) | undefined

	beforeAll(() => {
		savedAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
		registerAgents(new Map())
	})

	afterAll(() => {
		if (savedAgentDir === undefined) delete process.env.KIMCHI_CODING_AGENT_DIR
		else process.env.KIMCHI_CODING_AGENT_DIR = savedAgentDir
	})

	beforeEach(() => {
		sandbox = mkdtempSync(join(tmpdir(), "review-panel-integration-"))
		process.env.KIMCHI_CODING_AGENT_DIR = join(sandbox, "agent-home")
		repo = join(sandbox, "repo")
		outputDir = join(sandbox, "review-output")
		contextDir = join(sandbox, "review-context")
		execFileSync("mkdir", ["-p", repo])
		git(repo, "init", "--initial-branch=main")
		git(repo, "config", "user.name", "Panel Test")
		git(repo, "config", "user.email", "panel@localhost")
		writeFileSync(join(repo, "value.ts"), "export const value = 1\n")
		git(repo, "add", "value.ts")
		git(repo, "commit", "-m", "base")
		writeFileSync(join(repo, "value.ts"), "export const value = 1\nexport const risky = true\n")
		git(repo, "add", "value.ts")
		git(repo, "commit", "-m", "head")
	})

	afterEach(() => {
		vi.restoreAllMocks()
		unregisterPolicy?.()
		unregisterPolicy = undefined
		rmSync(sandbox, { recursive: true, force: true })
	})

	async function target(): Promise<ResolvedReviewTarget> {
		const base = git(repo, "rev-parse", "HEAD^")
		return resolveReviewTarget(parseReviewTargetArgs(["branch", "main", "--base", base]) as ExplicitReviewRequest, {
			root: repo,
			contextDir,
		})
	}

	async function scriptedContext(script: PanelScript, mode: "tui" | "plan" = "tui") {
		const rounds = new Map<string, number>()
		const requests: ScriptCall[] = []
		const streamSimple = (_model: Model<Api>, context: TranscriptContext, options?: { signal?: AbortSignal }) => {
			const agent = agentName(context)
			const turn = (rounds.get(agent) ?? 0) + 1
			rounds.set(agent, turn)
			const call = { agent, turn, context }
			requests.push(call)
			const stream = createAssistantMessageEventStream()
			void (async () => {
				const scripted = await script(call)
				await waitForDelay(scripted.delayMs ?? 0, options?.signal)
				pushResponse(stream, scripted, options?.signal?.aborted === true)
			})().catch((error: unknown) => pushProviderError(stream, error))
			return stream
		}
		const modelRuntime = await ModelRuntime.create({
			authPath: join(sandbox, "auth.json"),
			modelsPath: null,
		})
		modelRuntime.registerProvider(model.provider, {
			name: "Panel scripted provider",
			baseUrl: model.baseUrl,
			apiKey: "offline",
			api: "openai-completions",
			streamSimple,
		})
		const ctx = createContext({
			cwd: repo,
			model,
			mode: "tui",
			hasUI: false,
			modelRegistry: {
				find: vi.fn().mockReturnValue(undefined),
				getAvailable: vi.fn().mockReturnValue([model]),
				runtime: modelRuntime,
			} as unknown as RunReviewPanelOptions["ctx"]["modelRegistry"],
			sessionManager: {
				getSessionId: vi.fn().mockReturnValue("panel-parent"),
				getSessionDir: vi.fn().mockReturnValue(undefined),
				getSessionFile: vi.fn().mockReturnValue(undefined),
			},
		})
		unregisterPolicy = registerPermissionPolicySource("panel-parent", {
			getMode: () => ({ mode: mode === "plan" ? "plan" : "yolo", initiatedBy: "user", source: "runtime" }),
			getRules: () => [],
			getConfig: () => ({
				config: DEFAULT_CONFIG,
				allowBySource: { user: [], project: [], local: [], cli: [] },
				denyBySource: { user: [], project: [], local: [], cli: [] },
				paths: {},
			}),
			isDangerBypass: () => false,
			whenModeSettled: async () => {},
		})
		return { ctx, requests }
	}

	function runOptions(
		ctx: RunReviewPanelOptions["ctx"],
		resolvedTarget: ResolvedReviewTarget,
		extra: Partial<RunReviewPanelOptions> = {},
	): RunReviewPanelOptions {
		return {
			ctx,
			pi: createExtensionApi().api,
			target: resolvedTarget,
			outputDir,
			rootDir: join(sandbox, "worktrees"),
			checkDefinitions: [],
			executionPolicy: { mode: "headless" },
			agent: { maxTurns: 5, maxDuration: 30, inactivityTimeout: 5000 },
			...extra,
		}
	}

	it("limits active reviewers to the explicit slot count and publishes candidate checkpoints", async () => {
		const { ctx, requests } = await scriptedContext(defaultScript)
		const progress: ReviewPanelProgress[] = []
		const usageWriters = new Set<string>()
		const result = await runReviewPanel(
			runOptions(ctx, await target(), {
				concurrency: 2,
				onProgress: (update) => progress.push(update),
				onChildUsage: (usage) => {
					usageWriters.add(usage.writer)
				},
			}),
		)
		expect(progress.some((update) => update.phase === "reviewing" && update.counts.candidates > 0)).toBe(true)
		const maximumRunning = Math.max(...progress.map((update) => update.counts.running))
		expect(maximumRunning).toBe(2)
		expect(result.state.lenses.map((lens) => lens.status)).toEqual(["submitted", "submitted", "submitted", "submitted"])
		expect(result.state.candidates.map((candidate) => candidate.id)).toEqual([
			"spec-1",
			"standards-1",
			"operational-1",
			"adversarial-1",
		])
		expect(result.findings).toHaveLength(4)
		expect(result.state.reconciliation.status).toBe("reconciled")
		expect(result.summary.coverage).toMatchObject({ status: "complete", selected_lenses: 4, final_finding_count: 4 })
		expect(
			new Set(requests.filter((request) => request.agent !== "reconciliation").map((request) => request.agent)),
		).toEqual(new Set(["spec", "standards", "operational", "adversarial"]))
		expect(usageWriters).toEqual(new Set(["spec", "standards", "operational", "adversarial", "reconciliation"]))
	})

	it("stops queued launches at reserve, cancels active reviewers after grace, and stabilizes two wrap-ups", async () => {
		const controller = new AbortController()
		const script: PanelScript = (call) => {
			if (call.agent === "spec") return { delayMs: 60_000, text: "unreachable" }
			if (call.agent === "standards") {
				if (call.turn === 1) {
					return {
						toolCalls: [
							{
								name: "submit_finding",
								arguments: {
									path: "value.ts",
									line: 2,
									severity: "critical",
									type: "bug",
									description: "Revision head; code inspection observed the submitted reserve finding.",
									suggestion: "Retain this available finding during wrap-up.",
								},
							},
						],
					}
				}
				return { delayMs: 60_000, text: "unreachable" }
			}
			return defaultScript(call)
		}
		const { ctx, requests } = await scriptedContext(script)
		let aborted = false
		const result = await runReviewPanel(
			runOptions(ctx, await target(), {
				deadline: Date.now() + 10_000,
				reconciliationReserveMs: 5000,
				submitGraceMs: 25,
				finalWriteHeadroomMs: 0,
				signal: controller.signal,
				onProgress: (update) => {
					if (!aborted && update.counts.candidates > 0 && update.counts.running > 0) {
						aborted = true
						controller.abort()
					}
				},
			}),
		)
		expect(result.state.candidates.map((candidate) => candidate.id)).toEqual(["standards-1"])
		expect(result.findings).toHaveLength(1)
		expect(result.state.coverage.status).toBe("partial")
		expect(result.state.coverage.unfinished_lenses).toEqual(["spec", "standards", "operational", "adversarial"])
		expect(result.state.lenses.filter((lens) => lens.status === "cancelled")).toHaveLength(4)
		expect(
			new Set(requests.filter((request) => request.agent !== "reconciliation").map((request) => request.agent)),
		).toEqual(new Set(["spec", "standards"]))

		const requestCountBeforeWrap = requests.length
		const firstWrap = await wrapUpReviewPanel({
			ctx,
			pi: createExtensionApi().api,
			outputDir,
			expected: {
				baseSha: result.state.scope.pinned.baseSha,
				headSha: result.state.scope.pinned.headSha,
				checkoutPath: result.state.scope.checkoutPath,
				contextDir: result.state.contextDir,
				outputDir: result.state.outputDir,
			},
			rootDir: join(sandbox, "wrap-worktrees-1"),
			checkDefinitions: [],
			executionPolicy: { mode: "headless" },
		})
		const firstBytes = readFileSync(reviewPanelPaths(outputDir).findingsPath, "utf8")
		const firstSummaryBytes = readFileSync(reviewPanelPaths(outputDir).summaryPath, "utf8")
		const secondWrap = await wrapUpReviewPanel({
			ctx,
			pi: createExtensionApi().api,
			outputDir,
			rootDir: join(sandbox, "wrap-worktrees-2"),
			checkDefinitions: [],
			executionPolicy: { mode: "headless" },
		})
		expect(secondWrap.findings.map((finding) => finding.id)).toEqual(firstWrap.findings.map((finding) => finding.id))
		expect(secondWrap.summary.coverage).toEqual(firstWrap.summary.coverage)
		expect(readFileSync(reviewPanelPaths(outputDir).findingsPath, "utf8")).toBe(firstBytes)
		expect(readFileSync(reviewPanelPaths(outputDir).summaryPath, "utf8")).toBe(firstSummaryBytes)
		expect(requests).toHaveLength(requestCountBeforeWrap)
	})

	it("marks terminal provider errors as failed lenses with partial coverage", async () => {
		const { ctx } = await scriptedContext(() => {
			throw new Error("terminal scripted provider failure")
		})
		const result = await runReviewPanel(runOptions(ctx, await target(), { lenses: ["spec"] }))
		expect(result.state.lenses[0]).toMatchObject({ status: "failed", error: expect.stringContaining("provider") })
		expect(result.state.coverage).toMatchObject({ status: "partial", failed_lenses: 1, unfinished_lenses: ["spec"] })
		expect(result.summary.body).toContain("Coverage: partial")
	})

	it("marks a non-error reviewer with no accepted submission as failed", async () => {
		const { ctx } = await scriptedContext(() => ({ text: "Inspection complete without tool submissions." }))
		const result = await runReviewPanel(runOptions(ctx, await target(), { lenses: ["spec"] }))
		expect(result.state.lenses[0]).toMatchObject({ status: "failed", error: expect.stringContaining("no_submission") })
		expect(result.state.coverage).toMatchObject({ status: "partial", failed_lenses: 1, unfinished_lenses: ["spec"] })
	})

	it.each([
		{ name: "already past", offsetMs: -1000, headroomMs: 100 },
		{ name: "inside final-write headroom", offsetMs: 250, headroomMs: 500 },
	])("finalizes without launching when the deadline is $name", async ({ offsetMs, headroomMs }) => {
		const { ctx } = await scriptedContext(defaultScript)
		let launches = 0
		const resolvedTarget = await target()
		const deadline = Date.now() + offsetMs
		const resultPromise = runReviewPanel(
			runOptions(ctx, resolvedTarget, {
				deadline,
				finalWriteHeadroomMs: headroomMs,
				spawnAgent: async () => {
					launches += 1
					return completedRunResult()
				},
			}),
		)
		const result = await resultPromise
		expect(launches).toBe(0)
		expect(result.summary).toBeDefined()
		expect(result.state.lenses.every((lens) => lens.status === "cancelled")).toBe(true)
		expect(result.state.coverage.status).toBe("partial")
		if (offsetMs > 0) expect(Date.now()).toBeLessThan(deadline)
	})

	it("finishes before a sub-two-minute deadline when reviewers ignore cancellation", async () => {
		const { ctx } = await scriptedContext(defaultScript)
		const pending = deferred<RunResult>()
		const resolvedTarget = await target()
		const deadline = Date.now() + 800
		const startedAt = Date.now()
		const result = await runReviewPanel(
			runOptions(ctx, resolvedTarget, {
				lenses: ["spec"],
				deadline,
				finalWriteHeadroomMs: 200,
				submitGraceMs: 200,
				cancellationGraceMs: 200,
				spawnAgent: () => pending.promise,
			}),
		)
		const finishedAt = Date.now()
		expect(finishedAt).toBeLessThan(deadline)
		expect(finishedAt - startedAt).toBeLessThan(800)
		expect(result.state.lenses[0]).toMatchObject({ status: "cancelled" })
		expect(result.summary.body).toContain("Coverage: partial")
		expect(existsSync(reviewPanelPaths(outputDir).summaryPath)).toBe(true)
		pending.resolve(completedRunResult())
		await waitForDelay(50, undefined)
	})

	it("closes publication before a late reviewer submits after return and deadline, then recovers on wrap-up", async () => {
		const { ctx } = await scriptedContext(defaultScript)
		const resolvedTarget = await target()
		writeFileSync(
			join(contextDir, "comments.json"),
			JSON.stringify({
				schema_version: "review-comments/v1",
				threads: [{ thread_id: "existing-reply", is_ours: false, mentions_bot: true }],
			}),
		)
		expect(
			(
				await submitReply(
					{ thread_id: "existing-reply", body: "Existing reply artifact.", action: "none" },
					{ writer: "final", contextDir, outputDir },
				)
			).accepted,
		).toBe(true)
		// Preserve the reply artifact without requiring an unnecessary initial
		// verifier in the short reserve window.
		rmSync(join(contextDir, "comments.json"))
		const pending = deferred<RunResult>()
		const deadline = Date.now() + 1000
		let progressEvents = 0
		const result = await runReviewPanel(
			runOptions(ctx, resolvedTarget, {
				lenses: ["spec"],
				deadline,
				finalWriteHeadroomMs: 200,
				submitGraceMs: 250,
				cancellationGraceMs: 250,
				onProgress: () => {
					progressEvents += 1
				},
				spawnAgent: () => pending.promise,
			}),
		)
		expect(result.state.candidates).toEqual([])
		expect(Date.now()).toBeLessThan(deadline)
		const paths = reviewPanelPaths(outputDir)
		const artifacts = [paths.findingsPath, paths.summaryPath, paths.repliesPath, paths.statePath].map((path) => ({
			path,
			contents: readFileSync(path, "utf8"),
			mtimeMs: statSync(path).mtimeMs,
		}))
		const finishedProgressEvents = progressEvents

		await waitForDelay(Math.max(0, deadline - Date.now() + 25), undefined)
		expect(Date.now()).toBeGreaterThan(deadline)
		const late = await submitFinding(
			{
				path: "value.ts",
				line: 2,
				severity: "critical",
				type: "bug",
				description: "Late reviewer submission after coordinator closure.",
				suggestion: "Recover this through the next wrap-up.",
			},
			{ writer: "spec", contextDir, outputDir },
		)
		expect(late.accepted).toBe(true)
		pending.resolve(completedRunResult())
		await waitForDelay(100, undefined)

		for (const artifact of artifacts) {
			expect(readFileSync(artifact.path, "utf8"), artifact.path).toBe(artifact.contents)
			expect(statSync(artifact.path).mtimeMs, artifact.path).toBe(artifact.mtimeMs)
		}
		expect(progressEvents).toBe(finishedProgressEvents)
		expect(readFileSync(join(outputDir, "findings", "spec.jsonl"), "utf8")).toContain(
			"Late reviewer submission after coordinator closure.",
		)

		const recovered = await wrapUpReviewPanel({
			ctx,
			pi: createExtensionApi().api,
			outputDir,
			rootDir: join(sandbox, "late-review-wrap-worktrees"),
			checkDefinitions: [],
			executionPolicy: { mode: "headless" },
			deadline: Date.now() + 5000,
		})
		expect(recovered.state.candidates.map((candidate) => candidate.id)).toEqual(["spec-1"])
		expect(recovered.findings).toHaveLength(1)
		expect(recovered.findings[0]).toMatchObject({
			id: "final-1",
			severity: "critical",
			description: "Late reviewer submission after coordinator closure.",
		})
		expect(recovered.summary.coverage?.candidate_count).toBe(1)
	})

	it("publishes fallback before D when a verifier observes abort but ignores it", async () => {
		const { ctx } = await scriptedContext(defaultScript)
		const resolvedTarget = await target()
		const pendingVerifier = deferred<RunResult>()
		const verifierUsage = createUsageSession()
		const usageEvents: unknown[] = []
		let abortObserved = false
		let submitted = false
		const deadline = Date.now() + 900
		const result = await runReviewPanel(
			runOptions(ctx, resolvedTarget, {
				lenses: ["spec"],
				deadline,
				finalWriteHeadroomMs: 200,
				reconciliationReserveMs: 0,
				onChildUsage: (usage) => {
					usageEvents.push(usage)
				},
				spawnAgent: async ({ prompt, options }) => {
					if (prompt.startsWith("REVIEW_LENS")) {
						if (!submitted) {
							submitted = true
							expect(
								(
									await submitFinding(
										{
											path: "value.ts",
											line: 2,
											severity: "critical",
											type: "bug",
											description: "Original fallback finding.",
											suggestion: "Keep the deterministic fallback.",
										},
										{ writer: "spec", contextDir, outputDir },
									)
								).accepted,
							).toBe(true)
						}
						return completedRunResult()
					}
					options.onSessionCreated?.(verifierUsage.session)
					abortObserved ||= options.signal?.aborted === true
					options.signal?.addEventListener("abort", () => {
						abortObserved = true
					})
					return pendingVerifier.promise
				},
			}),
		)
		expect(result.state.reconciliation.reason).toContain("did not settle within the reconciliation window")
		expect(abortObserved).toBe(true)
		expect(Date.now()).toBeLessThan(deadline)
		expect(result.state.reconciliation.status).toBe("fallback")
		expect(result.findings[0]).toMatchObject({ severity: "critical", description: "Original fallback finding." })
		const paths = reviewPanelPaths(outputDir)
		const artifacts = [paths.findingsPath, paths.summaryPath, paths.statePath].map((path) => readFileSync(path, "utf8"))
		const usageCount = usageEvents.length
		expect(verifierUsage.listenerCount).toBe(0)

		await waitForDelay(Math.max(0, deadline - Date.now() + 25), undefined)
		pendingVerifier.resolve({ ...completedRunResult(), responseText: validVerifierResponse() })
		verifierUsage.emit(100, 200)
		await waitForDelay(100, undefined)
		expect([paths.findingsPath, paths.summaryPath, paths.statePath].map((path) => readFileSync(path, "utf8"))).toEqual(
			artifacts,
		)
		expect(usageEvents).toHaveLength(usageCount)
	})

	it("rescans late writers at the publication boundary during wrap-up", async () => {
		const { ctx } = await scriptedContext(defaultScript)
		const resolvedTarget = await target()
		const abandoned = deferred<RunResult>()
		await runReviewPanel(
			runOptions(ctx, resolvedTarget, {
				lenses: ["spec"],
				deadline: Date.now() + 700,
				finalWriteHeadroomMs: 150,
				reconciliationReserveMs: 0,
				submitGraceMs: 150,
				cancellationGraceMs: 150,
				spawnAgent: () => abandoned.promise,
			}),
		)
		writeFileSync(
			join(contextDir, "comments.json"),
			JSON.stringify({
				schema_version: "review-comments/v1",
				previous_revision: git(repo, "rev-parse", "HEAD^"),
				threads: [],
			}),
		)
		const verifierStarted = deferred<void>()
		const firstVerifier = deferred<RunResult>()
		let verifierCalls = 0
		const wrapped = wrapUpReviewPanel({
			ctx,
			pi: createExtensionApi().api,
			outputDir,
			rootDir: join(sandbox, "overlap-wrap-worktrees"),
			checkDefinitions: [],
			executionPolicy: { mode: "headless" },
			deadline: Date.now() + 10_000,
			cancellationGraceMs: 25,
			spawnAgent: async () => {
				verifierCalls += 1
				if (verifierCalls === 1) {
					verifierStarted.resolve()
					return firstVerifier.promise
				}
				return { ...completedRunResult(), responseText: validVerifierResponse() }
			},
		})
		await verifierStarted.promise
		expect(
			(
				await submitFinding(
					{
						path: "value.ts",
						line: 2,
						severity: "critical",
						type: "bug",
						description: "Accepted after wrap-up's initial scan but before publication.",
						suggestion: "Include this in the same wrap-up.",
					},
					{ writer: "spec", contextDir, outputDir },
				)
			).accepted,
		).toBe(true)
		firstVerifier.resolve({ ...completedRunResult(), responseText: validVerifierResponse() })
		const result = await wrapped
		expect(result.state.candidates.map((candidate) => candidate.id)).toEqual(["spec-1"])
		expect(result.findings).toHaveLength(1)
		expect(result.findings[0].derived_from).toEqual(["spec-1"])
		expect(verifierCalls).toBeGreaterThanOrEqual(2)
		abandoned.resolve(completedRunResult())
	})

	it("drains cleanup usage once, detaches subscriptions, and does not replay it on wrap-up", async () => {
		const { ctx } = await scriptedContext(defaultScript)
		const resolvedTarget = await target()
		const pending = deferred<RunResult>()
		const childUsage = createUsageSession()
		const usageEvents: Array<{ writer: string; usage: { input: number; output: number } }> = []
		await runReviewPanel(
			runOptions(ctx, resolvedTarget, {
				lenses: ["spec"],
				deadline: Date.now() + 800,
				finalWriteHeadroomMs: 200,
				reconciliationReserveMs: 0,
				submitGraceMs: 250,
				cancellationGraceMs: 250,
				onChildUsage: (usage) => {
					usageEvents.push(usage)
				},
				onProgress: (update) => {
					if (update.phase === "complete") {
						expect(childUsage.listenerCount).toBe(1)
						childUsage.emit(40, 60)
					}
				},
				spawnAgent: async ({ options }) => {
					options.onSessionCreated?.(childUsage.session)
					return pending.promise
				},
			}),
		)
		expect(childUsage.listenerCount).toBe(0)
		expect(usageEvents).toEqual([
			expect.objectContaining({
				writer: "spec",
				provider: model.provider,
				model: model.id,
				usage: { input: 40, output: 60, cacheRead: 0, cacheWrite: 0 },
			}),
		])
		childUsage.emit(1, 2)
		expect(usageEvents).toHaveLength(1)

		await wrapUpReviewPanel({
			ctx,
			pi: createExtensionApi().api,
			outputDir,
			rootDir: join(sandbox, "usage-wrap-worktrees"),
			checkDefinitions: [],
			executionPolicy: { mode: "headless" },
			onChildUsage: (usage) => {
				usageEvents.push(usage)
			},
			cancellationGraceMs: 25,
		})
		expect(usageEvents).toHaveLength(1)
		expect(usageEvents[0].usage).toMatchObject({ input: 40, output: 60 })
		pending.resolve(completedRunResult())
	})

	it("exits naturally after a fast reconciliation when no timeout remains armed", async () => {
		const harnessRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
		const fixture = join(harnessRoot, "src/extensions/review-panel/natural-exit-process.ts")
		const tsx = join(harnessRoot, "node_modules/tsx/dist/cli.mjs")
		const child = spawn(process.execPath, [tsx, fixture], {
			env: { ...process.env, KIMCHI_CODING_AGENT_DIR: join(sandbox, "child-agent-home") },
			stdio: ["ignore", "pipe", "pipe"],
		})
		let stdout = ""
		let stderr = ""
		let completedAt: number | undefined
		child.stdout.on("data", (data) => {
			stdout += data.toString()
			if (completedAt === undefined && stdout.includes('"outcome":"completion"')) completedAt = Date.now()
		})
		child.stderr.on("data", (data) => {
			stderr += data.toString()
		})
		const settled = new Promise<{ kind: "exit"; code: number | null }>((resolve, reject) => {
			child.once("error", reject)
			child.once("close", (code) => resolve({ kind: "exit", code }))
		})
		const outcome = await raceWithTimeout(settled, 5000, { kind: "timeout" as const }, () => {
			child.kill("SIGKILL")
		})
		expect(outcome, `${stdout}\n${stderr}`).toEqual({ kind: "exit", code: 0 })
		expect(stdout).toContain('"outcome":"completion"')
		expect(completedAt).toBeDefined()
		expect(Date.now() - (completedAt ?? 0)).toBeLessThan(2000)
	})

	it("aborts a blocked usage callback through its signal and exits naturally", async () => {
		const harnessRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
		const fixture = join(harnessRoot, "src/extensions/review-panel/natural-exit-process.ts")
		const tsx = join(harnessRoot, "node_modules/tsx/dist/cli.mjs")
		const child = spawn(process.execPath, [tsx, fixture], {
			env: {
				...process.env,
				KIMCHI_CODING_AGENT_DIR: join(sandbox, "child-agent-home"),
				REVIEW_USAGE_ABORT: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		})
		let stdout = ""
		let stderr = ""
		let completedAt: number | undefined
		child.stdout.on("data", (data) => {
			stdout += data.toString()
			if (completedAt === undefined && stdout.includes('"outcome":"completion"')) completedAt = Date.now()
		})
		child.stderr.on("data", (data) => {
			stderr += data.toString()
		})
		const settled = new Promise<{ kind: "exit"; code: number | null }>((resolve, reject) => {
			child.once("error", reject)
			child.once("close", (code) => resolve({ kind: "exit", code }))
		})
		const outcome = await raceWithTimeout(settled, 5000, { kind: "timeout" as const }, () => {
			child.kill("SIGKILL")
		})
		expect(outcome, `${stdout}\n${stderr}`).toEqual({ kind: "exit", code: 0 })
		expect(stdout).toContain('"outcome":"completion"')
		expect(stdout).toContain('"usageAborted":true')
		expect(completedAt).toBeDefined()
		expect(Date.now() - (completedAt ?? 0)).toBeLessThan(2000)
	})

	it("drops and diagnoses usage that cannot be delivered before the cleanup deadline", async () => {
		const { ctx } = await scriptedContext(defaultScript)
		const resolvedTarget = await target()
		const pending = deferred<RunResult>()
		const childUsage = createUsageSession()
		const dropped: ReviewPanelDroppedUsage[] = []
		let attempted = 0
		const deadline = Date.now() + 800
		await runReviewPanel(
			runOptions(ctx, resolvedTarget, {
				lenses: ["spec"],
				deadline,
				finalWriteHeadroomMs: 200,
				// Enter reserve inside D so callback latency is isolated from expiry.
				reconciliationReserveMs: 300,
				submitGraceMs: 250,
				cancellationGraceMs: 250,
				onUsageDropped: (usage) => {
					dropped.push(usage)
				},
				onChildUsage: async () => {
					attempted += 1
					await waitForDelay(100, undefined)
				},
				onProgress: (update) => {
					if (update.phase === "complete") {
						childUsage.emit(40, 60)
					}
				},
				spawnAgent: async ({ options }) => {
					options.onSessionCreated?.(childUsage.session)
					return pending.promise
				},
			}),
		)
		expect(Date.now()).toBeLessThan(deadline)
		expect(attempted).toBe(1)
		expect(dropped).toHaveLength(1)
		expect(dropped[0]).toMatchObject({
			writer: "spec",
			reason: "deadline",
			usage: { input: 40, output: 60, cacheRead: 0, cacheWrite: 0 },
		})
		expect(childUsage.listenerCount).toBe(0)
		pending.resolve(completedRunResult())
	})

	it("rechecks reserve after a paused running-state write and never launches", async () => {
		const { ctx } = await scriptedContext(defaultScript)
		const writeStarted = deferred<void>()
		const continueWrite = deferred<void>()
		const controller = new AbortController()
		let launches = 0
		let paused = false
		const original = ReviewPanelStateStore.prototype.update
		const spy = vi.spyOn(ReviewPanelStateStore.prototype, "update").mockImplementation(function (
			this: ReviewPanelStateStore,
			mutator,
		) {
			if (!paused && this.state.lenses[0]?.status === "queued") {
				paused = true
				writeStarted.resolve()
				return continueWrite.promise.then(() => original.call(this, mutator))
			}
			return original.call(this, mutator)
		})
		try {
			const resolvedTarget = await target()
			const run = runReviewPanel(
				runOptions(ctx, resolvedTarget, {
					lenses: ["spec"],
					signal: controller.signal,
					deadline: Date.now() + 1000,
					finalWriteHeadroomMs: 100,
					spawnAgent: async () => {
						launches += 1
						return completedRunResult()
					},
				}),
			)
			await writeStarted.promise
			controller.abort()
			continueWrite.resolve()
			const result = await run
			expect(launches).toBe(0)
			expect(result.state.lenses[0]).toMatchObject({ status: "cancelled" })
		} finally {
			continueWrite.resolve()
			spy.mockRestore()
		}
	})

	it("derives fixed and equivalent re-review decisions from real thread history", async () => {
		const previousRevision = git(repo, "rev-parse", "HEAD^")
		const resolvedTarget = await target()
		writeFileSync(
			join(contextDir, "comments.json"),
			JSON.stringify({
				schema_version: "review-comments/v1",
				previous_revision: previousRevision,
				threads: [
					{ thread_id: "fixed-thread", is_ours: true, mentions_bot: false },
					{ thread_id: "equivalent-thread", is_ours: true, mentions_bot: false },
				],
			}),
		)
		const script: PanelScript = (call) => {
			if (call.agent !== "reconciliation") return defaultScript(call)
			const prompt = JSON.stringify(call.context.messages)
			expect(prompt).toContain("Review the supplied thread history")
			const match = /Inspect (\S+), the pinned code/.exec(prompt)
			if (!match) throw new Error("Missing verifier request path")
			const request = JSON.parse(readFileSync(match[1], "utf8")) as {
				scope: { pinned: { baseSha: string } }
				candidates: Array<{ id: string }>
				comments: { previous_revision: string; threads: Array<{ thread_id: string }> }
			}
			expect(request.comments.previous_revision).toBe(previousRevision)
			expect(request.scope.pinned.baseSha).toBe(previousRevision)
			expect(request.comments.threads.map((thread) => thread.thread_id)).toEqual(["fixed-thread", "equivalent-thread"])
			expect(request.candidates.map((candidate) => candidate.id)).toEqual(["spec-1"])
			const fixedRecognized = request.comments.previous_revision === request.scope.pinned.baseSha
			const equivalentRecognized = request.comments.threads.some((thread) => thread.thread_id === "equivalent-thread")
			return {
				text: JSON.stringify({
					schema_version: "review-reconciliation/v1",
					findings: [],
					decisions: request.candidates.map((candidate) => ({
						candidate_id: candidate.id,
						disposition: "rejected",
						reason: equivalentRecognized
							? "The equivalent-thread in the supplied history covers this candidate."
							: "No historical equivalent was recognized.",
					})),
					threads: [
						{
							thread_id: "fixed-thread",
							body: fixedRecognized ? "Fixed at the pinned head from previous revision evidence." : "Unverified.",
							action: fixedRecognized ? "resolve" : "none",
							verdict: fixedRecognized ? "fixed" : "unverified",
							evidence_kind: "code_reference",
							evidence: `Compared ${request.comments.previous_revision} with the pinned head.`,
						},
						{
							thread_id: "equivalent-thread",
							body: "The supplied history covers this candidate; do not post it twice.",
							action: "none",
							verdict: "not_fixed",
							evidence_kind: "code_reference",
							evidence: "The finding remains equivalent to the earlier thread.",
							equivalent_candidate_ids: request.candidates.map((candidate) => candidate.id),
						},
					],
				}),
			}
		}
		const { ctx, requests } = await scriptedContext(script)
		const result = await runReviewPanel(runOptions(ctx, resolvedTarget, { lenses: ["spec"] }))
		expect(result.findings).toEqual([])
		expect(result.state.reconciliation.status).toBe("reconciled")
		const paths = reviewPanelPaths(outputDir)
		const replies = readFileSync(paths.repliesPath, "utf8")
		expect(replies).toContain("Fixed at the pinned head from previous revision evidence")
		expect(replies).toContain("do not post it twice")
		const artifacts = [paths.findingsPath, paths.summaryPath, paths.repliesPath].map((path) =>
			readFileSync(path, "utf8"),
		)
		const providerCalls = requests.length
		await wrapUpReviewPanel({
			ctx,
			pi: createExtensionApi().api,
			outputDir,
			rootDir: join(sandbox, "history-wrap-worktrees"),
			checkDefinitions: [],
			executionPolicy: { mode: "headless" },
			deadline: Date.now() + 5000,
		})
		expect(
			[paths.findingsPath, paths.summaryPath, paths.repliesPath].map((path) => readFileSync(path, "utf8")),
		).toEqual(artifacts)
		expect(requests).toHaveLength(providerCalls)
	})

	it("does not let any lens write a temporary test in a read-only session", async () => {
		const observations: boolean[] = []
		let worktree = ""
		const script: PanelScript = (call) => {
			if (call.turn === 1) {
				return { toolCalls: [{ name: "write", arguments: { path: "focused.test.ts", content: "temporary test" } }] }
			}
			if (call.turn === 2) {
				return {
					toolCalls: [{ name: "submit_summary", arguments: { body: "Read-only inspection.", environment_gaps: [] } }],
				}
			}
			return { text: "done" }
		}
		const { ctx } = await scriptedContext(script, "plan")
		const result = await runReviewPanel(
			runOptions(ctx, await target(), {
				lenses: ["spec"],
				agent: {
					maxTurns: 5,
					maxDuration: 30,
					onSessionCreated: (session) => {
						worktree = session.sessionManager.getCwd()
					},
				},
				onProgress: (update) => {
					if (update.phase === "reconciling") observations.push(existsSync(join(worktree, "focused.test.ts")))
				},
			}),
		)
		expect(observations.length).toBeGreaterThan(0)
		expect(observations.every((found) => !found)).toBe(true)
		expect(result.findings).toEqual([])
		expect(result.state.coverage.selected_lenses).toBe(1)
	})
})
