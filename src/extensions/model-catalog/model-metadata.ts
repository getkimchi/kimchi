/**
 * Standalone model metadata storage module.
 *
 * Stores custom metadata (tier, description, vision) keyed by model ref in
 * ~/.config/kimchi/harness/settings.json under the "modelMetadata" key.
 * This separates metadata from role assignments in modelRoles.
 *
 * Unified lookup: custom settings → builtin MODEL_CAPABILITIES → undefined
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { type Static, Type } from "typebox"
import { Value } from "typebox/value"

import { MODEL_CAPABILITIES } from "./builtin-models.js"
import { modelIdFromRef } from "./ref-utils.js"
import type { ModelTier } from "./types.js"

/**
 * TypeBox schema for the on-disk shape of a `modelMetadata` entry.
 *
 * All three fields are optional; an entry with none of them set is still
 * "shape-valid" but is dropped by {@link loadModelMetadata} (the whole entry
 * would carry no signal). `Value.Check` rejects entries whose fields have the
 * wrong runtime type — e.g. `tier: "mega"` — and the rejection is recorded as
 * a warning via {@link getModelMetadataWarnings}.
 */
const ModelTierSchema = Type.Union([Type.Literal("light"), Type.Literal("standard"), Type.Literal("heavy")])

const ModelCustomMetadataSchema = Type.Object({
	tier: Type.Optional(ModelTierSchema),
	description: Type.Optional(Type.String()),
	vision: Type.Optional(Type.Boolean()),
})

export type ModelCustomMetadata = Static<typeof ModelCustomMetadataSchema>

const HARNESS_SETTINGS_PATH = join(homedir(), ".config", "kimchi", "harness", "settings.json")

/**
 * Load metadata from settings.json "modelMetadata" key.
 *
 * Returns the loaded map plus a list of warnings for entries that failed
 * TypeBox validation (wrong field types, unrecognised tier, etc.). The caller
 * decides what to do with the warnings — the public API exposes them via
 * {@link getModelMetadataWarnings}. Returns an empty map + empty warnings when
 * the file is absent or the key is missing. Entries with no defined fields
 * after validation are silently dropped.
 */
export function loadModelMetadata(settingsPath?: string): {
	metadata: Map<string, ModelCustomMetadata>
	warnings: Array<{ ref: string; message: string }>
} {
	const path = settingsPath ?? HARNESS_SETTINGS_PATH
	const metadata = new Map<string, ModelCustomMetadata>()
	const warnings: Array<{ ref: string; message: string }> = []

	try {
		const raw = readFileSync(path, "utf-8")
		const parsed = JSON.parse(raw)
		if (!parsed || typeof parsed !== "object") return { metadata, warnings }
		const meta = parsed.modelMetadata
		if (!meta || typeof meta !== "object" || Array.isArray(meta)) return { metadata, warnings }

		for (const [ref, value] of Object.entries(meta)) {
			if (typeof ref !== "string" || !ref.trim()) continue
			const trimmed = ref.trim()
			const entry = validateMetadataEntry(value)
			if (entry) {
				metadata.set(trimmed, entry)
				continue
			}
			// Only record a warning if the entry looked like an object but failed
			// validation — nulls and primitives are silently ignored (they cannot
			// arise from well-behaved callers and would just be noise).
			if (value && typeof value === "object" && !Array.isArray(value)) {
				const errors = Value.Errors(ModelCustomMetadataSchema, value)
				const detail = errors.length > 0 ? `: ${errors[0].message}` : ""
				warnings.push({ ref: trimmed, message: `entry failed validation${detail}` })
			}
		}
	} catch {
		// settings.json absent or unreadable — return empty result
	}

	return { metadata, warnings }
}

function validateMetadataEntry(value: unknown): ModelCustomMetadata | undefined {
	if (!value || typeof value !== "object") return undefined
	if (!Value.Check(ModelCustomMetadataSchema, value)) return undefined
	const entry = value as ModelCustomMetadata
	// Entry must carry at least one defined field; otherwise it has no signal
	// and would clutter settings.json with empty rows that resolveModelMetadata
	// would ignore anyway.
	if (entry.tier === undefined && entry.description === undefined && entry.vision === undefined) {
		return undefined
	}
	return entry
}

/**
 * Save metadata to settings.json "modelMetadata" key, preserving other settings.
 * If the map is empty, the "modelMetadata" key is deleted.
 */
