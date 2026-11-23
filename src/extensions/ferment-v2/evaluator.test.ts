import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Api, Model, Usage } from "@earendil-works/pi-ai"
import type { AgentEndEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetProjectScopeTrustForTests } from "../../project-scope-trust.js"
import { createContext, createToolContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import type { FermentV2VerifierAgentRun } from "../agents/index.js"
import permissionsExtension from "../permissions/index.js"
import piiRedactionExtension from "../pii-redaction/index.js"
import * as redactor from "../pii-redaction/redactor.js"
import {
	evaluateFermentV2,
	type FermentV2EvaluationInput,
	type FermentV2VerifierDeps,
	type FermentV2VerifierSpawnInput,
	MAX_SUBMISSION_RESUMES,
} from "./evaluator.js"
import { DEFAULT_FERMENT_V2_SETTINGS, getFermentV2Settings } from "./settings.js"
import type { FermentV2Baseline, FermentV2EvaluatorUsage } from "./types.js"
import {
	enforceWorkspaceIntegrity,
	type IntegrityResult,
	type VerifierEvidence,
	type VerifierGuard,
	type VerifierGuardOptions,
} from "./verifier-guard.js"
import { fixedEvidenceProblem, VERIFIER_REPORT_TOOLS } from "./verifier-report.js"
import {
	detectGitWorkspace,
	gatherWorkspaceFacts,
	reserveBaselineWorktree,
	snapshotWorkspace,
	type TestInventoryFlag,
	type WorkspaceFacts,
	workspaceHead,
} from "./workspace.js"

vi.mock("../agents/index.js", () => ({
	spawnFermentV2VerifierAgent: vi.fn(),
	resumeFermentV2VerifierAgent: vi.fn(),
}))
vi.mock("./settings.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./settings.js")>()
	return { ...actual, getFermentV2Settings: vi.fn() }
})
vi.mock("./verifier-guard.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./verifier-guard.js")>()
	return { ...actual, enforceWorkspaceIntegrity: vi.fn() }
})
vi.mock("./workspace.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./workspace.js")>()
	return {
		...actual,
		snapshotWorkspace: vi.fn(),
		workspaceHead: vi.fn(),
		detectGitWorkspace: vi.fn(),
		reserveBaselineWorktree: vi.fn(),
		gatherWorkspaceFacts: vi.fn(),
	}
})

const fermentV2SettingsMock = vi.mocked(getFermentV2Settings)
const snapshotMock = vi.mocked(snapshotWorkspace)
const headMock = vi.mocked(workspaceHead)
const enforceIntegrityMock = vi.mocked(enforceWorkspaceIntegrity)
const gitProbeMock = vi.mocked(detectGitWorkspace)
const gatherWorkspaceFactsMock = vi.mocked(gatherWorkspaceFacts)
const reserveWorktreeMock = vi.mocked(reserveBaselineWorktree)

const sessionModel = model("session", "main")
const verifierModel = model("judge", "independent")
const rawUsage: Usage = {
	input: 10,
	output: 5,
	cacheRead: 2,
	cacheWrite: 1,
	totalTokens: 18,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
}
const emptyUsage: FermentV2EvaluatorUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	costUsd: 0,
}

const fakeApi = createExtensionApi().api

let attributionDir: string
beforeEach(() => {
	attributionDir = mkdtempSync(join(tmpdir(), "evaluator-attribution-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", attributionDir)
})
afterEach(() => {
	vi.unstubAllEnvs()
	rmSync(attributionDir, { recursive: true, force: true })
})

let redactionSettingsDir: string

/** One scripted call of a verifier report tool. */
type Step =
	| { find: Record<string, unknown> }
	| { retract: { id: string; reason: string } }
	| { submit: Record<string, unknown> }
	| { resolve: Record<string, unknown> }

const FINDING = {
	clause: "ship it",
	evidence: ["e1"],
	observed: "nothing shipped",
	expected: "the release is shipped, as the objective asks",
	why: "the objective's only requirement is unmet",
}
const SUBMIT_CONTINUE: Step = { submit: { verdict: "continue", summary: "" } }
const SUBMIT_MET: Step = { submit: { verdict: "met", summary: "all good" } }

function evidenceEntry(id: string): VerifierEvidence {
	return {
		id,
		toolName: "bash",
		input: { command: `check ${id}` },
		isError: false,
		excerpt: `result ${id}`,
	}
}

/** A guard whose evidence map is pre-populated with the given entries. */
function guardWithEvidence(
	entries: readonly (string | VerifierEvidence)[] = ["e1"],
	usage: FermentV2EvaluatorUsage = emptyUsage,
): VerifierGuard {
	const evidence = new Map(
		entries.map((entry) => {
			const item = typeof entry === "string" ? evidenceEntry(entry) : entry
			return [item.id, item] as const
		}),
	)
	return {
		extension: () => {},
		evidence,
		createdFiles: new Set<string>(),
		usage,
	}
}

function makeRun(overrides: Partial<FermentV2VerifierAgentRun> = {}): FermentV2VerifierAgentRun {
	return { id: "verifier-run-1", text: "", status: "completed", toolCalls: 2, turns: 1, ...overrides }
}

/**
 * The verifier's report tools as registered by the spawned session. The
 * report state spans attempts; each spawn rebinds the tools, and resumes
 * reuse the last binding (the same session).
 */
function createToolHarness() {
	let child: ReturnType<typeof createExtensionApi> | undefined
	const results: string[] = []
	return {
		results,
		async bind(input: FermentV2VerifierSpawnInput) {
			child = createExtensionApi()
			const extension = input.extensionFactories.at(-1)
			if (typeof extension === "function") await extension(child.api)
			else await extension?.factory(child.api)
		},
		async play(steps: readonly Step[]) {
			for (const step of steps) {
				const [name, params] =
					"find" in step
						? ["report_finding", { ...FINDING, ...step.find }]
						: "retract" in step
							? ["retract_finding", step.retract]
							: "resolve" in step
								? ["resolve_finding", step.resolve]
								: ["submit_verdict", step.submit]
				const tool = child?.getRegisteredTool(name)
				if (!tool) throw new Error(`${name} is not registered`)
				const output = await tool.execute("call", params, undefined, undefined, createToolContext())
				results.push((output.content[0] as { text: string }).text)
			}
		},
	}
}

type Attempt = { steps?: readonly Step[]; run?: Partial<FermentV2VerifierAgentRun>; before?: () => Promise<void> }

/** A spawn seam that binds the report tools, plays each attempt's steps, and returns its run. */
function scriptedSpawn(harness: ReturnType<typeof createToolHarness>, ...attempts: Attempt[]) {
	let index = 0
	return vi.fn(async (input: FermentV2VerifierSpawnInput) => {
		const attempt = attempts[Math.min(index++, attempts.length - 1)] ?? {}
		await harness.bind(input)
		await attempt.before?.()
		await harness.play(attempt.steps ?? [])
		return makeRun(attempt.run)
	})
}

/** A resume seam that plays each resume's steps in the already-bound session. */
function scriptedResume(harness: ReturnType<typeof createToolHarness>, ...attempts: Attempt[]) {
	let index = 0
	return vi.fn(async (_id: string, _prompt: string, _signal: AbortSignal) => {
		const attempt = attempts[Math.min(index++, attempts.length - 1)] ?? {}
		await attempt.before?.()
		await harness.play(attempt.steps ?? [])
		return makeRun(attempt.run)
	})
}

function noViolation(): IntegrityResult {
	return { violated: false, restored: [], removed: [], headMoved: false, postRunSnapshot: "after" }
}

/** A reserved baseline worktree whose checkout and disposal are observable. */
function reservedWorktree(path = "/tmp/baseline-wt") {
	return { path, ensure: vi.fn(async () => true), dispose: vi.fn(async () => {}) }
}

function workspaceFactsWithFlags(
	flags: readonly TestInventoryFlag[],
	overrides: Partial<WorkspaceFacts> = {},
): WorkspaceFacts {
	return {
		baseline: "base-1",
		changedFiles: [{ status: "M", path: "src/a.ts" }],
		diffStat: " src/a.ts | 2 +-",
		testInventoryFlags: [...flags],
		testInventoryIncomplete: false,
		git: { branch: "main", head: "head-1", commitsSinceBaseline: 1, uncommittedFiles: 1 },
		truncated: false,
		...overrides,
	}
}

function evaluatorContext() {
	return createContext({
		model: sessionModel,
		modelRegistry: {
			find: vi.fn((provider: string, id: string) =>
				provider === "judge" && id === "independent"
					? verifierModel
					: provider === "session" && id === "main"
						? sessionModel
						: undefined,
			),
			getAvailable: vi.fn(() => [sessionModel, verifierModel]),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "test-key" })),
		},
	})
}

