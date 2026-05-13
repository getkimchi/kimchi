import { readJson, writeFileAtomic, writeJson } from "../config/json.js"
import type { ConfigScope } from "../config/scope.js"
import { resolveScopePath } from "../config/scope.js"
import type { ModelMetadata } from "../models.js"
import { BASE_URL, PROVIDER_NAME } from "./constants.js"
import { findBinary } from "./detect.js"
import { type ModelRole, resolveAllModelRoles, resolveModelRole } from "./models.js"
import { register } from "./registry.js"

const GSD_PREFERENCES_PATH = "~/.gsd/preferences.md"
const GSD_MODELS_PATH = "~/.gsd/agent/models.json"

interface ModelCost {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
}

const COST_OPUS: ModelCost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
const COST_SONNET: ModelCost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
const COST_FREE: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * Determine cost for a model based on its provider. Anthropic models get
 * billed at sticker price; everything else is free (kimchi-internal).
 * This heuristic replaces the hardcoded CATALOG cost array.
 */
function computeCost(model: ModelMetadata): ModelCost {
	if (model.provider === "anthropic") {
		if (model.slug.includes("opus")) return COST_OPUS
		if (model.slug.includes("sonnet")) return COST_SONNET
	}
	return COST_FREE
}

/**
 * Build the kimchi provider block for ~/.gsd/agent/models.json. GSD2 reads
 * this to populate the kimchi provider in its UI. All available models from
 * the API are included; cost is derived from provider (anthropic = billed,
 * rest = free) so GSD's budget tracker doesn't double-charge kimchi users.
 *
 * @param apiKey - Raw API key (written directly; models.json is user-private).
 * @param models - Live `ModelMetadata[]` fetched from the API.
 */
export function buildGsd2KimchiProvider(apiKey: string, models: readonly ModelMetadata[]): Record<string, unknown> {
	if (models.length === 0) {
		throw new Error("No models available — is the API key valid?")
	}
	const main = resolveModelRole(models, "main")
	return {
		name: "Kimchi",
		baseUrl: BASE_URL,
		apiKey,
		api: "openai-completions",
		defaultModel: main?.slug ?? models[0].slug,
		models: models.map((m) => ({
			id: m.slug,
			name: m.display_name || m.slug,
			contextWindow: m.limits.context_window,
			maxTokens: m.limits.max_output_tokens,
			reasoning: m.reasoning,
			input: m.input_modalities,
			cost: computeCost(m),
		})),
	}
}

/**
 * Build the YAML-frontmatter Markdown that lives at ~/.gsd/preferences.md.
 * Task-type routing uses resolved model roles so it adapts to whatever
 * models the API has available.
 *
 * @param models - Live `ModelMetadata[]` fetched from the API.
 */
export function buildGsd2Preferences(models: readonly ModelMetadata[]): string {
	if (models.length === 0) {
		throw new Error("No models available — is the API key valid?")
	}
	const resolved = resolveAllModelRoles(models, ["main", "coding", "sub", "opus"] as readonly ModelRole[])
	const main = resolved.main
	const coding = resolved.coding
	const sub = resolved.sub
	const opus = resolved.opus

	// Fallbacks when some roles aren't available.
	const planning = opus ?? main
	const validation = opus ?? main

	const slug = (m?: ModelMetadata): string => (m ? `${PROVIDER_NAME}/${m.slug}` : `${PROVIDER_NAME}/unknown`)

	return `---
version: 1
models:
  research: ${slug(coding)}
  planning: ${slug(planning)}
  discuss: ${slug(sub)}
  execution: ${slug(main)}
  execution_simple: ${slug(sub)}
  completion: ${slug(main)}
  validation: ${slug(validation)}
  subagent: ${slug(coding)}
auto_supervisor:
  model: ${slug(planning)}
dynamic_routing:
  enabled: false
  tier_models:
    light: ${slug(coding)}
    standard: ${slug(sub)}
    heavy:
      - ${slug(main)}
      - ${slug(planning)}
  budget_pressure: false
token_profile: balanced
skill_discovery: suggest
git:
  isolation: worktree
  merge_strategy: squash
---
`
}

function detectGsd2(): boolean {
	return findBinary("gsd") !== undefined || findBinary("gsd-cli") !== undefined
}

async function writeGsd2(
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

	const modelsPath = resolveScopePath(scope, GSD_MODELS_PATH)
	const existing = readJson(modelsPath)
	const providers =
		existing.providers && typeof existing.providers === "object" && !Array.isArray(existing.providers)
			? (existing.providers as Record<string, unknown>)
			: {}
	providers.kimchi = buildGsd2KimchiProvider(apiKey, models)
	existing.providers = providers
	writeJson(modelsPath, existing)

	const prefsPath = resolveScopePath(scope, GSD_PREFERENCES_PATH)
	writeFileAtomic(prefsPath, buildGsd2Preferences(models))
}

register({
	id: "gsd2",
	name: "GSD2",
	description: "Autonomous coding agent (Get Shit Done v2)",
	configPath: GSD_PREFERENCES_PATH,
	binaryName: "gsd",
	isInstalled: detectGsd2,
	write: writeGsd2,
})
