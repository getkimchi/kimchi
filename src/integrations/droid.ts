import { readJson, writeJson } from "../config/json.js"
import type { ConfigScope } from "../config/scope.js"
import { resolveScopePath } from "../config/scope.js"
import type { ModelMetadata } from "../models.js"
import { ANTHROPIC_BASE_URL, BASE_URL } from "./constants.js"
import { dirExists, findBinary } from "./detect.js"
import { register } from "./registry.js"

const DROID_CONFIG_PATH = "~/.factory/settings.json"
const KIMCHI_BASE_URLS = new Set([BASE_URL, ANTHROPIC_BASE_URL])

/**
 * One entry in Droid's `customModels` array. Field names follow Factory's
 * settings.json (camelCase) BYOK schema; kimchi only emits the `anthropic`
 * and `generic-chat-completion-api` providers.
 */
interface DroidCustomModel {
	model: string
	displayName: string
	baseUrl: string
	apiKey: string
	provider: "anthropic" | "generic-chat-completion-api"
	maxOutputTokens: number
}

function toCustomModel(model: ModelMetadata, apiKey: string): DroidCustomModel {
	const isAnthropic = model.provider === "anthropic"
	return {
		model: model.slug,
		displayName: model.display_name || model.slug,
		baseUrl: isAnthropic ? ANTHROPIC_BASE_URL : BASE_URL,
		apiKey,
		provider: isAnthropic ? "anthropic" : "generic-chat-completion-api",
		maxOutputTokens: model.limits.max_output_tokens,
	}
}

/**
 * Replace any previously kimchi-written entries (identified by their base URL)
 * with a fresh set for the current model list, preserving the user's own
 * custom models. Pure so the merge is testable without touching the filesystem.
 */
export function buildDroidCustomModels(
	existing: unknown,
	apiKey: string,
	models: readonly ModelMetadata[],
): Array<DroidCustomModel | Record<string, unknown>> {
	const kept = (Array.isArray(existing) ? existing : []).filter(
		(entry): entry is Record<string, unknown> =>
			typeof entry === "object" &&
			entry !== null &&
			!KIMCHI_BASE_URLS.has((entry as { baseUrl?: string }).baseUrl ?? ""),
	)
	const fresh = models.map((m) => toCustomModel(m, apiKey))
	return [...kept, ...fresh]
}

/**
 * Merge the kimchi customModels block into Droid's settings.json at `path`.
 * Split out from writeDroid so the read/merge/write round-trip is testable
 * against a temp file.
 */
export function writeDroidConfig(path: string, apiKey: string, models: readonly ModelMetadata[]): void {
	const existing = readJson(path)
	existing.customModels = buildDroidCustomModels(existing.customModels, apiKey, models)
	writeJson(path, existing)
}

/**
 * Factory keeps BYOK models in a single user-level settings.json; it has no
 * Factory-native project config, and kimchi's `<cwd>/.claude/<basename>`
 * project path would collide with Claude Code's own settings.json (same
 * basename) and leak the API key into it. So Droid is configured at global
 * scope only — `scope` is accepted for the ToolDefinition contract but
 * ignored, mirroring the Cursor writer.
 */
async function writeDroid(
	_scope: ConfigScope,
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

	writeDroidConfig(resolveScopePath("global", DROID_CONFIG_PATH), apiKey, models)
}

function detectDroid(): boolean {
	return findBinary("droid") !== undefined || dirExists(resolveScopePath("global", "~/.factory"))
}

register({
	id: "droid",
	name: "Droid",
	description: "Factory.ai agentic coding CLI",
	configPath: DROID_CONFIG_PATH,
	binaryName: "droid",
	isInstalled: detectDroid,
	write: writeDroid,
})
