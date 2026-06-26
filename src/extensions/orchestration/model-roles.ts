/**
 * Role-based model configuration for multi-model orchestration.
 *
 * Seven roles:
 *   - orchestrator: runs the main loop, delegates work (single model)
 *   - planner: designs the approach, writes specs
 *   - builder: code implementation
 *   - reviewer: code review
 *   - explorer: codebase exploration, reading files, tracing architecture
 *   - researcher: research beyond codebase — web search, documentation lookup
 *   - judge: ferment verification and final grading calls
 *
 * Delegable roles (planner, builder, reviewer, explorer) accept either a
 * single model string or an array of candidates. When multiple models are
 * assigned, the orchestrator selects the best fit based on tier and task
 * complexity.
 *
 * Model metadata (tier, description, vision) is stored separately in the
 * "modelMetadata" key of settings.json — see model-metadata.ts.
 *
 * Defaults are hardcoded in DEFAULT_MODEL_ROLES.
 *
 * Users can override in ~/.config/kimchi/harness/settings.json under the
 * "modelRoles" key. Supports any provider/model-id string.
 *
 * Example settings.json:
 * ```json
 * {
 *   "modelRoles": {
 *     "orchestrator": "anthropic/claude-sonnet-4-5",
 *     "builder": ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"],
 *     "reviewer": "kimchi-dev/minimax-m2.7",
 *     "explorer": "kimchi-dev/nemotron-3-ultra-fp4",
 *     "judge": "kimchi-dev/kimi-k2.6"
 *   }
 * }
 * ```
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import {
	type ModelCustomMetadata,
	getModelMetadata,
	resetModelMetadataCache as resetMetadataCache,
} from "./model-metadata.js"
export { modelIdFromRef, splitModelRef } from "./model-ref-utils.js"
import { modelIdFromRef } from "./model-ref-utils.js"

/** Task-type affinity tag used to match an agent persona to a model role. */
export type ModelRole = "review" | "build" | "plan" | "explore" | "research"

/** Model assignment for a role: single model ref or ordered list of candidates. */
export type RoleModelAssignment = string | string[]

export interface ModelRoles {
	/** Main model: runs the orchestrator loop, delegates work to other roles. */
	orchestrator: string
	/** Planning model(s): designs the approach, writes specs. */
	planner: RoleModelAssignment
	/** Code implementation model(s). */
	builder: RoleModelAssignment
	/** Code review model(s). */
	reviewer: RoleModelAssignment
	/** Codebase exploration model(s). */
	explorer: RoleModelAssignment
	/** Research model(s): research beyond codebase — web search, documentation lookup, external sources. */
	researcher: RoleModelAssignment
	/** Ferment judge model(s): verification triage and final grading calls. */
	judge: RoleModelAssignment
}

const DELEGABLE_ROLE_KEYS: readonly (keyof Omit<ModelRoles, "orchestrator">)[] = [
	"planner",
	"builder",
	"reviewer",
	"explorer",
	"researcher",
	"judge",
]
const ROLE_KEYS: readonly (keyof ModelRoles)[] = ["orchestrator", ...DELEGABLE_ROLE_KEYS]

const HARNESS_SETTINGS_PATH = join(homedir(), ".config", "kimchi", "harness", "settings.json")

/** Hardcoded default model-to-role assignment. Users override via /multi-model. */
export const DEFAULT_MODEL_ROLES: Readonly<ModelRoles> = {
	orchestrator: "kimchi-dev/kimi-k2.7",
	planner: "kimchi-dev/kimi-k2.7",
	builder: ["kimchi-dev/minimax-m3"],
	reviewer: ["kimchi-dev/kimi-k2.7"],
	explorer: "kimchi-dev/nemotron-3-ultra-fp4",
	researcher: "kimchi-dev/minimax-m3",
	judge: ["kimchi-dev/kimi-k2.7"],
}

export interface ModelRolesWarning {
	role: keyof ModelRoles
	configuredModel: string
	message: string
}

/** Normalize a role value to an array of model refs. */
export function normalizeRoleModels(value: RoleModelAssignment): string[] {
	if (Array.isArray(value)) return value
	return [value]
}

function isValidRoleValue(value: unknown): value is RoleModelAssignment {
	if (typeof value === "string" && value.trim().length > 0) return true
	if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && v.trim().length > 0))
		return true
	return false
}

function trimRoleValue(value: string | string[]): RoleModelAssignment {
	if (typeof value === "string") return value.trim()
	return value.map((v) => v.trim())
}

/**
 * Parse and validate raw modelRoles from settings.json.
 * Returns a validated ModelRoles merged with defaults, plus any warnings.
 */
export function parseModelRoles(raw: unknown): { roles: ModelRoles; warnings: ModelRolesWarning[] } {
	const warnings: ModelRolesWarning[] = []
	const roles: ModelRoles = { ...DEFAULT_MODEL_ROLES }

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { roles, warnings }
	}

	const obj = raw as Record<string, unknown>

	for (const key of ROLE_KEYS) {
		const value = obj[key]
		if (value === undefined || value === null) continue

		if (key === "orchestrator") {
			if (typeof value !== "string" || value.trim().length === 0) {
				warnings.push({
					role: key,
					configuredModel: String(value),
					message: `modelRoles.${key} must be a non-empty string (e.g. "kimchi-dev/kimi-k2.6"). Using default.`,
				})
				continue
			}
			roles[key] = value.trim()
		} else {
			if (!isValidRoleValue(value)) {
				warnings.push({
					role: key,
					configuredModel: String(value),
					message: `modelRoles.${key} must be a non-empty string or array of strings. Using default.`,
				})
				continue
			}
			roles[key] = trimRoleValue(value as string | string[])
		}
	}

	return { roles, warnings }
}

