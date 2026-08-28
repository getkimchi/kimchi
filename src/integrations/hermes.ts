import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { writeFileAtomic } from "../config/json.js"
import type { ConfigScope } from "../config/scope.js"
import { resolveScopePath } from "../config/scope.js"
import type { ModelMetadata } from "../models.js"
import { API_KEY_ENV, BASE_URL, PROVIDER_NAME } from "./constants.js"
import { findBinary } from "./detect.js"
import { type ModelRole, resolveAllModelRoles } from "./models.js"
import { register } from "./registry.js"

export const HERMES_CONFIG_PATH = "~/.hermes/config.yaml"
export const HERMES_ENV_PATH = "~/.hermes/.env"

/** Minimum Hermes version we know the config layout works against. Exported for tests and version gating. */
export const HERMES_VERSION_MIN = "2026.1.0"

/** Matches `hermes --version` output: "Hermes 2026.1.2". Exported for tests and version gating. */
export const HERMES_VERSION_REGEX = /Hermes\s+(\d{4}\.\d+\.\d+)/

/**
 * Build the top-level `model` block Hermes uses to pick an active inference
 * provider. Same shape whether we write it via the CLI batch flag or
 * directly into ~/.hermes/config.yaml. Pure so we can snapshot-test it
 * without exec or fs.
 *
 * `apiKey` deliberately points at `${KIMCHI_API_KEY}` rather than the raw
 * key so the YAML can be checked into version control without leaking
 * credentials; the daemon resolves the env var from ~/.hermes/.env at
 * launch time.
 *
 * `default` uses the `<provider>/<slug>` convention Hermes expects when
 * `provider: "custom"`.
 *
 * @param models - Live `ModelMetadata[]` fetched from the API.
 */
export function buildHermesModelConfig(models: readonly ModelMetadata[]): Record<string, unknown> {
	if (models.length === 0) throw new Error("No models available — is the API key valid?")

	const resolved = resolveAllModelRoles(models, ["main"] as readonly ModelRole[])
	const mainSlug = resolved.main?.slug ?? models[0].slug

	return {
		provider: "custom",
		base_url: BASE_URL,
		api_key: `\${${API_KEY_ENV}}`,
		default: `${PROVIDER_NAME}/${mainSlug}`,
	}
}

/**
 * Build the `fallback_providers` list Hermes uses when the primary model
 * can't be reached. Each entry uses `key_env` (not `api_key`) so Hermes
 * reads the credential from ~/.hermes/.env at runtime. Falls back through
 * the `coding` and `sub` role slots; entries are deduped.
 *
 * @param models - Live `ModelMetadata[]` fetched from the API.
 */
export function buildHermesFallbackProviders(models: readonly ModelMetadata[]): Array<Record<string, unknown>> {
	if (models.length === 0) throw new Error("No models available — is the API key valid?")

	const resolved = resolveAllModelRoles(models, ["main", "coding", "sub"] as readonly ModelRole[])
	const mainSlug = resolved.main?.slug
	const slugs = ([resolved.coding, resolved.sub] as Array<ModelMetadata | undefined>)
		.filter((m): m is ModelMetadata => m !== undefined)
		.map((m) => m.slug)
		.filter((slug) => slug !== mainSlug)

	const deduped: string[] = []
	for (const slug of slugs) {
		if (!deduped.includes(slug)) deduped.push(slug)
	}

	return deduped.map((slug) => ({
		provider: "custom",
		model: `${PROVIDER_NAME}/${slug}`,
		base_url: BASE_URL,
		key_env: API_KEY_ENV,
	}))
}

/** Detection: ~/.hermes/ dir present OR `hermes` on PATH. */
export function detectHermes(): boolean {
	const dir = join(homedir(), ".hermes")
	if (existsSync(dir)) return true
	return findBinary("hermes") !== undefined
}

/**
 * Write `KIMCHI_API_KEY=<key>` into ~/.hermes/.env, replacing any prior
 * line for the same key. The .env file feeds the Hermes daemon, which
 * interpolates `${KIMCHI_API_KEY}` from config.yaml at runtime.
 */
