import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import type { RetrySettings } from "@earendil-works/pi-coding-agent"
import { getVersion } from "./utils.js"

const KIMCHI_CONFIG_PATH = resolve(homedir(), ".config", "kimchi", "config.json")
const AGENT_CONFIG_DIR = resolve(homedir(), ".config", "kimchi", "harness")
const KIMCHI_LLM_ENDPOINT = "https://llm.kimchi.dev/openai/v1"
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
	const cwd = process.cwd()
	// Relativize home- and cwd-rooted dirs so the persisted skill path is
	// location-independent: a relative path is re-scanned under both ~ and the
	// current project at runtime (see expandUserPath/resolveUserPath), whereas
	// an absolute path is pinned to the directory the wizard happened to run in.
	const toRelative = (abs: string): string => {
		if (abs === home || abs.startsWith(`${home}/`)) return relative(home, abs)
		if (abs === cwd || abs.startsWith(`${cwd}/`)) return relative(cwd, abs)
		return abs
	}

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
	apiKey: string
}

export interface SearchStrategyConfig {
	strategy: "bm25" | "regex"
	bm25K1: number
	bm25B: number
	fieldWeights: { name: number; description: number; schemaKey: number }
}

export interface OnboardingConfig {
	sessionModeWizardSeenAt?: string
	hideSessionModeDialog?: boolean
	teleportHelpSeenAt?: string
}

export interface SurveyConfig {
	seenAt?: string
}

export interface PreferencesConfig {
	hideTips?: boolean
}

export const RETRY_DEFAULTS = {
	enabled: true,
	maxRetries: 1,
	baseDelayMs: 2000,
	provider: {
		timeoutMs: 120_000,
		maxRetries: 0,
		maxRetryDelayMs: 60_000,
	},
} satisfies RetrySettings

/** What older kimchi versions wrote into pi's settings.json on every startup. */
const LEGACY_KIMCHI_MAX_RETRIES = 10

/**
 * The previous kimchi default retry block. Pre-existing settings.json files
 * written by an older kimchi version carry this exact shape (notably with
 * `provider.timeoutMs: 600_000`); `upgradeLegacyRetrySettings` detects and
 * upgrades exactly this shape (mirroring the special-casing of
 * `retry: { maxRetries: 10 }`). Frozen at the old values rather than derived
 * from `RETRY_DEFAULTS`, so that a future change to a non-timeoutMs default
 * (e.g. bumping `maxRetries`) does not silently stop detecting old
 * settings.json files.
 */
const LEGACY_KIMCHI_RETRY_DEFAULTS = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
	provider: {
		timeoutMs: 600_000,
		maxRetries: 0,
		maxRetryDelayMs: 60_000,
	},
} satisfies RetrySettings

/**
 * The kimchi default retry block from iteration 0001 through 0003:
 * `provider.timeoutMs` was already reduced to 120_000, but `maxRetries`
 * remained 3, so a failing gateway still triggered a ~11-minute retry storm
 * per failed turn (4 attempts × 120 s + 3 backoffs ≈ 666 s). Reducing
 * `maxRetries` to 1 cuts that to ~5 minutes per failed turn.
 * `upgradeLegacyProviderTimeout` detects and upgrades this exact shape too,
 * mirroring the `LEGACY_KIMCHI_RETRY_DEFAULTS` (`timeoutMs: 600_000`)
 * detection. Frozen at these values rather than derived from
 * `RETRY_DEFAULTS`, so a future change to another default does not silently
 * stop detecting old settings.json files written by iterations 1–3.
 */
const LEGACY_KIMCHI_RETRY_DEFAULTS_ITER1 = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
	provider: {
		timeoutMs: 120_000,
		maxRetries: 0,
		maxRetryDelayMs: 60_000,
	},
} satisfies RetrySettings

/**
 * Returns the `retry` block to write into pi's settings.json, or undefined if
 * the existing block should be left alone. A missing block gets the defaults.
 *
 * Older kimchi versions synced `retry: { maxRetries }` (never a `provider`
 * block) into settings.json on every startup, so a provider-less block is
 * kimchi-owned legacy state: upgrade it to the current defaults, but keep any
 * valid user-tuned values. Only an exact `retry: { maxRetries: 10 }` block is
 * known to be kimchi-written rather than user intent.
 *
 * A block that already carries a `provider` section is normally left alone —
 * the user (or a prior kimchi run) tuned it. The exceptions are exact matches
 * of `LEGACY_KIMCHI_RETRY_DEFAULTS` (the pre-iteration-0001 default, with
 * `provider.timeoutMs: 600_000`) or `LEGACY_KIMCHI_RETRY_DEFAULTS_ITER1`
 * (the iteration-0001-through-0003 default, with `maxRetries: 3` and
 * `provider.timeoutMs: 120_000`): those blocks are kimchi-written legacy
 * state too, so we upgrade them to the current defaults (which carry
 * `maxRetries: 1` and `provider.timeoutMs: 120_000`). User-tuned values that
 * differ from either old default are preserved.
 */
