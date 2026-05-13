import { readJson, writeFileAtomic, writeJson } from "../config/json.js"
import type { ConfigScope } from "../config/scope.js"
import { resolveScopePath } from "../config/scope.js"
import { BASE_URL, PROVIDER_NAME } from "./constants.js"
import { findBinary } from "./detect.js"
import { CODING_MODEL, KIMI_K25_MODEL, MAIN_MODEL, OPUS_MODEL, SONNET_MODEL, SUB_MODEL } from "./models.js"
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

interface CatalogEntry {
	model: typeof MAIN_MODEL
	input: ReadonlyArray<"text" | "image">
	cost: ModelCost
}

const CATALOG: CatalogEntry[] = [
	{ model: OPUS_MODEL, input: ["text"], cost: COST_OPUS },
	{ model: SONNET_MODEL, input: ["text"], cost: COST_SONNET },
	{ model: MAIN_MODEL, input: ["text", "image"], cost: COST_FREE },
	{ model: KIMI_K25_MODEL, input: ["text", "image"], cost: COST_FREE },
	{ model: CODING_MODEL, input: ["text"], cost: COST_FREE },
	{ model: SUB_MODEL, input: ["text"], cost: COST_FREE },
]

/**
 * Build the kimchi provider block for ~/.gsd/agent/models.json. GSD2 reads
 * this to populate the kimchi provider in its UI. Cost numbers: Opus/Sonnet
 * at sticker price, the free kimchi-internal models at zero so GSD's budget
 * tracker doesn't double-charge.
 */
export function buildGsd2KimchiProvider(apiKey: string): Record<string, unknown> {
	return {
		name: "Kimchi",
		baseUrl: BASE_URL,
		apiKey,
		api: "openai-completions",
		defaultModel: MAIN_MODEL.slug,
		models: CATALOG.map(({ model, input, cost }) => ({
			id: model.slug,
			name: model.displayName,
			contextWindow: model.limits.contextWindow,
			maxTokens: model.limits.maxOutputTokens,
			reasoning: model.reasoning,
			input,
			cost,
		})),
	}
}

/**
 * Build the YAML-frontmatter Markdown that lives at ~/.gsd/preferences.md.
 * Each task type is mapped to a kimchi-prefixed model slug.
 */
export function buildGsd2Preferences(): string {
	const slug = (m: typeof MAIN_MODEL): string => `${PROVIDER_NAME}/${m.slug}`
	return `---
version: 1
models:
  research: ${slug(CODING_MODEL)}
  planning: ${slug(OPUS_MODEL)}
  discuss: ${slug(SUB_MODEL)}
  execution: ${slug(MAIN_MODEL)}
  execution_simple: ${slug(SUB_MODEL)}
  completion: ${slug(MAIN_MODEL)}
  validation: ${slug(OPUS_MODEL)}
  subagent: ${slug(CODING_MODEL)}
auto_supervisor:
  model: ${slug(OPUS_MODEL)}
dynamic_routing:
  enabled: false
  tier_models:
    light: ${slug(CODING_MODEL)}
    standard: ${slug(SUB_MODEL)}
    heavy:
      - ${slug(MAIN_MODEL)}
      - ${slug(OPUS_MODEL)}
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

async function writeGsd2(scope: ConfigScope, apiKey: string, _options?: { telemetryEnabled?: boolean }): Promise<void> {
	if (!apiKey) {
		throw new Error("API key not configured")
	}
	const modelsPath = resolveScopePath(scope, GSD_MODELS_PATH)
	const existing = readJson(modelsPath)
	const providers =
		existing.providers && typeof existing.providers === "object" && !Array.isArray(existing.providers)
			? (existing.providers as Record<string, unknown>)
			: {}
	providers.kimchi = buildGsd2KimchiProvider(apiKey)
	existing.providers = providers
	writeJson(modelsPath, existing)

	const prefsPath = resolveScopePath(scope, GSD_PREFERENCES_PATH)
	writeFileAtomic(prefsPath, buildGsd2Preferences())
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
