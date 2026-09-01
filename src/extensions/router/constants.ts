import type { Model } from "@earendil-works/pi-ai"

export const AUTO_MODEL_PROVIDER = "kimchi-dev"
export const AUTO_MODEL_ID = "auto"
export const AUTO_MODEL_REF = `${AUTO_MODEL_PROVIDER}/${AUTO_MODEL_ID}`
export const AUTO_MODEL_API = "kimchi-auto"
export const AUTO_MODEL_NAME = "Auto (Kimchi Router)"

export function isAutoModel<T extends Pick<Model<string>, "provider" | "id">>(
	model: T | undefined,
): model is T & { provider: typeof AUTO_MODEL_PROVIDER; id: typeof AUTO_MODEL_ID } {
	return model?.provider === AUTO_MODEL_PROVIDER && model.id === AUTO_MODEL_ID
}
