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
