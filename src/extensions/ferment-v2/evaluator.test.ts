import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Api, Model, StopReason, Usage } from "@earendil-works/pi-ai"
import type { AgentEndEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetProjectScopeTrustForTests } from "../../project-scope-trust.js"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import type { FermentV2VerifierAgentRun } from "../agents/index.js"
import permissionsExtension from "../permissions/index.js"
import { resetRedactionConfigCache } from "../pii-redaction/config.js"
import piiRedactionExtension from "../pii-redaction/index.js"
import * as redactor from "../pii-redaction/redactor.js"
import {
	evaluateFermentV2,
	type FermentV2VerifierDeps,
	type FermentV2VerifierSpawnInput,
	parseFermentV2EvaluatorOutput,
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
import {
	detectGitWorkspace,
	gatherWorkspaceFacts,
	listSnapshotPaths,
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
		listSnapshotPaths: vi.fn(),
	}
})

const fermentV2SettingsMock = vi.mocked(getFermentV2Settings)
const snapshotMock = vi.mocked(snapshotWorkspace)
const headMock = vi.mocked(workspaceHead)
const enforceIntegrityMock = vi.mocked(enforceWorkspaceIntegrity)
const gitProbeMock = vi.mocked(detectGitWorkspace)
const gatherWorkspaceFactsMock = vi.mocked(gatherWorkspaceFacts)
const reserveWorktreeMock = vi.mocked(reserveBaselineWorktree)
const listSnapshotPathsMock = vi.mocked(listSnapshotPaths)

const CITED_CONTINUE =
	'{"verdict":"continue","reason":"more work","checks":[{"kind":"work","requirement":"ship it","status":"fail","evidence":["e1"]}]}'
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

let savedRedactionEnv: string | undefined

/** A guard whose evidence map is pre-populated with the given IDs. */
function guardWithEvidence(
	ids: readonly string[],
	usage: FermentV2EvaluatorUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
): VerifierGuard {
	const evidence = new Map(
		ids.map((id) => [
			id,
			{ id, toolName: "bash", input: { command: `check ${id}` }, isError: false, excerpt: `result ${id}` },
		]),
	)
	return { extension: () => {}, evidence, createdFiles: new Set<string>(), usage }
}

function makeRun(overrides: Partial<FermentV2VerifierAgentRun> = {}): FermentV2VerifierAgentRun {
	return {
		id: "verifier-run-1",
		text: CITED_CONTINUE,
		status: "completed",
		toolCalls: 2,
		turns: 1,
		...overrides,
	}
}

function fakeSession(assistantUsage: Usage[] = [rawUsage]): NonNullable<FermentV2VerifierAgentRun["session"]> {
	return {
		messages: assistantUsage.map((usage) => ({
			role: "assistant",
			content: [],
			usage,
			timestamp: Date.now(),
		})),
	} as unknown as NonNullable<FermentV2VerifierAgentRun["session"]>
}

/** A typed spawn seam so `mock.calls[0][0]` carries the input type. */
function spawnFn(
	impl: (input: FermentV2VerifierSpawnInput) => Promise<FermentV2VerifierAgentRun | undefined> = async () => makeRun(),
) {
	return vi.fn(impl)
}

function noViolation(): IntegrityResult {
	return { violated: false, restored: [], removed: [], headMoved: false, postRunSnapshot: "after" }
}

/** A reserved baseline worktree whose checkout and disposal are observable. */
function reservedWorktree(path = "/tmp/baseline-wt") {
	return { path, ensure: vi.fn(async () => true), dispose: vi.fn(async () => {}) }
}

const MET_ALL_GOOD =
	'{"verdict":"met","reason":"all good","checks":[{"kind":"work","category":"behavior","method":"command","requirement":"ship it","status":"pass","failureMode":"fm","evidence":["e1"]}]}'

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

function evaluatorContext(resolvedVerifier: Model<Api> | undefined = verifierModel) {
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
			getAvailable: vi.fn(() => (resolvedVerifier ? [sessionModel, resolvedVerifier] : [sessionModel])),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "test-key" })),
		},
	})
}

function model(provider: string, id: string): Model<Api> {
	return { provider, id, name: id, api: "openai-completions" } as Model<Api>
}

function assistant(text: string, options: { stopReason?: StopReason } = {}) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "openai-completions" as const,
		provider: "session",
		model: "main",
		usage: rawUsage,
		stopReason: options.stopReason ?? ("stop" as const),
		timestamp: Date.now(),
	}
}

/** A conversation whose last tool-free assistant entry is the proposed answer. */
function conversationWithAnswer(answer: string): ReadonlyArray<AgentEndEvent["messages"][number]> {
	return [
		{
			role: "user",
			content: "do the work",
			timestamp: Date.now(),
		} as AgentEndEvent["messages"][number],
		assistant(answer) as AgentEndEvent["messages"][number],
	]
}

async function evaluate(
	input: {
		text?: string
		evidence?: readonly string[]
		deps?: Partial<FermentV2VerifierDeps>
		messages?: ReadonlyArray<AgentEndEvent["messages"][number]>
		ctx?: ReturnType<typeof evaluatorContext>
		signal?: AbortSignal
		settings?: Partial<ReturnType<typeof getFermentV2Settings>>
		baseline?: FermentV2Baseline
		keptProbes?: readonly { path: string; requirementId: string }[]
	} = {},
) {
	const evidence = input.evidence ?? ["e1"]
	const text = input.text ?? CITED_CONTINUE
	// snapshot/head/facts/enforceIntegrity intentionally default to the
	// workspace and verifier-guard module mocks (seeded in beforeEach) so tests
	// can steer them through those mocks.
	const deps: FermentV2VerifierDeps = {
		spawn: vi.fn(async () => makeRun({ text })),
		resume: vi.fn(async (_id: string, prompt: string) => makeRun({ text: prompt })),
		createGuard: vi.fn(() => guardWithEvidence(evidence)),
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
			cwd: "/workspace",
			messages: input.messages ?? [],
			todos: [],
			...(input.baseline ? { baseline: input.baseline } : {}),
			...(input.keptProbes ? { keptProbes: input.keptProbes } : {}),
			...(input.signal ? { signal: input.signal } : {}),
		},
		input.ctx ?? evaluatorContext(),
		fakeApi,
		deps,
	)
}

