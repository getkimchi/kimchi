import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import YAML from "yaml"
import { readJson, writeFileAtomic } from "../config/json.js"
import type { ConfigScope } from "../config/scope.js"
import { resolveScopePath } from "../config/scope.js"
import { API_KEY_ENV, BASE_URL, PROVIDER_NAME } from "./constants.js"
import { findBinary } from "./detect.js"
import { type ModelRole, resolveAllModelRoles, resolveModelRole } from "./models.js"
import { register } from "./registry.js"

const HERMES_CONFIG_PATH = "~/.hermes/config.yaml"
const HERMES_ENV_PATH = "~/.hermes/.env"
const HERMES_VERSION_MIN = "2026.1.0"
const HERMES_VERSION_REGEX = /Hermes\s+(\d{4}\.\d+\.\d+)/

/**
 * Build the Hermes provider block — the YAML entry dropped at
 * `providers.kimchi`. Same shape whether we write it via the CLI
 * or directly into ~/.hermes/config.yaml. Pure so we can
 * snapshot-test it without exec or fs.
 *
 * `apiKey` deliberately points at `${KIMCHI_API_KEY}` rather than the raw
 * key so the config can be checked into version control without leaking
 * credentials; the daemon resolves the env var from ~/.hermes/.env at
 * launch time.
 *
 * @param models - Live `ModelMetadata[]` fetched from the API.
 */
export function buildHermesProviderBlock(
	models: readonly import("../models.js").ModelMetadata[],
): Record<string, unknown> {
	return {
		baseUrl: BASE_URL,
		apiKey: `\${${API_KEY_ENV}}`,
		api: "openai-completions",
		models: models.map((m) => ({
			id: `${PROVIDER_NAME}/${m.slug}`,
			name: (m.display_name ?? "").trim().length > 0 ? m.display_name : m.slug,
			reasoning: m.reasoning,
			input: m.input_modalities,
			contextWindow: m.limits.context_window,
			maxTokens: m.limits.max_output_tokens,
		})),
	}
}

/** Map of `<provider>/<slug>` → `{ alias: displayName }` for agents.defaults.models. */
export function buildHermesModelsCatalog(
	models: readonly import("../models.js").ModelMetadata[],
): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const m of models) {
		const alias = (m.display_name ?? "").trim().length > 0 ? m.display_name : m.slug
		out[`${PROVIDER_NAME}/${m.slug}`] = { alias }
	}
	return out
}

/** Detection: ~/.hermes/ dir present OR `hermes` on PATH. */
function detectHermes(): boolean {
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
	const resolved = HERMES_ENV_PATH.replace("~", homedir())
	let content = ""
	try {
		content = readFileSync(resolved, "utf-8")
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
	}

	const newLine = `${API_KEY_ENV}=${apiKey}`
	const lines = content === "" ? [] : content.split("\n")
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

	writeFileAtomic(resolved, `${lines.join("\n")}\n`)
}

