import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { getVersion } from "./utils.js"

const KIMCHI_CONFIG_PATH = resolve(homedir(), ".config", "kimchi", "config.json")
const AGENT_CONFIG_DIR = resolve(homedir(), ".config", "kimchi", "harness")
const CAST_AI_LLM_ENDPOINT = "https://llm.cast.ai/openai/v1"
const DEFAULT_TELEMETRY_LOGS_ENDPOINT = "https://api.cast.ai/ai-optimizer/v1beta/logs:ingest"
const DEFAULT_TELEMETRY_METRICS_ENDPOINT = "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest"

export const ALWAYS_SHOWN_SKILL_PATHS = [join(".config", "kimchi", "harness", "skills")]

export const OPTIONAL_SKILL_PATHS = [join(".pi", "agent", "skills"), join(".claude", "skills")]

export const envConfig = {
	KIMCHI_WEB_APP_URL: process.env.KIMCHI_WEB_APP_URL ?? "https://app.kimchi.dev",
}

export const DEFAULT_SKILL_PATHS = [...ALWAYS_SHOWN_SKILL_PATHS, ...OPTIONAL_SKILL_PATHS]

export function buildSkillPathOptions(discoveredDirs: string[]): string[] {
	const home = homedir()
	const toRelative = (abs: string): string => (abs === home || abs.startsWith(`${home}/`) ? relative(home, abs) : abs)

	const seen = new Set<string>()
	const result: string[] = []

	for (const p of ALWAYS_SHOWN_SKILL_PATHS) {
		seen.add(p)
		result.push(p)
	}

	for (const p of OPTIONAL_SKILL_PATHS) {
		if (!seen.has(p) && existsSync(join(home, p))) {
			seen.add(p)
			result.push(p)
		}
	}

	for (const abs of discoveredDirs) {
		const rel = toRelative(abs)
		if (!seen.has(rel) && existsSync(abs)) {
			seen.add(rel)
			result.push(rel)
		}
	}

	return result
}

export interface TelemetryConfig {
	enabled: boolean
	endpoint: string
	metricsEndpoint: string
	headers: Record<string, string>
}

export interface SearchStrategyConfig {
	strategy: "bm25" | "regex"
	bm25K1: number
	bm25B: number
	fieldWeights: { name: number; description: number; schemaKey: number }
}

export type OnboardingConfig = Record<string, unknown>

export const SEARCH_STRATEGY_DEFAULTS: SearchStrategyConfig = {
	strategy: "bm25",
	bm25K1: 1.2,
	bm25B: 0.75,
	fieldWeights: { name: 6, description: 2, schemaKey: 1 },
}

export type MigrationState = "done" | "skip-forever"

export interface KimchiConfig {
	apiKey: string
	agentConfigDir: string
	llmEndpoint: string
	maxToolResultChars: number
	mcpSearchLimit: number
	mcpSearch: SearchStrategyConfig
	skillPaths?: string[]
	migrationState?: MigrationState
	onboarding: OnboardingConfig
	deviceId: string
}

/**
 * Read the Cast AI API key from the kimchi CLI config file.
 * Returns undefined if the file doesn't exist or the field is missing.
 */
export function readApiKeyFromConfigFile(configPath: string = KIMCHI_CONFIG_PATH): string | undefined {
	try {
		const raw = readFileSync(configPath, "utf-8")
		const parsed = JSON.parse(raw)
		if (typeof parsed.apiKey === "string" && parsed.apiKey.length > 0) {
			return parsed.apiKey
		}
		if (typeof parsed.api_key === "string" && parsed.api_key.length > 0) {
			return parsed.api_key
		}
		return undefined
	} catch {
		return undefined
	}
}

