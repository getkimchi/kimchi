import { isCouncilVirtualModelRef } from "./model.js"
import { type CouncilConfig, type CouncilModelPool, REQUIRED_REVIEWER_ROLES, type ReviewerRole } from "./types.js"

export type CouncilPreset = "fast" | "normal" | "deep"

const MODELS = {
	kimi: "kimchi-dev/kimi-k2.7",
	glm: "kimchi-dev/glm-5.2-fp8",
	deepseek: "kimchi-dev/deepseek-v4-flash",
	minimax: "kimchi-dev/minimax-m3",
} as const

export const DEFAULT_COUNCIL_CONFIG: CouncilConfig = {
	enabled: true,
	reviewPolicy: "changes",
	lead: { primary: MODELS.kimi, fallbacks: [MODELS.glm, MODELS.deepseek] },
	reviewers: {
		independent: { primary: MODELS.glm, fallbacks: [MODELS.minimax, MODELS.deepseek] },
		critic: { primary: MODELS.deepseek, fallbacks: [MODELS.glm, MODELS.minimax] },
		checker: { primary: MODELS.minimax, fallbacks: [MODELS.deepseek, MODELS.glm] },
	},
	judge: { primary: MODELS.deepseek, fallbacks: [MODELS.glm, MODELS.kimi] },
	requiredRoles: [...REQUIRED_REVIEWER_ROLES],
	maxParallelReviewers: 3,
	overallTimeoutMs: 1_200_000,
	stageTimeoutMs: 300_000,
	leadMaxTokens: 32_768,
	internalMaxTokens: 8_192,
	maxEvidenceBytes: 131_072,
	maxStructuredBytes: 32_768,
	maxCalls: 8,
	budget: {
		maxLogicalCalls: 8,
		maxPhysicalAttempts: 12,
		maxConcurrentCalls: 3,
		maxAggregateInputTokens: 262_144,
		maxAggregateOutputTokens: 65_536,
		maxEstimatedCostUsd: 5,
		maxRetriesPerCall: 1,
	},
	useJudge: true,
	revisionPolicy: "always",
}

const PRESET_LIMITS = {
	fast: {
		requiredRoles: ["critic"],
		overallTimeoutMs: 240_000,
		stageTimeoutMs: 60_000,
		leadMaxTokens: 8_192,
		internalMaxTokens: 2_048,
		maxEvidenceBytes: 32_768,
		maxStructuredBytes: 8_192,
		maxLogicalCalls: 5,
		maxPhysicalAttempts: 7,
		maxConcurrentCalls: 1,
		maxAggregateInputTokens: 98_304,
		maxAggregateOutputTokens: 24_576,
		maxEstimatedCostUsd: 2,
		maxRetriesPerCall: 1,
		useJudge: false,
		revisionPolicy: "on-issues",
	},
	normal: {
		requiredRoles: ["independent", "critic"],
		overallTimeoutMs: 720_000,
		stageTimeoutMs: 180_000,
		leadMaxTokens: 16_384,
		internalMaxTokens: 8_192,
		maxEvidenceBytes: 65_536,
		maxStructuredBytes: 32_768,
		maxLogicalCalls: 7,
		maxPhysicalAttempts: 10,
		maxConcurrentCalls: 2,
		maxAggregateInputTokens: 196_608,
		maxAggregateOutputTokens: 49_152,
		maxEstimatedCostUsd: 4,
		maxRetriesPerCall: 1,
		useJudge: true,
		revisionPolicy: "on-issues",
	},
	deep: {
		requiredRoles: [...REQUIRED_REVIEWER_ROLES],
		overallTimeoutMs: DEFAULT_COUNCIL_CONFIG.overallTimeoutMs,
		stageTimeoutMs: DEFAULT_COUNCIL_CONFIG.stageTimeoutMs,
		leadMaxTokens: DEFAULT_COUNCIL_CONFIG.leadMaxTokens,
		internalMaxTokens: DEFAULT_COUNCIL_CONFIG.internalMaxTokens,
		maxEvidenceBytes: DEFAULT_COUNCIL_CONFIG.maxEvidenceBytes,
		maxStructuredBytes: DEFAULT_COUNCIL_CONFIG.maxStructuredBytes,
		...DEFAULT_COUNCIL_CONFIG.budget,
		useJudge: true,
		revisionPolicy: "always",
	},
} as const satisfies Record<CouncilPreset, { requiredRoles: readonly ReviewerRole[] } & Record<string, unknown>>

const MAX_POOL_FALLBACKS = 4

