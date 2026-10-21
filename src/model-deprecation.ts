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

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
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

/** Sidecar/metadata date fields must be ISO-ish date strings; anything else
 *  (numbers, garbage, escape-sequence payloads) is dropped with a warning so
 *  a malformed record can neither crash rendering nor inject control
 *  characters into user-visible surfaces. */
const ISO_DATE_SHAPE_RE = /^\d{4}-\d{2}-\d{2}/

function validDateField(value: unknown, fieldName: string, slug?: string): string | undefined {
	if (value === undefined) return undefined
	if (typeof value !== "string" || !ISO_DATE_SHAPE_RE.test(value) || Number.isNaN(Date.parse(value))) {
		console.warn(
			`[model-deprecation] ignoring invalid ${fieldName}${slug ? ` for ${slug}` : ""}: ${
				typeof value === "string" ? value : JSON.stringify(value)
			}`,
		)
		return undefined
	}
	return value
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

/**
 * How close a model's retirement must be (in days) before user-facing
 * deprecation signals fire — session-start warnings and the /model picker
 * marker alike. Far-future lifespan signals (vendor retirement dates years
 * out, with or without an announced deprecation) stay silent until they get
 * close; curated Kimchi deprecations run on a 30-day deprecation window.
 * 30 days keeps urgent notices loud and distant dates quiet.
 */
export const DEPRECATION_NOTIFY_WINDOW_DAYS = 30

/** Shared 30-day cutoff, midnight-truncated like the backend so the marker
 *  and the session-start toast can never disagree at the window edge. */
export function deprecationNotifyCutoff(nowMs: number = Date.now()): number {
	return midnightUtc(nowMs) + DEPRECATION_NOTIFY_WINDOW_DAYS * DAY_MS
}

/** True when a deprecation date falls within the notify window, compared by
 *  day (UTC-midnight truncation on both sides) rather than by exact instant.
 *  Sidecar dates carry a time of day; the backend and the window cutoff are
 *  day-granular, so a deprecation landing exactly 30 days out at 17:50 must
 *  still be inside the window — comparing the raw timestamp against the
 *  midnight-truncated cutoff would silently drop it. */
export function isWithinDeprecationNotifyWindow(effectiveMs: number, nowMs: number = Date.now()): boolean {
	return midnightUtc(effectiveMs) <= deprecationNotifyCutoff(nowMs)
}

/** Prefix every deprecation marker starts with. */
const MARKER_PREFIX = "[Deprecated"
const MARKER_RE = /^\[Deprecated(?: — retires \d{4}-\d{2}-\d{2})?\]\s*/

/** True when a description string carries a deprecation marker. */
export function isDeprecationMarked(description: string): boolean {
	return description.startsWith(MARKER_PREFIX)
}

/** Remove a previously applied marker from a description, or return it unchanged. */
export function stripDeprecationMarker(description: string): string {
	return isDeprecationMarked(description) ? description.replace(MARKER_RE, "") : description
}

/**
 * Picker-facing deprecation marker for a model, or undefined when none
 * should render: not deprecated, already sunset (never listed anyway), or an
 * announcement beyond the notify window. Mirrors the session-start toast's
 * gating so both surfaces agree on when a deprecation becomes visible.
 */
export function deprecationMarker(
	info: ModelDeprecationInfo,
	slug: string,
	nowMs: number = Date.now(),
): string | undefined {
	const state = deriveDeprecationState(info, nowMs, slug)
	if (state === "none" || state === "sunset") return undefined
	if (state === "announced") {
		const effectiveMs =
			parseIsoDate(info.deprecated_at, "deprecated_at", slug) ?? parseIsoDate(info.sunset_at, "sunset_at", slug)
		if (effectiveMs === undefined || !isWithinDeprecationNotifyWindow(effectiveMs, nowMs)) return undefined
	}
	// Never cite a past deprecated_at as a future retirement (mirrors the
	// session-start toast): past deprecations only name sunset_at when known.
	// Both fields are validated strings by the time they get here (sidecar
	// reads sanitize them), but guard anyway — deprecationMarker is exported
	// and callers may pass raw metadata.
	const sunsetAt = typeof info.sunset_at === "string" ? info.sunset_at : undefined
	const deprecatedAt = typeof info.deprecated_at === "string" ? info.deprecated_at : undefined
	const date = (state === "past" ? sunsetAt : (sunsetAt ?? deprecatedAt))?.slice(0, 10)
	return date ? `[Deprecated — retires ${date}]` : "[Deprecated]"
}

/**
 * Deprecation markers by slug for the current sidecar, ready for selector
 * surfaces (TUI description registry, ACP model option descriptions).
 * Empty when the sidecar is absent — no markers is the normal steady state.
 */
export function collectDeprecationMarkers(modelsJsonPath: string, nowMs: number = Date.now()): Map<string, string> {
	const markers = new Map<string, string>()
	for (const [slug, info] of readModelDeprecations(modelsJsonPath)) {
		const marker = deprecationMarker(info, slug, nowMs)
		if (marker) markers.set(slug, marker)
	}
	return markers
}

/** Read the persisted deprecation map (slug → info); empty on absent/corrupt file.
 *  Field values are validated on read — a hand-edited or corrupted sidecar
 *  must never leak non-date strings into rendering or crash marker building. */
export function readModelDeprecations(modelsJsonPath: string): Map<string, ModelDeprecationInfo> {
	const result = new Map<string, ModelDeprecationInfo>()
	try {
		const raw: unknown = JSON.parse(readFileSync(modelDeprecationsPath(modelsJsonPath), "utf-8"))
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			for (const [slug, info] of Object.entries(raw as Record<string, unknown>)) {
				if (info && typeof info === "object" && !Array.isArray(info)) {
					result.set(slug, sanitizeDeprecationInfo(info as Record<string, unknown>, slug))
				}
			}
		}
	} catch {
		// File absent or unreadable — no persisted deprecation state.
	}
	return result
}

