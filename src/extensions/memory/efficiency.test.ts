import { describe, expect, it } from "vitest"
import { groupedEfficiency, pairedEfficiency, type ReplayRun, summarizeUsefulness } from "./efficiency.js"

function run(overrides: Partial<ReplayRun> = {}): ReplayRun {
	return {
		checkpoint: "checkpoint-1",
		workload: "developer",
		model: "test-model",
		provider: "fixture-provider",
		stateDigest: "state-v1",
		toolSetDigest: "tools-v1",
		storeDigest: "store-v1",
		mode: "memory-off",
		steps: 10,
		toolCalls: 20,
		wallMs: 800,
		taskInputTokens: 4_000,
		taskOutputTokens: 1_000,
		accountingComplete: true,
		...overrides,
	}
}

describe("usefulness attribution", () => {
	it("separates delivery truth and confirmation flags from verified usefulness", () => {
		const common = {
			factId: "fact-1",
			trigger: "step-budget",
			kind: "digest-progressive",
			model: "test-model",
			provider: "test-provider",
			workload: "developer",
		}
		const groups = summarizeUsefulness([
			{ ...common, recallId: "r1", conclusion: "steered", acknowledged: true, followUpSearch: true },
			{ factId: "fact-1", recallId: "r1", trigger: "step-budget", verifiedOutcome: "useful" },
			{ ...common, recallId: "r2", conclusion: "droppedStale", acknowledged: true },
			{ ...common, recallId: "r3", conclusion: "selected", acknowledged: false },
			{ ...common, recallId: "r4", conclusion: "selected", contradicted: true },
			{ ...common, recallId: "r5", conclusion: "selected", contradicted: true, verifiedOutcome: "contradicted" },
			{ ...common, recallId: "r6", conclusion: "selected", followUpSearch: true },
			{ ...common, recallId: "r7", conclusion: "selected", verifiedOutcome: "stale" },
		])
		expect(groups).toHaveLength(1)
		const group = groups[0]
		expect(group).toMatchObject({
			selected: 7,
			attached: 0,
			steered: 1,
			cancelled: 0,
			timedOut: 0,
			droppedStale: 1,
			acknowledged: 2,
			followUpSearches: 2,
			contradictionsFlagged: 2,
			outcomes: { useful: 1, redundant: 0, ignored: 1, contradicted: 1, stale: 1, unknown: 3 },
			knownOutcomes: 4,
		})
	})

	it("preserves the original terminal delivery when later reviews carry no new delivery event", () => {
		const groups = summarizeUsefulness([
			{ factId: "fact-1", recallId: "r1", trigger: "step", conclusion: "steered" },
			{ factId: "fact-1", recallId: "r1", trigger: "step", verifiedOutcome: "useful" },
			{ factId: "fact-1", recallId: "r2", trigger: "step", conclusion: "attachedToTurn" },
			{ factId: "fact-1", recallId: "r2", trigger: "step", acknowledged: false, verifiedOutcome: "redundant" },
			{ factId: "fact-1", recallId: "r3", trigger: "step", conclusion: "selected" },
			{ factId: "fact-1", recallId: "r3", trigger: "step", acknowledged: true },
		])
		expect(groups[0]).toMatchObject({
			selected: 3,
			attached: 1,
			steered: 1,
			outcomes: { useful: 1, redundant: 1, ignored: 0, contradicted: 0, stale: 0, unknown: 1 },
		})
	})

	it("keeps distinct workloads and ignores only explicit non-selections", () => {
		const observations = summarizeUsefulness([
			{ factId: "same-fact", recallId: "r1", trigger: "digest", workload: "developer" },
			{ factId: "same-fact", recallId: "r2", trigger: "digest", workload: "long-loop" },
			{ factId: "same-fact", recallId: "r3", trigger: "digest", selected: false, acknowledged: true },
		])
		expect(observations.map((item) => item.workload)).toEqual(["developer", "long-loop"])
		expect(observations[1]?.outcomes.unknown).toBe(1)
	})
})

describe("paired net efficiency", () => {
	it("subtracts full memory cost from task savings in the known-benefit direction", () => {
		const report = pairedEfficiency(
			run(),
			run({
				mode: "capture-and-retrieval",
				steps: 8,
				toolCalls: 14,
				wallMs: 600,
				taskInputTokens: 3_000,
				backgroundMs: 50,
				usage: [
					{ kind: "extraction", inputTokens: 100, outputTokens: 50, failed: true },
					{ kind: "embedding", inputTokens: 20 },
					{ kind: "d3", inputTokens: 15, outputTokens: 5 },
				],
			}),
		)
		expect(report.gross).toEqual({ stepsSaved: 2, toolCallsSaved: 6, wallMsSaved: 200, modelTokensSaved: 1_000 })
		expect(report.cost).toEqual({ tokens: 190, backgroundMs: 50, failedMemoryCalls: 1 })
		expect(report.net).toEqual({ steps: 2, toolCalls: 6, wallMs: 150, tokens: 810 })
		expect(report.accountingComplete).toBe(true)
	})

	it("reports a negative net for redundant memory work instead of hiding it", () => {
		const report = pairedEfficiency(
			run(),
			run({
				mode: "capture-and-retrieval",
				steps: 11,
				toolCalls: 21,
				wallMs: 900,
				usage: [{ kind: "extraction", inputTokens: 1_000 }],
				accountingComplete: false,
			}),
		)
		expect(report.net).toEqual({ steps: -1, toolCalls: -1, wallMs: -100, tokens: -1_000 })
		expect(report.accountingComplete).toBe(false)
	})

	it("rejects controls that are not from the same matched checkpoint state", () => {
		expect(() => pairedEfficiency(run(), run({ mode: "frozen-retrieval", toolSetDigest: "different-tools" }))).toThrow(
			"same checkpoint",
		)
		expect(() => pairedEfficiency(run(), run({ mode: "frozen-retrieval", workload: "long-loop" }))).toThrow(
			"same checkpoint",
		)
		expect(() => pairedEfficiency(run(), run({ mode: "frozen-retrieval", taskInputTokens: -1 }))).toThrow(
			"non-negative finite number",
		)
	})

	it("separates group metrics by model/workload and reports observed uncertainty ranges", () => {
		const beneficial = pairedEfficiency(
			run(),
			run({
				mode: "capture-and-retrieval",
				steps: 8,
				toolCalls: 14,
				wallMs: 600,
				taskInputTokens: 3_000,
				backgroundMs: 50,
				usage: [{ kind: "embedding", inputTokens: 190 }],
			}),
		)
		const repeated = pairedEfficiency(
			run({ checkpoint: "checkpoint-2" }),
			run({
				checkpoint: "checkpoint-2",
				mode: "capture-and-retrieval",
				steps: 8,
				toolCalls: 14,
				wallMs: 600,
				taskInputTokens: 3_000,
				usage: [{ kind: "embedding", inputTokens: 90 }],
			}),
		)
		const summary = groupedEfficiency([beneficial, repeated])
		expect(summary.sampleSize).toBe(2)
		expect(summary.net.tokens).toEqual({ mean: 860, lower: 812.5, upper: 907.5 })
		expect(summary.net.steps).toEqual({ mean: 2, lower: 2, upper: 2 })
		expect(summary.net.wallMs.lower).toBe(151.25)
		expect(summary.net.wallMs.upper).toBe(198.75)
		expect(() => groupedEfficiency([beneficial, { ...repeated, workload: "long-loop" }])).toThrow("must share")
		expect(() => groupedEfficiency([])).toThrow("empty paired replay")
	})
})