function boundedPositiveInteger(value: string | undefined, fallback: number, maximum: number): number {
	const normalized = value?.trim()
	if (!normalized || !/^[1-9]\d*$/.test(normalized)) return fallback
	const parsed = Number(normalized)
	return Number.isSafeInteger(parsed) ? Math.min(parsed, maximum) : fallback
}

function boundedNonNegativeInteger(value: string | undefined, fallback: number, maximum: number): number {
	const normalized = value?.trim()
	if (!normalized || !/^\d+$/.test(normalized)) return fallback
	const parsed = Number(normalized)
	return Number.isSafeInteger(parsed) ? Math.min(parsed, maximum) : fallback
}

function boundedPositiveNumber(value: string | undefined, fallback: number, maximum: number): number {
	const normalized = value?.trim()
	if (!normalized || !/^(?:\d+|\d+\.\d{1,4})$/.test(normalized)) return fallback
	const parsed = Number(normalized)
	return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback
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

function models(value: string | undefined, fallback: string[]): string[] {
	if (value === undefined) return [...fallback]
	return [
		...new Set(
			value
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean),
		),
	].slice(0, MAX_POOL_FALLBACKS)
}

function modelPool(
	primary: string | undefined,
	fallbacks: string | undefined,
	base: CouncilModelPool,
): CouncilModelPool {
	const resolvedPrimary = model(primary, base.primary)
	return {
		primary: resolvedPrimary,
		fallbacks: models(fallbacks, base.fallbacks).filter((candidate) => candidate !== resolvedPrimary),
	}
}

export function validateCouncilConfig(config: CouncilConfig): CouncilConfig {
	if (config.requiredRoles.length === 0) throw new Error("Council requires at least one reviewer role")
	if (new Set(config.requiredRoles).size !== config.requiredRoles.length)
		throw new Error("Council reviewer roles must be unique")

	const requiredPools: [string, CouncilModelPool][] = [["lead", config.lead]]
	for (const role of config.requiredRoles) requiredPools.push([role, config.reviewers[role]])
	if (config.useJudge) requiredPools.push(["judge", config.judge])
	for (const [name, pool] of requiredPools) {
		if (!pool.primary.trim()) throw new Error(`Council ${name} model pool is empty`)
	}

	const pools = [config.lead, ...Object.values(config.reviewers), config.judge]
	for (const pool of pools) {
		for (const modelRef of [pool.primary, ...pool.fallbacks]) {
			if (modelRef && isCouncilVirtualModelRef(modelRef))
				throw new Error(`Council model pools cannot reference virtual model ${modelRef}`)
		}
	}
	return config
}

export function applyCouncilPreset(config: CouncilConfig, preset: CouncilPreset): CouncilConfig {
	const limits = PRESET_LIMITS[preset]
	const requiredRoles = [...limits.requiredRoles]
	return validateCouncilConfig({
		...config,
		requiredRoles,
		maxParallelReviewers: Math.min(config.maxParallelReviewers, requiredRoles.length),
		overallTimeoutMs: Math.min(config.overallTimeoutMs, limits.overallTimeoutMs),
		stageTimeoutMs: Math.min(config.stageTimeoutMs, limits.stageTimeoutMs),
		leadMaxTokens: Math.min(config.leadMaxTokens, limits.leadMaxTokens),
		internalMaxTokens: Math.min(config.internalMaxTokens, limits.internalMaxTokens),
		maxEvidenceBytes: Math.min(config.maxEvidenceBytes, limits.maxEvidenceBytes),
		maxStructuredBytes: Math.min(config.maxStructuredBytes, limits.maxStructuredBytes),
		maxCalls: Math.min(config.maxCalls, limits.maxLogicalCalls),
		budget: {
			maxLogicalCalls: Math.min(config.budget.maxLogicalCalls, limits.maxLogicalCalls),
			maxPhysicalAttempts: Math.min(config.budget.maxPhysicalAttempts, limits.maxPhysicalAttempts),
			maxConcurrentCalls: Math.min(config.budget.maxConcurrentCalls, limits.maxConcurrentCalls),
			maxAggregateInputTokens: Math.min(config.budget.maxAggregateInputTokens, limits.maxAggregateInputTokens),
			maxAggregateOutputTokens: Math.min(config.budget.maxAggregateOutputTokens, limits.maxAggregateOutputTokens),
			maxEstimatedCostUsd: Math.min(config.budget.maxEstimatedCostUsd, limits.maxEstimatedCostUsd),
			maxRetriesPerCall: Math.min(config.budget.maxRetriesPerCall, limits.maxRetriesPerCall),
		},
		useJudge: limits.useJudge,
		revisionPolicy: limits.revisionPolicy,
	})
}

