import { isCouncilVirtualModelRef } from "./model.js"
import { type CouncilConfig, type CouncilModelPool, MAX_COUNCIL_PANEL_SIZE } from "./types.js"

export type CouncilPreset = "fast" | "normal" | "deep"

const MODELS = {
	kimi: "kimchi-dev/kimi-k2.7",
	glm: "kimchi-dev/glm-5.2-fp8",
	deepseek: "kimchi-dev/deepseek-v4-flash",
	minimax: "kimchi-dev/minimax-m3",
} as const

export const DEFAULT_COUNCIL_CONFIG: CouncilConfig = {
	enabled: true,
	lead: { primary: MODELS.kimi, fallbacks: [MODELS.glm, MODELS.deepseek] },
	panel: [
		{ primary: MODELS.glm, fallbacks: [MODELS.minimax, MODELS.deepseek] },
		{ primary: MODELS.deepseek, fallbacks: [MODELS.glm, MODELS.minimax] },
		{ primary: MODELS.minimax, fallbacks: [MODELS.glm, MODELS.deepseek] },
	],
	analyst: { primary: MODELS.glm, fallbacks: [MODELS.deepseek, MODELS.minimax] },
	panelSize: 3,
	overallTimeoutMs: 1_200_000,
	stageTimeoutMs: 300_000,
	leadMaxTokens: 32_768,
	internalMaxTokens: 16_384,
	maxEvidenceBytes: 131_072,
	maxStructuredBytes: 131_072,
	budget: {
		maxLogicalCalls: 40,
		maxPhysicalAttempts: 48,
		maxConcurrentCalls: 3,
		maxAggregateInputTokens: 786_432,
		maxAggregateOutputTokens: 98_304,
		maxRetriesPerCall: 0,
	},
}

const PRESET_LIMITS = {
	fast: {
		panelSize: 2,
		overallTimeoutMs: 300_000,
		stageTimeoutMs: 90_000,
		leadMaxTokens: 12_288,
		internalMaxTokens: 4_096,
		maxEvidenceBytes: 131_072,
		maxStructuredBytes: 8_192,
		maxLogicalCalls: 12,
		maxPhysicalAttempts: 14,
		maxConcurrentCalls: 1,
		maxAggregateInputTokens: 196_608,
		maxAggregateOutputTokens: 32_768,
		maxRetriesPerCall: 0,
	},
	normal: {
		panelSize: 3,
		overallTimeoutMs: 1_200_000,
		stageTimeoutMs: 300_000,
		leadMaxTokens: 24_576,
		internalMaxTokens: 16_384,
		maxEvidenceBytes: 131_072,
		maxStructuredBytes: DEFAULT_COUNCIL_CONFIG.maxStructuredBytes,
		maxLogicalCalls: 40,
		maxPhysicalAttempts: 48,
		maxConcurrentCalls: 3,
		maxAggregateInputTokens: 524_288,
		maxAggregateOutputTokens: 65_536,
		maxRetriesPerCall: 0,
	},
	deep: {
		panelSize: 5,
		overallTimeoutMs: DEFAULT_COUNCIL_CONFIG.overallTimeoutMs,
		stageTimeoutMs: DEFAULT_COUNCIL_CONFIG.stageTimeoutMs,
		leadMaxTokens: DEFAULT_COUNCIL_CONFIG.leadMaxTokens,
		internalMaxTokens: DEFAULT_COUNCIL_CONFIG.internalMaxTokens,
		maxEvidenceBytes: DEFAULT_COUNCIL_CONFIG.maxEvidenceBytes,
		maxStructuredBytes: DEFAULT_COUNCIL_CONFIG.maxStructuredBytes,
		...DEFAULT_COUNCIL_CONFIG.budget,
	},
} as const satisfies Record<CouncilPreset, { panelSize: number } & Record<string, unknown>>

const MAX_POOL_FALLBACKS = 4

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

