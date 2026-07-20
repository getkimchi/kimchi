import { type CouncilConfig, DEFAULT_COUNCIL_CONFIG } from "./runtime.js"

export type CouncilPreset = "fast" | "normal" | "deep"

const PRESET_LIMITS = {
	fast: {
		reviewerRoles: ["critic"],
		overallTimeoutMs: 240_000,
		stageTimeoutMs: 60_000,
		leadMaxTokens: 8_192,
		internalMaxTokens: 2_048,
		maxEvidenceBytes: 32_768,
		maxStructuredBytes: 8_192,
		maxCalls: 5,
		useJudge: false,
		revisionPolicy: "on-issues",
	},
	normal: {
		reviewerRoles: ["critic", "checker"],
		overallTimeoutMs: 720_000,
		stageTimeoutMs: 180_000,
		leadMaxTokens: 16_384,
		internalMaxTokens: 8_192,
		maxEvidenceBytes: 65_536,
		maxStructuredBytes: 32_768,
		maxCalls: 7,
		useJudge: true,
		revisionPolicy: "on-issues",
	},
	deep: {
		reviewerRoles: ["independent", "critic", "checker"],
		overallTimeoutMs: DEFAULT_COUNCIL_CONFIG.overallTimeoutMs,
		stageTimeoutMs: DEFAULT_COUNCIL_CONFIG.stageTimeoutMs,
		leadMaxTokens: DEFAULT_COUNCIL_CONFIG.leadMaxTokens,
		internalMaxTokens: DEFAULT_COUNCIL_CONFIG.internalMaxTokens,
		maxEvidenceBytes: DEFAULT_COUNCIL_CONFIG.maxEvidenceBytes,
		maxStructuredBytes: DEFAULT_COUNCIL_CONFIG.maxStructuredBytes,
		maxCalls: DEFAULT_COUNCIL_CONFIG.maxCalls,
		useJudge: true,
		revisionPolicy: "always",
	},
} as const

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

export function applyCouncilPreset(config: CouncilConfig, preset: CouncilPreset): CouncilConfig {
	const limits = PRESET_LIMITS[preset]
	const selectedIndices: number[] = []
	const reviewerModels: string[] = []
	const reviewerRoles: CouncilConfig["reviewerRoles"] = []
	for (const role of limits.reviewerRoles) {
		let index = config.reviewerRoles.findIndex(
			(candidate, candidateIndex) =>
				candidate === role &&
				!selectedIndices.includes(candidateIndex) &&
				config.reviewerModels[candidateIndex] !== undefined,
		)
		if (index < 0)
			index = config.reviewerModels.findIndex((_, candidateIndex) => !selectedIndices.includes(candidateIndex))
		if (index < 0 && config.reviewerModels.length > 0) index = reviewerModels.length % config.reviewerModels.length
		const reviewerModel = config.reviewerModels[index]
		if (!reviewerModel) continue
		selectedIndices.push(index)
		reviewerModels.push(reviewerModel)
		reviewerRoles.push(role)
	}
	return {
		...config,
		reviewerModels,
		reviewerRoles,
		maxParallelReviewers: Math.min(config.maxParallelReviewers, reviewerModels.length),
		overallTimeoutMs: Math.min(config.overallTimeoutMs, limits.overallTimeoutMs),
		stageTimeoutMs: Math.min(config.stageTimeoutMs, limits.stageTimeoutMs),
		leadMaxTokens: Math.min(config.leadMaxTokens, limits.leadMaxTokens),
		internalMaxTokens: Math.min(config.internalMaxTokens, limits.internalMaxTokens),
		maxEvidenceBytes: Math.min(config.maxEvidenceBytes, limits.maxEvidenceBytes),
		maxStructuredBytes: Math.min(config.maxStructuredBytes, limits.maxStructuredBytes),
		maxCalls: Math.min(config.maxCalls, limits.maxCalls),
		useJudge: limits.useJudge,
		revisionPolicy: limits.revisionPolicy,
	}
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