export function upgradeLegacyRetrySettings(retry: unknown): RetrySettings | undefined {
	if (retry === undefined) return RETRY_DEFAULTS
	if (!retry || typeof retry !== "object" || Array.isArray(retry)) return undefined
	const legacy = retry as Record<string, unknown>

	if ("provider" in legacy) {
		return upgradeLegacyProviderTimeout(legacy)
	}

	const upgraded: RetrySettings = { ...RETRY_DEFAULTS }
	if (typeof legacy.enabled === "boolean") upgraded.enabled = legacy.enabled
	if (typeof legacy.baseDelayMs === "number" && Number.isFinite(legacy.baseDelayMs)) {
		upgraded.baseDelayMs = legacy.baseDelayMs
	}
	const maxRetries = legacy.maxRetries
	const isExactKimchiLegacyBlock =
		Object.keys(legacy).length === 1 && typeof maxRetries === "number" && maxRetries === LEGACY_KIMCHI_MAX_RETRIES
	if (typeof maxRetries === "number" && Number.isFinite(maxRetries) && !isExactKimchiLegacyBlock) {
		upgraded.maxRetries = maxRetries
	}
	return upgraded
}

/**
 * Returns true if `legacy` is an exact match for the frozen legacy default
 * `frozen`: the same set of top-level keys (`enabled`, `maxRetries`,
 * `baseDelayMs`, `provider`) with equal values, and the same set of provider
 * keys (`timeoutMs`, `maxRetries`, `maxRetryDelayMs`) with equal values. Any
 * divergence — a user-tuned value, an extra key, a partial provider block —
 * returns false so the caller leaves the block untouched. Compares against
 * the frozen constant (not the current `RETRY_DEFAULTS`) so a future change
 * to a non-matching default does not silently stop detecting old
 * settings.json files.
 */
function isExactLegacyRetryBlock(
	legacy: Record<string, unknown>,
	frozen: typeof LEGACY_KIMCHI_RETRY_DEFAULTS,
): boolean {
	const expectedTopKeys = new Set(["enabled", "maxRetries", "baseDelayMs", "provider"])
	const actualTopKeys = new Set(Object.keys(legacy))
	if (actualTopKeys.size !== expectedTopKeys.size) return false
	for (const k of actualTopKeys) if (!expectedTopKeys.has(k)) return false
	if (legacy.enabled !== frozen.enabled) return false
	if (legacy.maxRetries !== frozen.maxRetries) return false
	if (legacy.baseDelayMs !== frozen.baseDelayMs) return false

	const provider = legacy.provider
	if (!provider || typeof provider !== "object" || Array.isArray(provider)) return false
	const p = provider as Record<string, unknown>
	const expectedProviderKeys = new Set(["timeoutMs", "maxRetries", "maxRetryDelayMs"])
	const actualProviderKeys = new Set(Object.keys(p))
	if (actualProviderKeys.size !== expectedProviderKeys.size) return false
	for (const k of actualProviderKeys) if (!expectedProviderKeys.has(k)) return false
	if (p.maxRetries !== frozen.provider.maxRetries) return false
	if (p.maxRetryDelayMs !== frozen.provider.maxRetryDelayMs) return false
	if (p.timeoutMs !== frozen.provider.timeoutMs) return false
	return true
}

/**
 * If `legacy` is an exact match for one of the frozen legacy kimchi default
 * retry blocks — `LEGACY_KIMCHI_RETRY_DEFAULTS` (pre-iteration-0001, with
 * `provider.timeoutMs: 600_000`) or `LEGACY_KIMCHI_RETRY_DEFAULTS_ITER1`
 * (iteration-0001-through-0003, with `maxRetries: 3` and
 * `provider.timeoutMs: 120_000`) — upgrade it to the current `RETRY_DEFAULTS`
 * (which carries `maxRetries: 1` and `provider.timeoutMs: 120_000`) and
 * return the result. Otherwise return undefined to leave the user-tuned block
 * untouched.
 */
