import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai"
import { afterEach, describe, expect, it } from "vitest"
import { ChangeTransaction } from "../../agent-patch/index.js"
import { fixture, transactionRuntime } from "./coordinator-transaction-fixtures.js"
import { CANDIDATE_PATCH_SCHEMA, CandidatePatchSchema, stagePatch } from "./patch.js"
import type { PhysicalInvocationResult } from "./physical-invoker.js"
import type { CouncilRunContext } from "./run-context.js"
import { CouncilSessionCache } from "./run-context.js"
import {
	COUNCIL_ANSWER_SCHEMA,
	CombinedFusionSchema,
	CouncilAnswerSchema,
	parseFusionAnalysisArtifact,
} from "./schemas.js"
import { type CouncilStageRuntime, RepairBudget, type StructuredStagePrepareContext } from "./stage-runner.js"
import {
	ANALYST_PROMPT_VERSION,
	ANALYST_SCHEMA_VERSION,
	type AnalystInput,
	analystPacket,
	anonymizeCouncilAnswers,
	COMBINED_RESULT_SCHEMA,
	fusionAnalystSystemPrompt,
	runCombinedStage,
	runSolverStage,
	runSynthesisStage,
	runTextAnalystStage,
	runTextSolverStage,
	runTextSynthesisStage,
	SOLVER_PROMPT_VERSION,
	SOLVER_RESULT_SCHEMA,
	SOLVER_SCHEMA_VERSION,
	SOLVER_SYSTEM_PROMPT,
	SYNTHESIS_PROMPT_VERSION,
	SYNTHESIS_RESULT_SCHEMA,
	SYNTHESIS_SCHEMA_VERSION,
	solverContext,
	solverSystemPrompt,
	synthesisContext,
	synthesisSystemPrompt,
	TEXT_ANALYST_PROMPT_VERSION,
	TEXT_ANALYST_SCHEMA_VERSION,
	TEXT_SOLVER_PROMPT_VERSION,
	TEXT_SOLVER_RESULT_SCHEMA,
	TEXT_SOLVER_SCHEMA_VERSION,
	TEXT_SOLVER_SYSTEM_PROMPT,
	TEXT_SYNTHESIS_PROMPT_VERSION,
	TEXT_SYNTHESIS_RESULT_SCHEMA,
	TEXT_SYNTHESIS_SCHEMA_VERSION,
	textAnalystPacket,
	textAnalystSystemPrompt,
	textSolverContext,
	textSolverSystemPrompt,
	textSynthesisContext,
	textSynthesisSystemPrompt,
} from "./stages.js"

function stageMessage(text: string, modelRef: string): AssistantMessage {
	const [provider, model] = modelRef.split("/")
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: provider ?? "physical",
		model: model ?? "primary",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	}
}

interface StageInvocationCall {
	stage: string
	pool: { primary: string; fallbacks: string[] }
	context: Context
	prepareContext?: StructuredStagePrepareContext
}

interface StageTestHarness {
	rt: CouncilStageRuntime
	physicalCalls: StageInvocationCall[]
	repairCalls: Array<{ stage: string; context: Context }>
}

function stageTestHarness(physicalOutputs: string[], repairOutputs: string[] = []): StageTestHarness {
	const physicalCalls: StageInvocationCall[] = []
	const repairCalls: Array<{ stage: string; context: Context }> = []
	const rt: CouncilStageRuntime = {
		run: { throwIfAborted() {} } as unknown as CouncilRunContext,
		cache: new CouncilSessionCache(),
		repairBudget: new RepairBudget(),
		maxStructuredBytes: 1_000_000,
		invoke: async (stage, _pool, context) => {
			repairCalls.push({ stage, context })
			return stageMessage(repairOutputs.shift() ?? "{}", "physical/repair")
		},
		invokePhysical: async (stage, pool, context, _maxTokens, _timeoutMs, prepareContext) => {
			physicalCalls.push({ stage, pool, context, prepareContext })
			return {
				message: stageMessage(physicalOutputs.shift() ?? "{}", pool.primary),
				model: {} as Model<Api>,
				modelRef: pool.primary,
				attempts: 1,
			} satisfies PhysicalInvocationResult
		},
		structuredText: (_stage, result) =>
			result.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join(""),
		markStageError() {},
		startStage() {},
		completeStage() {},
		failStage() {},
		rethrowTerminalFailure() {},
		pushStage() {},
	}
	return { rt, physicalCalls, repairCalls }
}

