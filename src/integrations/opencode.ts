import { execFileSync } from "node:child_process"
import { readTelemetryConfig } from "../config.js"
import { readJson, writeJson } from "../config/json.js"
import type { ConfigScope } from "../config/scope.js"
import { resolveScopePath } from "../config/scope.js"
import type { ModelMetadata } from "../models.js"
import {
	NPM_REGISTRY_BASE_URL,
	OPENCODE_PLUGIN_ARRAY_MIN_VERSION,
	OPENCODE_PLUGIN_PACKAGE,
	PROVIDER_NAME,
} from "./constants.js"
import { detectBinaryFactory } from "./detect.js"
import { resolveModelRole } from "./models.js"
import { openCodeProviderConfig } from "./provider/opencode.js"
import { register } from "./registry.js"

const OPENCODE_CONFIG_PATH = "~/.config/opencode/opencode.json"
const NPM_REQUEST_TIMEOUT_MS = 10_000
const TELEMETRY_LOGS_ENDPOINT = "https://api.cast.ai/ai-optimizer/v1beta/logs:ingest"
const TELEMETRY_METRICS_ENDPOINT = "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest"

const OPENCODE_VERSION_REGEX = /opencode\s+v?(\d+\.\d+\.\d+)/

/**
 * Run `opencode --version` and parse out the SemVer. Returns null when the
 * binary is missing or the output doesn't match the expected pattern. Used
 * to decide whether to write the new array plugin format or the legacy
 * string-array form.
 */
export function getOpenCodeVersion(execFile: typeof execFileSync = execFileSync): string | null {
	try {
		const out = execFile("opencode", ["--version"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
		const match = out.match(OPENCODE_VERSION_REGEX)
		return match ? match[1] : null
	} catch {
		return null
	}
}

/**
 * Whether the locally installed OpenCode supports the array-of-arrays plugin
 * format (`>= 1.14.0`). When false, the writer falls back to the older
 * `["@kimchi-dev/opencode-kimchi"]` string list which loses the per-plugin
 * config block.
 */
export function isPluginArraySupported(version: string | null = getOpenCodeVersion()): boolean {
	return compareSemverGte(version, OPENCODE_PLUGIN_ARRAY_MIN_VERSION)
}

/**
 * Compare two `MAJOR.MINOR.PATCH` strings. Returns true iff `a >= b`. We
 * keep this inline rather than pulling the `semver` package because the only
 * comparison we need is the fixed >= 1.14.0 plugin-format gate.
 *
 * Inputs that aren't strict three-part numerics return false — same effect
 * as Go's `semver.NewVersion(version)` returning err on unparseable strings,
 * which kicks the writer into the conservative legacy plugin format.
 */
export function compareSemverGte(a: string | null, b: string): boolean {
	if (!a) return false
	const parts = (s: string): [number, number, number] | null => {
		const m = s.match(/^(\d+)\.(\d+)\.(\d+)/)
		return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
	}
	const av = parts(a)
	const bv = parts(b)
	if (!av || !bv) return false
	for (let i = 0; i < 3; i++) {
		if (av[i] > bv[i]) return true
		if (av[i] < bv[i]) return false
	}
	return true
}

/**
 * Hit the public npm registry for the package's latest tag. Returns null on
 * timeout, network error, non-200, or missing version field. Mirrors
 * `getLatestNPMVersion` in opencode.go but expressed via the global `fetch`
 * with an AbortSignal.timeout for parity with the Go 10s client timeout.
 */
export async function getLatestNpmVersion(packageName: string): Promise<string | null> {
	const url = `${NPM_REGISTRY_BASE_URL}/${packageName}/latest`
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(NPM_REQUEST_TIMEOUT_MS) })
		if (!res.ok) return null
		const body = (await res.json()) as { version?: unknown }
		return typeof body.version === "string" && body.version.length > 0 ? body.version : null
	} catch {
		return null
	}
}

const PLUGIN_VERSION_REGEX = new RegExp(`^${escapeRegExp(OPENCODE_PLUGIN_PACKAGE)}@(.+)$`)

/**
 * Pull the version suffix off a plugin entry like
 * `@kimchi-dev/opencode-kimchi@1.14.0` → `"1.14.0"`. Returns null for the
 * un-pinned form (`@kimchi-dev/opencode-kimchi`).
 */