function readConfigExtras(configPath: string): {
	apiKey?: string
	llmEndpoint?: string
	maxToolResultChars?: number
	mcpSearchLimit?: number
	mcpSearch?: Partial<SearchStrategyConfig>
	skillPaths?: string[]
	migrationState?: MigrationState
	onboarding?: OnboardingConfig
	deviceId?: string
} {
	try {
		const raw = readFileSync(configPath, "utf-8")
		const parsed = JSON.parse(raw)
		const maxToolResultChars =
			typeof parsed.maxToolResultChars === "number" && parsed.maxToolResultChars > 0
				? parsed.maxToolResultChars
				: undefined
		const mcpSearchLimit =
			typeof parsed.mcpSearchLimit === "number" && parsed.mcpSearchLimit > 0 ? parsed.mcpSearchLimit : undefined
		let mcpSearch: Partial<SearchStrategyConfig> | undefined
		const s = parsed.mcpSearch
		if (s && typeof s === "object") {
			mcpSearch = {
				...(s.strategy === "bm25" || s.strategy === "regex" ? { strategy: s.strategy } : {}),
				...(typeof s.bm25K1 === "number" ? { bm25K1: s.bm25K1 } : {}),
				...(typeof s.bm25B === "number" ? { bm25B: s.bm25B } : {}),
				...(s.fieldWeights && typeof s.fieldWeights === "object"
					? {
							fieldWeights: {
								name:
									typeof s.fieldWeights.name === "number"
										? s.fieldWeights.name
										: SEARCH_STRATEGY_DEFAULTS.fieldWeights.name,
								description:
									typeof s.fieldWeights.description === "number"
										? s.fieldWeights.description
										: SEARCH_STRATEGY_DEFAULTS.fieldWeights.description,
								schemaKey:
									typeof s.fieldWeights.schemaKey === "number"
										? s.fieldWeights.schemaKey
										: SEARCH_STRATEGY_DEFAULTS.fieldWeights.schemaKey,
							},
						}
					: {}),
			}
		}
		const skillPaths =
			Array.isArray(parsed.skillPaths) && parsed.skillPaths.every((p: unknown) => typeof p === "string")
				? (parsed.skillPaths as string[])
				: undefined
		const migrationState =
			parsed.migrationState === "done" || parsed.migrationState === "skip-forever"
				? (parsed.migrationState as MigrationState)
				: undefined
		const onboarding: OnboardingConfig = {}
		// Read apiKey (prefer camelCase, fall back to snake_case)
		let apiKey: string | undefined
		if (typeof parsed.apiKey === "string" && parsed.apiKey.length > 0) {
			apiKey = parsed.apiKey
		} else if (typeof parsed.api_key === "string" && parsed.api_key.length > 0) {
			apiKey = parsed.api_key
		}

		// Read llmEndpoint
		const llmEndpoint =
			typeof parsed.llmEndpoint === "string" && parsed.llmEndpoint.length > 0 ? parsed.llmEndpoint : undefined

		// Read deviceId (camelCase, then snake_case for backwards compat)
		const deviceId =
			(typeof parsed.deviceId === "string" && parsed.deviceId.length > 0 && parsed.deviceId) ||
			(typeof parsed.device_id === "string" && parsed.device_id.length > 0 && parsed.device_id) ||
			undefined

		return {
			apiKey,
			llmEndpoint,
			maxToolResultChars,
			mcpSearchLimit,
			mcpSearch,
			skillPaths,
			migrationState,
			onboarding,
			deviceId,
		}
	} catch {
		return {}
	}
}

function readConfigObject(configPath: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf-8"))
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>
		}
	} catch {
		// file missing or invalid
	}
	return undefined
}

/**
 * Read telemetry configuration from config.json without requiring an API key.
 * Safe to call before authentication is set up.
 *
 * Telemetry is disabled by default. It is enabled when:
 *   - KIMCHI_TELEMETRY_ENABLED env var is set to a truthy value, or
 *   - config.json has telemetry.enabled = true
 *
 * Auth header resolution order:
 *   1. telemetry.headers in config.json (explicit override)
 *   2. KIMCHI_API_KEY env var → Authorization: Bearer <key>
 *   3. api_key in config.json → Authorization: Bearer <key>
 */