function model(provider: string, id: string): Model<Api> {
	return { provider, id, name: id, api: "openai-completions" } as Model<Api>
}

/** A conversation whose last tool-free assistant entry is the proposed answer. */
function conversationWithAnswer(answer: string): ReadonlyArray<AgentEndEvent["messages"][number]> {
	return [
		{ role: "user", content: "do the work", timestamp: Date.now() } as AgentEndEvent["messages"][number],
		{
			role: "assistant",
			content: [{ type: "text", text: answer }],
			api: "openai-completions",
			provider: "session",
			model: "main",
			usage: rawUsage,
			stopReason: "stop",
			timestamp: Date.now(),
		} as AgentEndEvent["messages"][number],
	]
}

async function evaluate(
	input: {
		deps?: Partial<FermentV2VerifierDeps>
		evidence?: readonly (string | VerifierEvidence)[]
		ctx?: ReturnType<typeof evaluatorContext>
		signal?: AbortSignal
		settings?: Partial<ReturnType<typeof getFermentV2Settings>>
		baseline?: FermentV2Baseline
		messages?: ReadonlyArray<AgentEndEvent["messages"][number]>
		cwd?: string
		transcriptFree?: boolean
		openFindings?: FermentV2EvaluationInput["openFindings"]
	} = {},
) {
	// snapshot/head/facts/enforceIntegrity default to the workspace and
	// verifier-guard module mocks (seeded in beforeEach).
	const harness = createToolHarness()
	const deps: FermentV2VerifierDeps = {
		spawn: scriptedSpawn(harness, { steps: [{ find: {} }, SUBMIT_CONTINUE] }),
		resume: scriptedResume(harness),
		createGuard: vi.fn(() => guardWithEvidence(input.evidence)),
		sleep: vi.fn(async () => {}),
		...input.deps,
	}
	fermentV2SettingsMock.mockReturnValue({
		...DEFAULT_FERMENT_V2_SETTINGS,
		evaluatorModels: ["session/main", "judge/independent"],
		...(input.settings ?? {}),
	})
	return evaluateFermentV2(
		{
			objective: "ship it",
			cwd: input.cwd ?? "/workspace",
			messages: input.messages ?? [],
			todos: [],
			...(input.transcriptFree ? { transcriptFree: true } : {}),
			...(input.baseline ? { baseline: input.baseline } : {}),
			...(input.openFindings ? { openFindings: input.openFindings } : {}),
			...(input.signal ? { signal: input.signal } : {}),
		},
		input.ctx ?? evaluatorContext(),
		fakeApi,
		deps,
	)
}

/** Builds a harness and scripted seams in one place for tests that inspect both. */
function scripted(spawnAttempts: Attempt[], resumeAttempts: Attempt[] = []) {
	const harness = createToolHarness()
	return {
		harness,
		spawn: scriptedSpawn(harness, ...spawnAttempts),
		resume: scriptedResume(harness, ...resumeAttempts),
	}
}

