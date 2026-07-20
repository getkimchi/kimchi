/**
 * Role-based model configuration for multi-model orchestration.
 *
 *   - orchestrator: runs the main loop, delegates work (single model)
 *   - planner: designs the approach, writes specs
 *   - builder: code implementation
 *   - reviewer: code review
 *   - explorer: codebase exploration, reading files, tracing architecture
 *   - researcher: research beyond codebase — web search, documentation lookup
 *   - judge: ferment verification and final grading calls
 *   - compactor: context summarization model.
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
 *     "explorer": "kimchi-dev/deepseek-v4-flash",
 *     "judge": "kimchi-dev/kimi-k2.6",
 *     "compactor": "kimchi-dev/nemotron-3-ultra-fp4"
 *   }
 * }
 * ```
 */

import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import {
	getModelMetadata,
	type ModelCustomMetadata,
	resetModelMetadataCache as resetMetadataCache,
} from "./model-metadata.js"

export { modelIdFromRef, splitModelRef } from "./model-ref-utils.js"

import { readConfigSetting, writeConfigSetting } from "../../config/settings.js"
import { getProcessOrchestratorRef } from "../kimchi-process.js"
import { modelIdFromRef, splitModelRef } from "./model-ref-utils.js"

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
	/** Context summarization model. */
	compactor?: string
}

// "compactor" is excluded from these key types (not just omitted from the arrays):
// it's optional and single-model-only, so indexing roles[key] for key in ROLE_KEYS
// must stay narrowed to the always-present, non-optional role keys.
const DELEGABLE_ROLE_KEYS: readonly (keyof Omit<ModelRoles, "orchestrator" | "compactor">)[] = [
	"planner",
	"builder",
	"reviewer",
	"explorer",
	"researcher",
	"judge",
]
const ROLE_KEYS: readonly (keyof Omit<ModelRoles, "compactor">)[] = ["orchestrator", ...DELEGABLE_ROLE_KEYS]

/** Hardcoded default model-to-role assignment. Users override via /multi-model. */
export const DEFAULT_MODEL_ROLES: Readonly<ModelRoles> = {
	orchestrator: "kimchi-dev/glm-5.2-fp8",
	planner: ["kimchi-dev/kimi-k2.7"],
	builder: ["kimchi-dev/kimi-k2.7"],
	reviewer: ["kimchi-dev/kimi-k2.7", "kimchi-dev/claude-sonnet-5"],
	explorer: ["kimchi-dev/nemotron-3-ultra-fp4"],
	researcher: "kimchi-dev/glm-5.2-fp8",
	judge: "kimchi-dev/claude-opus-4-8",
	compactor: "kimchi-dev/glm-5.2-fp8",
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
export function parseModelRoles(obj: ModelRoles | Record<string, unknown> | undefined): {
	roles: ModelRoles
	warnings: ModelRolesWarning[]
} {
	const warnings: ModelRolesWarning[] = []
	const roles: ModelRoles = { ...DEFAULT_MODEL_ROLES }

	if (!obj) {
		return { roles, warnings }
	}

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

	// compactor is optional and single-model-only (like orchestrator), so it is
	// handled outside ROLE_KEYS rather than widening the generic loop's types.
	const compactorValue = obj.compactor
	if (compactorValue != null) {
		if (typeof compactorValue !== "string" || compactorValue.trim().length === 0) {
			warnings.push({
				role: "compactor",
				configuredModel: String(compactorValue),
				message: 'modelRoles.compactor must be a non-empty string (e.g. "kimchi-dev/nemotron-3-ultra-fp4"). Ignoring.',
			})
		} else {
			roles.compactor = compactorValue.trim()
		}
	}

	return { roles, warnings }
}

/**
 * Resolve model roles from settings.json, merged with defaults.
 * Missing or invalid entries fall back to DEFAULT_MODEL_ROLES.
 */
export function resolveModelRoles(): { roles: ModelRoles; warnings: ModelRolesWarning[] } {
	const value = readConfigSetting("modelRoles", (value): value is Record<string, unknown> => typeof value === "object")
	return parseModelRoles(value)
}

function isEqualRoleValue(a: RoleModelAssignment, b: RoleModelAssignment): boolean {
	if (typeof a === "string" && typeof b === "string") return a === b
	return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Save model roles to settings.json. Merges with existing settings,
 * only writing non-default values (omits keys that match DEFAULT_MODEL_ROLES).
 */
export function saveModelRoles(roles: ModelRoles): void {
	let rolesObj: Record<string, RoleModelAssignment> | undefined = {}
	for (const key of ROLE_KEYS) {
		if (!isEqualRoleValue(roles[key], DEFAULT_MODEL_ROLES[key])) {
			rolesObj[key] = roles[key]
		}
	}
	if (roles.compactor !== undefined && roles.compactor !== DEFAULT_MODEL_ROLES.compactor) {
		rolesObj.compactor = roles.compactor
	}

	if (Object.keys(rolesObj).length === 0) {
		rolesObj = undefined
	}

	writeConfigSetting("modelRoles", rolesObj)
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
	if (roles.compactor !== undefined && !availableModelIds.has(modelIdFromRef(roles.compactor))) {
		unavailable.push({ role: "compactor", configuredModel: roles.compactor })
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

/**
 * Collect every model ref referenced by any role (orchestrator, planner,
 * builder, reviewer, explorer, researcher, judge) into a de-duplicated,
 * deterministically sorted array. Normalization is limited to exact string
 * de-duplication; the configured case is preserved and ordering is fixed via
 * `.sort()` so the result is stable across calls.
 */
export function getAllowedMultiModelRefs(): string[] {
	const roles = getModelRoles()
	const refs = new Set<string>()
	for (const key of ROLE_KEYS) {
		const value = roles[key]
		if (Array.isArray(value)) {
			for (const ref of value) refs.add(ref)
		} else if (typeof value === "string" && value.length > 0) {
			refs.add(value)
		}
	}
	return Array.from(refs).sort()
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
	// compactor is excluded from ROLE_KEYS (optional, not part of the generic
	// loop's types — see the ROLE_KEYS comment), so it needs its own comparison.
	return a.compactor === b.compactor
}

/**
 * Orchestrator model ID (without provider prefix).
 * When sessionId is provided, reads from the per-session side-channel first,
 * falling back to the global model-roles config.
 */
export function getOrchestratorModelId(sessionId: string | null): string {
	if (sessionId !== null) {
		const ref = getProcessOrchestratorRef(sessionId)
		if (ref) return modelIdFromRef(ref)
	}
	return modelIdFromRef(getModelRoles().orchestrator)
}

/**
 * Orchestrator model reference (provider/model-id).
 * When sessionId is provided, reads from the per-session side-channel first,
 * falling back to the global model-roles config.
 */
export function getOrchestratorModelRef(sessionId: string | null): string {
	if (sessionId !== null) {
		const ref = getProcessOrchestratorRef(sessionId)
		if (ref) return ref
	}
	return getModelRoles().orchestrator
}

export function getOrchestratorModel(
	sessionId: string,
	modelRegistry: ModelRegistry,
): { model: Model<Api> | undefined; modelId: string; modelRef: string } {
	const orchRef = getOrchestratorModelRef(sessionId)
	const orchId = modelIdFromRef(orchRef)
	const parsed = splitModelRef(orchRef)
	return {
		model: parsed ? modelRegistry.find(parsed.provider, parsed.modelId) : undefined,
		modelId: orchId,
		modelRef: orchRef,
	}
}