/**
 * Resolve model roles from settings.json, merged with defaults.
 * Missing or invalid entries fall back to DEFAULT_MODEL_ROLES.
 */
export function resolveModelRoles(settingsPath?: string): { roles: ModelRoles; warnings: ModelRolesWarning[] } {
	const path = settingsPath ?? HARNESS_SETTINGS_PATH
	try {
		const raw = readFileSync(path, "utf-8")
		const parsed = JSON.parse(raw)
		if (parsed && typeof parsed === "object" && "modelRoles" in parsed) {
			return parseModelRoles(parsed.modelRoles)
		}
	} catch {
		// settings.json absent or unreadable — use defaults
	}
	return { roles: { ...DEFAULT_MODEL_ROLES }, warnings: [] }
}

function isEqualRoleValue(a: RoleModelAssignment, b: RoleModelAssignment): boolean {
	if (typeof a === "string" && typeof b === "string") return a === b
	return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Save model roles to settings.json. Merges with existing settings,
 * only writing non-default values (omits keys that match DEFAULT_MODEL_ROLES).
 */
export function saveModelRoles(roles: ModelRoles, settingsPath?: string): void {
	const path = settingsPath ?? HARNESS_SETTINGS_PATH
	let existing: Record<string, unknown> = {}
	try {
		existing = JSON.parse(readFileSync(path, "utf-8"))
	} catch {
		// absent or unreadable — start fresh
	}

	const rolesObj: Record<string, RoleModelAssignment> = {}
	for (const key of ROLE_KEYS) {
		if (!isEqualRoleValue(roles[key], DEFAULT_MODEL_ROLES[key])) {
			rolesObj[key] = roles[key]
		}
	}

	if (Object.keys(rolesObj).length === 0) {
		const { modelRoles: _, ...rest } = existing
		existing = rest
	} else {
		existing.modelRoles = rolesObj
	}

	const dir = dirname(path)
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
	writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`)

	resetModelRolesCache()
	resetMetadataCache()
}

// ---------------------------------------------------------------------------
// Validation against available models
// ---------------------------------------------------------------------------

export function extractCustomConfigs(
	_roles: ModelRoles,
	overrides?: ReadonlyMap<string, ModelCustomMetadata>,
): ReadonlyMap<string, ModelCustomMetadata> {
	return overrides ?? getModelMetadata()
}

export interface ModelRoleValidationResult {
	/** Roles whose configured model is not available in the API. */
	unavailable: { role: keyof ModelRoles; configuredModel: string }[]
}

/**
 * Validate that each role's model(s) exist in the set of available model IDs.
 */
export function validateModelRoles(
	roles: ModelRoles,
	availableModelIds: ReadonlySet<string>,
): ModelRoleValidationResult {
	const unavailable: ModelRoleValidationResult["unavailable"] = []
	for (const key of ROLE_KEYS) {
		const refs = normalizeRoleModels(roles[key])
		for (const ref of refs) {
			const id = modelIdFromRef(ref)
			if (!availableModelIds.has(id)) {
				unavailable.push({ role: key, configuredModel: ref })
			}
		}
	}
	return { unavailable }
}

// ---------------------------------------------------------------------------
// Singleton — resolved once at module load, reusable across the process
// ---------------------------------------------------------------------------

let _resolved: { roles: ModelRoles; warnings: ModelRolesWarning[] } | undefined

export function getModelRoles(): ModelRoles {
	_resolved ??= resolveModelRoles()
	return _resolved.roles
}

export function getModelRolesWarnings(): readonly ModelRolesWarning[] {
	_resolved ??= resolveModelRoles()
	return _resolved.warnings
}

export function resetModelRolesCache(): void {
	_resolved = undefined
}

/** Apply a post-resolution transform to the model roles singleton.
 *  If the cache is already populated, the transform runs against the cached
 *  roles; otherwise it runs against a fresh `resolveModelRoles()` result and
 *  the augmented value becomes the cached value. This is the hook extension
 *  authors (e.g. Ollama auto-discovery) should use to add runtime-discovered
 *  models to role pools without touching settings.json on disk.
 *
 *  The transform must be pure and idempotent — it may be called multiple
 *  times across the lifetime of the process (e.g. after a cache reset). */
export function applyRoleAugmentation(transform: (roles: ModelRoles) => ModelRoles): void {
	const base = _resolved ?? resolveModelRoles()
	const augmented = transform(base.roles)
	if (!isEqualModelRoles(augmented, base.roles)) {
		_resolved = { roles: augmented, warnings: base.warnings }
	}
}

function isEqualModelRoles(a: ModelRoles, b: ModelRoles): boolean {
	for (const key of ROLE_KEYS) {
		if (!isEqualRoleValue(a[key], b[key])) return false
	}
	return true
}
