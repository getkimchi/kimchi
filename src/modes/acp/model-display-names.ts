import type { Model } from "@earendil-works/pi-ai"

/**
 * Human-facing display names for ACP model pickers.
 *
 * The platform catalog ships `name` equal to the slug when `display_name` is
 * empty (src/models.ts `metadataToModel` falls back to the slug), so ACP
 * clients would otherwise render raw ids like `claude-opus-4-6`. Backend
 * display names always win: the prettifier only kicks in when the registered
 * name is missing, blank, or identical to the slug.
 */

/** Words whose catalog spelling is not plain sentence-case. */
const WORD_CASING: Record<string, string> = {
	ai: "AI",
	auto: "Auto",
	beta: "Beta",
	claude: "Claude",
	deepseek: "DeepSeek",
	fable: "Fable",
	flash: "Flash",
	gemma: "Gemma",
	glm: "GLM",
	gpt: "GPT",
	haiku: "Haiku",
	kimi: "Kimi",
	llama: "Llama",
	minimax: "MiniMax",
	mistral: "Mistral",
	nemotron: "Nemotron",
	opus: "Opus",
	pro: "Pro",
	qwen: "Qwen",
	sonnet: "Sonnet",
	ultra: "Ultra",
}

function prettifyWord(token: string): string {
	// Version-ish tokens keep their spelling: v4, 5.3, 4o, 31b.
	const lower = token.toLowerCase()
	if (WORD_CASING[lower]) return WORD_CASING[lower]
	if (/^v\d/.test(lower)) return lower
	if (/^\d/.test(token)) return token.toUpperCase()
	// Letter+number codes read better uppercased: k3 → K3, fp4 → FP4, m3 → M3.
	if (/^[a-z]+\d+$/.test(token)) return token.toUpperCase()
	return token.charAt(0).toUpperCase() + token.slice(1)
}

/**
 * Best-effort pretty name for a model slug: `claude-opus-4-6` → `Claude Opus
 * 4.6`, `glm-5.3-flash` → `GLM 5.3 Flash`, `kimi-k3` → `Kimi K3`. A run of
 * two or more pure-numeric tokens joins with dots (it is a dotted version);
 * a lone numeric token stays its own word (e.g. `gemma-4-31b` →
 * `Gemma 4 31B`).
 */
export function prettifyModelId(id: string): string {
	const tokens = id.split("-").filter(Boolean)
	const words: string[] = []
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]
		if (/^\d+$/.test(token)) {
			if (i + 1 < tokens.length && /^\d+$/.test(tokens[i + 1])) {
				const run = [token]
				while (i + 1 < tokens.length && /^\d+$/.test(tokens[i + 1])) {
					run.push(tokens[++i])
				}
				words.push(run.join("."))
			} else {
				words.push(token)
			}
			continue
		}
		words.push(prettifyWord(token))
	}
	return words.join(" ")
}

/** Model-shaped row with a nullable display name. */
type NamedModel = Pick<Model<string>, "id"> & { name?: string }

/** Whether the model's registered name carries no display information beyond the slug. */
function isSlugLikeName(model: NamedModel): boolean {
	const name = model.name?.trim()
	return !name || name === model.id
}

/**
 * The display name for a model row in the ACP model picker: the catalog's
 * display name when it exists, a prettified slug otherwise. Composite routed
 * rows ("Auto — Picks the best model…") still go through
 * `splitModelDisplayName` at the call site.
 */
export function resolveAcpModelDisplayName(model: NamedModel): string {
	if (isSlugLikeName(model)) return prettifyModelId(model.id)
	// biome-ignore lint/style/noNonNullAssertion: isSlugLikeName proved name is non-empty
	return model.name!.trim()
}
