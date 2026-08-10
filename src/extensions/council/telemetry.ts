import { createHash } from "node:crypto"
import type { Usage } from "@earendil-works/pi-ai"
import type { CouncilCacheStats } from "./cache.js"
import { PhysicalInvocationError } from "./physical-invoker.js"
import { type RunBudgetSnapshot, RunFailure } from "./run-context.js"
import type {
	CouncilBudgetUsage,
	CouncilDegradedReason,
	CouncilRole,
	CouncilRunRecord,
	CouncilSchemaErrorCode,
	CouncilTransactionSnapshot,
	SafeCouncilFailureReason,
} from "./types.js"

export const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const SAFE_STAGE_ERRORS = new Set([
	"aborted",
	"auth_failed",
	"budget_exceeded",
	"deadline_exceeded",
	"invalid_output",
	"model_incompatible",
	"model_not_found",
	"output_limit",
	"provider_error",
	"timeout",
])
const SAFE_SCHEMA_ERROR_CODES: ReadonlySet<CouncilSchemaErrorCode> = new Set([
	"missing_json",
	"ambiguous_json",
	"invalid_json",
	"invalid_shape",
	"unsupported_reference",
])

export function addUsage(total: Usage, next: Usage): Usage {
	return {
		input: total.input + next.input,
		output: total.output + next.output,
		cacheRead: total.cacheRead + next.cacheRead,
		cacheWrite: total.cacheWrite + next.cacheWrite,
		cacheWrite1h: (total.cacheWrite1h ?? 0) + (next.cacheWrite1h ?? 0),
		totalTokens: total.totalTokens + next.totalTokens,
		cost: {
			input: total.cost.input + next.cost.input,
			output: total.cost.output + next.cost.output,
			cacheRead: total.cost.cacheRead + next.cost.cacheRead,
			cacheWrite: total.cost.cacheWrite + next.cost.cacheWrite,
			total: total.cost.total + next.cost.total,
		},
	}
}

export function toCouncilBudgetUsage(
	snapshot: RunBudgetSnapshot,
	cache: Pick<CouncilCacheStats, "hits" | "misses"> = { hits: 0, misses: 0 },
): CouncilBudgetUsage {
	return {
		logicalCalls: snapshot.logicalCalls,
		physicalAttempts: snapshot.physicalAttempts,
		maxObservedConcurrency: snapshot.peakConcurrentCalls,
		aggregateInputTokens: snapshot.inputTokens,
		aggregateOutputTokens: snapshot.outputTokens,
		evidenceBytes: snapshot.evidenceBytes,
		structuredBytes: snapshot.structuredBytes,
		cacheHits: cache.hits,
		cacheMisses: cache.misses,
	}
}

export function sanitizeRunRecord(record: CouncilRunRecord): CouncilRunRecord {
	return {
		...record,
		stages: record.stages.map((stage) => ({
			...stage,
			...(stage.error ? { error: SAFE_STAGE_ERRORS.has(stage.error) ? stage.error : "unknown" } : {}),
			...(stage.schemaErrorCode
				? { schemaErrorCode: SAFE_SCHEMA_ERROR_CODES.has(stage.schemaErrorCode) ? stage.schemaErrorCode : undefined }
				: {}),
		})),
		transaction: record.transaction ? sanitizeCouncilTransactionSnapshot(record.transaction) : undefined,
	}
}

export function safeFailureReason(error: unknown, role?: CouncilRole): SafeCouncilFailureReason {
	const code = error instanceof RunFailure || error instanceof PhysicalInvocationError ? error.code : undefined
	if (code === "aborted") return "cancelled"
	if (code === "timeout" || code === "deadline_exceeded") return "timed_out"
	if (code === "budget_exceeded") return "limit_reached"
	if (role === "solver" || role === "analyst" || role === "repair") {
		return "panel_unavailable"
	}
	return "validation_failed"
}

export function safeDegradedReason(reason: CouncilDegradedReason | undefined): SafeCouncilFailureReason {
	if (reason === "deadline_exceeded") return "timed_out"
	if (reason === "budget_exhausted" || reason === "budget_exceeded") return "limit_reached"
	if (reason === "panel_unavailable" || reason === "analyst_failed") {
		return "panel_unavailable"
	}
	return "validation_failed"
}

export function sanitizeCouncilTransactionSnapshot(
	transaction: CouncilTransactionSnapshot,
): CouncilTransactionSnapshot {
	return {
		transactionId: transaction.transactionId,
		state: transaction.state,
		outcome: transaction.outcome,
		patchSha256: transaction.patchSha256,
		stats: transaction.stats ? { ...transaction.stats } : undefined,
		baseVerification: transaction.baseVerification,
		selectedValidationCheckIds: [...transaction.selectedValidationCheckIds],
		postApplyChecks: transaction.postApplyChecks.map((check) => ({
			...check,
			command: `sha256:${createHash("sha256").update(check.command).digest("hex")}`,
		})),
		rollbackState: transaction.rollbackState,
		hardRecoveryRequired: transaction.hardRecoveryRequired,
	}
}
