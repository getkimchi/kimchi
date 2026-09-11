/**
 * Deprecation state for models, mirroring the deprecation contract served
 * by the model metadata API:
 *
 *   - deprecated_at  — model enters the announcement window; still served.
 *   - sunset_at      — hard retirement date; model is removed from serving.
 *   - replacement_model — drop-in replacement the proxy routes to transparently.
 *   - alternatives   — human-facing migration hints (slug, reason, priority).
 *   - deprecation_note — URL with deprecation details.
 *
 * The backend excludes models past `deprecated_at` from default responses,
 * comparing against a UTC-midnight-truncated date. deriveDeprecationState
 * mirrors that comparison so the harness and backend agree on window
 * boundaries by the day.
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

export interface ModelAlternative {
	slug: string
	reason?: string
	priority?: number
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
 * falling back to the first listed alternative. Alternatives are used in
 * feed order — the informational `priority` field is not interpreted here.
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
 *   - "announced" — deprecated_at is in the future; still served, warn users.
 *   - "past"      — deprecated_at date reached; backend no longer lists it.
 *   - "sunset"    — sunset_at date reached; hard retirement, excluded even
 *                   from deprecation responses.
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
	if (deprecatedAt !== undefined) return deprecatedAt > today ? "announced" : "past"
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