export function writeHermesEnv(apiKey: string): void {
	// The .env file feeds the Hermes daemon, which always reads from
	// ~/.hermes/.env regardless of the config scope.
	const envPath = resolveScopePath("global", HERMES_ENV_PATH)
	let content = ""
	try {
		content = readFileSync(envPath, "utf-8")
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
	}

	const newLine = `${API_KEY_ENV}=${apiKey}`
	const lines = content === "" ? [] : content.split("\n")
	// Drop a trailing empty line so we don't double up on the newline when
	// we re-join below.
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()

	let found = false
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith(`${API_KEY_ENV}=`)) {
			lines[i] = newLine
			found = true
			break
		}
	}
	if (!found) lines.push(newLine)

	writeFileAtomic(envPath, `${lines.join("\n")}\n`)
}

function runHermesCmd(args: string[]): void {
	const result = spawnSync("hermes", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
	if (result.status !== 0) {
		const detail = (result.stderr || result.stdout || "").trim()
		throw new Error(`hermes ${args.slice(0, 2).join(" ")} failed: ${detail || `exit ${result.status}`}`)
	}
}

/** Configure Hermes via the `hermes config set` CLI (preferred when binary is present). */
async function writeHermesViaCLI(apiKey: string, models: readonly ModelMetadata[]): Promise<void> {
	if (models.length === 0) throw new Error("No models available — is the API key valid?")

	const modelConfig = buildHermesModelConfig(models)
	const fallbackProviders = buildHermesFallbackProviders(models)

	// Set each model.* key individually — `hermes config set model <json>`
	// stringifies the whole object under `model.default` instead of expanding
	// nested keys, so we use dot-path setters.
	runHermesCmd(["config", "set", "model.provider", String(modelConfig.provider)])
	runHermesCmd(["config", "set", "model.base_url", String(modelConfig.base_url)])
	runHermesCmd(["config", "set", "model.api_key", String(modelConfig.api_key)])
	runHermesCmd(["config", "set", "model.default", String(modelConfig.default)])
	runHermesCmd(["config", "set", "fallback_providers", JSON.stringify(fallbackProviders)])

	writeHermesEnv(apiKey)
	// We intentionally do not restart a running Hermes gateway here. In
	// container/headless environments `hermes gateway restart` can hang or
	// restart the process under the current shell, blocking setup-tools.
	// The provider/model config is persisted to ~/.hermes/config.yaml and
	// will be picked up the next time the user starts Hermes.
}

/** Configure Hermes by writing YAML directly when no CLI is available. */
async function writeHermesDirect(scope: ConfigScope, apiKey: string, models: readonly ModelMetadata[]): Promise<void> {
	if (models.length === 0) throw new Error("No models available — is the API key valid?")

	const path = resolveScopePath(scope, HERMES_CONFIG_PATH)
	let existing: Record<string, unknown> = {}
	try {
		const raw = readFileSync(path, "utf-8")
		const trimmed = raw.trim()
		if (trimmed !== "") {
			const parsed = parseYaml(trimmed)
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				existing = parsed as Record<string, unknown>
			}
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
	}

	existing.model = buildHermesModelConfig(models)
	existing.fallback_providers = buildHermesFallbackProviders(models)

	writeFileAtomic(path, stringifyYaml(existing))
	writeHermesEnv(apiKey)
}

async function writeHermes(
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
	// CLI route preferred when the binary is on PATH — Hermes uses YAML
	// internally and the CLI's setter is the only path that round-trips
	// cleanly through its parser. Fall back to direct YAML write only when
	// there's no hermes binary to ask.
	if (findBinary("hermes")) {
		await writeHermesViaCLI(apiKey, models)
	} else {
		await writeHermesDirect(scope, apiKey, models)
	}
}

/** Narrow an unknown value to a plain object, defaulting to `{}` for any other type. */
export function asObject(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** Merge fallbacks with an existing array, deduping entries. */
export function mergeFallbacks(existing: unknown, fallbacks: string[]): string[] {
	const current = Array.isArray(existing) ? (existing as string[]) : []
	return [...new Set([...current, ...fallbacks])]
}

/** Merge models catalog with an existing object, with new entries taking precedence. */
export function mergeModelsCatalog(existing: unknown, catalog: Record<string, unknown>): Record<string, unknown> {
	return { ...asObject(existing), ...catalog }
}

register({
	id: "hermes",
	name: "Hermes",
	description: "AI agent framework",
	configPath: HERMES_CONFIG_PATH,
	binaryName: "hermes",
	installUrl: "https://hermes-agent.nousresearch.com/install.sh",
	installArgs: ["--skip-setup", "--non-interactive", "--skip-browser", "--no-skills"],
	isInstalled: detectHermes,
	write: writeHermes,
})
