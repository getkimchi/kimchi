import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import { afterEach, describe, expect, it } from "vitest"
import { ChangeTransaction } from "../../agent-patch/index.js"
import { CANDIDATE_PATCH_SCHEMA, CandidatePatchSchema, stagePatch } from "./patch.js"
import { COUNCIL_ANSWER_SCHEMA, CombinedFusionSchema, CouncilAnswerSchema } from "./schemas.js"
import { stageTestHarness } from "./stage-test-harness.js"
import {
	COMBINED_RESULT_SCHEMA,
	runCombinedStage,
	runSynthesisStage,
	runTextSynthesisStage,
	SYNTHESIS_PROMPT_VERSION,
	SYNTHESIS_RESULT_SCHEMA,
	SYNTHESIS_SCHEMA_VERSION,
	synthesisContext,
	synthesisSystemPrompt,
	TEXT_SYNTHESIS_PROMPT_VERSION,
	TEXT_SYNTHESIS_RESULT_SCHEMA,
	TEXT_SYNTHESIS_SCHEMA_VERSION,
	textSynthesisContext,
	textSynthesisSystemPrompt,
} from "./synthesis.js"

const roots: string[] = []

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "council-synthesis-"))
	roots.push(root)
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

const patch = {
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
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("synthesis contract", () => {
	it("round-trips the final-patch and fast combined schemas", () => {
		expect(CandidatePatchSchema.parse(patch)).toEqual(patch)
		expect(synthesisSystemPrompt()).toContain(SYNTHESIS_RESULT_SCHEMA)
		expect(synthesisSystemPrompt()).toContain(CANDIDATE_PATCH_SCHEMA)
		expect(synthesisSystemPrompt()).toMatch(/consensus|contradictions|unique insights|coherent/i)
		expect(COMBINED_RESULT_SCHEMA).toContain(CANDIDATE_PATCH_SCHEMA)
		expect(CombinedFusionSchema.parse({ analysis, summary, patch })).toEqual({ analysis, summary, patch })
	})

	it("writes a lead-pool patch and summary that can be staged", async () => {
		const harness = stageTestHarness([JSON.stringify({ summary, patch })])
		const outcome = await runSynthesisStage(harness.rt, {
			input: { objective: "write an answer", constraints: [], analysis, candidates: [patch] },
			leadPool: { primary: "physical/lead", fallbacks: ["physical/fallback"] },
			maxTokens: 256,
			repairMaxTokens: 128,
			deadline: Date.now() + 10_000,
			cacheKeyFor: requestCacheKey,
		})

		expect(outcome?.value).toEqual({ summary, patch })
		expect(harness.physicalCalls[0]?.stage).toBe("synthesis")
		expect(harness.physicalCalls[0]?.pool.primary).toBe("physical/lead")
		const prepared = harness.physicalCalls[0]?.prepareContext?.({} as Model<Api>, 256, 10_000)
		expect(prepared?.context.systemPrompt).toBe(
			synthesisContext({ objective: "write an answer", constraints: [], analysis, candidates: [patch] }).systemPrompt,
		)

		const root = fixture()
		const staged = await stagePatch(new ChangeTransaction(root), outcome?.value.patch)
		expect(staged.ok).toBe(true)
	})

	it("accepts a synthesis result with no summary field and stages the patch", async () => {
		const harness = stageTestHarness([JSON.stringify({ patch })])
		const outcome = await runSynthesisStage(harness.rt, {
			input: { objective: "write an answer", constraints: [], analysis, candidates: [patch] },
			leadPool: { primary: "physical/lead", fallbacks: [] },
			maxTokens: 256,
			repairMaxTokens: 128,
			deadline: Date.now() + 10_000,
			cacheKeyFor: requestCacheKey,
		})

		expect(outcome?.value.summary).toBeUndefined()
		expect(outcome?.value.patch).toEqual(patch)

		const root = fixture()
		const staged = await stagePatch(new ChangeTransaction(root), outcome?.value.patch)
		expect(staged.ok).toBe(true)
	})

	it("accepts a synthesis result with an empty-string summary and stages the patch", async () => {
		const harness = stageTestHarness([JSON.stringify({ summary: "", patch })])
		const outcome = await runSynthesisStage(harness.rt, {
			input: { objective: "write an answer", constraints: [], analysis, candidates: [patch] },
			leadPool: { primary: "physical/lead", fallbacks: [] },
			maxTokens: 256,
			repairMaxTokens: 128,
			deadline: Date.now() + 10_000,
			cacheKeyFor: requestCacheKey,
		})

		expect(outcome?.value.summary).toBeUndefined()
		expect(outcome?.value.patch).toEqual(patch)
	})

	it("repairs malformed synthesis output once and fails when the repair is malformed", async () => {
		const harness = stageTestHarness(["not json"], ["still not json"])
		await expect(
			runSynthesisStage(harness.rt, {
				input: { objective: "write an answer", constraints: [], analysis, candidates: [patch] },
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
		const root = fixture()
		const transaction = new ChangeTransaction(root)
		const combined = { analysis, summary, patch }
		const harness = stageTestHarness([JSON.stringify(combined)])
		const outcome = await runCombinedStage(harness.rt, {
			input: {
				objective: "write an answer",
				constraints: [],
				candidates: [patch],
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
		const root = fixture()
		const transaction = new ChangeTransaction(root)
		const harness = stageTestHarness([JSON.stringify({ analysis, patch })])
		const outcome = await runCombinedStage(harness.rt, {
			input: {
				objective: "write an answer",
				constraints: [],
				candidates: [patch],
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
		expect(outcome?.value.patch).toEqual(patch)

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