export function extractVersionFromPluginName(pkgName: string): string | null {
	const match = pkgName.match(PLUGIN_VERSION_REGEX)
	return match ? match[1] : null
}

function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

interface PluginUpdateInputs {
	plugins: unknown[]
	telemetryEnabled: boolean
	latestVersion: string | null
}

interface PluginUpdateResult {
	plugins: unknown[]
	/** True when we couldn't determine any version to pin and skipped writing the plugin entry. */
	skippedKimchiPlugin: boolean
}

/**
 * Pure transform on the plugin array: strip out any prior Kimchi entries,
 * remember the version we found there, then re-insert exactly one updated
 * entry pinned to `latestVersion` (or the previous version if npm was
 * unavailable). Splitting this out from `writeOpenCode` keeps the file-IO-
 * free logic testable.
 */
export function buildUpdatedPlugins(inputs: PluginUpdateInputs): PluginUpdateResult {
	const { plugins, telemetryEnabled, latestVersion } = inputs

	const pluginConfig: Record<string, unknown> = {}
	if (telemetryEnabled) {
		pluginConfig.telemetry = true
		pluginConfig.logsEndpoint = TELEMETRY_LOGS_ENDPOINT
		pluginConfig.metricsEndpoint = TELEMETRY_METRICS_ENDPOINT
	}

	let existingVersion: string | null = null
	const filtered: unknown[] = []
	for (const entry of plugins) {
		if (Array.isArray(entry) && entry.length > 0 && typeof entry[0] === "string") {
			const pkgName = entry[0]
			if (pkgName === OPENCODE_PLUGIN_PACKAGE || pkgName.startsWith(`${OPENCODE_PLUGIN_PACKAGE}@`)) {
				existingVersion = extractVersionFromPluginName(pkgName)
				continue
			}
		}
		filtered.push(entry)
	}

	const versionToPin = latestVersion ?? existingVersion
	if (!versionToPin) {
		return { plugins: filtered, skippedKimchiPlugin: true }
	}

	const updatedEntry: unknown[] = [`${OPENCODE_PLUGIN_PACKAGE}@${versionToPin}`, pluginConfig]
	return { plugins: [...filtered, updatedEntry], skippedKimchiPlugin: false }
}

async function writeOpenCode(
	scope: ConfigScope,
	apiKey: string,
	models: readonly ModelMetadata[],
	_options?: { telemetryEnabled?: boolean },
): Promise<void> {
	if (!apiKey) {
		throw new Error("API key not configured")
	}

	if (!models || models.length === 0) {
		throw new Error("No models available — is the API key valid?")
	}

	const path = resolveScopePath(scope, OPENCODE_CONFIG_PATH)
	const existing = readJson(path)

	existing.$schema = "https://opencode.ai/config.json"

	const providers =
		existing.provider && typeof existing.provider === "object" && !Array.isArray(existing.provider)
			? (existing.provider as Record<string, unknown>)
			: {}
	providers[PROVIDER_NAME] = openCodeProviderConfig(apiKey, models)
	existing.provider = providers

	const main = resolveModelRole(models, "main")
	existing.model = `${PROVIDER_NAME}/${main?.slug ?? models[0].slug}`

	if (!("compaction" in existing)) {
		existing.compaction = { auto: true }
	}

	const telemetryEnabled = readTelemetryConfig().enabled
	const currentPlugins = Array.isArray(existing.plugin) ? existing.plugin : []
	const latestVersion = await getLatestNpmVersion(OPENCODE_PLUGIN_PACKAGE)
	const { plugins } = buildUpdatedPlugins({ plugins: currentPlugins, telemetryEnabled, latestVersion })

	if (isPluginArraySupported()) {
		existing.plugin = plugins
	} else {
		existing.plugin = [OPENCODE_PLUGIN_PACKAGE]
	}

	writeJson(path, existing)
}

register({
	id: "opencode",
	name: "OpenCode",
	description: "Agentic coding CLI",
	configPath: OPENCODE_CONFIG_PATH,
	binaryName: "opencode",
	isInstalled: detectBinaryFactory("opencode"),
	write: writeOpenCode,
})