export function readTelemetryConfig(configPath?: string): TelemetryConfig {
	const path = configPath ?? KIMCHI_CONFIG_PATH
	const envEnabled = process.env.KIMCHI_TELEMETRY_ENABLED
	let fileEnabled: boolean | undefined
	let fileEndpoint: string | undefined
	let fileMetricsEndpoint: string | undefined
	let fileHeaders: Record<string, string> | undefined

	try {
		const raw = readFileSync(path, "utf-8")
		const parsed = JSON.parse(raw)
		const t = parsed.telemetry
		if (t && typeof t === "object") {
			if (typeof t.enabled === "boolean") fileEnabled = t.enabled
			if (typeof t.endpoint === "string" && t.endpoint.length > 0) fileEndpoint = t.endpoint
			if (typeof t.metricsEndpoint === "string" && t.metricsEndpoint.length > 0) fileMetricsEndpoint = t.metricsEndpoint
			if (t.headers && typeof t.headers === "object" && !Array.isArray(t.headers)) {
				fileHeaders = t.headers as Record<string, string>
			}
		}
	} catch {
		// missing or invalid config — use defaults
	}

	// Resolve auth headers: explicit config override takes priority, then API key
	let headers: Record<string, string>
	let apiKey: string | undefined
	if (fileHeaders) {
		headers = fileHeaders
	} else {
		apiKey =
			(typeof process.env.KIMCHI_API_KEY === "string" && process.env.KIMCHI_API_KEY.length > 0
				? process.env.KIMCHI_API_KEY
				: undefined) ?? readApiKeyFromConfigFile(path)
		headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
	}

	// Enabled by default when an API key is available; explicit config/env overrides either way
	const defaultEnabled = fileHeaders ? Object.keys(fileHeaders).length > 0 : !!apiKey
	const enabled =
		envEnabled !== undefined ? envEnabled !== "0" && envEnabled !== "false" : (fileEnabled ?? defaultEnabled)

	// Always inject a User-Agent so telemetry is traceable on the server side.
	const hasUserAgent = Object.keys(headers).some((k) => k.toLowerCase() === "user-agent")
	if (!hasUserAgent) {
		headers["User-Agent"] = `kimchi/${getVersion()}`
	}

	return {
		enabled,
		endpoint: fileEndpoint ?? DEFAULT_TELEMETRY_LOGS_ENDPOINT,
		metricsEndpoint: fileMetricsEndpoint ?? DEFAULT_TELEMETRY_METRICS_ENDPOINT,
		headers,
	}
}

/**
 * Load the kimchi configuration.
 *
 * Config precedence (highest to lowest):
 *   1. KIMCHI_API_KEY environment variable (highest precedence)
 *   2. Project .kimchi/config.json (if cwd provided)
 *   3. Global ~/.config/kimchi/config.json
 *
 * For mcpSearch, a shallow merge is performed: project config overrides
 * individual keys, but global fills in any missing keys.
 * For all other fields, project config completely replaces global.
 *
 * Returns `apiKey: ""` when no API key is present in either config file.
 */
export function loadConfig(options?: { configPath?: string; cwd?: string }): KimchiConfig {
	// Read global config
	const globalConfigPath = options?.configPath ?? KIMCHI_CONFIG_PATH
	const globalExtras = readConfigExtras(globalConfigPath)

	// Read project-level config
	const projectPath = resolve(options?.cwd ?? process.cwd(), ".kimchi", "config.json")
	const projectExtras = readConfigExtras(projectPath)

	// Merge: project wins for scalars; shallow merge for mcpSearch
	const extras = {
		apiKey: projectExtras.apiKey ?? globalExtras.apiKey,
		llmEndpoint: projectExtras.llmEndpoint ?? globalExtras.llmEndpoint,
		maxToolResultChars: projectExtras.maxToolResultChars ?? globalExtras.maxToolResultChars,
		mcpSearchLimit: projectExtras.mcpSearchLimit ?? globalExtras.mcpSearchLimit,
		mcpSearch: { ...globalExtras.mcpSearch, ...projectExtras.mcpSearch },
		skillPaths: projectExtras.skillPaths ?? globalExtras.skillPaths,
		migrationState: projectExtras.migrationState ?? globalExtras.migrationState,
		onboarding: globalExtras.onboarding,
		deviceId: projectExtras.deviceId ?? globalExtras.deviceId,
	}

	return {
		apiKey: extras.apiKey ?? "",
		agentConfigDir: AGENT_CONFIG_DIR,
		llmEndpoint: extras.llmEndpoint ?? CAST_AI_LLM_ENDPOINT,
		maxToolResultChars: extras.maxToolResultChars ?? 10_000,
		mcpSearchLimit: extras.mcpSearchLimit ?? 5,
		mcpSearch: { ...SEARCH_STRATEGY_DEFAULTS, ...extras.mcpSearch },
		skillPaths: extras.skillPaths,
		migrationState: extras.migrationState,
		onboarding: extras.onboarding ?? {},
		deviceId: extras.deviceId ?? "",
	}
}

export function getAgentConfigDir(): string {
	return AGENT_CONFIG_DIR
}

function writeConfigObject(configPath: string, raw: Record<string, unknown>): void {
	mkdirSync(dirname(configPath), { recursive: true })
	const tmp = `${configPath}.${process.pid}.tmp`
	writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, "utf-8")
	renameSync(tmp, configPath)
}

