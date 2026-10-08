/**
 * Deprecation state for models, mirroring the deprecation contract served
 * by the model metadata API:
 *
 *   - deprecated_at  — model enters the announcement window; still served.
 *   - sunset_at      — hard retirement date; model is removed from serving.
 *   - replacement_model — drop-in replacement the proxy routes to transparently.
 *   - alternatives   — human-facing migration hints (slug, reason).
 *   - deprecation_note — URL with deprecation details.
 *
 * Deprecation is a signalling boundary; sunset is the serving boundary: the
 * proxy keeps serving deprecated models (translating to a configured
 * replacement, or passing through when none is set) until `sunset_at`, and
 * the metadata endpoint lists them until then. Window comparisons use a
 * UTC-midnight-truncated date; deriveDeprecationState mirrors that so the
 * harness and backend agree on boundaries by the day.
 *
 * Deprecation data is persisted to a sidecar (model-deprecations.json next to
 * models.json) rather than inside models.json, which is an upstream-Pi
 * schema. The sidecar is a union-merge: entries for models that vanish from a
 * later fetch are kept, so replacement info remains available exactly when a
 * model disappears from the metadata list. Entries are small and bounded by
 * catalog churn, so no eviction is implemented.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** Mirrors the metadata API's ModelAlternative contract ({slug, reason}). */
export interface ModelAlternative {
	slug: string
	reason?: string
}

export interface ModelDeprecationInfo {
	deprecated_at?: string
	sunset_at?: string
	replacement_model?: string
	alternatives?: ModelAlternative[]
	deprecation_note?: string
}

export type DeprecationState = "none" | "announced" | "past" | "sunset"

/**
 * Best replacement target for a deprecated model: the explicit replacement,
 * falling back to the first listed alternative — used in feed order.
 */
export function pickReplacementSlug(info: ModelDeprecationInfo): string | undefined {
	return info.replacement_model ?? info.alternatives?.[0]?.slug
}

const DAY_MS = 24 * 60 * 60 * 1000

/** UTC-midnight truncation, mirroring the backend's `.Truncate(24 * time.Hour)`. */
function midnightUtc(nowMs: number): number {
	return Math.floor(nowMs / DAY_MS) * DAY_MS
}

function parseIsoDate(value: string | undefined, fieldName: string, slug?: string): number | undefined {
	if (!value) return undefined
	const ms = Date.parse(value)
	if (Number.isNaN(ms)) {
		console.warn(`[model-deprecation] ignoring invalid ${fieldName}${slug ? ` for ${slug}` : ""}: ${value}`)
		return undefined
	}
	return ms
}

/**
 * Deprecation lifecycle state at `nowMs`:
 *   - "none"      — no deprecation signal; model is plain-active.
 *   - "announced" — deprecation signal active, nothing past: deprecated_at
 *                   is in the future, OR only a future sunset_at is known
 *                   (vendor retirement without an announcement — the sunset
 *                   date itself is the signal). Still served; warn users.
 *   - "past"      — deprecated_at date reached; still listed and served
 *                   (translated to replacement_model when set) until sunset.
 *   - "sunset"    — sunset_at date reached; hard retirement, requests 410
 *                   and the model is excluded from metadata responses.
 * Invalid date strings fail open to "none" (after warning) so a malformed
 * record never silently hides a working model.
 */
export function deriveDeprecationState(
	m: ModelDeprecationInfo,
	nowMs: number = Date.now(),
	slug?: string,
): DeprecationState {
	const today = midnightUtc(nowMs)
	const sunsetAt = parseIsoDate(m.sunset_at, "sunset_at", slug)
	const deprecatedAt = parseIsoDate(m.deprecated_at, "deprecated_at", slug)
	if (sunsetAt !== undefined && sunsetAt <= today) return "sunset"
	// LiteLLM-derived deprecation dates for Anthropic models are provider
	// floors ("not sooner than"), not retirements, and they stay stale in the
	// catalogue for weeks (claude-sonnet-4-5 showed a past date while the
	// model was still active). Don't let a deprecated_at date steer routing
	// or warnings for Claude models; only a sunset_at (vendor retirement)
	// should.
	if (deprecatedAt !== undefined && !slug?.startsWith("claude-")) {
		return deprecatedAt > today ? "announced" : "past"
	}
	// Sunset-only record (vendor retirement date, no announced deprecation):
	// a dated removal is a deprecation signal in itself.
	if (sunsetAt !== undefined) return "announced"
	return "none"
}

/** Sidecar location: same directory as the runtime models.json cache. */
export function modelDeprecationsPath(modelsJsonPath: string): string {
	return join(dirname(modelsJsonPath), "model-deprecations.json")
}

/** Read the persisted deprecation map (slug → info); empty on absent/corrupt file. */
export function readModelDeprecations(modelsJsonPath: string): Map<string, ModelDeprecationInfo> {
	const result = new Map<string, ModelDeprecationInfo>()
	try {
		const raw: unknown = JSON.parse(readFileSync(modelDeprecationsPath(modelsJsonPath), "utf-8"))
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			for (const [slug, info] of Object.entries(raw as Record<string, unknown>)) {
				if (info && typeof info === "object" && !Array.isArray(info)) {
					result.set(slug, info as ModelDeprecationInfo)
				}
			}
		}
	} catch {
		// File absent or unreadable — no persisted deprecation state.
	}
	return result
}

function pickDeprecationFields(m: ModelDeprecationInfo): ModelDeprecationInfo | undefined {
	const info: ModelDeprecationInfo = {}
	if (m.deprecated_at !== undefined) info.deprecated_at = m.deprecated_at
	if (m.sunset_at !== undefined) info.sunset_at = m.sunset_at
	if (m.replacement_model !== undefined) info.replacement_model = m.replacement_model
	if (m.alternatives !== undefined) info.alternatives = m.alternatives
	if (m.deprecation_note !== undefined) info.deprecation_note = m.deprecation_note
	return Object.keys(info).length > 0 ? info : undefined
}

/**
 * Union-merge fresh deprecation records into the sidecar. Fresh entries win
 * field-for-field; entries for models absent from `models` are preserved —
 * that is precisely when their replacement info becomes load-bearing.
 */
export function writeModelDeprecations(
	modelsJsonPath: string,
	models: readonly (ModelDeprecationInfo & { slug: string })[],
): void {
	const merged = readModelDeprecations(modelsJsonPath)
	for (const m of models) {
		const info = pickDeprecationFields(m)
		if (info) merged.set(m.slug, info)
	}
	mkdirSync(dirname(modelsJsonPath), { recursive: true })
	writeFileSync(
		modelDeprecationsPath(modelsJsonPath),
		`${JSON.stringify(Object.fromEntries(merged), null, "\t")}\n`,
		"utf-8",
	)
}
