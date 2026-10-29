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

/**
 * Vendor-canonical spellings that the generic word-joining prettifier cannot
 * reproduce: these vendors hyphenate their marketing names (verified against
 * z.ai, DeepSeek, BAAI FlagEmbedding), while Anthropic/Google/Moonshot/MiniMax
 * use spaces. Checked before the generic prettifier.
 */
const VENDOR_CANONICAL: Record<string, string> = {
	"bge-m3": "BGE-M3",
	"deepseek-v4-flash": "DeepSeek-V4-Flash",
	"deepseek-v4-flash-0731": "DeepSeek-V4-Flash-0731",
	"deepseek-v4.1-flash": "DeepSeek-V4.1-Flash",
	"glm-5.2-fp8": "GLM-5.2 FP8",
	"glm-5.3": "GLM-5.3",
	"glm-5.3-flash": "GLM-5.3-Flash",
}

// Compiled once at module load rather than per token.
const NUMERIC_TOKEN = /^\d+$/
const VERSION_TOKEN = /^v\d/
const DIGIT_LEADING = /^\d/
const LETTER_NUMBER_CODE = /^[a-z]+\d+$/

function prettifyWord(token: string): string {
	// Version-ish tokens keep their spelling: v4, 5.3, 4o, 31b.
	const lower = token.toLowerCase()
	if (WORD_CASING[lower]) return WORD_CASING[lower]
	if (VERSION_TOKEN.test(lower)) return lower
	if (DIGIT_LEADING.test(token)) return token.toUpperCase()
	// Letter+number codes read better uppercased: k3 → K3, fp4 → FP4, m3 → M3.
	if (LETTER_NUMBER_CODE.test(token)) return token.toUpperCase()
	return token.charAt(0).toUpperCase() + token.slice(1)
}

/**
 * Best-effort pretty name for a model slug: `claude-opus-4-6` → `Claude Opus
 * 4.6`, `kimi-k3` → `Kimi K3`. A run of two or more pure-numeric tokens
 * joins with dots (it is a dotted version); a lone numeric token stays its
 * own word (e.g. `gemma-4-31b` → `Gemma 4 31B`). Vendors with hyphenated
 * marketing names (GLM, DeepSeek, BGE) come from VENDOR_CANONICAL above.
 */
export function prettifyModelId(id: string): string {
	const canonical = VENDOR_CANONICAL[id]
	if (canonical) return canonical
	return id
		.split("-")
		.reduce<string[]>((words, token) => {
			if (!token) return words
			const last = words[words.length - 1]
			if (last !== undefined && NUMERIC_TOKEN.test(last) && NUMERIC_TOKEN.test(token)) {
				words[words.length - 1] = `${last}.${token}`
			} else {
				words.push(NUMERIC_TOKEN.test(token) ? token : prettifyWord(token))
			}
			return words
		}, [])
		.join(" ")
}

/** Model-shaped row with a nullable display name. */
type NamedModel = Pick<Model<string>, "id"> & { name?: string }

/**
 * The display name for a model row in the ACP model picker: the catalog's
 * display name when it exists, a prettified slug otherwise. Slug-only names
 * (missing, blank, or identical to the id) carry no display information.
 * Composite routed rows ("Auto — Picks the best model…") still go through
 * `splitModelDisplayName` at the call site.
 */
export function resolveAcpModelDisplayName(model: NamedModel): string {
	const name = model.name?.trim()
	return !name || name === model.id ? prettifyModelId(model.id) : name
}