describe("Council panel contract", () => {
	it("builds a solver prompt and round-trips a complete candidate patch", () => {
		const patch = { operations: [{ op: "create", path: "answer.txt", content: "done\n" }] }
		const prompt = solverSystemPrompt()

		expect(prompt).toContain(SOLVER_RESULT_SCHEMA)
		expect(prompt).toContain(CANDIDATE_PATCH_SCHEMA)
		expect(prompt).not.toMatch(/other models|review|critique/i)
		expect(CandidatePatchSchema.parse(patch)).toEqual(patch)
		expect(solverContext({ objective: "write it", constraints: [], frozenContext: { files: [] } })).toMatchObject({
			systemPrompt: SOLVER_SYSTEM_PROMPT,
		})
		expect(SOLVER_PROMPT_VERSION).toBe("solver-patch-v2")
		expect(SOLVER_SCHEMA_VERSION).toBe("candidate-patch-v2")
	})

	it("runs a solver through structured execution and returns a stageable patch", async () => {
		const harness = stageTestHarness(['{"operations":[{"op":"create","path":"answer.txt","content":"done\\n"}]}'])
		const outcome = await runSolverStage(harness.rt, {
			input: { objective: "write it", constraints: [], frozenContext: { files: [] } },
			pool: { primary: "physical/solver", fallbacks: [] },
			maxTokens: 256,
			repairMaxTokens: 128,
			deadline: Date.now() + 10_000,
			cacheKeyFor: (modelRef) => ({
				patchHash: "patch",
				baseSnapshotHash: "base",
				objectiveHash: "objective",
				constraintsHash: "constraints",
				evidenceHash: "evidence",
				role: "stale-role",
				modelId: modelRef,
				promptVersion: "stale-prompt",
				schemaVersion: "stale-schema",
			}),
		})

		expect(outcome?.value.operations).toEqual([{ op: "create", path: "answer.txt", content: "done\n" }])
		expect(harness.physicalCalls[0]?.stage).toBe("solver")
		const prepared = harness.physicalCalls[0]?.prepareContext?.({} as Model<Api>, 256, 10_000)
		expect(prepared?.context.systemPrompt).toBe(SOLVER_SYSTEM_PROMPT)
		expect(prepared?.context.messages[0]?.content).toContain('"objective":"write it"')
	})

	it("repairs malformed output once and fails when the repair is malformed", async () => {
		const harness = stageTestHarness(["not json"], ["still not json"])
		await expect(
			runSolverStage(harness.rt, {
				input: { objective: "write it", constraints: [], frozenContext: {} },
				pool: { primary: "physical/solver", fallbacks: [] },
				maxTokens: 256,
				repairMaxTokens: 128,
				deadline: Date.now() + 10_000,
				cacheKeyFor: (modelRef) => ({
					patchHash: "patch",
					baseSnapshotHash: "base",
					objectiveHash: "objective",
					constraintsHash: "constraints",
					evidenceHash: "evidence",
					role: "solver",
					modelId: modelRef,
					promptVersion: "prompt",
					schemaVersion: "schema",
				}),
			}),
		).rejects.toThrow()
		expect(harness.repairCalls).toHaveLength(1)
	})
})

const cacheKeyFor = (modelRef: string) => ({
	patchHash: "patch",
	baseSnapshotHash: "base",
	objectiveHash: "objective",
	constraintsHash: "constraints",
	evidenceHash: "evidence",
	role: "solver",
	modelId: modelRef,
	promptVersion: "prompt",
	schemaVersion: "schema",
})

