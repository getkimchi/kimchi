import { mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { writeFileAtomic, writeJson } from "../config/json.js"
import type { ConfigScope } from "../config/scope.js"
import { resolveScopePath } from "../config/scope.js"
import type { ModelMetadata } from "../models.js"
import { BASE_URL, PROVIDER_NAME } from "./constants.js"
import { detectBinaryFactory } from "./detect.js"
import { resolveModelRole } from "./models.js"
import { register } from "./registry.js"

const CODEX_CONFIG_PATH = "~/.codex/config.toml"
const CODEX_CATALOG_PATH = "~/.codex/model_catalog.json"

/** Escape a string for inclusion inside a TOML basic double-quoted string. */
function tomlEscape(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t")
}

/**
 * Build the Codex config.toml body pointing at the kimchi proxy. The API
 * key is embedded directly as a static `Authorization` header so that
 * Codex works when launched directly (`codex`) — not just via `kimchi codex`.
 *
 * @param apiKey     - Kimchi API key, written as a Bearer token in http_headers.
 * @param modelSlug  - Slug of the resolved "main" model, written to the top-level `model` key.
 * @param catalogPath - Resolved absolute path to the model catalog JSON file.
 */
export function buildCodexToml(apiKey: string, modelSlug: string, catalogPath: string): string {
	const escapedSlug = tomlEscape(modelSlug)
	const escapedCatalogPath = tomlEscape(catalogPath)
	const escapedKey = tomlEscape(apiKey)
	return `model_provider = "${PROVIDER_NAME}"
model = "${escapedSlug}"
model_catalog_json = "${escapedCatalogPath}"

[model_providers.${PROVIDER_NAME}]
name = "Kimchi Gateway"
base_url = "${tomlEscape(BASE_URL)}"
http_headers = { Authorization = "Bearer ${escapedKey}" }
wire_api = "responses"
`
}

interface CodexReasoningLevel {
	effort: "low" | "medium" | "high"
	description: string
}

interface CodexModelEntry {
	slug: string
	display_name: string
	name: string
	model: string
	provider: string
	context_window: number
	truncation_policy: { mode: "tokens"; limit: number }
	shell_type: "shell_command"
	visibility: "list"
	supported_in_api: boolean
	priority: number
	base_instructions: string
	supports_tools: boolean
	supports_parallel_tool_calls: boolean
	experimental_supported_tools: string[]
	supports_reasoning_summaries: boolean
	support_verbosity: boolean
	supported_reasoning_levels: CodexReasoningLevel[]
}

export interface CodexModelCatalog {
	models: CodexModelEntry[]
}

/**
 * Build the Codex model catalog (`~/.codex/model_catalog.json`). Mirrors
 * the structure Codex expects from a user-provided catalog: per-model
 * reasoning levels, truncation policy, and capability flags. Priority
 * is assigned by index so the first model wins any picker ordering.
 *
 * Pure so the snapshot is testable without touching the filesystem.
 */
export function buildModelCatalog(models: readonly ModelMetadata[]): CodexModelCatalog {
	const REASONING_LEVELS: CodexReasoningLevel[] = [
		{ effort: "low", description: "Low reasoning effort" },
		{ effort: "medium", description: "Medium reasoning effort" },
		{ effort: "high", description: "High reasoning effort" },
	]

	const entries: CodexModelEntry[] = models.map((m, index) => ({
		slug: m.slug,
		display_name: m.display_name,
		name: m.slug,
		model: m.slug,
		provider: PROVIDER_NAME,
		context_window: m.limits.context_window,
		truncation_policy: { mode: "tokens", limit: m.limits.context_window },
		shell_type: "shell_command",
		visibility: "list",
		supported_in_api: true,
		priority: (index + 1) * 10,
		base_instructions: "You are a helpful coding assistant.",
		supports_tools: true,
		supports_parallel_tool_calls: true,
		experimental_supported_tools: [],
		supports_reasoning_summaries: m.reasoning,
		support_verbosity: m.reasoning,
		supported_reasoning_levels: m.reasoning ? REASONING_LEVELS : [],
	}))

	return { models: entries }
}

const TOP_LEVEL_KIMCHI_KEYS = new Set(["model_provider", "model", "model_catalog_json"])
const KIMCHI_PROVIDER_SECTION = `model_providers.${PROVIDER_NAME}`

/**
 * Merge freshly-generated kimchi Codex config on top of an existing
 * config.toml. Strips the old `[model_providers.kimchi]` block and the
 * top-level `model_provider` / `model` / `model_catalog_json` keys, then
 * prepends `freshToml` to whatever user-owned sections remain (e.g.
 * `[plugins]`, `[features]`, `[projects]`, `[marketplaces]`).
 *
 * Blank-line runs are collapsed to a single blank line so the rewritten
 * file stays readable.
 *
 * @param existingText - Raw contents of an existing `~/.codex/config.toml` (empty string if absent).
 * @param freshToml    - Newly-generated TOML to take precedence.
 */
export function mergeCodexToml(existingText: string, freshToml: string): string {
	const lines = existingText.split("\n")
	const kept: string[] = []
	let inKimchiProviderSection = false
	let inAnySection = false

	for (const line of lines) {
		// Match a [section] header. We deliberately do not match [[array.of.tables]]
		// here — those keep their content untouched so user-defined project lists
		// survive a refresh.
		const headerMatch = line.match(/^\s*\[([^[\]]+)\]\s*$/)
		if (headerMatch) {
			const sectionName = headerMatch[1].trim()
			inKimchiProviderSection = sectionName === KIMCHI_PROVIDER_SECTION
			inAnySection = true
			if (inKimchiProviderSection) {
				// Drop the header — freshToml re-emits it.
				continue
			}
			kept.push(line)
			continue
		}

		// Match [[array.of.tables]] headers. These are user-owned sections
		// (e.g. [[projects]]) — never part of the kimchi provider block.
		const arrayHeaderMatch = line.match(/^\s*\[\[(.+)\]\]\s*$/)
		if (arrayHeaderMatch) {
			inKimchiProviderSection = false
			inAnySection = true
			kept.push(line)
			continue
		}

		// Body of the kimchi provider section: skip until the next header.
		if (inKimchiProviderSection) continue

		// Top-level keys: only strip before we enter any table. Inside a table,
		// `model`/`model_provider` would refer to a nested key — leave those alone.
		if (!inAnySection) {
			const keyMatch = line.match(/^([A-Za-z0-9_-]+)\s*=/)
			if (keyMatch && TOP_LEVEL_KIMCHI_KEYS.has(keyMatch[1])) continue
		}

		kept.push(line)
	}

	// Collapse runs of blank lines, then strip leading/trailing whitespace so
	// the separator between freshToml and existing stays tidy.
	const collapsed = kept
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^\n+|\n+$/g, "")

	if (collapsed.length === 0) return freshToml
	return `${freshToml}\n${collapsed}\n`
}

async function writeCodex(
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

	const configPath = resolveScopePath(scope, CODEX_CONFIG_PATH)
	const catalogPath = resolveScopePath(scope, CODEX_CATALOG_PATH)

	mkdirSync(dirname(configPath), { recursive: true })

	let existingText = ""
	try {
		existingText = readFileSync(configPath, "utf-8")
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
	}

	const main = resolveModelRole(models, "main")
	const mainSlug = main?.slug ?? models[0].slug

	const freshToml = buildCodexToml(apiKey, mainSlug, catalogPath)
	const merged = mergeCodexToml(existingText, freshToml)

	writeFileAtomic(configPath, merged)
	writeJson(catalogPath, buildModelCatalog(models))
}

register({
	id: "codex",
	name: "Codex",
	description: "OpenAI Codex CLI",
	configPath: CODEX_CONFIG_PATH,
	binaryName: "codex",
	isInstalled: detectBinaryFactory("codex"),
	write: writeCodex,
})
