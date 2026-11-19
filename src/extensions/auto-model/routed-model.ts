import type { Model } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { isKimchiGatewayBlock } from "../../kimchi-provider.js"

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

export type RoutedModelRegistry = Pick<ModelRegistry, "find" | "getAll">

/**
 * Map a backend-verified routed model id back to the catalog model that serves
 * the request.
 *
 * The Kimchi backend stamps the concrete model in the OpenAI response `model`
 * field (surfaced as `AssistantMessage.responseModel`). Routed ids are bare
 * slugs, and the catalog registers them under the block that serves them: the
 * virtual model lives on `kimchi-dev`, while concrete models usually sit on a
 * per-upstream sibling. An exact `find(provider, id)` therefore reports most
 * picks as unknown and capability sync silently never runs, so a miss falls
 * back to a bare-slug scan across {@link isKimchiGatewayBlock} providers.
 * Direct and local blocks are excluded on purpose: the routed request travels
 * through the gateway, so their descriptors are not what served the turn.
 *
 * A slug registered under more than one gateway block is expected to carry the
 * same limits in each (the rows come from the same catalog model); the first
 * catalog entry wins, and no cross-block preference is applied.
 *
 * When the routed id is not present in the catalog (a backend-routed model the
 * harness has not been told about), return an {@link UnknownRoutedModel} so the
 * caller can still display the raw id while declining to attempt capability
 * sync — the extension degrades gracefully rather than failing the turn.
 */
export function resolveRoutedModel(
	provider: string,
	responseModel: string,
	modelRegistry: RoutedModelRegistry,
): RoutedModelResolution {
	const exact = modelRegistry.find(provider, responseModel)
	if (exact) return { kind: "model", model: exact }

	const sibling = modelRegistry
		.getAll()
		.find((model) => model.id === responseModel && isKimchiGatewayBlock(model.provider))
	return sibling ? { kind: "model", model: sibling } : { kind: "unknown", rawId: responseModel }
}
