import { afterEach, describe, expect, it, vi } from "vitest"
import {
	addUsage,
	type CouncilCacheKey,
	CouncilRunContext,
	CouncilSessionCache,
	hashCouncilCacheValue,
	type RunBudgetLimits,
	type RunFailure,
	sanitizeRunRecord,
	toCouncilBudgetUsage,
	ZERO_USAGE,
} from "./run-context.js"
import { type CouncilTransactionSnapshot, FusionAnalysisSchema } from "./schemas.js"

const limits: RunBudgetLimits = {
	overallTimeoutMs: 1_000,
	maxLogicalCalls: 2,
	maxPhysicalAttempts: 3,
	maxConcurrentCalls: 2,
	maxAggregateInputTokens: 100,
	maxAggregateOutputTokens: 50,
	maxEvidenceBytes: 100,
	maxStructuredBytes: 100,
}

afterEach(() => vi.useRealTimers())

describe("CouncilRunContext", () => {
	it("atomically reserves parallel attempts and reconciles actual usage", () => {
		const run = new CouncilRunContext(limits)
		const first = run.reserveAttempt({ inputTokens: 40, outputTokens: 20 })
		const second = run.reserveAttempt({ inputTokens: 40, outputTokens: 20 })

		expect(() => run.reserveAttempt({ inputTokens: 1, outputTokens: 1 })).toThrowError(
			/Council run budget exceeded: maxConcurrentCalls/,
		)
		first.reconcile({ inputTokens: 10, outputTokens: 5 })
		second.reconcile({ inputTokens: 20, outputTokens: 10 })
		expect(run.snapshot()).toMatchObject({
			physicalAttempts: 2,
			activeCalls: 0,
			peakConcurrentCalls: 2,
			inputTokens: 30,
			outputTokens: 15,
		})
		run.close()
	})

	it("does not count a rejected physical attempt", () => {
		const run = new CouncilRunContext({ ...limits, maxPhysicalAttempts: 2, maxConcurrentCalls: 3 })
		const first = run.reserveAttempt({ inputTokens: 1, outputTokens: 1 })
		const second = run.reserveAttempt({ inputTokens: 1, outputTokens: 1 })

		expect(() => run.reserveAttempt({ inputTokens: 1, outputTokens: 1 })).toThrowError(
			expect.objectContaining<Partial<RunFailure>>({ code: "budget_exceeded", limit: "maxPhysicalAttempts" }),
		)
		expect(run.snapshot()).toMatchObject({ physicalAttempts: 2, activeCalls: 2 })
		first.release()
		second.release()
		expect(run.snapshot()).toMatchObject({ physicalAttempts: 2, activeCalls: 0 })
		run.close()
	})

	it("aborts the run when a logical-call budget is exceeded", () => {
		const run = new CouncilRunContext(limits)
		run.beginLogicalCall()
		run.beginLogicalCall()

		expect(() => run.beginLogicalCall()).toThrowError(
			expect.objectContaining<Partial<RunFailure>>({ code: "budget_exceeded", limit: "maxLogicalCalls" }),
		)
		expect(run.snapshot().logicalCalls).toBe(2)
		expect(run.signal.aborted).toBe(true)
		run.close()
	})

	it("tracks the largest evidence packet without accumulating repeated packets", () => {
		const evidence = new CouncilRunContext(limits)
		evidence.reserveEvidence(90)
		evidence.reserveEvidence(90)
		expect(evidence.snapshot().evidenceBytes).toBe(90)
		evidence.close()

		const oversized = new CouncilRunContext(limits)
		expect(() => oversized.reserveEvidence(101)).toThrowError(
			expect.objectContaining<Partial<RunFailure>>({ code: "budget_exceeded", limit: "maxEvidenceBytes" }),
		)
		expect(oversized.snapshot().evidenceBytes).toBe(0)
		oversized.close()
	})

	it("does not record rejected structured bytes", () => {
		const structured = new CouncilRunContext(limits)
		structured.reserveStructured(90)
		expect(() => structured.reserveStructured(20)).toThrowError(
			expect.objectContaining<Partial<RunFailure>>({ code: "budget_exceeded", limit: "maxStructuredBytes" }),
		)
		expect(structured.snapshot().structuredBytes).toBe(90)
		structured.close()
	})

	it("uses the shorter caller timeout as the whole-run deadline", () => {
		vi.useFakeTimers({ now: 10 })
		const run = new CouncilRunContext(limits, { callerTimeoutMs: 100 })
		expect(run.remainingMs(500)).toBe(100)

		vi.advanceTimersByTime(100)
		expect(() => run.throwIfAborted()).toThrowError(
			expect.objectContaining<Partial<RunFailure>>({ code: "deadline_exceeded" }),
		)
		run.close()
	})

	it("keeps cumulative usage when recreated between tool rounds", () => {
		vi.useFakeTimers({ now: 100 })
		const first = new CouncilRunContext(limits)
		first.beginLogicalCall()
		first.reserveAttempt({ inputTokens: 30, outputTokens: 15 }).reconcile({
			inputTokens: 20,
			outputTokens: 10,
		})
		first.reserveEvidence(25)
		first.reserveStructured(30)
		const initialSnapshot = { ...first.snapshot(), activeCalls: 7 }
		first.close()

		const second = new CouncilRunContext(limits, {
			startedAt: first.startedAt,
			deadlineAt: first.deadlineAt,
			initialSnapshot,
		})
		second.beginLogicalCall()
		second.reserveAttempt({ inputTokens: 10, outputTokens: 5 }).reconcile({
			inputTokens: 10,
			outputTokens: 5,
		})

		expect(second.snapshot()).toMatchObject({
			logicalCalls: 2,
			physicalAttempts: 2,
			activeCalls: 0,
			peakConcurrentCalls: 1,
			inputTokens: 30,
			outputTokens: 15,
			evidenceBytes: 25,
			structuredBytes: 30,
		})
		expect(() => second.beginLogicalCall()).toThrowError(
			expect.objectContaining<Partial<RunFailure>>({ code: "budget_exceeded", limit: "maxLogicalCalls" }),
		)
		expect(second.snapshot().logicalCalls).toBe(2)
		second.close()
	})

	it("keeps one absolute deadline when recreated", () => {
		vi.useFakeTimers({ now: 10 })
		const first = new CouncilRunContext(limits, { callerTimeoutMs: 100 })
		vi.advanceTimersByTime(60)
		const snapshot = first.snapshot()
		first.close()

		const second = new CouncilRunContext(limits, {
			startedAt: first.startedAt,
			deadlineAt: first.deadlineAt,
			initialSnapshot: snapshot,
		})
		expect(second.remainingMs(500)).toBe(40)
		vi.advanceTimersByTime(40)
		expect(() => second.throwIfAborted()).toThrowError(
			expect.objectContaining<Partial<RunFailure>>({ code: "deadline_exceeded" }),
		)
		second.close()
	})

	it("fails immediately when an inherited deadline is already expired", () => {
		vi.useFakeTimers({ now: 200 })
		const run = new CouncilRunContext(limits, { startedAt: 10, deadlineAt: 110 })

		expect(run.signal.aborted).toBe(true)
		expect(() => run.throwIfAborted()).toThrowError(
			expect.objectContaining<Partial<RunFailure>>({ code: "deadline_exceeded" }),
		)
		run.close()
	})

	it("propagates caller cancellation", () => {
		const caller = new AbortController()
		const run = new CouncilRunContext(limits, { callerSignal: caller.signal })
		caller.abort()

		expect(() => run.throwIfAborted()).toThrowError(expect.objectContaining<Partial<RunFailure>>({ code: "aborted" }))
		run.close()
	})
})