describe("Ferment V2 executing verifier", () => {
	beforeEach(() => {
		// Hermetic resources layer for the redaction gate: no org policy,
		// no user overrides; redaction tests enable the resource via
		// KIMCHI_ENABLE_RESOURCES inside the test.
		redactionSettingsDir = mkdtempSync(join(tmpdir(), "evaluator-redaction-"))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", redactionSettingsDir)
		vi.stubEnv("KIMCHI_ENABLE_RESOURCES", "")
		redactor.resetRedactorEngine()
		fermentV2SettingsMock.mockReturnValue({ ...DEFAULT_FERMENT_V2_SETTINGS })
		gitProbeMock.mockReset().mockResolvedValue("git")
		snapshotMock.mockReset().mockResolvedValue({ commit: "snap", tree: "tree" })
		headMock.mockReset().mockResolvedValue({ kind: "commit", sha: "head-1" })
		enforceIntegrityMock.mockReset().mockResolvedValue(noViolation())
		gatherWorkspaceFactsMock.mockReset().mockResolvedValue(undefined)
		reserveWorktreeMock.mockReset().mockReturnValue(undefined)
	})

	afterEach(() => {
		resetProjectScopeTrustForTests()
		rmSync(redactionSettingsDir, { recursive: true, force: true })
		redactor.resetRedactorEngine()
		vi.restoreAllMocks()
	})

	describe("tool-based report", () => {
		it("accepts met without findings and ends the session on the accepted submission", async () => {
			const { spawn, resume } = scripted([{ steps: [SUBMIT_MET] }])
			const result = await evaluate({ deps: { spawn, resume } })
			expect(result).toMatchObject({ verdict: "met", reason: "all good", findings: [] })
			expect(resume).not.toHaveBeenCalled()
			const terminate = spawn.mock.calls[0]?.[0].shouldTerminateAfterTool
			expect(terminate?.("submit_verdict")).toBe(true)
			expect(terminate?.("report_finding")).toBe(false)
		})

		it("turns active findings into a concrete task-facing continue reason", async () => {
			const result = await evaluate()
			expect(result).toMatchObject({
				verdict: "continue",
				reason: "F1 ship it: expected the release is shipped, as the objective asks; observed nothing shipped.",
			})
			if (result.verdict === "continue") {
				expect(result.findings).toEqual([
					expect.objectContaining({ id: "F1", attempt: 1, status: "active", evidence: ["e1"] }),
				])
			}
		})

		it("rejects a finding that cites evidence no tool result carries", async () => {
			const { harness, spawn, resume } = scripted([{ steps: [{ find: { evidence: ["e9", "made-up"] } }, SUBMIT_MET] }])
			const result = await evaluate({ deps: { spawn, resume } })
			expect(harness.results[0]).toContain("not found: made-up, e9")
			expect(result).toMatchObject({ verdict: "met", findings: [] })
		})

		it("accepts annotated and bracketed evidence IDs", async () => {
			const { spawn, resume } = scripted([{ steps: [{ find: { evidence: ["[E1]"] } }, SUBMIT_CONTINUE] }])
			const result = await evaluate({ deps: { spawn, resume } })
			if (result.verdict === "continue") expect(result.findings?.[0]?.evidence).toEqual(["e1"])
			else throw new Error(`expected continue, got ${result.verdict}`)
		})

		it("refuses met while a finding is active, then accepts it once the finding is retracted", async () => {
			const { harness, spawn, resume } = scripted([
				{
					steps: [
						{ find: {} },
						SUBMIT_MET,
						{ retract: { id: "F1", reason: "the objective allows an unshipped draft" } },
						SUBMIT_MET,
					],
				},
			])
			const result = await evaluate({ deps: { spawn, resume } })
			expect(harness.results[1]).toContain("active findings F1 contradict met")
			expect(result).toMatchObject({ verdict: "met" })
			if (result.verdict === "met") {
				expect(result.findings).toEqual([
					expect.objectContaining({
						id: "F1",
						status: "retracted",
						retractReason: "the objective allows an unshipped draft",
					}),
				])
			}
		})

		it("refuses continue and impossible without an active finding", async () => {
			const { harness, spawn, resume } = scripted([
				{ steps: [SUBMIT_CONTINUE, { submit: { verdict: "impossible", summary: "" } }, SUBMIT_MET] },
			])
			const result = await evaluate({ deps: { spawn, resume } })
			expect(harness.results[0]).toContain("continue needs at least one active finding")
			expect(harness.results[1]).toContain("impossible needs at least one active finding")
			expect(result.verdict).toBe("met")
		})

		it("accepts impossible backed by a blocker finding", async () => {
			const { spawn, resume } = scripted([
				{ steps: [{ find: { clause: "deploy to prod" } }, { submit: { verdict: "impossible", summary: "" } }] },
			])
			const result = await evaluate({ deps: { spawn, resume } })
			expect(result).toMatchObject({ verdict: "impossible" })
		})

		it("excludes the report tools from evidence stamping", async () => {
			let guardOptions: VerifierGuardOptions | undefined
			await evaluate({
				deps: {
					createGuard: (options) => {
						guardOptions = options
						return guardWithEvidence()
					},
				},
			})
			expect(guardOptions?.metadataTools).toEqual(VERIFIER_REPORT_TOOLS)
		})
	})

	describe("getting a submission", () => {
		it("resumes a session that ended without submitting and accepts the resumed verdict", async () => {
			const { spawn, resume } = scripted([{ steps: [] }], [{ steps: [SUBMIT_MET] }])
			const result = await evaluate({ deps: { spawn, resume } })
			expect(resume).toHaveBeenCalledOnce()
			expect(resume.mock.calls[0]?.[1]).toContain("call submit_verdict now")
			expect(result).toMatchObject({ verdict: "met", diagnostics: { correctionCount: 1 } })
		})

		it("returns continue from recorded findings when the resumes never submit", async () => {
			const { spawn, resume } = scripted([{ steps: [{ find: {} }] }], [{ steps: [] }])
			const result = await evaluate({ deps: { spawn, resume } })
			expect(resume).toHaveBeenCalledTimes(MAX_SUBMISSION_RESUMES)
			expect(result).toMatchObject({ verdict: "continue", incompleteReview: true })
		})

		it("reports an incomplete review without findings as unavailable, never as implementation work", async () => {
			const { spawn, resume } = scripted([{ steps: [] }], [{ steps: [] }])
			const result = await evaluate({ deps: { spawn, resume } })
			expect(resume).toHaveBeenCalledTimes(MAX_SUBMISSION_RESUMES)
			expect(result).toMatchObject({ verdict: "unavailable", diagnostics: { failureType: "incomplete_review" } })
		})

		it("carries active findings into the fresh session after a transport retry", async () => {
			const { spawn, resume } = scripted([
				{ steps: [{ find: {} }], run: { status: "error", error: "429 rate limit exceeded" } },
				{ steps: [{ find: { clause: "second" } }, SUBMIT_CONTINUE] },
			])
			const result = await evaluate({ deps: { spawn, resume } })
			expect(spawn).toHaveBeenCalledTimes(2)
			expect(spawn.mock.calls[0]?.[0].prompt).not.toContain("interrupted earlier attempt")
			const retryPrompt = spawn.mock.calls[1]?.[0].prompt ?? ""
			expect(retryPrompt).toContain("interrupted earlier attempt")
			expect(retryPrompt).toContain("F1 [ship it]")
			if (result.verdict !== "continue") throw new Error(`expected continue, got ${result.verdict}`)
			expect(result.findings?.map((finding) => [finding.id, finding.attempt])).toEqual([
				["F1", 1],
				["F2", 2],
			])
		})

		it("grants one grace turn after the overall timeout and marks the verdict", async () => {
			const { spawn, resume } = scripted(
				[{ before: () => new Promise((resolve) => setTimeout(resolve, 30)), steps: [] }],
				[{ steps: [SUBMIT_MET] }],
			)
			const result = await evaluate({ deps: { spawn, resume }, settings: { evaluationTimeoutMs: 5 } })
			expect(resume).toHaveBeenCalledOnce()
			expect(resume.mock.calls[0]?.[1]).toContain("time limit has been reached")
			expect(resume.mock.calls[0]?.[2].aborted).toBe(false)
			expect(result).toMatchObject({ verdict: "met", submittedAfterLimit: true, diagnostics: { timeoutCount: 1 } })
		})

		it("reports a timeout when the grace turn does not submit either", async () => {
			const { spawn, resume } = scripted(
				[{ before: () => new Promise((resolve) => setTimeout(resolve, 30)), steps: [] }],
				[{ steps: [] }],
			)
			const result = await evaluate({ deps: { spawn, resume }, settings: { evaluationTimeoutMs: 5 } })
			expect(resume).toHaveBeenCalledOnce()
			expect(result).toMatchObject({ verdict: "unavailable", diagnostics: { failureType: "timeout", timeoutCount: 1 } })
		})

		it("ends the grace turn at its own deadline", async () => {
			const { spawn } = scripted([{ before: () => new Promise((resolve) => setTimeout(resolve, 30)), steps: [] }])
			let graceSignal: AbortSignal | undefined
			const resume = vi.fn(async (_id: string, _prompt: string, signal: AbortSignal) => {
				graceSignal = signal
				await new Promise((resolve) => setTimeout(resolve, 40))
				return makeRun()
			})
			await evaluate({ deps: { spawn, resume, graceMs: 10 }, settings: { evaluationTimeoutMs: 5 } })
			expect(graceSignal?.aborted).toBe(true)
		})

		it("does not resume or grant grace after the user cancels", async () => {
			const controller = new AbortController()
			const { spawn, resume } = scripted([{ before: async () => controller.abort(), steps: [{ find: {} }] }])
			const result = await evaluate({ deps: { spawn, resume }, signal: controller.signal })
			expect(resume).not.toHaveBeenCalled()
			expect(result).toMatchObject({ verdict: "unavailable", diagnostics: { failureType: "cancelled" } })
		})
	})

	describe("final answer", () => {
		it("downgrades met when the proposed answer differs from a required literal answer", async () => {
			const { spawn, resume } = scripted([
				{
					steps: [
						{ submit: { verdict: "met", summary: "ok", finalAnswer: [{ clause: "answer 42", expected: "42" }] } },
					],
				},
			])
			const result = await evaluate({ messages: conversationWithAnswer("The answer is 42"), deps: { spawn, resume } })
			expect(result).toMatchObject({ verdict: "continue" })
			expect(result.reason).toContain('requires exactly "42"')
		})

		it("records but never compares final-answer checks in a transcript-free review", async () => {
			const check = { clause: 'the error becomes "multiple timezones"', expected: "multiple timezones" }
			const { spawn, resume } = scripted([
				{ steps: [{ submit: { verdict: "met", summary: "ok", finalAnswer: [check] } }] },
			])
			const result = await evaluate({ transcriptFree: true, deps: { spawn, resume } })
			expect(result).toMatchObject({ verdict: "met", reason: "ok", uncheckedFinalAnswer: [check] })
			expect(result).not.toHaveProperty("acceptedFinalAnswer")
		})

		it("still asks a ferment for an exact answer it has not given", async () => {
			const check = { clause: "reply with only the number", expected: "42" }
			const { spawn, resume } = scripted([
				{ steps: [{ submit: { verdict: "met", summary: "ok", finalAnswer: [check] } }] },
			])
			const result = await evaluate({ deps: { spawn, resume } })
			expect(result).toMatchObject({ verdict: "continue" })
			expect(result.reason).toContain("has not been checked against an exact proposed answer")
		})

		it("accepts the exact proposed answer for delivery", async () => {
			const { spawn, resume } = scripted([
				{
					steps: [
						{ submit: { verdict: "met", summary: "ok", finalAnswer: [{ clause: "answer 42", expected: "42" }] } },
					],
				},
			])
			const result = await evaluate({ messages: conversationWithAnswer("42"), deps: { spawn, resume } })
			expect(result).toMatchObject({ verdict: "met", acceptedFinalAnswer: "42" })
		})
	})

	describe("workspace facts and baseline worktree", () => {
		it("gathers facts against HEAD when the ferment has no baseline", async () => {
			const { spawn, resume } = scripted([{ steps: [SUBMIT_MET] }])
			gatherWorkspaceFactsMock.mockResolvedValue(workspaceFactsWithFlags([], { baseline: "head-1" }))
			await evaluate({ deps: { spawn, resume } })
			expect(gatherWorkspaceFactsMock).toHaveBeenCalledWith(
				"/workspace",
				"head-1",
				{ commit: "snap", tree: "tree" },
				undefined,
			)
			const prompt = spawn.mock.calls[0]?.[0].prompt ?? ""
			expect(prompt).toContain("compared against HEAD head-1")
			expect(prompt).toContain("no baseline snapshot was captured")
			expect(reserveWorktreeMock).not.toHaveBeenCalled()
		})

		it("gathers facts against the ferment baseline and renders the flags in the prompt", async () => {
			const { spawn, resume } = scripted([{ steps: [SUBMIT_MET] }])
			gatherWorkspaceFactsMock.mockResolvedValue(
				workspaceFactsWithFlags([{ id: "f1", kind: "test_file_modified", path: "src/a.test.ts" }]),
			)
			await evaluate({
				baseline: { commit: "base-1", capturedAt: "2026-01-01T00:00:00.000Z" },
				deps: { spawn, resume },
			})
			expect(gatherWorkspaceFactsMock).toHaveBeenCalledWith(
				"/workspace",
				"base-1",
				{ commit: "snap", tree: "tree" },
				undefined,
			)
			const prompt = spawn.mock.calls[0]?.[0].prompt ?? ""
			expect(prompt).toContain("compared against the baseline")
			expect(prompt).toContain("f1: test file modified")
			expect(prompt).toContain("run the original version of modified, deleted, or renamed tests")
			expect(prompt).not.toContain("flags array")
		})

		it("reserves the baseline worktree lazily, hands its path to the prompt, and disposes it after the run", async () => {
			const worktree = reservedWorktree()
			const { spawn, resume } = scripted([{ steps: [SUBMIT_MET] }])
			const reserveWorktree = vi.fn(() => worktree)
			await evaluate({
				baseline: { commit: "base-1", capturedAt: "2026-01-01T00:00:00.000Z" },
				deps: { spawn, resume, reserveWorktree },
			})
			expect(reserveWorktree).toHaveBeenCalledWith("/workspace", "base-1")
			const prompt = spawn.mock.calls[0]?.[0].prompt ?? ""
			expect(prompt).toContain("Baseline worktree (host-provided, disposable): /tmp/baseline-wt")
			expect(prompt).toContain("Execution there is NOT isolated")
			expect(worktree.ensure).not.toHaveBeenCalled()
			expect(worktree.dispose).toHaveBeenCalledOnce()
		})

		it("hands the reserved worktree to the guard, which checks it out on demand", async () => {
			const worktree = reservedWorktree()
			let guardOptions: VerifierGuardOptions | undefined
			await evaluate({
				baseline: { commit: "base-1", capturedAt: "2026-01-01T00:00:00.000Z" },
				deps: {
					reserveWorktree: () => worktree,
					createGuard: (options) => {
						guardOptions = options
						return guardWithEvidence()
					},
				},
			})
			expect(guardOptions?.baselineWorktree?.path).toBe("/tmp/baseline-wt")
			await expect(guardOptions?.baselineWorktree?.ensure()).resolves.toBe(true)
			expect(worktree.ensure).toHaveBeenCalledOnce()
		})

		it("tells the verifier when the baseline worktree cannot be reserved", async () => {
			const { spawn, resume } = scripted([{ steps: [SUBMIT_MET] }])
			gatherWorkspaceFactsMock.mockResolvedValue(workspaceFactsWithFlags([]))
			await evaluate({
				baseline: { commit: "base-1", capturedAt: "2026-01-01T00:00:00.000Z" },
				deps: { spawn, resume },
			})
			expect(spawn.mock.calls[0]?.[0].prompt).toContain("Baseline worktree: unavailable")
		})

		it("disposes the baseline worktree after an error and after cancellation", async () => {
			const failed = reservedWorktree()
			await evaluate({
				baseline: { commit: "base-1", capturedAt: "2026-01-01T00:00:00.000Z" },
				deps: {
					spawn: vi.fn(async () => {
						throw new Error("boom")
					}),
					reserveWorktree: () => failed,
				},
			})
			expect(failed.dispose).toHaveBeenCalledOnce()
			const cancelled = reservedWorktree()
			const controller = new AbortController()
			await evaluate({
				baseline: { commit: "base-1", capturedAt: "2026-01-01T00:00:00.000Z" },
				signal: controller.signal,
				deps: {
					spawn: vi.fn(async () => {
						controller.abort()
						return makeRun()
					}),
					reserveWorktree: () => cancelled,
				},
			})
			expect(cancelled.dispose).toHaveBeenCalledOnce()
		})

		it("runs without a baseline outside git and says so in the prompt", async () => {
			const { spawn, resume } = scripted([{ steps: [SUBMIT_MET] }])
			gitProbeMock.mockResolvedValue("outside_git")
			await evaluate({ deps: { spawn, resume } })
			const prompt = spawn.mock.calls[0]?.[0].prompt ?? ""
			expect(prompt).toContain("not a git repository")
			expect(prompt).not.toContain("Baseline worktree")
		})
	})

	describe("availability and transport", () => {
		it("reports unavailable/agent_unavailable when the spawn seam has no agent system", async () => {
			const result = await evaluate({ deps: { spawn: vi.fn(async () => undefined) } })
			expect(result).toMatchObject({ verdict: "unavailable", diagnostics: { failureType: "agent_unavailable" } })
		})

		it("reports unavailable/cancelled when the caller aborts before the run", async () => {
			const controller = new AbortController()
			controller.abort()
			const result = await evaluate({ signal: controller.signal })
			expect(result).toMatchObject({ verdict: "unavailable", diagnostics: { failureType: "cancelled" } })
		})

		it("retries transient provider failures with backoff and then succeeds", async () => {
			const { spawn, resume } = scripted([
				{ run: { status: "error", error: "429 rate limit exceeded" } },
				{ steps: [{ find: {} }, SUBMIT_CONTINUE] },
			])
			const sleep = vi.fn(async () => {})
			const result = await evaluate({ deps: { spawn, resume, sleep } })
			expect(spawn).toHaveBeenCalledTimes(2)
			expect(sleep).toHaveBeenCalledExactlyOnceWith(5_000, expect.any(AbortSignal))
			expect(result).toMatchObject({ verdict: "continue" })
		})

		it("stops retrying after three transient failures and reports the classified reason", async () => {
			const { spawn, resume } = scripted([{ run: { status: "error", error: "429 rate limit exceeded" } }])
			const sleep = vi.fn(async () => {})
			const result = await evaluate({ deps: { spawn, resume, sleep } })
			expect(spawn).toHaveBeenCalledTimes(4)
			expect(sleep).toHaveBeenCalledTimes(3)
			expect(resume).not.toHaveBeenCalled()
			expect(result).toMatchObject({ verdict: "unavailable", diagnostics: { failureType: "rate_limit" } })
		})

		it("does not retry non-transient provider failures", async () => {
			const { spawn, resume } = scripted([{ run: { status: "error", error: "400 bad request payload" } }])
			const sleep = vi.fn(async () => {})
			const result = await evaluate({ deps: { spawn, resume, sleep } })
			expect(spawn).toHaveBeenCalledOnce()
			expect(sleep).not.toHaveBeenCalled()
			expect(result).toMatchObject({ verdict: "unavailable", diagnostics: { failureType: "bad_request" } })
		})

		it("keeps findings recorded before a non-transient failure as a continue", async () => {
			const { spawn, resume } = scripted([
				{ steps: [{ find: {} }], run: { status: "error", error: "400 bad request payload" } },
			])
			const result = await evaluate({ deps: { spawn, resume } })
			expect(result).toMatchObject({ verdict: "continue", incompleteReview: true })
		})

		it("reports a timeout when the cap elapses during backoff before any session can be resumed", async () => {
			const spawn = vi.fn(async () => makeRun({ status: "error", error: "429 rate limit exceeded" }))
			const sleep = vi.fn(
				(_ms: number, signal?: AbortSignal) =>
					new Promise<void>((resolve) => {
						if (signal?.aborted) return resolve()
						signal?.addEventListener("abort", () => resolve())
					}),
			)
			const result = await evaluate({ deps: { spawn, sleep }, settings: { evaluationTimeoutMs: 5 } })
			expect(spawn).toHaveBeenCalledOnce()
			expect(result).toMatchObject({ verdict: "unavailable", diagnostics: { failureType: "timeout", timeoutCount: 1 } })
		})
	})

	describe("fixed resolutions", () => {
		const entry = (id: string, toolName: string, input: Record<string, unknown>, excerpt = ""): VerifierEvidence => ({
			id,
			toolName,
			input,
			isError: false,
			excerpt,
		})
		const ledger = new Map(
			[
				entry("e1", "read", { path: "builtin/errtype.go" }, 'case strings.Contains(msg, "float(nil)")'),
				entry("e2", "bash", { command: "go test -run TestZZ ." }, "--- PASS: TestZZVerifyErrtype"),
				entry("e3", "write", { path: "zz_probe_test.go", content: "run(`try { float(nil) } catch e { errtype(e) }`)" }),
				entry("e4", "bash", { command: "go run ./probe 'float(nil)'" }, "conversion"),
			].map((item) => [item.id, item] as const),
		)

		it("refuses a fixed resolution that rests on reads and an unrelated run", () => {
			expect(fixedEvidenceProblem("F4", "float(nil)", ["e1"], ledger)).toContain("executed re-check")
			expect(fixedEvidenceProblem("F4", "float(nil)", ["e1", "e2"], ledger)).toContain("does not appear")
			expect(fixedEvidenceProblem("F4", undefined, ["e2"], ledger)).toContain("needs reproduction")
		})

		it("accepts the finding's input in a cited command, its output, or a probe file the verifier wrote", () => {
			expect(fixedEvidenceProblem("F4", "float(nil)", ["e4"], ledger)).toBeUndefined()
			expect(fixedEvidenceProblem("F4", "try {  float(nil) }", ["e2", "e3"], ledger)).toBeUndefined()
		})
	})

	describe("workspace integrity", () => {
		it("discards a met verdict as unavailable/guard_violation when integrity finds changes", async () => {
			enforceIntegrityMock.mockResolvedValue({
				...noViolation(),
				violated: true,
				restored: ["src/a.ts"],
				postRunSnapshot: "after-snap",
			})
			const { spawn, resume } = scripted([{ steps: [SUBMIT_MET] }])
			const result = await evaluate({ deps: { spawn, resume } })
			expect(result).toMatchObject({ verdict: "unavailable", diagnostics: { failureType: "guard_violation" } })
			expect(result.reason).toContain("src/a.ts")
			expect(result.reason).toContain("after-snap")
		})

		it("keeps a continue verdict but attaches the integrity outcome on violation", async () => {
			enforceIntegrityMock.mockResolvedValue({ ...noViolation(), violated: true, restored: ["src/a.ts"] })
			const result = await evaluate()
			expect(result).toMatchObject({ verdict: "continue", integrity: { violated: true, restored: ["src/a.ts"] } })
		})

		it("enforces integrity even when the run is cancelled", async () => {
			const controller = new AbortController()
			await evaluate({
				signal: controller.signal,
				deps: {
					spawn: vi.fn(async () => {
						controller.abort()
						return makeRun({ status: "stopped" })
					}),
				},
			})
			expect(enforceIntegrityMock).toHaveBeenCalledOnce()
		})

		it("discards a met verdict when integrity enforcement throws, and keeps a continue", async () => {
			enforceIntegrityMock.mockRejectedValue(new Error("restore failed"))
			const met = scripted([{ steps: [SUBMIT_MET] }])
			const discarded = await evaluate({ deps: { spawn: met.spawn, resume: met.resume } })
			expect(discarded).toMatchObject({ verdict: "unavailable", diagnostics: { failureType: "guard_violation" } })
			expect(discarded.reason).toContain("restore failed")
			expect(await evaluate()).toMatchObject({ verdict: "continue" })
		})

		it("discards a met verdict when the post-run snapshot fails", async () => {
			enforceIntegrityMock.mockResolvedValue({ ...noViolation(), unenforced: true })
			const { spawn, resume } = scripted([{ steps: [SUBMIT_MET] }])
			const result = await evaluate({ deps: { spawn, resume } })
			expect(result.reason).toContain("could not be established after the run")
		})

		it("skips integrity outside git and does not attach it", async () => {
			gitProbeMock.mockResolvedValue("outside_git")
			snapshotMock.mockResolvedValue(undefined)
			const { spawn, resume } = scripted([{ steps: [SUBMIT_MET] }])
			const result = await evaluate({ deps: { spawn, resume } })
			expect(result).toMatchObject({ verdict: "met" })
			expect(enforceIntegrityMock).not.toHaveBeenCalled()
			expect("integrity" in result).toBe(false)
		})

		it("runs the verifier with integrity unenforced when a git workspace cannot be snapshotted", async () => {
			snapshotMock.mockResolvedValue(undefined)
			const { spawn, resume } = scripted([{ steps: [SUBMIT_MET] }])
			const result = await evaluate({
				baseline: { commit: "base-1", capturedAt: "2026-01-01T00:00:00.000Z" },
				deps: { spawn, resume },
			})
			expect(result).toMatchObject({ verdict: "met", integrity: { unenforced: true, violated: false } })
			expect(enforceIntegrityMock).not.toHaveBeenCalled()
			expect(spawn.mock.calls[0]?.[0].prompt).toContain("Integrity guard: unavailable for this run")
		})

		it("runs the verifier without HEAD-move detection when HEAD cannot be resolved", async () => {
			headMock.mockResolvedValue(undefined)
			await evaluate()
			expect(enforceIntegrityMock).toHaveBeenCalledWith(
				"/workspace",
				{ commit: "snap", tree: "tree" },
				undefined,
				undefined,
				expect.objectContaining({ createdFiles: expect.any(Set) }),
			)
		})
	})

	describe("spawn configuration and accounting", () => {
		it("reports the guard's accumulated usage, including on unavailable results", async () => {
			const usage: FermentV2EvaluatorUsage = {
				input: 20,
				output: 10,
				cacheRead: 4,
				cacheWrite: 2,
				totalTokens: 36,
				costUsd: 0.66,
			}
			const continued = await evaluate({ deps: { createGuard: vi.fn(() => guardWithEvidence(["e1"], usage)) } })
			expect(continued).toMatchObject({ verdict: "continue", usage })
			const { spawn, resume } = scripted([{ run: { status: "error", error: "400 bad request payload" } }])
			const failed = await evaluate({
				deps: { spawn, resume, createGuard: vi.fn(() => guardWithEvidence(["e1"], usage)) },
			})
			expect(failed).toMatchObject({ verdict: "unavailable", usage })
		})

		it("counts only the delta of tool calls across a resume", async () => {
			const { spawn, resume } = scripted(
				[{ steps: [], run: { toolCalls: 3, turns: 1 } }],
				[{ steps: [SUBMIT_MET], run: { toolCalls: 5, turns: 1 } }],
			)
			const result = await evaluate({ deps: { spawn, resume } })
			expect(result.diagnostics).toMatchObject({ toolCalls: 5, turns: 2 })
		})

		it("resolves the configured verifier model that is not the implementer", async () => {
			const { spawn, resume } = scripted([{ steps: [SUBMIT_MET] }])
			const result = await evaluate({ deps: { spawn, resume } })
			expect(spawn.mock.calls[0]?.[0].model).toBe(verifierModel)
			expect(result).toMatchObject({ verdict: "met", model: "judge/independent" })
		})

		it("spawns with redaction, permissions, the guard, and the report tools, at unlimited duration", async () => {
			const guardExtension = () => {}
			const { spawn, resume } = scripted([{ steps: [SUBMIT_MET] }])
			await evaluate({
				deps: { spawn, resume, createGuard: () => ({ ...guardWithEvidence(), extension: guardExtension }) },
			})
			const input = spawn.mock.calls[0]?.[0]
			expect(input?.extensionFactories).toHaveLength(4)
			expect(input?.extensionFactories?.[0]).toBe(piiRedactionExtension)
			expect(input?.extensionFactories?.[1]).not.toBe(permissionsExtension)
			expect(input?.extensionFactories?.[2]).toBe(guardExtension)
			expect(input?.maxDuration).toBe(0)
			expect(input?.prompt).toContain("ship it")
		})

		it("spawns the verifier at the configured thinking level and wall-clock cap", async () => {
			const high = scripted([{ steps: [SUBMIT_MET] }])
			await evaluate({ deps: { spawn: high.spawn, resume: high.resume } })
			expect(high.spawn.mock.calls[0]?.[0].thinkingLevel).toBe("high")
			const max = scripted([{ steps: [SUBMIT_MET] }])
			await evaluate({
				deps: { spawn: max.spawn, resume: max.resume },
				settings: { verifierThinking: "max", evaluationTimeoutMs: 45_000 },
			})
			expect(max.spawn.mock.calls[0]?.[0]).toMatchObject({ thinkingLevel: "max", maxDuration: 45 })
		})

		it("resolves no model to unavailable/no_model", async () => {
			const result = await evaluate({
				ctx: { ...evaluatorContext(), model: undefined },
				settings: { evaluatorModels: ["missing/one"] },
			})
			expect(result).toMatchObject({ verdict: "unavailable", diagnostics: { failureType: "no_model" } })
		})

		it("reports unavailable/redaction_failed when prompt redaction fails", async () => {
			vi.stubEnv("KIMCHI_ENABLE_RESOURCES", "extensions.pii-redaction")
			const result = await evaluate({
				deps: {
					redact: vi.fn(async () => {
						throw new Error("redaction engine failed")
					}),
				},
			})
			expect(result).toMatchObject({ verdict: "unavailable", diagnostics: { failureType: "redaction_failed" } })
		})
	})

	describe("open findings from earlier reviews", () => {
		const open = [
			{
				id: "F2",
				clause: "tag it",
				observed: "no tag",
				expected: "a v1 tag",
				why: "the objective asks",
				response: { status: "disputed" as const, evidence: "the objective says unsigned releases need no tag" },
			},
			{ id: "F5", clause: "ship it", observed: "nothing shipped", expected: "shipped", why: "the objective asks" },
		]

		it("lists open findings with responses and refuses to submit until each is resolved", async () => {
			const { harness, spawn, resume } = scripted([
				{
					steps: [
						SUBMIT_MET,
						{ resolve: { id: "F5", resolution: "fixed", evidence: [], reason: "re-ran" } },
						{ resolve: { id: "F5", resolution: "dispute_accepted", evidence: [], reason: "x" } },
						{
							resolve: {
								id: "F5",
								resolution: "fixed",
								evidence: ["e1"],
								reproduction: "check e1",
								reason: "the release ships now",
							},
						},
						{
							resolve: {
								id: "F2",
								resolution: "dispute_accepted",
								evidence: [],
								reason: "the objective exempts unsigned releases",
							},
						},
						{
							resolve: {
								id: "F2",
								resolution: "dispute_accepted",
								evidence: [],
								reason: "the objective exempts unsigned releases",
								source: "objective",
								quote: "ship   IT",
							},
						},
						{ find: {} },
						SUBMIT_CONTINUE,
					],
				},
			])
			const result = await evaluate({ openFindings: open, deps: { spawn, resume } })
			const prompt = spawn.mock.calls[0]?.[0].prompt ?? ""
			expect(prompt).toContain("Open findings from earlier reviews")
			expect(prompt).toContain("- F2 [tag it]")
			expect(prompt).toContain("implementer response: disputed — the objective says unsigned releases need no tag")
			expect(harness.results[0]).toContain("resolve the open findings F2, F5")
			expect(harness.results[1]).toContain("needs the [eN] evidence")
			expect(harness.results[2]).toContain("was not disputed")
			expect(harness.results[4]).toContain("dispute_accepted needs source and the exact quote")
			// New findings continue the numbering after the open ones.
			expect(harness.results[6]).toBe("Recorded finding F6.")
			expect(result).toMatchObject({
				verdict: "continue",
				resolutions: [
					{ id: "F5", resolution: "fixed", evidence: ["e1"] },
					{ id: "F2", resolution: "dispute_accepted", quote: { source: "objective", text: "ship   IT" } },
				],
				findings: [{ id: "F6", status: "active" }],
			})
		})

		it("accepts a dispute only on a quote the host finds in the objective or the named repository file", async () => {
			const dir = mkdtempSync(join(tmpdir(), "evaluator-dispute-"))
			try {
				mkdirSync(join(dir, "docs"))
				writeFileSync(join(dir, "docs", "release.md"), "Unsigned releases\nneed no tag.\n")
				const dispute = (extra: Record<string, unknown>): Step => ({
					resolve: { id: "F2", resolution: "dispute_accepted", evidence: [], reason: "out of scope", ...extra },
				})
				const { harness, spawn, resume } = scripted([
					{
						steps: [
							dispute({ source: "objective", quote: "tags are optional" }),
							dispute({ source: "repository", quote: "unsigned releases need no tag" }),
							dispute({ source: "repository", path: "../outside.md", quote: "x" }),
							dispute({ source: "repository", path: "docs/release.md", quote: "releases need a tag" }),
							dispute({ source: "repository", path: "src/release.ts", quote: "x" }),
							dispute({ source: "repository", path: "docs/release.md", quote: "unsigned releases need no tag" }),
							{
								resolve: {
									id: "F5",
									resolution: "fixed",
									evidence: ["e1"],
									reproduction: "check e1",
									reason: "ships now",
								},
							},
							SUBMIT_MET,
						],
					},
				])
				const result = await evaluate({ cwd: dir, openFindings: open, deps: { spawn, resume } })
				expect(harness.results.slice(0, 5)).toEqual([
					expect.stringContaining("does not appear in the objective"),
					expect.stringContaining("needs the path"),
					expect.stringContaining("inside the repository"),
					expect.stringContaining("does not appear in docs/release.md"),
					expect.stringContaining("src/release.ts is production code"),
				])
				expect(result).toMatchObject({
					verdict: "met",
					resolutions: [
						{ id: "F2", quote: { source: "repository", path: "docs/release.md" } },
						{ id: "F5", resolution: "fixed" },
					],
				})
				expect(spawn.mock.calls[0]?.[0].prompt).toContain("feasibility never removes a requirement")
			} finally {
				rmSync(dir, { recursive: true, force: true })
			}
		})

		it("refuses fixed when the code has not changed since the finding was observed", async () => {
			const unchanged = open.map((finding) => ({ ...finding, observedTree: "tree" }))
			const { harness, spawn, resume } = scripted([
				{
					steps: [
						{
							resolve: { id: "F5", resolution: "fixed", evidence: ["e1"], reproduction: "check e1", reason: "passes" },
						},
						{ resolve: { id: "F5", resolution: "still_failing", evidence: ["e1"], reason: "still fails" } },
						{ resolve: { id: "F2", resolution: "dispute_rejected", evidence: [], reason: "no evidence" } },
						SUBMIT_CONTINUE,
					],
				},
			])
			// The beforeEach snapshot mock reports tree "tree": the same tree the findings were observed on.
			const result = await evaluate({ openFindings: unchanged, deps: { spawn, resume } })
			expect(harness.results[0]).toContain("the code has not changed since F5 was last observed failing")
			expect(result).toMatchObject({ verdict: "continue", workspaceTree: "tree" })
			const changed = open.map((finding) => ({ ...finding, observedTree: "older-tree" }))
			const again = scripted([
				{
					steps: [
						{
							resolve: { id: "F5", resolution: "fixed", evidence: ["e1"], reproduction: "check e1", reason: "passes" },
						},
						{ resolve: { id: "F2", resolution: "dispute_rejected", evidence: [], reason: "no evidence" } },
						SUBMIT_CONTINUE,
					],
				},
			])
			await evaluate({ openFindings: changed, deps: { spawn: again.spawn, resume: again.resume } })
			expect(again.harness.results[0]).toBe("F5 is closed.")
		})

		it("keeps a still-failing or rejected finding active under its ID, which blocks met", async () => {
			const { harness, spawn, resume } = scripted([
				{
					steps: [
						{
							resolve: {
								id: "F5",
								resolution: "still_failing",
								evidence: ["e1"],
								observed: "still nothing",
								reason: "re-ran",
							},
						},
						{
							resolve: {
								id: "F2",
								resolution: "dispute_rejected",
								evidence: [],
								reason: "the objective requires a tag for every release",
							},
						},
						SUBMIT_MET,
						SUBMIT_CONTINUE,
					],
				},
			])
			const result = await evaluate({ openFindings: open, deps: { spawn, resume } })
			expect(harness.results[2]).toContain("active findings F5, F2 contradict met")
			expect(result).toMatchObject({
				verdict: "continue",
				findings: [
					{ id: "F5", observed: "still nothing", carried: true },
					{ id: "F2", carried: true, why: expect.stringContaining("Dispute rejected: the objective requires a tag") },
				],
			})
			expect(result.reason).toContain("F5 ship it")
		})
	})
})