describe("Council text-panel contract", () => {
	it("builds a text-solver prompt and round-trips a complete answer", () => {
		const answer = { answer: "The recommended approach is X because it satisfies the objective." }
		const prompt = textSolverSystemPrompt()

		expect(prompt).toBe(TEXT_SOLVER_SYSTEM_PROMPT)
		expect(prompt).toContain(TEXT_SOLVER_RESULT_SCHEMA)
		expect(prompt).toContain(COUNCIL_ANSWER_SCHEMA)
		expect(prompt).not.toMatch(/other models|review|critique/i)
		expect(CouncilAnswerSchema.parse(answer)).toEqual(answer)
		expect(textSolverContext({ objective: "answer it", constraints: [], frozenContext: { files: [] } })).toMatchObject({
			systemPrompt: TEXT_SOLVER_SYSTEM_PROMPT,
		})
		expect(TEXT_SOLVER_PROMPT_VERSION).toBe("solver-answer-v1")
		expect(TEXT_SOLVER_SCHEMA_VERSION).toBe("council-answer-v1")
		// The text-panel schema/prompt versions are new constants distinct from the code path's, so
		// no code-path cache entry can ever be read back as a text-panel result or vice versa.
		expect(TEXT_SOLVER_PROMPT_VERSION).not.toBe(SOLVER_PROMPT_VERSION)
		expect(TEXT_SOLVER_SCHEMA_VERSION).not.toBe(SOLVER_SCHEMA_VERSION)
	})

	it("runs a text solver through structured execution and returns a standalone answer", async () => {
		const harness = stageTestHarness(['{"answer":"The recommended approach is X."}'])
		const outcome = await runTextSolverStage(harness.rt, {
			input: { objective: "answer it", constraints: [], frozenContext: { files: [] } },
			pool: { primary: "physical/solver", fallbacks: [] },
			maxTokens: 256,
			repairMaxTokens: 128,
			deadline: Date.now() + 10_000,
			cacheKeyFor,
		})

		expect(outcome?.value).toEqual({ answer: "The recommended approach is X." })
		expect(harness.physicalCalls[0]?.stage).toBe("solver")
		const prepared = harness.physicalCalls[0]?.prepareContext?.({} as Model<Api>, 256, 10_000)
		expect(prepared?.context.systemPrompt).toBe(TEXT_SOLVER_SYSTEM_PROMPT)
		expect(prepared?.context.messages[0]?.content).toContain('"objective":"answer it"')
	})

	it("repairs malformed output once and fails when the repair is malformed", async () => {
		const harness = stageTestHarness(["not json"], ["still not json"])
		await expect(
			runTextSolverStage(harness.rt, {
				input: { objective: "answer it", constraints: [], frozenContext: {} },
				pool: { primary: "physical/solver", fallbacks: [] },
				maxTokens: 256,
				repairMaxTokens: 128,
				deadline: Date.now() + 10_000,
				cacheKeyFor,
			}),
		).rejects.toThrow()
		expect(harness.repairCalls).toHaveLength(1)
	})

	it("rejects an empty answer", async () => {
		const harness = stageTestHarness(['{"answer":""}'], ['{"answer":""}'])
		await expect(
			runTextSolverStage(harness.rt, {
				input: { objective: "answer it", constraints: [], frozenContext: {} },
				pool: { primary: "physical/solver", fallbacks: [] },
				maxTokens: 256,
				repairMaxTokens: 128,
				deadline: Date.now() + 10_000,
				cacheKeyFor,
			}),
		).rejects.toThrow()
	})
})

describe("fusion analyst", () => {
	it("round-trips the six comparison buckets and catalog checks", () => {
		const value = parseFusionAnalysisArtifact(
			JSON.stringify({
				consensus: ["shared"],
				contradictions: [],
				partial_coverage: ["partial"],
				unique_insights: ["unique"],
				blind_spots: ["blind"],
				required_checks: ["package.test"],
			}),
			["package.test"],
		)
		expect(value.required_checks).toEqual(["package.test"])
		expect(fusionAnalystSystemPrompt()).toContain("validation_catalog")
	})

	it("renders every candidate diff into the analyst packet", async () => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		const transaction = runtime.ensure()
		const input: AnalystInput = {
			objective: "update the file",
			constraints: [],
			candidates: [
				{ operations: [{ op: "update", path: "file.txt", content: "first\n" }] },
				{ operations: [{ op: "update", path: "file.txt", content: "second\n" }] },
			],
			transaction,
			shuffleSeed: "fixed",
			validationCatalog: [],
		}
		const packet = await analystPacket(input)
		expect(packet.solutions).toHaveLength(2)
		expect(packet.solutions.every(({ diff }) => diff.includes("file.txt"))).toBe(true)
	})
})