const cacheKey: CouncilCacheKey = {
	patchHash: "patch",
	baseSnapshotHash: "base",
	objectiveHash: "objective",
	constraintsHash: "constraints",
	evidenceHash: "evidence",
	role: "solver",
	modelId: "physical/model",
	promptVersion: "prompt",
	schemaVersion: "schema",
}

describe("CouncilSessionCache", () => {
	it("invalidates on every required key component", () => {
		for (const field of Object.keys(cacheKey) as Array<keyof CouncilCacheKey>) {
			const cache = new CouncilSessionCache()
			cache.setResult(cacheKey, { schema_version: 1 }, () => true)
			expect(cache.getResult({ ...cacheKey, [field]: `${cacheKey[field]}-changed` })).toBeUndefined()
		}
	})

	it("separates packets from validated results and clones values", () => {
		const cache = new CouncilSessionCache()
		const value = { schema_version: 1, findings: [] as string[] }
		cache.setResult(cacheKey, value, () => true)
		value.findings.push("mutated")

		expect(cache.getPacket(cacheKey)).toBeUndefined()
		expect(cache.getResult(cacheKey)).toEqual({ schema_version: 1, findings: [] })
		expect(cache.snapshot()).toMatchObject({ hits: 1, misses: 1, entries: 1 })
	})

	it("bounds entry count and byte size", () => {
		const cache = new CouncilSessionCache(2, 80, 60)
		expect(cache.setResult(cacheKey, { value: "a".repeat(20) }, () => true)).toBe(true)
		expect(cache.setResult({ ...cacheKey, role: "analyst" }, { value: "b".repeat(20) }, () => true)).toBe(true)
		expect(cache.setResult({ ...cacheKey, role: "synthesis" }, { value: "c".repeat(20) }, () => true)).toBe(true)
		expect(cache.snapshot().entries).toBeLessThanOrEqual(2)
		expect(cache.snapshot().bytes).toBeLessThanOrEqual(80)
		expect(
			cache.setResult({ ...cacheKey, modelId: "physical/oversized" }, { value: "x".repeat(100) }, () => true),
		).toBe(false)
	})

	it("never caches a schema-invalid structured result", () => {
		const cache = new CouncilSessionCache()
		expect(
			cache.setResult(
				cacheKey,
				{ consensus: "not-an-array", raw_reasoning: "private" },
				(value) => FusionAnalysisSchema.safeParse(value).success,
			),
		).toBe(false)
		expect(cache.getResult(cacheKey)).toBeUndefined()
	})

	it("hashes exact packet contents", () => {
		expect(hashCouncilCacheValue({ objective: "a" })).not.toBe(hashCouncilCacheValue({ objective: "b" }))
		expect(hashCouncilCacheValue({ objective: "a" })).toBe(hashCouncilCacheValue({ objective: "a" }))
	})
})

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
		const budget = toCouncilBudgetUsage(
			{
				logicalCalls: 2,
				physicalAttempts: 3,
				activeCalls: 0,
				peakConcurrentCalls: 2,
				inputTokens: 2,
				outputTokens: 3,
				evidenceBytes: 10,
				structuredBytes: 20,
			},
			{ hits: 2, misses: 3 },
		)
		const transaction = Object.assign(
			{
				transactionId: "transaction",
				state: "applied",
				outcome: "applied",
				patchSha256: "patch",
				stats: { files: 1, addedLines: 1, removedLines: 0, patchBytes: 10 },
				baseVerification: "passed",
				selectedValidationCheckIds: ["package.test"],
				postApplyChecks: [
					{
						id: "package.test",
						kind: "test",
						toolName: "bash",
						command: "node verify.mjs --token castai_v1_abcdefgh123456",
						ok: true,
						exitCode: 0,
						durationMs: 10,
						beforeSha256: "a".repeat(64),
						afterSha256: "a".repeat(64),
						mutationPolicy: "read-only",
						mutation: "none",
					},
				],
				rollbackState: "not_available",
				hardRecoveryRequired: false,
			} satisfies CouncilTransactionSnapshot,
			{ token: "server-secret", internalReasoning: "private chain" },
		)
		const record = sanitizeRunRecord({
			runId: "run",
			virtualModel: "kimchi/council",
			outcome: "error",
			degradedReason: "panel_unavailable",
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
					schemaErrorCode: "private-schema-secret" as never,
					truncated: true,
					retry: true,
				},
			],
		})

		expect(record.usage).toEqual(usage)
		expect(record.budget).toEqual(budget)
		expect(record.budget).toMatchObject({ cacheHits: 2, cacheMisses: 3 })
		expect(record.stages[0]?.error).toBe("unknown")
		expect(record.stages[0]?.schemaErrorCode).toBeUndefined()
		expect(record).toMatchObject({ degradedReason: "panel_unavailable" })
		expect(record.stages[0]).toMatchObject({ truncated: true, retry: true })
		expect(record.transaction).toMatchObject({ transactionId: "transaction", patchSha256: "patch" })
		expect(record.transaction?.postApplyChecks[0]?.command).toMatch(/^sha256:[a-f0-9]{64}$/)
		expect(JSON.stringify(record)).not.toMatch(
			/server-secret|private chain|private-schema-secret|castai_v1_abcdefgh123456|token|internalReasoning/,
		)
	})
})
