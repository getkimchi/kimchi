import { createHash } from "node:crypto"
import type { Usage } from "@earendil-works/pi-ai"
import type { CouncilCacheStats } from "./cache.js"
import type { RunBudgetSnapshot } from "./run-context.js"
import type {
	CouncilBudgetUsage,
	CouncilRunRecord,
	CouncilSchemaErrorCode,
	CouncilTransactionSnapshot,
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
	"missing_disposition",
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
		estimatedCostUsd: snapshot.estimatedCostUsd,
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
		revisionCount: transaction.revisionCount,
		selectedValidationCheckIds: [...transaction.selectedValidationCheckIds],
		postApplyChecks: transaction.postApplyChecks.map((check) => ({
			...check,
			command: `sha256:${createHash("sha256").update(check.command).digest("hex")}`,
		})),
		rollbackState: transaction.rollbackState,
		hardRecoveryRequired: transaction.hardRecoveryRequired,
	}
}
