import { ask, createTestRun, raw, reply } from "@kimchi-dev/kimchi-workflows/testing"
import { describe, expect, it } from "vitest"
import loopReviewWorkflow, { GLM_MODEL, KIMI_MODEL, MAX_REVIEW_ROUNDS } from "./loop-review.workflow.js"

const intent = {
	baseRef: "main",
	summary: "Add a repository-bundled loop review workflow.",
	problem: "Developers need repeatable review and correction before merging.",
	expectedBehavior: ["Two independent reviewers inspect every round."],
	acceptanceCriteria: ["The loop stops when clean or after five rounds."],
	constraints: ["Reviewers remain read-only."],
	nonGoals: ["Committing changes automatically."],
	evidence: ["The workflow request and current diff."],
	uncertainties: [],
}

const finding = {
	title: "Handle the edge case",
	priority: "P2",
	category: "edge-case",
	file: "src/example.ts",
	line: 12,
	problem: "An empty input follows the wrong branch.",
	impact: "The feature fails for a supported input.",
	evidence: "The condition treats an empty value as absent.",
	recommendation: "Distinguish an empty value from a missing value and add a regression test.",
}

const intentDecision = (question: string) =>
	ask({
		title: "Confirm change intent",
		questions: [
			{
				key: "intentDecision",
				header: "Intent",
				question,
				kind: "single",
				options: [
					{ value: "confirm", label: "Confirm and start review", recommended: true },
					{ value: "revise", label: "Needs correction" },
				],
			},
		],
	})

const correctionQuestion = ask({
	title: "Correct change intent",
	questions: [
		{
			key: "additionalContext",
			header: "Context",
			question: "What should be corrected or added?",
			kind: "chat",
		},
	],
})

function reviewerResult(findings: readonly (typeof finding)[] = []) {
	return {
		summary: findings.length === 0 ? "No actionable issues found." : "One actionable issue found.",
		findings,
		questions: [],
	}
}

function synthesis(status: "clean" | "actionable") {
	const findings = status === "clean" ? [] : [finding]
	return {
		status,
		message:
			status === "clean" ? "No actionable issues remain." : "Fix the empty-input branch and cover it with a test.",
		findings,
		openQuestions: [],
	}
}

describe("loop-review workflow", () => {
	it("does not review until the user corrects and confirms the inferred intent", async () => {
		let run = await createTestRun(loopReviewWorkflow, {
			agents: {
				"discover-and-confirm-intent": [
					intentDecision("Initial inferred intent"),
					correctionQuestion,
					intentDecision("Revised inferred intent"),
					reply(intent),
				],
				"review-with-glm": [reply(reviewerResult())],
				"review-with-kimi": [reply(reviewerResult())],
				"synthesize-findings": [reply(synthesis("clean"))],
			},
		})

		expect(run.status).toBe("blocked")
		expect(run.questionKeys()).toEqual(["intentDecision"])
		expect(run.agent("review-with-glm").sessions).toBe(0)

		run = await run.answer({ intentDecision: "revise" })
		expect(run.status).toBe("blocked")
		expect(run.questionKeys()).toEqual(["additionalContext"])
		expect(run.agent("review-with-kimi").sessions).toBe(0)

		run = await run.answer({ additionalContext: "The workflow must also include working-tree fixes." })
		expect(run.status).toBe("blocked")
		expect(run.questionKeys()).toEqual(["intentDecision"])
		expect(run.agent("review-with-glm").sessions).toBe(0)

		run = await run.answer({ intentDecision: "confirm" })
		expect(run.status).toBe("completed")
		expect(run.output).toMatchObject({ outcome: "clean", rounds: 1, lastReviewedFindings: [] })
		expect(run.agent("implement-corrections").sessions).toBe(0)
	})

	it("uses GLM to implement findings before both reviewers inspect the updated tree", async () => {
		const blocked = await createTestRun(loopReviewWorkflow, {
			agents: {
				"discover-and-confirm-intent": [intentDecision("Inferred intent"), reply(intent)],
				"review-with-glm": [reply(reviewerResult([finding])), reply(reviewerResult())],
				"review-with-kimi": [reply(reviewerResult([finding])), reply(reviewerResult())],
				"synthesize-findings": [reply(synthesis("actionable")), reply(synthesis("clean"))],
				"implement-corrections": [raw("Implemented the correction and its regression test.")],
			},
		})

		const run = await blocked.answer({ intentDecision: "confirm" })

		expect(run.status).toBe("completed")
		expect(run.output).toMatchObject({ outcome: "clean", rounds: 2, lastReviewedFindings: [] })
		expect(run.agent("review-with-glm").models).toEqual([GLM_MODEL, GLM_MODEL])
		expect(run.agent("review-with-kimi").models).toEqual([KIMI_MODEL, KIMI_MODEL])
		expect(run.agent("synthesize-findings").models).toEqual([GLM_MODEL, GLM_MODEL])
		expect(run.agent("implement-corrections").models).toEqual([GLM_MODEL])
	})

	it("completes successfully after five non-clean rounds without starting a sixth review", async () => {
		const actionableReviews = Array.from({ length: MAX_REVIEW_ROUNDS }, () => reply(reviewerResult([finding])))
		const actionableSyntheses = Array.from({ length: MAX_REVIEW_ROUNDS }, () => reply(synthesis("actionable")))
		const implementations = Array.from({ length: MAX_REVIEW_ROUNDS }, () => raw("Implemented this round's fixes."))
		const blocked = await createTestRun(loopReviewWorkflow, {
			agents: {
				"discover-and-confirm-intent": [intentDecision("Inferred intent"), reply(intent)],
				"review-with-glm": actionableReviews,
				"review-with-kimi": actionableReviews,
				"synthesize-findings": actionableSyntheses,
				"implement-corrections": implementations,
			},
		})

		const run = await blocked.answer({ intentDecision: "confirm" })

		expect(run.status).toBe("completed")
		expect(run.output).toMatchObject({
			outcome: "iteration-cap",
			rounds: MAX_REVIEW_ROUNDS,
			lastReviewedFindings: [finding],
		})
		expect(run.agent("review-with-glm").sessions).toBe(MAX_REVIEW_ROUNDS)
		expect(run.agent("review-with-kimi").sessions).toBe(MAX_REVIEW_ROUNDS)
		expect(run.agent("implement-corrections").sessions).toBe(MAX_REVIEW_ROUNDS)
		expect(run.agent("review-with-glm").remaining).toBe(0)
		expect(run.agent("review-with-kimi").remaining).toBe(0)
	})
})
