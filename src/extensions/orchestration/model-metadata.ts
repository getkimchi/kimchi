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

import { MODEL_CAPABILITIES } from "./model-registry/builtin-models.js"
import type { ModelTier } from "./model-registry/types.js"

export interface ModelCustomMetadata {
	tier?: ModelTier
	description?: string
	vision?: boolean
}

const HARNESS_SETTINGS_PATH = join(homedir(), ".config", "kimchi", "harness", "settings.json")

/**
 * Strip provider prefix from a "provider/model-id" ref to get the model ID.
 * Returns the full string if no slash is present.
 */
function modelIdFromRef(ref: string): string {
	const slashIdx = ref.indexOf("/")
	return slashIdx >= 0 ? ref.slice(slashIdx + 1) : ref
}

/**
 * Load metadata from settings.json "modelMetadata" key.
 * Returns an empty map if the file is absent or the key is missing.
 * Entries with no valid fields are ignored.
 */
export function loadModelMetadata(settingsPath?: string): Map<string, ModelCustomMetadata> {
	const path = settingsPath ?? HARNESS_SETTINGS_PATH
	const result = new Map<string, ModelCustomMetadata>()

	try {
		const raw = readFileSync(path, "utf-8")
		const parsed = JSON.parse(raw)
		if (!parsed || typeof parsed !== "object") return result
		const meta = parsed.modelMetadata
		if (!meta || typeof meta !== "object" || Array.isArray(meta)) return result

		for (const [ref, value] of Object.entries(meta)) {
			if (typeof ref !== "string" || !ref.trim()) continue
			const entry = validateMetadataEntry(value)
			if (entry) result.set(ref.trim(), entry)
		}
	} catch {
		// settings.json absent or unreadable — return empty map
	}

	return result
}

function isModelTier(value: unknown): value is ModelTier {
	return value === "light" || value === "standard" || value === "heavy"
}

function validateMetadataEntry(value: unknown): ModelCustomMetadata | undefined {
	if (!value || typeof value !== "object") return undefined
	const obj = value as Record<string, unknown>

	const tier = obj.tier !== undefined && isModelTier(obj.tier) ? obj.tier : undefined
	const description = typeof obj.description === "string" ? obj.description : undefined
	const vision = typeof obj.vision === "boolean" ? obj.vision : undefined

	// Entry must have at least one valid field
	if (tier === undefined && description === undefined && vision === undefined) {
		return undefined
	}

	return { tier, description, vision }
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
	} catch {
		// absent or unreadable — start fresh
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
		_cached = loadModelMetadata(path)
		_cachedPath = path
	}
	// _cached is always set after the branch above (either previously or just now)
	return _cached ?? new Map()
}

export function getModelMetadataWarnings(): ReadonlyArray<{ ref: string; message: string }> {
	// Currently no warnings are generated during load, but the API exists
	// for future validation (e.g., unknown fields, type mismatches)
	_warnings ??= []
	return _warnings
}

export function resetModelMetadataCache(): void {
	_cached = undefined
	_warnings = undefined
	_cachedPath = undefined
}