function upgradeLegacyProviderTimeout(legacy: Record<string, unknown>): RetrySettings | undefined {
	if (
		!isExactLegacyRetryBlock(legacy, LEGACY_KIMCHI_RETRY_DEFAULTS) &&
		!isExactLegacyRetryBlock(legacy, LEGACY_KIMCHI_RETRY_DEFAULTS_ITER1)
	) {
		return undefined
	}
	// Exact match of an old default: upgrade to the current defaults. Clone the
	// nested provider object too so a caller mutating the returned block can't
	// corrupt the module-level RETRY_DEFAULTS constant.
	return { ...RETRY_DEFAULTS, provider: { ...RETRY_DEFAULTS.provider } }
}

/** Seed hideThinkingBlock when absent so Kimchi and upstream pi agree on the default. */
export function ensureHideThinkingBlockDefault(settings: Record<string, unknown>): boolean {
	if ("hideThinkingBlock" in settings) return false
	settings.hideThinkingBlock = true
	return true
}

/**
 * Seed quietStartup when absent so settings.json files predating this default
 * (or otherwise missing the key) don't fall back to pi's verbose startup
 * listing (the `[Extensions]`/`[Themes]` resource dump).
 */
export function ensureQuietStartupDefault(settings: Record<string, unknown>): boolean {
	if ("quietStartup" in settings) return false
	settings.quietStartup = true
	return true
}

export const THIRD_PARTY_MAX_RETRIES = 4

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
	/** The user-configured endpoint, undefined if not explicitly set. Use this when passing to updateModelsConfig. */
	customLlmEndpoint: string | undefined
	maxToolResultChars: number
	mcpSearchLimit: number
	mcpSearch: SearchStrategyConfig
	skillPaths?: string[]
	migrationState?: MigrationState
	onboarding: OnboardingConfig
	deviceId: string
	redaction?: { enabled?: boolean }
}

/**
 * Read the Cast AI API key from the kimchi CLI config file.
 * Returns undefined if the file doesn't exist or the field is missing.
 */
export function readApiKeyFromConfigFile(configPath: string = KIMCHI_CONFIG_PATH): string | undefined {
	const permWarning = checkConfigFilePermissions(configPath)
	if (permWarning) console.warn(permWarning)
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
	preferences?: PreferencesConfig
	deviceId?: string
	redaction?: { enabled?: boolean }
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
		const onboarding = parseOnboardingConfig(parsed.onboarding)
		const preferences = parsePreferencesConfig(parsed.preferences)
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

		// Read redaction config
		let redaction: { enabled?: boolean } | undefined
		const rd = parsed.redaction
		if (rd && typeof rd === "object" && typeof rd.enabled === "boolean") {
			redaction = { enabled: rd.enabled }
		}

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
			preferences,
			redaction,
		}
	} catch {
		return {}
	}
}

/**
 * Check if the config file has group/world-readable permission bits.
 * Returns a warning string if the file is too permissive (mode allows
 * group or world access), or undefined if the file doesn't exist or is
 * owner-only (0600 or stricter). Used by loadConfig and
 * readApiKeyFromConfigFile to warn users when their API key is exposed.
 */
export function checkConfigFilePermissions(configPath: string): string | undefined {
	try {
		const stat = statSync(configPath)
		if ((stat.mode & 0o077) !== 0) {
			const mode = (stat.mode & 0o777).toString(8)
			return `Warning: ${configPath} is group/world-readable (mode ${mode}). Run \`chmod 600 ${configPath}\` to restrict access to your API key.`
		}
	} catch {
		// File doesn't exist or is inaccessible — not a perm warning
	}
	return undefined
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

function parseOnboardingConfig(value: unknown): OnboardingConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
	const raw = value as Record<string, unknown>
	const sessionModeWizardSeenAt =
		typeof raw.sessionModeWizardSeenAt === "string" && raw.sessionModeWizardSeenAt.length > 0
			? raw.sessionModeWizardSeenAt
			: undefined
	const hideSessionModeDialog = typeof raw.hideSessionModeDialog === "boolean" ? raw.hideSessionModeDialog : undefined
	const teleportHelpSeenAt =
		typeof raw.teleportHelpSeenAt === "string" && raw.teleportHelpSeenAt.length > 0 ? raw.teleportHelpSeenAt : undefined

	return {
		...(sessionModeWizardSeenAt ? { sessionModeWizardSeenAt } : {}),
		...(hideSessionModeDialog !== undefined ? { hideSessionModeDialog } : {}),
		...(teleportHelpSeenAt ? { teleportHelpSeenAt } : {}),
	}
}

