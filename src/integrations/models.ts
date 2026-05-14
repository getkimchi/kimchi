/**
 * Static model catalogue used when writing tool config files. The runtime
 * model list served to the harness is fetched from the metadata API at
 * startup (src/models.ts); this static list is only used by tool config
 * writers, which configure tools to talk to a known set of model IDs
 * without an online round-trip.
 *
 * @deprecated Use `resolveModelRole(models, role)` instead — it picks models
 * dynamically from the API-fetched `ModelMetadata[]` list. This static
 * catalogue will be removed in a future release.
 */
export interface ModelLimits {
	contextWindow: number
	maxOutputTokens: number
}

export interface KimchiModel {
	slug: string
	displayName: string
	description: string
	toolCall: boolean
	reasoning: boolean
	supportsImages?: boolean
	inputModalities: ReadonlyArray<"text" | "image">
	limits: ModelLimits
}

export const MAIN_MODEL: KimchiModel = {
	slug: "kimi-k2.6",
	displayName: "Kimi K2.6",
	description: "Primary model for reasoning, planning, code generation, and image processing.",
	toolCall: true,
	reasoning: true,
	supportsImages: true,
	inputModalities: ["text", "image"],
	limits: { contextWindow: 262_144, maxOutputTokens: 32_768 },
}

export const KIMI_K25_MODEL: KimchiModel = {
	slug: "kimi-k2.5",
	displayName: "Kimi K2.5",
	description: "Previous Kimi model for reasoning, planning, and code generation.",
	toolCall: true,
	reasoning: true,
	supportsImages: true,
	inputModalities: ["text", "image"],
	limits: { contextWindow: 262_144, maxOutputTokens: 32_768 },
}

export const CODING_MODEL: KimchiModel = {
	slug: "nemotron-3-super-fp4",
	displayName: "Nemotron 3 Super FP4",
	description: "High-performance reasoning model for complex tasks.",
	toolCall: true,
	reasoning: true,
	inputModalities: ["text"],
	limits: { contextWindow: 1_048_576, maxOutputTokens: 256_000 },
}

export const SUB_MODEL: KimchiModel = {
	slug: "minimax-m2.7",
	displayName: "MiniMax M2.7",
	description: "Secondary subagent for code generation and debugging.",
	toolCall: true,
	reasoning: true,
	inputModalities: ["text"],
	limits: { contextWindow: 196_608, maxOutputTokens: 32_768 },
}

export const OPUS_MODEL: KimchiModel = {
	slug: "claude-opus-4-6",
	displayName: "Claude Opus 4.6",
	description: "High-capability model for complex planning and validation tasks.",
	toolCall: true,
	reasoning: true,
	inputModalities: ["text"],
	limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
}

export const SONNET_MODEL: KimchiModel = {
	slug: "claude-sonnet-4-6",
	displayName: "Claude Sonnet 4.6",
	description: "Balanced model for general reasoning and code tasks.",
	toolCall: true,
	reasoning: true,
	inputModalities: ["text"],
	limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
}

export const ALL_MODELS: ReadonlyArray<KimchiModel> = [
	MAIN_MODEL,
	CODING_MODEL,
	SUB_MODEL,
	OPUS_MODEL,
	SONNET_MODEL,
	KIMI_K25_MODEL,
]

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic model role resolution (replaces the static constants above)
// ─────────────────────────────────────────────────────────────────────────────

import type { ModelMetadata } from "../models.js"

export type ModelRole = "main" | "coding" | "sub" | "opus" | "sonnet"

/**
 * Resolve a conceptual model role to a concrete `ModelMetadata` from the
 * available API-fetched list.
 *
 * Role resolution strategy:
 *
 * | Role   | Selection logic                                                                                                    |
 * |--------|---------------------------------------------------------------------------------------------------------------------|
 * | main   | First serverless model that has vision (input_modalities includes "image") and "Kimi" in display_name → first serverless fallback |
 * | coding | First serverless model whose slug matches /nemotron|minimax/ → first serverless non-main                            |
 * | sub    | Smallest serverless model that is not main (sorted by context_window)                                                  |
 * | opus   | First model with provider=anthropic whose slug contains "opus" → any anthropic model                                  |
 * | sonnet | First model with provider=anthropic whose slug contains "sonnet" → any anthropic model                               |
 *
 * @param models          - The live `ModelMetadata[]` fetched from the API via `updateModelsConfig()`.
 * @param role            - Which conceptual role to resolve.
 * @param precomputedMain - Optional precomputed main model. If omitted, `main` is resolved internally (safe for single-role calls).
 */
export function resolveModelRole(
	models: readonly ModelMetadata[],
	role: ModelRole,
	precomputedMain?: ModelMetadata | undefined,
): ModelMetadata | undefined {
	if (models.length === 0) return undefined

	const serverless = models.filter((m) => m.is_serverless)
	const anthropic = models.filter((m) => m.provider === "anthropic")

	// Cache main once so coding/sub don't recurse into it.
	const main =
		precomputedMain ??
		((): ModelMetadata | undefined => {
			const vision = serverless.find(
				(m) =>
					m.input_modalities.includes("image") &&
					(m.display_name.toLowerCase().includes("kimi") || m.slug.toLowerCase().includes("kimi")),
			)
			return vision ?? serverless[0] ?? models[0]
		})()

	switch (role) {
		case "main":
			return main

		case "coding": {
			// Prefer known coding-optimised slugs; then any serverless non-main.
			if (main) {
				const coding = serverless.find((m) => /nemotron|minimax/.test(m.slug) && m.slug !== main.slug)
				if (coding) return coding
				const fallback = serverless.find((m) => m.slug !== main.slug)
				if (fallback) return fallback
			}
			return serverless.length > 0 ? serverless[0] : models.length > 1 ? models[1] : undefined
		}

		case "sub": {
			// Smallest serverless model that is not main.
			const nonMain = serverless.filter((m) => !main || m.slug !== main.slug)
			if (nonMain.length === 0) return models.find((m) => !main || m.slug !== main.slug)
			nonMain.sort((a, b) => a.limits.context_window - b.limits.context_window)
			return nonMain[0]
		}

		case "opus":
			return models.find((m) => m.provider === "anthropic" && m.slug.includes("opus")) ?? anthropic[0]

		case "sonnet":
			return models.find((m) => m.provider === "anthropic" && m.slug.includes("sonnet")) ?? anthropic[0]

		default:
			return undefined
	}
}

/**
 * Resolve multiple model roles in a single pass, computing `main` only once.
 * Returns a record keyed by role name. Use this when you need several roles
 * at once to avoid redundant resolution.
 */
export function resolveAllModelRoles(
	models: readonly ModelMetadata[],
	roles: readonly ModelRole[],
): Partial<Record<ModelRole, ModelMetadata>> {
	const result: Partial<Record<ModelRole, ModelMetadata>> = {}
	let main: ModelMetadata | undefined
	for (const role of roles) {
		if (result[role]) continue // already resolved
		const resolved = resolveModelRole(models, role, main)
		result[role] = resolved
		if (role === "main" && resolved) main = resolved
	}
	return result
}

/**
 * Build a human-readable model pair string for CLI banners.
 * e.g. "kimi-k2.6 (reasoning) / nemotron-3-super-fp4 (coding)"
 */
export function formatModelPair(models: readonly ModelMetadata[]): string {
	if (models.length === 0) return "dynamic models"
	const main = resolveModelRole(models, "main")
	const coding = resolveModelRole(models, "coding", main)
	if (!main) return "dynamic models"
	if (!coding) return main.slug
	return `${main.slug} (reasoning) / ${coding.slug} (coding)`
}