export function readCouncilConfig(env: NodeJS.ProcessEnv = process.env): CouncilConfig {
	const legacyReviewers = models(env.KIMCHI_COUNCIL_REVIEWER_MODELS, [])
	const reviewers = structuredClone(DEFAULT_COUNCIL_CONFIG.reviewers)
	if (legacyReviewers.length >= 2) {
		reviewers.independent.primary = legacyReviewers[0]
		reviewers.critic.primary = legacyReviewers[1]
		reviewers.checker.primary = legacyReviewers[2] ?? legacyReviewers[0]
	}

	const maxLogicalCalls = boundedPositiveInteger(
		env.KIMCHI_COUNCIL_MAX_LOGICAL_CALLS ?? env.KIMCHI_COUNCIL_MAX_CALLS,
		DEFAULT_COUNCIL_CONFIG.budget.maxLogicalCalls,
		DEFAULT_COUNCIL_CONFIG.budget.maxLogicalCalls,
	)
	const config: CouncilConfig = {
		...DEFAULT_COUNCIL_CONFIG,
		enabled: boolean(env.KIMCHI_COUNCIL_ENABLED, DEFAULT_COUNCIL_CONFIG.enabled),
		lead: modelPool(
			env.KIMCHI_COUNCIL_LEAD_MODEL,
			env.KIMCHI_COUNCIL_LEAD_FALLBACK_MODELS,
			DEFAULT_COUNCIL_CONFIG.lead,
		),
		reviewers: {
			independent: modelPool(
				env.KIMCHI_COUNCIL_INDEPENDENT_MODEL,
				env.KIMCHI_COUNCIL_INDEPENDENT_FALLBACK_MODELS,
				reviewers.independent,
			),
			critic: modelPool(env.KIMCHI_COUNCIL_CRITIC_MODEL, env.KIMCHI_COUNCIL_CRITIC_FALLBACK_MODELS, reviewers.critic),
			checker: modelPool(
				env.KIMCHI_COUNCIL_CHECKER_MODEL,
				env.KIMCHI_COUNCIL_CHECKER_FALLBACK_MODELS,
				reviewers.checker,
			),
		},
		judge: modelPool(
			env.KIMCHI_COUNCIL_JUDGE_MODEL,
			env.KIMCHI_COUNCIL_JUDGE_FALLBACK_MODELS,
			DEFAULT_COUNCIL_CONFIG.judge,
		),
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
			REQUIRED_REVIEWER_ROLES.length,
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
		maxCalls: maxLogicalCalls,
		budget: {
			maxLogicalCalls,
			maxPhysicalAttempts: boundedPositiveInteger(
				env.KIMCHI_COUNCIL_MAX_PHYSICAL_ATTEMPTS,
				DEFAULT_COUNCIL_CONFIG.budget.maxPhysicalAttempts,
				DEFAULT_COUNCIL_CONFIG.budget.maxPhysicalAttempts,
			),
			maxConcurrentCalls: boundedPositiveInteger(
				env.KIMCHI_COUNCIL_MAX_CONCURRENT_CALLS,
				DEFAULT_COUNCIL_CONFIG.budget.maxConcurrentCalls,
				DEFAULT_COUNCIL_CONFIG.budget.maxConcurrentCalls,
			),
			maxAggregateInputTokens: boundedPositiveInteger(
				env.KIMCHI_COUNCIL_MAX_AGGREGATE_INPUT_TOKENS,
				DEFAULT_COUNCIL_CONFIG.budget.maxAggregateInputTokens,
				DEFAULT_COUNCIL_CONFIG.budget.maxAggregateInputTokens,
			),
			maxAggregateOutputTokens: boundedPositiveInteger(
				env.KIMCHI_COUNCIL_MAX_AGGREGATE_OUTPUT_TOKENS,
				DEFAULT_COUNCIL_CONFIG.budget.maxAggregateOutputTokens,
				DEFAULT_COUNCIL_CONFIG.budget.maxAggregateOutputTokens,
			),
			maxEstimatedCostUsd: boundedPositiveNumber(
				env.KIMCHI_COUNCIL_MAX_ESTIMATED_COST_USD,
				DEFAULT_COUNCIL_CONFIG.budget.maxEstimatedCostUsd,
				DEFAULT_COUNCIL_CONFIG.budget.maxEstimatedCostUsd,
			),
			maxRetriesPerCall: boundedNonNegativeInteger(
				env.KIMCHI_COUNCIL_MAX_RETRIES_PER_CALL,
				DEFAULT_COUNCIL_CONFIG.budget.maxRetriesPerCall,
				DEFAULT_COUNCIL_CONFIG.budget.maxRetriesPerCall,
			),
		},
	}
	return validateCouncilConfig(config)
}