describe("text-fusion analyst", () => {
	it("anonymizes and hash-seeded-shuffles answers under contiguous Solution A/B/C labels", () => {
		const answers = ["first answer", "second answer", "third answer"]
		const anonymized = anonymizeCouncilAnswers(answers, "fixed-seed")
		expect(anonymized.map(({ label }) => label)).toEqual(["Solution A", "Solution B", "Solution C"])
		expect(anonymized.map(({ text }) => text).sort()).toEqual([...answers].sort())
		// Same inputs, same seed: the shuffle is deterministic, not merely stable-sorted.
		expect(anonymizeCouncilAnswers(answers, "fixed-seed")).toEqual(anonymized)
	})

	it("builds a text-analyst packet with no diffs and no validation catalog", () => {
		const packet = textAnalystPacket({
			objective: "recommend a caching strategy",
			constraints: [],
			answers: ["answer one", "answer two"],
			shuffleSeed: "fixed",
		})
		expect(packet.solutions).toHaveLength(2)
		expect(JSON.stringify(packet)).not.toContain("diff")
		expect(JSON.stringify(packet)).not.toContain("validation_catalog")
	})

	it("never mentions required_checks or validation in its own system prompt", () => {
		const prompt = textAnalystSystemPrompt()
		expect(prompt).not.toMatch(/required_checks|validation_catalog|catalog/i)
		expect(prompt).toMatch(/consensus|contradictions|unique insights/i)
		// The prompt/schema versions are new, distinct constants, so no code-path analyst cache
		// entry can ever be read back on the text path or vice versa.
		expect(TEXT_ANALYST_PROMPT_VERSION).not.toBe(ANALYST_PROMPT_VERSION)
		expect(TEXT_ANALYST_SCHEMA_VERSION).not.toBe(ANALYST_SCHEMA_VERSION)
	})

	it("keeps the FusionAnalysisSchema shape but always drops required_checks, even when a model supplies one", async () => {
		const harness = stageTestHarness([
			JSON.stringify({
				consensus: ["shared"],
				contradictions: [],
				partial_coverage: [],
				unique_insights: [],
				blind_spots: [],
				required_checks: ["package.test"],
			}),
		])
		const outcome = await runTextAnalystStage(harness.rt, {
			input: {
				objective: "recommend a caching strategy",
				constraints: [],
				answers: ["answer one", "answer two"],
				shuffleSeed: "fixed",
			},
			pool: { primary: "physical/analyst", fallbacks: [] },
			maxTokens: 256,
			repairMaxTokens: 128,
			deadline: Date.now() + 10_000,
			cacheKeyFor: (modelRef) => ({
				patchHash: "patch",
				baseSnapshotHash: "base",
				objectiveHash: "objective",
				constraintsHash: "constraints",
				evidenceHash: "evidence",
				role: "analyst",
				modelId: modelRef,
				promptVersion: "prompt",
				schemaVersion: "schema",
			}),
		})

		expect(outcome?.value.consensus).toEqual(["shared"])
		expect(outcome?.value.required_checks).toEqual([])
		expect(harness.physicalCalls[0]?.stage).toBe("analyst")
	})
})

const synthesisRoots: string[] = []

function synthesisFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "council-synthesis-"))
	synthesisRoots.push(root)
	writeFileSync(join(root, "answer.txt"), "base\n")
	return root
}

const analysis = {
	consensus: ["Keep the answer path"],
	contradictions: ["One solution replaces the format"],
	partial_coverage: [],
	unique_insights: ["Preserve the newline"],
	blind_spots: [],
	required_checks: [],
}

const synthesisPatch = {
	operations: [{ op: "update" as const, path: "answer.txt", content: "done\n" }],
}

const summary = "Updated answer.txt to satisfy the objective."

function requestCacheKey(modelRef: string) {
	return {
		patchHash: "patch",
		baseSnapshotHash: "base",
		objectiveHash: "objective",
		constraintsHash: "constraints",
		evidenceHash: "evidence",
		role: "stale-role",
		modelId: modelRef,
		promptVersion: "stale-prompt",
		schemaVersion: "stale-schema",
	}
}

