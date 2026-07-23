import { describe, expect, it } from "vitest"
import { addUsage, sanitizeRunRecord, toCouncilBudgetUsage, ZERO_USAGE } from "./telemetry.js"
import type { CouncilTransactionSnapshot } from "./types.js"

describe("Council telemetry", () => {
	it("aggregates usage and emits only bounded structured stage data", () => {
		const usage = addUsage(ZERO_USAGE, {
			input: 2,
			output: 3,
			cacheRead: 4,
			cacheWrite: 5,
			totalTokens: 14,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		})
		const budget = toCouncilBudgetUsage({
			logicalCalls: 2,
			physicalAttempts: 3,
			activeCalls: 0,
			peakConcurrentCalls: 2,
			inputTokens: 2,
			outputTokens: 3,
			estimatedCostUsd: 1,
			evidenceBytes: 10,
			structuredBytes: 20,
		})
		const transaction = Object.assign(
			{
				transactionId: "transaction",
				state: "applied",
				outcome: "applied",
				patchSha256: "patch",
				stats: { files: 1, addedLines: 1, removedLines: 0, patchBytes: 10 },
				baseVerification: "passed",
				revisionCount: 0,
				postApplyChecks: [{ toolName: "bash", ok: true }],
				rollbackState: "not_available",
				hardRecoveryRequired: false,
			} satisfies CouncilTransactionSnapshot,
			{ token: "server-secret", internalReasoning: "private chain" },
		)
		const record = sanitizeRunRecord({
			runId: "run",
			virtualModel: "kimchi/council",
			outcome: "error",
			unresolvedFindingCount: 1,
			missingReviewerRoles: ["checker"],
			durationMs: 1,
			usage,
			budget,
			transaction,
			stages: [
				{
					stage: "lead",
					modelRef: "provider/model",
					status: "error",
					durationMs: 1,
					attempts: 1,
					error: "secret message with spaces",
					truncated: true,
					retry: true,
				},
			],
		})

		expect(record.usage).toEqual(usage)
		expect(record.budget).toEqual(budget)
		expect(record.stages[0]?.error).toBe("unknown")
		expect(record).toMatchObject({ unresolvedFindingCount: 1, missingReviewerRoles: ["checker"] })
		expect(record.stages[0]).toMatchObject({ truncated: true, retry: true })
		expect(record.transaction).toMatchObject({ transactionId: "transaction", patchSha256: "patch" })
		expect(JSON.stringify(record)).not.toMatch(/server-secret|private chain|token|internalReasoning/)
	})
})