describe("Ferment V2 executing verifier", () => {
	beforeEach(() => {
		savedRedactionEnv = process.env.KIMCHI_REDACTION_ENABLED
		delete process.env.KIMCHI_REDACTION_ENABLED
		resetRedactionConfigCache()
		redactor.resetRedactorEngine()
		fermentV2SettingsMock.mockReturnValue({ ...DEFAULT_FERMENT_V2_SETTINGS })
		gitProbeMock.mockReset().mockResolvedValue("git")
		snapshotMock.mockReset().mockResolvedValue({ commit: "snap", tree: "tree" })
		headMock.mockReset().mockResolvedValue({ kind: "commit", sha: "head-1" })
		enforceIntegrityMock.mockReset().mockResolvedValue(noViolation())
		gatherWorkspaceFactsMock.mockReset().mockResolvedValue(undefined)
		reserveWorktreeMock.mockReset().mockReturnValue(undefined)
		listSnapshotPathsMock.mockReset().mockResolvedValue(undefined)
	})

	afterEach(() => {
		resetProjectScopeTrustForTests()
		if (savedRedactionEnv === undefined) delete process.env.KIMCHI_REDACTION_ENABLED
		else process.env.KIMCHI_REDACTION_ENABLED = savedRedactionEnv
		resetRedactionConfigCache()
		redactor.resetRedactorEngine()
		vi.restoreAllMocks()
	})

	it("accepts a met verdict whose every check cites stamped evidence", async () => {
		const result = await evaluate({
			text: '{"verdict":"met","reason":"all good","checks":[{"kind":"work","method":"existing_test","requirement":"ship it","status":"pass","failureMode":"untested path","evidence":["e1"]}]}',
		})
		expect(result).toMatchObject({ verdict: "met", reason: "all good", model: "judge/independent" })
		if (result.verdict === "met") {
			expect(result.usage).toMatchObject({ input: 0, output: 0, totalTokens: 0, costUsd: 0 })
			expect(result.acceptedFinalAnswer).toBeUndefined()
			expect(result.diagnostics.toolCalls).toBe(2)
			expect(result.diagnostics.turns).toBe(1)
		}
	})

	it("downgrades a met verdict with no cited evidence to a host-authored continue", async () => {
		const result = await evaluate({
			text: '{"verdict":"met","reason":"all good","checks":[{"kind":"work","requirement":"ship it","status":"pass","failureMode":"fm","evidence":[]}]}',
		})
		expect(result.verdict).toBe("continue")
		if (result.verdict === "continue") {
			expect(result.reason).toContain("has no cited evidence")
		}
	})

	it("downgrades a met verdict citing an unknown evidence ID even when a valid one is also cited", async () => {
		const result = await evaluate({
			text: '{"verdict":"met","reason":"all good","checks":[{"kind":"work","requirement":"ship it","status":"pass","failureMode":"fm","evidence":["e1","e999"]}]}',
		})
		expect(result.verdict).toBe("continue")
		if (result.verdict === "continue") {
			expect(result.reason).toContain("e999")
			expect(result.reason).toContain("match no executed tool result")
		}
	})

	it("downgrades a met verdict that leaves a test-inventory flag unaddressed", async () => {
		gatherWorkspaceFactsMock.mockResolvedValue(
			workspaceFactsWithFlags([
				{ id: "f1", kind: "test_file_deleted", path: "src/a.test.ts" },
				{ id: "f2", kind: "skip_marker_added", path: "src/b.test.ts", detail: "it.skip('works')" },
			]),
		)
		const result = await evaluate({ text: MET_ALL_GOOD })
		expect(result.verdict).toBe("continue")
		if (result.verdict === "continue") {
			expect(result.reason).toContain("f1")
			expect(result.reason).toContain("test file deleted")
			expect(result.reason).toContain("src/a.test.ts")
		}
	})

	it("accepts a met verdict on an incomplete test inventory and tells the verifier to inspect test files", async () => {
		const spawn = spawnFn(async () => makeRun({ text: MET_ALL_GOOD }))
		gatherWorkspaceFactsMock.mockResolvedValue(workspaceFactsWithFlags([], { testInventoryIncomplete: true }))
		const result = await evaluate({ deps: { spawn } })
		expect(result).toMatchObject({ verdict: "met", reason: "all good" })
		expect(spawn.mock.calls[0]?.[0].prompt).toContain("could not collect the test inventory completely")
	})

	it("accepts a met verdict when the baseline comparison fails and reports the facts as unavailable", async () => {
		const spawn = spawnFn(async () => makeRun({ text: MET_ALL_GOOD }))
		// The default workspace mock resolves undefined: the baseline diff failed.
		const result = await evaluate({
			baseline: { commit: "base-1", capturedAt: "2026-01-01T00:00:00.000Z" },
			deps: { spawn },
		})
		expect(gatherWorkspaceFactsMock).toHaveBeenCalledOnce()
		expect(result).toMatchObject({ verdict: "met" })
		expect(spawn.mock.calls[0]?.[0].prompt).toContain("unavailable for this run — git failed")
	})

	it("accepts a met verdict that addresses every test-inventory flag", async () => {
		gatherWorkspaceFactsMock.mockResolvedValue(
			workspaceFactsWithFlags([
				{ id: "f1", kind: "test_file_deleted", path: "src/a.test.ts" },
				{ id: "f2", kind: "skip_marker_added", path: "src/b.test.ts" },
			]),
		)
		const result = await evaluate({
			text: '{"verdict":"met","reason":"all good","checks":[{"kind":"work","method":"baseline_test","requirement":"ship it","status":"pass","failureMode":"fm","evidence":["e1"],"flags":["f1","f2"]}]}',
		})
		expect(result).toMatchObject({ verdict: "met", reason: "all good" })
	})

	describe("independent verification (procedure rules)", () => {
		const met = (check: Record<string, unknown>) =>
			JSON.stringify({
				verdict: "met",
				reason: "all good",
				checks: [
					{ kind: "work", requirement: "ship it", status: "pass", failureMode: "fm", evidence: ["e1"], ...check },
				],
			})

		it("sends a behaviour pass resting on the implementer's tests back to the verifier as a procedure correction", async () => {
			const resume = vi.fn(async (_id: string, _prompt: string) =>
				makeRun({ text: met({ category: "behavior", method: "probe" }) }),
			)
			const guard = guardWithEvidence(["e1"])
			const evidence = guard.evidence as Map<string, VerifierEvidence>
			evidence.set("e1", {
				...evidence.get("e1"),
				input: { command: "npx vitest run test/ship.probe.test.ts" },
			} as VerifierEvidence)
			const createdFiles = guard.createdFiles as Set<string>
			createdFiles.add("/workspace/test/ship.probe.test.ts")
			const result = await evaluate({
				text: met({ category: "behavior", method: "implementer_test" }),
				deps: { resume, createGuard: () => guard },
			})
			expect(resume).toHaveBeenCalledOnce()
			const prompt = resume.mock.calls[0]?.[1] ?? ""
			expect(prompt).toContain("verification incomplete")
			expect(prompt).toContain("implementer's own tests are context, not proof")
			expect(prompt).toContain("write and run the probes")
			expect(result).toMatchObject({ verdict: "met" })
		})

		it("reports unavailable/procedure_incomplete when the corrected verdict is still not independent", async () => {
			const resume = vi.fn(async () => makeRun({ text: met({}) }))
			const result = await evaluate({ text: met({ method: "inspection" }), deps: { resume } })
			expect(result.verdict).toBe("unavailable")
			if (result.verdict === "unavailable") {
				expect(result.diagnostics.failureType).toBe("procedure_incomplete")
				expect(result.reason).toContain("unlabelled evidence")
			}
		})

		it("requires a probe check to cite a run of a file the verifier created", async () => {
			const resume = vi.fn(async (_id: string, _prompt: string) => makeRun({ text: met({ method: "probe" }) }))
			const result = await evaluate({ text: met({ method: "probe" }), deps: { resume } })
			expect(resume.mock.calls[0]?.[1]).toContain('labelled "probe" but cites no run of a probe file you created')
			expect(result.verdict).toBe("unavailable")
		})

		it("accepts a probe created with shell commands: a cited run of a repository file absent before the run", async () => {
			listSnapshotPathsMock.mockResolvedValue({
				root: "/workspace",
				paths: new Set(["src/ship.ts", "test/ship.test.ts"]),
			})
			const guard = guardWithEvidence(["e1"])
			const evidence = guard.evidence as Map<string, VerifierEvidence>
			evidence.set("e1", {
				...evidence.get("e1"),
				input: { command: "timeout 300 npx vitest run test/ship.verifier-probe.test.ts" },
			} as VerifierEvidence)
			const result = await evaluate({ text: met({ method: "probe" }), deps: { createGuard: () => guard } })
			expect(listSnapshotPathsMock).toHaveBeenCalledWith("/workspace", { commit: "snap", tree: "tree" }, undefined)
			expect(result).toMatchObject({ verdict: "met" })
		})

		it("rejects a probe label on a run of the implementer's own test, which existed before the run", async () => {
			listSnapshotPathsMock.mockResolvedValue({
				root: "/workspace",
				paths: new Set(["src/ship.ts", "test/ship.test.ts"]),
			})
			const guard = guardWithEvidence(["e1"])
			const evidence = guard.evidence as Map<string, VerifierEvidence>
			evidence.set("e1", {
				...evidence.get("e1"),
				input: { command: "npx vitest run test/ship.test.ts" },
			} as VerifierEvidence)
			const resume = vi.fn(async (_id: string, _prompt: string) => makeRun({ text: met({ method: "probe" }) }))
			const result = await evaluate({ text: met({ method: "probe" }), deps: { createGuard: () => guard, resume } })
			expect(resume.mock.calls[0]?.[1]).toContain('labelled "probe" but cites no run of a probe file you created')
			expect(result.verdict).toBe("unavailable")
		})

		it("accepts constraint and delivery passes on inspection", async () => {
			const text = JSON.stringify({
				verdict: "met",
				reason: "all good",
				checks: [
					{
						kind: "work",
						category: "behavior",
						method: "existing_test",
						requirement: "ship it",
						status: "pass",
						failureMode: "fm",
						evidence: ["e1"],
					},
					{
						kind: "work",
						category: "constraint",
						method: "inspection",
						requirement: "lives in src/ship.ts",
						status: "pass",
						failureMode: "fm",
						evidence: ["e1"],
					},
					{
						kind: "work",
						category: "delivery",
						method: "inspection",
						requirement: "committed on a branch",
						status: "pass",
						failureMode: "fm",
						evidence: ["e1"],
					},
				],
			})
			expect(await evaluate({ text })).toMatchObject({ verdict: "met" })
		})

		it("requires a baseline_test check for every modified, deleted, or renamed pre-existing test file", async () => {
			gatherWorkspaceFactsMock.mockResolvedValue(
				workspaceFactsWithFlags([
					{ id: "f1", kind: "test_file_modified", path: "src/a.test.ts" },
					{ id: "f2", kind: "skip_marker_added", path: "src/b.test.ts" },
				]),
			)
			const resume = vi.fn(async (_id: string, _prompt: string) =>
				makeRun({ text: met({ method: "baseline_test", flags: ["f1", "f2"] }) }),
			)
			const result = await evaluate({ text: met({ method: "command", flags: ["f1", "f2"] }), deps: { resume } })
			const prompt = resume.mock.calls[0]?.[1] ?? ""
			expect(prompt).toContain("Flag f1 (test file modified: src/a.test.ts) has no baseline_test check")
			expect(prompt).toContain("git show <baseline>:src/a.test.ts")
			expect(result).toMatchObject({ verdict: "met" })
		})
	})

	it("gathers facts against HEAD when the ferment has no baseline", async () => {
		const spawn = spawnFn()
		gatherWorkspaceFactsMock.mockResolvedValue(workspaceFactsWithFlags([], { baseline: "head-1" }))
		await evaluate({ deps: { spawn } })
		expect(gatherWorkspaceFactsMock).toHaveBeenCalledWith(
			"/workspace",
			"head-1",
			{ commit: "snap", tree: "tree" },
			[],
			undefined,
		)
		const prompt = spawn.mock.calls[0]?.[0].prompt ?? ""
		expect(prompt).toContain("compared against HEAD head-1")
		expect(prompt).toContain("no baseline snapshot was captured")
		// The baseline worktree belongs to a ferment baseline only.
		expect(reserveWorktreeMock).not.toHaveBeenCalled()
	})

	it("gathers facts against the ferment baseline and renders the flags in the prompt", async () => {
		const spawn = spawnFn()
		gatherWorkspaceFactsMock.mockResolvedValue(
			workspaceFactsWithFlags([{ id: "f1", kind: "test_file_modified", path: "src/a.test.ts" }]),
		)
		await evaluate({
			baseline: { commit: "base-1", capturedAt: "2026-01-01T00:00:00.000Z" },
			keptProbes: [{ path: "probes/p.test.ts", requirementId: "R1" }],
			deps: { spawn },
		})
		expect(gatherWorkspaceFactsMock).toHaveBeenCalledWith(
			"/workspace",
			"base-1",
			{ commit: "snap", tree: "tree" },
			[{ path: "probes/p.test.ts", requirementId: "R1" }],
			undefined,
		)
		const prompt = spawn.mock.calls[0]?.[0].prompt ?? ""
		expect(prompt).toContain("compared against the baseline")
		expect(prompt).toContain("f1: test file modified")
		expect(prompt).toContain("must be addressed by some check's flags array")
	})

	it("reserves the baseline worktree lazily, hands its path to the prompt, and disposes it after the run", async () => {
		const worktree = reservedWorktree()
		const spawn = spawnFn()
		const reserveWorktree = vi.fn(() => worktree)
		await evaluate({
			baseline: { commit: "base-1", capturedAt: "2026-01-01T00:00:00.000Z" },
			deps: { spawn, reserveWorktree },
		})
		expect(reserveWorktree).toHaveBeenCalledWith("/workspace", "base-1")
		const prompt = spawn.mock.calls[0]?.[0].prompt ?? ""
		expect(prompt).toContain("Baseline worktree (host-provided, disposable): /tmp/baseline-wt")
		expect(prompt).toContain("checked out on first use")
		expect(prompt).toContain("they must FAIL there")
		expect(prompt).toContain("editable install")
		// Nothing referenced the worktree, so it was never checked out.
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
					return guardWithEvidence(["e1"])
				},
			},
		})
		expect(guardOptions?.baselineWorktree?.path).toBe("/tmp/baseline-wt")
		await expect(guardOptions?.baselineWorktree?.ensure()).resolves.toBe(true)
		expect(worktree.ensure).toHaveBeenCalledOnce()
	})

	it("tells the verifier when the baseline worktree cannot be reserved", async () => {
		const spawn = spawnFn()
		gatherWorkspaceFactsMock.mockResolvedValue(workspaceFactsWithFlags([]))
		await evaluate({
			baseline: { commit: "base-1", capturedAt: "2026-01-01T00:00:00.000Z" },
			deps: { spawn },
		})
		const prompt = spawn.mock.calls[0]?.[0].prompt ?? ""
		expect(prompt).toContain("Baseline worktree: unavailable")
	})

	it("disposes the baseline worktree after an error", async () => {
		const worktree = reservedWorktree()
		const result = await evaluate({
			baseline: { commit: "base-1", capturedAt: "2026-01-01T00:00:00.000Z" },
			deps: {
				spawn: vi.fn(async () => {
					throw new Error("boom")
				}),
				reserveWorktree: () => worktree,
			},
		})
		expect(result.verdict).toBe("unavailable")
		expect(worktree.dispose).toHaveBeenCalledOnce()
	})

	it("disposes the baseline worktree when the run is cancelled mid-flight", async () => {
		const worktree = reservedWorktree()
		const controller = new AbortController()
		await evaluate({
			baseline: { commit: "base-1", capturedAt: "2026-01-01T00:00:00.000Z" },
			signal: controller.signal,
			deps: {
				spawn: vi.fn(async () => {
					controller.abort()
					return makeRun()
				}),
				reserveWorktree: () => worktree,
			},
		})
		expect(worktree.dispose).toHaveBeenCalledOnce()
	})

	it("runs without a baseline outside git and says so in the prompt", async () => {
		const spawn = spawnFn()
		gitProbeMock.mockResolvedValue("outside_git")
		await evaluate({ deps: { spawn } })
		const prompt = spawn.mock.calls[0]?.[0].prompt ?? ""
		expect(prompt).toContain("not a git repository")
		expect(prompt).toContain("no baseline snapshot")
		expect(prompt).not.toContain("Baseline worktree")
	})

	it("corrects a continue verdict citing an unknown evidence ID once, then reports unavailable", async () => {
		const resume = vi.fn(async () =>
			makeRun({
				text: '{"verdict":"continue","reason":"still hallucinating","checks":[{"kind":"work","requirement":"ship it","status":"fail","evidence":["e1","e999"]}]}',
			}),
		)
		const result = await evaluate({
			text: '{"verdict":"continue","reason":"fix things","checks":[{"kind":"work","requirement":"ship it","status":"fail","evidence":["e1","e999"]}]}',
			deps: { resume },
		})
		expect(resume).toHaveBeenCalledOnce()
		expect(result.verdict).toBe("unavailable")
		if (result.verdict === "unavailable") {
			expect(result.diagnostics.failureType).toBe("uncited_verdict")
		}
	})

	it("corrects an impossible verdict citing an unknown evidence ID, then reports unavailable", async () => {
		const resume = vi.fn(async () =>
			makeRun({
				text: '{"verdict":"impossible","reason":"still hallucinating","checks":[{"kind":"work","requirement":"ship it","status":"fail","evidence":["e999"]}]}',
			}),
		)
		const result = await evaluate({
			text: '{"verdict":"impossible","reason":"blocked forever","checks":[{"kind":"work","requirement":"ship it","status":"fail","evidence":["e999"]}]}',
			deps: { resume },
		})
		expect(resume).toHaveBeenCalledOnce()
		expect(result.verdict).toBe("unavailable")
		if (result.verdict === "unavailable") {
			expect(result.diagnostics.failureType).toBe("uncited_verdict")
		}
	})

	it("blocks an impossible verdict without a cited check, then reports unavailable/uncited_verdict", async () => {
		const resume = vi.fn(async () => makeRun({ text: '{"verdict":"impossible","reason":"need user input"}' }))
		const result = await evaluate({ text: '{"verdict":"impossible","reason":"need user input"}', deps: { resume } })
		expect(resume).toHaveBeenCalledOnce()
		expect(result.verdict).toBe("unavailable")
		if (result.verdict === "unavailable") {
			expect(result.diagnostics.failureType).toBe("uncited_verdict")
			expect(result.diagnostics.correctionCount).toBe(1)
		}
	})

	it("accepts an impossible verdict backed by a cited check", async () => {
		const result = await evaluate({
			text: '{"verdict":"impossible","reason":"needs the credentials","checks":[{"kind":"work","requirement":"ship it","status":"fail","evidence":["e1"]}]}',
		})
		expect(result).toMatchObject({
			verdict: "impossible",
			reason: "Remaining requirement: ship it. Failing check: result e1",
		})
	})

	it("downgrades a met verdict whose check names no failure mode", async () => {
		const result = await evaluate({
			text: '{"verdict":"met","reason":"all good","checks":[{"kind":"work","requirement":"ship it","status":"pass","evidence":["e1"]}]}',
		})
		expect(result.verdict).toBe("continue")
		if (result.verdict === "continue") {
			expect(result.reason).toContain("plausible failure mode")
		}
	})

	it("downgrades a met verdict with a failing check to a continue naming the requirement", async () => {
		const result = await evaluate({
			text: '{"verdict":"met","reason":"all good","checks":[{"kind":"work","requirement":"ship it","status":"fail","evidence":["e1"]}]}',
		})
		expect(result.verdict).toBe("continue")
		if (result.verdict === "continue") {
			expect(result.reason).toContain("is not met; continue work and verify it")
			expect(result.reason).toContain("Failing check: result e1")
		}
	})

	it("keeps a continue verdict with at least one cited failing check", async () => {
		const result = await evaluate({
			text: '{"verdict":"continue","reason":"Fix the parser","checks":[{"kind":"work","requirement":"ship it","status":"fail","evidence":["e1"]}]}',
		})
		expect(result).toMatchObject({
			verdict: "continue",
			reason: "Remaining requirement: ship it. Failing check: result e1",
		})
	})

	it("keeps the verifier's own summary when the failing check's cited evidence has no text excerpt", async () => {
		const result = await evaluate({
			text: '{"verdict":"continue","reason":"Fix the parser","checks":[{"kind":"work","requirement":"ship it","status":"fail","evidence":["e1"]}]}',
			deps: {
				// A tool result with no text content stamps an empty excerpt: the
				// composed gap has nothing to show, so the verifier's summary stands.
				createGuard: () => ({
					extension: () => {},
					evidence: new Map([["e1", { id: "e1", toolName: "read", input: {}, isError: false, excerpt: "" }]]),
					createdFiles: new Set<string>(),
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
				}),
			},
		})
		expect(result).toMatchObject({ verdict: "continue", reason: "Fix the parser" })
	})

	it("embeds the failing check's evidence excerpt, flattened and clipped, in the task-facing reason", async () => {
		const result = await evaluate({
			text: '{"verdict":"continue","reason":"Fix the parser","checks":[{"kind":"work","requirement":"ship it","status":"fail","evidence":["e1"]}]}',
			deps: {
				createGuard: () => ({
					extension: () => {},
					evidence: new Map([
						[
							"e1",
							{
								id: "e1",
								toolName: "bash",
								input: {},
								isError: false,
								excerpt: `assertion failed\n${"x".repeat(500)}`,
							},
						],
					]),
					createdFiles: new Set<string>(),
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
				}),
			},
		})
		expect(result.verdict).toBe("continue")
		if (result.verdict === "continue") {
			expect(result.reason).toContain("Failing check: assertion failed ")
			expect(result.reason.endsWith("…")).toBe(true)
			expect(result.reason).toHaveLength("Remaining requirement: ship it. Failing check: ".length + 301)
		}
	})

	it("corrects an uncited continue verdict once, then reports unavailable/uncited_verdict", async () => {
		const resume = vi.fn(async () =>
			makeRun({
				text: '{"verdict":"continue","reason":"still uncited","checks":[{"kind":"work","requirement":"ship it","status":"fail","evidence":["e7"]}]}',
			}),
		)
		const result = await evaluate({
			text: '{"verdict":"continue","reason":"fix things","checks":[{"kind":"work","requirement":"ship it","status":"fail","evidence":["e7"]}]}',
			deps: { resume },
		})
		expect(resume).toHaveBeenCalledOnce()
		expect(result.verdict).toBe("unavailable")
		if (result.verdict === "unavailable") {
			expect(result.diagnostics.failureType).toBe("uncited_verdict")
			expect(result.diagnostics.correctionCount).toBe(1)
		}
	})

	it("accepts a continue verdict after the correction supplies a cited failing check", async () => {
		const resume = vi.fn(async () =>
			makeRun({
				text: '{"verdict":"continue","reason":"now cited","checks":[{"kind":"work","requirement":"ship it","status":"fail","evidence":["e1"]}]}',
			}),
		)
		const result = await evaluate({
			text: '{"verdict":"continue","reason":"fix things","checks":[{"kind":"work","requirement":"ship it","status":"fail","evidence":["e7"]}]}',
			deps: { resume },
		})
		expect(result).toMatchObject({
			verdict: "continue",
			reason: "Remaining requirement: ship it. Failing check: result e1",
		})
	})

	it("corrects an unparseable verdict once, then reports unavailable/invalid_output", async () => {
		const resume = vi.fn(async () => makeRun({ text: "still not json" }))
		const result = await evaluate({ text: "not json at all", deps: { resume } })
		expect(resume).toHaveBeenCalledOnce()
		expect(result.verdict).toBe("unavailable")
		if (result.verdict === "unavailable") {
			expect(result.diagnostics.failureType).toBe("invalid_output")
			expect(result.diagnostics.correctionCount).toBe(1)
		}
	})

	it("accepts the verdict after the correction returns a valid one", async () => {
		const resume = vi.fn(async () =>
			makeRun({
				text: '{"verdict":"impossible","reason":"needs the credentials","checks":[{"kind":"work","requirement":"ship it","status":"unverifiable","evidence":["e1"]}]}',
			}),
		)
		const result = await evaluate({ text: "not json at all", deps: { resume } })
		expect(result).toMatchObject({ verdict: "impossible", reason: "needs the credentials" })
	})

	it("counts only the delta of tool calls across a correction resume", async () => {
		const spawn = vi.fn(async () => makeRun({ text: "not json at all" }))
		const resume = vi.fn(async () =>
			makeRun({
				text: '{"verdict":"continue","reason":"now cited","checks":[{"kind":"work","requirement":"ship it","status":"fail","evidence":["e1"]}]}',
				// The resume returns the child record's cumulative count: 2 initial + 1 correction.
				toolCalls: 3,
			}),
		)
		const result = await evaluate({ deps: { spawn, resume } })
		expect(result).toMatchObject({ verdict: "continue" })
		if (result.verdict === "continue") {
			expect(result.diagnostics.toolCalls).toBe(3)
		}
	})

	it("compares final-answer checks against the exact proposed answer", async () => {
		const result = await evaluate({
			text: '{"verdict":"met","reason":"done","checks":[{"kind":"final_answer","requirement":"exact output","status":"pass","candidateRef":"last_assistant","observedAnswer":"paraphrase of the answer","expectedAnswer":null,"evidence":[]}]}',
			messages: conversationWithAnswer("THE ANSWER"),
		})
		expect(result.verdict).toBe("continue")
		if (result.verdict === "continue") {
			expect(result.reason).toContain("not been checked against the exact proposed answer")
		}
	})

	it("rejects a final answer that differs from the exact expected answer", async () => {
		const result = await evaluate({
			text: '{"verdict":"met","reason":"done","checks":[{"kind":"final_answer","requirement":"exact output","status":"pass","candidateRef":"last_assistant","observedAnswer":"THE ANSWER","expectedAnswer":"THE OTHER ANSWER","evidence":[]}]}',
			messages: conversationWithAnswer("THE ANSWER"),
		})
		expect(result.verdict).toBe("continue")
		if (result.verdict === "continue") {
			expect(result.reason).toContain("requires exactly")
		}
	})

	it("accepts a final-answer check that matches the proposed answer literally", async () => {
		const result = await evaluate({
			text: '{"verdict":"met","reason":"done","checks":[{"kind":"final_answer","requirement":"exact output","status":"pass","candidateRef":"last_assistant","observedAnswer":"THE ANSWER","expectedAnswer":null,"evidence":[]}]}',
			messages: conversationWithAnswer("THE ANSWER"),
		})
		expect(result).toMatchObject({ verdict: "met" })
		if (result.verdict === "met") {
			expect(result.acceptedFinalAnswer).toBe("THE ANSWER")
		}
	})

	it("reports unavailable/agent_unavailable when the spawn seam has no agent system", async () => {
		const result = await evaluate({ deps: { spawn: vi.fn(async () => undefined) } })
		expect(result.verdict).toBe("unavailable")
		if (result.verdict === "unavailable") {
			expect(result.diagnostics.failureType).toBe("agent_unavailable")
		}
	})

	it("reports unavailable/cancelled when the caller aborts before the run", async () => {
		const controller = new AbortController()
		controller.abort()
		const result = await evaluate({ signal: controller.signal })
		expect(result.verdict).toBe("unavailable")
		if (result.verdict === "unavailable") {
			expect(result.diagnostics.failureType).toBe("cancelled")
		}
	})

	it("reports unavailable/cancelled when the caller aborts mid-run", async () => {
		const controller = new AbortController()
		const result = await evaluate({
			deps: {
				spawn: vi.fn(async () => {
					controller.abort()
					return makeRun({ status: "stopped" })
				}),
			},
			signal: controller.signal,
		})
		expect(result.verdict).toBe("unavailable")
		if (result.verdict === "unavailable") {
			expect(result.diagnostics.failureType).toBe("cancelled")
		}
	})

	it("retries transient provider failures with backoff and then succeeds", async () => {
		const spawn = vi
			.fn()
			.mockResolvedValueOnce(makeRun({ status: "error", error: "429 rate limit exceeded" }))
			.mockResolvedValueOnce(makeRun({ text: CITED_CONTINUE }))
		const sleep = vi.fn(async () => {})
		const result = await evaluate({ deps: { spawn, sleep } })
		expect(spawn).toHaveBeenCalledTimes(2)
		expect(sleep).toHaveBeenCalledExactlyOnceWith(5_000, expect.any(AbortSignal))
		expect(result).toMatchObject({ verdict: "continue" })
	})

	it("stops retrying after three transient failures and reports the classified reason", async () => {
		const spawn = vi.fn(async () => makeRun({ status: "error", error: "429 rate limit exceeded" }))
		const sleep = vi.fn(async () => {})
		const result = await evaluate({ deps: { spawn, sleep } })
		expect(spawn).toHaveBeenCalledTimes(4)
		expect(sleep).toHaveBeenCalledTimes(3)
		expect(result.verdict).toBe("unavailable")
		if (result.verdict === "unavailable") {
			expect(result.diagnostics.failureType).toBe("rate_limit")
		}
	})

	it("does not retry non-transient provider failures", async () => {
		const spawn = vi.fn(async () => makeRun({ status: "error", error: "400 bad request payload" }))
		const sleep = vi.fn(async () => {})
		const result = await evaluate({ deps: { spawn, sleep } })
		expect(spawn).toHaveBeenCalledOnce()
		expect(sleep).not.toHaveBeenCalled()
		expect(result.verdict).toBe("unavailable")
		if (result.verdict === "unavailable") {
			expect(result.diagnostics.failureType).toBe("bad_request")
		}
	})

	it("retries transient provider failures during the correction with backoff and then accepts the verdict", async () => {
		const spawn = vi.fn(async () => makeRun({ text: "not json at all" }))
		const resume = vi
			.fn()
			.mockResolvedValueOnce(makeRun({ status: "error", error: "429 rate limit exceeded" }))
			.mockResolvedValueOnce(makeRun({ status: "error", error: "503 service unavailable" }))
			.mockResolvedValueOnce(makeRun({ text: CITED_CONTINUE }))
		const sleep = vi.fn(async () => {})
		const result = await evaluate({ deps: { spawn, resume, sleep } })
		expect(resume).toHaveBeenCalledTimes(3)
		expect(sleep).toHaveBeenCalledWith(5_000, expect.any(AbortSignal))
		expect(sleep).toHaveBeenCalledWith(20_000, expect.any(AbortSignal))
		expect(result).toMatchObject({ verdict: "continue" })
		if (result.verdict === "continue") {
			expect(result.diagnostics.correctionCount).toBe(1)
		}
	})

	it("does not retry a non-transient correction failure and reports the classified reason", async () => {
		const spawn = vi.fn(async () => makeRun({ text: "not json at all" }))
		const resume = vi.fn(async () => makeRun({ status: "error", error: "400 bad request payload" }))
		const sleep = vi.fn(async () => {})
		const result = await evaluate({ deps: { spawn, resume, sleep } })
		expect(resume).toHaveBeenCalledOnce()
		expect(sleep).not.toHaveBeenCalled()
		expect(result.verdict).toBe("unavailable")
		if (result.verdict === "unavailable") {
			expect(result.diagnostics.failureType).toBe("bad_request")
			expect(result.reason).toContain("correction failed")
		}
	})

	it("reports unavailable/timeout without retrying when the optional cap elapses", async () => {
		const spawn = vi.fn(async (_input: FermentV2VerifierSpawnInput) => {
			await new Promise((resolve) => setTimeout(resolve, 30))
			return makeRun({ status: "stopped" })
		})
		const sleep = vi.fn(async () => {})
		const result = await evaluate({
			deps: { spawn, sleep },
			settings: { evaluationTimeoutMs: 5 },
		})
		expect(result.verdict).toBe("unavailable")
		if (result.verdict === "unavailable") {
			expect(result.diagnostics.failureType).toBe("timeout")
			expect(result.diagnostics.timeoutCount).toBe(1)
			expect(result.diagnostics.timeoutMs).toBe(5)
		}
		expect(spawn).toHaveBeenCalledOnce()
		expect(sleep).not.toHaveBeenCalled()
	})

	/** Injected backoff that mirrors the default: resolves early once the run's signal aborts. */
	const abortableSleep = (_ms: number, signal?: AbortSignal) =>
		new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, _ms)
			const onAbort = () => {
				clearTimeout(timer)
				resolve()
			}
			if (signal?.aborted) {
				clearTimeout(timer)
				resolve()
				return
			}
			signal?.addEventListener("abort", onAbort)
		})

	it("reports unavailable/timeout without retrying when the cap elapses during backoff", async () => {
		const spawn = vi.fn(async () => makeRun({ status: "error", error: "429 rate limit exceeded" }))
		// The backoff ends when the 5ms cap fires, so the loop-top check reports
		// the timeout instead of spawning again.
		const sleep = vi.fn(abortableSleep)
		const result = await evaluate({ deps: { spawn, sleep }, settings: { evaluationTimeoutMs: 5 } })
		expect(spawn).toHaveBeenCalledOnce()
		expect(result.verdict).toBe("unavailable")
		if (result.verdict === "unavailable") {
			expect(result.diagnostics.failureType).toBe("timeout")
			expect(result.diagnostics.timeoutCount).toBe(1)
			expect(result.diagnostics.providerRequestCount).toBe(1)
		}
	})

	it("reports unavailable/cancelled when the caller aborts during backoff", async () => {
		const controller = new AbortController()
		const spawn = vi.fn(async () => makeRun({ status: "error", error: "429 rate limit exceeded" }))
		const sleep = vi.fn(async () => {
			controller.abort()
			await new Promise((resolve) => setTimeout(resolve, 5))
		})
		const result = await evaluate({ deps: { spawn, sleep }, signal: controller.signal })
		expect(spawn).toHaveBeenCalledOnce()
		expect(result.verdict).toBe("unavailable")
		if (result.verdict === "unavailable") {
			expect(result.diagnostics.failureType).toBe("cancelled")
		}
	})

	it("does not resume the correction again after the cap elapses during backoff", async () => {
		const spawn = vi.fn(async () => makeRun({ text: "not json at all" }))
		const resume = vi.fn(async () => makeRun({ status: "error", error: "429 rate limit exceeded" }))
		const sleep = vi.fn(abortableSleep)
		const result = await evaluate({ deps: { spawn, resume, sleep }, settings: { evaluationTimeoutMs: 5 } })
		expect(resume).toHaveBeenCalledOnce()
		expect(result.verdict).toBe("unavailable")
		if (result.verdict === "unavailable") {
			expect(result.diagnostics.failureType).toBe("timeout")
			expect(result.diagnostics.correctionCount).toBe(1)
		}
	})

	it("discards a met verdict as unavailable/guard_violation when integrity finds changes", async () => {
		enforceIntegrityMock.mockResolvedValue({
			...noViolation(),
			violated: true,
			restored: ["src/a.ts"],
			postRunSnapshot: "after-snap",
		})
		const result = await evaluate({
			text: MET_ALL_GOOD,
		})
		expect(result.verdict).toBe("unavailable")
		if (result.verdict === "unavailable") {
			expect(result.diagnostics.failureType).toBe("guard_violation")
			expect(result.reason).toContain("src/a.ts")
			expect(result.reason).toContain("after-snap")
			expect(result.integrity?.violated).toBe(true)
		}
	})

	it("keeps a continue verdict but attaches the integrity outcome on violation", async () => {
		enforceIntegrityMock.mockResolvedValue({
			...noViolation(),
			violated: true,
			restored: ["src/a.ts"],
			removed: ["scratch.txt"],
		})
		const result = await evaluate({
			text: '{"verdict":"continue","reason":"Fix the parser","checks":[{"kind":"work","requirement":"ship it","status":"fail","evidence":["e1"]}]}',
		})
		expect(result).toMatchObject({
			verdict: "continue",
			reason: "Remaining requirement: ship it. Failing check: result e1",
		})
		if (result.verdict === "continue") {
			expect(result.integrity?.violated).toBe(true)
			expect(result.integrity?.restored).toEqual(["src/a.ts"])
		}
	})

	it("enforces integrity even when the run is cancelled", async () => {
		const controller = new AbortController()
		const result = await evaluate({
			signal: controller.signal,
			deps: {
				spawn: vi.fn(async () => {
					controller.abort()
					return makeRun({ status: "stopped" })
				}),
			},
		})
		expect(result.verdict).toBe("unavailable")
		expect(enforceIntegrityMock).toHaveBeenCalledOnce()
	})

	it("discards a met verdict when integrity enforcement throws, with a recovery note", async () => {
		enforceIntegrityMock.mockRejectedValue(new Error("restore failed"))
		const result = await evaluate({
			text: MET_ALL_GOOD,
		})
		expect(result.verdict).toBe("unavailable")
		if (result.verdict === "unavailable") {
			expect(result.diagnostics.failureType).toBe("guard_violation")
			expect(result.reason).toContain("could not be enforced")
			expect(result.reason).toContain("restore failed")
			expect(result.reason).toContain("inspect it before continuing")
		}
	})

	it("keeps a continue verdict when integrity enforcement throws", async () => {
		enforceIntegrityMock.mockRejectedValue(new Error("restore failed"))
		const result = await evaluate({ text: CITED_CONTINUE })
		expect(result).toMatchObject({ verdict: "continue" })
	})

	it("discards a met verdict when the post-run snapshot fails, with a recovery note", async () => {
		enforceIntegrityMock.mockResolvedValue({ ...noViolation(), unenforced: true })
		const result = await evaluate({
			text: MET_ALL_GOOD,
		})
		expect(result.verdict).toBe("unavailable")
		if (result.verdict === "unavailable") {
			expect(result.diagnostics.failureType).toBe("guard_violation")
			expect(result.reason).toContain("could not be established after the run")
		}
	})

	it("skips integrity outside git and does not attach it", async () => {
		gitProbeMock.mockResolvedValue("outside_git")
		snapshotMock.mockResolvedValue(undefined)
		const result = await evaluate({
			text: '{"verdict":"met","reason":"ok","checks":[{"kind":"work","method":"command","requirement":"ship it","status":"pass","failureMode":"fm","evidence":["e1"]}]}',
		})
		expect(result).toMatchObject({ verdict: "met" })
		expect(enforceIntegrityMock).not.toHaveBeenCalled()
		if (result.verdict === "met") expect(result.integrity).toBeUndefined()
	})

	it.each([
		{ name: "the workspace git state cannot be determined", probe: "unknown" as const },
		{ name: "a git workspace cannot be snapshotted before the run", probe: "git" as const },
	])("runs the verifier with integrity unenforced when $name", async ({ probe }) => {
		gitProbeMock.mockResolvedValue(probe)
		snapshotMock.mockResolvedValue(undefined)
		const spawn = spawnFn(async () => makeRun({ text: MET_ALL_GOOD }))
		const result = await evaluate({
			baseline: { commit: "base-1", capturedAt: "2026-01-01T00:00:00.000Z" },
			deps: { spawn },
		})
		expect(spawn).toHaveBeenCalledOnce()
		expect(result).toMatchObject({ verdict: "met", integrity: { unenforced: true, violated: false } })
		expect(enforceIntegrityMock).not.toHaveBeenCalled()
		// Without a snapshot there are no facts to diff and no worktree to reserve.
		expect(gatherWorkspaceFactsMock).not.toHaveBeenCalled()
		expect(reserveWorktreeMock).not.toHaveBeenCalled()
		const prompt = spawn.mock.calls[0]?.[0].prompt ?? ""
		expect(prompt).toContain("Integrity guard: unavailable for this run")
		expect(prompt).toContain("Working tree facts (host-gathered):\n(unavailable for this run")
	})

	it("runs the verifier without HEAD-move detection when HEAD cannot be resolved", async () => {
		headMock.mockResolvedValue(undefined)
		const spawn = spawnFn()
		const result = await evaluate({ deps: { spawn } })
		expect(spawn).toHaveBeenCalledOnce()
		expect(result).toMatchObject({ verdict: "continue" })
		expect(enforceIntegrityMock).toHaveBeenCalledWith(
			"/workspace",
			{ commit: "snap", tree: "tree" },
			undefined,
			undefined,
		)
	})

	it("reports the guard's accumulated usage even when compaction discarded the session messages", async () => {
		// Compaction replaced the session's messages: nothing can be folded from
		// them — the guard's per-message accumulation is the only source.
		const usage: FermentV2EvaluatorUsage = {
			input: 20,
			output: 10,
			cacheRead: 4,
			cacheWrite: 2,
			totalTokens: 36,
			costUsd: 0.66,
		}
		const resume = vi.fn(async () =>
			makeRun({
				text: '{"verdict":"continue","reason":"now cited","checks":[{"kind":"work","requirement":"ship it","status":"fail","evidence":["e1"]}]}',
				session: fakeSession([]),
			}),
		)
		const result = await evaluate({
			text: "not json",
			deps: {
				spawn: vi.fn(async () => makeRun({ text: "not json", session: fakeSession([]) })),
				resume,
				createGuard: vi.fn(() => guardWithEvidence(["e1"], usage)),
			},
		})
		expect(result).toMatchObject({ verdict: "continue" })
		if (result.verdict === "continue") {
			expect(result.usage).toEqual(usage)
		}
	})

	it("counts usage from the guard's accumulation, not the session messages", async () => {
		const guardUsage: FermentV2EvaluatorUsage = {
			input: 20,
			output: 10,
			cacheRead: 4,
			cacheWrite: 2,
			totalTokens: 36,
			costUsd: 0.66,
		}
		const result = await evaluate({
			deps: {
				spawn: vi.fn(async () => makeRun({ session: fakeSession([rawUsage]) })),
				createGuard: vi.fn(() => guardWithEvidence(["e1"], guardUsage)),
			},
		})
		expect(result).toMatchObject({ verdict: "continue" })
		if (result.verdict === "continue") {
			expect(result.usage).toEqual(guardUsage)
		}
	})

	it("reports the guard's accumulated usage on unavailable results after the run", async () => {
		const usage: FermentV2EvaluatorUsage = {
			input: 10,
			output: 5,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 18,
			costUsd: 0.33,
		}
		const result = await evaluate({
			deps: {
				spawn: vi.fn(async () => makeRun({ status: "error", error: "400 bad request payload" })),
				createGuard: vi.fn(() => guardWithEvidence(["e1"], usage)),
			},
		})
		expect(result.verdict).toBe("unavailable")
		if (result.verdict === "unavailable") {
			expect(result.usage).toEqual(usage)
		}
	})

	it("resolves the configured verifier model that is not the implementer", async () => {
		const spawn = spawnFn()
		const result = await evaluate({ deps: { spawn } })
		expect(spawn.mock.calls[0]?.[0].model).toBe(verifierModel)
		expect(result).toMatchObject({ verdict: "continue", model: "judge/independent" })
	})

	it("passes the objective, facts, guard extension and unlimited limits to the verifier prompt", async () => {
		gatherWorkspaceFactsMock.mockResolvedValue(
			workspaceFactsWithFlags([], { changedFiles: [{ status: "M", path: "src/feature.ts" }] }),
		)
		const spawn = spawnFn()
		await evaluate({ deps: { spawn } })
		const input = spawn.mock.calls[0]?.[0]
		expect(input?.prompt).toContain("ship it")
		expect(input?.prompt).toContain("src/feature.ts")
		expect(input?.cwd).toBe("/workspace")
		expect(input?.extensionFactories).toHaveLength(3)
		expect(input?.maxDuration).toBe(0)
	})

	it("spawns the verifier with PII redaction and permissions injected before the guard", async () => {
		const spawn = spawnFn()
		const guardExtension = () => {}
		const guard: VerifierGuard = {
			extension: guardExtension,
			evidence: new Map([["e1", { id: "e1", toolName: "bash", input: {}, isError: false, excerpt: "result e1" }]]),
			createdFiles: new Set<string>(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
		}
		await evaluate({ deps: { spawn, createGuard: () => guard } })
		const input = spawn.mock.calls[0]?.[0]
		// The persona disables extensions, so redaction and permissions ride
		// along as inline factories — redaction before the guard, so the stamped
		// content and the evidence excerpts recorded for verdict reasons are
		// already redacted; permissions (with the verifier's write pre-approval)
		// gate verifier tool calls by the session mode.
		expect(input?.extensionFactories).toHaveLength(3)
		expect(input?.extensionFactories?.[0]).toBe(piiRedactionExtension)
		expect(typeof input?.extensionFactories?.[1]).toBe("function")
		expect(input?.extensionFactories?.[1]).not.toBe(permissionsExtension)
		expect(input?.extensionFactories?.[2]).toBe(guardExtension)
	})

	it("spawns the verifier at the configured thinking level, low by default", async () => {
		const spawn = spawnFn()
		await evaluate({ deps: { spawn } })
		expect(spawn.mock.calls[0]?.[0].thinkingLevel).toBe("low")
		const maxSpawn = spawnFn()
		await evaluate({ deps: { spawn: maxSpawn }, settings: { verifierThinking: "max" } })
		expect(maxSpawn.mock.calls[0]?.[0].thinkingLevel).toBe("max")
	})

	it("reports the timeout cap as the wall-clock limit when configured", async () => {
		const spawn = spawnFn()
		await evaluate({ deps: { spawn }, settings: { evaluationTimeoutMs: 45_000 } })
		expect(spawn.mock.calls[0]?.[0].maxDuration).toBe(45)
	})

	it("resolves no model to unavailable/no_model", async () => {
		const result = await evaluate({
			ctx: { ...evaluatorContext(), model: undefined },
			settings: { evaluatorModels: ["missing/one"] },
		})
		expect(result.verdict).toBe("unavailable")
		if (result.verdict === "unavailable") {
			expect(result.diagnostics.failureType).toBe("no_model")
		}
	})

	it("reports the timeout cap in diagnostics when configured", async () => {
		const result = await evaluate({ settings: { evaluationTimeoutMs: 45_000 } })
		expect(result).toMatchObject({ verdict: "continue" })
		if (result.verdict === "continue") expect(result.diagnostics.timeoutMs).toBe(45_000)
	})

	it("reports unavailable/redaction_failed when prompt redaction fails", async () => {
		process.env.KIMCHI_REDACTION_ENABLED = "true"
		resetRedactionConfigCache()
		const result = await evaluate({
			deps: {
				redact: vi.fn(async () => {
					throw new Error("redaction engine failed")
				}),
			},
		})
		expect(result.verdict).toBe("unavailable")
		if (result.verdict === "unavailable") {
			expect(result.diagnostics.failureType).toBe("redaction_failed")
		}
	})
})