/** Keep only well-formed fields from a raw deprecation record. */
function sanitizeDeprecationInfo(raw: Record<string, unknown>, slug: string): ModelDeprecationInfo {
	const info: ModelDeprecationInfo = {}
	const deprecatedAt = validDateField(raw.deprecated_at, "deprecated_at", slug)
	if (deprecatedAt !== undefined) info.deprecated_at = deprecatedAt
	const sunsetAt = validDateField(raw.sunset_at, "sunset_at", slug)
	if (sunsetAt !== undefined) info.sunset_at = sunsetAt
	if (typeof raw.replacement_model === "string") info.replacement_model = raw.replacement_model
	if (Array.isArray(raw.alternatives)) {
		info.alternatives = raw.alternatives.filter(
			(a): a is ModelAlternative =>
				!!a && typeof a === "object" && !Array.isArray(a) && typeof (a as ModelAlternative).slug === "string",
		)
	}
	if (typeof raw.deprecation_note === "string") info.deprecation_note = raw.deprecation_note
	return info
}

function pickDeprecationFields(m: ModelDeprecationInfo & { slug?: string }): ModelDeprecationInfo | undefined {
	const info: ModelDeprecationInfo = {}
	const deprecatedAt = validDateField(m.deprecated_at, "deprecated_at", m.slug)
	if (deprecatedAt !== undefined) info.deprecated_at = deprecatedAt
	const sunsetAt = validDateField(m.sunset_at, "sunset_at", m.slug)
	if (sunsetAt !== undefined) info.sunset_at = sunsetAt
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
	// Atomic swap: concurrent readers (per-request ACP marker reads) must see
	// either the old file or the new one, never a half-written body.
	const target = modelDeprecationsPath(modelsJsonPath)
	const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
	writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(merged), null, "\t")}\n`, "utf-8")
	renameSync(tmp, target)
}
