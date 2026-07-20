import { type CouncilConfig, DEFAULT_COUNCIL_CONFIG } from "./runtime.js"

function boundedPositiveInteger(value: string | undefined, fallback: number, maximum: number): number {
	const normalized = value?.trim()
	if (!normalized || !/^[1-9]\d*$/.test(normalized)) return fallback
	const parsed = Number(normalized)
	return Number.isSafeInteger(parsed) ? Math.min(parsed, maximum) : fallback
}

function boolean(value: string | undefined, fallback: boolean): boolean {
	switch (value?.trim().toLowerCase()) {
		case "1":
		case "true":
			return true
		case "0":
		case "false":
			return false
		default:
			return fallback
	}
}

function model(value: string | undefined, fallback: string): string {
	return value?.trim() || fallback
}

export function readCouncilConfig(env: NodeJS.ProcessEnv = process.env): CouncilConfig {
	const configuredReviewerModels = env.KIMCHI_COUNCIL_REVIEWER_MODELS?.split(",")
		.map((value) => value.trim())
		.filter(Boolean)
		.slice(0, 3)
	const reviewerModels =
		configuredReviewerModels && configuredReviewerModels.length >= 2
			? configuredReviewerModels
			: [...DEFAULT_COUNCIL_CONFIG.reviewerModels]

	return {
		...DEFAULT_COUNCIL_CONFIG,
		enabled: boolean(env.KIMCHI_COUNCIL_ENABLED, DEFAULT_COUNCIL_CONFIG.enabled),
		leadModel: model(env.KIMCHI_COUNCIL_LEAD_MODEL, DEFAULT_COUNCIL_CONFIG.leadModel),
		reviewerModels,
		judgeModel: model(env.KIMCHI_COUNCIL_JUDGE_MODEL, DEFAULT_COUNCIL_CONFIG.judgeModel),
		overallTimeoutMs: boundedPositiveInteger(
			env.KIMCHI_COUNCIL_TIMEOUT_MS,
			DEFAULT_COUNCIL_CONFIG.overallTimeoutMs,
			DEFAULT_COUNCIL_CONFIG.overallTimeoutMs,
		),
		stageTimeoutMs: boundedPositiveInteger(
			env.KIMCHI_COUNCIL_STAGE_TIMEOUT_MS,
			DEFAULT_COUNCIL_CONFIG.stageTimeoutMs,
			DEFAULT_COUNCIL_CONFIG.stageTimeoutMs,
		),
		maxParallelReviewers: boundedPositiveInteger(
			env.KIMCHI_COUNCIL_MAX_PARALLEL_REVIEWERS,
			DEFAULT_COUNCIL_CONFIG.maxParallelReviewers,
			3,
		),
		leadMaxTokens: boundedPositiveInteger(
			env.KIMCHI_COUNCIL_LEAD_MAX_TOKENS,
			DEFAULT_COUNCIL_CONFIG.leadMaxTokens,
			DEFAULT_COUNCIL_CONFIG.leadMaxTokens,
		),
		internalMaxTokens: boundedPositiveInteger(
			env.KIMCHI_COUNCIL_INTERNAL_MAX_TOKENS,
			DEFAULT_COUNCIL_CONFIG.internalMaxTokens,
			DEFAULT_COUNCIL_CONFIG.internalMaxTokens,
		),
		maxEvidenceBytes: boundedPositiveInteger(
			env.KIMCHI_COUNCIL_MAX_EVIDENCE_BYTES,
			DEFAULT_COUNCIL_CONFIG.maxEvidenceBytes,
			DEFAULT_COUNCIL_CONFIG.maxEvidenceBytes,
		),
		maxStructuredBytes: boundedPositiveInteger(
			env.KIMCHI_COUNCIL_MAX_STRUCTURED_BYTES,
			DEFAULT_COUNCIL_CONFIG.maxStructuredBytes,
			DEFAULT_COUNCIL_CONFIG.maxStructuredBytes,
		),
		maxCalls: boundedPositiveInteger(
			env.KIMCHI_COUNCIL_MAX_CALLS,
			DEFAULT_COUNCIL_CONFIG.maxCalls,
			DEFAULT_COUNCIL_CONFIG.maxCalls,
		),
	}
}
