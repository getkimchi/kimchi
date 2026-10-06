import type { Model } from "@earendil-works/pi-ai"

export const AUTO_MODEL_PROVIDER = "kimchi-dev"

/** Display name for the Auto router. */
export const AUTO_MODEL_NAME = "Auto"

/**
 * What Auto does, in one line.
 *
 * Shown wherever a surface has somewhere to put it: ACP sends it as
 * `SessionConfigSelectOption.description`, and the Pi model registration
 * appends it to the name, because Pi's `Model` has no description field and
 * `/model` would otherwise list a bare "Auto" with no explanation.
 */
export const AUTO_MODEL_DESCRIPTION = "Picks the best model for your tasks automatically."

/**
 * The Pi-registered model name: the two constants joined, for surfaces without
 * a description slot. Use this wherever Auto's registered `Model.name` is
 * produced or asserted, so tests cannot drift from what production builds.
 */
export const AUTO_MODEL_PI_NAME = `${AUTO_MODEL_NAME} — ${AUTO_MODEL_DESCRIPTION}`

/**
 * Default-model candidates for organizations whose catalog does not serve a
 * routed virtual model (`auto`). Until the Auto router reaches GA, such
 * organizations default to a concrete flash model instead of multi-model.
 * First match in the served catalog wins; when none is served the
 * organization stays on multi-model.
 *
 * `deepseek-v4-flash` is the platform's canonical slug; `deepseek-v4-flash-0731`
 * mirrors the existing extraction-model fallback (memory/backend.ts
 * EXTRACTION_MODEL) so a versioned slug still satisfies the gate.
 */
export const GATED_DEFAULT_MODEL_CANDIDATES: readonly string[] = ["deepseek-v4-flash", "deepseek-v4-flash-0731"]

/**
 * The harness-side deprecation label for the virtual multi-model selection.
 * Multi-model does not exist in the platform catalog, so no backend marker
 * can carry this. ACP sources this constant; the TUI /model selector renders
 * the same literal from the pi-coding-agent patch (patched dist code cannot
 * import harness source), and the rendered-text tests pin both sides to the
 * same string.
 *
 * The wording is deliberately replacement-agnostic: organizations gated off
 * the `auto` virtual model never see Auto, so "replaced by Auto" would point
 * at a model they cannot select.
 */
export const MULTI_MODEL_DEPRECATION_LABEL = "[Deprecated]"

/**
 * Whether the model is a routed virtual model, by the `auto*` naming
 * convention: any `kimchi-dev` model whose id starts with `auto` is
 * backend-routed (`auto` today, `auto-beta`, future variants) — the backend
 * picks and serves a concrete model per request and reports the pick in the
 * response `model` field.
 *
 * Concrete `kimchi-dev` models never start with `auto`; the `auto*` id
 * namespace belongs to backend routing.
 */
export function isAutoRoutedModel<T extends Pick<Model<string>, "provider" | "id">>(
	model: T | undefined,
): model is T & { provider: typeof AUTO_MODEL_PROVIDER; id: `auto${string}` } {
	return model?.provider === AUTO_MODEL_PROVIDER && model.id.startsWith("auto")
}

/** Ref-form check (`provider/id` string) matching isAutoRoutedModel's convention. */
export function isAutoRoutedRef(ref: string): boolean {
	return ref.startsWith(`${AUTO_MODEL_PROVIDER}/auto`)
}

/**
 * Backend display names may carry the description after an em-dash sentinel:
 * `"Auto — Picks the best model…"`. Surfaces with a dedicated description slot
 * (ACP options) split the pair; surfaces that render the raw name (the /model
 * detail line) keep it whole. Only the first " — " separates; plain hyphens in
 * names are untouched.
 */
export function splitModelDisplayName(name: string): { name: string; description?: string } {
	const sep = name.indexOf(" — ")
	if (sep === -1) return { name }
	return { name: name.slice(0, sep), description: name.slice(sep + 3) }
}