function models(value: string | undefined, fallback: string[], maximum = MAX_POOL_FALLBACKS): string[] {
	if (value === undefined) return [...fallback]
	return [
		...new Set(
			value
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean),
		),
	].slice(0, maximum)
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

/** Floors and caps Council limits at the configuration boundary. */
function clampCouncilConfigLimits(config: CouncilConfig): CouncilConfig {
	return {
		...config,
		overallTimeoutMs: Math.min(Math.max(1, config.overallTimeoutMs), DEFAULT_COUNCIL_CONFIG.overallTimeoutMs),
		stageTimeoutMs: Math.min(Math.max(1, config.stageTimeoutMs), DEFAULT_COUNCIL_CONFIG.stageTimeoutMs),
		leadMaxTokens: Math.min(Math.max(1, config.leadMaxTokens), DEFAULT_COUNCIL_CONFIG.leadMaxTokens),
		internalMaxTokens: Math.min(Math.max(1, config.internalMaxTokens), DEFAULT_COUNCIL_CONFIG.internalMaxTokens),
		maxEvidenceBytes: Math.min(Math.max(4096, config.maxEvidenceBytes), DEFAULT_COUNCIL_CONFIG.maxEvidenceBytes),
		maxStructuredBytes: Math.min(Math.max(1024, config.maxStructuredBytes), DEFAULT_COUNCIL_CONFIG.maxStructuredBytes),
	}
}

export function validateCouncilConfig(config: CouncilConfig): CouncilConfig {
	if (config.panel.length === 0) throw new Error("Council requires at least one panel model")
	if (config.panel.length > MAX_COUNCIL_PANEL_SIZE)
		throw new Error(`Council panel cannot exceed ${MAX_COUNCIL_PANEL_SIZE} models`)
	const panelSize = Math.min(Math.max(1, config.panelSize), MAX_COUNCIL_PANEL_SIZE)

	const requiredPools: [string, CouncilModelPool][] = [["lead", config.lead]]
	for (let index = 0; index < panelSize; index++) {
		const pool = config.panel[index % config.panel.length]
		if (pool) requiredPools.push(["solver", pool])
	}
	requiredPools.push(["analyst", config.analyst])
	for (const [name, pool] of requiredPools) {
		if (!pool.primary.trim()) throw new Error(`Council ${name} model pool is empty`)
	}

	const pools = [config.lead, ...config.panel, config.analyst]
	for (const pool of pools) {
		for (const modelRef of [pool.primary, ...pool.fallbacks]) {
			if (modelRef && isCouncilVirtualModelRef(modelRef))
				throw new Error(`Council model pools cannot reference virtual model ${modelRef}`)
		}
	}
	return clampCouncilConfigLimits({ ...config, panelSize })
}

export function applyCouncilPreset(config: CouncilConfig, preset: CouncilPreset): CouncilConfig {
	const limits = PRESET_LIMITS[preset]
	return validateCouncilConfig({
		...config,
		panelSize: config.panelSizeOverride ?? limits.panelSize,
		overallTimeoutMs: Math.min(config.overallTimeoutMs, limits.overallTimeoutMs),
		stageTimeoutMs: Math.min(config.stageTimeoutMs, limits.stageTimeoutMs),
		leadMaxTokens: Math.min(config.leadMaxTokens, limits.leadMaxTokens),
		internalMaxTokens: Math.min(config.internalMaxTokens, limits.internalMaxTokens),
		maxEvidenceBytes: Math.min(config.maxEvidenceBytes, limits.maxEvidenceBytes),
		maxStructuredBytes: Math.min(config.maxStructuredBytes, limits.maxStructuredBytes),
		budget: {
			maxLogicalCalls: Math.min(config.budget.maxLogicalCalls, limits.maxLogicalCalls),
			maxPhysicalAttempts: Math.min(config.budget.maxPhysicalAttempts, limits.maxPhysicalAttempts),
			maxConcurrentCalls: Math.min(config.budget.maxConcurrentCalls, limits.maxConcurrentCalls),
			maxAggregateInputTokens: Math.min(config.budget.maxAggregateInputTokens, limits.maxAggregateInputTokens),
			maxAggregateOutputTokens: Math.min(config.budget.maxAggregateOutputTokens, limits.maxAggregateOutputTokens),
			maxRetriesPerCall: Math.min(config.budget.maxRetriesPerCall, limits.maxRetriesPerCall),
		},
	})
}