function isHermesGatewayRunning(execFile: typeof execFileSync = execFileSync): boolean {
	try {
		const out = execFile("hermes", ["gateway", "status"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
		return out.includes("running")
	} catch {
		return false
	}
}

function runHermesCmd(args: string[]): void {
	const result = spawnSync("hermes", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
	if (result.status !== 0) {
		const detail = (result.stderr || result.stdout || "").trim()
		throw new Error(`hermes ${args.slice(0, 2).join(" ")} failed: ${detail || `exit ${result.status}`}`)
	}
}

/**
 * Configure Hermes via the `hermes config set` CLI (preferred when binary is present).
 * Hermes config is YAML-based; the CLI is the safest round-trip path.
 */
async function writeHermesViaCLI(
	apiKey: string,
	models: readonly import("../models.js").ModelMetadata[],
): Promise<void> {
	if (models.length === 0) throw new Error("No models available — is the API key valid?")

	const providerBlock = buildHermesProviderBlock(models)
	const modelsCatalog = buildHermesModelsCatalog(models)

	const resolved = resolveAllModelRoles(models, ["main", "coding", "sub"] as readonly ModelRole[])
	const primary = resolved.main ? `${PROVIDER_NAME}/${resolved.main.slug}` : `${PROVIDER_NAME}/${models[0].slug}`
	const fallbacks = ([resolved.coding, resolved.sub] as Array<import("../models.js").ModelMetadata>)
		.filter((m): m is import("../models.js").ModelMetadata => m !== undefined)
		.map((m) => `${PROVIDER_NAME}/${m.slug}`)

	runHermesCmd(["config", "set", "providers.kimchi", JSON.stringify(providerBlock)])
	runHermesCmd(["config", "set", "agents.defaults.model.primary", primary])
	runHermesMerge("agents.defaults.model.fallbacks", (existing) => mergeFallbacks(existing, fallbacks))
	runHermesMerge("agents.defaults.models", (existing) => mergeModelsCatalog(existing, modelsCatalog))

	writeHermesEnv(apiKey)

	if (isHermesGatewayRunning()) {
		runHermesCmd(["gateway", "restart"])
	} else {
		// Fresh install — run `hermes onboard` to scaffold the workspace and daemon.
		runHermesCmd([
			"onboard",
			"--non-interactive",
			"--accept-risk",
			"--auth-choice",
			"skip",
			"--install-daemon",
			"--skip-channels",
			"--skip-skills",
			"--skip-search",
			"--skip-ui",
		])
	}
}

/**
 * Configure Hermes by writing YAML directly when no CLI is available.
 * Parses the existing config.yaml, merges the provider block, and serialises back.
 */
async function writeHermesDirect(
	scope: ConfigScope,
	apiKey: string,
	models: readonly import("../models.js").ModelMetadata[],
): Promise<void> {
	if (models.length === 0) throw new Error("No models available — is the API key valid?")

	const configPath = resolveScopePath(scope, HERMES_CONFIG_PATH).replace("~", homedir())
	let existing: Record<string, unknown> = {}
	try {
		const raw = readFileSync(configPath, "utf-8")
		existing = YAML.parse(raw) as Record<string, unknown>
		if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
			existing = {}
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
		// File doesn't exist yet — start fresh
	}

	const providers = asObject(existing.providers)
	providers[PROVIDER_NAME] = buildHermesProviderBlock(models)
	existing.providers = providers

	const agents = asObject(existing.agents)
	const defaults = asObject(agents.defaults)
	const modelMap = asObject(defaults.model)
	const resolved = resolveAllModelRoles(models, ["main", "coding", "sub"] as readonly ModelRole[])
	const mainSlug = resolved.main?.slug ?? models[0].slug
	const fallbacks = ([resolved.coding, resolved.sub] as Array<import("../models.js").ModelMetadata>)
		.filter((m): m is import("../models.js").ModelMetadata => m !== undefined)
		.map((m) => `${PROVIDER_NAME}/${m.slug}`)
	modelMap.primary = `${PROVIDER_NAME}/${mainSlug}`
	modelMap.fallbacks = mergeFallbacks(modelMap.fallbacks, fallbacks)
	defaults.model = modelMap

	defaults.models = mergeModelsCatalog(defaults.models, buildHermesModelsCatalog(models))
	agents.defaults = defaults
	existing.agents = agents

	const output = YAML.stringify(existing)
	const resolvedDir = join(homedir(), ".hermes")
	try {
		import("node:fs").then(({ mkdirSync }) => mkdirSync(resolvedDir, { recursive: true }))
	} catch {
		// already imported above in resolve
	}
	writeFileAtomic(configPath, output)
	writeHermesEnv(apiKey)
}

async function writeHermes(
	scope: ConfigScope,
	apiKey: string,
	models: readonly import("../models.js").ModelMetadata[],
	_options?: { telemetryEnabled?: boolean },
): Promise<void> {
	if (!apiKey) {
		throw new Error("API key not configured")
	}
	if (!models || models.length === 0) {
		throw new Error("No models available — is the API key valid?")
	}
	if (findBinary("hermes")) {
		await writeHermesViaCLI(apiKey, models)
	} else {
		await writeHermesDirect(scope, apiKey, models)
	}
}

/** Read a config value via `hermes config get --json`; returns `null` if the path is missing or unreadable. */
function hermesConfigGet(path: string): unknown | null {
	try {
		const result = spawnSync("hermes", ["config", "get", path, "--json"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		})
		if (result.status !== 0) return null
		const raw = (result.stdout ?? "").trim()
		if (!raw) return null
		return JSON.parse(raw)
	} catch {
		return null
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

/** Read existing value, merge it, and write back via CLI. */
function runHermesMerge(path: string, merger: (existing: unknown) => unknown): void {
	const existing = hermesConfigGet(path)
	const merged = merger(existing)
	runHermesCmd(["config", "set", path, JSON.stringify(merged)])
}

register({
	id: "hermes",
	name: "Hermes Agent",
	description: "NousResearch AI agent framework",
	configPath: HERMES_CONFIG_PATH,
	binaryName: "hermes",
	installUrl: "https://hermes-agent.nousresearch.com/install.sh",
	isInstalled: detectHermes,
	write: writeHermes,
})
