/**
 * Role-based model configuration for multi-model orchestration.
 *
 * Five roles:
 *   - orchestrator: runs the main loop, delegates work
 *   - planner: designs the approach, writes specs (defaults to orchestrator)
 *   - builder: code implementation and research delegation
 *   - reviewer: code review
 *   - explorer: codebase exploration, reading files, tracing architecture
 *
 * Defaults to kimchi-dev OSS models. Users can override in
 * ~/.config/kimchi/harness/settings.json under the "modelRoles" key.
 * Supports any provider/model-id string (kimchi-dev, anthropic, openai, etc.).
 *
 * Example settings.json:
 * ```json
 * {
 *   "modelRoles": {
 *     "orchestrator": "anthropic/claude-sonnet-4-5",
 *     "planner": "anthropic/claude-sonnet-4-5",
 *     "builder": "anthropic/claude-sonnet-4-5",
 *     "reviewer": "kimchi-dev/minimax-m2.7",
 *     "explorer": "kimchi-dev/nemotron-3-super-fp4"
 *   }
 * }
 * ```
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface ModelRoles {
	/** Main model: runs the orchestrator loop, delegates work to other roles. */
	orchestrator: string
	/** Planning model: designs the approach, writes specs. Defaults to orchestrator. */
	planner: string
	/** Code implementation model: build and research delegation. */
	builder: string
	/** Code review model. */
	reviewer: string
	/** Codebase exploration model: reading files, tracing architecture, understanding code. */
	explorer: string
}

/** Kimchi-dev OSS defaults — used when no user config is present. */
export const DEFAULT_MODEL_ROLES: Readonly<ModelRoles> = {
	orchestrator: "kimchi-dev/kimi-k2.6",
	planner: "kimchi-dev/kimi-k2.6",
	builder: "kimchi-dev/minimax-m2.7",
	reviewer: "kimchi-dev/minimax-m2.7",
	explorer: "kimchi-dev/nemotron-3-super-fp4",
}

const ROLE_KEYS: readonly (keyof ModelRoles)[] = ["orchestrator", "planner", "builder", "reviewer", "explorer"]

const HARNESS_SETTINGS_PATH = join(homedir(), ".config", "kimchi", "harness", "settings.json")

export interface ModelRolesWarning {
	role: keyof ModelRoles
	configuredModel: string
	message: string
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

		if (typeof value !== "string" || value.trim().length === 0) {
			warnings.push({
				role: key,
				configuredModel: String(value),
				message: `modelRoles.${key} must be a non-empty string (e.g. "kimchi-dev/kimi-k2.6"). Using default.`,
			})
			continue
		}

		roles[key] = value.trim()
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

	// Only persist non-default values
	const rolesObj: Record<string, string> = {}
	for (const key of ROLE_KEYS) {
		if (roles[key] !== DEFAULT_MODEL_ROLES[key]) {
			rolesObj[key] = roles[key]
		}
	}

	if (Object.keys(rolesObj).length === 0) {
		// All defaults — remove the key entirely
		const { modelRoles: _, ...rest } = existing
		existing = rest
	} else {
		existing.modelRoles = rolesObj
	}

	const dir = dirname(path)
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
	writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`)

	// Invalidate the singleton cache so subsequent reads pick up the new values
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
 * Validate that each role's model exists in the set of available model IDs.
 * `availableModelIds` should be the set of model slugs from the API
 * (e.g. "kimi-k2.6", "minimax-m2.7"). Provider-prefixed refs are
 * split automatically.
 */
export function validateModelRoles(
	roles: ModelRoles,
	availableModelIds: ReadonlySet<string>,
): ModelRoleValidationResult {
	const unavailable: ModelRoleValidationResult["unavailable"] = []
	for (const key of ROLE_KEYS) {
		const ref = roles[key]
		const id = modelIdFromRef(ref)
		if (!availableModelIds.has(id)) {
			unavailable.push({ role: key, configuredModel: ref })
		}
	}
	return { unavailable }
}

// ---------------------------------------------------------------------------
// Singleton — resolved once at module load, reusable across the process
// ---------------------------------------------------------------------------

let _resolved: { roles: ModelRoles; warnings: ModelRolesWarning[] } | undefined

/** Get the resolved model roles (cached after first call). */
export function getModelRoles(): ModelRoles {
	_resolved ??= resolveModelRoles()
	return _resolved.roles
}

/** Get any warnings from resolving model roles (cached after first call). */
export function getModelRolesWarnings(): readonly ModelRolesWarning[] {
	_resolved ??= resolveModelRoles()
	return _resolved.warnings
}

/** Reset the cached model roles. Useful for tests. */
export function resetModelRolesCache(): void {
	_resolved = undefined
}
