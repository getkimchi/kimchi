import type { Api, Model } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import {
	runSolverStage,
	runTextSolverStage,
	SOLVER_PROMPT_VERSION,
	SOLVER_RESULT_SCHEMA,
	SOLVER_SCHEMA_VERSION,
	SOLVER_SYSTEM_PROMPT,
	solverContext,
	solverSystemPrompt,
	TEXT_SOLVER_PROMPT_VERSION,
	TEXT_SOLVER_RESULT_SCHEMA,
	TEXT_SOLVER_SCHEMA_VERSION,
	TEXT_SOLVER_SYSTEM_PROMPT,
	textSolverContext,
	textSolverSystemPrompt,
} from "./panel.js"
import { CANDIDATE_PATCH_SCHEMA, CandidatePatchSchema } from "./patch.js"
import { COUNCIL_ANSWER_SCHEMA, CouncilAnswerSchema } from "./schemas.js"
import { stageTestHarness } from "./stage-test-harness.js"

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
