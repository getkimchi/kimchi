import { resolve } from "node:path"
import { AGENT_DEFINITIONS, discoverAgent } from "../../agent-discovery/index.js"
import { readJson } from "../../config/json.js"
import type { KimchiConfig } from "../../config.js"
import { getMultiModelEnabled } from "../multi-model.js"
import type { RoleModelAssignment } from "../orchestration/model-roles.js"
import { getModelRoles, normalizeRoleModels } from "../orchestration/model-roles.js"
import { PERMISSION_MODES, PERMISSIONS_ENV_KEY } from "../permissions/constants.js"
import type { PermissionMode } from "../permissions/types.js"

/**
 * Snapshot of the launch-time harness configuration emitted alongside the
 * `harness_launched` pre-session telemetry event.
 *
 * Every value is a primitive (string | number | boolean) so the object can be
 * spread directly into a `sendPreSessionEvent` properties payload — no nested
 * objects or arrays are leaked.
 */
export interface ConfigSnapshot {
	"config.model": string
	"config.provider": string
	"config.search_provider": string
	"config.telemetry_enabled": boolean
	"config.permission_mode": string
	"config.agents_enabled": boolean
	"config.mcp_server_count": number
	"config.multi_model_enabled": boolean
	"config.model_roles.orchestrator": string
	"config.model_roles.planner": string
	"config.model_roles.builder": string
	"config.model_roles.reviewer": string
	"config.model_roles.explorer": string
	"config.model_roles.researcher": string
	"config.model_roles.judge": string
}

/** Default provider for this harness. */
const DEFAULT_PROVIDER = "cast-ai"

/**
 * Parse pi's `settings.json` (under `KIMCHI_CODING_AGENT_DIR`) once.
 * Returns an empty record when the env var is unset or the file is
 * missing/unreadable/unparseable — callers fall back to defaults.
 */
function readAgentSettings(): Record<string, unknown> {
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	if (!agentDir) return {}
	try {
		return readJson(resolve(agentDir, "settings.json"))
	} catch {
		return {}
	}
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Active model id is only resolved into a single value during async session
 * init, so at launch time we best-effort read it from pi's `settings.json`.
 * Falls back to `"unknown"`; in-session events already carry the resolved
 * `currentModelId`.
 */
function resolveModel(settings: Record<string, unknown>): string {
	return asNonEmptyString(settings.model) ?? "unknown"
}

/**
 * Provider is Cast AI by default for this harness. Prefer an explicit
 * `provider` field in `settings.json` when present.
 */
function resolveProvider(settings: Record<string, unknown>): string {
	return asNonEmptyString(settings.provider) ?? DEFAULT_PROVIDER
}

/**
 * Permission mode as known at launch.
 *
 * `getPermissionMode(sessionId)` reflects the value cached by the permissions
 * extension, but that cache is only populated during session init — so at the
 * (pre-session) launch site it is not yet set. Fall back to the env-derived
 * mode (`KIMCHI_PERMISSIONS`), which is available synchronously at launch, and
 * finally to `"default"`.
 */
function getDefaultPermissionMode(): string {
	const envMode = process.env[PERMISSIONS_ENV_KEY]
	if (envMode && PERMISSION_MODES.includes(envMode as PermissionMode)) return envMode
	return "default"
}

/**
 * Count configured MCP servers across all known agent definitions.
 *
 * Mirrors the aggregate discovery already used by the setup/skills wizards
 * (`AGENT_DEFINITIONS.map(discoverAgent)`). Only the numeric count is
 * returned — server names are never leaked.
 */
function countMcpServers(): number {
	let count = 0
	for (const def of AGENT_DEFINITIONS) {
		count += Object.keys(discoverAgent(def).mcpServers).length
	}
	return count
}

/**
 * Serialize a role model assignment into a single primitive string so the
 * primitive-only snapshot invariant is preserved. A single model ref is
 * returned unchanged; an ordered candidate list is joined with commas.
 */
function serializeRole(value: RoleModelAssignment): string {
	return normalizeRoleModels(value).join(",")
}

/** Safe fallback snapshot returned when building fails. */
function fallbackSnapshot(telemetryEnabled: boolean): ConfigSnapshot {
	return {
		"config.model": "unknown",
		"config.provider": DEFAULT_PROVIDER,
		"config.search_provider": "unknown",
		"config.telemetry_enabled": telemetryEnabled,
		"config.permission_mode": "default",
		"config.agents_enabled": false,
		"config.mcp_server_count": 0,
		"config.multi_model_enabled": false,
		"config.model_roles.orchestrator": "unknown",
		"config.model_roles.planner": "unknown",
		"config.model_roles.builder": "unknown",
		"config.model_roles.reviewer": "unknown",
		"config.model_roles.explorer": "unknown",
		"config.model_roles.researcher": "unknown",
		"config.model_roles.judge": "unknown",
	}
}

/**
 * Build the launch-time config snapshot for the `harness_launched` event.
 *
 * `telemetryEnabled` is passed in explicitly because it originates from the
 * separate `TelemetryConfig` rather than `KimchiConfig`.
 *
 * Wraps all work in a try/catch so a failure in any helper (e.g.
 * `discoverAgent`) can never crash the CLI launch — returns a minimal safe
 * fallback snapshot on any error.
 */
export function buildConfigSnapshot(config: KimchiConfig, telemetryEnabled: boolean): ConfigSnapshot {
	try {
		const settings = readAgentSettings()
		const roles = getModelRoles()
		return {
			"config.model": resolveModel(settings),
			"config.provider": resolveProvider(settings),
			"config.search_provider": config.mcpSearch.strategy,
			"config.telemetry_enabled": telemetryEnabled,
			"config.permission_mode": getDefaultPermissionMode(),
			"config.agents_enabled": getMultiModelEnabled(null),
			"config.mcp_server_count": countMcpServers(),
			"config.multi_model_enabled": getMultiModelEnabled(null),
			"config.model_roles.orchestrator": serializeRole(roles.orchestrator),
			"config.model_roles.planner": serializeRole(roles.planner),
			"config.model_roles.builder": serializeRole(roles.builder),
			"config.model_roles.reviewer": serializeRole(roles.reviewer),
			"config.model_roles.explorer": serializeRole(roles.explorer),
			"config.model_roles.researcher": serializeRole(roles.researcher),
			"config.model_roles.judge": serializeRole(roles.judge),
		}
	} catch {
		return fallbackSnapshot(telemetryEnabled)
	}
}
