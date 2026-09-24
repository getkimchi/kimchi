import type { Model } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"

/** A routed model id the harness catalog does not recognize — display only. */
export interface UnknownRoutedModel {
	readonly kind: "unknown"
	rawId: string
}

/** A routed id resolved to the concrete model in the harness catalog. */
export interface KnownRoutedModel {
	readonly kind: "model"
	model: Model<string>
}

export type RoutedModelResolution = KnownRoutedModel | UnknownRoutedModel

/**
 * Map a backend-verified routed model id back to the catalog model that serves
 * the request.
 *
 * The Kimchi backend stamps the concrete model in the OpenAI response `model`
 * field (surfaced as `AssistantMessage.responseModel`). Routed ids are bare
 * slugs matching the `kimchi-dev` catalog ids 1:1, so a direct `find` lookup
 * suffices.
 *
 * When the routed id is not present in the catalog (a backend-routed model the
 * harness has not been told about), return an {@link UnknownRoutedModel} so the
 * caller can still display the raw id while declining to attempt capability
 * sync — the extension degrades gracefully rather than failing the turn.
 */
export function resolveRoutedModel(
	provider: string,
	responseModel: string,
	modelRegistry: Pick<ModelRegistry, "find">,
): RoutedModelResolution {
	const model = modelRegistry.find(provider, responseModel)
	return model ? { kind: "model", model } : { kind: "unknown", rawId: responseModel }
}