export function readCouncilConfig(env: NodeJS.ProcessEnv = process.env): CouncilConfig {
	const panelPrimaries = models(env.KIMCHI_COUNCIL_PANEL_MODELS, [], MAX_COUNCIL_PANEL_SIZE)
	const panel = panelPrimaries.length
		? panelPrimaries.map((primary, index) => {
				const base = DEFAULT_COUNCIL_CONFIG.panel[index % DEFAULT_COUNCIL_CONFIG.panel.length]
				return { primary, fallbacks: base?.fallbacks.filter((candidate) => candidate !== primary) ?? [] }
			})
		: structuredClone(DEFAULT_COUNCIL_CONFIG.panel)
	const panelSizeOverride = env.KIMCHI_COUNCIL_PANEL_SIZE
		? boundedPositiveInteger(env.KIMCHI_COUNCIL_PANEL_SIZE, DEFAULT_COUNCIL_CONFIG.panelSize, MAX_COUNCIL_PANEL_SIZE)
		: undefined

	const maxLogicalCalls = boundedPositiveInteger(
		env.KIMCHI_COUNCIL_MAX_LOGICAL_CALLS ?? env.KIMCHI_COUNCIL_MAX_CALLS,
		DEFAULT_COUNCIL_CONFIG.budget.maxLogicalCalls,
		DEFAULT_COUNCIL_CONFIG.budget.maxLogicalCalls,
	)
	const config: CouncilConfig = {
		...DEFAULT_COUNCIL_CONFIG,
		enabled: boolean(env.KIMCHI_COUNCIL_ENABLED, DEFAULT_COUNCIL_CONFIG.enabled),
		lead: modelPool(env.KIMCHI_COUNCIL_LEAD_MODEL, undefined, DEFAULT_COUNCIL_CONFIG.lead),
		panel,
		panelSize: panelSizeOverride ?? DEFAULT_COUNCIL_CONFIG.panelSize,
		...(panelSizeOverride === undefined ? {} : { panelSizeOverride }),
		analyst: modelPool(
			env.KIMCHI_COUNCIL_ANALYST_MODEL,
			env.KIMCHI_COUNCIL_ANALYST_FALLBACK_MODELS,
			panel[0] ?? DEFAULT_COUNCIL_CONFIG.analyst,
		),
		overallTimeoutMs: boundedPositiveInteger(
			env.KIMCHI_COUNCIL_TIMEOUT_MS,
			DEFAULT_COUNCIL_CONFIG.overallTimeoutMs,
			DEFAULT_COUNCIL_CONFIG.overallTimeoutMs,
		),
		stageTimeoutMs: DEFAULT_COUNCIL_CONFIG.stageTimeoutMs,
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
		maxEvidenceBytes: DEFAULT_COUNCIL_CONFIG.maxEvidenceBytes,
		maxStructuredBytes: DEFAULT_COUNCIL_CONFIG.maxStructuredBytes,
		budget: {
			maxLogicalCalls,
			maxPhysicalAttempts: DEFAULT_COUNCIL_CONFIG.budget.maxPhysicalAttempts,
			maxConcurrentCalls: DEFAULT_COUNCIL_CONFIG.budget.maxConcurrentCalls,
			maxAggregateInputTokens: DEFAULT_COUNCIL_CONFIG.budget.maxAggregateInputTokens,
			maxAggregateOutputTokens: DEFAULT_COUNCIL_CONFIG.budget.maxAggregateOutputTokens,
			maxRetriesPerCall: DEFAULT_COUNCIL_CONFIG.budget.maxRetriesPerCall,
		},
	}
	return validateCouncilConfig(config)
}