export function saveModelMetadata(metadata: Map<string, ModelCustomMetadata>, settingsPath?: string): void {
	const path = settingsPath ?? HARNESS_SETTINGS_PATH
	let existing: Record<string, unknown> = {}
	try {
		existing = JSON.parse(readFileSync(path, "utf-8"))
	} catch (err) {
		// Missing file is fine — start fresh. Anything else (corrupted JSON, read
		// error) is destructive to overwrite silently, so rethrow so the caller
		// can decide whether to surface the corruption instead of wiping the
		// user's other settings.
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
	}

	// Merge with existing modelMetadata so we don't wipe out other models
	const metaObj: Record<string, ModelCustomMetadata> =
		existing.modelMetadata && typeof existing.modelMetadata === "object" && !Array.isArray(existing.modelMetadata)
			? { ...(existing.modelMetadata as Record<string, ModelCustomMetadata>) }
			: {}

	if (metadata.size === 0) {
		// Delete the key if map is empty
		const { modelMetadata: _, ...rest } = existing
		existing = rest
	} else {
		for (const [ref, entry] of metadata.entries()) {
			const prev = metaObj[ref]
			metaObj[ref] = prev ? { ...prev, ...entry } : entry
		}
		existing.modelMetadata = metaObj
	}

	const dir = dirname(path)
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
	writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`)

	resetModelMetadataCache()
}

/**
 * Remove a single model's custom metadata from settings.json.
 * If the modelMetadata object becomes empty, the key is removed entirely.
 */
export function deleteModelMetadata(ref: string, settingsPath?: string): void {
	const path = settingsPath ?? HARNESS_SETTINGS_PATH
	let existing: Record<string, unknown> = {}
	try {
		existing = JSON.parse(readFileSync(path, "utf-8"))
	} catch {
		return
	}

	if (!existing.modelMetadata || typeof existing.modelMetadata !== "object" || Array.isArray(existing.modelMetadata)) {
		return
	}

	const metaObj = { ...(existing.modelMetadata as Record<string, ModelCustomMetadata>) }
	if (!(ref in metaObj)) return

	delete metaObj[ref]

	if (Object.keys(metaObj).length === 0) {
		const { modelMetadata: _, ...rest } = existing
		existing = rest
	} else {
		existing.modelMetadata = metaObj
	}

	writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`)
	resetModelMetadataCache()
}

/**
 * Unified lookup: settings metadata → builtin MODEL_CAPABILITIES → undefined
 * ref format: "provider/model-id". For builtin lookup, strip provider and use model ID.
 */
export function resolveModelMetadata(
	ref: string,
	settingsPath?: string,
): { source: "builtin" | "custom"; tier?: ModelTier; description?: string; vision?: boolean } | undefined {
	// 1. Check cached custom metadata for the exact ref
	const custom = getModelMetadata(settingsPath).get(ref)
	if (custom) {
		return { source: "custom", tier: custom.tier, description: custom.description, vision: custom.vision }
	}

	// 2. Check MODEL_CAPABILITIES — strip provider prefix to get model ID
	const modelId = modelIdFromRef(ref)
	const entry = MODEL_CAPABILITIES.get(modelId)
	if (entry && entry !== "ignored") {
		return {
			source: "builtin",
			tier: entry.tier,
			description: entry.description,
			vision: entry.vision,
		}
	}

	// 3. Return undefined if neither
	return undefined
}

/**
 * True if model has neither builtin nor custom metadata.
 */
export function isModelMetadataMissing(ref: string, settingsPath?: string): boolean {
	return resolveModelMetadata(ref, settingsPath) === undefined
}

// ---------------------------------------------------------------------------
// Singleton — resolved once at module load, reusable across the process
// ---------------------------------------------------------------------------

let _cached: ReadonlyMap<string, ModelCustomMetadata> | undefined
let _warnings: ReadonlyArray<{ ref: string; message: string }> | undefined
let _cachedPath: string | undefined

/**
 * Get cached model metadata, loading from the default settings path on first call.
 * If a settingsPath is provided and differs from the cached path, reloads.
 */
export function getModelMetadata(settingsPath?: string): ReadonlyMap<string, ModelCustomMetadata> {
	const path = settingsPath ?? HARNESS_SETTINGS_PATH
	if (_cachedPath !== path) {
		const loaded = loadModelMetadata(path)
		_cached = loaded.metadata
		_warnings = loaded.warnings
		_cachedPath = path
	}
	// _cached is always set after the branch above (either previously or just now)
	return _cached ?? new Map()
}

export function getModelMetadataWarnings(): ReadonlyArray<{ ref: string; message: string }> {
	_warnings ??= []
	return _warnings
}

export function resetModelMetadataCache(): void {
	_cached = undefined
	_warnings = undefined
	_cachedPath = undefined
}