function updateConfigFile(
	configPath: string,
	update: (raw: Record<string, unknown>) => void,
	options?: { createIfMissing?: boolean },
): void {
	const raw = readConfigObject(configPath)
	if (!raw && options?.createIfMissing === false) return
	const next = raw ?? {}
	update(next)
	writeConfigObject(configPath, next)
}

function writeConfigField(key: string, value: unknown, configPath: string): void {
	updateConfigFile(configPath, (raw) => {
		raw[key] = value
	})
}

export function writeMigrationState(state: MigrationState, configPath?: string): void {
	writeConfigField("migrationState", state, configPath ?? KIMCHI_CONFIG_PATH)
}

export function writeSkillPaths(paths: string[], configPath?: string): void {
	writeConfigField("skillPaths", paths, configPath ?? KIMCHI_CONFIG_PATH)
}

export function writeApiKey(key: string, configPath?: string): void {
	const path = configPath ?? KIMCHI_CONFIG_PATH
	updateConfigFile(path, (raw) => {
		raw.apiKey = key
		// Clear legacy snake_case key so we don't keep stale data
		// biome-ignore lint/performance/noDelete: explicit removal is clearer than relying on JSON.stringify to silently drop undefined values
		delete raw.api_key
	})
}

export function writeDeviceId(id: string, configPath?: string): void {
	const path = configPath ?? KIMCHI_CONFIG_PATH
	updateConfigFile(path, (raw) => {
		raw.deviceId = id
		// Clear legacy snake_case key so we don't keep stale data
		// biome-ignore lint/performance/noDelete: explicit removal is clearer than relying on JSON.stringify to silently drop undefined values
		delete raw.device_id
	})
}

/**
 * Persist telemetry.enabled in the kimchi config.json. Used by
 * `kimchi config telemetry on|off`. The reader (readTelemetryConfig) already
 * honours an env-var override, so this is a no-op for sessions where
 * KIMCHI_TELEMETRY_ENABLED is set — but the persisted value is still useful
 * for fresh shells.
 */
export function writeTelemetryEnabled(enabled: boolean, configPath?: string): void {
	const path = configPath ?? KIMCHI_CONFIG_PATH
	updateConfigFile(path, (raw) => {
		const t = (raw.telemetry as Record<string, unknown> | undefined) ?? {}
		t.enabled = enabled
		raw.telemetry = t
	})
}

export function clearApiKey(configPath?: string): void {
	const path = configPath ?? KIMCHI_CONFIG_PATH
	updateConfigFile(
		path,
		(raw) => {
			// biome-ignore lint/performance/noDelete: explicit removal is clearer than relying on JSON.stringify to silently drop undefined values
			delete raw.apiKey
			// biome-ignore lint/performance/noDelete: explicit removal is clearer than relying on JSON.stringify to silently drop undefined values
			delete raw.api_key
		},
		{ createIfMissing: false },
	)
}

/**
 * Read a stored git token for a specific host from the global config.
 * Tokens are stored under `gitTokens.<host>` (e.g. `gitTokens["github.com"]`).
 */
export function readGitToken(host: string, configPath?: string): string | undefined {
	const path = configPath ?? KIMCHI_CONFIG_PATH
	try {
		const raw = readFileSync(path, "utf-8")
		const parsed = JSON.parse(raw)
		const tokens = parsed.gitTokens
		if (tokens && typeof tokens === "object" && !Array.isArray(tokens)) {
			const token = (tokens as Record<string, unknown>)[host]
			if (typeof token === "string" && token.length > 0) {
				return token
			}
		}
		return undefined
	} catch {
		return undefined
	}
}

/**
 * Persist a git token for a specific host in the global config.
 * Stored under `gitTokens.<host>` alongside the API key, following the same
 * security model (plaintext in `~/.config/kimchi/config.json`).
 */
export function writeGitToken(host: string, token: string, configPath?: string): void {
	const path = configPath ?? KIMCHI_CONFIG_PATH
	updateConfigFile(path, (raw) => {
		const gitTokens =
			raw.gitTokens && typeof raw.gitTokens === "object" && !Array.isArray(raw.gitTokens)
				? { ...(raw.gitTokens as Record<string, unknown>) }
				: {}
		gitTokens[host] = token
		raw.gitTokens = gitTokens
	})
}