describe("parseFermentV2EvaluatorOutput", () => {
	it("parses the verifier output contract", () => {
		const parsed = parseFermentV2EvaluatorOutput(
			'{"verdict":"continue","reason":"Fix the parser","checks":[{"kind":"work","requirement":"parser handles empty input","status":"fail","failureMode":"crashes on empty","evidence":["e3"]}]}',
		)
		expect(parsed).toMatchObject({
			verdict: "continue",
			reason: "Fix the parser",
			checks: [
				{
					requirement: "parser handles empty input",
					status: "fail",
					evidence: ["e3"],
				},
			],
		})
	})

	it("normalizes bracketed evidence ids", () => {
		const parsed = parseFermentV2EvaluatorOutput(
			'{"verdict":"met","reason":"done","checks":[{"kind":"work","requirement":"r","status":"pass","failureMode":"fm","evidence":["[E12]"]}]}',
		)
		expect(parsed?.checks?.[0]?.evidence).toEqual(["e12"])
	})

	it("rejects unknown check statuses", () => {
		expect(
			parseFermentV2EvaluatorOutput(
				'{"verdict":"met","reason":"done","checks":[{"kind":"work","requirement":"r","status":"maybe"}]}',
			),
		).toBeUndefined()
	})

	it("rejects missing reasons", () => {
		expect(parseFermentV2EvaluatorOutput('{"verdict":"met","reason":"  "}')).toBeUndefined()
	})

	it("keeps verdicts without checks", () => {
		expect(parseFermentV2EvaluatorOutput('{"verdict":"impossible","reason":"blocked upstream"}')).toMatchObject({
			verdict: "impossible",
			reason: "blocked upstream",
		})
	})

	it("finds the verdict object inside surrounding prose", () => {
		expect(parseFermentV2EvaluatorOutput('thinking… {"verdict":"met","reason":"done"} …tail')).toMatchObject({
			verdict: "met",
		})
	})
})
