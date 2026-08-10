import { describe, expect, it } from "vitest"
import {
	ANALYST_PROMPT_VERSION,
	ANALYST_SCHEMA_VERSION,
	type AnalystInput,
	analystPacket,
	anonymizeCouncilAnswers,
	fusionAnalystSystemPrompt,
	runTextAnalystStage,
	TEXT_ANALYST_PROMPT_VERSION,
	TEXT_ANALYST_SCHEMA_VERSION,
	textAnalystPacket,
	textAnalystSystemPrompt,
} from "./adjudicator.js"
import { fixture, transactionRuntime } from "./coordinator-transaction-fixtures.js"
import { parseFusionAnalysisArtifact } from "./schemas.js"
import { stageTestHarness } from "./stage-test-harness.js"

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