function parsePreferencesConfig(value: unknown): PreferencesConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
	const raw = value as Record<string, unknown>
	const hideTips = typeof raw.hideTips === "boolean" ? raw.hideTips : undefined

	return {
		...(hideTips !== undefined ? { hideTips } : {}),
	}
}

/**
 * Read telemetry configuration from config.json without requiring an API key.
 * Safe to call before authentication is set up.
 *
 * Telemetry is enabled by default unless explicitly disabled. It can be disabled by:
 *   - KIMCHI_TELEMETRY_ENABLED env var set to a falsy value (0/false), or
 *   - config.json has telemetry.enabled = false
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
	const apiKey =
		(typeof process.env.KIMCHI_API_KEY === "string" && process.env.KIMCHI_API_KEY.length > 0
			? process.env.KIMCHI_API_KEY
			: undefined) ?? readApiKeyFromConfigFile(path)
	if (fileHeaders) {
		headers = fileHeaders
	} else {
		headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
	}

	// Enabled by default; explicit config/env overrides either way
	const defaultEnabled = true
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
		apiKey: apiKey ?? "",
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
	const globalPermWarning = checkConfigFilePermissions(globalConfigPath)
	if (globalPermWarning) console.warn(globalPermWarning)
	const globalExtras = readConfigExtras(globalConfigPath)

	// Read project-level config
	const projectPath = resolve(options?.cwd ?? process.cwd(), ".kimchi", "config.json")
	const projectPermWarning = checkConfigFilePermissions(projectPath)
	if (projectPermWarning) console.warn(projectPermWarning)
	const projectExtras = readConfigExtras(projectPath)

	// Merge: project wins for scalars; shallow merge for mcpSearch.
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
		redaction: projectExtras.redaction ?? globalExtras.redaction,
	}

	return {
		apiKey: extras.apiKey ?? "",
		agentConfigDir: AGENT_CONFIG_DIR,
		llmEndpoint: extras.llmEndpoint ?? KIMCHI_LLM_ENDPOINT,
		customLlmEndpoint: extras.llmEndpoint,
		maxToolResultChars: extras.maxToolResultChars ?? 10_000,
		mcpSearchLimit: extras.mcpSearchLimit ?? 5,
		mcpSearch: { ...SEARCH_STRATEGY_DEFAULTS, ...extras.mcpSearch },
		skillPaths: extras.skillPaths,
		migrationState: extras.migrationState,
		onboarding: extras.onboarding ?? {},
		deviceId: extras.deviceId ?? "",
		redaction: extras.redaction,
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
	// Restrict to owner-only (0600) — config.json holds the Cast AI API key and
	// git tokens in plaintext. The atomic rename may inherit the tmp file's
	// default umask perms, so chmod explicitly after the rename lands.
	chmodSync(configPath, 0o600)
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

function updateOnboardingConfig(configPath: string, update: (onboarding: Record<string, unknown>) => void): void {
	updateConfigFile(configPath, (raw) => {
		const onboarding =
			raw.onboarding && typeof raw.onboarding === "object" && !Array.isArray(raw.onboarding)
				? { ...(raw.onboarding as Record<string, unknown>) }
				: {}
		update(onboarding)
		raw.onboarding = onboarding
	})
}

function readSurveyConfig(surveyId: string, configPath: string): SurveyConfig | undefined {
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf-8"))
		const surveys = parsed.surveys
		if (!surveys || typeof surveys !== "object" || Array.isArray(surveys)) return undefined
		const survey = (surveys as Record<string, unknown>)[surveyId]
		if (!survey || typeof survey !== "object" || Array.isArray(survey)) return undefined
		const seenAt = (survey as Record<string, unknown>).seenAt
		return typeof seenAt === "string" && seenAt.length > 0 ? { seenAt } : undefined
	} catch {
		return undefined
	}
}

function updateSurveyConfig(
	configPath: string,
	surveyId: string,
	update: (survey: Record<string, unknown>) => void,
): void {
	updateConfigFile(configPath, (raw) => {
		const surveys =
			raw.surveys && typeof raw.surveys === "object" && !Array.isArray(raw.surveys)
				? { ...(raw.surveys as Record<string, unknown>) }
				: {}
		const survey =
			surveys[surveyId] && typeof surveys[surveyId] === "object" && !Array.isArray(surveys[surveyId])
				? { ...(surveys[surveyId] as Record<string, unknown>) }
				: {}
		update(survey)
		surveys[surveyId] = survey
		raw.surveys = surveys
	})
}

export function readSessionModeWizardSeenAt(configPath?: string): string | undefined {
	return readConfigExtras(configPath ?? KIMCHI_CONFIG_PATH).onboarding?.sessionModeWizardSeenAt
}

export function writeSessionModeWizardSeenAt(seenAt: string, configPath?: string): void {
	const path = configPath ?? KIMCHI_CONFIG_PATH
	updateOnboardingConfig(path, (onboarding) => {
		onboarding.sessionModeWizardSeenAt = seenAt
	})
}

export function readTeleportHelpSeenAt(configPath?: string): string | undefined {
	return readConfigExtras(configPath ?? KIMCHI_CONFIG_PATH).onboarding?.teleportHelpSeenAt
}

export function writeTeleportHelpSeenAt(seenAt: string, configPath?: string): void {
	const path = configPath ?? KIMCHI_CONFIG_PATH
	updateOnboardingConfig(path, (onboarding) => {
		onboarding.teleportHelpSeenAt = seenAt
	})
}

export function readSurveySeenAt(surveyId: string, configPath?: string): string | undefined {
	return readSurveyConfig(surveyId, configPath ?? KIMCHI_CONFIG_PATH)?.seenAt
}

export function writeSurveySeenAt(surveyId: string, seenAt: string, configPath?: string): void {
	updateSurveyConfig(configPath ?? KIMCHI_CONFIG_PATH, surveyId, (survey) => {
		survey.seenAt = seenAt
	})
}

export function readHideSessionModeDialog(configPath?: string): boolean {
	return readConfigExtras(configPath ?? KIMCHI_CONFIG_PATH).onboarding?.hideSessionModeDialog === true
}

export function readHideTips(configPath?: string): boolean {
	return readConfigExtras(configPath ?? KIMCHI_CONFIG_PATH).preferences?.hideTips === true
}

function updatePreferencesConfig(configPath: string, update: (preferences: Record<string, unknown>) => void): void {
	updateConfigFile(configPath, (raw) => {
		const preferences =
			raw.preferences && typeof raw.preferences === "object" && !Array.isArray(raw.preferences)
				? { ...(raw.preferences as Record<string, unknown>) }
				: {}
		update(preferences)
		raw.preferences = preferences
	})
}

export function writeHideTips(hidden: boolean, configPath?: string): void {
	const path = configPath ?? KIMCHI_CONFIG_PATH
	updatePreferencesConfig(path, (preferences) => {
		preferences.hideTips = hidden
	})
}

export function writeMigrationState(state: MigrationState, configPath?: string): void {
	writeConfigField("migrationState", state, configPath ?? KIMCHI_CONFIG_PATH)
}

export function writeSkillPaths(paths: string[], configPath?: string): void {
	writeConfigField("skillPaths", paths, configPath ?? KIMCHI_CONFIG_PATH)
}

export interface WriteApiKeyOptions {
	llmEndpoint?: string
}

export function writeApiKey(key: string, configPath?: string, options: WriteApiKeyOptions = {}): void {
	const path = configPath ?? KIMCHI_CONFIG_PATH
	updateConfigFile(path, (raw) => {
		raw.apiKey = key
		const llmEndpoint = options.llmEndpoint?.trim()
		if (llmEndpoint) {
			raw.llmEndpoint = llmEndpoint
		} else {
			// biome-ignore lint/performance/noDelete: explicit removal is clearer than relying on JSON.stringify to silently drop undefined values
			delete raw.llmEndpoint
		}
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
/**
 * Check whether the user has explicitly set a telemetry preference —
 * either via the KIMCHI_TELEMETRY_ENABLED env var or by persisting
 * telemetry.enabled in config.json. Returns false when neither is set,
 * meaning the user has never been asked / never chose.
 */
export function isTelemetryExplicitlyConfigured(configPath?: string): boolean {
	if (process.env.KIMCHI_TELEMETRY_ENABLED !== undefined) return true
	try {
		const path = configPath ?? KIMCHI_CONFIG_PATH
		const raw = readFileSync(path, "utf-8")
		const parsed = JSON.parse(raw)
		const t = parsed.telemetry
		if (t && typeof t === "object" && typeof t.enabled === "boolean") return true
	} catch {
		// missing or invalid config — not configured
	}
	return false
}

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
