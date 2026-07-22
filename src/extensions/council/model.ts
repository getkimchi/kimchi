import type { Api, Model } from "@earendil-works/pi-ai"

export const COUNCIL_PROVIDER = "kimchi"
export const COUNCIL_API = "kimchi-council"
export const COUNCIL_MODEL_IDS = ["council-fast", "council", "council-deep"] as const
const COUNCIL_MODEL_ID_SET = new Set<string>(COUNCIL_MODEL_IDS)

export function isCouncilVirtualModelRef(modelRef: string): boolean {
	const normalized = modelRef.trim().toLowerCase()
	if (normalized === COUNCIL_API || normalized.startsWith(`${COUNCIL_API}/`)) return true
	const separator = normalized.indexOf("/")
	if (separator < 0) return COUNCIL_MODEL_ID_SET.has(normalized)
	return (
		normalized.slice(0, separator) === COUNCIL_PROVIDER && COUNCIL_MODEL_ID_SET.has(normalized.slice(separator + 1))
	)
}

export function isCouncilVirtualModel(model: Pick<Model<Api>, "api" | "id" | "provider">): boolean {
	return (
		model.api === COUNCIL_API ||
		(model.provider === COUNCIL_PROVIDER && COUNCIL_MODEL_ID_SET.has(model.id)) ||
		isCouncilVirtualModelRef(`${model.provider}/${model.id}`)
	)
}
