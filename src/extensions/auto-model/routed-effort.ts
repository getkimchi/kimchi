import type { Api, AssistantMessage, Model, ModelThinkingLevel } from "@earendil-works/pi-ai"
import type { AfterProviderResponseEvent, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { CANONICAL_THINKING_LEVELS } from "../../thinking-levels.js"
import { AUTO_MODEL_PROVIDER, isAutoRoutedModel } from "./constants.js"

type Owner = ExtensionContext["sessionManager"]
type RoutedModel = Pick<Model<Api>, "provider" | "id">

const actualEffortByOwner = new WeakMap<Owner, ModelThinkingLevel>()
const activeRequests = new WeakSet<Owner>()
const requestedModelByOwner = new WeakMap<Owner, string>()
export const AUTO_REASONING_EFFORT_HEADER = "x-auto-reasoning-effort"

/** Start a real Auto request. Never infer its effort from the configured preference. */
export function beginRoutedEffort(owner: Owner, model: RoutedModel | undefined): void {
	actualEffortByOwner.delete(owner)
	requestedModelByOwner.delete(owner)
	activeRequests.delete(owner)
	if (!model || !isAutoRoutedModel(model)) return
	requestedModelByOwner.set(owner, model.id)
	activeRequests.add(owner)
}

/** Capture only an actual effort header on the request begun for this exact owner. */
export function captureRoutedEffort(event: AfterProviderResponseEvent, owner: Owner): void {
	if (!activeRequests.has(owner) || !requestedModelByOwner.has(owner)) return
	// The bridge may forward a native Headers object despite the record type.
	const headers = event.headers as unknown as Headers | Record<string, string>
	const value =
		headers instanceof Headers
			? headers.get(AUTO_REASONING_EFFORT_HEADER)
			: Object.entries(headers).find(([key]) => key.toLowerCase() === AUTO_REASONING_EFFORT_HEADER)?.[1]
	const effort = value?.trim().toLowerCase()
	if (CANONICAL_THINKING_LEVELS.some((level) => level === effort)) {
		actualEffortByOwner.set(owner, effort as ModelThinkingLevel)
	}
}

/** Consume matching Auto metadata; missing or mismatched headers never overwrite a response. */
export function takeRoutedEffort(owner: Owner, message: AssistantMessage): ModelThinkingLevel | undefined {
	const actual = actualEffortByOwner.get(owner)
	const modelId = requestedModelByOwner.get(owner)
	actualEffortByOwner.delete(owner)
	requestedModelByOwner.delete(owner)
	activeRequests.delete(owner)
	if (!actual || message.provider !== AUTO_MODEL_PROVIDER || message.model !== modelId) return undefined
	return actual
}

export function clearRoutedEffort(owner: Owner): void {
	actualEffortByOwner.delete(owner)
	requestedModelByOwner.delete(owner)
	activeRequests.delete(owner)
}
