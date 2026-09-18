import type { Model } from "@earendil-works/pi-ai"

export const AUTO_MODEL_PROVIDER = "kimchi-dev"
export const AUTO_MODEL_ID = "auto"
export const AUTO_MODEL_REF = `${AUTO_MODEL_PROVIDER}/${AUTO_MODEL_ID}`
export const AUTO_MODEL_API = "kimchi-auto"

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

export function isAutoModel<T extends Pick<Model<string>, "provider" | "id">>(
	model: T | undefined,
): model is T & { provider: typeof AUTO_MODEL_PROVIDER; id: typeof AUTO_MODEL_ID } {
	return model?.provider === AUTO_MODEL_PROVIDER && model.id === AUTO_MODEL_ID
}
