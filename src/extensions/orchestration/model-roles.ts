/**
 * Role-based model configuration for multi-model orchestration.
 *
 * Six roles:
 *   - orchestrator: runs the main loop, delegates work (single model)
 *   - planner: designs the approach, writes specs
 *   - builder: code implementation
 *   - reviewer: code review
 *   - explorer: codebase exploration, reading files, tracing architecture
 *   - judge: ferment verification and final grading calls
 *
 * Delegable roles (planner, builder, reviewer, explorer) accept either a
 * single model string or an array of candidates. When multiple models are
 * assigned, the orchestrator selects the best fit based on tier and task
 * complexity.
 *
 * Defaults are derived from MODEL_CAPABILITIES — each model's `roles` field
 * determines which role pools it belongs to.
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

import { MODEL_CAPABILITIES } from "./model-registry/builtin-models.js"
import { KIMCHI_DEV_PROVIDER } from "./model-registry/model-registry.js"

/** Model assignment for a role: single model or ordered list of candidates. */
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
	/** Ferment judge model(s): verification triage and final grading calls. */
	judge: RoleModelAssignment
}

const DELEGABLE_ROLE_KEYS: readonly (keyof Omit<ModelRoles, "orchestrator">)[] = [
	"planner",
	"builder",
	"reviewer",
	"explorer",
	"judge",
]
const ROLE_KEYS: readonly (keyof ModelRoles)[] = ["orchestrator", ...DELEGABLE_ROLE_KEYS]

const HARNESS_SETTINGS_PATH = join(homedir(), ".config", "kimchi", "harness", "settings.json")

/**
 * Build default model roles by scanning MODEL_CAPABILITIES.
 *
 * Each non-ignored model is placed into role pools matching its `roles` field.
 * The orchestrator is the heaviest model with the "plan" role.
 */
export function buildDefaultModelRoles(): ModelRoles {
	const planners: string[] = []
	const builders: string[] = []
	const reviewers: string[] = []
	const explorers: string[] = []

	let orchestrator: string | undefined

	for (const [id, entry] of MODEL_CAPABILITIES.entries()) {
		if (entry === "ignored") continue
		const ref = `${KIMCHI_DEV_PROVIDER}/${id}`

		if (entry.roles.includes("plan")) {
			planners.push(ref)
			if (entry.tier === "heavy" && !orchestrator) {
				orchestrator = ref
			}
		}
		if (entry.roles.includes("build")) builders.push(ref)
		if (entry.roles.includes("review")) reviewers.push(ref)
		if (entry.roles.includes("explore") || entry.roles.includes("research")) {
			if (!explorers.includes(ref)) explorers.push(ref)
		}
	}

	const orch = orchestrator ?? `${KIMCHI_DEV_PROVIDER}/kimi-k2.6`

	const toAssignment = (arr: string[], fallback: string): string | string[] =>
		arr.length === 1 ? arr[0] : arr.length > 0 ? arr : fallback

	return {
		orchestrator: orch,
		planner: toAssignment(planners, orch),
		builder: toAssignment(builders, orch),
		reviewer: toAssignment(reviewers, orch),
		explorer: toAssignment(explorers, orch),
		judge: orch,
	}
}

/** Default roles derived from MODEL_CAPABILITIES. */
export const DEFAULT_MODEL_ROLES: Readonly<ModelRoles> = buildDefaultModelRoles()

export interface ModelRolesWarning {
	role: keyof ModelRoles
	configuredModel: string
	message: string
}

/** Normalize a role value to an array of model refs. */
export function normalizeRoleModels(value: RoleModelAssignment): string[] {
	return Array.isArray(value) ? value : [value]
}

function isValidRoleValue(value: unknown): value is string | string[] {
	if (typeof value === "string" && value.trim().length > 0) return true
	if (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((v) => typeof v === "string" && (v as string).trim().length > 0)
	)
		return true
	return false
}

function trimRoleValue(value: string | string[]): string | string[] {
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
	const arrA = normalizeRoleModels(a)
	const arrB = normalizeRoleModels(b)
	return arrA.length === arrB.length && arrA.every((v, i) => v === arrB[i])
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

	const rolesObj: Record<string, string | string[]> = {}
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
}

/**
 * Extract provider and model ID from a "provider/model-id" string.
 * Returns undefined if the string doesn't contain a slash.
 */
export function splitModelRef(ref: string): { provider: string; modelId: string } | undefined {
	const slashIdx = ref.indexOf("/")
	if (slashIdx <= 0) return undefined
	return {
		provider: ref.slice(0, slashIdx),
		modelId: ref.slice(slashIdx + 1),
	}
}

/**
 * Extract just the model ID from a "provider/model-id" string.
 * Returns the full string if no slash is present.
 */
export function modelIdFromRef(ref: string): string {
	const slashIdx = ref.indexOf("/")
	return slashIdx >= 0 ? ref.slice(slashIdx + 1) : ref
}

// ---------------------------------------------------------------------------
// Validation against available models
// ---------------------------------------------------------------------------

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