afterEach(() => {
	for (const root of synthesisRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("synthesis contract", () => {
	it("round-trips the final-patch and fast combined schemas", () => {
		expect(CandidatePatchSchema.parse(synthesisPatch)).toEqual(synthesisPatch)
		expect(synthesisSystemPrompt()).toContain(SYNTHESIS_RESULT_SCHEMA)
		expect(synthesisSystemPrompt()).toContain(CANDIDATE_PATCH_SCHEMA)
		expect(synthesisSystemPrompt()).toMatch(/consensus|contradictions|unique insights|coherent/i)
		expect(COMBINED_RESULT_SCHEMA).toContain(CANDIDATE_PATCH_SCHEMA)
		expect(CombinedFusionSchema.parse({ analysis, summary, patch: synthesisPatch })).toEqual({
			analysis,
			summary,
			patch: synthesisPatch,
		})
	})

	it("writes a lead-pool patch and summary that can be staged", async () => {
		const harness = stageTestHarness([JSON.stringify({ summary, patch: synthesisPatch })])
		const outcome = await runSynthesisStage(harness.rt, {
			input: { objective: "write an answer", constraints: [], analysis, candidates: [synthesisPatch] },
			leadPool: { primary: "physical/lead", fallbacks: ["physical/fallback"] },
			maxTokens: 256,
			repairMaxTokens: 128,
			deadline: Date.now() + 10_000,
			cacheKeyFor: requestCacheKey,
		})

		expect(outcome?.value).toEqual({ summary, patch: synthesisPatch })
		expect(harness.physicalCalls[0]?.stage).toBe("synthesis")
		expect(harness.physicalCalls[0]?.pool.primary).toBe("physical/lead")
		const prepared = harness.physicalCalls[0]?.prepareContext?.({} as Model<Api>, 256, 10_000)
		expect(prepared?.context.systemPrompt).toBe(
			synthesisContext({ objective: "write an answer", constraints: [], analysis, candidates: [synthesisPatch] })
				.systemPrompt,
		)

		const root = synthesisFixture()
		const staged = await stagePatch(new ChangeTransaction(root), outcome?.value.patch)
		expect(staged.ok).toBe(true)
	})

	it("accepts a synthesis result with no summary field and stages the patch", async () => {
		const harness = stageTestHarness([JSON.stringify({ patch: synthesisPatch })])
		const outcome = await runSynthesisStage(harness.rt, {
			input: { objective: "write an answer", constraints: [], analysis, candidates: [synthesisPatch] },
			leadPool: { primary: "physical/lead", fallbacks: [] },
			maxTokens: 256,
			repairMaxTokens: 128,
			deadline: Date.now() + 10_000,
			cacheKeyFor: requestCacheKey,
		})

		expect(outcome?.value.summary).toBeUndefined()
		expect(outcome?.value.patch).toEqual(synthesisPatch)

		const root = synthesisFixture()
		const staged = await stagePatch(new ChangeTransaction(root), outcome?.value.patch)
		expect(staged.ok).toBe(true)
	})

	it("accepts a synthesis result with an empty-string summary and stages the patch", async () => {
		const harness = stageTestHarness([JSON.stringify({ summary: "", patch: synthesisPatch })])
		const outcome = await runSynthesisStage(harness.rt, {
			input: { objective: "write an answer", constraints: [], analysis, candidates: [synthesisPatch] },
			leadPool: { primary: "physical/lead", fallbacks: [] },
			maxTokens: 256,
			repairMaxTokens: 128,
			deadline: Date.now() + 10_000,
			cacheKeyFor: requestCacheKey,
		})

		expect(outcome?.value.summary).toBeUndefined()
		expect(outcome?.value.patch).toEqual(synthesisPatch)
	})

	it("repairs malformed synthesis output once and fails when the repair is malformed", async () => {
		const harness = stageTestHarness(["not json"], ["still not json"])
		await expect(
			runSynthesisStage(harness.rt, {
				input: { objective: "write an answer", constraints: [], analysis, candidates: [synthesisPatch] },
				leadPool: { primary: "physical/lead", fallbacks: [] },
				maxTokens: 256,
				repairMaxTokens: 128,
				deadline: Date.now() + 10_000,
				cacheKeyFor: requestCacheKey,
			}),
		).rejects.toThrow()
		expect(harness.repairCalls).toHaveLength(1)
	})
})

describe("combined fast stage", () => {
	it("returns comparison, summary, and final patch in one lead-pool call", async () => {
		const root = synthesisFixture()
		const transaction = new ChangeTransaction(root)
		const combined = { analysis, summary, patch: synthesisPatch }
		const harness = stageTestHarness([JSON.stringify(combined)])
		const outcome = await runCombinedStage(harness.rt, {
			input: {
				objective: "write an answer",
				constraints: [],
				candidates: [synthesisPatch],
				transaction,
				shuffleSeed: "fast",
				validationCatalog: [],
			},
			leadPool: { primary: "physical/lead", fallbacks: [] },
			maxTokens: 512,
			repairMaxTokens: 128,
			deadline: Date.now() + 10_000,
			cacheKeyFor: requestCacheKey,
		})

		expect(outcome?.value).toEqual(combined)
		expect(harness.physicalCalls).toHaveLength(1)
		expect(harness.physicalCalls[0]?.stage).toBe("combined")
		expect(harness.physicalCalls[0]?.pool.primary).toBe("physical/lead")
		const prepared = harness.physicalCalls[0]?.prepareContext?.({} as Model<Api>, 512, 10_000)
		expect(prepared?.context.systemPrompt).toContain(COMBINED_RESULT_SCHEMA)
		expect(prepared?.context.messages[0]?.content).toContain('"candidate_patches"')
	})

	it("accepts a combined result with no summary field and stages the patch", async () => {
		const root = synthesisFixture()
		const transaction = new ChangeTransaction(root)
		const harness = stageTestHarness([JSON.stringify({ analysis, patch: synthesisPatch })])
		const outcome = await runCombinedStage(harness.rt, {
			input: {
				objective: "write an answer",
				constraints: [],
				candidates: [synthesisPatch],
				transaction,
				shuffleSeed: "fast",
				validationCatalog: [],
			},
			leadPool: { primary: "physical/lead", fallbacks: [] },
			maxTokens: 512,
			repairMaxTokens: 128,
			deadline: Date.now() + 10_000,
			cacheKeyFor: requestCacheKey,
		})

		expect(outcome?.value.summary).toBeUndefined()
		expect(outcome?.value.patch).toEqual(synthesisPatch)

		const staged = await stagePatch(transaction, outcome?.value.patch)
		expect(staged.ok).toBe(true)
	})
})

const textAnalysis = {
	consensus: ["Both answers recommend the write-through cache"],
	contradictions: ["One answer suggests a shorter TTL"],
	partial_coverage: [],
	unique_insights: ["Consider cache stampede protection"],
	blind_spots: [],
	required_checks: [],
}

describe("text-fusion synthesis", () => {
	it("round-trips the text-synthesis schema and its own prompt/schema versions", () => {
		const answer = { answer: "Use a write-through cache with a short TTL and stampede protection." }
		expect(CouncilAnswerSchema.parse(answer)).toEqual(answer)
		expect(textSynthesisSystemPrompt()).toContain(TEXT_SYNTHESIS_RESULT_SCHEMA)
		expect(textSynthesisSystemPrompt()).toContain(COUNCIL_ANSWER_SCHEMA)
		expect(textSynthesisSystemPrompt()).toMatch(/consensus|contradictions|unique insights|coherent/i)
		expect(TEXT_SYNTHESIS_PROMPT_VERSION).not.toBe(SYNTHESIS_PROMPT_VERSION)
		expect(TEXT_SYNTHESIS_SCHEMA_VERSION).not.toBe(SYNTHESIS_SCHEMA_VERSION)
	})

	it("writes a lead-pool answer from the analysis and candidate answers", async () => {
		const harness = stageTestHarness([JSON.stringify({ answer: "Use a write-through cache with a short TTL." })])
		const outcome = await runTextSynthesisStage(harness.rt, {
			input: {
				objective: "recommend a caching strategy",
				constraints: [],
				analysis: textAnalysis,
				answers: ["answer one", "answer two"],
			},
			leadPool: { primary: "physical/lead", fallbacks: ["physical/fallback"] },
			maxTokens: 256,
			repairMaxTokens: 128,
			deadline: Date.now() + 10_000,
			cacheKeyFor: requestCacheKey,
		})

		expect(outcome?.value).toEqual({ answer: "Use a write-through cache with a short TTL." })
		expect(harness.physicalCalls[0]?.stage).toBe("synthesis")
		expect(harness.physicalCalls[0]?.pool.primary).toBe("physical/lead")
		const prepared = harness.physicalCalls[0]?.prepareContext?.({} as Model<Api>, 256, 10_000)
		expect(prepared?.context.systemPrompt).toBe(
			textSynthesisContext({
				objective: "recommend a caching strategy",
				constraints: [],
				analysis: textAnalysis,
				answers: ["answer one", "answer two"],
			}).systemPrompt,
		)
	})

	it("repairs malformed output once and fails when the repair is malformed", async () => {
		const harness = stageTestHarness(["not json"], ["still not json"])
		await expect(
			runTextSynthesisStage(harness.rt, {
				input: { objective: "recommend a caching strategy", constraints: [], analysis: textAnalysis, answers: ["a"] },
				leadPool: { primary: "physical/lead", fallbacks: [] },
				maxTokens: 256,
				repairMaxTokens: 128,
				deadline: Date.now() + 10_000,
				cacheKeyFor: requestCacheKey,
			}),
		).rejects.toThrow()
		expect(harness.repairCalls).toHaveLength(1)
	})
})
